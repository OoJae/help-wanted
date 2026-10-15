/**
 * The pages of launch A (questions, Jobs Report, company, seats) switched on against a mocked chain,
 * the way a launch switches them on: a book with launch A written in (`BOOKS.aOnly`), and the pages
 * read the contracts with the ABIs the shared package generates from the launch projects' build
 * output. Every answer the fake chain gives is encoded with those same ABIs, so a view this site
 * decodes wrongly fails here. Two states of launch A are played: the day of the launch (three feeds,
 * one pending round each, nothing answered, nothing printed, nothing booked) and a day later.
 *
 * Also here: what launches B and C add to a page that the first-wave tests did not cover (a pot's
 * kind in text, the lists of rules and endowments), and the keeper's status file.
 */
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  type Abi,
  type AbiEvent,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  crowdPotsAbi,
  endowmentsAbi,
  erc20Abi,
  feedBodyHex,
  HOUSE_FEEDS,
  intakeAbi,
  jobsReportAbi,
  kindHash,
  MAINNET,
  payrollAbi,
  questionsAbi,
  REQUEST_BLOCKER,
  ROUND_STATUS,
  rulesAbi,
  specHash,
  type DeploymentBook,
  type HouseFeedName,
} from "@help-wanted/shared";
import { HOUSE_X402 } from "~/config/history";
import { HOUSE_WALLETS } from "~/config/house";
import { LAUNCH_A_JOB } from "~/data";
import { keeperSource, parseKeeperStatus } from "~/data/keeper";
import { handleApi } from "~/lib/api";
import { formatUtcLongDay } from "~/lib/format";
import type { RawLog } from "~/lib/jsonrpc";
import { llmsTxt } from "~/lib/siteDocs";
import { loadPath, markdownTwin } from "~/lib/twins";
import type { JobsReportModel } from "~/models/jobsReport";
import type { JudgesModel } from "~/models/judges";
import type { CompanyModel, EndowmentsModel, PotModel, RulesNewModel, SeatsModel } from "~/models/money";
import type { QuestionsModel } from "~/models/questions";
import {
  BOOKS,
  ctxFor,
  fakeApi,
  fixtureJson,
  TEST_ADDRESSES,
  TEST_LAUNCH,
  testSources,
  TRANSFERS,
  type FakeChainOptions,
} from "./helpers";

const IMD = 10n ** 18n;
// The addresses the launch-A-only book gives launch A's three contracts.
const { questions: Q, jobsReport: J, payroll: P } = TEST_ADDRESSES.a;
const KEEPER = HOUSE_WALLETS[1]!.address.toLowerCase();
const OTHER_KEEPER = "0x4444444444444444444444444444444444444444";
const SUBMITTER = "0x3333333333333333333333333333333333333333";
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const HEAD = TRANSFERS.toBlock;
const T0 = 1_791_660_000;

type Views = NonNullable<FakeChainOptions["views"]>;

/** A log of one of our contracts, encoded from the generated ABI. */
function eventLog(
  abi: Abi,
  address: string,
  eventName: string,
  args: Record<string, unknown>,
  at: { block: number; index?: number },
): RawLog {
  const event = abi.find((item): item is AbiEvent => item.type === "event" && item.name === eventName);
  if (!event) throw new Error(`no event ${eventName}`);
  const indexed = Object.fromEntries(
    event.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name ?? ""]]),
  );
  const rest = event.inputs.filter((i) => !i.indexed);
  return {
    address,
    topics: encodeEventTopics({ abi: [event], eventName, args: indexed } as never) as string[],
    data: encodeAbiParameters(
      rest,
      rest.map((i) => args[i.name ?? ""]),
    ),
    blockNumber: `0x${at.block.toString(16)}`,
    transactionHash: keccak256(`0x${(at.block * 100 + (at.index ?? 0)).toString(16).padStart(64, "0")}`),
    logIndex: `0x${(at.index ?? 0).toString(16)}`,
  };
}

/** A request id as an attestation carries it: the UUID's sixteen bytes, left-aligned in 32. */
const oracleId = (uuid: string) => `0x${uuid.replace(/-/g, "")}${"0".repeat(32)}` as Hex;

const PAYROLLS = HOUSE_FEEDS.payrolls.id;
const HIRES = HOUSE_FEEDS.hires.id;
const EMPLOYERS = HOUSE_FEEDS.employers.id;
const nameOfId = (id: unknown): HouseFeedName | null =>
  id === PAYROLLS ? "payrolls" : id === HIRES ? "hires" : id === EMPLOYERS ? "employers" : null;

/**
 * A day after launch A, as the chain could have it. Payrolls has had four rounds: one answered by
 * `submit`, one failed, one answered by the Intake's callback, one still pending. Hires has had
 * one, answered by the callback. Nobody has created the employers feed in this world.
 */
const ROUNDS: Record<
  string,
  Record<number, { status: number; value: bigint; from: number; to: number; at: number }>
> = {
  [PAYROLLS]: {
    1: { status: ROUND_STATUS.Answered, value: 114n * IMD, from: HEAD - 21_700, to: HEAD - 14_501, at: T0 },
    2: { status: ROUND_STATUS.Failed, value: 0n, from: HEAD - 14_500, to: HEAD - 7_301, at: T0 + 50_000 },
    3: {
      status: ROUND_STATUS.Answered,
      value: 121n * IMD,
      from: HEAD - 14_500,
      to: HEAD - 301,
      at: T0 + 90_000,
    },
    4: { status: ROUND_STATUS.Pending, value: 0n, from: HEAD - 300, to: HEAD - 50, at: 0 },
  },
  [HIRES]: {
    // The same blocks as the newer print below: the count's own window, which this server holds.
    1: {
      status: ROUND_STATUS.Answered,
      value: 99n,
      from: TRANSFERS.fromBlock,
      to: TRANSFERS.toBlock,
      at: T0 + 90_100,
    },
  },
};

function feedState(id: unknown) {
  const base = {
    exists: true,
    lastToBlock: BigInt(HEAD - 301),
    failStreak: 0,
    pendingRequestId: ZERO32,
    totalShares: 5_500_000_000_000_000_000n,
    cost: 550_000_000_000_000_000n,
  };
  if (id === PAYROLLS) {
    return {
      ...base,
      rounds: 4n,
      latestRound: 3n,
      lastRequestBlock: BigInt(HEAD - 40),
      pending: true,
      pendingRequestId: `0x${"77".repeat(32)}`,
      nextRequestBlock: BigInt(HEAD + 7_160),
      meterBalance: 5_500_000_000_000_000_000n,
      blocker: REQUEST_BLOCKER.RoundPending,
    };
  }
  if (id === HIRES) {
    return {
      ...base,
      rounds: 1n,
      latestRound: 1n,
      lastRequestBlock: BigInt(HEAD - 290),
      pending: false,
      nextRequestBlock: BigInt(HEAD + 6_910),
      meterBalance: 1_100_000_000_000_000_000n,
      totalShares: 1_100_000_000_000_000_000n,
      blocker: REQUEST_BLOCKER.TooSoon,
    };
  }
  return {
    ...base,
    exists: false,
    rounds: 0n,
    latestRound: 0n,
    lastRequestBlock: 0n,
    lastToBlock: 0n,
    pending: false,
    nextRequestBlock: 0n,
    meterBalance: 0n,
    totalShares: 0n,
    cost: 0n,
    blocker: REQUEST_BLOCKER.UnknownFeed,
  };
}

const QUESTIONS_VIEWS: Views = {
  [`${Q}:feedCount`]: { abi: questionsAbi, result: 2n },
  [`${Q}:INTAKE`]: { abi: questionsAbi, result: MAINNET.INTAKE },
  [`${Q}:IMD`]: { abi: questionsAbi, result: MAINNET.IMD },
  [`${Q}:feedAt`]: {
    abi: questionsAbi,
    result: ([index]: readonly unknown[]) => [PAYROLLS, HIRES][Number(index)],
  },
  [`${Q}:feedState`]: { abi: questionsAbi, result: ([id]: readonly unknown[]) => feedState(id) },
  [`${Q}:latest`]: {
    abi: questionsAbi,
    result: ([id]: readonly unknown[]) => {
      const rounds = ROUNDS[id as string];
      const round = id === PAYROLLS ? 3 : id === HIRES ? 1 : 0;
      const r = rounds?.[round];
      return r ? [r.value, BigInt(r.from), BigInt(r.to), BigInt(round), BigInt(r.at)] : [0n, 0n, 0n, 0n, 0n];
    },
  },
  [`${Q}:feedParams`]: {
    abi: questionsAbi,
    result: ([id]: readonly unknown[]) => {
      const name = nameOfId(id);
      return name ? HOUSE_FEEDS[name].params : undefined;
    },
  },
  [`${Q}:feedText`]: {
    abi: questionsAbi,
    result: ([id]: readonly unknown[]) => {
      const name = nameOfId(id);
      return name ? [HOUSE_FEEDS[name].qPrefix, HOUSE_FEEDS[name].tail] : undefined;
    },
  },
  [`${Q}:canSubmit`]: { abi: questionsAbi, result: ([id]: readonly unknown[]) => id === PAYROLLS },
  [`${Q}:canAbandon`]: {
    abi: questionsAbi,
    result: ([id]: readonly unknown[]) => (id === PAYROLLS ? [0, BigInt(T0 + 140_000)] : [0, 0n]),
  },
  [`${Q}:redeemable`]: {
    abi: questionsAbi,
    result: ([id]: readonly unknown[]) => (id === PAYROLLS ? 3n * IMD : id === HIRES ? IMD : 0n),
  },
  [`${Q}:roundOf`]: {
    abi: questionsAbi,
    result: ([id, round]: readonly unknown[]) => {
      const r = ROUNDS[id as string]?.[Number(round)];
      return r ? [r.status, r.value, BigInt(r.from), BigInt(r.to), BigInt(r.at)] : [0, 0n, 0n, 0n, 0n];
    },
  },
  [`${Q}:roundRequest`]: {
    abi: questionsAbi,
    result: ([id, round]: readonly unknown[]) => [
      `0x${"7".repeat(63)}${Number(round)}`,
      `0x${"8".repeat(64)}`,
      `0x${"9".repeat(64)}`,
      BigInt(T0 - 3_000 + Number(round) * 40_000 + (id === HIRES ? 100 : 0)),
    ],
  },
  [`${Q}:tipsOf`]: {
    abi: questionsAbi,
    result: ([keeper]: readonly unknown[]) =>
      String(keeper).toLowerCase() === KEEPER
        ? [100_000_000_000_000_000n, 0n]
        : [0n, 50_000_000_000_000_000n],
  },
};

const opened = (feedId: Hex, round: number, keeper: string, block: number) =>
  eventLog(
    questionsAbi,
    Q,
    "RoundOpened",
    {
      feedId,
      round: BigInt(round),
      intakeRequestId: `0x${"7".repeat(63)}${round}`,
      fromBlock: 1n,
      toBlock: 2n,
      questionHash: `0x${"8".repeat(64)}`,
      blockHash: `0x${"9".repeat(64)}`,
      price: IMD / 2n,
      tip: IMD / 20n,
      keeper,
    },
    { block, index: 0 },
  );
const answered = (feedId: Hex, round: number, deliveredBy: string, uuid: string, block: number) =>
  eventLog(
    questionsAbi,
    Q,
    "RoundAnswered",
    {
      feedId,
      round: BigInt(round),
      oracleRequestId: oracleId(uuid),
      value: 1n,
      figure: 1n,
      agreed: 5,
      panelJobId: ZERO32,
      deliveredBy,
    },
    { block, index: 1 },
  );

const ROUND_LOGS: RawLog[] = [
  opened(PAYROLLS, 1, KEEPER, HEAD - 6_000),
  // Round 1's answer was handed in with submit, by somebody who is not the keeper that asked.
  answered(PAYROLLS, 1, SUBMITTER, "3744d864-8cbf-4fcf-8a8c-3529fb1736cb", HEAD - 5_800),
  opened(PAYROLLS, 2, KEEPER, HEAD - 4_000),
  eventLog(
    questionsAbi,
    Q,
    "RoundFailed",
    { feedId: PAYROLLS, round: 2n, intakeRequestId: `0x${"7".repeat(63)}2`, completed: true, failStreak: 1 },
    { block: HEAD - 3_500, index: 2 },
  ),
  opened(PAYROLLS, 3, KEEPER, HEAD - 2_000),
  // Round 3's answer came by the Intake's own callback: the tip is the keeper's that opened it.
  answered(PAYROLLS, 3, MAINNET.INTAKE, "11111111-2222-4333-8444-555555555555", HEAD - 1_900),
  opened(PAYROLLS, 4, OTHER_KEEPER, HEAD - 40),
  opened(HIRES, 1, KEEPER, HEAD - 290),
  answered(HIRES, 1, MAINNET.INTAKE, "df50bf76-41a0-4596-ae9e-9dcfd0e1ccd5", HEAD - 200),
];

const LEDGER = {
  received: 100n * IMD,
  toStakers: 50n * IMD,
  toSeats: 30n * IMD,
  toFeeds: 20n * IMD,
  dripped: 5n * IMD,
  seatClaimed: IMD,
  tipsIn: 4n * IMD,
  tipsClaimed: IMD,
  feedsFunded: 4n * IMD,
  tipsToSeats: IMD / 2n,
  feedsReleased: 0n,
};

const PAYROLL_VIEWS: Views = {
  [`${P}:IMD`]: { abi: payrollAbi, result: MAINNET.IMD },
  [`${P}:ledger`]: { abi: payrollAbi, result: LEDGER },
  [`${P}:stream`]: {
    abi: payrollAbi,
    result: [45n * IMD, 40n * IMD, BigInt(T0 + 600_000), IMD / 4n, BigInt(T0 + 600), IMD / 2n],
  },
  [`${P}:owed`]: {
    abi: payrollAbi,
    result: [45n * IMD, 29_500_000_000_000_000_000n, 3n * IMD, 16n * IMD, 93_500_000_000_000_000_000n],
  },
  [`${P}:feedBudget`]: { abi: payrollAbi, result: [16n * IMD, 6n * IMD, 0n, BigInt(T0 + 1_200_000)] },
  [`${P}:feedShortfalls`]: {
    abi: payrollAbi,
    result: [4_700_000_000_000_000_000n, 6_700_000_000_000_000_000n, 0n],
  },
  [`${P}:unbooked`]: { abi: payrollAbi, result: 250_000_000_000_000_000n },
  [`${P}:SEAT_BPS`]: { abi: payrollAbi, result: 3_000n },
  [`${P}:FEED_BPS`]: { abi: payrollAbi, result: 2_000n },
  [`${P}:STREAM_DURATION`]: { abi: payrollAbi, result: 604_800n },
  [`${P}:seatClaimable`]: { abi: payrollAbi, result: 15_000_000_000_000_000n },
  [`${P}:seatPaid`]: { abi: payrollAbi, result: 500_000_000_000_000n },
  [`${P}:tipOwed`]: { abi: payrollAbi, result: IMD / 10n },
};

/** Two prints: the newer covers exactly the recorded day of transfers, so this site can count it again. */
const PRINTS = [
  {
    amount: 121n * IMD,
    count: 99n,
    fromBlock: BigInt(TRANSFERS.fromBlock),
    toBlock: BigInt(TRANSFERS.toBlock),
    payrollsRound: 3n,
    hiresRound: 1n,
  },
  {
    amount: 114n * IMD,
    count: 0n,
    fromBlock: BigInt(TRANSFERS.fromBlock - 7_200),
    toBlock: BigInt(TRANSFERS.fromBlock - 1),
    payrollsRound: 1n,
    hiresRound: 0n,
  },
];

const REPORT_VIEWS: Views = {
  [`${J}:QUESTIONS`]: { abi: jobsReportAbi, result: Q },
  [`${J}:latestPrints`]: { abi: jobsReportAbi, result: PRINTS },
  [`${J}:summary`]: {
    abi: jobsReportAbi,
    result: {
      prints: 2n,
      total: 235n * IMD,
      counts: 1n,
      totalCount: 99n,
      bestAmount: 121n * IMD,
      bestIndex: 1n,
      streak: 2n,
      longestStreak: 2n,
      payrollsRead: 3n,
      hiresRead: 1n,
      pairedPrints: 1n,
      pairedCounts: 1n,
      crowns: 0n,
      latestCrownedRound: 0n,
    },
  },
  [`${J}:latestCrown`]: {
    abi: jobsReportAbi,
    result: [
      false,
      0n,
      { first: ZERO, fromBlock: 0n, second: ZERO, toBlock: 0n, third: ZERO, crownedAt: 0n, places: 0 },
    ],
  },
};

/** Launch A a day in: the book holds launch A and nothing else, and the chain answers for it. */
function launchedA(chain: FakeChainOptions = {}) {
  return testSources({
    book: BOOKS.aOnly,
    chain: {
      views: { ...QUESTIONS_VIEWS, ...PAYROLL_VIEWS, ...REPORT_VIEWS },
      logs: { [Q]: ROUND_LOGS },
      contracts: [Q, J, P],
      ...chain,
    },
  });
}

describe("launch A switched on: the questions page", () => {
  it("shows each house feed's meter, cadence and what stands in the way of the next request", async () => {
    const loaded = await loadPath("/questions", ctxFor(launchedA(), "/questions"));
    const model = loaded!.model as QuestionsModel;
    expect(model.launched).toBe(true);
    expect(model.questions.address?.toLowerCase()).toBe(Q);
    expect(model.feedCount).toBe(2);
    expect(model.feedsError).toBeNull();
    const [payrolls, hires, employers] = model.houseFeeds;

    expect(payrolls?.live).toMatchObject({
      exists: true,
      meterImd: "5.5",
      costImd: "0.55",
      requestsFunded: 10,
      payrollPositionImd: "3",
      rounds: 4,
      pending: true,
      canSubmit: true,
    });
    expect(payrolls?.live?.next).toContain(
      "A round is pending: no new request can be made until it is answered",
    );
    expect(payrolls?.live?.latest).toContain("121 IMD for blocks");
    expect(payrolls?.live?.latest).toContain("round 3");

    expect(hires?.live).toMatchObject({
      exists: true,
      meterImd: "1.1",
      requestsFunded: 2,
      rounds: 1,
      pending: false,
    });
    expect(hires?.live?.latest).toContain("99 transfers for blocks");
    expect(hires?.live?.next).toMatch(/^Due at block [\d,]+, in about [^.]+\.$/);
    expect(hires?.live?.next).not.toContain("holds less than one request costs");

    // A house feed nobody has created yet is shown as exactly that: defined, and not on chain.
    expect(employers?.live).toMatchObject({ exists: false, rounds: 0, meterImd: null, roundRows: [] });
    expect(employers?.live?.next).toContain("The feed has not been created yet");
  });

  it("lists every round with its window, state, answer and who earned the tip", async () => {
    const loaded = await loadPath("/questions", ctxFor(launchedA(), "/questions"));
    const model = loaded!.model as QuestionsModel;
    const rows = model.houseFeeds[0]!.live!.roundRows;
    expect(rows.map((r) => r.round)).toEqual([4, 3, 2, 1]);

    const [pending, byCallback, failed, bySubmit] = rows;
    expect(pending).toMatchObject({ status: "pending: waiting for its answer", tipEarner: null });
    // A pending round's tip is set aside for the keeper that opened it, and for nobody else.
    expect(pending?.tip).toBe(
      `0.05 IMD is set aside for ${OTHER_KEEPER}, the keeper that opened the round. It is credited if the round is answered, whoever delivers the answer, and goes back onto the meter if the round is closed without one.`,
    );
    expect(pending?.window).toBe(
      `blocks ${(HEAD - 300).toLocaleString("en-US")} to ${(HEAD - 50).toLocaleString("en-US")}`,
    );

    // The Intake's callback delivered round 3: the tip is the keeper's that opened the round.
    expect(byCallback).toMatchObject({ status: "answered", answer: "121 IMD", tipEarner: KEEPER });
    // The keeper is house wallet H1: the sentence says so, as every count of ours does.
    expect(byCallback?.tip).toBe(
      `0.05 IMD earned by ${KEEPER} (HOUSE: one of ours), the keeper that opened the round (the Intake's callback delivered the answer).`,
    );
    expect(byCallback?.delivered).toBe("the Intake's callback");
    expect(byCallback?.oracleRequestUrl).toBe(
      "https://api.imd.fun/oracle/requests/11111111-2222-4333-8444-555555555555",
    );

    // A failed round earns nobody anything: its tip went back onto the meter.
    expect(failed).toMatchObject({ status: "failed: no usable answer arrived", tipEarner: null });
    expect(failed?.tip).toBe("0.05 IMD went back onto the meter: the round failed.");

    // Round 1 was handed in with submit by somebody else. As launched, the tip still goes to the
    // keeper that opened the round: handing an answer in earns nothing.
    expect(bySubmit).toMatchObject({ status: "answered", answer: "114 IMD", tipEarner: KEEPER });
    expect(bySubmit?.tip).toBe(
      `0.05 IMD earned by ${KEEPER} (HOUSE: one of ours), the keeper that opened the round (the answer was handed in with submit by ${SUBMITTER}, which earns nothing).`,
    );
    expect(bySubmit?.delivered).toBe(`submit, by ${SUBMITTER}`);
    expect(pending?.delivered).toBeNull();
    expect(bySubmit?.tipEarner).not.toBe(SUBMITTER);
    expect(bySubmit?.oracleRequestUrl).toBe(
      "https://api.imd.fun/oracle/requests/3744d864-8cbf-4fcf-8a8c-3529fb1736cb",
    );

    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain("| Round | Window | State | Answer | Requested | Delivered by | Tip |");
    expect(markdown).toContain("which earns nothing");
    expect(markdown).not.toContain("who handed the answer in with submit");
    expect(markdown).toContain(`Questions is at [${model.questions.label}]`);
    expect(markdown).not.toContain("The Questions contract is not launched yet");
    // Every command now names the real address, not a placeholder.
    expect(markdown).not.toContain("$QUESTIONS");
    expect(markdown).toContain(`cast send ${model.questions.address} "collectTips()"`);
    // The rule itself, as the launched contract has it.
    expect(model.tipRule.join(" ")).toContain("always by that keeper");
    expect(model.tipRule.join(" ")).toContain("Handing an answer in earns nothing of its own.");
    expect(model.waits.join(" ")).toContain("that is 36 hours, 5 minutes and 1 second after the request");
    expect(model.waits.join(" ")).toContain("in one call");
    expect(model.waits.join(" ")).toContain("in two calls");
    // The hire desk and the company are not live, and the page says so in so many words.
    expect(model.notLive).toHaveLength(2);
    expect(markdown).toContain("## What is not live");
    expect(markdown).toContain(
      "The hire desk (launch B: WorkProof, WorkOrders, CrowdPots, Doorbell) is not launched yet.",
    );
    expect(markdown).toContain("The company (launch C: Rules, Endowments, Zap) is not launched yet.");
  });

  it("says a round's tip earner is not shown when its events are older than the RPC serves", async () => {
    // The same contract state, with no log in reach.
    const world = launchedA({ logs: {} });
    const model = (await loadPath("/questions", ctxFor(world, "/questions")))!.model as QuestionsModel;
    const rows = model.houseFeeds[0]!.live!.roundRows;
    const answered = rows.find((r) => r.round === 3);
    // Window, state and answer come from the contract itself and are still there.
    expect(answered).toMatchObject({ status: "answered", answer: "121 IMD", tipEarner: null });
    expect(answered?.tip).toBe(
      "Earned by the keeper that opened the round; which keeper is not shown, because the round's opening log is older than this server can read.",
    );
    expect(model.eventsCoverage).toContain("the range this server's RPC serves");
  });

  it("reads a keeper's tips, and the JSON API serves the same feeds", async () => {
    const world = launchedA();
    const tips = await world.sources.house.keeperTips(KEEPER);
    expect(tips.live && tips.data).toEqual({ keeper: KEEPER, earnedWei: IMD / 10n, pendingWei: 0n });
    const response = await handleApi("feeds", new Request("https://help-wanted.test/x"), ctxFor(world));
    const body = (await response.json()) as {
      launched: boolean;
      feedCount: number;
      houseFeeds: { name: string; live: { rounds: number } | null }[];
      note: string | null;
    };
    expect(body).toMatchObject({ launched: true, feedCount: 2, note: null });
    expect(body.houseFeeds.map((f) => [f.name, f.live?.rounds])).toEqual([
      ["payrolls", 4],
      ["hires", 1],
      ["employers", 0],
    ]);
  });

  it("says Questions could not be read, and keeps the definitions, when the address does not answer", async () => {
    const world = testSources({ book: BOOKS.aOnly });
    const loaded = await loadPath("/questions", ctxFor(world, "/questions"));
    const model = loaded!.model as QuestionsModel;
    expect(model.launched).toBe(true);
    // Nothing answered at that address: no feed is reported, and none is invented. Nor is it said
    // that no feed exists, or that none has been created: the contract was not read.
    expect(model.feedCount).toBeNull();
    expect(model.feedsError).toContain("Questions.feedCount() did not answer");
    expect(model.houseFeeds.every((f) => f.live?.exists === false && f.live.read === false)).toBe(true);
    expect(model.houseFeeds[0]?.live?.next).toContain("Questions could not be read just now");
    expect(model.houseFeeds[0]?.proof.bodyMatches).toBe(true);
    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain("Questions could not be read just now: Questions.feedCount() did not answer");
    expect(markdown).not.toContain("feeds have been created in it");
    expect(markdown).not.toContain("The feed has not been created yet");
    expect(markdown).not.toContain("The Questions contract is not launched yet");
  });
});

describe("launch A switched on: the Jobs Report", () => {
  it("is the official release once a print exists, with the unofficial tally kept beside it", async () => {
    const loaded = await loadPath("/jobs-report", ctxFor(launchedA(), "/jobs-report"));
    const model = loaded!.model as JobsReportModel;
    expect(loaded!.meta.title).toBe("The Robot Jobs Report");
    expect(model.official).toMatchObject({ launched: true, printed: true, error: null });
    // A release is dated by its print: here, by when the payrolls round it copies was answered
    // (no print transaction is kept for a test book's JobsReport).
    expect(model.releaseNumber).toBe("HW-RJR-2026-10-11-O");
    expect(model.schedule?.lastPrintWords).toContain(
      "The last print, no. 2, copies the payrolls round answered on",
    );
    expect(model.releaseDay).toBe(formatUtcLongDay(model.schedule?.lastPrintAt ?? ""));
    expect(model.headline).toBe(
      `Official print no. 2: 121 IMD was paid to the swarm in blocks ${TRANSFERS.fromBlock.toLocaleString("en-US")} to ${TRANSFERS.toBlock.toLocaleString("en-US")}, in 99 payments, as answered by IdentityMD's oracle and stored on chain.`,
    );
    expect(model.official.summary).toMatchObject({
      prints: 2,
      totalWei: 235n * IMD,
      counts: 1,
      totalCount: 99n,
      streak: 2,
    });
    expect(model.official.prints.map((p) => p.index)).toEqual([1, 0]);

    // The newer print covers exactly the day of logs this server holds: counted the same way
    // (every IMD Transfer log to the fee payee, zero-value included), the two agree.
    const [newer, older] = model.official.prints;
    expect(newer).toMatchObject({ counted: true, amountWei: 121n * IMD, count: 99 });
    expect(newer?.check).toEqual({
      totalWei: 121n * IMD,
      payments: 99,
      amountAgrees: true,
      countOverItsWindow: 99,
      countAgrees: true,
    });
    expect(newer).toMatchObject({
      differs: false,
      countWindow: { fromBlock: TRANSFERS.fromBlock, toBlock: TRANSFERS.toBlock },
    });
    // The older one is outside what the server holds, and no count is attached to it yet.
    expect(older).toMatchObject({ counted: false, check: null, countWindow: null, differs: false });

    // The unofficial tally is still there, beside it.
    expect(model.tally?.totalWei).toBe(121n * IMD);
    expect(model.tally?.payments).toBe(99);

    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain("**OFFICIAL RELEASE.**");
    expect(markdown).toContain("## The official release");
    expect(markdown).toContain("## The unofficial tally, beside it");
    expect(markdown).toContain(
      `121 IMD over the print's blocks: agrees; 99 payments over the count's own blocks (${TRANSFERS.fromBlock.toLocaleString("en-US")} to ${TRANSFERS.toBlock.toLocaleString("en-US")}): agrees`,
    );
    expect(markdown).toContain("no count attached yet");
    expect(markdown).toContain(
      "not held by this server: some of these blocks are older than the range it reads",
    );
    expect(markdown).toContain("Employers of the week: no round has been crowned.");
    expect(markdown).toContain("settled by panel agreement".slice(0, 0) + "a feed a panel judges");
    expect(markdown).not.toContain("**UNOFFICIAL TALLY.**");
    expect(markdown).toContain(`cast call ${model.official.contract.address} "latestPrint()`);
  });

  it("says so when a print and this site's count of the same blocks differ", async () => {
    const world = launchedA({
      views: {
        ...QUESTIONS_VIEWS,
        ...PAYROLL_VIEWS,
        ...REPORT_VIEWS,
        [`${J}:latestPrints`]: {
          abi: jobsReportAbi,
          result: [{ ...PRINTS[0]!, amount: 120n * IMD, count: 98n }],
        },
      },
    });
    const loaded = await loadPath("/jobs-report", ctxFor(world, "/jobs-report"));
    const model = loaded!.model as JobsReportModel;
    expect(model.official.prints[0]?.check).toMatchObject({ amountAgrees: false, countAgrees: false });
    expect(model.official.prints[0]?.differs).toBe(true);
    expect(markdownTwin(loaded!)).toContain("DIFFERS");
  });

  it("recounts a count over the count's own window, which can be a few blocks off the print's", async () => {
    // As on mainnet on the day of the launch: the two daily feeds were requested two blocks apart,
    // so the count covers a window shifted against the print's. Here the count's window reaches one
    // block further than the print's, and that block holds a payment.
    const last = Number(BigInt(TRANSFERS.logs.at(-1)!.blockNumber));
    const inLast = TRANSFERS.logs.filter((log) => Number(BigInt(log.blockNumber)) === last).length;
    expect(inLast).toBeGreaterThan(0);
    const printWindow = { fromBlock: TRANSFERS.fromBlock, toBlock: last - 1 };
    const countWindow = { fromBlock: TRANSFERS.fromBlock, toBlock: last };
    const sumOver = (window: { fromBlock: number; toBlock: number }) => {
      const logs = TRANSFERS.logs.filter((log) => {
        const block = Number(BigInt(log.blockNumber));
        return block >= window.fromBlock && block <= window.toBlock;
      });
      return { count: logs.length, wei: logs.reduce((sum, log) => sum + BigInt(log.data), 0n) };
    };
    const world = launchedA({
      views: {
        ...QUESTIONS_VIEWS,
        ...PAYROLL_VIEWS,
        ...REPORT_VIEWS,
        [`${Q}:roundOf`]: {
          abi: questionsAbi,
          result: ([id, round]: readonly unknown[]) => {
            if (id === HIRES && round === 1n) {
              return [
                ROUND_STATUS.Answered,
                BigInt(sumOver(countWindow).count),
                BigInt(countWindow.fromBlock),
                BigInt(countWindow.toBlock),
                BigInt(T0),
              ];
            }
            const r = ROUNDS[id as string]?.[Number(round)];
            return r ? [r.status, r.value, BigInt(r.from), BigInt(r.to), BigInt(r.at)] : [0, 0n, 0n, 0n, 0n];
          },
        },
        [`${J}:latestPrints`]: {
          abi: jobsReportAbi,
          result: [
            {
              ...PRINTS[0]!,
              amount: sumOver(printWindow).wei,
              count: BigInt(sumOver(countWindow).count),
              fromBlock: BigInt(printWindow.fromBlock),
              toBlock: BigInt(printWindow.toBlock),
            },
          ],
        },
      },
    });
    const loaded = await loadPath("/jobs-report", ctxFor(world, "/jobs-report"));
    const [print] = (loaded!.model as JobsReportModel).official.prints;
    expect(print?.countWindow).toEqual(countWindow);
    // Over the print's own blocks this site counts fewer transfers than the attached count. That is
    // not a difference: the count is held against its own window, where the two agree.
    expect(print?.check?.payments).toBe(sumOver(printWindow).count);
    expect(print?.check?.payments).not.toBe(print?.count);
    expect(print?.check).toMatchObject({
      amountAgrees: true,
      countOverItsWindow: sumOver(countWindow).count,
      countAgrees: true,
    });
    expect(print?.differs).toBe(false);
    expect(markdownTwin(loaded!)).not.toContain("DIFFERS");
    expect(markdownTwin(loaded!)).toContain("payments over the count's own blocks");

    // The count is never printed as though it had been counted over the print's blocks: the
    // headline and the table name the blocks it covers, and each command recounts one figure over
    // that figure's own blocks.
    const model = loaded!.model as JobsReportModel;
    const blocks = (w: { fromBlock: number; toBlock: number }) =>
      `${w.fromBlock.toLocaleString("en-US")} to ${w.toBlock.toLocaleString("en-US")}`;
    const count = sumOver(countWindow).count.toLocaleString("en-US");
    expect(print?.countWords).toBe(`${count}, counted over blocks ${blocks(countWindow)}`);
    expect(model.headline).toContain(
      `in blocks ${blocks(printWindow)}, and ${count} payments were counted in blocks ${blocks(countWindow)}, as answered`,
    );
    expect(model.headline).not.toContain(`, in ${count} payments`);
    expect(markdownTwin(loaded!)).toContain(`| ${count}, counted over blocks ${blocks(countWindow)} |`);
    const commands = model.officialCommands.map((c) => c.command);
    expect(
      commands.filter(
        (c) =>
          c.includes(`--from-block ${printWindow.fromBlock} --to-block ${printWindow.toBlock} `) &&
          c.includes("sum(int(l,16)"),
      ),
    ).toHaveLength(1);
    expect(
      commands.filter(
        (c) =>
          c.includes(`--from-block ${countWindow.fromBlock} --to-block ${countWindow.toBlock} `) &&
          c.endsWith("| jq length"),
      ),
    ).toHaveLength(1);
    // No command counts transfers over the print's blocks: that number is not the attached count.
    expect(
      commands.some((c) => c.includes(`--to-block ${printWindow.toBlock} `) && c.endsWith("| jq length")),
    ).toBe(false);
  });

  it("does not compare a count whose own window it cannot read or does not hold", async () => {
    // The hires round behind the count is older than the rounds the site reads: no window, no verdict.
    const world = launchedA({
      views: {
        ...QUESTIONS_VIEWS,
        ...PAYROLL_VIEWS,
        ...REPORT_VIEWS,
        [`${J}:latestPrints`]: { abi: jobsReportAbi, result: [{ ...PRINTS[0]!, hiresRound: 7n }] },
      },
    });
    const loaded = await loadPath("/jobs-report", ctxFor(world, "/jobs-report"));
    const [print] = (loaded!.model as JobsReportModel).official.prints;
    expect(print).toMatchObject({ counted: true, countWindow: null, differs: false });
    expect(print?.check).toMatchObject({ amountAgrees: true, countOverItsWindow: null, countAgrees: null });
    expect(print?.checkWords).toBe(
      "121 IMD over the print's blocks: agrees; the count is not compared: the blocks it covers could not be read",
    );
    // Nor is the count said to be "in" the print's blocks, and no command guesses its window.
    expect(print?.countWords).toBe("99, over blocks that could not be read just now");
    const read = loaded!.model as JobsReportModel;
    expect(read.headline).toContain(", with a count of 99 payments attached, as answered");
    expect(read.headline).not.toContain(", in 99 payments");
    expect(read.officialCommands.at(-1)?.command).toContain(
      "--from-block <from-block> --to-block <to-block>",
    );
    // And with the payment logs unreadable, nothing at all is compared, and the page says why.
    const blind = launchedA({ failCalls: false, transferLogs: [], head: HEAD });
    const unread = { ...blind };
    blind.sources.chain.payments = async () => {
      throw new Error("eth_getLogs answered HTTP 403");
    };
    const failed = await loadPath("/jobs-report", ctxFor(unread, "/jobs-report"));
    const model = failed!.model as JobsReportModel;
    expect(model.tallyError).toBe("eth_getLogs answered HTTP 403");
    expect(model.official.prints[0]?.checkWords).toBe(
      "not compared: this server could not read the payment logs just now",
    );
  });

  it("names the week's employers as a panel's list once a round is crowned", async () => {
    const crowned = [
      true,
      2n,
      {
        first: "0x21919137e69ed667ac404c7fcb71b8179b645f46",
        fromBlock: BigInt(HEAD - 50_400),
        second: "0x9fadab91f6fa03dbd7f4f8a08a338704baacf63f",
        toBlock: BigInt(HEAD - 1),
        third: ZERO,
        crownedAt: BigInt(T0),
        places: 2,
      },
    ];
    const world = launchedA({
      views: {
        ...QUESTIONS_VIEWS,
        ...PAYROLL_VIEWS,
        ...REPORT_VIEWS,
        [`${J}:latestCrown`]: { abi: jobsReportAbi, result: crowned },
      },
    });
    const loaded = await loadPath("/jobs-report", ctxFor(world, "/jobs-report"));
    const model = loaded!.model as JobsReportModel;
    expect(model.official.crown).toMatchObject({
      round: 2,
      places: ["0x21919137e69ed667ac404c7fcb71b8179b645f46", "0x9fadab91f6fa03dbd7f4f8a08a338704baacf63f"],
    });
    expect(markdownTwin(loaded!)).toContain(
      "This list is settled by panel agreement; IdentityMD does not recompute it.",
    );
  });

  it("stays an unofficial tally while the contract is live and has not printed", async () => {
    const world = launchedA({
      views: {
        ...QUESTIONS_VIEWS,
        ...PAYROLL_VIEWS,
        ...REPORT_VIEWS,
        [`${J}:latestPrints`]: { abi: jobsReportAbi, result: [] },
      },
    });
    const loaded = await loadPath("/jobs-report", ctxFor(world, "/jobs-report"));
    const model = loaded!.model as JobsReportModel;
    expect(model.official).toMatchObject({ launched: true, printed: false });
    expect(loaded!.meta.title).toBe("The Robot Jobs Report (unofficial tally)");
    expect(model.releaseNumber.endsWith("-U")).toBe(true);
    expect(markdownTwin(loaded!)).toContain("is live at");
    expect(markdownTwin(loaded!)).toContain("has not printed yet");
  });
});

describe("launch A switched on: the company page and the seats", () => {
  it("prints Payroll's ledger: what came in, the split, the stream, the seat pool, tips and the feed budget", async () => {
    const loaded = await loadPath("/company", ctxFor(launchedA(), "/company"));
    const model = loaded!.model as CompanyModel;
    expect(model.launched).toBe(true);
    expect(model.error).toBeNull();
    expect(model.splitRead).toBe(
      "As read from the contract: SEAT_BPS is 3,000, FEED_BPS is 2,000 (of 10,000; stakers take the rest), and STREAM_DURATION is 7 d.",
    );
    const section = (title: string) =>
      Object.fromEntries(model.sections.find((s) => s.title === title)!.rows.map((r) => [r.label, r.imd]));
    expect(section("What came in")).toEqual({
      "Received and split, all time": "100",
      "Arrived but not yet split": "0.25",
      "Held now for everyone it is owed to": "93.5",
    });
    expect(section("The stream to stakers")).toEqual({
      "Booked for sIMD stakers": "50",
      "Sent to sIMD so far": "5",
      "Still to be sent": "45",
      "Due to sIMD right now": "0.5",
    });
    expect(section("The seat pool")).toEqual({
      "Booked for seat owners": "30",
      "Tips that fell to the seat pool": "0.5",
      "Claimed by seat owners": "1",
      "Unclaimed in the pool": "29.5",
    });
    expect(section("Tips")).toEqual({
      "Tips received for agents": "4",
      "Tips claimed": "1",
      "Tips waiting": "3",
    });
    expect(section("The feed budget")).toEqual({
      "Placed on feed meters so far": "4",
      "Released to the stakers' stream": "0",
      "Budget on hand": "16",
      "How far the payrolls meter is below Payroll's runway": "4.7",
      "How far the hires meter is below Payroll's runway": "6.7",
      "How far the employers meter is below Payroll's runway": "0",
    });
    const markdown = markdownTwin(loaded!);
    for (const heading of [
      "## The split",
      "## What came in",
      "## The stream to stakers",
      "## The seat pool",
      "## Tips",
      "## The feed budget",
    ]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).not.toContain("The ledger is empty");
    expect(markdown).toContain(`cast send ${model.payroll.address} "fundFeeds()"`);
  });

  it("the seats page shows the pool, and a seat what it can claim and has been paid", async () => {
    const world = launchedA();
    const seats = (await loadPath("/seats", ctxFor(world, "/seats")))!.model as SeatsModel;
    expect(seats.pool).toEqual({
      bookedImd: "30.5",
      claimedImd: "1",
      unclaimedImd: "29.5",
      tipsWaitingImd: "3",
    });
    const seat = await loadPath("/seats/1998", ctxFor(world, "/seats/1998"));
    expect(seat!.model).toMatchObject({ claimableImd: "0.015", paidImd: "0.0005" });
    const markdown = markdownTwin(seat!);
    expect(markdown).toContain("| Claimable from the seat pool | 0.015 IMD |");
    // seatPaid counts the seat pool only; a tip paid to the seat's owner is not in it.
    expect(markdown).toContain("| Paid from the seat pool so far | 0.0005 IMD |");
    expect(markdown).not.toContain("Paid to this seat");
    expect(markdown).toContain(`cast send ${P.replace("a3", "A3")} "claimSeat(uint256)" 1998`);
  });
});

describe("launch A switched on: the judges page, llms.txt and the navigation follow", () => {
  it("launch A reads as launched, its rows count what was read, and nothing else is claimed", async () => {
    const world = launchedA();
    const loaded = await loadPath("/judges", ctxFor(world, "/judges"));
    const model = loaded!.model as JudgesModel;
    expect(model.launchedCount).toBe(3);
    expect(model.summary).toContain("3 of our 10 contracts are launched (launch A).");
    expect(model.launchSummary).toBe(
      "3 of 10 contracts are launched: launch A (Payroll and Questions). Not launched yet: launch B (the hire desk) and launch C (the company).",
    );
    expect(model.launches.map((l) => [l.key, l.launched])).toEqual([
      ["A", true],
      ["B", false],
      ["C", false],
    ]);
    expect(model.notLive.filter((line) => line.startsWith("Launch ")).map((l) => l.slice(0, 8))).toEqual([
      "Launch B",
      "Launch C",
    ]);
    const said = model.notLive.join(" ");
    expect(said).not.toContain("No feed exists");
    expect(said).not.toContain("No fee has been split");
    // Two feeds hold an answer and the report has printed: neither is listed as missing.
    expect(said).not.toContain("No round of a house feed has been answered yet");
    expect(said).not.toContain("has printed nothing");
    expect(said).not.toContain("None has anything to act on yet");
    expect(said).toContain("Since launch A the keeper has feeds to keep; the runner has no desk");
    // The reads of launch A have run against a chain; only B's and C's are said to be untried.
    expect(said).toContain(
      "This site's reads of the contracts that are not in its deployments book (launch B, launch C) have run only against stand-ins",
    );
    expect(said).not.toContain("because no contract of ours exists to read");
    expect(said).toContain(
      "the hire desk is not launched, so no order has been opened and none has been settled",
    );
    const oracle = model.integration.find((r) => r.primitive === "Oracle attestations");
    expect(oracle).toMatchObject({ launch: "launched" });
    expect(oracle?.usage).toMatchObject({ count: "2", reason: null });
    expect(oracle?.proofNote).toContain("2 feeds of our Questions contract hold an answer");
    const stakers = model.integration.find((r) => r.primitive.startsWith("sIMD"));
    expect(stakers?.usage.count).toBe("5 IMD");
    expect(model.feedProofs.limit).toContain("On chain, 2 feeds of the launched contract now hold an answer");
    const text = await llmsTxt(ctxFor(world));
    expect(text).toContain("3 of 10 HELP WANTED contracts launched.");
    expect(text).toContain("since then our Questions contract has stored an answer for 2 feeds");
    expect(text).not.toContain("Not live until Payroll is launched");
    expect(text).toContain("Not live until WorkOrders is launched");
    expect(text).not.toContain("is in IdentityMD's launch pipeline");
  });

  it("the launch on record is said as the book has it, and round events are read from its block on", async () => {
    // The launch-A-only book, with the launch placed inside the day of blocks the fake RPC serves.
    const launchedAt = HEAD - 7_000;
    const book: DeploymentBook = { ...BOOKS.aOnly, a: { ...BOOKS.aOnly.a, block: launchedAt } };
    const world = testSources({
      book,
      chain: {
        views: { ...QUESTIONS_VIEWS, ...PAYROLL_VIEWS, ...REPORT_VIEWS },
        logs: { [Q]: ROUND_LOGS },
      },
    });
    expect(world.sources.deployments.fromEnv).toEqual([]);
    const judges = (await loadPath("/judges", ctxFor(world, "/judges")))!.model as JudgesModel;
    const a = judges.launches.find((l) => l.key === "A");
    expect(a).toMatchObject({ launched: true, launchNumber: TEST_LAUNCH.a.launchNumber });
    expect(a?.status).toBe(
      `Launched as IdentityMD launch ${TEST_LAUNCH.a.launchNumber}, in block ${launchedAt.toLocaleString("en-US")}.`,
    );
    expect(a?.txUrl).toBe(`https://etherscan.io/tx/${TEST_LAUNCH.a.transaction}`);
    const pipeline = judges.integration.find((r) => r.primitive === "The launch pipeline");
    expect(pipeline).toMatchObject({ launch: "partly", statusWords: "Recorded: launch A." });
    expect(pipeline?.usage.count).toBe("1 of 3");
    // The round events are read from the launch block on, never from before the contract existed.
    const questions = (await loadPath("/questions", ctxFor(world, "/questions")))!.model as QuestionsModel;
    expect(questions.houseFeeds[0]?.live?.rounds).toBe(4);
    const logReads = world.chain.calls.filter((c) => c.startsWith(`eth_getLogs ${Q}`));
    expect(logReads.length).toBeGreaterThan(0);
    expect(logReads.every((c) => Number(c.split(" ")[2]?.split("-")[0]) >= launchedAt)).toBe(true);
  });

  it("never says 'not launched' of a launched contract that could not be read", async () => {
    // Launch A is in the book, and the chain answers nothing for it.
    const world = testSources({ book: BOOKS.aOnly });
    const pages = await Promise.all(
      ["/company", "/seats", "/seats/1998", "/jobs-report", "/questions"].map(async (path) => ({
        path,
        loaded: (await loadPath(path, ctxFor(world, path)))!,
      })),
    );
    for (const { path, loaded } of pages) {
      const markdown = markdownTwin(loaded);
      for (const name of ["Payroll", "Questions", "JobsReport"]) {
        expect(markdown, path).not.toContain(`${name} is not launched yet`);
        expect(markdown, path).not.toContain(`${name} (launch A) is not launched yet`);
      }
      expect(markdown, path).toMatch(/could not be read|did not answer/);
    }
    const seats = pages[1]!.loaded.model as SeatsModel;
    expect(seats).toMatchObject({ launched: true, pool: null });
    expect(seats.poolError).toContain("did not answer");
    const seat = pages[2]!.loaded.model as { launched: boolean; claimableImd: string | null };
    expect(seat).toMatchObject({ launched: true, claimableImd: null });
    expect(markdownTwin(pages[2]!.loaded)).toContain(
      "| Claimable from the seat pool | could not be read from Payroll just now |",
    );
    // The Jobs Report does not say "has not printed" of a contract it could not read.
    const report = pages[3]!.loaded.model as JobsReportModel;
    expect(report.official).toMatchObject({ launched: true, printed: false, unread: true });
    expect(markdownTwin(pages[3]!.loaded)).toContain("does not say whether it has printed");
    expect(markdownTwin(pages[3]!.loaded)).not.toContain("has not printed yet");
    const judges = (await loadPath("/judges", ctxFor(world, "/judges")))!.model as JudgesModel;
    const said = judges.notLive.join(" ");
    expect(said).toContain("Whether any house feed holds an answer could not be read just now");
    expect(said).toContain("Whether the Jobs Report has printed could not be read just now");
    expect(said).toContain("Whether any fee has been split could not be read just now");
    expect(said).not.toContain("Payroll is not launched");
    for (const row of judges.integration)
      expect(row.proofNote, row.primitive).not.toContain("does not exist");
  });

  it("never prints a count of zero for a launched desk or company contract that could not be read", async () => {
    // Everything is in the book, and the chain answers nothing for any of it: "0 orders have been
    // opened" would be a statement about a contract nobody read.
    const world = testSources({ book: BOOKS.all });
    for (const path of ["/orders", "/pots", "/endowments", "/rules/new"]) {
      const loaded = (await loadPath(path, ctxFor(world, path)))!;
      const said = `${loaded.meta.description}\n${markdownTwin(loaded)}`;
      expect(said, path).not.toMatch(/\b0 (orders|pots|endowments|rules) (have|has) been/);
      expect(said, path).not.toContain("not launched yet");
      expect(said, path).toMatch(/could not be read just now/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The day of the launch
// ---------------------------------------------------------------------------------------------

/**
 * Launch A as mainnet had it on 13 October 2026, a quarter of an hour after house wallet H1 created
 * the three feeds, put 0.55 IMD on each meter and made the first request of each: one round pending
 * on every feed, no answer anywhere, no print, and a Payroll that has received nothing. The contract
 * addresses are the test book's; the amounts, counts and order of events are the chain's.
 */
const DAY_HEAD = 26_183_686;
const DAY_T0 = 1_791_895_079;
const DAY_FEEDS = [
  { id: PAYROLLS, name: "payrolls", opened: 26_183_619, requestedAt: DAY_T0 },
  { id: HIRES, name: "hires", opened: 26_183_621, requestedAt: DAY_T0 + 24 },
  { id: EMPLOYERS, name: "employers", opened: 26_183_622, requestedAt: DAY_T0 + 36 },
] as const;
const dayFeed = (id: unknown) => DAY_FEEDS.find((feed) => feed.id === id);
/**
 * The window each first round asked about on mainnet. It ends 12 blocks behind the request and is
 * 7,000 blocks long for the two daily feeds and 50,400 for the weekly one, so the two daily windows
 * are two blocks apart: payrolls 26,176,608 to 26,183,607, hires 26,176,610 to 26,183,609.
 */
const dayWindow = (feed: (typeof DAY_FEEDS)[number]) => {
  const toBlock = feed.opened - 12;
  return { fromBlock: toBlock - (feed.name === "employers" ? 50_400 : 7_000) + 1, toBlock };
};
const TIP = IMD / 20n;
const PRICE = IMD / 2n;

const DAY_QUESTIONS_VIEWS: Views = {
  [`${Q}:feedCount`]: { abi: questionsAbi, result: 3n },
  [`${Q}:INTAKE`]: { abi: questionsAbi, result: MAINNET.INTAKE },
  [`${Q}:IMD`]: { abi: questionsAbi, result: MAINNET.IMD },
  [`${Q}:feedAt`]: {
    abi: questionsAbi,
    result: ([index]: readonly unknown[]) => DAY_FEEDS[Number(index)]?.id,
  },
  [`${Q}:feedState`]: {
    abi: questionsAbi,
    result: ([id]: readonly unknown[]) => {
      const feed = dayFeed(id);
      if (!feed) return { ...feedState(null) };
      const cadence = HOUSE_FEEDS[feed.name].params.cadenceBlocks;
      return {
        exists: true,
        rounds: 1n,
        latestRound: 0n,
        lastRequestBlock: BigInt(feed.opened),
        lastToBlock: 0n,
        failStreak: 0,
        pending: true,
        pendingRequestId: `0x${"7".repeat(63)}1`,
        nextRequestBlock: BigInt(feed.opened + cadence),
        // 0.55 IMD went on, and the first request took the price and set the tip aside.
        meterBalance: 0n,
        totalShares: 550_000_000_000_000_000n,
        cost: PRICE + TIP,
        blocker: REQUEST_BLOCKER.RoundPending,
      };
    },
  },
  [`${Q}:latest`]: { abi: questionsAbi, result: [0n, 0n, 0n, 0n, 0n] },
  [`${Q}:feedParams`]: QUESTIONS_VIEWS[`${Q}:feedParams`]!,
  [`${Q}:feedText`]: QUESTIONS_VIEWS[`${Q}:feedText`]!,
  [`${Q}:canSubmit`]: { abi: questionsAbi, result: false },
  [`${Q}:canAbandon`]: {
    abi: questionsAbi,
    result: ([id]: readonly unknown[]) => {
      const feed = dayFeed(id);
      // Wait: closable 12 h + one day of validity + 5 min + 1 s after the request.
      return feed ? [0, BigInt(feed.requestedAt + 129_901)] : [0, 0n];
    },
  },
  [`${Q}:redeemable`]: { abi: questionsAbi, result: 0n },
  [`${Q}:roundOf`]: {
    abi: questionsAbi,
    result: ([id, round]: readonly unknown[]) => {
      const feed = dayFeed(id);
      return feed && round === 1n
        ? [ROUND_STATUS.Pending, 0n, BigInt(dayWindow(feed).fromBlock), BigInt(dayWindow(feed).toBlock), 0n]
        : [0, 0n, 0n, 0n, 0n];
    },
  },
  [`${Q}:roundRequest`]: {
    abi: questionsAbi,
    result: ([id]: readonly unknown[]) => [
      `0x${"7".repeat(63)}1`,
      `0x${"8".repeat(64)}`,
      `0x${"9".repeat(64)}`,
      BigInt(dayFeed(id)?.requestedAt ?? 0),
    ],
  },
  [`${Q}:tipsOf`]: {
    abi: questionsAbi,
    result: ([keeper]: readonly unknown[]) =>
      String(keeper).toLowerCase() === KEEPER ? [0n, 3n * TIP] : [0n, 0n],
  },
};

const ZERO_LEDGER = Object.fromEntries(Object.keys(LEDGER).map((key) => [key, 0n]));
const DAY_PAYROLL_VIEWS: Views = {
  ...PAYROLL_VIEWS,
  [`${P}:ledger`]: { abi: payrollAbi, result: ZERO_LEDGER },
  [`${P}:stream`]: { abi: payrollAbi, result: [0n, 0n, 0n, 0n, 0n, 0n] },
  [`${P}:owed`]: { abi: payrollAbi, result: [0n, 0n, 0n, 0n, 0n] },
  [`${P}:feedBudget`]: { abi: payrollAbi, result: [0n, 0n, 0n, 0n] },
  [`${P}:feedShortfalls`]: { abi: payrollAbi, result: [0n, 0n, 0n] },
  [`${P}:unbooked`]: { abi: payrollAbi, result: 0n },
  [`${P}:seatClaimable`]: { abi: payrollAbi, result: 0n },
  [`${P}:seatPaid`]: { abi: payrollAbi, result: 0n },
  [`${P}:tipOwed`]: { abi: payrollAbi, result: 0n },
};

const DAY_REPORT_VIEWS: Views = {
  ...REPORT_VIEWS,
  [`${J}:latestPrints`]: { abi: jobsReportAbi, result: [] },
  [`${J}:summary`]: {
    abi: jobsReportAbi,
    result: Object.fromEntries(
      Object.keys(REPORT_VIEWS[`${J}:summary`]!.result as object).map((key) => [key, 0n]),
    ),
  },
};

/** The first round of each feed, opened by house wallet H1. */
const DAY_ROUND_LOGS: RawLog[] = DAY_FEEDS.map((feed) => ({
  ...opened(feed.id, 1, KEEPER, feed.opened),
}));

/** The three purchases as the Intake (version 2) logged them: paid by Questions, to be delivered to it. */
const DAY_INTAKE_LOGS: RawLog[] = DAY_FEEDS.map((feed, index) => ({
  ...eventLog(
    intakeAbi,
    MAINNET.INTAKE.toLowerCase(),
    "Requested",
    {
      requestId: `0x${"7".repeat(62)}${index}1`,
      payer: Q,
      action: MAINNET.ORACLE_ACTION,
      body: feedBodyHex(HOUSE_FEEDS[feed.name], dayWindow(feed)),
      callbackTarget: Q,
      callbackSelector: "0x12345678",
      asset: MAINNET.IMD,
      amount: PRICE,
    },
    { block: feed.opened, index: 3 },
  ),
}));

/** What Questions paid the swarm's fee address for them: three transfers of 0.5 IMD. */
const DAY_TRANSFERS: RawLog[] = DAY_FEEDS.map((feed) => ({
  ...eventLog(
    erc20Abi,
    MAINNET.IMD.toLowerCase(),
    "Transfer",
    { from: Q, to: MAINNET.FEE_PAYEE, value: PRICE },
    { block: feed.opened, index: 2 },
  ),
}));

function launchDayA(chain: FakeChainOptions = {}) {
  return testSources({
    book: BOOKS.aOnly,
    // IdentityMD's record of launch A's job as its API gave it once the launch was live.
    api: fakeApi({
      [`/jobs/${LAUNCH_A_JOB.jobId}`]: () =>
        new Response(JSON.stringify(fixtureJson("job-d8bb3d81-live.json")), {
          headers: { "content-type": "application/json" },
        }),
    }),
    chain: {
      head: DAY_HEAD,
      views: { ...DAY_QUESTIONS_VIEWS, ...DAY_PAYROLL_VIEWS, ...DAY_REPORT_VIEWS },
      logs: { [Q]: DAY_ROUND_LOGS },
      intakeLogs: DAY_INTAKE_LOGS,
      transferLogs: DAY_TRANSFERS,
      intakeNonce: 47n,
      imdBalances: { [Q]: 3n * TIP },
      contracts: [Q, J, P],
      ...chain,
    },
  });
}

describe("the day launch A went live: three feeds asking, nothing answered, nothing printed, nothing booked", () => {
  const NOT_LIVE_B =
    "The hire desk (launch B: WorkProof, WorkOrders, CrowdPots, Doorbell) is not launched yet.";
  const NOT_LIVE_C = "The company (launch C: Rules, Endowments, Zap) is not launched yet.";

  it("/questions shows the three feeds, each with its first round pending and its tip set aside for the opener", async () => {
    const loaded = await loadPath("/questions", ctxFor(launchDayA(), "/questions"));
    const model = loaded!.model as QuestionsModel;
    expect(model).toMatchObject({ launched: true, feedCount: 3, feedsError: null });
    expect(model.houseFeeds.map((f) => f.name)).toEqual(["payrolls", "hires", "employers"]);
    for (const feed of model.houseFeeds) {
      expect(feed.live, feed.name).toMatchObject({
        exists: true,
        rounds: 1,
        pending: true,
        meterImd: "0",
        costImd: "0.55",
        requestsFunded: 0,
        latest: "no answer yet",
        canSubmit: false,
      });
      expect(feed.live?.next).toContain(
        "A round is pending: no new request can be made until it is answered",
      );
      expect(feed.live?.roundRows).toHaveLength(1);
      const [round] = feed.live!.roundRows;
      expect(round).toMatchObject({
        round: 1,
        status: "pending: waiting for its answer",
        answer: "none yet",
        tipEarner: null,
      });
      expect(round?.tip).toBe(
        `0.05 IMD is set aside for ${KEEPER} (HOUSE: one of ours), the keeper that opened the round. It is credited if the round is answered, whoever delivers the answer, and goes back onto the meter if the round is closed without one.`,
      );
    }
    // A silent round of a house feed can be closed 36 h 5 min 1 s after its request, in one call.
    expect(model.houseFeeds[0]?.live?.next).toContain("It can be closed from 15 Oct 2026, 00:43 UTC");
    // The three purchases are in the Intake's list: paid by our contract, so HOUSE, with a callback.
    const ours = model.intake.rows.filter((row) => row.payer === Q);
    expect(ours).toHaveLength(3);
    for (const row of ours) {
      expect(row).toMatchObject({ version: 2, house: true, callbackTarget: Q, statusKey: "open" });
    }
    expect(model.intake.counts.ours).toBe(7);
    expect(model.intake.current).toMatchObject({ nonce: 47, listed: 23 });

    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain(`Questions is at [${model.questions.label}]`);
    expect(markdown).toContain("3 feeds have been created in it.");
    expect(markdown).toContain("Rounds so far: 1. Latest answer: no answer yet");
    expect(markdown).toContain("(HOUSE: one of ours)");
    expect(markdown).not.toContain("not launched yet** (launch A)");
    expect(markdown).toContain(NOT_LIVE_B);
    expect(markdown).toContain(NOT_LIVE_C);
    // Zap is launch C: the page says so where it offers to fund a meter with ETH.
    expect(markdown).toContain('cast send $ZAP "fundMeter(bytes32,uint256,uint256)"');
    expect(markdown).not.toContain("$QUESTIONS");
  });

  it("/jobs-report says the contract is live and has not printed, and counts our own payments as HOUSE", async () => {
    const loaded = await loadPath("/jobs-report", ctxFor(launchDayA(), "/jobs-report"));
    const model = loaded!.model as JobsReportModel;
    expect(model.official).toMatchObject({ launched: true, printed: false, unread: false, error: null });
    expect(model.official.summary).toMatchObject({ prints: 0, totalWei: 0n });
    expect(model.official.prints).toEqual([]);
    expect(loaded!.meta.title).toBe("The Robot Jobs Report (unofficial tally)");
    expect(model.releaseNumber.endsWith("-U")).toBe(true);
    // What Questions paid the swarm for its three requests is ours, and is never outside usage.
    expect(model.tally).toMatchObject({
      payments: 3,
      totalWei: 3n * PRICE,
      housePayments: 3,
      houseWei: 3n * PRICE,
      outsidePayments: 0,
      outsideWei: 0n,
    });
    expect(model.tally?.topPayers[0]).toMatchObject({ address: Q, house: true });
    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain("**UNOFFICIAL TALLY.** The JobsReport contract is live at");
    expect(markdown).toContain("and has not printed yet.");
    // Table A: three payments, all three HOUSE, none OUTSIDE.
    expect(markdown).toContain("| Payments | 3 | 3 | 0 |");
    expect(markdown).toContain("| Non-human payrolls, IMD | 1.5 | 1.5 | 0 |");
    expect(markdown).toContain(`| 1 | ${Q} | 1.5 | 3 | 100.0% | HOUSE |`);
    expect(markdown).not.toContain("**OFFICIAL RELEASE.**");
    expect(markdown).toContain(NOT_LIVE_B);
    expect(markdown).toContain(`cast call ${model.official.contract.address} "latestPrint()`);
  });

  it("/company says Payroll is live and has booked nothing, and why", async () => {
    const loaded = await loadPath("/company", ctxFor(launchDayA(), "/company"));
    const model = loaded!.model as CompanyModel;
    expect(model).toMatchObject({ launched: true, error: null });
    expect(model.ledger?.receivedWei).toBe(0n);
    expect(model.nothingYet).toContain("Payroll has booked nothing yet");
    for (const section of model.sections) {
      expect(section.rows.length, section.title).toBeGreaterThan(0);
      for (const row of section.rows) expect(row.imd, `${section.title}: ${row.label}`).toBe("0");
    }
    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain(`Payroll is at [${model.payroll.label}]`);
    expect(markdown).not.toContain("The ledger is empty: Payroll (launch A) is not launched yet");
    expect(markdown).toContain(
      `${NOT_LIVE_B} Fees and tips reach Payroll from orders settled on the hire desk`,
    );
    expect(markdown).toContain(NOT_LIVE_C);
    // The claim rule as launched: a contract that holds a seat claims for itself.
    expect(model.limits.join(" ")).toContain("ContractOwnerMustClaim");
    expect(model.limits.join(" ")).not.toContain("anyone may trigger it");
  });

  it("/seats and a seat show a pool of nothing, read from Payroll, and how a claim is made", async () => {
    const world = launchDayA();
    const seats = await loadPath("/seats", ctxFor(world, "/seats"));
    const model = seats!.model as SeatsModel;
    expect(model).toMatchObject({ launched: true, poolError: null });
    expect(model.pool).toEqual({ bookedImd: "0", claimedImd: "0", unclaimedImd: "0", tipsWaitingImd: "0" });
    const markdown = markdownTwin(seats!);
    expect(markdown).not.toContain("Nothing can be claimed yet: Payroll (launch A) is not launched yet");
    expect(markdown).toContain("The seat pool so far: 0 IMD booked for seats, 0 IMD claimed");
    expect(markdown).toContain(`${NOT_LIVE_B} The seat pool is filled from the hire desk's fees`);
    expect(markdown).toContain(
      "When the seat's owner is an address with no code (an ordinary wallet) or Payroll itself, nothing needs the owner's signature",
    );
    expect(markdown).toContain(
      "only the owner may send it; anyone else's call reverts ContractOwnerMustClaim",
    );
    expect(markdown).not.toContain("Nothing needs the owner's signature. Anyone can send the claim");

    const seat = await loadPath("/seats/1998", ctxFor(world, "/seats/1998"));
    expect(seat!.model).toMatchObject({ launched: true, claimableImd: "0", paidImd: "0" });
    const seatMarkdown = markdownTwin(seat!);
    expect(seatMarkdown).toContain("| Claimable from the seat pool | 0 IMD |");
    expect(seatMarkdown).toContain(
      "Anyone may call claimSeat when the seat's owner is an address with no code (an ordinary wallet) or Payroll itself.",
    );
    expect(seatMarkdown).toContain(
      "only the owner may call it; anyone else's call reverts ContractOwnerMustClaim.",
    );
    expect(seatMarkdown).not.toContain("must be claimed by that contract itself");
    expect(seatMarkdown).not.toContain("Claim before moving a seat into another contract");
    expect(seatMarkdown).toContain(NOT_LIVE_B);
  });

  it("/judges says what is live, what has not happened yet, and whose activity it was", async () => {
    const world = launchDayA();
    const loaded = await loadPath("/judges", ctxFor(world, "/judges"));
    const model = loaded!.model as JudgesModel;
    expect(model.launchedCount).toBe(3);
    expect(model.summary).toContain("3 of our 10 contracts are launched (launch A).");
    expect(model.contracts.filter((c) => c.address !== null).map((c) => c.name)).toEqual([
      "Questions",
      "JobsReport",
      "Payroll",
    ]);
    // IdentityMD's own record of the launch job: completed, every step accepted, the launch live.
    expect(model.pipeline.read).toMatchObject({ state: "completed", launchStatus: "live", stepsAccepted: 9 });
    expect(model.pipeline.words).toBe(
      `IdentityMD's API gives the job's state as "completed". 9 of its 9 steps are accepted. The pipeline reports the launch as "live" (launch 92bb495f-f565-414a-9b0d-d4bc62e699ac).`,
    );
    expect(model.audits.adaptation.findings.map((f) => [f.title, f.outcome])).toEqual([
      ["keeper tip", "changed"],
      ["premature closure", "changed"],
      ["fixed signer", "kept"],
      ["escrow claims", "changed"],
    ]);
    expect(model.audits.adaptation.intro).toContain("Read for this page: 5 of those 5 are accepted.");

    const said = model.notLive.join(" ");
    expect(model.notLive.filter((line) => line.startsWith("Launch ")).map((l) => l.slice(0, 8))).toEqual([
      "Launch B",
      "Launch C",
    ]);
    expect(said).toContain(
      "No round of a house feed has been answered yet, so no feed holds an answer and nothing has been delivered to a contract of ours: 3 of the three house feeds exist, with 3 rounds opened and 3 still pending. Of the 3 rounds whose opening this server could read, 3 were opened by our own wallets (HOUSE) and 0 by others (OUTSIDE).",
    );
    expect(said).toContain("The JobsReport contract has printed nothing");
    expect(said).toContain("Payroll is launched and has received no fee yet");
    expect(said).toContain(
      "the hire desk is not launched, so no order has been opened and none has been settled by a real job",
    );
    expect(said).toContain("The header job's receipt is not on chain.");
    expect(said).not.toContain("No feed exists");
    expect(said).not.toContain("Payroll is not launched");

    const row = (start: string) => model.integration.find((r) => r.primitive.startsWith(start));
    expect(row("Oracle attestations")).toMatchObject({ launch: "launched" });
    expect(row("Oracle attestations")?.usage).toMatchObject({ count: "0", reason: null });
    expect(row("Oracle attestations")?.proofNote).toContain("has stored no answer yet (read for this page)");
    expect(row("Intake, version 2")?.usage).toMatchObject({ count: "3", reason: null });
    expect(row("IMD")?.proofNote).toBe("Read for this page: Questions holds 0.15 IMD, Payroll holds 0 IMD.");
    expect(row("sIMD")?.usage.count).toBe("0 IMD");
    expect(row("sIMD")?.proofNote).toBe("Payroll's ledger, read live: it has sent nothing to sIMD yet.");
    expect(row("WorkRegistry")?.usage).toMatchObject({
      count: null,
      reason: "WorkOrders is not launched yet",
    });
    // The x402 count is the house wallets' own history, kept with its source: the same in every book.
    expect(row("Paid swarm jobs")?.usage.count).toBe(String(HOUSE_X402.payments.length));
    // Our contract's three payments to the fee address are HOUSE payments in the newest day's tally.
    expect(row("Paid swarm jobs")?.proofNote).toContain(
      "In the newest day of blocks the tally counts 3 payments to the fee address from house wallets and contracts",
    );
    expect(model.feedProofs.limit).toContain("none has been answered yet (read for this page)");

    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain(
      "3 of 10 contracts are launched: launch A (Payroll and Questions). Not launched yet: launch B (the hire desk) and launch C (the company).",
    );
    expect(markdown).not.toContain("**Nothing is launched yet.**");
    expect(markdown).toContain("**What the launch pipeline changed before the launch.**");
    expect(markdown).toContain("| keeper tip (2ab3a604) | changed |");
  });

  it("/llms.txt and the JSON API say the same", async () => {
    const world = launchDayA();
    const text = await llmsTxt(ctxFor(world));
    expect(text).toContain("**3 of our 10 contracts are launched (launch A).**");
    expect(text).toContain(
      "our Questions contract is launched and has stored no answer yet (3 of its three house feeds exist; none has an answered round).",
    );
    expect(text).not.toContain("is in IdentityMD's launch pipeline");
    expect(text).toContain("Not live until WorkOrders is launched");
    // Say When is a conditional order on the desk: it waits for WorkOrders, and Endowments for itself.
    expect(text).toContain(
      "[Say When](https://help-wanted.test/rules/new.md): WHEN a view call crosses a line",
    );
    expect(text).toContain("Not live until Endowments is launched");
    expect(text).not.toContain("Not live until Rules is launched");
    expect(text).not.toContain("Not live until Payroll is launched");

    const get = async <T>(path: string) =>
      (await (await handleApi(path, new Request("https://help-wanted.test/x"), ctxFor(world))).json()) as T;
    const evidence = await get<{
      contracts: { launched: number };
      standingQuestions: Record<string, unknown>;
      jobsReport: Record<string, unknown>;
      feeSplit: Record<string, unknown>;
      orders: Record<string, unknown>;
      intakeRequests: Record<string, unknown>;
      paymentsToTheSwarm: Record<string, unknown>;
    }>("evidence");
    expect(evidence.contracts.launched).toBe(3);
    expect(evidence.standingQuestions).toMatchObject({
      feedsCreated: 3,
      houseFeedsCreated: 3,
      houseRoundsOpened: 3,
      houseFeedsWithAnAnswer: 0,
      roundsWhoseOpenerWasRead: 3,
      openedByHouse: 3,
      openedByOutside: 0,
    });
    expect(evidence.jobsReport).toEqual({ prints: 0 });
    expect(evidence.feeSplit).toMatchObject({ receivedWei: "0", sentToStakersWei: "0" });
    expect(evidence.orders).toEqual({ opened: null, reason: "WorkOrders is not launched yet" });
    expect(evidence.intakeRequests).toMatchObject({ boughtByOurContracts: 3, boughtByHouseWallets: 7 });
    expect(evidence.paymentsToTheSwarm).toMatchObject({ payments: 3, housePayments: 3, outsidePayments: 0 });

    const status = await get<{
      launchedContracts: number;
      contracts: { contract: string; answersAsThatContract: boolean | null }[];
    }>("status");
    expect(status.launchedContracts).toBe(3);
    expect(status.contracts.map((c) => [c.contract, c.answersAsThatContract])).toEqual([
      ["Questions", true],
      ["JobsReport", true],
      ["Payroll", true],
    ]);
    const pnl = await get<{ launched: boolean; nothingYet: string | null }>("pnl");
    expect(pnl).toMatchObject({ launched: true });
    expect(pnl.nothingYet).toContain("Payroll has booked nothing yet");
  });
});

/**
 * The same day, half an hour on, as mainnet had it from block 26,183,781: house wallet H1 handed the
 * payrolls and hires answers in with `submit` (the Intake had not completed the requests), then
 * called `print`. The employers round is still pending: nobody can hand that one in.
 */
const ANSWERED = {
  [PAYROLLS]: { value: 112n * IMD, block: 26_183_772, agreed: 6 },
  [HIRES]: { value: 223n, block: 26_183_780, agreed: 7 },
} as Record<string, { value: bigint; block: number; agreed: number }>;

function afterFirstAnswers() {
  const views: Views = {
    ...DAY_QUESTIONS_VIEWS,
    [`${Q}:feedState`]: {
      abi: questionsAbi,
      result: (args: readonly unknown[]) => {
        const state = (DAY_QUESTIONS_VIEWS[`${Q}:feedState`]!.result as (a: readonly unknown[]) => object)(
          args,
        );
        const feed = dayFeed(args[0]);
        return feed && ANSWERED[feed.id]
          ? {
              ...state,
              pending: false,
              latestRound: 1n,
              lastToBlock: BigInt(dayWindow(feed).toBlock),
              pendingRequestId: ZERO32,
              blocker: REQUEST_BLOCKER.TooSoon,
            }
          : state;
      },
    },
    [`${Q}:latest`]: {
      abi: questionsAbi,
      result: ([id]: readonly unknown[]) => {
        const feed = dayFeed(id);
        const answer = feed ? ANSWERED[feed.id] : undefined;
        return feed && answer
          ? [
              answer.value,
              BigInt(dayWindow(feed).fromBlock),
              BigInt(dayWindow(feed).toBlock),
              1n,
              BigInt(DAY_T0 + 1_900),
            ]
          : [0n, 0n, 0n, 0n, 0n];
      },
    },
    [`${Q}:roundOf`]: {
      abi: questionsAbi,
      result: ([id, round]: readonly unknown[]) => {
        const feed = dayFeed(id);
        if (!feed || round !== 1n) return [0, 0n, 0n, 0n, 0n];
        const answer = ANSWERED[feed.id];
        return answer
          ? [
              ROUND_STATUS.Answered,
              answer.value,
              BigInt(dayWindow(feed).fromBlock),
              BigInt(dayWindow(feed).toBlock),
              BigInt(DAY_T0 + 1_900),
            ]
          : [
              ROUND_STATUS.Pending,
              0n,
              BigInt(dayWindow(feed).fromBlock),
              BigInt(dayWindow(feed).toBlock),
              0n,
            ];
      },
    },
    [`${Q}:canAbandon`]: {
      abi: questionsAbi,
      result: ([id]: readonly unknown[]) => {
        const feed = dayFeed(id);
        return feed && !ANSWERED[feed.id] ? [0, BigInt(feed.requestedAt + 129_901)] : [0, 0n];
      },
    },
    [`${Q}:tipsOf`]: {
      abi: questionsAbi,
      result: ([keeper]: readonly unknown[]) =>
        String(keeper).toLowerCase() === KEEPER ? [2n * TIP, TIP] : [0n, 0n],
    },
    ...DAY_PAYROLL_VIEWS,
    ...REPORT_VIEWS,
    [`${J}:latestPrints`]: {
      abi: jobsReportAbi,
      result: [
        {
          amount: 112n * IMD,
          count: 223n,
          fromBlock: 26_176_608n,
          toBlock: 26_183_607n,
          payrollsRound: 1n,
          hiresRound: 1n,
        },
      ],
    },
    [`${J}:summary`]: {
      abi: jobsReportAbi,
      result: {
        ...(DAY_REPORT_VIEWS[`${J}:summary`]!.result as object),
        prints: 1n,
        total: 112n * IMD,
        counts: 1n,
        totalCount: 223n,
        bestAmount: 112n * IMD,
        streak: 1n,
        longestStreak: 1n,
        payrollsRead: 1n,
        hiresRead: 1n,
        pairedPrints: 1n,
        pairedCounts: 1n,
      },
    },
  };
  // Each answer was handed in by H1 itself, the keeper that had opened the round.
  const answers = DAY_FEEDS.filter((feed) => ANSWERED[feed.id]).map((feed) =>
    answered(feed.id, 1, KEEPER, "3744d864-8cbf-4fcf-8a8c-3529fb1736cb", ANSWERED[feed.id]!.block),
  );
  return launchDayA({
    head: 26_183_860,
    views,
    logs: { [Q]: [...DAY_ROUND_LOGS, ...answers] },
    intakeNonce: 51n,
  });
}

describe("the same day, after house wallet H1 handed in the first two answers and printed", () => {
  it("/questions says each answer was handed in with submit, by whom, and that the tip was the opener's", async () => {
    const loaded = await loadPath("/questions", ctxFor(afterFirstAnswers(), "/questions"));
    const model = loaded!.model as QuestionsModel;
    const [payrolls, hires, employers] = model.houseFeeds;
    expect(payrolls?.live).toMatchObject({ rounds: 1, pending: false });
    expect(payrolls?.live?.latest).toContain("112 IMD for blocks");
    expect(hires?.live?.latest).toContain("223 transfers for blocks");
    // The first request emptied the meter. The next one is a day away, and the page says now that
    // the meter cannot pay for it, although the contract's own reason today is only "too soon".
    expect(payrolls?.live).toMatchObject({ meterImd: "0", requestsFunded: 0 });
    expect(payrolls?.live?.next).toMatch(/^Due at block [\d,]+, in about /);
    expect(payrolls?.live?.next).toContain(
      "The meter holds less than one request costs (0.55 IMD), so it has to be funded before the feed can ask again.",
    );
    for (const feed of [payrolls, hires]) {
      const [round] = feed!.live!.roundRows;
      expect(round).toMatchObject({
        status: "answered",
        tipEarner: KEEPER,
        delivered: `submit, by ${KEEPER}`,
      });
      // Opener and submitter are the same house wallet: said once, with what handing in earns.
      expect(round?.tip).toBe(
        `0.05 IMD earned by ${KEEPER} (HOUSE: one of ours), the keeper that opened the round. The same account handed the answer in with submit; handing in earns nothing of its own.`,
      );
    }
    // The weekly list is judged by a panel: submit is closed for it, and its round still waits.
    expect(employers?.live).toMatchObject({ pending: true, latest: "no answer yet" });
    expect(employers?.live?.roundRows[0]).toMatchObject({
      status: "pending: waiting for its answer",
      delivered: null,
    });
    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain(`| answered | 112 IMD |`);
    expect(markdown).toContain(`| submit, by ${KEEPER} |`);
    expect(markdown).not.toContain("the Intake's callback delivered the answer");
  });

  it("/jobs-report leads with the official print, and still calls its own tally unofficial", async () => {
    const loaded = await loadPath("/jobs-report", ctxFor(afterFirstAnswers(), "/jobs-report"));
    const model = loaded!.model as JobsReportModel;
    expect(loaded!.meta.title).toBe("The Robot Jobs Report");
    expect(model.official).toMatchObject({ launched: true, printed: true, unread: false });
    // As on mainnet: the count's window is two blocks off the print's, and the page says which
    // blocks each figure is for (the print's own blocks hold 224 transfers, not 223).
    expect(model.headline).toBe(
      "Official print no. 1: 112 IMD was paid to the swarm in blocks 26,176,608 to 26,183,607, and 223 payments were counted in blocks 26,176,610 to 26,183,609, as answered by IdentityMD's oracle and stored on chain.",
    );
    expect(model.official.prints[0]).toMatchObject({
      countWindow: { fromBlock: 26_176_610, toBlock: 26_183_609 },
      countWords: "223, counted over blocks 26,176,610 to 26,183,609",
    });
    expect(model.officialCommands.map((c) => c.command).join("\n")).toContain(
      "--from-block 26176610 --to-block 26183609 ",
    );
    expect(model.official.summary).toMatchObject({
      prints: 1,
      totalWei: 112n * IMD,
      counts: 1,
      totalCount: 223n,
    });
    // This world's fake RPC holds only our own three payments, not the day the print covers.
    expect(model.official.prints[0]?.check).toBeNull();
    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain("**OFFICIAL RELEASE.**");
    expect(markdown).toContain("## The unofficial tally, beside it");
    expect(markdown).toContain(
      "not held by this server: some of these blocks are older than the range it reads",
    );
  });

  it("/judges counts two answered feeds and one print, and says no answer has come by the Intake's callback", async () => {
    const world = afterFirstAnswers();
    const model = (await loadPath("/judges", ctxFor(world, "/judges")))!.model as JudgesModel;
    const said = model.notLive.join(" ");
    expect(said).not.toContain("No round of a house feed has been answered yet");
    expect(said).not.toContain("has printed nothing");
    expect(said).toContain(
      "No answer has reached our Questions contract through the Intake's own callback yet: the 2 answered rounds this server could read were handed in with submit, 2 of them by our own wallets (HOUSE).",
    );
    expect(said).toContain("Payroll is launched and has received no fee yet");
    const oracle = model.integration.find((r) => r.primitive === "Oracle attestations");
    expect(oracle?.usage).toMatchObject({ count: "2", reason: null });
    expect(oracle?.proofNote).toContain(
      "Of the 2 answered rounds whose delivery this server could read, 0 were delivered by the Intake's own callback and 2 handed in with submit (2 of those by our own wallets, HOUSE).",
    );
    expect(model.feedProofs.limit).toContain(
      "On chain, 2 feeds of the launched contract now hold an answer it checked",
    );
    const evidence = (await (
      await handleApi("evidence", new Request("https://help-wanted.test/x"), ctxFor(world))
    ).json()) as { standingQuestions: Record<string, unknown>; jobsReport: Record<string, unknown> };
    expect(evidence.standingQuestions).toMatchObject({
      houseFeedsWithAnAnswer: 2,
      answeredRoundsWhoseDeliveryWasRead: 2,
      deliveredByTheIntakeCallback: 0,
      handedInWithSubmit: 2,
      handedInWithSubmitByHouse: 2,
      openedByHouse: 3,
      openedByOutside: 0,
    });
    expect(evidence.jobsReport).toEqual({ prints: 1 });
    const text = await llmsTxt(ctxFor(world));
    expect(text).toContain(
      "since then our Questions contract has stored an answer for 2 feeds, each checked on chain",
    );
  });
});

describe("the launched contract's own logs, as mainnet served them on the day", () => {
  const recorded = fixtureJson<{ address: string; fromBlock: number; toBlock: number; logs: RawLog[] }>(
    "launch-a-questions-logs-26182869-26183622.json",
  );
  const H1 = HOUSE_WALLETS[1]!.address.toLowerCase();
  const decoded = recorded.logs.flatMap((log) => {
    try {
      return [
        decodeEventLog({ abi: questionsAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex }),
      ];
    } catch {
      return [];
    }
  });

  it("the generated ABI decodes them: three feeds created, three meters funded, three rounds opened", () => {
    const names = decoded.map((event) => event.eventName);
    expect(names.filter((name) => name === "FeedCreated")).toHaveLength(3);
    expect(names.filter((name) => name === "Funded")).toHaveLength(3);
    expect(names.filter((name) => name === "RoundOpened")).toHaveLength(3);
    // The three feeds created on chain are exactly the three house feeds of the shared package.
    const created = decoded.flatMap((event) =>
      event.eventName === "FeedCreated" ? [event.args.feedId] : [],
    );
    expect(created).toEqual([PAYROLLS, HIRES, EMPLOYERS]);
    for (const event of decoded) {
      if (event.eventName === "Funded") {
        expect(event.args.amount).toBe(550_000_000_000_000_000n);
        expect(event.args.funder.toLowerCase()).toBe(H1);
      }
      if (event.eventName === "RoundOpened") {
        expect(event.args).toMatchObject({ round: 1n, price: PRICE, tip: TIP });
        expect(event.args.keeper.toLowerCase()).toBe(H1);
      }
    }
  });

  it("the site reads who opened each round from them, and labels that wallet HOUSE", async () => {
    // A book whose Questions is the recorded address, launched in the recorded block.
    const address = recorded.address.toLowerCase();
    const book: DeploymentBook = {
      ...BOOKS.aOnly,
      a: {
        ...BOOKS.aOnly.a,
        block: recorded.fromBlock,
        contracts: { ...BOOKS.aOnly.a.contracts, questions: address as `0x${string}` },
      },
    };
    const views = Object.fromEntries(
      Object.entries(DAY_QUESTIONS_VIEWS).map(([key, view]) => [key.replace(Q, address), view]),
    );
    const world = testSources({
      book,
      chain: { head: recorded.toBlock + 64, views, logs: { [address]: recorded.logs } },
    });
    const feeds = await world.sources.house.feeds();
    if (!feeds.live || !feeds.data) throw new Error("expected the feeds to be read");
    expect(feeds.data.feeds.map((feed) => feed.house)).toEqual(["payrolls", "hires", "employers"]);
    for (const feed of feeds.data.feeds) {
      expect(feed.roundList).toHaveLength(1);
      expect(feed.roundList[0]).toMatchObject({
        round: 1,
        status: "Pending",
        keeper: H1,
        tipWei: TIP,
        priceWei: PRICE,
        tipOutcome: "pending",
        tipEarner: null,
      });
    }
    // Read from the launch block on, and no earlier.
    expect(world.chain.calls.filter((c) => c.startsWith(`eth_getLogs ${address}`))).toEqual([
      `eth_getLogs ${address} ${recorded.fromBlock}-${recorded.toBlock + 64}`,
    ]);
    const judges = (await loadPath("/judges", ctxFor(world, "/judges")))!.model as JudgesModel;
    expect(judges.notLive.join(" ")).toContain(
      "3 were opened by our own wallets (HOUSE) and 0 by others (OUTSIDE)",
    );
  });
});

describe("launch B and C on a page: a pot's kind, rules and endowments", () => {
  const POTS = "0x00000000000000000000000000000000000000c2";
  const RULES = "0x00000000000000000000000000000000000000c8";
  const ENDOW = "0x00000000000000000000000000000000000000c9";
  const SPEC = "Write a one-page summary of the week's IMD transfers to the fee payee.";

  it("a pot shows its job kind in text, as kindOf returns it, and says whether a runner knows it", async () => {
    const pot = {
      specHash: specHash(SPEC),
      kindHash: kindHash("skill:research-report"),
      target: 5n * IMD,
      raised: IMD,
      deadline: 1_792_300_000,
      stage: 1,
      allowClaimed: false,
      minPay: 2n * IMD,
      bond: IMD / 2n,
      rampSecs: 3600,
      deliverySecs: 604_800,
      opener: "0x1111111111111111111111111111111111111111",
      hireSecs: 604_800,
      fundSecs: 259_200,
      pool: 0n,
      chipsLeft: 0n,
      orderExpiresAt: 0,
      seriesId: 0n,
      jobId: `0x${"0".repeat(32)}`,
      orderId: 0n,
      recordHash: ZERO32,
    };
    const views = (kind: string): Views => ({
      [`${POTS}:remaining`]: { abi: crowdPotsAbi, result: 4n * IMD },
      [`${POTS}:stageOf`]: { abi: crowdPotsAbi, result: 1 },
      [`${POTS}:potOf`]: { abi: crowdPotsAbi, result: { ...pot, kindHash: kindHash(kind) } },
      [`${POTS}:kindOf`]: { abi: crowdPotsAbi, result: kind },
    });
    const known = testSources({
      env: { HW_ADDR_CROWD_POTS: POTS },
      chain: { views: views("skill:research-report") },
    });
    const page = (await loadPath("/pots/1", ctxFor(known, "/pots/1")))!.model as PotModel;
    expect(page.kind).toBe("skill:research-report");
    expect(page.facts.find((f) => f.label === "Job kind")?.value).toBe("skill:research-report");
    expect(page.kindNote).toContain("A kind the open-source runner knows how to open");

    const odd = testSources({
      env: { HW_ADDR_CROWD_POTS: POTS },
      chain: { views: views("skill:write-poem") },
    });
    const other = (await loadPath("/pots/1", ctxFor(odd, "/pots/1")))!.model as PotModel;
    expect(other.kind).toBe("skill:write-poem");
    expect(other.kindNote).toContain("Not one of the kinds the open-source runner opens");
  });

  it("lists rules as sentences, and endowments with what a harvest would send", async () => {
    const world = testSources({
      env: { HW_ADDR_RULES: RULES, HW_ADDR_ENDOWMENTS: ENDOW },
      chain: {
        views: {
          [`${RULES}:ruleCount`]: { abi: rulesAbi, result: 0n },
          [`${ENDOW}:endowmentCount`]: { abi: endowmentsAbi, result: 2n },
          [`${ENDOW}:METER_RUNWAY`]: { abi: endowmentsAbi, result: 30n },
          [`${ENDOW}:nextStakeBlock`]: { abi: endowmentsAbi, result: BigInt(HEAD + 12) },
          [`${ENDOW}:pendingTotal`]: { abi: endowmentsAbi, result: 3n * IMD },
          [`${ENDOW}:vaultHold`]: { abi: endowmentsAbi, result: false },
          [`${ENDOW}:endowment`]: {
            abi: endowmentsAbi,
            result: ([id]: readonly unknown[]) =>
              id === 2n
                ? [1, PAYROLLS, ZERO, 1_000n * IMD, 3n * IMD, 0n, 2n * IMD]
                : [3, ZERO32, "0x5555555555555555555555555555555555555555", 50n * IMD, 0n, 0n, 0n],
          },
          [`${ENDOW}:harvestable`]: {
            abi: endowmentsAbi,
            result: ([id]: readonly unknown[]) => (id === 2n ? 0n : IMD / 4n),
          },
        },
      },
    });
    const endowments = (await loadPath("/endowments", ctxFor(world, "/endowments")))!
      .model as EndowmentsModel;
    expect(endowments.launched).toBe(true);
    expect(endowments.count).toBe(2);
    expect(endowments.rows.map((r) => [r.id, r.kind, r.target])).toEqual([
      [2, "Meter", "the meter of the payrolls feed"],
      [1, "Recipient", "0x5555555555555555555555555555555555555555"],
    ]);
    // A meter endowment that sends nothing now says why that can be: the runway of 30 requests.
    expect(endowments.rows[0]?.harvestable).toContain("the meter already holds 30 requests' worth");
    expect(endowments.rows[1]?.harvestable).toBe("0.25 IMD");
    expect(endowments.stakingNote).toContain("3 IMD is waiting to be staked");
    expect(endowments.stakingNote).toContain("METER_RUNWAY, as read from the contract: 30.");

    const rules = (await loadPath("/rules/new", ctxFor(world, "/rules/new")))!.model as RulesNewModel;
    expect(rules.ruleCount).toBe(0);
    expect(rules.ruleRows).toEqual([]);
    expect(rules.rules.address?.toLowerCase()).toBe(RULES);
  });
});

describe("the keeper's status file", () => {
  // The shape `bots/keeper/src/status.ts` writes (its StatusFile, version 1), cut to what matters here.
  const STATUS = {
    v: 1,
    at: "2026-10-10T21:20:00.000Z",
    command: "run",
    mode: "live",
    dryRunReason: null,
    keeper: HOUSE_WALLETS[1]!.address,
    chainId: 1,
    block: { number: "26164650", time: 1_791_667_200 },
    killed: false,
    attention: ["The hires meter holds fewer than three requests."],
    nextDue: [{ feed: "payrolls", block: "26171852", at: 1_791_750_000, note: "a round is pending" }],
    done: [{ module: "questions", label: "request payrolls", outcome: "sent", hash: `0x${"ab".repeat(32)}` }],
    errors: [],
    privateKey: "this field is not one the site reads",
  };

  it("reads only the fields a page prints, and refuses what is not a status", () => {
    const parsed = parseKeeperStatus(STATUS);
    expect(parsed).toMatchObject({ at: STATUS.at, mode: "live", killed: false });
    expect(parsed?.attention).toEqual(STATUS.attention);
    expect(JSON.stringify(parsed)).not.toContain("this field is not one the site reads");
    expect(parsed?.block).toBe(26_164_650);
    expect(parsed?.keeper).toBe(HOUSE_WALLETS[1]!.address.toLowerCase());
    expect(parseKeeperStatus(null)).toBeNull();
    expect(parseKeeperStatus({ mode: "live" })).toBeNull();
    expect(parseKeeperStatus("nope")).toBeNull();
    // A later version of the file is not guessed at.
    expect(parseKeeperStatus({ ...STATUS, v: 2 })).toBeNull();
  });

  it("is shown on the questions page when the server has been told where it is, and not otherwise", async () => {
    const none = (await loadPath("/questions", ctxFor(testSources(), "/questions")))!.model as QuestionsModel;
    expect(none.keeper.connected).toBe(false);
    expect(none.keeper.words).toContain("No keeper status is connected to this server.");

    const keeper = keeperSource({
      path: "/somewhere/keeper-status.json",
      url: null,
      read: async () => JSON.stringify(STATUS),
    });
    const world = testSources({ keeper });
    const shown = (await loadPath("/questions", ctxFor(world, "/questions")))!.model as QuestionsModel;
    expect(shown.keeper.connected).toBe(true);
    expect(shown.keeper.words).toContain("The keeper last wrote its status 10 Oct 2026, 21:20 UTC");
    expect(shown.keeper.words).toContain("in live mode");
    expect(shown.keeper.attention).toEqual(STATUS.attention);
    expect(shown.keeper.nextDue).toEqual([
      { feed: "payrolls", when: expect.stringContaining("2026"), note: "a round is pending" },
    ]);
    // The page never prints where the file is.
    expect(JSON.stringify(shown.keeper)).not.toContain("/somewhere/");
  });

  it("says the status could not be read when the file is missing or is not a status", async () => {
    const missing = keeperSource({
      path: "/nope.json",
      url: null,
      read: async () => {
        throw new Error("ENOENT");
      },
    });
    const read = await missing.status();
    expect(read).toMatchObject({ configured: true, status: null });
    const garbage = keeperSource({ path: "/x.json", url: null, read: async () => "[1,2,3]" });
    expect(await garbage.status()).toMatchObject({ configured: true, status: null });
    // Over HTTP, only GET, and never through the global fetch a test forbids.
    const calls: string[] = [];
    const remote = keeperSource({
      path: null,
      url: "https://keeper.example/status.json",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        return new Response(JSON.stringify(STATUS), { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    expect((await remote.status()).configured).toBe(true);
    await remote.status();
    expect(calls).toEqual(["GET https://keeper.example/status.json"]);
  });
});
