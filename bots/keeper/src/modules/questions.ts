/**
 * The questions module: what the keeper does about each feed of Standing Questions.
 *
 * `decideQuestions` is a pure function. It is given a snapshot (what the chain says at one block,
 * and what IdentityMD's service says about each pending round) and a policy (the operator's
 * settings), and returns actions and waits. Nothing here reads a clock, the chain or the network.
 *
 * THE RULES, per feed.
 *
 * No round pending:
 *   ask (`request`) when the contract's `canRequest` says yes, and, when the operator set a time
 *   of day, once that time has come. When the only thing in the way is a meter that is too low and
 *   Payroll has budget for it, call `Payroll.fundFeeds` first; the request follows on the next look.
 *
 * A round pending. The keeper works out which of five things is true of it:
 *   answer   a signed answer for this contract is in hand and passes every check the contract makes
 *   coming   IdentityMD's service is still working on the request, or shows it as completing
 *   none     no answer can be stored any more (refused, failed, or the Intake completed the request
 *            and only its callback could have answered)
 *   unseen   the service has never seen the request
 *   unknown  the service cannot be read, or says something that does not add up
 * and then:
 *   answer   hand it in (`submit`) as soon as the contract's `canSubmit` is true: thirty minutes
 *            after the request, or at once when the Intake has completed it. Never wait for the
 *            Intake's writer, which has been seen seven hours late.
 *   none     `abandon` when the contract allows a step: the first call starts thirty minutes, the
 *            second closes the round.
 *   unseen   close once the silence deadline has passed, not before. The deadline is the
 *            contract's: twelve hours for the oracle to sign, then the validity the feed asks of
 *            an answer, the signing-clock tolerance and one second (36 hours, 5 minutes and one
 *            second after the request for the three house feeds).
 *   coming   never close, even when the silence deadline has passed, unless the operator set
 *            CLOSE_ROUNDS_IN_PROGRESS: the answer may be on its way, and an answer that arrives
 *            after its round was closed is refused.
 *   unknown  the same as coming: a round is not closed blind.
 *
 * Whether a call is possible is always the contract's word (`canRequest`, `canSubmit`,
 * `canAbandon`, read in the same block). The keeper's own arithmetic on the waits is used to say
 * when something will open, and as a second opinion: when the two disagree about `submit`, nothing
 * is sent and the status file says so.
 *
 * Tips: `collectTips` once the earned tips reach the operator's threshold. A round's tip belongs
 * to the keeper that opened it (`request`), whoever delivers the answer: handing an answer in
 * earns nothing by itself. This keeper hands answers in all the same, because an unanswered round
 * returns the opener's tip to the meter and leaves the feed without its figure.
 */
import type { Abi, Address, Hex } from "viem";
import {
  ABANDON_STEP,
  REQUEST_BLOCKER,
  payrollAbi,
  questionsAbi,
  requestBlockerName,
  sameAddress,
  type OracleAttestationMessage,
} from "@help-wanted/shared";
import type { Action, Decision, Waiting } from "../actions.js";

const QUESTIONS_ABI = questionsAbi as unknown as Abi;
const PAYROLL_ABI = payrollAbi as unknown as Abi;

/** Seconds a block takes, for saying roughly when a block number will come. */
export const SECONDS_PER_BLOCK = 12;

/**
 * `Payroll.fundFeeds` reads each meter and funds it through calls whose failure it swallows, so a
 * gas estimate can come out too low to do the work (see `Action.gasFloor`). Three top-ups and a
 * release were measured at under 500,000 gas; this is twice that.
 */
export const FUND_FEEDS_GAS_FLOOR = 1_000_000n;

export interface QuestionsPolicy {
  /** Collect earned tips once they reach this much IMD. */
  tipCollectMin: bigint;
  /** Close rounds past their silence deadline although the service still shows them in progress. */
  closeRoundsInProgress: boolean;
  /** A signed answer is handed in only while it has at least this many seconds of validity left. */
  expiryMarginSeconds: number;
  /** Ask at this time of day (seconds after midnight UTC), or null for as soon as a feed is due. */
  requestAtUtc: number | null;
}

/** The waits fixed in the deployed contract, read from it. */
export interface QuestionsConstants {
  submitAfterSilence: bigint;
  abandonAfterSilence: bigint;
  abandonAfterCompleted: bigint;
  issuedAtTolerance: bigint;
}

/** The parameters of a feed that an answer is checked against. */
export interface FeedRules {
  chainId: bigint;
  answerType: number;
  panelSize: number;
  quorum: number;
  minAgreed: number;
}

/** The signed answer IdentityMD's API serves for a round's oracle request, if any. */
export type AnswerView =
  /** No attestation: the request is not attested, or the keeper had no reason to ask for it. */
  | { kind: "none"; detail: string }
  /** The API could not be read, or served something that is not an attestation. */
  | { kind: "unreadable"; detail: string }
  | {
      kind: "signed";
      oracleRequestId: string;
      message: OracleAttestationMessage;
      signature: Hex;
      /** The chain and contract of the domain it was signed in. */
      signedFor: { chainId: number; verifyingContract: Address };
      /** Who signed it, recovered in this contract's own domain; null when recovery failed. */
      recoveredSigner: Address | null;
    };

/** What IdentityMD's service says about a round's request. */
export type ServiceView =
  /** The API could not be read, or the transaction that made the request could not be found. */
  | { kind: "unreachable"; detail: string }
  /** The API answered and does not know the request. */
  | { kind: "unseen"; detail: string }
  | {
      kind: "seen";
      /** `received`, `paid`, `admitted`, `completing`, `completed`, `refused` or `failed`. */
      state: string;
      reason: string | null;
      oracleRequestId: string | null;
      /** What the writer will write or has written: 0 an answer, 1 refused, 2 no answer. */
      completionStatus: number | null;
      /** Whether the callback ran, once the writer has written. */
      delivered: boolean | null;
      /** Why the oracle ended without an answer, when it did and said so: its status and failure. */
      failure: string | null;
      answer: AnswerView;
    };

export interface PendingRound {
  round: bigint;
  /** The block time of the request. */
  requestedAt: bigint;
  /** The validity the feed asks of an answer, in seconds (`feedParams.validFor`). */
  validFor: bigint;
  intakeRequestId: Hex;
  questionHash: Hex;
  /** The closing block's hash stored when the round opened; zero when it could not be read. */
  blockHash: Hex;
  fromBlock: bigint;
  toBlock: bigint;
  /** `Intake.requests(id).completed`. */
  intakeCompleted: boolean;
  /** `Questions.canSubmit(feedId)`. */
  canSubmit: boolean;
  /** `Questions.canAbandon(feedId)`. */
  abandonStep: number;
  closableAt: bigint;
  /** The transaction that made the request, when it is known. */
  requestTx: Hex | null;
  service: ServiceView;
}

export interface FeedView {
  name: string;
  feedId: Hex;
  exists: boolean;
  /** Whether `submit` is open to the feed at all: it pins its question and no panel judges it. */
  submitAllowed: boolean;
  rules: FeedRules | null;
  rounds: bigint;
  latestRound: bigint;
  failStreak: number;
  /** The first block at which the cadence allows another request. */
  nextRequestBlock: bigint;
  meterBalance: bigint;
  /** `costOf`: the live price plus the tip, zero while no request can be bought. */
  cost: bigint;
  canRequest: { ok: boolean; why: number; price: bigint; fromBlock: bigint; toBlock: bigint };
  /** The block time of the newest round's request; zero before the first. */
  lastRequestedAt: bigint;
  pending: PendingRound | null;
  /**
   * What `Payroll.fundFeeds` would offer this feed's meter now: its shortfall when Payroll has
   * budget, zero when it has none or the meter is at its runway, null when Payroll does not fund
   * this feed or is not configured.
   */
  payrollTopUp: bigint | null;
}

export interface QuestionsSnapshot {
  /** The time and number of the block everything was read at. */
  now: bigint;
  block: bigint;
  chainId: number;
  questions: Address;
  /** The signer `Questions` accepts answers from. */
  oracleSigner: Address;
  payroll: Address | null;
  keeper: Address | null;
  constants: QuestionsConstants;
  feeds: FeedView[];
  /** The keeper's tips; null when no keeper address is known. */
  tips: { earned: bigint; pending: bigint } | null;
}

const ZERO_HASH = `0x${"00".repeat(32)}`;

/** The most recent start of the daily slot at or before `now`. */
export function slotStart(now: bigint, atUtc: number): bigint {
  const midnight = now - (now % 86_400n);
  const slot = midnight + BigInt(atUtc);
  return slot <= now ? slot : slot - 86_400n;
}

/**
 * A feed that comes due this close before the daily slot waits for it. A day's cadence is forty
 * minutes short of a day, so a feed asked at the slot comes due forty minutes before the next one;
 * and a feed first asked a little before the slot is brought onto it the next day. Ninety minutes
 * keeps the window of a held request under the 7,500 blocks the Jobs Report counts as one day.
 */
export const SLOT_HOLD_SECONDS = 5_400n;

/**
 * Whether a due feed is held for the daily slot, and until when. One request per slot (a slot runs
 * from the set time of day to the same time the next day): a feed already asked in the current
 * slot waits for the next one, and so does a feed that comes due within the hold before it.
 */
export function slotHold(
  now: bigint,
  lastRequestedAt: bigint,
  atUtc: number,
): { until: bigint; reason: string } | null {
  const slot = slotStart(now, atUtc);
  const next = slot + 86_400n;
  if (lastRequestedAt >= slot) {
    return {
      until: next,
      reason: "the feed is due and was already asked in today's slot; it is asked at the next one",
    };
  }
  if (next - now <= SLOT_HOLD_SECONDS) {
    return {
      until: next,
      reason: "the feed is due shortly before the daily slot; it is asked when the slot starts",
    };
  }
  return null;
}

/** The contract's own rule for `submit`, from the round's figures. */
export function submitOpensAt(round: PendingRound, constants: QuestionsConstants): bigint {
  return round.requestedAt + constants.submitAfterSilence;
}

export function submitOpenByTheRule(
  now: bigint,
  round: PendingRound,
  constants: QuestionsConstants,
): boolean {
  return now >= submitOpensAt(round, constants) || round.intakeCompleted;
}

/**
 * The contract's silence deadline: when a pending round may be closed whatever the Intake says.
 * `Questions._abandonStep` allows the oracle `ABANDON_AFTER_SILENCE` to sign, then the answer the
 * full validity the feed asked for, the signing-clock tolerance, and one second because an
 * answer's expiry is inclusive. For the house feeds that is 36 hours, 5 minutes and one second.
 * `canAbandon` reports the same moment as `closableAt` while the Intake has not completed the
 * request (a seen completion can only bring the closing forward).
 */
export function silenceEndsAt(
  round: Pick<PendingRound, "requestedAt" | "validFor">,
  constants: QuestionsConstants,
): bigint {
  return (
    round.requestedAt + constants.abandonAfterSilence + round.validFor + constants.issuedAtTolerance + 1n
  );
}

/** The silence deadline as hours and minutes after the request, for a sentence. */
export function silenceText(round: Pick<PendingRound, "validFor">, constants: QuestionsConstants): string {
  const seconds = constants.abandonAfterSilence + round.validFor + constants.issuedAtTolerance + 1n;
  const hours = seconds / 3600n;
  const minutes = (seconds % 3600n) / 60n;
  return minutes === 0n ? `${hours} hours` : `${hours} hours and ${minutes} minutes`;
}

export interface AnswerProblems {
  /** Reasons the answer can never be stored for this round. */
  permanent: string[];
  /** Reasons it cannot be stored yet. */
  transient: string[];
}

/**
 * Every check `Questions` makes on an answer (`_verifyAttestation` and `_settle`), made here first
 * so that nothing is sent that the contract would refuse, and so the status file can say why.
 */
export function answerProblems(
  answer: Extract<AnswerView, { kind: "signed" }>,
  round: PendingRound,
  rules: FeedRules,
  snapshot: Pick<QuestionsSnapshot, "now" | "chainId" | "questions" | "oracleSigner" | "constants">,
  policy: Pick<QuestionsPolicy, "expiryMarginSeconds">,
): AnswerProblems {
  const permanent: string[] = [];
  const transient: string[] = [];
  const a = answer.message;
  if (
    answer.signedFor.chainId !== snapshot.chainId ||
    !sameAddress(answer.signedFor.verifyingContract, snapshot.questions)
  ) {
    permanent.push(
      `it was signed for ${answer.signedFor.verifyingContract} on chain ${answer.signedFor.chainId}, not for this contract`,
    );
  }
  if (answer.recoveredSigner === null || !sameAddress(answer.recoveredSigner, snapshot.oracleSigner)) {
    permanent.push(
      `its signature recovers ${answer.recoveredSigner ?? "nobody"} in this contract's domain, not the oracle signer ${snapshot.oracleSigner}`,
    );
  }
  if (a.chainId !== rules.chainId)
    permanent.push(`it is about chain ${a.chainId}, the feed about ${rules.chainId}`);
  if (a.questionHash.toLowerCase() !== round.questionHash.toLowerCase()) {
    permanent.push("its question hash is not the round's");
  }
  if (a.fromBlock !== round.fromBlock || a.toBlock !== round.toBlock) {
    permanent.push(
      `its window is ${a.fromBlock} to ${a.toBlock}, the round's ${round.fromBlock} to ${round.toBlock}`,
    );
  }
  if (a.answerType !== rules.answerType) {
    permanent.push(`its answer type is ${a.answerType}, the feed's ${rules.answerType}`);
  }
  if (a.panelSize < rules.panelSize || a.quorum < rules.quorum) {
    permanent.push(
      `its panel of ${a.panelSize} with quorum ${a.quorum} is below the feed's ${rules.panelSize} and ${rules.quorum}`,
    );
  }
  // A feed created with `minAgreed == quorum` takes only the panel's own agreement.
  const needed = rules.minAgreed === rules.quorum ? a.quorum : rules.minAgreed;
  if (a.agreed < needed) permanent.push(`${a.agreed} members agreed and the feed needs ${needed}`);
  if (
    round.blockHash.toLowerCase() !== ZERO_HASH &&
    a.blockHash.toLowerCase() !== round.blockHash.toLowerCase()
  ) {
    permanent.push("its closing block hash is not the one the round stored");
  }
  // Below the list types an answer is one word.
  if (a.answerType < 4 && a.answer.length !== 66) permanent.push("its answer is not one 32-byte word");
  // `block.timestamp > expiresAt` reverts. The transaction is mined after `now`, hence the margin.
  if (snapshot.now + BigInt(policy.expiryMarginSeconds) > a.expiresAt) {
    permanent.push(`it expires at ${a.expiresAt}, too close to hand in`);
  }
  // `issuedAt > block.timestamp + tolerance` reverts: the signer's clock is ahead of the chain's.
  if (a.issuedAt > snapshot.now + snapshot.constants.issuedAtTolerance) {
    transient.push(`it was issued at ${a.issuedAt}, more than the tolerance ahead of the chain's clock`);
  }
  return { permanent, transient };
}

export type Verdict =
  | { kind: "answer"; answer: Extract<AnswerView, { kind: "signed" }> }
  | { kind: "coming"; why: string }
  | { kind: "none"; why: string }
  | { kind: "unseen"; why: string }
  | { kind: "unknown"; why: string };

const FINAL_STATES = ["refused", "failed"];

/** Which of the five things is true of a pending round. */
export function verdictOf(
  feed: FeedView,
  round: PendingRound,
  snapshot: Pick<QuestionsSnapshot, "now" | "chainId" | "questions" | "oracleSigner" | "constants">,
  policy: Pick<QuestionsPolicy, "expiryMarginSeconds">,
): Verdict {
  const service = round.service;
  const answer = service.kind === "seen" ? service.answer : null;

  // A signed answer that passes every check can be handed in, whatever else is going on.
  let unusable: string | null = null;
  if (feed.submitAllowed && feed.rules !== null && answer?.kind === "signed") {
    const problems = answerProblems(answer, round, feed.rules, snapshot, policy);
    if (problems.permanent.length === 0 && problems.transient.length === 0) return { kind: "answer", answer };
    if (problems.permanent.length === 0) {
      return { kind: "coming", why: `a signed answer is in hand but ${problems.transient.join("; ")}` };
    }
    unusable = problems.permanent.join("; ");
  }

  if (round.intakeCompleted) {
    // The writer has written: the callback was tried, or there was nothing to deliver.
    if (!feed.submitAllowed) {
      return {
        kind: "none",
        why: "the Intake completed the request and nothing was stored; only its callback can answer this feed",
      };
    }
    if (unusable !== null) return { kind: "none", why: `the signed answer cannot be stored: ${unusable}` };
    if (service.kind !== "seen") {
      return {
        kind: "unknown",
        why: `the Intake completed the request, nothing was stored, and the service cannot say why (${service.detail})`,
      };
    }
    if (
      service.completionStatus === 1 ||
      service.completionStatus === 2 ||
      FINAL_STATES.includes(service.state)
    ) {
      return {
        kind: "none",
        why: `the request ended without an answer (${service.failure ?? service.reason ?? service.state}, status ${service.completionStatus ?? "unknown"})`,
      };
    }
    if (service.answer.kind === "unreadable") {
      return { kind: "unknown", why: `the signed answer could not be read (${service.answer.detail})` };
    }
    return {
      kind: "unknown",
      why: `the Intake completed the request with nothing stored, and the service shows ${service.state} with no answer that could be handed in${service.answer.kind === "none" ? ` (${service.answer.detail})` : ""}`,
    };
  }

  if (service.kind === "unreachable") return { kind: "unknown", why: service.detail };
  if (service.kind === "unseen") return { kind: "unseen", why: service.detail };
  if (FINAL_STATES.includes(service.state)) {
    return {
      kind: "none",
      why: `the service shows the request as ${service.state}${(service.failure ?? service.reason) ? ` (${service.failure ?? service.reason})` : ""}`,
    };
  }
  if (unusable !== null) {
    return {
      kind: "coming",
      why: `the service shows the request as ${service.state}, but its signed answer cannot be stored: ${unusable}`,
    };
  }
  return { kind: "coming", why: `the service shows the request as ${service.state}` };
}

function requestAction(snapshot: QuestionsSnapshot, feed: FeedView, reason: string): Action {
  return {
    module: "questions",
    kind: "request",
    subject: feed.name,
    label: `request ${feed.name}`,
    reason,
    call: { address: snapshot.questions, abi: QUESTIONS_ABI, functionName: "request", args: [feed.feedId] },
  };
}

function abandonAction(snapshot: QuestionsSnapshot, feed: FeedView, closes: boolean, reason: string): Action {
  return {
    module: "questions",
    kind: closes ? "abandon" : "abandon-start",
    subject: feed.name,
    label: closes ? `close the round of ${feed.name}` : `start the wait on the round of ${feed.name}`,
    reason,
    call: { address: snapshot.questions, abi: QUESTIONS_ABI, functionName: "abandon", args: [feed.feedId] },
  };
}

function decidePending(
  snapshot: QuestionsSnapshot,
  policy: QuestionsPolicy,
  feed: FeedView,
  round: PendingRound,
): Decision {
  const actions: Action[] = [];
  const waiting: Waiting[] = [];
  const subject = `${feed.name} round ${round.round}`;
  const wait = (reason: string, extra: Partial<Waiting> = {}) =>
    waiting.push({ module: "questions", subject, reason, ...extra });
  const { now, constants } = snapshot;
  const verdict = verdictOf(feed, round, snapshot, policy);
  const silenceEnds = silenceEndsAt(round, constants);
  const silenceUp = now >= silenceEnds;
  const silence = silenceText(round, constants);

  if (verdict.kind === "answer") {
    const byTheRule = submitOpenByTheRule(now, round, constants);
    if (byTheRule && round.canSubmit) {
      actions.push({
        module: "questions",
        kind: "submit",
        subject: feed.name,
        label: `submit the answer of ${feed.name}`,
        reason: round.intakeCompleted
          ? `the Intake completed the request of round ${round.round} and nothing was stored; the signed answer of oracle request ${verdict.answer.oracleRequestId} is handed in`
          : `round ${round.round} was requested ${now - round.requestedAt} seconds ago, the Intake has not delivered, and the signed answer of oracle request ${verdict.answer.oracleRequestId} is public`,
        call: {
          address: snapshot.questions,
          abi: QUESTIONS_ABI,
          functionName: "submit",
          args: [feed.feedId, verdict.answer.message, verdict.answer.signature],
        },
      });
    } else if (byTheRule !== round.canSubmit) {
      wait(
        `the signed answer is in hand, but the contract says submit is ${round.canSubmit ? "open" : "closed"} where the keeper's reading of its rule says ${byTheRule ? "open" : "closed"}; nothing is sent`,
        { attention: true },
      );
    } else {
      wait("the signed answer is in hand; the Intake's callback has the first thirty minutes to itself", {
        until: Number(submitOpensAt(round, constants)),
      });
    }
    return { actions, waiting };
  }

  const step = round.abandonStep;
  const closable = step === ABANDON_STEP.Close;

  if (verdict.kind === "none") {
    if (step === ABANDON_STEP.StartWait) {
      actions.push(abandonAction(snapshot, feed, false, verdict.why));
    } else if (closable) {
      actions.push(abandonAction(snapshot, feed, true, verdict.why));
    } else {
      wait(`${verdict.why}; the round can be closed at ${round.closableAt}`, {
        until: Number(round.closableAt),
      });
    }
    return { actions, waiting };
  }

  if (verdict.kind === "unseen") {
    if (closable && silenceUp) {
      actions.push(
        abandonAction(
          snapshot,
          feed,
          true,
          `${verdict.why}, and the silence deadline (${silence} after the request) has passed`,
        ),
      );
    } else {
      wait(
        `${verdict.why}. ${
          feed.submitAllowed
            ? "Anyone who buys the same question for this contract can hand its answer in; the keeper does not buy answers."
            : "Only the Intake's callback can answer this feed."
        } The round can be closed ${silence} after its request`,
        { until: Number(silenceEnds), attention: now >= submitOpensAt(round, constants) },
      );
    }
    return { actions, waiting };
  }

  // Coming, or unknown: an answer may be on its way, or the keeper cannot tell.
  if (closable && silenceUp && policy.closeRoundsInProgress) {
    actions.push(
      abandonAction(
        snapshot,
        feed,
        true,
        `the silence deadline (${silence} after the request) has passed and CLOSE_ROUNDS_IN_PROGRESS is set, although ${verdict.why}`,
      ),
    );
    return { actions, waiting };
  }
  if (closable) {
    wait(
      `the round can be closed, and the keeper is not closing it: ${verdict.why}. An answer that arrives after its round was closed is refused. Set CLOSE_ROUNDS_IN_PROGRESS=1 to close such rounds once their silence deadline (${silence} after the request) has passed`,
      { attention: true },
    );
    return { actions, waiting };
  }
  if (verdict.kind === "unknown") {
    wait(`${verdict.why}; a round is not closed blind`, { until: Number(silenceEnds), attention: true });
    return { actions, waiting };
  }
  if (feed.submitAllowed) {
    const opensAt = submitOpensAt(round, constants);
    wait(
      now >= opensAt
        ? `${verdict.why}; no signed answer for this contract is served yet`
        : `${verdict.why}; an answer can be handed in from ${opensAt}`,
      now >= opensAt ? { until: Number(silenceEnds) } : { until: Number(opensAt) },
    );
  } else {
    wait(`${verdict.why}; only the Intake's callback can answer this feed, and it has until ${silenceEnds}`, {
      until: Number(silenceEnds),
    });
  }
  return { actions, waiting };
}

function decideIdle(snapshot: QuestionsSnapshot, policy: QuestionsPolicy, feed: FeedView): Decision {
  const actions: Action[] = [];
  const waiting: Waiting[] = [];
  const wait = (reason: string, extra: Partial<Waiting> = {}) =>
    waiting.push({ module: "questions", subject: feed.name, reason, ...extra });
  const { now } = snapshot;
  const can = feed.canRequest;

  if (can.ok) {
    // The contract checked the meter; the keeper checks it once more before it spends gas.
    if (feed.meterBalance < feed.cost || feed.cost === 0n) {
      wait(
        `canRequest says yes, but the meter holds ${feed.meterBalance} against a cost of ${feed.cost}; nothing is sent`,
        { attention: true },
      );
      return { actions, waiting };
    }
    if (policy.requestAtUtc !== null && feed.rounds !== 0n) {
      const hold = slotHold(now, feed.lastRequestedAt, policy.requestAtUtc);
      if (hold !== null) {
        wait(hold.reason, { until: Number(hold.until) });
        return { actions, waiting };
      }
    }
    actions.push(
      requestAction(
        snapshot,
        feed,
        `canRequest allows it: the window is blocks ${can.fromBlock} to ${can.toBlock}, the price ${can.price}, and the meter holds ${feed.meterBalance}`,
      ),
    );
    return { actions, waiting };
  }

  const why = requestBlockerName(can.why);
  if (can.why === REQUEST_BLOCKER.MeterTooLow) {
    // Only when the top-up would make the request possible: a call that leaves the meter too low
    // would be asked for again on every pass.
    const covers =
      feed.cost > 0n && feed.payrollTopUp !== null && feed.meterBalance + feed.payrollTopUp >= feed.cost;
    if (snapshot.payroll !== null && feed.payrollTopUp !== null && feed.payrollTopUp > 0n && covers) {
      actions.push({
        module: "questions",
        kind: "fundFeeds",
        subject: feed.name,
        label: "top up the meters from Payroll's feed budget",
        reason: `the meter of ${feed.name} holds ${feed.meterBalance}, less than a request costs, and Payroll would place ${feed.payrollTopUp} on it`,
        call: { address: snapshot.payroll, abi: PAYROLL_ABI, functionName: "fundFeeds", args: [] },
        gasFloor: FUND_FEEDS_GAS_FLOOR,
      });
      wait("the meter is too low; the request follows once Payroll has topped it up");
    } else {
      wait(
        `the meter holds ${feed.meterBalance}, less than a request costs (${can.price} and the tip), and Payroll has no budget that would cover it: fund the meter`,
        { attention: true },
      );
    }
  } else if (can.why === REQUEST_BLOCKER.TooSoon) {
    const blocks = feed.nextRequestBlock > snapshot.block ? feed.nextRequestBlock - snapshot.block : 0n;
    wait(
      `the cadence allows the next request at block ${feed.nextRequestBlock}${feed.failStreak > 0 ? ` (${feed.failStreak} failed rounds in a row have lengthened it)` : ""}`,
      { until: Number(now + blocks * BigInt(SECONDS_PER_BLOCK)) },
    );
  } else if (can.why === REQUEST_BLOCKER.UnknownFeed) {
    wait("the feed does not exist on this contract: run the first-day command", { attention: true });
  } else if (can.why === REQUEST_BLOCKER.PriceAboveCap) {
    wait(`the Intake's price (${can.price}) is above the feed's cap; requests stop until it falls`, {
      attention: true,
    });
  } else if (can.why === REQUEST_BLOCKER.NotSold) {
    wait("the Intake does not sell the feed's action for IMD, or its price cannot be read", {
      attention: true,
    });
  } else {
    wait(`canRequest says no: ${why}`);
  }
  return { actions, waiting };
}

/** State in, actions with reasons out. Pure. */
export function decideQuestions(snapshot: QuestionsSnapshot, policy: QuestionsPolicy): Decision {
  const topUps: Action[] = [];
  const answers: Action[] = [];
  const closings: Action[] = [];
  const requests: Action[] = [];
  const waiting: Waiting[] = [];

  for (const feed of snapshot.feeds) {
    if (!feed.exists) {
      waiting.push({
        module: "questions",
        subject: feed.name,
        reason: "the feed does not exist on this contract: run the first-day command",
        attention: true,
      });
      continue;
    }
    const decision =
      feed.pending === null
        ? decideIdle(snapshot, policy, feed)
        : decidePending(snapshot, policy, feed, feed.pending);
    for (const action of decision.actions) {
      if (action.kind === "fundFeeds") topUps.push(action);
      else if (action.kind === "submit") answers.push(action);
      else if (action.kind === "request") requests.push(action);
      else closings.push(action);
    }
    waiting.push(...decision.waiting);
  }

  const actions = [...topUps, ...answers, ...closings, ...requests];
  if (snapshot.tips !== null && snapshot.tips.earned > 0n && snapshot.tips.earned >= policy.tipCollectMin) {
    actions.push({
      module: "questions",
      kind: "collectTips",
      subject: "tips",
      label: "collect earned tips",
      reason: `${snapshot.tips.earned} of tips are earned, at or above the threshold of ${policy.tipCollectMin}`,
      call: { address: snapshot.questions, abi: QUESTIONS_ABI, functionName: "collectTips", args: [] },
    });
  }
  return { actions, waiting };
}
