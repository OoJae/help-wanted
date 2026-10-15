import { describe, expect, it } from "vitest";
import {
  attribute,
  eventTable,
  foldLaunchA,
  foldLaunchB,
  foldLaunchC,
  transactionsBySender,
  viewKey,
  type DecodedLog,
} from "../fold.js";
import { houseList, parseHouseFile } from "../house.js";
import {
  decodeLogUnder,
  HOUSE_FEEDS,
  MAINNET,
  ORDER_FLAG,
  ORDER_STATE,
  CLAIM_END,
  questionsAbi,
  type Address,
  type Hex,
} from "../shared.js";
import {
  ADDRESSES,
  Chain,
  H1,
  HOUSE_FILE,
  IMD,
  JOB,
  OUTSIDER,
  RECORD,
  ROOT,
  RUNNER,
  STRANGER,
  W1,
  ZERO_ADDRESS,
  ZERO_WORD,
  house,
  orderParams,
  readJson,
} from "./helpers.js";

const INTAKE = MAINNET.INTAKE.toLowerCase() as Address;
const input = (contracts?: Parameters<typeof house>[0]) => ({
  house: house(contracts),
  intake: INTAKE,
  addresses: ADDRESSES,
});

interface RawLog {
  topics: string[];
  data: string;
  blockNumber: string;
  blockTimestamp: string;
  transactionHash: string;
  logIndex: string;
}

/** The logs of a saved `eth_getLogs` answer for Questions, named with the builder's decoder. */
function questionsLogs(raw: readonly RawLog[]): DecodedLog[] {
  const launchTx =
    "0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58";
  return raw.map((log) => {
    const named = decodeLogUnder(questionsAbi, log.topics, log.data);
    if (named === null || Array.isArray(named.args))
      throw new Error("a fixture log is not an event of Questions");
    return {
      contract: "questions",
      event: named.event,
      args: named.args as Record<string, unknown>,
      txHash: log.transactionHash.toLowerCase() as Hex,
      // The fixtures hold logs, not transactions. Their own notes say who sent them: the launch
      // transaction by IdentityMD's launch deployer, the nine others by house wallet H1.
      txFrom:
        log.transactionHash === launchTx
          ? (MAINNET.LAUNCH_DEPLOYER.toLowerCase() as Address)
          : H1,
      blockNumber: Number(BigInt(log.blockNumber)),
      blockTime: Number(BigInt(log.blockTimestamp)),
      logIndex: Number(BigInt(log.logIndex)),
    };
  });
}

const INDEXER_FIXTURE = readJson<{ logs: RawLog[] }>(
  ROOT,
  "apps/indexer/test/fixtures/logs/launch-a-questions.json",
);
const WEB_FIXTURE = readJson<{ logs: RawLog[] }>(
  ROOT,
  "apps/web/test/fixtures/launch-a-questions-logs-26182869-26183622.json",
);

/** What the three contracts answered while only the first ten logs existed (block 26,183,622). */
function launchDayViews(
  over: Record<string, unknown> = {},
): Map<string, unknown> {
  const views = new Map<string, unknown>();
  views.set(viewKey("questions", "INTAKE"), MAINNET.INTAKE);
  views.set(viewKey("questions", "IMD"), MAINNET.IMD);
  views.set(viewKey("questions", "oracleSigner"), MAINNET.ORACLE_SIGNER);
  views.set(viewKey("questions", "feedCount"), 3n);
  for (const name of ["payrolls", "hires", "employers"] as const) {
    const id = HOUSE_FEEDS[name].id.toLowerCase();
    views.set(viewKey("questions", "feedState", [id]), {
      exists: true,
      rounds: 1n,
      pending: true,
      meterBalance: 0n,
    });
    views.set(viewKey("questions", "latest", [id]), [0n, 0n, 0n, 0n, 0n]);
  }
  views.set(viewKey("jobsReport", "QUESTIONS"), ADDRESSES.questions);
  views.set(viewKey("jobsReport", "summary"), {
    prints: 0n,
    total: 0n,
    counts: 0n,
    totalCount: 0n,
    bestAmount: 0n,
    bestIndex: 0n,
    streak: 0n,
    longestStreak: 0n,
    crowns: 0n,
  });
  views.set(viewKey("payroll", "QUESTIONS"), ADDRESSES.questions);
  views.set(viewKey("payroll", "ledger"), {
    received: 0n,
    toStakers: 0n,
    toSeats: 0n,
    toFeeds: 0n,
    dripped: 0n,
    seatClaimed: 0n,
    tipsIn: 0n,
    tipsClaimed: 0n,
    feedsFunded: 0n,
    tipsToSeats: 0n,
    feedsReleased: 0n,
  });
  views.set(viewKey("payroll", "owed"), [0n, 0n, 0n, 0n, 0n]);
  views.set(viewKey("payroll", "unbooked"), 0n);
  for (const [key, value] of Object.entries(over)) views.set(key, value);
  return views;
}

describe("launch A, from the logs mainnet served on the day of the launch", () => {
  it("names the ten logs the indexer's fixture holds as the indexer does", () => {
    // The same list apps/indexer/test/launchA.test.ts expects of its own decoder.
    expect(questionsLogs(INDEXER_FIXTURE.logs).map((log) => log.event)).toEqual(
      [
        "OracleSignerSet",
        "FeedCreated",
        "FeedCreated",
        "FeedCreated",
        "Funded",
        "Funded",
        "Funded",
        "RoundOpened",
        "RoundOpened",
        "RoundOpened",
      ],
    );
  });

  it("reads the web app's fixture of the same blocks as the same ten events", () => {
    const strip = (logs: DecodedLog[]) =>
      logs.map((log) => [log.event, log.txHash, log.logIndex, log.blockNumber]);
    expect(strip(questionsLogs(WEB_FIXTURE.logs))).toEqual(
      strip(questionsLogs(INDEXER_FIXTURE.logs)),
    );
  });

  it("counts three house feeds, each funded with 0.55 IMD and each with one round pending, all HOUSE", () => {
    const logs = attribute(
      questionsLogs(INDEXER_FIXTURE.logs),
      input(["questions", "jobsReport", "payroll"]),
    );
    const { evidence, checks } = foldLaunchA(logs, launchDayViews(), {
      questions: ADDRESSES.questions,
    });
    const q = evidence.questions;

    expect(q.feedsCreated).toEqual({ total: 3, house: 3, outside: 0 });
    expect(q.feeds.map((feed) => feed.feedId)).toEqual([
      HOUSE_FEEDS.payrolls.id.toLowerCase(),
      HOUSE_FEEDS.hires.id.toLowerCase(),
      HOUSE_FEEDS.employers.id.toLowerCase(),
    ]);
    expect(q.feeds.map((feed) => feed.houseFeed)).toEqual([
      "payrolls",
      "hires",
      "employers",
    ]);
    // The creation blocks the indexer's own test expects of the same logs.
    expect(q.feeds.map((feed) => feed.createdBlock)).toEqual([
      26_183_604, 26_183_605, 26_183_608,
    ]);
    for (const feed of q.feeds) {
      expect(feed.creator.toLowerCase()).toBe(H1);
      expect(feed.side).toBe("HOUSE");
      expect(feed.rounds).toEqual({
        opened: 1,
        answeredBySubmit: 0,
        answeredByCallback: 0,
        closed: 0,
        pending: 1,
      });
      expect(feed.latest).toBeNull();
    }
    expect(q.meterFunding).toEqual({
      total: 3,
      house: 3,
      outside: 0,
      imd: {
        totalWei: "1650000000000000000",
        houseWei: "1650000000000000000",
        outsideWei: "0",
      },
    });
    // A zero is written as a zero, with its split.
    expect(q.meterDefunding).toEqual({
      total: 0,
      house: 0,
      outside: 0,
      imd: { totalWei: "0", houseWei: "0", outsideWei: "0" },
    });

    expect(q.roundsOpened).toEqual({ total: 3, house: 3, outside: 0 });
    expect(q.endings).toEqual({
      answeredBySubmit: { total: 0, house: 0, outside: 0 },
      answeredByCallback: { total: 0, house: 0, outside: 0 },
      closedWithoutAnswer: { total: 0, house: 0, outside: 0 },
      pending: { total: 3, house: 3, outside: 0 },
    });
    expect(
      q.rounds.map((round) => [
        round.houseFeed,
        round.round,
        round.request.block,
        round.ending,
      ]),
    ).toEqual([
      ["payrolls", 1, 26_183_619, "pending"],
      ["hires", 1, 26_183_621, "pending"],
      ["employers", 1, 26_183_622, "pending"],
    ]);
    for (const round of q.rounds) {
      expect(round.request.priceWei).toBe((IMD / 2n).toString());
      expect(round.request.tipWei).toBe((IMD / 20n).toString());
      expect(round.opener.toLowerCase()).toBe(H1);
      expect(round.ended).toBeNull();
      expect(round.answer).toBeNull();
    }
    expect(q.paidToIntake).toEqual({
      totalWei: "1500000000000000000",
      houseWei: "1500000000000000000",
      outsideWei: "0",
    });
    // Nothing is earned until a round is answered.
    expect(q.keeperTips.earned).toMatchObject({
      total: 0,
      imd: { totalWei: "0" },
    });

    expect(evidence.jobsReport.prints).toEqual({
      total: 0,
      house: 0,
      outside: 0,
    });
    expect(evidence.jobsReport.printRows).toEqual([]);
    expect(evidence.payroll.ledger.receivedWei).toBe("0");
    expect(checks.length).toBeGreaterThan(15);
    expect(checks.filter((check) => !check.agree)).toEqual([]);
  });

  it("splits by the published list: with H1 taken off it, the same logs are OUTSIDE", () => {
    const withoutH1 = houseList(
      parseHouseFile({
        wallets: [(HOUSE_FILE as { wallets: unknown[] }).wallets[0]],
      }),
      [{ name: "Questions", launch: "a", address: ADDRESSES.questions }],
    );
    const logs = attribute(questionsLogs(INDEXER_FIXTURE.logs), {
      house: withoutH1,
      intake: INTAKE,
      addresses: ADDRESSES,
    });
    const table = eventTable(logs, "questions");
    expect(table.FeedCreated).toMatchObject({ total: 3, house: 0, outside: 3 });
    expect(table.RoundOpened).toMatchObject({ total: 3, house: 0, outside: 3 });
    // The constructor's event is the launch itself: HOUSE whoever is on the list.
    expect(table.OracleSignerSet).toMatchObject({
      total: 1,
      house: 1,
      outside: 0,
    });
    // An event never logged is a row of zeros, not a missing row.
    expect(table.RoundFailed).toMatchObject({ total: 0, house: 0, outside: 0 });
    expect(Object.keys(table)).toHaveLength(14);
  });

  it("does not count the launch transaction as a use of the contracts", () => {
    const logs = attribute(
      questionsLogs(INDEXER_FIXTURE.logs),
      input(["questions"]),
    );
    const all = transactionsBySender(logs, house(["questions"]), []);
    const afterLaunch = transactionsBySender(logs, house(["questions"]), [
      "0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58",
    ]);
    // Ten transactions hold the ten logs; the launch deployer's is not on the house list.
    expect(all).toEqual({ total: 10, house: 9, outside: 1, byIdentityMd: 0 });
    expect(afterLaunch).toEqual({
      total: 9,
      house: 9,
      outside: 0,
      byIdentityMd: 0,
    });
  });

  it("counts a transaction sent by one of IdentityMD's service accounts apart from HOUSE and OUTSIDE", () => {
    const logs = attribute(
      questionsLogs(INDEXER_FIXTURE.logs),
      input(["questions"]),
    );
    const launch =
      "0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58";
    const sender = logs.find((log) => log.txHash !== launch)?.txFrom as string;
    const split = transactionsBySender(
      logs,
      house(["questions"]),
      [launch],
      [sender.toUpperCase().replace("0X", "0x")],
    );
    expect(split.byIdentityMd).toBeGreaterThan(0);
    expect(split.total).toBe(9);
    expect(split.house + split.outside + split.byIdentityMd).toBe(9);
  });

  it("reports a count that disagrees with the contract's own counter", () => {
    const logs = attribute(
      questionsLogs(INDEXER_FIXTURE.logs),
      input(["questions"]),
    );
    const views = launchDayViews({ [viewKey("questions", "feedCount")]: 4n });
    const { checks } = foldLaunchA(logs, views, {
      questions: ADDRESSES.questions,
    });
    expect(checks.filter((check) => !check.agree)).toEqual([
      {
        what: "Questions: feeds created",
        expected: "3",
        expectedFrom: "logs",
        contractSays: "4",
        agree: false,
      },
    ]);
  });

  it("reports a Questions that is built on another Intake or trusts another signer", () => {
    const logs = attribute(
      questionsLogs(INDEXER_FIXTURE.logs),
      input(["questions"]),
    );
    const views = launchDayViews({
      // The legacy Intake: nothing of ours is launched against it.
      [viewKey("questions", "INTAKE")]: MAINNET.INTAKE_V1,
      [viewKey("questions", "oracleSigner")]: OUTSIDER,
    });
    const failed = foldLaunchA(logs, views, {
      questions: ADDRESSES.questions,
    }).checks.filter((check) => !check.agree);
    expect(failed.map((check) => [check.what, check.expectedFrom])).toEqual([
      [
        "Questions is built on IdentityMD's Intake, version 2",
        "IdentityMD's addresses in packages/shared",
      ],
      [
        "Questions accepts answers signed by IdentityMD's oracle signer",
        "IdentityMD's addresses in packages/shared",
      ],
    ]);
  });

  it("reports a contract that is bound to another Questions than the book's", () => {
    const logs = attribute(
      questionsLogs(INDEXER_FIXTURE.logs),
      input(["questions"]),
    );
    const views = launchDayViews({
      [viewKey("payroll", "QUESTIONS")]: OUTSIDER,
    });
    const failed = foldLaunchA(logs, views, {
      questions: ADDRESSES.questions,
    }).checks.filter((check) => !check.agree);
    expect(failed.map((check) => check.what)).toEqual([
      "Payroll is bound to the Questions address in the book",
    ]);
    expect(failed[0]?.expectedFrom).toBe("the deployments book");
  });
});

describe("launch A, rounds that end", () => {
  const FEED = HOUSE_FEEDS.payrolls.id.toLowerCase() as Hex;
  const ORACLE_REQUEST =
    `0xf8ffb99155b74316946144a94d5270aa${"00".repeat(16)}` as Hex;

  function world() {
    const chain = new Chain();
    const feed = (id: Hex, creator: Address) =>
      chain.emit(
        "questions",
        "FeedCreated",
        {
          feedId: id,
          creator,
          params: {
            action: MAINNET.ORACLE_ACTION,
            chainId: 1n,
            answerType: 0,
            panelSize: 3,
            quorum: 2,
            minAgreed: 2,
            validFor: 86_400,
            cadenceBlocks: 7000,
            maxWindowBlocks: 21_000,
            lagBlocks: 12,
            contiguous: true,
            pinHash: true,
            maxPrice: 2n * IMD,
            tip: IMD / 20n,
            gateCmp: 0,
            gateTarget: ZERO_ADDRESS,
            gateThreshold: 0n,
            gateData: "0x",
          },
          qPrefix: "0x7b",
          tail: "0x7d",
        },
        creator,
      );
    const open = (id: Hex, round: bigint, keeper: Address) =>
      chain.emit(
        "questions",
        "RoundOpened",
        {
          feedId: id,
          round,
          intakeRequestId: `0x${round.toString(16).padStart(2, "0")}${id.slice(4)}`,
          fromBlock: 100n,
          toBlock: 200n,
          questionHash: ZERO_WORD,
          blockHash: ZERO_WORD,
          price: IMD / 2n,
          tip: IMD / 20n,
          keeper,
        },
        keeper,
      );
    const answer = (
      id: Hex,
      round: bigint,
      deliveredBy: Address,
      from: Address,
      value: bigint,
    ) =>
      chain.emit(
        "questions",
        "RoundAnswered",
        {
          feedId: id,
          round,
          oracleRequestId: ORACLE_REQUEST,
          value,
          figure: value,
          agreed: 3,
          panelJobId: ZERO_WORD,
          deliveredBy,
        },
        from,
      );
    return { chain, feed, open, answer };
  }

  const viewsFor = (
    feeds: {
      id: Hex;
      rounds: bigint;
      pending: boolean;
      latest: [bigint, bigint];
    }[],
  ) => {
    const views = launchDayViews({
      [viewKey("questions", "feedCount")]: BigInt(feeds.length),
    });
    for (const f of feeds) {
      views.set(viewKey("questions", "feedState", [f.id]), {
        exists: true,
        rounds: f.rounds,
        pending: f.pending,
        meterBalance: 7n,
      });
      views.set(viewKey("questions", "latest", [f.id]), [
        f.latest[1],
        100n,
        200n,
        f.latest[0],
        1_791_900_100n,
      ]);
    }
    return views;
  };

  it("tells the four endings apart and counts each for the round's opener", () => {
    const { chain, feed, open, answer } = world();
    const OTHER = `0x${"77".repeat(32)}` as Hex;
    feed(FEED, H1);
    feed(OTHER, OUTSIDER);
    // Round 1: opened by the house keeper, answered by the Intake's own callback (sent by IdentityMD's writer).
    open(FEED, 1n, H1);
    answer(
      FEED,
      1n,
      INTAKE,
      MAINNET.INTAKE_WRITER.toLowerCase() as Address,
      112n * IMD,
    );
    // Round 2: opened by the house keeper, handed in with submit by an outsider.
    open(FEED, 2n, H1);
    answer(FEED, 2n, STRANGER, STRANGER, 5n * IMD);
    // Round 3: opened by the house keeper, closed without an answer by an outsider.
    open(FEED, 3n, H1);
    chain.emit(
      "questions",
      "RoundFailed",
      {
        feedId: FEED,
        round: 3n,
        intakeRequestId: ZERO_WORD,
        completed: false,
        failStreak: 1,
      },
      STRANGER,
    );
    // Round 4 of the house feed and round 1 of an outsider's own feed: both pending.
    open(FEED, 4n, H1);
    open(OTHER, 1n, OUTSIDER);
    chain.emit(
      "questions",
      "TipsCollected",
      { keeper: H1, amount: IMD / 10n },
      H1,
    );

    const logs = attribute(chain.logs, input());
    const { evidence, checks } = foldLaunchA(
      logs,
      viewsFor([
        { id: FEED, rounds: 4n, pending: true, latest: [2n, 5n * IMD] },
        { id: OTHER, rounds: 1n, pending: true, latest: [0n, 0n] },
      ]),
      { questions: ADDRESSES.questions },
    );
    const q = evidence.questions;
    expect(checks.filter((check) => !check.agree)).toEqual([]);
    expect(q.feedsCreated).toEqual({ total: 2, house: 1, outside: 1 });
    expect(q.roundsOpened).toEqual({ total: 5, house: 4, outside: 1 });
    expect(q.endings).toEqual({
      answeredBySubmit: { total: 1, house: 1, outside: 0 },
      answeredByCallback: { total: 1, house: 1, outside: 0 },
      closedWithoutAnswer: { total: 1, house: 1, outside: 0 },
      pending: { total: 2, house: 1, outside: 1 },
    });
    // The submit itself is counted for who handed it in: an outsider.
    expect(q.submits).toEqual({ total: 1, house: 0, outside: 1 });
    expect(q.rounds.map((round) => round.ending)).toEqual([
      "answered by the Intake's callback",
      "answered by submit",
      "closed without an answer",
      "pending",
      "pending",
    ]);
    // The callback is the protocol's own delivery: neither side.
    expect(q.rounds[0]?.ended).toMatchObject({
      by: MAINNET.INTAKE,
      bySide: null,
    });
    expect(q.rounds[1]?.ended?.bySide).toBe("OUTSIDE");
    expect(q.rounds[2]?.ended?.bySide).toBe("OUTSIDE");
    expect(q.rounds[0]?.answer).toMatchObject({
      value: (112n * IMD).toString(),
      agreed: 3,
      oracleRequestId: "f8ffb991-55b7-4316-9461-44a94d5270aa",
    });
    // Tips go to the opener of an answered round, whoever handed the answer in.
    expect(q.keeperTips.earned).toEqual({
      total: 2,
      house: 2,
      outside: 0,
      imd: {
        totalWei: (IMD / 10n).toString(),
        houseWei: (IMD / 10n).toString(),
        outsideWei: "0",
      },
    });
    expect(q.keeperTips.collected).toMatchObject({
      total: 1,
      house: 1,
      imd: { totalWei: (IMD / 10n).toString() },
    });
    expect(q.feeds[0]).toMatchObject({
      houseFeed: "payrolls",
      meterWei: "7",
      rounds: {
        opened: 4,
        answeredBySubmit: 1,
        answeredByCallback: 1,
        closed: 1,
        pending: 1,
      },
      latest: { round: 2, value: (5n * IMD).toString() },
    });
    expect(q.feeds[1]).toMatchObject({ houseFeed: null, side: "OUTSIDE" });
    // In the raw table the callback's answer is counted for the round's opener.
    expect(eventTable(logs, "questions").RoundAnswered).toMatchObject({
      total: 2,
      house: 1,
      outside: 1,
    });
  });

  it("stops on an answer for a round no log opened: the logs have a hole", () => {
    const { chain, feed, answer } = world();
    feed(FEED, H1);
    answer(
      FEED,
      9n,
      INTAKE,
      MAINNET.INTAKE_WRITER.toLowerCase() as Address,
      1n,
    );
    expect(() => attribute(chain.logs, input())).toThrow(
      /round .*:9, which no earlier log opened. Logs are missing/,
    );
  });

  it("pairs a print with its count and the count's own block window", () => {
    const chain = new Chain();
    const tx = chain.tx();
    chain.emit(
      "jobsReport",
      "Printed",
      {
        index: 0n,
        round: 1n,
        amount: 112n * IMD,
        fromBlock: 26_176_608n,
        toBlock: 26_183_607n,
        total: 112n * IMD,
        streak: 1n,
      },
      H1,
      tx,
    );
    chain.emit(
      "jobsReport",
      "CountRecorded",
      {
        index: 0n,
        round: 1n,
        count: 223n,
        fromBlock: 26_176_610n,
        toBlock: 26_183_609n,
        totalCount: 223n,
      },
      H1,
      tx,
    );
    chain.emit(
      "jobsReport",
      "Counted",
      { index: 0n, round: 1n, count: 223n },
      H1,
      tx,
    );
    chain.emit(
      "jobsReport",
      "BestDay",
      { index: 0n, amount: 112n * IMD },
      H1,
      tx,
    );
    chain.emit(
      "jobsReport",
      "Printed",
      {
        index: 1n,
        round: 2n,
        amount: 80n * IMD,
        fromBlock: 26_183_608n,
        toBlock: 26_190_607n,
        total: 192n * IMD,
        streak: 2n,
      },
      STRANGER,
    );
    const views = launchDayViews({
      [viewKey("questions", "feedCount")]: 0n,
      [viewKey("jobsReport", "summary")]: {
        prints: 2n,
        total: 192n * IMD,
        counts: 1n,
        totalCount: 223n,
        bestAmount: 112n * IMD,
        bestIndex: 0n,
        streak: 2n,
        longestStreak: 2n,
        crowns: 0n,
      },
    });
    const { evidence, checks } = foldLaunchA(
      attribute(chain.logs, input()),
      views,
      {
        questions: ADDRESSES.questions,
      },
    );
    expect(checks.filter((check) => !check.agree)).toEqual([]);
    expect(evidence.jobsReport.prints).toEqual({
      total: 2,
      house: 1,
      outside: 1,
    });
    expect(evidence.jobsReport.printRows[0]).toMatchObject({
      index: 0,
      amountWei: (112n * IMD).toString(),
      fromBlock: 26_176_608,
      toBlock: 26_183_607,
      bestDay: true,
      side: "HOUSE",
      count: {
        count: "223",
        hiresRound: 1,
        fromBlock: 26_176_610,
        toBlock: 26_183_609,
      },
    });
    // The second print has no count yet: that is said, not filled in with a zero.
    expect(evidence.jobsReport.printRows[1]).toMatchObject({
      index: 1,
      bestDay: false,
      side: "OUTSIDE",
      count: null,
    });
  });
});

describe("launch B, counted against the ABIs before it is launched", () => {
  const DESK = ADDRESSES.workOrders;

  function world() {
    const chain = new Chain();
    const open = (
      id: bigint,
      employer: Address,
      from: Address,
      params: Record<string, unknown> = {},
      tx?: Hex,
    ) =>
      chain.emit(
        "workOrders",
        "OrderOpened",
        {
          id,
          employer,
          kindHash: `0x${"11".repeat(32)}`,
          specHash: ZERO_WORD,
          params: orderParams(params),
          spec: "0x41",
        },
        from,
        tx,
      );
    const claim = (id: bigint, runner: Address) =>
      chain.emit(
        "workOrders",
        "Claimed",
        { id, runner, seq: 1n, price: IMD, bond: IMD / 4n, ticket: ZERO_WORD },
        runner,
      );
    const register = (id: bigint, runner: Address) =>
      chain.emit("workOrders", "Registered", { id, jobId: JOB }, runner);
    const deliver = (
      id: bigint,
      runner: Address,
      proven: boolean,
      from: Address,
      tx?: Hex,
    ) =>
      chain.emit(
        "workOrders",
        "Delivered",
        {
          id,
          jobId: JOB,
          runner,
          recordHash: RECORD,
          proven,
          runnerPay: (IMD * 9n) / 10n,
          fee: IMD / 20n,
          tip: IMD / 20n,
          toEmployer: IMD,
          bonds: 0n,
          agentIds: [52211n],
        },
        from,
        tx,
      );
    return { chain, open, claim, register, deliver };
  }

  const views = (over: Record<string, unknown> = {}) => {
    const map = new Map<string, unknown>([
      [viewKey("workProof", "WORK_REGISTRY"), MAINNET.WORK_REGISTRY],
      [viewKey("workOrders", "orderCount"), 6n],
      [viewKey("workOrders", "WORK_PROOF"), ADDRESSES.workProof],
      [viewKey("workOrders", "PAYROLL"), ADDRESSES.payroll],
      [viewKey("crowdPots", "WORK_ORDERS"), DESK],
      [viewKey("crowdPots", "potCount"), 2n],
      [viewKey("doorbell", "WORK_ORDERS"), DESK],
      [viewKey("doorbell", "rings"), 26n],
      [viewKey("doorbell", "hires"), 1n],
      [viewKey("doorbell", "receipts"), 0n],
      [viewKey("doorbell", "funded"), false],
      [viewKey("doorbell", "ALLOW_CLAIMED"), true],
    ]);
    for (const [key, value] of Object.entries(over)) map.set(key, value);
    return map;
  };
  const book = {
    workProof: ADDRESSES.workProof,
    workOrders: DESK,
    crowdPots: ADDRESSES.crowdPots,
    doorbell: ADDRESSES.doorbell,
    payroll: ADDRESSES.payroll,
    rules: ADDRESSES.rules,
  };

  function day() {
    const { chain, open, claim, register, deliver } = world();
    // 1: an outside employer; an outside runner; settled against a receipt by the house keeper.
    open(1n, OUTSIDER, OUTSIDER);
    claim(1n, RUNNER);
    register(1n, RUNNER);
    const settle = chain.tx();
    chain.emit(
      "payroll",
      "Paid",
      { from: DESK, memo: `0x${"00".repeat(31)}01`, amount: IMD / 20n },
      H1,
      settle,
    );
    chain.emit(
      "payroll",
      "Booked",
      {
        amount: IMD / 20n,
        toStakers: IMD / 40n,
        toSeats: (IMD * 3n) / 200n,
        toFeeds: IMD / 100n,
      },
      H1,
      settle,
    );
    chain.emit(
      "payroll",
      "Tipped",
      {
        from: DESK,
        amount: IMD / 20n,
        perAgent: IMD / 20n,
        toSeatPool: 0n,
        agentIds: [52211n],
      },
      H1,
      settle,
    );
    deliver(1n, RUNNER, true, H1, settle);
    // 2: a house employer that allows the claimed path; paid on a claim; proven when the receipt lands.
    open(2n, W1, W1, { flags: ORDER_FLAG.ALLOW_CLAIMED });
    claim(2n, H1);
    register(2n, H1);
    chain.emit(
      "workOrders",
      "DeliveryClaimed",
      {
        id: 2n,
        jobId: JOB,
        recordHash: RECORD,
        challengeUntil: 1_792_000_000n,
      },
      H1,
    );
    deliver(2n, H1, false, STRANGER);
    chain.emit(
      "workOrders",
      "Proven",
      { id: 2n, jobId: JOB, recordHash: RECORD },
      STRANGER,
    );
    // 3: the employer is a contract nobody lists, and a house wallet sent the transaction: HOUSE.
    open(3n, STRANGER, W1);
    chain.emit(
      "workOrders",
      "Refunded",
      { id: 3n, toEmployer: 2n * IMD },
      RUNNER,
    );
    // 4: an outside employer; the runner gives the order back; cancelled.
    open(4n, OUTSIDER, OUTSIDER);
    claim(4n, RUNNER);
    chain.emit(
      "workOrders",
      "ClaimEnded",
      {
        id: 4n,
        runner: RUNNER,
        reason: CLAIM_END.Released,
        toRunner: 1n,
        toEmployer: 1n,
        toChallenger: 0n,
        next: ORDER_STATE.Open,
      },
      RUNNER,
    );
    chain.emit(
      "workOrders",
      "Cancelled",
      { id: 4n, toEmployer: 2n * IMD },
      OUTSIDER,
    );
    // A pot: opened and filled by outsiders and the house, launched by the house keeper. Order 5.
    chain.emit(
      "crowdPots",
      "PotOpened",
      {
        potId: 1n,
        opener: OUTSIDER,
        seriesId: 0n,
        specHash: ZERO_WORD,
        deadline: 1_792_000_000,
        terms: {
          kind: "research",
          target: 2n * IMD,
          minPay: IMD,
          rampSecs: 3600,
          bond: IMD / 4n,
          deliverySecs: 259_200,
          hireSecs: 86_400,
          fundSecs: 86_400,
          allowClaimed: true,
        },
      },
      OUTSIDER,
    );
    chain.emit(
      "crowdPots",
      "SeriesOpened",
      {
        seriesId: 2n,
        opener: W1,
        specHash: ZERO_WORD,
        terms: {
          kind: "research",
          target: 2n * IMD,
          minPay: IMD,
          rampSecs: 3600,
          bond: IMD / 4n,
          deliverySecs: 259_200,
          hireSecs: 86_400,
          fundSecs: 86_400,
          allowClaimed: false,
        },
      },
      W1,
    );
    chain.emit(
      "crowdPots",
      "ChippedIn",
      {
        potId: 1n,
        beneficiary: OUTSIDER,
        payer: OUTSIDER,
        amount: IMD,
        raised: IMD,
      },
      OUTSIDER,
    );
    chain.emit(
      "crowdPots",
      "ChippedIn",
      {
        potId: 1n,
        beneficiary: STRANGER,
        payer: W1,
        amount: IMD,
        raised: 2n * IMD,
      },
      W1,
    );
    const launch = chain.tx();
    open(5n, ADDRESSES.crowdPots, H1, {}, launch);
    chain.emit(
      "crowdPots",
      "PotLaunched",
      {
        potId: 1n,
        orderId: 5n,
        launcher: H1,
        amount: 2n * IMD,
        orderExpiresAt: 1_792_000_000,
      },
      H1,
      launch,
    );
    // The Doorbell: 26 rings by an outsider, the 25th hires. Order 6.
    for (let ring = 1n; ring <= 26n; ring++) {
      const tx = chain.tx();
      chain.emit(
        "doorbell",
        "Rang",
        { ringer: OUTSIDER, count: ring },
        OUTSIDER,
        tx,
      );
      if (ring === 25n) {
        open(
          6n,
          ADDRESSES.doorbell,
          OUTSIDER,
          { flags: ORDER_FLAG.ALLOW_CLAIMED },
          tx,
        );
        chain.emit(
          "doorbell",
          "Hired",
          {
            orderId: 6n,
            ringer: OUTSIDER,
            count: 25n,
            escrow: IMD,
            expiresAt: 1_792_000_000,
          },
          OUTSIDER,
          tx,
        );
      }
    }
    return chain;
  }

  it("counts orders by their employer, whoever settles them", () => {
    const logs = attribute(day().logs, input());
    const { evidence, checks } = foldLaunchB(logs, views(), book);
    const w = evidence.workOrders;
    expect(checks.filter((check) => !check.agree)).toEqual([]);
    expect(checks).toHaveLength(10);

    // Orders 1 and 4 are an outsider's. Orders 2 and 3 are the house's (3 by the sender of its
    // transaction). Orders 5 and 6 were opened by our own employer contracts.
    expect(w.ordersOpened).toMatchObject({ total: 6, house: 4, outside: 2 });
    expect(w.ordersOpened.imd?.totalWei).toBe((12n * IMD).toString());
    expect(w.openedByOurEmployers).toEqual({
      doorbell: 1,
      crowdPots: 1,
      rules: 0,
    });
    // The house keeper sent the settlement of order 1. It stays the outsider's order.
    expect(w.settledProven).toMatchObject({
      total: 1,
      house: 0,
      outside: 1,
      imd: { totalWei: IMD.toString() },
    });
    expect(w.paidOnAClaim).toMatchObject({ total: 1, house: 1, outside: 0 });
    expect(w.provenLater).toEqual({ total: 1, house: 1, outside: 0 });
    expect(w.refunded).toMatchObject({
      total: 1,
      house: 1,
      outside: 0,
      imd: { totalWei: (2n * IMD).toString() },
    });
    expect(w.cancelled).toMatchObject({ total: 1, house: 0, outside: 1 });
    expect(w.claimsTaken).toEqual({ total: 3, house: 1, outside: 2 });
    expect(w.jobsRegistered).toEqual({ total: 2, house: 1, outside: 1 });
    expect(w.deliveryClaims).toEqual({ total: 1, house: 1, outside: 0 });
    expect(w.claimsEnded).toEqual({ total: 1, house: 0, outside: 1 });
    expect(w.challenges).toEqual({ total: 0, house: 0, outside: 0 });
    expect(w.feesWei).toBe((IMD / 10n).toString());
    expect(
      w.orders.map((order) => [
        order.id,
        order.side,
        order.openedBy,
        order.outcome,
      ]),
    ).toEqual([
      ["1", "OUTSIDE", null, "settled, proven by a receipt"],
      ["2", "HOUSE", null, "paid on a claim, proven later"],
      ["3", "HOUSE", null, "refunded"],
      ["4", "OUTSIDE", null, "cancelled"],
      ["5", "HOUSE", "CrowdPots", "open"],
      ["6", "HOUSE", "Doorbell", "open"],
    ]);
    expect(w.orders[0]).toMatchObject({
      jobId: "e9efec16-56f3-40d3-9243-52c453effc7d",
      allowsClaimedPath: false,
    });
    expect(w.orders[1]?.allowsClaimedPath).toBe(true);
    // Order 4 was given back, so it holds no runner any more.
    expect(w.orders[3]?.runner).toBeNull();

    expect(evidence.crowdPots).toMatchObject({
      potsOpened: { total: 1, house: 0, outside: 1 },
      seriesOpened: { total: 1, house: 1, outside: 0 },
      chips: {
        total: 2,
        house: 1,
        outside: 1,
        imd: { houseWei: IMD.toString(), outsideWei: IMD.toString() },
      },
      potsLaunched: { total: 1, house: 1, outside: 0 },
    });
    expect(evidence.doorbell).toMatchObject({
      rings: { total: 26, house: 0, outside: 26 },
      hires: {
        total: 1,
        house: 0,
        outside: 1,
        imd: { outsideWei: IMD.toString() },
      },
      deliveries: { total: 0, house: 0, outside: 0 },
      funded: false,
      allowsClaimedPath: true,
    });
  });

  it("counts the fee and the tip the desk pays into Payroll for the order's employer", () => {
    const table = eventTable(attribute(day().logs, input()), "payroll");
    // Both were paid by the desk in a transaction the house keeper sent, for an outsider's order.
    expect(table.Paid).toMatchObject({ total: 1, house: 0, outside: 1 });
    expect(table.Tipped).toMatchObject({ total: 1, house: 0, outside: 1 });
    // The booking names nobody: it is counted for who sent it.
    expect(table.Booked).toMatchObject({ total: 1, house: 1, outside: 0 });
  });

  it("holds its counts against the contracts' own counters", () => {
    const logs = attribute(day().logs, input());
    const failed = foldLaunchB(
      logs,
      views({
        [viewKey("workOrders", "orderCount")]: 7n,
        [viewKey("doorbell", "rings")]: 25n,
      }),
      book,
    ).checks.filter((check) => !check.agree);
    expect(
      failed.map((check) => [check.what, check.expected, check.contractSays]),
    ).toEqual([
      ["WorkOrders: orders opened", "6", "7"],
      ["Doorbell: rings", "26", "25"],
    ]);
    // A pot and a series share one counter in the contract.
    const pots = foldLaunchB(logs, views(), book).checks.find((check) =>
      check.what.startsWith("CrowdPots: pots"),
    );
    expect(pots).toMatchObject({
      expected: "2",
      contractSays: "2",
      agree: true,
    });
  });

  it("stops on a settlement of an order no log opened", () => {
    const { chain, deliver } = world();
    deliver(9n, RUNNER, true, H1);
    expect(() => attribute(chain.logs, input())).toThrow(
      /order 9, which no earlier log opened/,
    );
  });

  it("stops on an event that has no counting rule", () => {
    const { chain, open } = world();
    const log = open(1n, OUTSIDER, OUTSIDER);
    expect(() =>
      attribute([{ ...log, event: "OrderRenamed" }], input()),
    ).toThrow(/workOrders.OrderRenamed has no counting rule/);
    expect(chain.logs).toHaveLength(1);
  });

  it("stops when an argument is not what the rule expects", () => {
    const { open } = world();
    const log = open(1n, OUTSIDER, OUTSIDER);
    expect(() =>
      attribute([{ ...log, args: { ...log.args, employer: 5n } }], input()),
    ).toThrow(
      /workOrders.OrderOpened: argument "employer" is missing or is not an address/,
    );
  });
});

describe("launch C, counted against the ABIs before it is launched", () => {
  it("counts a fire for the rule's creator and, separately, for who called it", () => {
    const chain = new Chain();
    const rule = (id: bigint, creator: Address) =>
      chain.emit(
        "rules",
        "RuleCreated",
        {
          id,
          creator,
          params: {
            when: {
              kind: 0,
              cmp: 1,
              maxAge: 0,
              target: ZERO_ADDRESS,
              threshold: 0n,
              feedId: ZERO_WORD,
              data: "0x",
            },
            action: 0,
            hire: {
              kindHash: ZERO_WORD,
              minPay: IMD,
              maxPay: 2n * IMD,
              rampSecs: 0,
              deliverySecs: 259_200,
              bond: IMD / 4n,
              runnerOnly: ZERO_ADDRESS,
              arbiter: ZERO_ADDRESS,
              flags: 0,
              orderTtl: 86_400,
            },
            pay: { recipient: ZERO_ADDRESS, amount: 0n },
            tip: IMD / 100n,
            cooldown: 3600,
            maxFires: 3,
          },
          spec: "0x41",
          deposit: 3n * IMD,
        },
        creator,
      );
    rule(1n, OUTSIDER);
    rule(2n, W1);
    // The house keeper fires the outsider's rule (a hire: it opens order 7) and the house rule (a payment).
    chain.emit(
      "rules",
      "Fired",
      {
        id: 1n,
        caller: H1,
        fireNumber: 1,
        value: 5n,
        round: 0n,
        orderId: 7n,
        spent: 2n * IMD,
        tip: IMD / 100n,
      },
      H1,
    );
    chain.emit(
      "rules",
      "Fired",
      {
        id: 2n,
        caller: H1,
        fireNumber: 1,
        value: 5n,
        round: 0n,
        orderId: 0n,
        spent: IMD,
        tip: IMD / 100n,
      },
      H1,
    );
    chain.emit(
      "rules",
      "ToppedUp",
      { id: 1n, from: OUTSIDER, amount: IMD },
      OUTSIDER,
    );
    chain.emit(
      "endowments",
      "Created",
      {
        id: 1n,
        kind: 1,
        target: ZERO_WORD,
        beneficiary: OUTSIDER,
        creator: OUTSIDER,
      },
      OUTSIDER,
    );
    chain.emit(
      "endowments",
      "Deposited",
      { id: 1n, depositor: OUTSIDER, amount: 10n * IMD },
      OUTSIDER,
    );
    chain.emit(
      "endowments",
      "Staked",
      { epoch: 1n, assets: 10n * IMD, shares: 10n },
      H1,
    );
    chain.emit(
      "endowments",
      "Harvested",
      { id: 1n, caller: H1, shares: 1n, assets: IMD / 10n },
      H1,
    );
    chain.emit(
      "zap",
      "Bought",
      { caller: STRANGER, ethSpent: 10n ** 15n, imdOut: IMD },
      STRANGER,
    );

    const views = new Map<string, unknown>([
      [viewKey("rules", "ruleCount"), 2n],
      [viewKey("rules", "totalEscrowed"), 4n * IMD],
      [viewKey("rules", "WORK_ORDERS"), ADDRESSES.workOrders],
      [viewKey("endowments", "endowmentCount"), 1n],
      [viewKey("endowments", "pendingTotal"), 0n],
      [viewKey("endowments", "QUESTIONS"), ADDRESSES.questions],
      [viewKey("endowments", "CROWD_POTS"), ADDRESSES.crowdPots],
      [viewKey("zap", "QUESTIONS"), ADDRESSES.questions],
      [viewKey("zap", "CROWD_POTS"), ADDRESSES.crowdPots],
    ]);
    const { evidence, checks } = foldLaunchC(
      attribute(chain.logs, input()),
      views,
      {
        questions: ADDRESSES.questions,
        workOrders: ADDRESSES.workOrders,
        crowdPots: ADDRESSES.crowdPots,
      },
      house(),
    );
    expect(checks.filter((check) => !check.agree)).toEqual([]);
    expect(checks).toHaveLength(7);
    expect(evidence.rules).toMatchObject({
      created: {
        total: 2,
        house: 1,
        outside: 1,
        imd: { totalWei: (6n * IMD).toString() },
      },
      fired: { total: 2, house: 1, outside: 1 },
      firedByCaller: { total: 2, house: 2, outside: 0 },
      hires: { total: 1, house: 0, outside: 1 },
      pays: { total: 1, house: 1, outside: 0 },
      toppedUp: { total: 1, house: 0, outside: 1 },
      cancelled: { total: 0, house: 0, outside: 0 },
      totalEscrowedWei: (4n * IMD).toString(),
    });
    expect(evidence.endowments).toMatchObject({
      created: { total: 1, house: 0, outside: 1 },
      deposits: {
        total: 1,
        outside: 1,
        imd: { outsideWei: (10n * IMD).toString() },
      },
      harvests: { total: 1, house: 1, outside: 0 },
      stakes: { total: 1, house: 1, outside: 0 },
    });
    expect(evidence.zap.bought).toMatchObject({
      total: 1,
      house: 0,
      outside: 1,
      imd: { outsideWei: IMD.toString() },
    });
  });
});
