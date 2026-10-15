/**
 * Launch A's three modules. Its contracts are on mainnet, so their events are final and each
 * module folds them with the ABI the shared package generates from the launch project.
 *
 * Two kinds of log are played. The real ones: every log of the Questions contract from its launch
 * block to the first three requests, recorded from mainnet on the day (see `fixtures/README.md`).
 * And made-up ones, encoded with the same generated ABIs, for what had not happened on chain yet:
 * an answer, a failed round, a print, a fee.
 *
 * What is launched is injected: the configuration is built from a test book with launch A only,
 * or with the recorded address in launch A's place. No test reads the real book to learn it.
 */
import { asc, eq } from "drizzle-orm";
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  numberToHex,
  toHex,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  HOUSE_FEEDS,
  jobsReportAbi,
  payrollAbi,
  questionsAbi,
  type DeploymentBook,
} from "@help-wanted/shared";
import { loadConfig } from "../src/config.js";
import type { Database } from "../src/db/client.js";
import { events, feeds, payrollMovements, prints, rounds } from "../src/db/schema.js";
import { Indexer } from "../src/engine/indexer.js";
import { ALL_MODULES, OWN_MODULES } from "../src/modules/index.js";
import { createQueries } from "../src/queries.js";
import { BOOKS, TEST_LAUNCH } from "./helpers/books.js";
import { countRows, emptyDatabase, openTestDatabase } from "./helpers/db.js";
import { FakeNode, loadLogFixture, type RawLog } from "./helpers/fakeNode.js";

const IMD = 10n ** 18n;
const H1 = "0x60ccc928eb8eee1d64ca0164565bfa9858669560";
const OTHER = "0x4444444444444444444444444444444444444444";
const ZERO32 = `0x${"0".repeat(64)}` as Hex;

let database: Database;

beforeAll(async () => {
  database = await openTestDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await emptyDatabase(database);
});

/** The indexer as a start-up builds it: modules and start blocks from the configuration of a book. */
function indexerFor(node: FakeNode, book: DeploymentBook, modules = OWN_MODULES) {
  const config = loadConfig({ HOUSE_WALLETS_FILE: "" }, book);
  return {
    config,
    indexer: new Indexer({
      db: database.db,
      client: node.client(),
      modules,
      deployments: config.deployments,
      sync: { ...config.sync, confirmations: 0, pollIntervalMs: 1000 },
      now: () => 1_760_000_000_000,
    }),
  };
}

/** A log of one of our contracts, encoded from its generated ABI. */
function eventLog(
  node: FakeNode,
  abi: Abi,
  address: string,
  eventName: string,
  args: Record<string, unknown>,
  at: { block: number; index?: number },
): RawLog {
  const event = abi.find((item): item is AbiEvent => item.type === "event" && item.name === eventName);
  if (!event) throw new Error(`no event ${eventName}`);
  const indexed = Object.fromEntries(
    event.inputs.filter((input) => input.indexed).map((input) => [input.name, args[input.name ?? ""]]),
  );
  const rest = event.inputs.filter((input) => !input.indexed);
  const log: RawLog = {
    address: address.toLowerCase(),
    topics: encodeEventTopics({ abi: [event], eventName, args: indexed } as never) as string[],
    data: encodeAbiParameters(
      rest,
      rest.map((input) => args[input.name ?? ""]),
    ),
    blockNumber: numberToHex(at.block),
    blockHash: node.hashOf(at.block),
    blockTimestamp: numberToHex(node.timeOf(at.block)),
    transactionHash: keccak256(toHex(`launch-a-test:${at.block}:${at.index ?? 0}`)),
    transactionIndex: "0x0",
    logIndex: numberToHex(at.index ?? 0),
    removed: false,
  };
  node.addLog(log);
  return log;
}

describe("Questions, from the logs mainnet served on the day of the launch", () => {
  const fixture = loadLogFixture("launch-a-questions");
  /** Launch A with the recorded contract in the place of Questions, launched in the recorded block. */
  const book: DeploymentBook = {
    ...BOOKS.aOnly,
    a: {
      ...BOOKS.aOnly.a,
      block: fixture.from,
      contracts: { ...BOOKS.aOnly.a.contracts, questions: fixture.address as Address },
    },
  };

  it("starts at the launch block and stores all ten logs, decoded with the generated ABI", async () => {
    const node = new FakeNode().load(fixture);
    const { indexer, config } = indexerFor(node, book);
    expect(config.sync.startBlocks.questions).toEqual({ kind: "absolute", block: 26_182_869 });
    const report = await indexer.tick();
    expect(report.failed).toEqual([]);
    expect(report.synced.find((entry) => entry.module === "questions")).toMatchObject({
      fromBlock: 26_182_869,
      toBlock: 26_183_622,
      logs: 10,
      unfolded: 0,
    });
    const stored = await database.db
      .select()
      .from(events)
      .where(eq(events.module, "questions"))
      .orderBy(asc(events.blockNumber), asc(events.logIndex));
    expect(stored.map((event) => event.event)).toEqual([
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
    ]);
    expect(stored.every((event) => event.foldError === null && event.args !== null)).toBe(true);
    expect(new Set(stored.map((event) => event.address))).toEqual(new Set([fixture.address.toLowerCase()]));
    // The other two contracts of the launch are indexed too, from the same block, and are silent.
    expect(report.synced.map((entry) => [entry.module, entry.logs]).sort()).toEqual([
      ["jobs_report", 0],
      ["payroll", 0],
      ["questions", 10],
    ]);
  });

  it("folds them into the three house feeds, each funded with 0.55 IMD and one round pending", async () => {
    const node = new FakeNode().load(fixture);
    await indexerFor(node, book).indexer.tick();

    const feedRows = await database.db.select().from(feeds).orderBy(asc(feeds.createdBlock));
    // The feeds created on chain are the three house feeds of the shared package, in Payroll's order.
    expect(feedRows.map((feed) => feed.feedId)).toEqual([
      HOUSE_FEEDS.payrolls.id,
      HOUSE_FEEDS.hires.id,
      HOUSE_FEEDS.employers.id,
    ]);
    for (const feed of feedRows) {
      expect(feed).toMatchObject({
        creator: H1,
        rounds: 1,
        latestRound: null,
        latestValue: null,
        funded: 550_000_000_000_000_000n,
        defunded: 0n,
        // The first request took the Intake's price and set the keeper tip aside: 0.5 + 0.05 IMD.
        spent: 550_000_000_000_000_000n,
      });
      expect((feed.params as { tip: string; maxPrice: string }).tip).toBe("50000000000000000");
    }
    expect(feedRows.map((feed) => feed.createdBlock)).toEqual([26_183_604, 26_183_605, 26_183_608]);
    expect(feedRows[0]?.questionPrefix).toBe(HOUSE_FEEDS.payrolls.qPrefix.toLowerCase());
    expect(feedRows[0]?.questionTail).toBe(HOUSE_FEEDS.payrolls.tail.toLowerCase());

    const roundRows = await database.db.select().from(rounds).orderBy(asc(rounds.openedBlock));
    expect(roundRows).toHaveLength(3);
    for (const round of roundRows) {
      expect(round).toMatchObject({
        round: 1,
        status: "Pending",
        keeper: H1,
        price: IMD / 2n,
        tip: IMD / 20n,
        value: null,
        deliveredBy: null,
        closedBlock: null,
      });
      // A first window of a daily feed is one cadence long; the weekly feed's is a week of blocks.
      expect(round.toBlock - round.fromBlock + 1).toBeGreaterThanOrEqual(7_000);
    }
    expect(roundRows.map((round) => round.openedBlock)).toEqual([26_183_619, 26_183_621, 26_183_622]);
    // Nothing has printed and nothing has been paid in: both tables are empty because that is so.
    expect(await countRows(database, prints)).toBe(0);
    expect(await countRows(database, payrollMovements)).toBe(0);
    const q = createQueries(database.db, { house: new Set([H1]), modules: ALL_MODULES });
    expect(await q.source("questions")).toMatchObject({
      module: "questions",
      handler: "ready",
      fromBlock: 26_182_869,
      throughBlock: 26_183_622,
      unfolded: 0,
    });
    expect(await q.source("jobs_report")).toMatchObject({ handler: "ready", throughBlock: 26_183_622 });
  });

  it("gives the same tables when the stored events are folded again", async () => {
    const node = new FakeNode().load(fixture);
    const { indexer } = indexerFor(node, book);
    await indexer.tick();
    const before = await database.db.select().from(feeds).orderBy(asc(feeds.feedId));
    await indexer.reproject(["questions"]);
    expect(await database.db.select().from(feeds).orderBy(asc(feeds.feedId))).toEqual(before);
    expect(await countRows(database, rounds)).toBe(3);
  });
});

describe("launch A's events that had not happened on chain yet, encoded with the generated ABIs", () => {
  const Q = BOOKS.aOnly.a.contracts.questions as Address;
  const J = BOOKS.aOnly.a.contracts.jobsReport as Address;
  const P = BOOKS.aOnly.a.contracts.payroll as Address;
  const START = TEST_LAUNCH.a.block;
  const PAYROLLS = HOUSE_FEEDS.payrolls.id;

  function launched() {
    const node = new FakeNode();
    node.head = START;
    return node;
  }

  it("an answer credits nobody in the table but the round's opener; a failed round returns its tip", async () => {
    const node = launched();
    const q = (name: string, args: Record<string, unknown>, block: number, index = 0) =>
      eventLog(node, questionsAbi, Q, name, args, { block, index });
    q(
      "FeedCreated",
      {
        feedId: PAYROLLS,
        creator: H1,
        params: HOUSE_FEEDS.payrolls.params,
        qPrefix: HOUSE_FEEDS.payrolls.qPrefix,
        tail: HOUSE_FEEDS.payrolls.tail,
      },
      START + 1,
    );
    q("Funded", { feedId: PAYROLLS, funder: H1, amount: 2n * IMD, shares: 2n * IMD }, START + 2);
    q("FundedFor", { feedId: PAYROLLS, payer: OTHER, beneficiary: H1, amount: IMD, shares: IMD }, START + 3);
    const open = (round: number, keeper: string, block: number) =>
      q(
        "RoundOpened",
        {
          feedId: PAYROLLS,
          round: BigInt(round),
          intakeRequestId: `0x${"7".repeat(63)}${round}`,
          fromBlock: BigInt(block - 7_205),
          toBlock: BigInt(block - 6),
          questionHash: `0x${"8".repeat(64)}`,
          blockHash: `0x${"9".repeat(64)}`,
          price: IMD / 2n,
          tip: IMD / 20n,
          keeper,
        },
        block,
      );
    open(1, H1, START + 10);
    // Round 1 is answered through `submit`, by somebody who is not the keeper that opened it.
    q(
      "RoundAnswered",
      {
        feedId: PAYROLLS,
        round: 1n,
        oracleRequestId: `0x${"ab".repeat(16)}${"00".repeat(16)}`,
        value: 114n * IMD,
        figure: 114n * IMD,
        agreed: 5,
        panelJobId: ZERO32,
        deliveredBy: OTHER,
      },
      START + 200,
    );
    open(2, H1, START + 7_300);
    q(
      "CompletionSeen",
      { feedId: PAYROLLS, round: 2n, intakeRequestId: `0x${"7".repeat(63)}2`, closableAt: 1_800_000_000n },
      START + 7_400,
    );
    q(
      "RoundFailed",
      {
        feedId: PAYROLLS,
        round: 2n,
        intakeRequestId: `0x${"7".repeat(63)}2`,
        completed: true,
        failStreak: 1,
      },
      START + 7_600,
    );
    q("Defunded", { feedId: PAYROLLS, funder: H1, shares: IMD, amount: IMD }, START + 7_700);
    q("TipsCollected", { keeper: H1, amount: IMD / 20n }, START + 7_701);

    const { indexer } = indexerFor(node, BOOKS.aOnly);
    const report = await indexer.tick();
    expect(report.failed).toEqual([]);
    expect(report.synced.find((entry) => entry.module === "questions")).toMatchObject({
      logs: 10,
      unfolded: 0,
    });

    const [feed] = await database.db.select().from(feeds);
    expect(feed).toMatchObject({
      feedId: PAYROLLS,
      rounds: 2,
      latestRound: 1,
      latestValue: 114n * IMD,
      funded: 3n * IMD,
      defunded: IMD,
      // Two prices and one tip: the failed round's tip went back onto the meter.
      spent: IMD + IMD / 20n,
    });
    const [first, second] = await database.db.select().from(rounds).orderBy(asc(rounds.round));
    // The answer was handed in by another account. The round still names its opener as the keeper,
    // and as launched the tip is the opener's: `delivered_by` is who delivered, not who was paid.
    expect(first).toMatchObject({
      status: "Answered",
      keeper: H1,
      deliveredBy: OTHER,
      value: 114n * IMD,
      agreed: 5,
    });
    expect(first?.closedBlock).toBe(START + 200);
    expect(second).toMatchObject({ status: "Failed", keeper: H1, value: null, closedBlock: START + 7_600 });
  });

  it("the Jobs Report's prints, with the count attached later and the best day marked", async () => {
    const node = launched();
    const j = (name: string, args: Record<string, unknown>, block: number, index = 0) =>
      eventLog(node, jobsReportAbi, J, name, args, { block, index });
    j(
      "Printed",
      {
        index: 0n,
        round: 1n,
        amount: 114n * IMD,
        fromBlock: 26_140_000n,
        toBlock: 26_147_199n,
        total: 114n * IMD,
        streak: 1n,
      },
      START + 300,
    );
    j("BestDay", { index: 0n, amount: 114n * IMD }, START + 300, 1);
    j(
      "CountRecorded",
      { index: 0n, round: 1n, count: 228n, fromBlock: 26_140_000n, toBlock: 26_147_199n, totalCount: 228n },
      START + 301,
    );
    j("Counted", { index: 0n, round: 1n, count: 228n }, START + 301, 1);
    j(
      "Printed",
      {
        index: 1n,
        round: 2n,
        amount: 90n * IMD,
        fromBlock: 26_147_200n,
        toBlock: 26_154_399n,
        total: 204n * IMD,
        streak: 2n,
      },
      START + 7_500,
    );
    j("RoundSkipped", { feedId: HOUSE_FEEDS.hires.id, round: 2n, reason: 1 }, START + 7_501);

    const { indexer } = indexerFor(node, BOOKS.aOnly);
    const report = await indexer.tick();
    expect(report.synced.find((entry) => entry.module === "jobs_report")).toMatchObject({
      logs: 6,
      unfolded: 0,
    });
    const rows = await database.db.select().from(prints).orderBy(asc(prints.index));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      index: 0,
      round: 1,
      amount: 114n * IMD,
      fromBlock: 26_140_000,
      toBlock: 26_147_199,
      total: 114n * IMD,
      streak: 1,
      count: 228n,
      countRound: 1,
      bestDay: true,
      printedBlock: START + 300,
    });
    expect(rows[1]).toMatchObject({ index: 1, amount: 90n * IMD, streak: 2, count: null, bestDay: false });
  });

  it("Payroll's ledger: one row for each movement of IMD, and none for an event that moves none", async () => {
    const node = launched();
    const p = (name: string, args: Record<string, unknown>, block: number, index = 0) =>
      eventLog(node, payrollAbi, P, name, args, { block, index });
    p("Paid", { from: OTHER, memo: `0x${"11".repeat(32)}`, amount: 10n * IMD }, START + 5);
    p(
      "Booked",
      { amount: 10n * IMD, toStakers: 5n * IMD, toSeats: 3n * IMD, toFeeds: 2n * IMD },
      START + 5,
      1,
    );
    p(
      "StreamLevelled",
      { outstanding: 5n * IMD, unvested: 5n * IMD, endsAt: 1_800_000_000n, dripCap: IMD },
      START + 5,
      2,
    );
    p(
      "Tipped",
      { from: OTHER, amount: IMD, perAgent: IMD / 2n, toSeatPool: 0n, agentIds: [52_211n, 52_372n] },
      START + 6,
    );
    p("Dripped", { caller: H1, amount: IMD / 10n, outstanding: 49n * (IMD / 10n) }, START + 60);
    p("SeatClaimed", { tokenId: 1998n, owner: OTHER, amount: IMD / 1000n }, START + 61);
    p("TipClaimed", { agentId: 52_211n, tokenId: 1998n, owner: OTHER, amount: IMD / 2n }, START + 62);
    p("TipSwept", { agentId: 52_372n, amount: IMD / 2n }, START + 63);
    p("FeedFunded", { feedId: PAYROLLS, amount: IMD }, START + 64);
    p("FeedFundingFailed", { feedId: HOUSE_FEEDS.hires.id, amount: IMD }, START + 64, 1);
    p("FeedBudgetAged", { period: 3n, heldOver: IMD }, START + 64, 2);
    p("FeedBudgetReleased", { amount: IMD / 4n }, START + 65);

    const { indexer } = indexerFor(node, BOOKS.aOnly);
    const report = await indexer.tick();
    expect(report.synced.find((entry) => entry.module === "payroll")).toMatchObject({
      logs: 12,
      unfolded: 0,
    });
    const rows = await database.db
      .select()
      .from(payrollMovements)
      .orderBy(asc(payrollMovements.blockNumber), asc(payrollMovements.logIndex));
    expect(rows.map((row) => [row.kind, row.amount])).toEqual([
      ["paid", 10n * IMD],
      ["booked", 10n * IMD],
      ["tipped", IMD],
      ["dripped", IMD / 10n],
      ["seat_claimed", IMD / 1000n],
      ["tip_claimed", IMD / 2n],
      ["tip_swept", IMD / 2n],
      ["feed_funded", IMD],
      ["feed_budget_released", IMD / 4n],
    ]);
    expect(rows[0]).toMatchObject({ account: OTHER, memo: `0x${"11".repeat(32)}` });
    expect(rows[1]?.detail).toEqual({
      toStakers: (5n * IMD).toString(),
      toSeats: (3n * IMD).toString(),
      toFeeds: (2n * IMD).toString(),
    });
    expect(rows[2]?.detail).toMatchObject({ agentIds: ["52211", "52372"], perAgent: (IMD / 2n).toString() });
    expect(rows[4]).toMatchObject({ account: OTHER, tokenId: 1998 });
    expect(rows[5]).toMatchObject({ account: OTHER, tokenId: 1998, agentId: 52_211n });
    expect(rows[7]).toMatchObject({ feedId: PAYROLLS });
    // The three events that move no IMD are in `events`, decoded, and in no row.
    const stored = await database.db.select().from(events).where(eq(events.module, "payroll"));
    expect(stored).toHaveLength(12);
    const kept = stored.filter((event) =>
      ["StreamLevelled", "FeedFundingFailed", "FeedBudgetAged"].includes(event.event),
    );
    expect(kept).toHaveLength(3);
    expect(kept.every((event) => event.args !== null && event.foldError === null)).toBe(true);
  });
});

describe("which of our modules run follows the deployments book", () => {
  it.each([
    ["none", []],
    ["aOnly", ["questions", "jobs_report", "payroll"]],
    ["all", OWN_MODULES.map((module) => module.name)],
  ] as const)("with the book %s, exactly these modules have a contract to read", (name, expected) => {
    const config = loadConfig({ HOUSE_WALLETS_FILE: "" }, BOOKS[name]);
    const indexer = new Indexer({
      db: database.db,
      client: new FakeNode().client(),
      modules: ALL_MODULES,
      deployments: config.deployments,
      sync: config.sync,
      now: () => 1_760_000_000_000,
    });
    const own = new Set(OWN_MODULES.map((module) => module.name));
    expect(
      indexer
        .active()
        .map((entry) => entry.module.name)
        .filter((module) => own.has(module)),
    ).toEqual([...expected]);
    // Each one that runs was given the block of its launch to start from.
    for (const module of expected)
      expect(config.sync.startBlocks[module]).toMatchObject({ kind: "absolute" });
  });
});
