/**
 * The three finished modules against logs recorded from Ethereum mainnet (see
 * `scripts/record-fixtures.ts`). The node is in memory; the logs, block hashes and timestamps
 * are real.
 */
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FEE_PAYEE, INTAKE, INTAKE_V1, ORACLE_ACTION, WORK_REGISTRY } from "../src/constants.js";
import type { Database } from "../src/db/client.js";
import { cursors, events, feeTransfers, intakeRequests, receipts } from "../src/db/schema.js";
import { NO_DEPLOYMENTS } from "../src/deployments.js";
import { Indexer } from "../src/engine/indexer.js";
import {
  EXTERNAL_MODULES,
  feeTransfersModule,
  intakeModule,
  workRegistryModule,
} from "../src/modules/index.js";
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

function indexerFor(node: FakeNode, modules = EXTERNAL_MODULES, start = 26_131_900) {
  return new Indexer({
    db: database.db,
    client: node.client(),
    modules,
    deployments: NO_DEPLOYMENTS,
    sync: testSync({ start }),
    now: () => 1_760_000_000_000,
  });
}

describe("WorkRegistry receipts", () => {
  it("stores the receipt of job e9efec16 exactly as the chain has it", async () => {
    const fixture = loadLogFixture("work-recorded");
    const node = new FakeNode().load(fixture);
    const report = await indexerFor(node, [workRegistryModule], fixture.from).tick();

    expect(report.failed).toEqual([]);
    expect(report.synced).toEqual([
      { module: "receipts", fromBlock: 26_131_900, toBlock: 26_132_100, logs: 5, requests: 1, unfolded: 0 },
    ]);

    const [row] = await database.db
      .select()
      .from(receipts)
      .where(eq(receipts.jobUuid, "e9efec16-56f3-40d3-9243-52c453effc7d"));
    expect(row).toEqual({
      txHash: "0xee0fe8ac1d27324676b65c3e86d89bb2359bf708648115ec59a1ab3325f000ec",
      logIndex: 985,
      blockNumber: 26_131_975,
      blockTime: 1_791_273_263,
      jobId: "0xe9efec1656f340d3924352c453effc7d",
      jobUuid: "e9efec16-56f3-40d3-9243-52c453effc7d",
      documentHash: "0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5",
      previousHash: `0x${"0".repeat(64)}`,
      uri: "https://api.imd.fun/work-records/3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5.json",
    });
  });

  it("stores every receipt in the window, each from the WorkRegistry", async () => {
    const fixture = loadLogFixture("work-recorded");
    await indexerFor(new FakeNode().load(fixture), [workRegistryModule], fixture.from).tick();

    const rows = await database.db.select().from(receipts).orderBy(asc(receipts.blockNumber));
    expect(rows.map((row) => row.blockNumber)).toEqual([
      26_131_921, 26_131_933, 26_131_975, 26_132_086, 26_132_096,
    ]);
    // The served URI always names the document hash: the record is addressed by its own keccak.
    for (const row of rows)
      expect(row.uri).toBe(`https://api.imd.fun/work-records/${row.documentHash.slice(2)}.json`);

    const stored = await database.db.select().from(events).where(eq(events.module, "receipts"));
    expect(stored).toHaveLength(5);
    expect(new Set(stored.map((event) => event.address))).toEqual(new Set([WORK_REGISTRY.toLowerCase()]));
    expect(new Set(stored.map((event) => event.event))).toEqual(new Set(["WorkRecorded"]));
  });
});

describe("Intake requests", () => {
  it("stores every request bought on chain since the Intake was created, with its outcome", async () => {
    const fixture = loadLogFixture("intake");
    const node = new FakeNode().load(fixture);
    const report = await indexerFor(node, [intakeModule], fixture.from).tick();
    expect(report.failed).toEqual([]);
    expect(report.synced[0]?.logs).toBe(13);

    const rows = await database.db.select().from(intakeRequests).orderBy(asc(intakeRequests.requestedBlock));
    expect(rows).toHaveLength(8);
    // Three were answered, two went unanswered, three had no completion when this was recorded.
    expect(rows.map((row) => row.statusName)).toEqual([
      "unanswered",
      "unanswered",
      "answered",
      null,
      null,
      null,
      "answered",
      "answered",
    ]);
    for (const row of rows) {
      expect(row.action).toBe(ORACLE_ACTION);
      expect(row.actionName).toBe("oracle.request@oracle-1");
      expect(row.amount).toBe(500_000_000_000_000_000n);
      expect(row.asset).toBe("0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7");
      expect(row.bodyJson).not.toBeNull();
      expect(row.question).toBeTypeOf("string");
    }
  });

  it("decodes the body byte for byte and keeps the raw hex", async () => {
    const fixture = loadLogFixture("intake");
    await indexerFor(new FakeNode().load(fixture), [intakeModule], fixture.from).tick();

    const [first] = await database.db
      .select()
      .from(intakeRequests)
      .where(eq(intakeRequests.requestedBlock, 26_142_980));
    expect(first?.bodyText).toBe(
      '{"v":1,"question":"Is the symbol of the ERC-20 token at 0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7 on Ethereum mainnet IMD?","chainId":1,"window":{"hours":24},"answerType":"bool","evidence":"panel","panelSize":5,"quorum":4,"validForSeconds":86400}',
    );
    expect(first?.bodyHex).toBe(`0x${Buffer.from(first?.bodyText ?? "", "utf8").toString("hex")}`);
    expect(first?.bodyJson).toMatchObject({ v: 1, answerType: "bool", panelSize: 5, quorum: 4 });
    expect(first?.answerType).toBe("bool");
    expect(first?.payer).toBe("0x047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7");
    // No callback was asked for: the request was bought by a wallet, not by a consumer contract.
    expect(first?.callbackTarget).toBe(`0x${"0".repeat(40)}`);
    expect(first?.callbackSelector).toBe("0x00000000");
    // Unanswered: the price was spent, nothing was delivered.
    expect(first).toMatchObject({
      status: 2,
      delivered: false,
      resultHash: `0x${"0".repeat(64)}`,
      uri: "https://api.imd.fun/oracle/requests/13b6c6af-5a2f-4c42-b16e-366f4db90861",
      oracleRequestId: "13b6c6af-5a2f-4c42-b16e-366f4db90861",
      completedBlock: 26_142_993,
    });
  });

  it("records a request that a contract bought and was called back for", async () => {
    const fixture = loadLogFixture("intake");
    await indexerFor(new FakeNode().load(fixture), [intakeModule], fixture.from).tick();

    const delivered = await database.db
      .select()
      .from(intakeRequests)
      .where(eq(intakeRequests.delivered, true));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      payer: "0x70c1b03ccc02905b2ad5683156592418424c787b",
      callbackTarget: "0x70c1b03ccc02905b2ad5683156592418424c787b",
      callbackSelector: "0x510379c7",
      status: 0,
      statusName: "answered",
      oracleRequestId: "03f89e74-3db8-4c10-8fa8-d3424c9a18d4",
      requestedBlock: 26_159_930,
      completedBlock: 26_159_943,
    });
    // The recorded range holds the legacy Intake (version 1) only: version 2 did not exist yet.
    // Every stored event and every row names the contract that logged it.
    const stored = await database.db.select().from(events).where(eq(events.module, "intake"));
    expect(new Set(stored.map((event) => event.address))).toEqual(new Set([INTAKE_V1.toLowerCase()]));
    const rows = await database.db.select().from(intakeRequests);
    expect(new Set(rows.map((row) => row.intake))).toEqual(new Set([INTAKE_V1.toLowerCase()]));
  });

  it("fills a completion in even when its request is below the start block", async () => {
    const fixture = loadLogFixture("intake");
    // Start between the first request (26,142,980) and its completion (26,142,993).
    await indexerFor(new FakeNode().load(fixture), [intakeModule], 26_142_990).tick();

    const [orphan] = await database.db
      .select()
      .from(intakeRequests)
      .where(eq(intakeRequests.completedBlock, 26_142_993));
    expect(orphan).toMatchObject({
      statusName: "unanswered",
      payer: null,
      bodyHex: null,
      requestedBlock: null,
    });
    expect(await countRows(database, intakeRequests)).toBe(8);
  });
});

describe("fee transfers", () => {
  it("stores every IMD transfer to the fee payee in the recorded 7,000 blocks", async () => {
    const fixture = loadLogFixture("fee-transfers");
    const node = new FakeNode().load(fixture);
    const report = await indexerFor(node, [feeTransfersModule], fixture.from).tick();
    expect(report.failed).toEqual([]);

    const rows = await database.db.select().from(feeTransfers);
    expect(rows).toHaveLength(94);
    expect(new Set(rows.map((row) => row.to))).toEqual(new Set([FEE_PAYEE.toLowerCase()]));
    expect(rows.reduce((sum, row) => sum + row.value, 0n)).toBe(118_500_000_000_000_000_000n);
    expect(new Set(rows.map((row) => row.from)).size).toBe(33);
    // Not every payment is the 0.5 IMD of a single paid action.
    expect([...new Set(rows.map((row) => row.value))].sort((a, b) => (a < b ? -1 : 1))).toEqual([
      500_000_000_000_000_000n,
      2_000_000_000_000_000_000n,
      10_500_000_000_000_000_000n,
    ]);
  });

  it("drops a transfer to anyone else, should a node return one", async () => {
    // The node filters by recipient. The handler checks again, because a transfer to another
    // address that slipped through would be counted as a payment to the swarm.
    await feeTransfersModule.apply(database.db, {
      module: "fee_transfers",
      txHash: `0x${"ab".repeat(32)}`,
      logIndex: 1,
      txIndex: 0,
      blockNumber: 26_160_000,
      blockHash: `0x${"cd".repeat(32)}`,
      blockTime: 1_791_600_000,
      address: "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
      event: "Transfer",
      args: { from: `0x${"22".repeat(20)}`, to: `0x${"11".repeat(20)}`, value: "500000000000000000" },
      topics: [],
      data: "0x",
    });
    expect(await countRows(database, feeTransfers)).toBe(0);
  });
});

describe("all three together", () => {
  it("gives each module its own cursor and its own slice of the event store", async () => {
    const node = new FakeNode()
      .load(loadLogFixture("work-recorded"))
      .load(loadLogFixture("intake"))
      .load(loadLogFixture("fee-transfers"));
    const report = await indexerFor(node).tick();
    expect(report.failed).toEqual([]);
    expect(report.head).toBe(26_164_615);

    expect(await countRows(database, receipts)).toBe(5);
    expect(await countRows(database, intakeRequests)).toBe(8);
    expect(await countRows(database, feeTransfers)).toBe(94);
    expect(await countRows(database, events)).toBe(5 + 13 + 94);

    const rows = await database.db.select().from(cursors).orderBy(asc(cursors.module));
    expect(rows.map((row) => [row.module, row.startBlock, row.nextBlock])).toEqual([
      ["fee_transfers", 26_131_900, 26_164_616],
      ["intake", 26_131_900, 26_164_616],
      ["receipts", 26_131_900, 26_164_616],
    ]);
    // Caught up: each cursor names the hash and time of the block it reached.
    for (const row of rows) {
      expect(row.tipHash).toBe(node.hashOf(26_164_615));
      expect(row.tipTime).toBe(node.timeOf(26_164_615));
    }
  });
});
