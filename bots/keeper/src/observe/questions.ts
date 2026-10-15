/**
 * Reads everything `decideQuestions` needs: each feed's state at one block and, for a pending
 * round, what IdentityMD's service says about its request.
 *
 * The service is asked as little as possible. A pending round costs one read of the Intake route
 * per pass (`GET /intake/1/<tx>`: the request's state and the oracle request behind it), and one
 * more (`GET /oracle/requests/<id>/attestation`) only when an answer could be handed in now: the
 * feed is open to `submit`, the contract says `submit` is open, and the service shows the request
 * as decided. The shared client spaces all of them out.
 */
import { getAbiItem, type Abi, type AbiEvent, type Address, type Hex } from "viem";
import {
  holdsPanelEvidence,
  intakeAbi,
  isNotAttested,
  isUnknownTransaction,
  payrollAbi,
  questionsAbi,
  recoverAttestationSigner,
  signedAttestation,
  type HouseFeed,
} from "@help-wanted/shared";
import type {
  AnswerView,
  FeedRules,
  FeedView,
  PendingRound,
  QuestionsConstants,
  QuestionsSnapshot,
  ServiceView,
} from "../modules/questions.js";
import { noteRound, roundNote } from "../store.js";
import { messageOf, readAt, readOnce, type ObserveContext } from "./common.js";

const QUESTIONS_ABI = questionsAbi as unknown as Abi;
const INTAKE_ABI = intakeAbi as unknown as Abi;
const PAYROLL_ABI = payrollAbi as unknown as Abi;
const ROUND_OPENED = getAbiItem({ abi: questionsAbi, name: "RoundOpened" }) as AbiEvent;

export const big = (value: unknown): bigint => (typeof value === "bigint" ? value : BigInt(value as number));
export const num = (value: unknown): number => Number(value);

interface FeedStateStruct {
  exists: boolean;
  rounds: unknown;
  latestRound: unknown;
  lastRequestBlock: unknown;
  failStreak: unknown;
  pending: boolean;
  pendingRequestId: Hex;
  nextRequestBlock: unknown;
  meterBalance: unknown;
  cost: unknown;
}

interface FeedParamsStruct {
  chainId: unknown;
  answerType: unknown;
  panelSize: unknown;
  quorum: unknown;
  minAgreed: unknown;
  validFor: unknown;
  pinHash: boolean;
}

export interface QuestionsTargets {
  questions: Address;
  payroll: Address | null;
  feeds: readonly Pick<HouseFeed, "name" | "id">[];
}

/** The waits fixed in the deployed contract. Read once. */
export async function readConstants(ctx: ObserveContext, questions: Address): Promise<QuestionsConstants> {
  const [submitAfterSilence, abandonAfterSilence, abandonAfterCompleted, issuedAtTolerance] =
    await Promise.all(
      ["SUBMIT_AFTER_SILENCE", "ABANDON_AFTER_SILENCE", "ABANDON_AFTER_COMPLETED", "ISSUED_AT_TOLERANCE"].map(
        (name) => readOnce<unknown>(ctx, questions, QUESTIONS_ABI, name),
      ),
    );
  return {
    submitAfterSilence: big(submitAfterSilence),
    abandonAfterSilence: big(abandonAfterSilence),
    abandonAfterCompleted: big(abandonAfterCompleted),
    issuedAtTolerance: big(issuedAtTolerance),
  };
}

/** A feed's own parameters and whether `submit` is open to it at all. Read once per feed. */
async function readRules(
  ctx: ObserveContext,
  questions: Address,
  feedId: Hex,
): Promise<{ rules: FeedRules; submitAllowed: boolean; validFor: bigint }> {
  const key = `rules:${questions.toLowerCase()}:${feedId.toLowerCase()}`;
  const kept = ctx.cache.values.get(key) as
    { rules: FeedRules; submitAllowed: boolean; validFor: bigint } | undefined;
  if (kept !== undefined) return kept;
  const [params, text] = (await Promise.all([
    readAt(ctx, questions, QUESTIONS_ABI, "feedParams", [feedId]),
    readAt(ctx, questions, QUESTIONS_ABI, "feedText", [feedId]),
  ])) as [FeedParamsStruct, readonly [Hex, Hex]];
  const value = {
    rules: {
      chainId: big(params.chainId),
      answerType: num(params.answerType),
      panelSize: num(params.panelSize),
      quorum: num(params.quorum),
      minAgreed: num(params.minAgreed),
    },
    // What the contract itself decides at creation: a pinned question no panel judges.
    submitAllowed: params.pinHash && !holdsPanelEvidence(text[0]),
    // How long the feed asks an answer to stay valid: part of the contract's silence deadline.
    validFor: big(params.validFor),
  };
  ctx.cache.values.set(key, value);
  return value;
}

/**
 * The transaction that opened a round. The keeper notes it when it sends the request itself;
 * otherwise the `RoundOpened` log is looked up in the one block the request was made in.
 */
export async function findRequestTx(
  ctx: ObserveContext,
  questions: Address,
  feedId: Hex,
  round: bigint,
  requestBlock: bigint,
): Promise<Hex | null> {
  const noted = roundNote(ctx.store.data, feedId, round)?.requestTx;
  if (noted !== undefined) return noted;
  try {
    const logs = await ctx.reader.getLogs({
      address: questions,
      event: ROUND_OPENED,
      args: { feedId, round },
      fromBlock: requestBlock,
      toBlock: requestBlock,
    });
    const hash = logs[0]?.transactionHash ?? null;
    if (
      hash !== null &&
      noteRound(ctx.store.data, feedId, round, { requestTx: hash }, Number(ctx.block.timestamp))
    ) {
      saveQuietly(ctx);
    }
    return hash;
  } catch (error) {
    ctx.log.warn("could not look up the transaction that opened a round", {
      feedId,
      round: round.toString(),
      block: requestBlock.toString(),
      error: messageOf(error),
    });
    return null;
  }
}

function saveQuietly(ctx: ObserveContext): void {
  try {
    ctx.store.save();
  } catch (error) {
    // The notes only save a lookup. A state file that cannot be written stops a live keeper at
    // start; here, in a dry run, it is not worth failing a read over.
    ctx.log.debug("the state file could not be written", { error: messageOf(error) });
  }
}

/** The signed answer of an oracle request, checked in this contract's own domain. */
export async function readAnswer(
  ctx: ObserveContext,
  questions: Address,
  oracleRequestId: string,
): Promise<AnswerView> {
  try {
    const document = await ctx.api.oracleAttestation(oracleRequestId);
    const signed = signedAttestation(document);
    let recoveredSigner: Address | null = null;
    try {
      recoveredSigner = await recoverAttestationSigner(
        { chainId: ctx.chainId, verifyingContract: questions },
        signed.message,
        signed.signature,
      );
    } catch {
      recoveredSigner = null;
    }
    return {
      kind: "signed",
      oracleRequestId,
      message: signed.message,
      signature: signed.signature,
      signedFor: signed.consumer,
      recoveredSigner,
    };
  } catch (error) {
    if (isNotAttested(error)) return { kind: "none", detail: "the oracle request is not attested" };
    return { kind: "unreadable", detail: messageOf(error) };
  }
}

/** What IdentityMD's service says about a pending round's request. */
export async function readService(
  ctx: ObserveContext,
  questions: Address,
  feedId: Hex,
  round: Pick<PendingRound, "round" | "intakeRequestId" | "requestTx">,
  wantAnswer: boolean,
): Promise<ServiceView> {
  if (round.requestTx === null) {
    return { kind: "unreachable", detail: "the transaction that opened the round could not be found" };
  }
  let read;
  try {
    read = await ctx.api.intakeRead(ctx.chainId, round.requestTx);
  } catch (error) {
    if (isUnknownTransaction(error)) {
      return {
        kind: "unseen",
        detail: "IdentityMD's service has not seen the transaction that made the request",
      };
    }
    return { kind: "unreachable", detail: `IdentityMD's service could not be read (${messageOf(error)})` };
  }
  // One transaction can hold several requests; ours is the one with the round's Intake id.
  const wanted = round.intakeRequestId.toLowerCase();
  const entry = read.entries.find((e) => e.requestId?.toLowerCase() === wanted);
  if (entry === undefined) {
    return {
      kind: "unseen",
      detail: "IdentityMD's service lists the transaction but not this request",
    };
  }
  const oracleRequestId = entry.admission?.result?.requestId ?? null;
  if (
    oracleRequestId !== null &&
    noteRound(ctx.store.data, feedId, round.round, { oracleRequestId }, Number(ctx.block.timestamp))
  ) {
    saveQuietly(ctx);
  }
  const completionStatus = entry.completion?.status ?? null;
  const undecided = ["received", "paid", "admitted"].includes(entry.state);
  const withoutAnswer =
    completionStatus === 1 || completionStatus === 2 || entry.state === "refused" || entry.state === "failed";
  // For a request that ended without an answer, the oracle's own record says why. It is read
  // once and kept in the round's note.
  let failure: string | null = roundNote(ctx.store.data, feedId, round.round)?.failure ?? null;
  if (failure === null && withoutAnswer && oracleRequestId !== null) {
    try {
      const record = await ctx.api.oracleRequest(oracleRequestId);
      failure = record.failure ? `${record.status}: ${record.failure}` : record.status;
      noteRound(ctx.store.data, feedId, round.round, { failure }, Number(ctx.block.timestamp));
      saveQuietly(ctx);
    } catch (error) {
      ctx.log.debug("could not read the oracle request of a failed round", { error: messageOf(error) });
    }
  }
  let answer: AnswerView;
  if (!wantAnswer) answer = { kind: "none", detail: "not asked for: no answer could be handed in now" };
  else if (undecided) answer = { kind: "none", detail: `the request is still ${entry.state}` };
  else if (withoutAnswer) answer = { kind: "none", detail: "the request ended without an answer" };
  else if (oracleRequestId === null) answer = { kind: "none", detail: "the service names no oracle request" };
  else answer = await readAnswer(ctx, questions, oracleRequestId);
  return {
    kind: "seen",
    state: entry.state,
    reason: entry.reason ?? null,
    oracleRequestId,
    completionStatus,
    delivered: entry.completion?.delivered ?? null,
    failure,
    answer,
  };
}

/** What `Payroll.fundFeeds` would offer each of its three feeds now, by feed id (lowercase). */
async function readPayrollTopUps(ctx: ObserveContext, payroll: Address): Promise<Map<string, bigint>> {
  const [a, b, c] = (await Promise.all(
    ["FEED_A", "FEED_B", "FEED_C"].map((name) => readOnce<Hex>(ctx, payroll, PAYROLL_ABI, name)),
  )) as [Hex, Hex, Hex];
  const [shortfalls, budget] = (await Promise.all([
    readAt(ctx, payroll, PAYROLL_ABI, "feedShortfalls"),
    readAt(ctx, payroll, PAYROLL_ABI, "feedBudget"),
  ])) as [readonly unknown[], readonly unknown[]];
  const hasBudget = big(budget[0]) > 0n;
  const out = new Map<string, bigint>();
  [a, b, c].forEach((feedId, i) => out.set(feedId.toLowerCase(), hasBudget ? big(shortfalls[i]) : 0n));
  return out;
}

async function observeFeed(
  ctx: ObserveContext,
  targets: QuestionsTargets,
  intake: Address,
  constants: QuestionsConstants,
  feed: Pick<HouseFeed, "name" | "id">,
  topUps: Map<string, bigint> | null,
): Promise<FeedView> {
  const { questions } = targets;
  const feedId = feed.id;
  const state = (await readAt(ctx, questions, QUESTIONS_ABI, "feedState", [feedId])) as FeedStateStruct;
  const payrollTopUp = topUps === null ? null : (topUps.get(feedId.toLowerCase()) ?? null);
  if (!state.exists) {
    return {
      name: feed.name,
      feedId,
      exists: false,
      submitAllowed: false,
      rules: null,
      rounds: 0n,
      latestRound: 0n,
      failStreak: 0,
      nextRequestBlock: 0n,
      meterBalance: 0n,
      cost: 0n,
      canRequest: { ok: false, why: 1, price: 0n, fromBlock: 0n, toBlock: 0n },
      lastRequestedAt: 0n,
      pending: null,
      payrollTopUp,
    };
  }
  const rounds = big(state.rounds);
  const [can, { rules, submitAllowed, validFor }, newest] = (await Promise.all([
    readAt(ctx, questions, QUESTIONS_ABI, "canRequest", [feedId]),
    readRules(ctx, questions, feedId),
    rounds === 0n
      ? Promise.resolve(null)
      : readAt(ctx, questions, QUESTIONS_ABI, "roundRequest", [feedId, rounds]),
  ])) as [
    readonly unknown[],
    { rules: FeedRules; submitAllowed: boolean; validFor: bigint },
    readonly [Hex, Hex, Hex, unknown] | null,
  ];

  let pending: PendingRound | null = null;
  if (state.pending && newest !== null) {
    const [intakeRequestId, questionHash, blockHash, requestedAt] = newest;
    const [roundOf, canSubmit, canAbandon, request] = (await Promise.all([
      readAt(ctx, questions, QUESTIONS_ABI, "roundOf", [feedId, rounds]),
      readAt(ctx, questions, QUESTIONS_ABI, "canSubmit", [feedId]),
      readAt(ctx, questions, QUESTIONS_ABI, "canAbandon", [feedId]),
      readAt(ctx, intake, INTAKE_ABI, "requests", [intakeRequestId]),
    ])) as [readonly unknown[], boolean, readonly unknown[], readonly unknown[]];
    const requestTx = await findRequestTx(ctx, questions, feedId, rounds, big(state.lastRequestBlock));
    const partial = {
      round: rounds,
      requestedAt: big(requestedAt),
      validFor,
      intakeRequestId,
      questionHash,
      blockHash,
      fromBlock: big(roundOf[2]),
      toBlock: big(roundOf[3]),
      intakeCompleted: request[3] === true,
      canSubmit,
      abandonStep: num(canAbandon[0]),
      closableAt: big(canAbandon[1]),
      requestTx,
    };
    // The signed answer is fetched only when it could be handed in now.
    const wantAnswer = submitAllowed && (canSubmit || partial.intakeCompleted);
    pending = { ...partial, service: await readService(ctx, questions, feedId, partial, wantAnswer) };
  }

  return {
    name: feed.name,
    feedId,
    exists: true,
    submitAllowed,
    rules,
    rounds,
    latestRound: big(state.latestRound),
    failStreak: num(state.failStreak),
    nextRequestBlock: big(state.nextRequestBlock),
    meterBalance: big(state.meterBalance),
    cost: big(state.cost),
    canRequest: {
      ok: can[0] === true,
      why: num(can[1]),
      price: big(can[2]),
      fromBlock: big(can[3]),
      toBlock: big(can[4]),
    },
    lastRequestedAt: newest === null ? 0n : big(newest[3]),
    pending,
    payrollTopUp,
  };
}

/** Reads the snapshot `decideQuestions` takes. Sends nothing. */
export async function observeQuestions(
  ctx: ObserveContext,
  targets: QuestionsTargets,
): Promise<QuestionsSnapshot> {
  const { questions, payroll } = targets;
  const [constants, oracleSigner, intake] = await Promise.all([
    readConstants(ctx, questions),
    readOnce<Address>(ctx, questions, QUESTIONS_ABI, "oracleSigner"),
    readOnce<Address>(ctx, questions, QUESTIONS_ABI, "INTAKE"),
  ]);
  let topUps: Map<string, bigint> | null = null;
  if (payroll !== null) {
    try {
      topUps = await readPayrollTopUps(ctx, payroll);
    } catch (error) {
      // Payroll is only asked whether it could top a low meter up; without it, feeds are still kept.
      ctx.log.warn("could not read Payroll's feed budget", { error: messageOf(error) });
    }
  }
  // Feeds one after the other: their service reads share one polite queue anyway.
  const feeds: FeedView[] = [];
  for (const feed of targets.feeds) {
    feeds.push(await observeFeed(ctx, targets, intake, constants, feed, topUps));
  }
  let tips: QuestionsSnapshot["tips"] = null;
  if (ctx.keeper !== null) {
    const [earned, pending] = (await readAt(ctx, questions, QUESTIONS_ABI, "tipsOf", [
      ctx.keeper,
    ])) as readonly [unknown, unknown];
    tips = { earned: big(earned), pending: big(pending) };
  }
  return {
    now: ctx.block.timestamp,
    block: ctx.block.number,
    chainId: ctx.chainId,
    questions,
    oracleSigner,
    payroll,
    keeper: ctx.keeper,
    constants,
    feeds,
    tips,
  };
}
