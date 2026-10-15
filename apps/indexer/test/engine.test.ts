/**
 * The sync engine against a node in memory: idempotency, the reorganisation rewind, range limits,
 * history the node does not keep, backfill and replay.
 */
import { asc, eq, sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { parseAbi, type Address } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IMD } from "../src/constants.js";
import type { Database } from "../src/db/client.js";
import { int53 } from "../src/db/columns.js";
import { cursors, events, feeTransfers, intakeRequests } from "../src/db/schema.js";
import { NO_DEPLOYMENTS } from "../src/deployments.js";
import { Indexer } from "../src/engine/indexer.js";
import type { ContractModule } from "../src/engine/module.js";
import { firstMismatch, type LogIdentity } from "../src/engine/store.js";
import { feeTransfersModule, intakeModule } from "../src/modules/index.js";
import { countRows, emptyDatabase, openTestDatabase, testSync } from "./helpers/db.js";
import { FakeNode, loadLogFixture } from "./helpers/fakeNode.js";

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

const ALICE: Address = "0x00000000000000000000000000000000000a11ce";
const BOB: Address = "0x0000000000000000000000000000000000000b0b";
const CAROL: Address = "0x00000000000000000000000000000000000ca401";
const HALF = 500_000_000_000_000_000n;

function build(
  node: FakeNode,
  sync: Parameters<typeof testSync>[0],
  modules: ContractModule[] = [feeTransfersModule],
) {
  return new Indexer({
    db: database.db,
    client: node.client(),
    modules,
    deployments: NO_DEPLOYMENTS,
    sync: testSync(sync),
  });
}

async function transfers() {
  const rows = await database.db
    .select()
    .from(feeTransfers)
    .orderBy(asc(feeTransfers.blockNumber), asc(feeTransfers.logIndex));
  return rows.map((row) => ({ block: row.blockNumber, from: row.from, value: row.value }));
}

async function cursorOf(module: string) {
  const [row] = await database.db.select().from(cursors).where(eq(cursors.module, module));
  if (!row) throw new Error(`no cursor for ${module}`);
  return row;
}

describe("idempotency", () => {
  it("stores nothing twice when the same range is synced again", async () => {
    const fixture = loadLogFixture("fee-transfers");
    const node = new FakeNode().load(fixture);
    const indexer = build(node, { start: fixture.from });

    await indexer.tick();
    const before = await database.db.select().from(feeTransfers).orderBy(asc(feeTransfers.txHash));
    expect(before).toHaveLength(94);

    // Put the cursor back to the start, as if the process had died before saving any progress.
    await database.db
      .update(cursors)
      .set({ nextBlock: fixture.from })
      .where(eq(cursors.module, "fee_transfers"));
    const again = await build(node, { start: fixture.from }).tick();
    expect(again.synced[0]?.logs).toBe(94);

    const after = await database.db.select().from(feeTransfers).orderBy(asc(feeTransfers.txHash));
    expect(after).toEqual(before);
    expect(await countRows(database, events)).toBe(94);
  });

  it("gives the same rows whether the range comes in one piece or in many", async () => {
    const fixture = loadLogFixture("intake");
    const node = new FakeNode().load(fixture);
    await build(node, { start: fixture.from }, [intakeModule]).tick();
    const whole = await database.db.select().from(intakeRequests).orderBy(asc(intakeRequests.requestId));

    await emptyDatabase(database);
    const pieces = build(node, { start: fixture.from, chunkSize: 137 }, [intakeModule]);
    const report = await pieces.tick();
    expect(report.synced[0]?.requests).toBeGreaterThan(100);
    expect(await database.db.select().from(intakeRequests).orderBy(asc(intakeRequests.requestId))).toEqual(
      whole,
    );
  });

  it("does nothing on a tick with no new block", async () => {
    const node = new FakeNode();
    node.head = 1000;
    node.addFeeTransfer({ block: 990, from: ALICE, value: HALF });
    const indexer = build(node, { start: 900 });
    await indexer.tick();
    const logsCalls = node.countOf("eth_getLogs");

    const report = await indexer.tick();
    expect(report.synced).toEqual([
      { module: "fee_transfers", fromBlock: 1001, toBlock: 1000, logs: 0, requests: 0, unfolded: 0 },
    ]);
    expect(node.countOf("eth_getLogs")).toBe(logsCalls);
    expect(await transfers()).toHaveLength(1);
  });

  it("stays the configured number of blocks behind the head", async () => {
    const node = new FakeNode();
    node.head = 1000;
    node.addFeeTransfer({ block: 995, from: ALICE, value: HALF });
    node.addFeeTransfer({ block: 999, from: BOB, value: HALF });
    const indexer = build(node, { start: 900, confirmations: 3 });

    const report = await indexer.tick();
    expect(report.target).toBe(997);
    expect(await transfers()).toEqual([{ block: 995, from: ALICE, value: HALF }]);

    node.head = 1002;
    await indexer.tick();
    expect((await transfers()).map((row) => row.block)).toEqual([995, 999]);
    expect((await cursorOf("fee_transfers")).nextBlock).toBe(1000);
  });
});

describe("reorganisation", () => {
  it("finds the lowest block at which stored logs and the chain differ", () => {
    const log = (
      block: number,
      index: number,
      hash = `h${block}`,
      tx = `t${block}-${index}`,
    ): LogIdentity => ({
      txHash: tx,
      logIndex: index,
      blockNumber: block,
      blockHash: hash,
    });
    const stored = [log(10, 0), log(12, 1), log(15, 0)];

    expect(firstMismatch(stored, [log(10, 0), log(12, 1), log(15, 0)])).toBeNull();
    expect(firstMismatch([], [])).toBeNull();
    // A stored log is gone.
    expect(firstMismatch(stored, [log(10, 0), log(15, 0)])).toBe(12);
    // The same log, in a block with another hash.
    expect(firstMismatch(stored, [log(10, 0), log(12, 1, "other"), log(15, 0)])).toBe(12);
    // The chain has a log that was never stored.
    expect(firstMismatch(stored, [log(10, 0), log(11, 3), log(12, 1), log(15, 0)])).toBe(11);
    // The same transaction was included again in an earlier block.
    expect(firstMismatch(stored, [log(10, 0), log(12, 1), log(14, 0, "h14", "t15-0")])).toBe(14);
    // Several differences: the lowest one decides how far to go back.
    expect(firstMismatch(stored, [log(10, 0, "other"), log(12, 1), log(13, 0)])).toBe(10);
  });

  it("rewinds when a stored block was replaced, and reads the new fork", async () => {
    const node = new FakeNode();
    node.head = 1000;
    node.addFeeTransfer({ block: 980, from: ALICE, value: HALF });
    node.addFeeTransfer({ block: 996, from: BOB, value: HALF });
    node.addFeeTransfer({ block: 999, from: BOB, value: 2n * HALF });
    const indexer = build(node, { start: 900 });
    await indexer.tick();
    expect((await transfers()).map((row) => row.block)).toEqual([980, 996, 999]);
    const oldHash = node.hashOf(996);

    // Blocks 995 and up are replaced. On the new fork Bob's first payment is gone, his second
    // landed one block earlier, and Carol paid in a block that used to hold nothing of ours.
    node.reorg(995);
    node.addFeeTransfer({ block: 997, from: CAROL, value: HALF });
    node.addFeeTransfer({ block: 998, from: BOB, value: 2n * HALF });
    node.head = 1003;
    expect(node.hashOf(996)).not.toBe(oldHash);

    const report = await indexer.tick();
    expect(report.failed).toEqual([]);
    expect(report.rewinds).toEqual([{ module: "fee_transfers", keptThrough: 995 }]);
    expect(await transfers()).toEqual([
      { block: 980, from: ALICE, value: HALF },
      { block: 997, from: CAROL, value: HALF },
      { block: 998, from: BOB, value: 2n * HALF },
    ]);

    // The event store agrees with the table, and every stored hash is the new chain's.
    const stored = await database.db.select().from(events).orderBy(asc(events.blockNumber));
    expect(stored.map((event) => [event.blockNumber, event.blockHash])).toEqual([
      [980, node.hashOf(980)],
      [997, node.hashOf(997)],
      [998, node.hashOf(998)],
    ]);
    const cursor = await cursorOf("fee_transfers");
    expect(cursor.nextBlock).toBe(1004);
    expect(cursor.tipHash).toBe(node.hashOf(1003));
  });

  it("notices a log that a reorganisation added to a block already synced", async () => {
    const node = new FakeNode();
    node.head = 500;
    node.addFeeTransfer({ block: 450, from: ALICE, value: HALF });
    const indexer = build(node, { start: 400 });
    await indexer.tick();

    node.reorg(498);
    node.addFeeTransfer({ block: 499, from: CAROL, value: HALF });
    node.head = 501;
    const report = await indexer.tick();
    expect(report.rewinds).toEqual([{ module: "fee_transfers", keptThrough: 498 }]);
    expect((await transfers()).map((row) => [row.block, row.from])).toEqual([
      [450, ALICE],
      [499, CAROL],
    ]);
  });

  it("leaves everything alone when the recent blocks are unchanged", async () => {
    const node = new FakeNode();
    node.head = 1000;
    node.addFeeTransfer({ block: 990, from: ALICE, value: HALF });
    const indexer = build(node, { start: 900 });
    await indexer.tick();
    node.addFeeTransfer({ block: 1001, from: BOB, value: HALF });

    const report = await indexer.tick();
    expect(report.rewinds).toEqual([]);
    // One request covered both the blocks read again and the new one.
    expect(report.synced[0]).toMatchObject({ fromBlock: 1001, toBlock: 1001, logs: 1, requests: 1 });
    const last = node.requests.filter((request) => request.method === "eth_getLogs").at(-1);
    expect((last?.params as [{ fromBlock: string; toBlock: string }])[0]).toMatchObject({
      fromBlock: `0x${(1001 - 64).toString(16)}`,
      toBlock: `0x${(1001).toString(16)}`,
    });
  });

  it("does not look below what the reorg depth covers", async () => {
    const node = new FakeNode();
    node.head = 1000;
    node.addFeeTransfer({ block: 910, from: ALICE, value: HALF });
    const indexer = build(node, { start: 900, reorgDepth: 10 });
    await indexer.tick();

    // A change this deep is outside the window: by then the block is final on mainnet.
    node.reorg(905);
    node.head = 1001;
    const report = await indexer.tick();
    expect(report.rewinds).toEqual([]);
    expect((await transfers()).map((row) => row.block)).toEqual([910]);
  });

  it("stops and asks for a rewind when a change deeper than the window shows itself", async () => {
    const node = new FakeNode();
    node.head = 1000;
    const paid = node.addFeeTransfer({ block: 910, from: ALICE, value: HALF });
    const indexer = build(node, { start: 900, reorgDepth: 10 });
    await indexer.tick();

    // Far below the window the chain changes, and Alice's transaction lands again much later.
    node.reorg(905);
    node.addFeeTransfer({
      block: 1003,
      from: ALICE,
      value: HALF,
      txHash: paid.transactionHash as `0x${string}`,
    });
    node.head = 1005;
    const report = await indexer.tick();
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.error).toMatch(/stored in block 910 with another block hash/);
    expect(report.failed[0]?.error).toMatch(/rewind --to/);
    // Nothing was written and the cursor did not move: the payment is not counted twice.
    expect((await transfers()).map((row) => row.block)).toEqual([910]);
    expect((await cursorOf("fee_transfers")).nextBlock).toBe(1001);

    // The operator rewinds to below both blocks; the next sync reads the chain as it now is.
    expect(await indexer.rewindTo(904)).toEqual({ deleted: 1, modules: ["fee_transfers"] });
    expect(await transfers()).toEqual([]);
    expect((await indexer.tick()).failed).toEqual([]);
    expect((await transfers()).map((row) => row.block)).toEqual([1003]);
  });

  it("rebuilds a table that folds several events when one of them is reorganised away", async () => {
    // The Intake table merges two events into one row, so a rewind has to rebuild it, not just
    // delete rows: here a completion disappears and its request must go back to "no outcome yet".
    const fixture = loadLogFixture("intake");
    const node = new FakeNode().load(fixture);
    // The newest request was completed in block 26,163,839. Sync to just past it.
    node.head = 26_163_845;
    const indexer = build(node, { start: fixture.from }, [intakeModule]);
    await indexer.tick();
    const answered = async () =>
      (
        await database.db.select().from(intakeRequests).where(eq(intakeRequests.requestedBlock, 26_163_827))
      )[0];
    expect(await answered()).toMatchObject({ statusName: "answered", completedBlock: 26_163_839 });

    node.reorg(26_163_839);
    node.head = 26_163_850;
    const report = await indexer.tick();
    expect(report.rewinds).toEqual([{ module: "intake", keptThrough: 26_163_838 }]);
    expect(await answered()).toMatchObject({
      statusName: null,
      status: null,
      completedBlock: null,
      payer: "0xe5b1275fb926613d983da33fbfe1f331b7f64f2a",
    });
    expect(await countRows(database, intakeRequests)).toBe(8);
    expect(await countRows(database, events)).toBe(12);
  });

  it("rewinds every module, because a replaced block is replaced for all of them", async () => {
    const counter = counterModule();
    const node = new FakeNode();
    node.head = 300;
    node.addFeeTransfer({ block: 290, from: ALICE, value: HALF });
    node.addFeeTransfer({ block: 295, from: BOB, value: HALF });
    const indexer = build(node, { start: 200 }, [feeTransfersModule, counter.module]);
    await indexer.tick();
    expect(await counter.read()).toEqual({ transfers: 2, lastBlock: 295 });

    node.reorg(294);
    node.head = 302;
    const report = await indexer.tick();
    // The first module to sync noticed at block 295, where its stored log had gone; the second
    // was rewound with it and needed no rewind of its own.
    expect(report.rewinds).toEqual([{ module: "fee_transfers", keptThrough: 294 }]);
    expect((await transfers()).map((row) => row.block)).toEqual([290]);
    expect(await counter.read()).toEqual({ transfers: 1, lastBlock: 290 });
    expect((await cursorOf("counter")).nextBlock).toBe(303);
  });
});

describe("node limits", () => {
  it("halves a range the node refuses and still reads every log", async () => {
    const fixture = loadLogFixture("fee-transfers");
    const node = new FakeNode().load(fixture);
    node.maxRange = 800;
    const indexer = build(node, { start: fixture.from, chunkSize: 5000 });

    const report = await indexer.tick();
    expect(report.failed).toEqual([]);
    expect(await countRows(database, feeTransfers)).toBe(94);
    // 5,000 → 2,500 → 1,250 → 625 fits under 800: three refusals, then twelve ranges of at most
    // 625 blocks cover the 7,001 blocks.
    expect(report.synced[0]?.requests).toBe(3 + 12);
    expect(indexer.live().modules[0]?.chunkSize).toBeLessThan(5000);
  });

  it("goes down to one block at a time if that is all the node allows", async () => {
    const node = new FakeNode();
    node.head = 120;
    node.maxRange = 1;
    node.addFeeTransfer({ block: 103, from: ALICE, value: HALF });
    node.addFeeTransfer({ block: 119, from: BOB, value: HALF });
    const indexer = build(node, { start: 100, chunkSize: 16 });
    const report = await indexer.tick();
    expect(report.failed).toEqual([]);
    expect((await transfers()).map((row) => row.block)).toEqual([103, 119]);
    expect(indexer.live().modules[0]?.chunkSize).toBe(1);
  });

  it("stops with advice, and without halving, when the node does not keep the history", async () => {
    const node = new FakeNode();
    node.head = 50_000;
    node.historyFloor = 40_000;
    const indexer = build(node, { start: 10_000 });

    const report = await indexer.tick();
    expect(report.synced).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.error).toMatch(/does not keep history that far back/);
    expect(report.failed[0]?.error).toMatch(/RPC_URL/);
    // Asked twice (a refusal is believed when it is repeated), not halved eleven times.
    expect(node.countOf("eth_getLogs")).toBe(2);
    // Nothing was stored, so nothing is left behind: not even a cursor (see coverage.test.ts).
    expect(await countRows(database, cursors)).toBe(0);
    expect(indexer.live().modules[0]?.lastError).toMatch(/history/);
    expect(indexer.live().lastTickOk).toBe(false);
  });

  it("does not believe a refusal for missing history that is not repeated", async () => {
    // Seen for real on the free node: one of its machines refused a range 7,000 blocks behind
    // the head as an "archive request", and the same range was served on the next request.
    const node = new FakeNode();
    node.head = 50_000;
    node.addFeeTransfer({ block: 43_500, from: ALICE, value: HALF });
    let refusals = 0;
    node.intercept = (method) => {
      if (method === "eth_getLogs" && refusals++ === 0) {
        throw Object.assign(new Error("Archive requests require a personal token."), { code: -32602 });
      }
    };
    const indexer = build(node, { start: 43_000 });
    const report = await indexer.tick();
    expect(report.failed).toEqual([]);
    // Four ranges of 2,000 blocks, and the one request that was refused.
    expect(report.synced[0]).toMatchObject({ fromBlock: 43_000, toBlock: 50_000, logs: 1, requests: 5 });
    expect((await transfers()).map((row) => row.block)).toEqual([43_500]);
  });

  it("lets the other modules carry on when one cannot be served", async () => {
    const counter = counterModule();
    const node = new FakeNode();
    node.head = 50_000;
    node.historyFloor = 40_000;
    node.addFeeTransfer({ block: 45_000, from: ALICE, value: HALF });
    const indexer = new Indexer({
      db: database.db,
      client: node.client(),
      modules: [feeTransfersModule, counter.module],
      deployments: NO_DEPLOYMENTS,
      sync: { ...testSync({ start: 10_000 }), startBlocks: { counter: { kind: "behind", blocks: 6000 } } },
    });
    const report = await indexer.tick();
    expect(report.failed.map((failure) => failure.module)).toEqual(["fee_transfers"]);
    expect(report.synced.map((progress) => progress.module)).toEqual(["counter"]);
    expect(await counter.read()).toEqual({ transfers: 1, lastBlock: 45_000 });
    expect((await cursorOf("counter")).startBlock).toBe(44_000);
  });

  it("fetches the header for the timestamp when the node leaves it out of its logs", async () => {
    const fixture = loadLogFixture("fee-transfers");
    const node = new FakeNode().load(fixture);
    node.timestampsInLogs = false;
    await build(node, { start: fixture.from }).tick();

    const rows = await database.db.select().from(feeTransfers);
    expect(rows).toHaveLength(94);
    const recorded = new Map(fixture.logs.map((log) => [log.transactionHash, Number(log.blockTimestamp)]));
    for (const row of rows) expect(row.blockTime).toBe(recorded.get(row.txHash));
    // One header per block that holds a log (93 of them), plus the tip and the start block.
    expect(node.countOf("eth_getBlockByNumber")).toBe(93 + 2);
  });

  it("refuses an answer that holds a log from outside the range it asked for", async () => {
    const node = new FakeNode();
    node.head = 100;
    const client = node.client();
    const original = client.request;
    // A node that answers a narrow query with a log from far away.
    (client as { request: unknown }).request = async (args: { method: string }) => {
      const answer = await (original as (a: unknown) => Promise<unknown>)(args);
      if (args.method !== "eth_getLogs") return answer;
      return [
        {
          address: IMD.toLowerCase(),
          topics: [],
          data: "0x",
          blockNumber: "0x9999",
          blockHash: `0x${"11".repeat(32)}`,
          transactionHash: `0x${"22".repeat(32)}`,
          transactionIndex: "0x0",
          logIndex: "0x0",
          removed: false,
        },
      ];
    };
    const indexer = new Indexer({
      db: database.db,
      client,
      modules: [feeTransfersModule],
      deployments: NO_DEPLOYMENTS,
      sync: testSync({ start: 90 }),
    });
    const report = await indexer.tick();
    expect(report.failed[0]?.error).toMatch(/outside 90 to 100/);
    expect(await countRows(database, events)).toBe(0);
    expect(await countRows(database, cursors)).toBe(0);
  });

  it("refuses an answer whose entries are not shaped like logs, before any of it is stored", async () => {
    const node = new FakeNode();
    node.head = 100;
    const good = node.addFeeTransfer({ block: 95, from: ALICE, value: HALF });
    const answers: Record<string, unknown>[] = [
      // Text where an address belongs: it would otherwise travel into the database and the logs.
      { ...good, address: "<script>not an address</script>" },
      { ...good, topics: ["0x1234"] },
      { ...good, data: "0xzz" },
      { ...good, blockHash: "0x00" },
      { ...good, transactionHash: "nope" },
      // A timestamp no calendar holds would break every day of the tally.
      { ...good, blockTimestamp: "0xffffffffffffffff" },
      { ...good, blockNumber: "not a number" },
    ];
    for (const answer of answers) {
      const client = node.client();
      const original = client.request;
      (client as { request: unknown }).request = async (args: { method: string }) =>
        args.method === "eth_getLogs" ? [answer] : (original as (a: unknown) => Promise<unknown>)(args);
      const indexer = new Indexer({
        db: database.db,
        client,
        modules: [feeTransfersModule],
        deployments: NO_DEPLOYMENTS,
        sync: testSync({ start: 90 }),
      });
      const report = await indexer.tick();
      expect(report.failed[0]?.error).toMatch(/not shaped like a log/);
      expect(await countRows(database, events)).toBe(0);
    }
  });
});

describe("backfill and replay", () => {
  it("extends a module's history downwards and rebuilds its table in chain order", async () => {
    const fixture = loadLogFixture("intake");
    const node = new FakeNode().load(fixture);
    // Start after the first five logs, so one completion is stored without its request.
    const indexer = build(node, { start: 26_155_500 }, [intakeModule]);
    await indexer.tick();
    expect(await countRows(database, events)).toBe(8);
    const orphan = async () =>
      (
        await database.db.select().from(intakeRequests).where(eq(intakeRequests.completedBlock, 26_155_506))
      )[0];
    expect(await orphan()).toMatchObject({ payer: null, statusName: "answered" });

    const progress = await indexer.backfill("intake", fixture.from);
    expect(progress).toMatchObject({
      module: "intake",
      fromBlock: fixture.from,
      toBlock: 26_155_499,
      logs: 5,
    });
    expect(await countRows(database, events)).toBe(13);
    expect(await countRows(database, intakeRequests)).toBe(8);
    expect(await orphan()).toMatchObject({
      payer: "0x4b91078b2374c956a65f7af0999cae0a935e6821",
      requestedBlock: 26_155_480,
      statusName: "answered",
    });
    const cursor = await cursorOf("intake");
    expect([cursor.startBlock, cursor.nextBlock]).toEqual([fixture.from, fixture.to + 1]);
    expect(cursor.startTime).toBe(node.timeOf(fixture.from));

    // Asking for a range that is already covered reads nothing.
    const calls = node.countOf("eth_getLogs");
    expect((await indexer.backfill("intake", fixture.from + 10)).logs).toBe(0);
    expect(node.countOf("eth_getLogs")).toBe(calls);
  });

  it("decodes stored logs again when a module gets its ABI after the fact", async () => {
    // What will happen to our own contracts: logs arrive before the handler is written.
    const early: ContractModule = {
      name: "counter",
      title: "the same contract before its handler exists",
      abi: [],
      stub: true,
      filter: () => ({ address: IMD }),
      tables: [counterState],
      apply: async () => {},
    };
    const node = new FakeNode();
    node.head = 60;
    node.addFeeTransfer({ block: 20, from: ALICE, value: HALF });
    node.addFeeTransfer({ block: 40, from: BOB, value: HALF });
    await build(node, { start: 0 }, [early]).tick();

    const raw = await database.db.select().from(events).orderBy(asc(events.blockNumber));
    expect(raw.map((event) => [event.event, event.args])).toEqual([
      ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", null],
      ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", null],
    ]);

    const finished = counterModule();
    const later = build(node, { start: 0 }, [finished.module]);
    expect(await later.reproject(["counter"])).toEqual({ counter: { folded: 2, unfolded: 0 } });
    expect(await finished.read()).toEqual({ transfers: 2, lastBlock: 40 });
    const decoded = await database.db.select().from(events).orderBy(asc(events.blockNumber));
    expect(decoded.map((event) => event.event)).toEqual(["Transfer", "Transfer"]);
    expect(decoded[0]?.args).toMatchObject({ value: HALF.toString() });
  });

  it("rejects two modules with one name", () => {
    const node = new FakeNode();
    expect(() => build(node, { start: 0 }, [feeTransfersModule, feeTransfersModule])).toThrow(/two modules/);
  });
});

// A small module of the kind `src/engine/module.ts` describes: one table folded from one event.
// It reads all IMD transfers, with no topic filter, the way our own contracts' modules read theirs.
const counterState = pgTable("counter_state", {
  id: text("id").primaryKey(),
  transfers: int53("transfers").notNull(),
  lastBlock: int53("last_block").notNull(),
});

async function ensureCounterTable(): Promise<void> {
  await database.db.execute(
    sql`create table if not exists counter_state (id text primary key, transfers bigint not null, last_block bigint not null)`,
  );
  await database.db.delete(counterState);
}

function counterModule() {
  const module: ContractModule = {
    name: "counter",
    title: "counts IMD transfers",
    abi: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]),
    filter: () => ({ address: IMD }),
    tables: [counterState],
    async apply(db, event) {
      if (event.event !== "Transfer") return;
      const [current] = await db.select().from(counterState).where(eq(counterState.id, "all"));
      const next = { transfers: (current?.transfers ?? 0) + 1, lastBlock: event.blockNumber };
      await db
        .insert(counterState)
        .values({ id: "all", ...next })
        .onConflictDoUpdate({ target: counterState.id, set: next });
    },
  };
  return {
    module,
    async read() {
      const [row] = await database.db.select().from(counterState).where(eq(counterState.id, "all"));
      return row ? { transfers: row.transfers, lastBlock: row.lastBlock } : null;
    },
  };
}

beforeEach(async () => {
  await ensureCounterTable();
});
