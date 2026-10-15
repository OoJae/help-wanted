/**
 * One pass of the keeper: look, decide, act, look again, and write the status file.
 *
 * A pass is a few rounds. In each, every enabled module observes (reads only) and decides (a pure
 * function); the actions are sent one at a time through the chain writer, which simulates, caps
 * and waits for each. If anything was sent the pass looks again, because one step often makes the
 * next possible: a top-up lets a request through, a handed-in answer lets the report print. It
 * stops when there is nothing left to do, after `maxRounds` rounds, or when a failure means
 * nothing more can be sent (the kill switch, the fee cap, the daily cap, a transaction still in
 * flight). In a dry run nothing changes, so one round says everything.
 *
 * The last thing a pass does is observe once more and write the status file from that fresh look.
 */
import { parseEventLogs, type Abi, type Address } from "viem";
import { erc20Abi, questionsAbi } from "@help-wanted/shared";
import { dedupe, type Action, type Decision, type Waiting } from "./actions.js";
import { ChainWriteError, STOPS_THE_PASS, type ChainCall, type WriteOutcome } from "./chain.js";
import type { KeeperConfig } from "./config.js";
import type { Logger } from "./log.js";
import { decideDesk, type ClaimRecord, type DeskSnapshot } from "./modules/desk.js";
import { decideDoorbell, type DoorbellSnapshot } from "./modules/doorbell.js";
import { decideEndowments, type EndowmentsSnapshot } from "./modules/endowments.js";
import { decideJobsReport, type JobsReportSnapshot } from "./modules/jobsReport.js";
import { BUILT_MODULES, type ModuleName } from "./modules/names.js";
import { decidePayroll, type PayrollSnapshot } from "./modules/payroll.js";
import { decidePots, type PotsSnapshot } from "./modules/pots.js";
import { decideQuestions, type QuestionsSnapshot } from "./modules/questions.js";
import { decideRules, type RulesSnapshot } from "./modules/rules.js";
import {
  messageOf,
  readOnce,
  type ObserveCache,
  type ObserveContext,
  type Reader,
  type ServiceApi,
} from "./observe/common.js";
import { observeDesk } from "./observe/desk.js";
import { observeDoorbell } from "./observe/doorbell.js";
import { observeEndowments } from "./observe/endowments.js";
import { observeJobsReport } from "./observe/jobsReport.js";
import { observePayroll } from "./observe/payroll.js";
import { observePots } from "./observe/pots.js";
import { observeQuestions } from "./observe/questions.js";
import { observeRules } from "./observe/rules.js";
import {
  describeDesk,
  describeDoorbell,
  describeEndowments,
  describeJobsReport,
  describePayroll,
  describePots,
  describeQuestions,
  describeRules,
  nextDueOf,
  writeStatus,
  type ActionRecord,
  type StatusFile,
} from "./status.js";
import { claimKey, noteChallenge, noteRound, spentOn, utcDay, type ClaimNote, type Store } from "./store.js";

const QUESTIONS_ABI = questionsAbi as unknown as Abi;
const ERC20_ABI = erc20Abi as unknown as Abi;

/** Everything a pass works with. The command line builds it; tests build it from stand-ins. */
export interface Runtime {
  config: KeeperConfig;
  reader: Reader;
  api: ServiceApi;
  store: Store;
  writer: { readonly mode: "live" | "dry-run"; send(call: ChainCall): Promise<WriteOutcome> };
  log: Logger;
  cache: ObserveCache;
  killed: () => boolean;
  /** The wall clock, in unix seconds: for the status file and the daily cap only. */
  now: () => number;
}

interface Look {
  block: { number: bigint; timestamp: bigint };
  questions?: QuestionsSnapshot;
  jobsReport?: JobsReportSnapshot;
  payroll?: PayrollSnapshot;
  desk?: DeskSnapshot;
  /** Every delivery claim the desk module looked at on this look, and what it made of it. */
  claims?: ClaimRecord[];
  pots?: PotsSnapshot;
  doorbell?: DoorbellSnapshot;
  rules?: RulesSnapshot;
  endowments?: EndowmentsSnapshot;
  actions: Action[];
  waiting: Waiting[];
  errors: { module: string; error: string }[];
}

function contextOf(rt: Runtime, block: Look["block"]): ObserveContext {
  return {
    reader: rt.reader,
    api: rt.api,
    store: rt.store,
    log: rt.log,
    cache: rt.cache,
    block,
    chainId: rt.config.chainId,
    keeper: rt.config.keeper,
  };
}

/** Every enabled module observes and decides. A module that fails is reported and the rest go on. */
export async function look(rt: Runtime): Promise<Look> {
  const { config } = rt;
  const block = await rt.reader.getBlock();
  const ctx = contextOf(rt, block);
  const out: Look = { block, actions: [], waiting: [], errors: [] };
  const collected: Decision[] = [];
  const run = async (name: ModuleName, body: () => Promise<Decision>) => {
    if (!config.modules.has(name)) return;
    try {
      collected.push(await body());
    } catch (error) {
      rt.log.error("a module could not be read", { module: name, error: messageOf(error) });
      out.errors.push({ module: name, error: messageOf(error) });
    }
  };

  await run("questions", async () => {
    out.questions = await observeQuestions(ctx, {
      questions: config.questions as Address,
      payroll: config.payroll,
      feeds: config.feeds,
    });
    return decideQuestions(out.questions, {
      tipCollectMin: config.tipCollectMin,
      closeRoundsInProgress: config.closeRoundsInProgress,
      expiryMarginSeconds: config.expiryMarginSeconds,
      requestAtUtc: config.requestAtUtc,
    });
  });
  await run("jobsReport", async () => {
    out.jobsReport = await observeJobsReport(ctx, {
      jobsReport: config.jobsReport as Address,
      crown: config.feeds.some((feed) => feed.name === "employers"),
    });
    return decideJobsReport(out.jobsReport);
  });
  await run("payroll", async () => {
    out.payroll = await observePayroll(ctx, { payroll: config.payroll as Address });
    return decidePayroll(out.payroll, {
      bookMin: config.bookMin,
      dripEverySeconds: config.dripEverySeconds,
      fundFeedsMin: config.fundFeedsMin,
    });
  });

  // Launch B. The desk comes before the pots: a claim it ends is what lets a pot settle its books.
  await run("desk", async () => {
    out.desk = await observeDesk(ctx, {
      workOrders: config.workOrders as Address,
      maxOrders: config.maxItems,
      receiptStallBlocks: config.receiptStallBlocks,
      stampWatchSeconds: config.stampWatchSeconds,
    });
    const decision = decideDesk(out.desk, {
      keeper: config.keeper,
      challengeFloat: config.challengeFloat,
      challengeDailyCap: config.challengeDailyCap,
      challengeArbiters: config.challengeArbiters,
      challengeEmployers: config.challengeEmployers,
      challengeConfirmSeconds: config.challengeConfirmSeconds,
      ownRunners: config.ownRunners,
      maxRecordBytes: config.maxRecordBytes,
      finalizeClaims: config.finalizeClaims,
      settleReceipts: config.settleReceipts,
    });
    out.claims = decision.claims;
    noteClaims(rt, out.desk, decision.claims);
    return decision;
  });
  const startBlock = (launch: bigint | null): bigint =>
    launch ??
    (block.number > BigInt(config.logLookbackBlocks) ? block.number - BigInt(config.logLookbackBlocks) : 0n);
  await run("pots", async () => {
    out.pots = await observePots(ctx, {
      crowdPots: config.crowdPots as Address,
      startBlock: startBlock(config.startBlockB),
      maxPots: config.maxItems,
      maxContributors: config.maxItems,
    });
    return decidePots(out.pots, { refundBatch: config.potsRefundBatch, refundMin: config.potsRefundMin });
  });
  await run("doorbell", async () => {
    out.doorbell = await observeDoorbell(ctx, { doorbell: config.doorbell as Address });
    return decideDoorbell(out.doorbell);
  });
  // Launch C.
  await run("rules", async () => {
    out.rules = await observeRules(ctx, {
      rules: config.rules as Address,
      workOrders: config.workOrders as Address,
      startBlock: startBlock(config.startBlockC),
      maxRules: config.maxItems,
    });
    return decideRules(out.rules, {
      house: config.houseRules,
      imdPerEth: config.imdPerEth,
      tipCoverBps: config.tipCoverBps,
    });
  });
  await run("endowments", async () => {
    out.endowments = await observeEndowments(ctx, {
      endowments: config.endowments as Address,
      maxEndowments: config.maxItems,
    });
    return decideEndowments(out.endowments, { stakeMin: config.stakeMin, harvestMin: config.harvestMin });
  });

  // Two rules can ask for the same call (a low meter and Payroll's own shortfall rule both want
  // `fundFeeds`): it is sent once.
  out.actions = dedupe(collected.flatMap((d) => d.actions));
  out.waiting = collected.flatMap((d) => d.waiting);
  return out;
}

/**
 * Keeps what was made of each delivery claim: when it was first and last looked at, the verdict
 * and its reasons, when it was first seen to fail the check (a challenge waits for a second look),
 * and what the keeper decided to do. The notes survive a restart; the newest few hundred are kept.
 */
export function noteClaims(rt: Runtime, snapshot: DeskSnapshot, claims: readonly ClaimRecord[]): void {
  if (claims.length === 0) return;
  const state = rt.store.data;
  const notes: Record<string, ClaimNote> = { ...(state.claims ?? {}) };
  const now = Number(snapshot.now);
  let changed = false;
  for (const claim of claims) {
    const key = claimKey(claim.order, claim.seq);
    const before = notes[key];
    const view = snapshot.orders.find((o) => o.id.toString() === claim.order);
    const failingSince =
      view?.failingSince === null || view === undefined ? undefined : Number(view.failingSince);
    const next: ClaimNote = {
      order: claim.order,
      seq: claim.seq,
      runner: claim.runner,
      jobId: claim.jobId,
      namedHash: claim.namedHash,
      assertedAt: claim.assertedAt,
      firstSeenAt: before?.firstSeenAt ?? now,
      lastSeenAt: now,
      // A claim found true stays true: the job cannot stop being completed. And a look that
      // could not judge the claim does not wipe out what an earlier look found.
      verdict: keepsEarlier(before, claim) ? (before as ClaimNote).verdict : claim.verdict,
      reasons: keepsEarlier(before, claim) ? (before as ClaimNote).reasons : claim.reasons,
      ...(failingSince === undefined ? {} : { failingSince }),
      action: claim.action,
      why: claim.why,
      ...(before?.did === undefined ? {} : { did: before.did }),
      ...(before?.tx === undefined ? {} : { tx: before.tx }),
    };
    if (
      before === undefined ||
      before.verdict !== next.verdict ||
      before.action !== next.action ||
      before.why !== next.why ||
      before.failingSince !== next.failingSince
    ) {
      changed = true;
      if (before === undefined || before.verdict !== next.verdict || before.action !== next.action) {
        rt.log.info("looked at a delivery claim", {
          order: claim.order,
          runner: claim.runner,
          jobId: claim.jobId,
          namedHash: claim.namedHash,
          verdict: next.verdict,
          reasons: next.reasons,
          action: claim.action,
          why: claim.why,
        });
      }
    }
    notes[key] = next;
  }
  state.claims = notes;
  if (changed) {
    try {
      rt.store.save();
    } catch (error) {
      rt.log.debug("the state file could not be written", { error: messageOf(error) });
    }
  }
}

/** Whether a claim's earlier verdict stands over the one of this look. */
function keepsEarlier(before: ClaimNote | undefined, claim: ClaimRecord): boolean {
  if (before === undefined) return false;
  if (before.verdict === "true") return true;
  return before.verdict === "untrue" && claim.verdict === "unknown";
}

/** After a desk action for a claim is mined: note its transaction, and book a challenge's bond. */
function noteDeskAction(
  rt: Runtime,
  action: Action,
  outcome: Extract<WriteOutcome, { kind: "sent" }>,
  chainTime: bigint | null,
): void {
  try {
    const state = rt.store.data;
    if (action.postsImd !== undefined && action.postsImd > 0n) {
      // The day is the chain's: the cap is held against the same clock the snapshot reads.
      noteChallenge(state, utcDay(chainTime === null ? rt.now() : Number(chainTime)), action.postsImd);
    }
    const order = /^order (\d+)$/.exec(action.subject)?.[1];
    if (order !== undefined && state.claims) {
      // The newest claim of the order is the one the action was decided for.
      const newest = Object.entries(state.claims)
        .filter(([, note]) => note.order === order)
        .sort((a, b) => b[1].seq - a[1].seq)[0];
      const claimActions = ["challenge", "finalize", "settle", "reportFailed", "timeout", "stamp"];
      if (newest !== undefined && claimActions.includes(action.kind)) {
        state.claims[newest[0]] = { ...newest[1], did: action.kind, tx: outcome.hash };
      }
    }
    rt.store.save();
  } catch (error) {
    rt.log.debug("could not note a desk action", { error: messageOf(error) });
  }
}

function recordOf(
  action: Action,
  outcome: ActionRecord["outcome"],
  extra: Partial<ActionRecord> = {},
): ActionRecord {
  return {
    module: action.module,
    kind: action.kind,
    subject: action.subject,
    label: action.label,
    reason: action.reason,
    outcome,
    ...extra,
  };
}

/** After a request is mined: note which transaction opened which round, to find its answer by. */
function noteRequest(rt: Runtime, outcome: Extract<WriteOutcome, { kind: "sent" }>): void {
  try {
    const opened = parseEventLogs({ abi: questionsAbi, logs: [...outcome.logs], eventName: "RoundOpened" });
    for (const log of opened) {
      noteRound(
        rt.store.data,
        log.args.feedId,
        BigInt(log.args.round),
        { requestTx: outcome.hash },
        rt.now(),
      );
    }
    if (opened.length > 0) rt.store.save();
  } catch (error) {
    rt.log.debug("could not note the round a request opened", { error: messageOf(error) });
  }
}

/**
 * Sends the actions in order, one at a time. Returns a record per action, whether anything was
 * mined, and whether the pass must stop.
 */
export async function execute(
  rt: Runtime,
  actions: readonly Action[],
  /** The time of the block the actions were decided at, when it is known. */
  chainTime: bigint | null = null,
): Promise<{ records: ActionRecord[]; sent: number; stop: boolean }> {
  const records: ActionRecord[] = [];
  let sent = 0;
  let stop = false;
  for (const action of actions) {
    if (stop) {
      records.push(recordOf(action, "left", { error: "an earlier step stopped the pass" }));
      continue;
    }
    rt.log.info("acting", { module: action.module, label: action.label, reason: action.reason });
    try {
      const outcome = await rt.writer.send({
        ...action.call,
        label: action.label,
        ...(action.gasFloor === undefined ? {} : { gasFloor: action.gasFloor }),
      });
      if (outcome.kind === "sent") {
        sent += 1;
        if (action.kind === "request") noteRequest(rt, outcome);
        if (action.module === "desk") noteDeskAction(rt, action, outcome, chainTime);
        records.push(
          recordOf(action, "sent", {
            hash: outcome.hash,
            block: outcome.blockNumber.toString(),
            gasUsed: outcome.gasUsed.toString(),
            costWei: outcome.cost.toString(),
          }),
        );
      } else {
        records.push(
          recordOf(action, "dry-run", {
            wouldSucceed: outcome.wouldSucceed,
            ...(outcome.reason === undefined ? {} : { error: outcome.reason }),
          }),
        );
      }
    } catch (error) {
      const code = error instanceof ChainWriteError ? error.code : "error";
      rt.log.warn("a step was not completed", { label: action.label, code, error: messageOf(error) });
      records.push(recordOf(action, "failed", { code, error: messageOf(error) }));
      if (error instanceof ChainWriteError && STOPS_THE_PASS.includes(error.code)) stop = true;
      // A transaction that reverted on chain has still been mined and paid for.
      if (code === "tx_reverted") sent += 1;
    }
  }
  return { records, sent, stop };
}

async function balancesOf(rt: Runtime, lookAt: Look): Promise<StatusFile["balances"]> {
  const keeper = rt.config.keeper;
  const tips = lookAt.questions?.tips ?? null;
  const out: StatusFile["balances"] = {
    eth: null,
    ethFormatted: null,
    imd: null,
    tipsEarned: tips === null ? null : tips.earned.toString(),
    tipsPending: tips === null ? null : tips.pending.toString(),
  };
  if (keeper === null) return out;
  try {
    const eth = await rt.reader.getBalance({ address: keeper, blockNumber: lookAt.block.number });
    out.eth = eth.toString();
    out.ethFormatted = (Number(eth / 10n ** 12n) / 1e6).toString();
    if (rt.config.questions !== null || lookAt.desk !== undefined) {
      const ctx = contextOf(rt, lookAt.block);
      // The token is the one the contracts themselves name.
      const token =
        lookAt.desk?.imd ??
        (await readOnce<Address>(ctx, rt.config.questions as Address, QUESTIONS_ABI, "IMD"));
      const imd = (await rt.reader.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [keeper],
        blockNumber: lookAt.block.number,
      })) as bigint;
      out.imd = imd.toString();
    }
  } catch (error) {
    rt.log.warn("could not read the keeper's balances", { error: messageOf(error) });
  }
  return out;
}

/** Builds the status document from the last look and what was done. */
export async function statusOf(
  rt: Runtime,
  command: string,
  last: Look | null,
  done: ActionRecord[],
  errors: { module: string; error: string }[],
): Promise<StatusFile> {
  const { config } = rt;
  const day = utcDay(rt.now());
  const waiting = last?.waiting ?? [];
  const balances: StatusFile["balances"] =
    last === null
      ? { eth: null, ethFormatted: null, imd: null, tipsEarned: null, tipsPending: null }
      : await balancesOf(rt, last);

  const checked: string[] = [];
  if (last?.questions) {
    for (const feed of last.questions.feeds) {
      checked.push(
        feed.exists
          ? `questions: ${feed.name}, ${feed.rounds} rounds, ${feed.pending === null ? "none pending" : `round ${feed.pending.round} pending`}, meter ${feed.meterBalance}`
          : `questions: ${feed.name} does not exist`,
      );
    }
    if (last.questions.tips) checked.push(`questions: tips earned ${last.questions.tips.earned}`);
  }
  if (last?.jobsReport) {
    const m = last.jobsReport.summary;
    checked.push(`jobsReport: ${m.prints} prints, ${m.counts} counts, ${m.crowns} crowns`);
  }
  if (last?.payroll) {
    checked.push(
      `payroll: unbooked ${last.payroll.unbooked}, due to stakers now ${last.payroll.stream.dueNow}, feed budget ${last.payroll.feedBudget.total}`,
    );
  }
  if (last?.desk) {
    checked.push(
      `desk: ${last.desk.orderCount} orders, ${last.desk.orders.length} live, ${last.claims?.length ?? 0} delivery claims looked at, receipts ${last.desk.receiptsFlowing === null ? "unread" : last.desk.receiptsFlowing ? "flowing" : "stalled"}`,
    );
  }
  if (last?.pots) checked.push(`pots: ${last.pots.potCount} pots and series, ${last.pots.pots.length} live`);
  if (last?.doorbell) {
    checked.push(
      `doorbell: ${last.doorbell.rings} rings, ${last.doorbell.hires} hires, ${last.doorbell.receipts} deliveries, ${last.doorbell.funded ? "funded" : "not funded"}`,
    );
  }
  if (last?.rules) {
    checked.push(
      `rules: ${last.rules.ruleCount} rules, ${last.rules.list.length} armed, ${last.rules.orders.length} orders followed`,
    );
  }
  if (last?.endowments) {
    checked.push(
      `endowments: ${last.endowments.endowmentCount} endowments, ${last.endowments.pendingTotal} waiting to be staked`,
    );
  }

  const attention: string[] = [];
  if (rt.killed()) attention.push("the kill switch is on: nothing is sent");
  for (const error of errors) attention.push(`${error.module} could not be read: ${error.error}`);
  for (const item of waiting) if (item.attention) attention.push(`${item.subject}: ${item.reason}`);
  for (const record of done) {
    if (record.outcome === "failed")
      attention.push(`${record.label} failed (${record.code}): ${record.error}`);
    if (record.outcome === "dry-run" && record.wouldSucceed === false) {
      attention.push(`${record.label} would revert: ${record.error}`);
    }
  }
  if (balances.eth !== null && BigInt(balances.eth) < config.minEthBalance) {
    attention.push(
      `the keeper holds ${balances.ethFormatted} ETH, below MIN_ETH_BALANCE: send it ETH for gas`,
    );
  }

  const untils = waiting.map((w) => w.until).filter((u): u is number => u !== undefined);
  return {
    v: 1,
    at: new Date(rt.now() * 1000).toISOString(),
    command,
    mode: config.mode,
    dryRunReason: config.dryRunReason,
    keeper: config.keeper,
    chainId: config.chainId,
    block:
      last === null ? null : { number: last.block.number.toString(), time: Number(last.block.timestamp) },
    killed: rt.killed(),
    checked,
    done,
    waiting,
    attention,
    balances,
    spend: {
      day,
      spentWei: spentOn(rt.store.data, day).toString(),
      capWei: config.dailySpendCap.toString(),
    },
    nextDue: last?.questions ? nextDueOf(last.questions, config.requestAtUtc) : [],
    nextLookAt: untils.length === 0 ? null : Math.min(...untils),
    modules: {
      enabled: BUILT_MODULES.filter((name) => config.modules.has(name)),
      later: {},
      ...(last?.questions ? { questions: describeQuestions(last.questions) } : {}),
      ...(last?.jobsReport ? { jobsReport: describeJobsReport(last.jobsReport) } : {}),
      ...(last?.payroll ? { payroll: describePayroll(last.payroll) } : {}),
      ...(last?.desk ? { desk: describeDesk(last.desk, last.claims ?? []) } : {}),
      ...(last?.pots ? { pots: describePots(last.pots) } : {}),
      ...(last?.doorbell ? { doorbell: describeDoorbell(last.doorbell) } : {}),
      ...(last?.rules ? { rules: describeRules(last.rules) } : {}),
      ...(last?.endowments ? { endowments: describeEndowments(last.endowments) } : {}),
    },
    errors,
  };
}

export interface PassOptions {
  /** The name of the command, for the status file. */
  command: string;
  /** Look and decide, list what would be done, and send nothing: the status command. */
  planOnly?: boolean;
}

/** One pass. Never throws for a module or a step that failed: those are in the status it returns. */
export async function runPass(rt: Runtime, options: PassOptions): Promise<StatusFile> {
  const done: ActionRecord[] = [];
  const errors: { module: string; error: string }[] = [];
  let last: Look | null = null;
  let acted = false;

  try {
    for (let round = 1; round <= rt.config.maxRounds; round++) {
      last = await look(rt);
      acted = false;
      if (last.actions.length === 0) break;
      if (options.planOnly) {
        done.push(...last.actions.map((action) => recordOf(action, "planned")));
        break;
      }
      const result = await execute(rt, last.actions, last.block.timestamp);
      done.push(...result.records);
      acted = result.sent > 0;
      // In a dry run nothing changed, so a second look would say the same.
      if (rt.writer.mode === "dry-run" || result.sent === 0 || result.stop) break;
    }
    if (acted) {
      // The status is written from a look taken after the last transaction.
      last = await look(rt);
      done.push(
        ...last.actions.map((action) => recordOf(action, "left", { error: "left for the next pass" })),
      );
    }
    if (last !== null) errors.push(...last.errors);
  } catch (error) {
    rt.log.error("the pass could not finish", { error: messageOf(error) });
    errors.push({ module: "pass", error: messageOf(error) });
  }

  const status = await statusOf(rt, options.command, last, done, errors);
  try {
    writeStatus(rt.config.statusPath, status);
  } catch (error) {
    rt.log.error("the status file could not be written", {
      path: rt.config.statusPath,
      error: messageOf(error),
    });
  }
  rt.log.info("pass finished", {
    sent: done.filter((r) => r.outcome === "sent").length,
    wouldSend: done.filter((r) => r.outcome === "dry-run" || r.outcome === "planned").length,
    failed: done.filter((r) => r.outcome === "failed").length,
    waiting: status.waiting.length,
    attention: status.attention,
  });
  return status;
}

/** Runs passes until `signal` is aborted. One failed pass does not end the loop. */
export async function runLoop(
  rt: Runtime,
  options: { signal: AbortSignal; sleep?: (ms: number, signal: AbortSignal) => Promise<void> },
): Promise<void> {
  const sleep =
    options.sleep ??
    ((ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      }));
  while (!options.signal.aborted) {
    let wait = rt.config.pollSeconds;
    try {
      const status = await runPass(rt, { command: "run" });
      wait = nextWait(rt.config.pollSeconds, status.nextLookAt, status.block?.time ?? null);
    } catch (error) {
      rt.log.error("pass failed", { error: messageOf(error) });
    }
    if (options.signal.aborted) break;
    await sleep(wait * 1000, options.signal);
  }
}

/**
 * How long to sleep before the next pass: the poll period, or less when something being waited
 * for (a `submit` that opens, a round that becomes closable) is due sooner. Never under ten
 * seconds. `nextLookAt` is in the chain's time, so it is measured from the block's time, plus a
 * block for the chain to get there.
 */
export function nextWait(pollSeconds: number, nextLookAt: number | null, blockTime: number | null): number {
  if (nextLookAt === null || blockTime === null) return pollSeconds;
  const until = nextLookAt - blockTime + 12;
  if (until >= pollSeconds) return pollSeconds;
  return Math.max(10, until);
}
