/**
 * Coverage: the block range a module has read, and the rule that its tables hold exactly what
 * that range holds. These tests are about keeping that true when things do not go to plan: a
 * node without history, a backfill that is interrupted, a contract configured late, a lookup
 * for something that lies outside the range.
 */
import { asc, eq } from "drizzle-orm";
import { keccak256, numberToHex, toHex, type Address } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { cursors, events, feeTransfers } from "../src/db/schema.js";
import { NO_DEPLOYMENTS } from "../src/deployments.js";
import { Indexer } from "../src/engine/indexer.js";
import { createApp } from "../src/http/app.js";
import { feeTransfersModule, workRegistryModule } from "../src/modules/index.js";
import { workOrdersModule } from "../src/modules/own/workOrders.js";
import { createQueries } from "../src/queries.js";
import { buildSnapshot } from "../src/snapshot.js";
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
const HALF = 500_000_000_000_000_000n;

async function cursorOf(module: string) {
  const [row] = await database.db.select().from(cursors).where(eq(cursors.module, module));
  if (!row) throw new Error(`no cursor for ${module}`);
  return row;
}

async function transferBlocks(): Promise<number[]> {
  const rows = await database.db
    .select({ block: feeTransfers.blockNumber })
    .from(feeTransfers)
    .orderBy(asc(feeTransfers.blockNumber));
  return rows.map((row) => row.block);
}

function feeIndexer(node: FakeNode, sync: Parameters<typeof testSync>[0]) {
  return new Indexer({
    db: database.db,
    client: node.client(),
    modules: [feeTransfersModule],
    deployments: NO_DEPLOYMENTS,
    sync: testSync(sync),
  });
}

describe("a node that no longer serves the blocks a module stopped at", () => {
  // The free node keeps about 9,000 blocks of logs (some 30 hours). A process that was off for
  // longer comes back with its cursor below that. The error used to say "start later with
  // START_BLOCK", which does nothing once a cursor exists, and no command moved a cursor forward.
  function twoDaysOff() {
    const node = new FakeNode();
    node.head = 50_000;
    node.addFeeTransfer({ block: 49_990, from: ALICE, value: HALF });
    return node;
  }

  it("says what works, and `skip` restarts the module's coverage further on", async () => {
    const node = twoDaysOff();
    expect((await feeIndexer(node, { start: 49_000 }).tick()).failed).toEqual([]);
    expect((await cursorOf("fee_transfers")).nextBlock).toBe(50_001);

    // Two days later (14,400 blocks). The node keeps the last 9,000.
    node.head = 64_400;
    node.historyFloor = 64_400 - 9000;
    node.addFeeTransfer({ block: 64_390, from: BOB, value: HALF });
    const indexer = feeIndexer(node, { start: 49_000 });
    const stuck = await indexer.tick();
    expect(stuck.failed).toHaveLength(1);
    expect(stuck.failed[0]?.error).toMatch(/skip --module fee_transfers --to latest-7000/);
    expect(stuck.failed[0]?.error).toMatch(/START_BLOCK_FEE_TRANSFERS only applies to a module's first run/);
    expect((await cursorOf("fee_transfers")).nextBlock).toBe(50_001);

    // The operator gives up the blocks in between.
    expect(await indexer.skip("fee_transfers", { kind: "behind", blocks: 7000 })).toEqual({
      module: "fee_transfers",
      gaveUp: { fromBlock: 49_000, throughBlock: 50_000 },
      restartsAt: 57_400,
      eventsLeftOutside: 1,
    });
    // Coverage is one unbroken range or nothing: the old range is off the books, its log is
    // kept, and the table holds only what the new range holds (nothing yet).
    expect(await cursorOf("fee_transfers")).toMatchObject({ startBlock: 57_400, nextBlock: 57_400 });
    expect(await transferBlocks()).toEqual([]);
    expect(await countRows(database, events)).toBe(1);

    expect((await indexer.tick()).failed).toEqual([]);
    expect(await transferBlocks()).toEqual([64_390]);
    const queries = createQueries(database.db);
    expect(await queries.coverage()).toMatchObject([
      { module: "fee_transfers", fromBlock: 57_400, throughBlock: 64_400, events: 1, eventsOutside: 1 },
    ]);
    // The log outside coverage is in no list either.
    expect((await queries.events()).map((event) => event.blockNumber)).toEqual([64_390]);

    // Later, through a node with history, a backfill brings the whole range back.
    node.historyFloor = null;
    expect(await indexer.backfill("fee_transfers", 49_000)).toMatchObject({
      fromBlock: 49_000,
      toBlock: 57_399,
      logs: 1,
    });
    expect(await transferBlocks()).toEqual([49_990, 64_390]);
    expect(await queries.coverage()).toMatchObject([
      { module: "fee_transfers", fromBlock: 49_000, throughBlock: 64_400, events: 2, eventsOutside: 0 },
    ]);
  });

  it("refuses a skip that would go back, overshoot the head, or has nothing to skip", async () => {
    const node = twoDaysOff();
    const indexer = feeIndexer(node, { start: 49_000 });
    await expect(indexer.skip("fee_transfers", { kind: "behind", blocks: 0 })).rejects.toThrow(
      /stored nothing yet/,
    );
    await indexer.tick();
    await expect(indexer.skip("fee_transfers", { kind: "absolute", block: 50_000 })).rejects.toThrow(
      /already read through block 50000/,
    );
    await expect(indexer.skip("fee_transfers", { kind: "behind", blocks: 500 })).rejects.toThrow(
      /already read through block 50000.+use rewind/,
    );
    await expect(indexer.skip("fee_transfers", { kind: "absolute", block: 60_000 })).rejects.toThrow(
      /block 60000 is above the head \(50000\)/,
    );
    await expect(indexer.skip("nonsense", { kind: "behind", blocks: 0 })).rejects.toThrow(/unknown module/);
    expect(await cursorOf("fee_transfers")).toMatchObject({ startBlock: 49_000, nextBlock: 50_001 });
    expect(await transferBlocks()).toEqual([49_990]);
  });

  // The same trap on a first run: the cursor row used to be written before the first log query,
  // so a look-back the node cannot serve left a cursor that a corrected START_BLOCK never changed.
  it("leaves nothing behind when a first run asks for more history than the node keeps", async () => {
    const node = new FakeNode();
    node.head = 100_000;
    node.historyFloor = 91_000;
    node.addFeeTransfer({ block: 99_990, from: ALICE, value: HALF });
    const build = (behind: number) =>
      new Indexer({
        db: database.db,
        client: node.client(),
        modules: [feeTransfersModule],
        deployments: NO_DEPLOYMENTS,
        sync: { ...testSync({ start: 0 }), startBlock: { kind: "behind", blocks: behind } },
      });

    const refused = await build(50_400).tick();
    expect(refused.failed).toHaveLength(1);
    expect(refused.failed[0]?.error).toMatch(/Nothing is stored for this module yet/);
    expect(refused.failed[0]?.error).toMatch(/setting START_BLOCK_FEE_TRANSFERS/);
    expect(await countRows(database, cursors)).toBe(0);

    // Corrected to a look-back the node serves: it simply works.
    expect((await build(7000).tick()).failed).toEqual([]);
    expect(await cursorOf("fee_transfers")).toMatchObject({ startBlock: 93_000, nextBlock: 100_001 });
    expect(await transferBlocks()).toEqual([99_990]);
  });

  it("fixes a start block given relative to the head on the first pass, even with nothing to read yet", async () => {
    // "Start at the head" with two confirmations: the first pass has no block to read. The
    // cursor is written all the same, or the start would move with the head for ever.
    const node = new FakeNode();
    node.head = 1000;
    const indexer = new Indexer({
      db: database.db,
      client: node.client(),
      modules: [feeTransfersModule],
      deployments: NO_DEPLOYMENTS,
      sync: { ...testSync({ start: 0, confirmations: 2 }), startBlock: { kind: "behind", blocks: 0 } },
    });
    expect((await indexer.tick()).synced[0]).toMatchObject({ fromBlock: 1000, toBlock: 999, requests: 0 });
    expect(await cursorOf("fee_transfers")).toMatchObject({ startBlock: 1000, nextBlock: 1000 });

    node.addFeeTransfer({ block: 1005, from: ALICE, value: HALF });
    node.head = 1010;
    await indexer.tick();
    expect(await cursorOf("fee_transfers")).toMatchObject({ startBlock: 1000, nextBlock: 1009 });
    expect(await transferBlocks()).toEqual([1005]);
  });
});

describe("an interrupted backfill", () => {
  // A backfill stores its logs range by range. It used to lower `start_block` only at the very
  // end, with nothing to say how far it had got: the logs of an interrupted one sat below
  // `start_block`, in no table, and entered the tables whenever something else rebuilt them.
  function interrupted() {
    const node = new FakeNode();
    node.head = 10_000;
    node.addFeeTransfer({ block: 2500, from: ALICE, value: HALF });
    node.addFeeTransfer({ block: 9990, from: BOB, value: HALF });
    const indexer = feeIndexer(node, { start: 9000 });
    const breakAt = (block: number) => {
      node.intercept = (method, params) => {
        const from = Number((params[0] as { fromBlock?: string } | undefined)?.fromBlock ?? 0);
        if (method === "eth_getLogs" && from >= block) throw new Error("fetch failed");
      };
    };
    return { node, indexer, breakAt };
  }

  it("changes nothing a reader can see, whatever is rebuilt afterwards", async () => {
    const { indexer, breakAt } = interrupted();
    await indexer.tick();
    expect(await transferBlocks()).toEqual([9990]);

    breakAt(6000);
    await expect(indexer.backfill("fee_transfers", 2000)).rejects.toThrow();

    // Two ranges were stored (2,000 to 5,999) and noted; coverage still begins at 9,000.
    expect(await countRows(database, events)).toBe(2);
    expect(await cursorOf("fee_transfers")).toMatchObject({
      startBlock: 9000,
      backfillFrom: 2000,
      backfillNext: 6000,
    });
    const queries = createQueries(database.db);
    expect(await queries.coverage()).toMatchObject([
      {
        module: "fee_transfers",
        fromBlock: 9000,
        events: 1,
        eventsOutside: 1,
        backfill: { fromBlock: 2000, nextBlock: 6000 },
      },
    ]);

    // A rebuild for any other reason folds only what coverage holds.
    expect(await indexer.reproject(["fee_transfers"])).toEqual({ fee_transfers: { folded: 1, unfolded: 0 } });
    expect(await transferBlocks()).toEqual([9990]);
    expect((await queries.events()).map((event) => event.blockNumber)).toEqual([9990]);
    const files = await buildSnapshot(database.db);
    const transfers = files.find((file) => file.name === "fee-transfers.json");
    expect(transfers?.rows).toBe(1);
  });

  it("continues where it stopped when the same command is run again", async () => {
    const { node, indexer, breakAt } = interrupted();
    await indexer.tick();
    breakAt(6000);
    await expect(indexer.backfill("fee_transfers", 2000)).rejects.toThrow();

    node.intercept = null;
    const before = node.logRanges().length;
    expect(await indexer.backfill("fee_transfers", 2000)).toMatchObject({ fromBlock: 2000, toBlock: 8999 });
    // Only the part that was missing is asked for.
    expect(node.logRanges().slice(before)).toEqual([
      [6000, 7999],
      [8000, 8999],
    ]);
    expect(await transferBlocks()).toEqual([2500, 9990]);
    expect(await cursorOf("fee_transfers")).toMatchObject({
      startBlock: 2000,
      backfillFrom: null,
      backfillNext: null,
    });
    expect(await createQueries(database.db).coverage()).toMatchObject([
      { fromBlock: 2000, events: 2, eventsOutside: 0, backfill: null },
    ]);
  });

  it("starts over when it is run again for another range", async () => {
    const { node, indexer, breakAt } = interrupted();
    await indexer.tick();
    breakAt(6000);
    await expect(indexer.backfill("fee_transfers", 2000)).rejects.toThrow();

    node.intercept = null;
    const before = node.logRanges().length;
    await indexer.backfill("fee_transfers", 3000);
    expect(node.logRanges().slice(before)[0]).toEqual([3000, 4999]);
    // The log at 2,500 is still stored, and still outside coverage.
    expect(await transferBlocks()).toEqual([9990]);
    expect(await createQueries(database.db).coverage()).toMatchObject([
      { fromBlock: 3000, events: 1, eventsOutside: 1 },
    ]);
  });

  it("forgets how far it had got when a rewind removes part of what it stored", async () => {
    const { indexer, breakAt } = interrupted();
    await indexer.tick();
    breakAt(6000);
    await expect(indexer.backfill("fee_transfers", 2000)).rejects.toThrow();

    await indexer.rewindTo(5000);
    expect(await cursorOf("fee_transfers")).toMatchObject({
      startBlock: 9000,
      nextBlock: 9000,
      backfillFrom: null,
      backfillNext: null,
    });
  });

  it("asks for a first sync before there is anything to extend", async () => {
    const { indexer } = interrupted();
    await expect(indexer.backfill("fee_transfers", 2000)).rejects.toThrow(/has not synced yet/);
  });
});

describe("a lookup outside the indexed range", () => {
  // With the default look-back, a receipt older than the range is not in the receipts table (as
  // happened while the receipt writer was stalled, 8 to 13 October 2026). The route used to answer `latest: null` for a job whose receipt is on chain,
  // with no word about which blocks had been looked at.
  it("says which blocks were searched, so that no receipt is not read as none on chain", async () => {
    const fixture = loadLogFixture("work-recorded");
    const node = new FakeNode().load(fixture);
    const indexer = new Indexer({
      db: database.db,
      client: node.client(),
      modules: [workRegistryModule],
      deployments: NO_DEPLOYMENTS,
      // Starts 25 blocks after the receipt of job e9efec16, as a later look-back would.
      sync: testSync({ start: 26_132_000 }),
    });
    await indexer.tick();
    const app = createApp({ queries: createQueries(database.db), live: () => indexer.live() });
    const lookup = async () =>
      (await (
        await app(new Request("http://indexer.test/v1/receipts/e9efec16-56f3-40d3-9243-52c453effc7d"))
      ).json()) as { latest: { documentHash: string } | null; coverage: Record<string, unknown> };

    expect(await lookup()).toEqual({
      jobId: "0xe9efec1656f340d3924352c453effc7d",
      latest: null,
      receipts: [],
      coverage: {
        module: "receipts",
        handler: "ready",
        fromBlock: 26_132_000,
        throughBlock: 26_132_100,
        fromTime: node.timeOf(26_132_000),
        throughTime: node.timeOf(26_132_100),
        unfolded: 0,
      },
    });
    const list = (await (await app(new Request("http://indexer.test/v1/receipts"))).json()) as {
      coverage: { fromBlock: number };
      receipts: unknown[];
    };
    expect(list.coverage.fromBlock).toBe(26_132_000);
    expect(list.receipts).toHaveLength(2);

    // Extending the range downwards finds it.
    await indexer.backfill("receipts", 26_131_900);
    const found = await lookup();
    expect(found.latest?.documentHash).toBe(
      "0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5",
    );
    expect(found.coverage).toMatchObject({ fromBlock: 26_131_900, throughBlock: 26_132_100 });
  });

  it("answers the typed lookup with the range too, and null for text that is not a job id", async () => {
    const queries = createQueries(database.db);
    expect(await queries.jobReceipts("not a job")).toBeNull();
    // Nothing synced at all: the answer says so instead of looking like "no receipt".
    expect(await queries.jobReceipts("e9efec16-56f3-40d3-9243-52c453effc7d")).toEqual({
      jobId: "0xe9efec1656f340d3924352c453effc7d",
      latest: null,
      receipts: [],
      coverage: {
        module: "receipts",
        handler: "ready",
        fromBlock: null,
        throughBlock: null,
        fromTime: null,
        throughTime: null,
        unfolded: 0,
      },
    });
  });
});

describe("one of our own contracts", () => {
  // A module of ours used to start, like every module, 7,000 blocks behind the head. A contract
  // configured more than a day after its launch had its first events skipped without a word.
  const desk: Address = "0x00000000000000000000000000000000000de5c0";
  function deskNode() {
    const node = new FakeNode();
    node.head = 30_000;
    const log = (block: number, salt: string) =>
      node.addLog({
        address: desk,
        topics: [keccak256(toHex("OrderOpened(uint256)"))],
        data: "0x",
        blockNumber: numberToHex(block),
        blockHash: node.hashOf(block),
        blockTimestamp: numberToHex(node.timeOf(block)),
        transactionHash: keccak256(toHex(`tx:${salt}`)),
        transactionIndex: "0x0",
        logIndex: "0x0",
        removed: false,
      });
    log(20_000, "first order, a day and a half ago");
    log(29_990, "an order just now");
    return node;
  }

  it("is not started from the default look-back: the module asks for its deployment block", async () => {
    const node = deskNode();
    const indexer = new Indexer({
      db: database.db,
      client: node.client(),
      modules: [workOrdersModule],
      deployments: { ...NO_DEPLOYMENTS, workOrders: desk },
      sync: { ...testSync({ start: 0 }), startBlock: { kind: "behind", blocks: 7000 } },
    });
    const report = await indexer.tick();
    expect(report.synced).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.error).toMatch(/module "work_orders" has no start block/);
    expect(report.failed[0]?.error).toMatch(/START_BLOCK_WORK_ORDERS/);
    expect(node.countOf("eth_getLogs")).toBe(0);
    expect(await countRows(database, events)).toBe(0);
    expect(await countRows(database, cursors)).toBe(0);
    // The reason is one this package wrote, so the status route may show it.
    expect(indexer.live().modules[0]?.lastError).toMatch(/has no start block/);
  });

  it("is read from its deployment block when that is given", async () => {
    const node = deskNode();
    const indexer = new Indexer({
      db: database.db,
      client: node.client(),
      modules: [workOrdersModule],
      deployments: { ...NO_DEPLOYMENTS, workOrders: desk },
      sync: {
        ...testSync({ start: 0 }),
        startBlock: { kind: "behind", blocks: 7000 },
        startBlocks: { work_orders: { kind: "absolute", block: 19_500 } },
      },
    });
    expect((await indexer.tick()).failed).toEqual([]);
    const stored = await database.db
      .select({ block: events.blockNumber })
      .from(events)
      .orderBy(asc(events.blockNumber));
    expect(stored).toEqual([{ block: 20_000 }, { block: 29_990 }]);
    expect(await cursorOf("work_orders")).toMatchObject({ startBlock: 19_500, nextBlock: 30_001 });
  });

  it("says on its routes that the handler is a stub, so an empty list is not read as no orders", async () => {
    const node = deskNode();
    const indexer = new Indexer({
      db: database.db,
      client: node.client(),
      modules: [workOrdersModule],
      deployments: { ...NO_DEPLOYMENTS, workOrders: desk },
      sync: { ...testSync({ start: 0 }), startBlocks: { work_orders: { kind: "absolute", block: 19_500 } } },
    });
    await indexer.tick();
    const app = createApp({ queries: createQueries(database.db), live: () => indexer.live() });
    const orders = (await (await app(new Request("http://indexer.test/v1/orders"))).json()) as unknown;
    // Two logs of the desk are stored, and the list is empty: `handler: "stub"` is why.
    expect(orders).toEqual({
      coverage: {
        module: "work_orders",
        handler: "stub",
        fromBlock: 19_500,
        throughBlock: 30_000,
        fromTime: node.timeOf(19_500),
        throughTime: node.timeOf(30_000),
        unfolded: 0,
      },
      orders: [],
    });
  });
});
