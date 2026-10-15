/**
 * The status file: a small JSON document written after every run, for a web page or an alert.
 *
 * It says what was checked, what was done (each transaction with the reason its rule fired), what
 * is waiting and why, the balances, what was spent on gas today, and when each feed is next due.
 * It holds nothing secret: no key, no RPC URL. Amounts are decimal strings of wei; times are unix
 * seconds unless a field says otherwise. Anything an operator should look at is repeated under
 * `attention`.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { formatUnits, type Address, type Hex } from "viem";
import { abandonStepName, requestBlockerName } from "@help-wanted/shared";
import { orderStateName } from "@help-wanted/shared";
import type { ActionSource, Waiting } from "./actions.js";
import type { ClaimRecord, DeskSnapshot } from "./modules/desk.js";
import type { DoorbellSnapshot } from "./modules/doorbell.js";
import { endowmentKindName, type EndowmentsSnapshot } from "./modules/endowments.js";
import type { JobsReportSnapshot } from "./modules/jobsReport.js";
import type { ModuleName } from "./modules/names.js";
import type { PayrollSnapshot } from "./modules/payroll.js";
import { potStageName, type PotsSnapshot } from "./modules/pots.js";
import type { RulesSnapshot } from "./modules/rules.js";
import {
  SECONDS_PER_BLOCK,
  silenceEndsAt,
  slotHold,
  submitOpensAt,
  type QuestionsSnapshot,
} from "./modules/questions.js";

export interface ActionRecord {
  module: ActionSource;
  kind: string;
  subject: string;
  label: string;
  reason: string;
  /**
   * `sent`: mined. `dry-run`: simulated only. `failed`: not sent, or sent and reverted; `error`
   * says which. `planned`: listed by the status command, which sends nothing. `left`: not reached
   * in this pass (an earlier step stopped it, or the pass had done its rounds).
   */
  outcome: "sent" | "dry-run" | "failed" | "planned" | "left";
  hash?: Hex;
  block?: string;
  gasUsed?: string;
  costWei?: string;
  wouldSucceed?: boolean | null;
  code?: string;
  error?: string;
}

export interface FeedDue {
  feed: string;
  /** The first block the cadence allows a request at; null while a round is pending. */
  block: string | null;
  /** Roughly when that is, at twelve seconds a block, and not before the daily slot if one is set. */
  at: number | null;
  note: string;
}

export interface StatusFile {
  v: 1;
  /** When this file was written, ISO 8601. */
  at: string;
  command: string;
  mode: "live" | "dry-run";
  dryRunReason: string | null;
  keeper: Address | null;
  chainId: number;
  /** The block the last look was taken at. */
  block: { number: string; time: number } | null;
  killed: boolean;
  /** One line per thing looked at. */
  checked: string[];
  /** What was sent, would be sent, or failed, in order. */
  done: ActionRecord[];
  waiting: Waiting[];
  /** What an operator should look at; empty when all is well. */
  attention: string[];
  balances: {
    eth: string | null;
    ethFormatted: string | null;
    imd: string | null;
    tipsEarned: string | null;
    tipsPending: string | null;
  };
  /** Gas spent, or set aside for a transaction in flight, in the current UTC day. */
  spend: { day: string; spentWei: string; capWei: string };
  /** When each feed is next due. */
  nextDue: FeedDue[];
  /** The earliest time something being waited for is expected to change. */
  nextLookAt: number | null;
  modules: {
    enabled: ModuleName[];
    /** Modules named and not built. Empty since the modules of launches B and C were built. */
    later: Record<string, string>;
    questions?: unknown;
    jobsReport?: unknown;
    payroll?: unknown;
    /** The hire desk: every live order, and every delivery claim looked at with what was made of it. */
    desk?: unknown;
    pots?: unknown;
    /** The Doorbell's state. The keeper never rings. */
    doorbell?: unknown;
    rules?: unknown;
    endowments?: unknown;
  };
  errors: { module: string; error: string }[];
  /** Written by the first-day command only: its plan digest and where each step stands. */
  firstDay?: unknown;
}

const s = (value: bigint): string => value.toString();
const imd = (value: bigint): string => formatUnits(value, 18);

/** When each feed may next be asked. */
export function nextDueOf(snapshot: QuestionsSnapshot, requestAtUtc: number | null): FeedDue[] {
  return snapshot.feeds.map((feed) => {
    if (!feed.exists) return { feed: feed.name, block: null, at: null, note: "the feed does not exist yet" };
    if (feed.pending !== null) {
      return {
        feed: feed.name,
        block: null,
        at: null,
        note: `round ${feed.pending.round} is pending; the next request follows its answer or its closing`,
      };
    }
    const blocks = feed.nextRequestBlock > snapshot.block ? feed.nextRequestBlock - snapshot.block : 0n;
    let at = snapshot.now + blocks * BigInt(SECONDS_PER_BLOCK);
    let note = blocks === 0n ? "due now, as far as the cadence goes" : `due in about ${blocks} blocks`;
    if (requestAtUtc !== null && feed.rounds !== 0n) {
      // The same rule the decision applies, at the moment the cadence allows the request.
      const hold = slotHold(at, feed.lastRequestedAt, requestAtUtc);
      if (hold !== null) {
        at = hold.until;
        note = `${note}; asked at the next daily slot`;
      }
    }
    if (!feed.canRequest.ok && blocks === 0n) note = `blocked: ${requestBlockerName(feed.canRequest.why)}`;
    return { feed: feed.name, block: s(feed.nextRequestBlock), at: Number(at), note };
  });
}

/** The questions snapshot as the status file shows it. */
export function describeQuestions(snapshot: QuestionsSnapshot): unknown {
  return {
    questions: snapshot.questions,
    oracleSigner: snapshot.oracleSigner,
    tips:
      snapshot.tips === null
        ? null
        : {
            earned: s(snapshot.tips.earned),
            pending: s(snapshot.tips.pending),
            earnedImd: imd(snapshot.tips.earned),
          },
    feeds: snapshot.feeds.map((feed) => ({
      name: feed.name,
      feedId: feed.feedId,
      exists: feed.exists,
      submitAllowed: feed.submitAllowed,
      rounds: s(feed.rounds),
      latestRound: s(feed.latestRound),
      failStreak: feed.failStreak,
      meter: {
        balance: s(feed.meterBalance),
        balanceImd: imd(feed.meterBalance),
        cost: s(feed.cost),
        requestsLeft: feed.cost === 0n ? null : Number(feed.meterBalance / feed.cost),
      },
      canRequest: feed.canRequest.ok,
      blocker: feed.exists ? requestBlockerName(feed.canRequest.why) : "UnknownFeed",
      nextRequestBlock: s(feed.nextRequestBlock),
      payrollTopUp: feed.payrollTopUp === null ? null : s(feed.payrollTopUp),
      pending:
        feed.pending === null
          ? null
          : {
              round: s(feed.pending.round),
              requestedAt: Number(feed.pending.requestedAt),
              ageSeconds: Number(snapshot.now - feed.pending.requestedAt),
              window: { fromBlock: s(feed.pending.fromBlock), toBlock: s(feed.pending.toBlock) },
              intakeRequestId: feed.pending.intakeRequestId,
              requestTx: feed.pending.requestTx,
              intakeCompleted: feed.pending.intakeCompleted,
              canSubmit: feed.pending.canSubmit,
              submitOpensAt: feed.submitAllowed
                ? Number(submitOpensAt(feed.pending, snapshot.constants))
                : null,
              abandonStep: abandonStepName(feed.pending.abandonStep),
              closableAt: Number(feed.pending.closableAt),
              silenceEndsAt: Number(silenceEndsAt(feed.pending, snapshot.constants)),
              service:
                feed.pending.service.kind === "seen"
                  ? {
                      kind: "seen",
                      state: feed.pending.service.state,
                      reason: feed.pending.service.reason,
                      oracleRequestId: feed.pending.service.oracleRequestId,
                      completionStatus: feed.pending.service.completionStatus,
                      delivered: feed.pending.service.delivered,
                      failure: feed.pending.service.failure,
                      answer: feed.pending.service.answer.kind,
                    }
                  : feed.pending.service,
            },
    })),
  };
}

export function describeJobsReport(snapshot: JobsReportSnapshot): unknown {
  const m = snapshot.summary;
  return {
    jobsReport: snapshot.jobsReport,
    prints: s(m.prints),
    counts: s(m.counts),
    total: s(m.total),
    totalImd: imd(m.total),
    totalCount: s(m.totalCount),
    streak: s(m.streak),
    payrollsRead: s(m.payrollsRead),
    payrollsAnswered: s(snapshot.payrolls.latestRound),
    hiresRead: s(m.hiresRead),
    hiresAnswered: s(snapshot.hires.latestRound),
    crowns: s(m.crowns),
    latestCrownedRound: s(m.latestCrownedRound),
    crownCandidates: snapshot.crownCandidates.map((c) => ({
      round: s(c.round),
      crowned: c.crowned,
      status: c.status,
      list: c.answer.kind,
    })),
  };
}

export function describePayroll(snapshot: PayrollSnapshot): unknown {
  return {
    payroll: snapshot.payroll,
    unbooked: s(snapshot.unbooked),
    stream: {
      outstanding: s(snapshot.stream.outstanding),
      unvested: s(snapshot.stream.unvested),
      endsAt: Number(snapshot.stream.endsAt),
      perDrip: s(snapshot.stream.perDrip),
      dueNow: s(snapshot.stream.dueNow),
      nextDripAt: Number(snapshot.stream.nextDripAt),
      lastDripAt: Number(snapshot.lastDripAt),
    },
    feedBudget: {
      total: s(snapshot.feedBudget.total),
      old: s(snapshot.feedBudget.old),
      releasableNow: s(snapshot.feedBudget.releasableNow),
      nextReleaseAt: Number(snapshot.feedBudget.nextReleaseAt),
    },
    shortfalls: snapshot.shortfalls.map(s),
  };
}

/** What the desk module saw: every live order in a line, and every delivery claim it judged. */
export function describeDesk(snapshot: DeskSnapshot, claims: readonly ClaimRecord[]): unknown {
  const byState: Record<string, number> = {};
  for (const order of snapshot.orders) {
    const name = orderStateName(order.state);
    byState[name] = (byState[name] ?? 0) + 1;
  }
  return {
    workOrders: snapshot.workOrders,
    orderCount: s(snapshot.orderCount),
    live: snapshot.orders.length,
    byState,
    receiptsFlowing: snapshot.receiptsFlowing,
    challengeBonds: {
      postedToday: s(snapshot.challengedToday),
      keeperImd: snapshot.keeperImd === null ? null : s(snapshot.keeperImd),
    },
    orders: snapshot.orders.map((order) => ({
      id: s(order.id),
      state: orderStateName(order.state),
      employer: order.employer,
      runner: order.claim.runner,
      jobId: order.claim.jobId,
      expiresAt: Number(order.expiresAt),
      deliveryDeadline:
        order.claim.registeredAt === 0n ? null : Number(order.claim.registeredAt + order.deliverySecs),
      claimedPath: (order.flags & 1) !== 0,
      proven: order.proven,
      receipt:
        order.receipt === null
          ? null
          : order.receipt.kind === "read"
            ? { hash: order.receipt.hash, bytes: order.receipt.bytes, verdict: order.receipt.verdict.kind }
            : order.receipt.kind === "unread"
              ? { hash: order.receipt.hash, verdict: "unread" }
              : { hash: null, verdict: "none" },
    })),
    claims,
  };
}

export function describePots(snapshot: PotsSnapshot): unknown {
  return {
    crowdPots: snapshot.crowdPots,
    potCount: s(snapshot.potCount),
    pots: snapshot.pots.map((pot) => ({
      id: s(pot.id),
      stage: potStageName(pot.stage),
      liveStage: potStageName(pot.liveStage),
      raised: s(pot.raised),
      target: s(pot.target),
      deadline: Number(pot.deadline),
      orderId: pot.orderId === 0n ? null : s(pot.orderId),
      pool: s(pot.pool),
      refundable: pot.refundable.map((r) => ({ contributor: r.contributor, amount: s(r.amount) })),
      specKnown: pot.spec !== null,
    })),
  };
}

export function describeDoorbell(snapshot: DoorbellSnapshot): unknown {
  return {
    doorbell: snapshot.doorbell,
    rings: s(snapshot.rings),
    hires: s(snapshot.hires),
    receipts: s(snapshot.receipts),
    ringsUntilHire: s(snapshot.ringsUntilHire),
    funded: snapshot.funded,
    balance: s(snapshot.balance),
    balanceImd: imd(snapshot.balance),
    orderEscrow: s(snapshot.maxPay),
    allowClaimed: snapshot.allowClaimed,
    lastOrderId: snapshot.hires === 0n ? null : s(snapshot.lastOrderId),
    lastOrderState: snapshot.lastOrderState,
    note: "the keeper never rings: ringing is for people",
  };
}

export function describeRules(snapshot: RulesSnapshot): unknown {
  return {
    rules: snapshot.rules,
    ruleCount: s(snapshot.ruleCount),
    feePerGas: snapshot.feePerGas === null ? null : s(snapshot.feePerGas),
    armed: snapshot.list.map((rule) => ({
      id: s(rule.id),
      action: rule.action === 1 ? "hire" : "pay",
      canFire: rule.canFire,
      conditionHolds: rule.met,
      value: s(rule.value),
      tip: s(rule.tip),
      escrow: s(rule.escrow),
      cost: s(rule.cost),
      fires: rule.fires,
      maxFires: rule.maxFires,
    })),
    orders: snapshot.orders.map((order) => ({
      rule: s(order.ruleId),
      order: s(order.orderId),
      state: orderStateName(order.state),
      returned: s(order.returned),
      credited: s(order.credited),
    })),
  };
}

export function describeEndowments(snapshot: EndowmentsSnapshot): unknown {
  return {
    endowments: snapshot.endowments,
    endowmentCount: s(snapshot.endowmentCount),
    pendingTotal: s(snapshot.pendingTotal),
    nextStakeBlock: s(snapshot.nextStakeBlock),
    priceBelowMark: snapshot.priceBelowMark,
    vaultHold: snapshot.vaultHold,
    list: snapshot.list.map((e) => ({
      id: s(e.id),
      kind: endowmentKindName(e.kind),
      target: e.target,
      principal: s(e.principal),
      harvestable: s(e.harvestable),
    })),
  };
}

/** Writes the status file whole: to a temporary file that is then renamed. */
export function writeStatus(path: string, status: StatusFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, path);
}
