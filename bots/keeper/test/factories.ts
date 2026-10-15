/**
 * Snapshots for the decision tests. Each builder returns a state in which nothing needs doing, and
 * a test changes only the figures its rule is about.
 */
import type { Address, Hex } from "viem";
import type { OracleAttestationMessage } from "@help-wanted/shared";
import type { JobsReportSnapshot } from "../src/modules/jobsReport.js";
import type { PayrollPolicy, PayrollSnapshot } from "../src/modules/payroll.js";
import type {
  AnswerView,
  FeedView,
  PendingRound,
  QuestionsPolicy,
  QuestionsSnapshot,
  ServiceView,
} from "../src/modules/questions.js";

export const QUESTIONS: Address = "0x00000000000000000000000000000000000A11cE";
export const PAYROLL: Address = "0x000000000000000000000000000000000000c0dE";
export const JOBS_REPORT: Address = "0x0000000000000000000000000000000000000B0b";
export const KEEPER: Address = "0x0000000000000000000000000000000000000FED";
export const ORACLE_SIGNER: Address = "0x5598Aa9146215Bc13eb26f2c692Ad1461Fd32982";

/** A Tuesday afternoon, in unix seconds: 2026-10-13 14:00:00 UTC. */
export const NOW = 1_791_900_000n;
export const BLOCK = 26_200_000n;
export const REQUESTED_AT = NOW - 600n;
/**
 * The contract's silence deadline for a house feed, in seconds after the request: twelve hours to
 * sign, a day of validity, five minutes of clock tolerance and one second (36 h 5 min 1 s).
 */
export const SILENCE = 43_200n + 86_400n + 300n + 1n;

const hash = (byte: string): Hex => `0x${byte.repeat(32)}`;
export const FEED_ID = hash("f1");
export const QUESTION_HASH = hash("a1");
export const BLOCK_HASH = hash("b1");
export const INTAKE_ID = hash("c1");
export const REQUEST_TX = hash("d1");
export const ORACLE_REQUEST = "3744d864-8cbf-4fcf-8a8c-3529fb1736cb";

export const IMD = (whole: number): bigint => BigInt(Math.round(whole * 1000)) * 10n ** 15n;

export const policy = (over: Partial<QuestionsPolicy> = {}): QuestionsPolicy => ({
  tipCollectMin: IMD(0.5),
  closeRoundsInProgress: false,
  expiryMarginSeconds: 120,
  requestAtUtc: null,
  ...over,
});

/** A signed answer that passes every check for `round()` on `feed()`. */
export function message(over: Partial<OracleAttestationMessage> = {}): OracleAttestationMessage {
  return {
    requestId: `0x3744d8648cbf4fcf8a8c3529fb1736cb${"0".repeat(32)}`,
    chainId: 1n,
    questionHash: QUESTION_HASH,
    answerType: 3,
    answer: `0x${"00".repeat(31)}e4`,
    figure: 228n,
    fromBlock: BLOCK - 7_100n,
    toBlock: BLOCK - 101n,
    blockHash: BLOCK_HASH,
    panelJobId: hash("e1"),
    panelSize: 7,
    quorum: 5,
    agreed: 5,
    issuedAt: REQUESTED_AT + 60n,
    expiresAt: REQUESTED_AT + 60n + 86_400n,
    ...over,
  };
}

export function signed(
  over: Partial<Extract<AnswerView, { kind: "signed" }>> = {},
  messageOver: Partial<OracleAttestationMessage> = {},
): Extract<AnswerView, { kind: "signed" }> {
  return {
    kind: "signed",
    oracleRequestId: ORACLE_REQUEST,
    message: message(messageOver),
    signature: `0x${"ab".repeat(65)}`,
    signedFor: { chainId: 1, verifyingContract: QUESTIONS },
    recoveredSigner: ORACLE_SIGNER,
    ...over,
  };
}

export function seen(over: Partial<Extract<ServiceView, { kind: "seen" }>> = {}): ServiceView {
  return {
    kind: "seen",
    state: "admitted",
    reason: null,
    oracleRequestId: ORACLE_REQUEST,
    completionStatus: null,
    delivered: null,
    failure: null,
    answer: { kind: "none", detail: "not asked for" },
    ...over,
  };
}

/** The service shows the request decided, with an answer queued for the writer. */
export const completing = (answer: AnswerView = { kind: "none", detail: "not asked for" }): ServiceView =>
  seen({ state: "completing", completionStatus: 0, answer });

/** A pending round, ten minutes old, that nothing can be done about yet. */
export function round(over: Partial<PendingRound> = {}): PendingRound {
  return {
    round: 3n,
    requestedAt: REQUESTED_AT,
    validFor: 86_400n,
    intakeRequestId: INTAKE_ID,
    questionHash: QUESTION_HASH,
    blockHash: BLOCK_HASH,
    fromBlock: BLOCK - 7_100n,
    toBlock: BLOCK - 101n,
    intakeCompleted: false,
    canSubmit: false,
    abandonStep: 0,
    closableAt: REQUESTED_AT + SILENCE,
    requestTx: REQUEST_TX,
    service: seen(),
    ...over,
  };
}

/** A daily feed with a full meter that was asked ten minutes ago and answered: nothing is due. */
export function feed(over: Partial<FeedView> = {}): FeedView {
  return {
    name: "hires",
    feedId: FEED_ID,
    exists: true,
    submitAllowed: true,
    rules: { chainId: 1n, answerType: 3, panelSize: 7, quorum: 5, minAgreed: 5 },
    rounds: 3n,
    latestRound: 3n,
    failStreak: 0,
    nextRequestBlock: BLOCK + 6_950n,
    meterBalance: IMD(7.7),
    cost: IMD(0.55),
    // Blocker 4: too soon.
    canRequest: { ok: false, why: 4, price: 0n, fromBlock: 0n, toBlock: 0n },
    lastRequestedAt: REQUESTED_AT,
    pending: null,
    payrollTopUp: 0n,
    ...over,
  };
}

/** The same feed, due: `canRequest` says yes. */
export const dueFeed = (over: Partial<FeedView> = {}): FeedView =>
  feed({
    nextRequestBlock: BLOCK - 10n,
    lastRequestedAt: NOW - 84_000n,
    canRequest: { ok: true, why: 0, price: IMD(0.5), fromBlock: BLOCK - 7_011n, toBlock: BLOCK - 12n },
    ...over,
  });

/** The same feed with a round pending. */
export const pendingFeed = (roundOver: Partial<PendingRound> = {}, over: Partial<FeedView> = {}): FeedView =>
  feed({
    latestRound: 2n,
    // Blocker 3: round pending.
    canRequest: { ok: false, why: 3, price: 0n, fromBlock: 0n, toBlock: 0n },
    pending: round(roundOver),
    ...over,
  });

export function questions(over: Partial<QuestionsSnapshot> = {}): QuestionsSnapshot {
  return {
    now: NOW,
    block: BLOCK,
    chainId: 1,
    questions: QUESTIONS,
    oracleSigner: ORACLE_SIGNER,
    payroll: PAYROLL,
    keeper: KEEPER,
    constants: {
      submitAfterSilence: 1_800n,
      abandonAfterSilence: 43_200n,
      abandonAfterCompleted: 1_800n,
      issuedAtTolerance: 300n,
    },
    feeds: [feed()],
    tips: { earned: 0n, pending: 0n },
    ...over,
  };
}

/** A snapshot whose one feed has a round pending, `age` seconds after its request. */
export function pendingAt(
  age: bigint,
  roundOver: Partial<PendingRound> = {},
  feedOver: Partial<FeedView> = {},
): QuestionsSnapshot {
  return questions({ now: REQUESTED_AT + age, feeds: [pendingFeed(roundOver, feedOver)] });
}

export function jobsReport(over: Partial<JobsReportSnapshot> = {}): JobsReportSnapshot {
  return {
    jobsReport: JOBS_REPORT,
    summary: {
      prints: 3n,
      counts: 3n,
      payrollsRead: 3n,
      hiresRead: 3n,
      pairedPrints: 3n,
      pairedCounts: 3n,
      crowns: 0n,
      latestCrownedRound: 0n,
      total: IMD(342),
      totalCount: 684n,
      streak: 3n,
    },
    payrolls: { rounds: 3n, latestRound: 3n },
    hires: { rounds: 3n, latestRound: 3n },
    crownCandidates: [],
    ...over,
  };
}

export const payrollPolicy = (over: Partial<PayrollPolicy> = {}): PayrollPolicy => ({
  bookMin: IMD(1),
  dripEverySeconds: 3_600,
  fundFeedsMin: IMD(1.1),
  ...over,
});

const FORTNIGHT = 1_209_600n;

/** Payroll with nothing waiting: no plain transfers, nothing due to stakers, meters at their runways. */
export function payroll(over: Partial<PayrollSnapshot> = {}): PayrollSnapshot {
  return {
    now: NOW,
    payroll: PAYROLL,
    unbooked: 0n,
    stream: { outstanding: 0n, unvested: 0n, endsAt: 0n, perDrip: 0n, nextDripAt: 600n, dueNow: 0n },
    lastDripAt: 0n,
    feedPeriod: NOW / FORTNIGHT,
    feedBudgetPeriod: FORTNIGHT,
    feedBudget: { total: 0n, old: 0n, releasableNow: 0n, nextReleaseAt: (NOW / FORTNIGHT + 1n) * FORTNIGHT },
    shortfalls: [0n, 0n, 0n],
    ...over,
  };
}
