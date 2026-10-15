/**
 * What must not take the rest down with it: a log the handler cannot fold, a request body built
 * to be awkward, a node that stops answering, a module that keeps failing, and a node whose error
 * text holds what it should not.
 */
import { asc, eq, sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  numberToHex,
  parseAbi,
  stringToHex,
  toHex,
  type Address,
} from "viem";
import { mainnet } from "viem/chains";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IMD, INTAKE, ORACLE_ACTION } from "../src/constants.js";
import type { Database } from "../src/db/client.js";
import { int53 } from "../src/db/columns.js";
import { cursors, events, intakeRequests } from "../src/db/schema.js";
import { NO_DEPLOYMENTS } from "../src/deployments.js";
import { Indexer, MAX_MODULE_BACKOFF_MS } from "../src/engine/indexer.js";
import type { ContractModule } from "../src/engine/module.js";
import { createApp, DEFAULT_STALE_AFTER_MS } from "../src/http/app.js";
import { stableStringify } from "../src/json.js";
import { clearSecrets, registerSecrets, secretsOfUrl } from "../src/log.js";
import { feeTransfersModule, intakeModule } from "../src/modules/index.js";
import { intakeAbi } from "../src/modules/intake.js";
import { createQueries } from "../src/queries.js";
import { buildSnapshot } from "../src/snapshot.js";
import { countRows, emptyDatabase, openTestDatabase, testSync } from "./helpers/db.js";
import { FakeNode } from "./helpers/fakeNode.js";

let database: Database;

beforeAll(async () => {
  database = await openTestDatabase();
  await database.db.execute(
    sql`create table if not exists picky_state (id text primary key, transfers bigint not null, last_block bigint not null)`,
  );
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await emptyDatabase(database);
  await database.db.delete(pickyState);
});
afterEach(() => {
  clearSecrets();
});

const ALICE: Address = "0x00000000000000000000000000000000000a11ce";
const BOB: Address = "0x0000000000000000000000000000000000000b0b";
const HALF = 500_000_000_000_000_000n;

async function cursorOf(module: string) {
  const [row] = await database.db.select().from(cursors).where(eq(cursors.module, module));
  if (!row) throw new Error(`no cursor for ${module}`);
  return row;
}

/** A `Requested` log of the real Intake ABI carrying `body`, as any buyer can emit for the price. */
function addRequested(node: FakeNode, block: number, body: string, salt: string): void {
  const topics = encodeEventTopics({
    abi: intakeAbi,
    eventName: "Requested",
    args: { requestId: keccak256(toHex(`request:${salt}`)), payer: ALICE, action: ORACLE_ACTION },
  });
  const data = encodeAbiParameters(
    [{ type: "bytes" }, { type: "address" }, { type: "bytes4" }, { type: "address" }, { type: "uint256" }],
    [stringToHex(body), `0x${"0".repeat(40)}`, "0x00000000", IMD, HALF],
  );
  node.addLog({
    address: INTAKE.toLowerCase(),
    topics: topics as string[],
    data,
    blockNumber: numberToHex(block),
    blockHash: node.hashOf(block),
    blockTimestamp: numberToHex(node.timeOf(block)),
    transactionHash: keccak256(toHex(`tx:${salt}`)),
    transactionIndex: "0x0",
    logIndex: "0x0",
    removed: false,
  });
}

function intakeIndexer(node: FakeNode) {
  return new Indexer({
    db: database.db,
    client: node.client(),
    modules: [intakeModule],
    deployments: NO_DEPLOYMENTS,
    sync: testSync({ start: 900 }),
  });
}

describe("a request body built to be awkward", () => {
  // The Intake takes any body of 1 to 16,384 bytes for 0.5 IMD and emits it whole. 8,191 nested
  // arrays fit in 16,382 bytes. Walking such a value overflows the stack, and the handler runs
  // inside the transaction that moves the cursor: before the decoder refused deep values, one
  // such request stopped the module on that block for good.
  it("stores a body nested as deep as 16 KB allows as text, and reads on", async () => {
    const node = new FakeNode();
    node.head = 1000;
    const deep = "[".repeat(8191) + "]".repeat(8191);
    addRequested(node, 950, deep, "nested");
    addRequested(node, 960, '{"v":1,"question":"Is this indexed?","answerType":"bool"}', "plain");
    const indexer = intakeIndexer(node);

    for (let pass = 0; pass < 3; pass++) {
      node.head += 10;
      const report = await indexer.tick();
      expect(report.failed).toEqual([]);
      expect(report.synced.map((progress) => progress.unfolded)).toEqual([0]);
    }
    expect((await cursorOf("intake")).nextBlock).toBe(1031);

    const rows = await database.db.select().from(intakeRequests).orderBy(asc(intakeRequests.requestedBlock));
    expect(rows).toHaveLength(2);
    // The bytes are all there; only the parsed copy is declined.
    expect(rows[0]).toMatchObject({
      requestedBlock: 950,
      payer: ALICE,
      bodyHex: stringToHex(deep),
      bodyText: deep,
      bodyJson: null,
      question: null,
    });
    expect(rows[1]).toMatchObject({ requestedBlock: 960, question: "Is this indexed?", answerType: "bool" });
    expect(rows[1]?.bodyJson).toEqual({ v: 1, question: "Is this indexed?", answerType: "bool" });
    const stored = await database.db.select().from(events);
    expect(stored.map((event) => event.foldError)).toEqual([null, null]);
  });

  // A shallower body used to get through the handler and break the readers instead: the list
  // route answered 500 and the snapshot could not be written, because they walk the stored JSON.
  it("keeps the list route and the snapshot working when the body is 3,000 levels deep", async () => {
    const node = new FakeNode();
    node.head = 1000;
    addRequested(node, 950, "[".repeat(3000) + "]".repeat(3000), "shallower");
    expect((await intakeIndexer(node).tick()).failed).toEqual([]);

    const app = createApp({ queries: createQueries(database.db) });
    const response = await app(new Request("http://indexer.test/v1/intake/requests"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { requests: { bodyJson: unknown; bodyText: string }[] };
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]?.bodyJson).toBeNull();
    expect(body.requests[0]?.bodyText).toHaveLength(6000);

    const files = await buildSnapshot(database.db);
    for (const file of files) expect(() => stableStringify(file.value)).not.toThrow();
  });

  it("keeps a body at the depth limit as JSON and declines one level more", async () => {
    const node = new FakeNode();
    node.head = 1000;
    const nested = (levels: number) => `${"[".repeat(levels)}1${"]".repeat(levels)}`;
    addRequested(node, 950, nested(32), "at the limit");
    addRequested(node, 951, nested(33), "one more");
    expect((await intakeIndexer(node).tick()).failed).toEqual([]);
    const rows = await database.db.select().from(intakeRequests).orderBy(asc(intakeRequests.requestedBlock));
    expect(rows[0]?.bodyJson).not.toBeNull();
    expect(rows[1]?.bodyJson).toBeNull();
    expect(rows[1]?.bodyText).toBe(nested(33));
  });

  it("answers 500, not a dead process, for a deep row an older version stored, and a rebuild repairs it", async () => {
    const node = new FakeNode();
    node.head = 1000;
    const deep = "[".repeat(3000) + "]".repeat(3000);
    addRequested(node, 950, deep, "legacy");
    const indexer = intakeIndexer(node);
    await indexer.tick();
    // What the table held before deep values were declined.
    await database.db.execute(sql`update intake_requests set body_json = ${deep}::jsonb`);

    const app = createApp({ queries: createQueries(database.db) });
    const before = await app(new Request("http://indexer.test/v1/intake/requests"));
    expect(before.status).toBe(500);
    expect(await before.json()).toEqual({ error: "internal error" });

    expect(await indexer.reproject(["intake"])).toEqual({ intake: { folded: 1, unfolded: 0 } });
    expect((await app(new Request("http://indexer.test/v1/intake/requests"))).status).toBe(200);
  });
});

// A module that reads every IMD transfer and cannot fold two kinds of them.
const pickyState = pgTable("picky_state", {
  id: text("id").primaryKey(),
  transfers: int53("transfers").notNull(),
  lastBlock: int53("last_block").notNull(),
});

const UNLUCKY = 13n;
const UNSTORABLE = 14n;

function pickyModule(lenient = false): ContractModule {
  return {
    name: "picky",
    title: "counts IMD transfers, except the ones it cannot",
    abi: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]),
    filter: () => ({ address: IMD }),
    tables: [pickyState],
    async apply(db, event) {
      if (event.event !== "Transfer") return;
      const value = BigInt((event.args as { value: string | number }).value);
      const [current] = await db.select().from(pickyState).where(eq(pickyState.id, "all"));
      const next = { transfers: (current?.transfers ?? 0) + 1, lastBlock: event.blockNumber };
      await db
        .insert(pickyState)
        .values({ id: "all", ...next })
        .onConflictDoUpdate({ target: pickyState.id, set: next });
      if (lenient) return;
      // Throws after it has written: the write must not survive.
      if (value === UNLUCKY) throw new Error("unlucky amount");
      // Or hands the database a row it refuses, which aborts the statement, not the range.
      if (value === UNSTORABLE) await db.execute(sql`insert into picky_state (id) values ('broken')`);
    },
  };
}

async function pickyRows() {
  return database.db.select().from(pickyState).orderBy(asc(pickyState.id));
}

describe("a log the handler cannot fold", () => {
  function pickyNode() {
    const node = new FakeNode();
    node.head = 200;
    node.addFeeTransfer({ block: 110, from: ALICE, value: HALF });
    node.addFeeTransfer({ block: 120, from: BOB, value: UNLUCKY });
    node.addFeeTransfer({ block: 130, from: BOB, value: UNSTORABLE });
    node.addFeeTransfer({ block: 140, from: ALICE, value: HALF });
    return node;
  }
  const build = (node: FakeNode, module: ContractModule) =>
    new Indexer({
      db: database.db,
      client: node.client(),
      modules: [module],
      deployments: NO_DEPLOYMENTS,
      sync: testSync({ start: 100 }),
    });

  it("is stored with the reason, undone in the tables, and does not stop the module", async () => {
    const node = pickyNode();
    const indexer = build(node, pickyModule());
    const report = await indexer.tick();

    expect(report.failed).toEqual([]);
    expect(report.synced).toEqual([
      { module: "picky", fromBlock: 100, toBlock: 200, logs: 4, requests: 1, unfolded: 2 },
    ]);
    // The cursor moved past all four, and the two good ones are counted: the handler's own write
    // for the log at block 120 was rolled back with it.
    expect((await cursorOf("picky")).nextBlock).toBe(201);
    expect(await pickyRows()).toEqual([{ id: "all", transfers: 2, lastBlock: 140 }]);

    const stored = await database.db.select().from(events).orderBy(asc(events.blockNumber));
    expect(stored.map((event) => event.blockNumber)).toEqual([110, 120, 130, 140]);
    expect(stored[0]?.foldError).toBeNull();
    expect(stored[1]?.foldError).toBe("unlucky amount");
    expect(stored[2]?.foldError).toMatch(/^a database query failed \(.+\)$/);
    expect(stored[3]?.foldError).toBeNull();

    // A later pass does not fold them again, and later logs are still read.
    node.addFeeTransfer({ block: 205, from: ALICE, value: HALF });
    const next = await indexer.tick();
    expect(next.synced[0]).toMatchObject({ logs: 1, unfolded: 0 });
    expect(await pickyRows()).toEqual([{ id: "all", transfers: 3, lastBlock: 205 }]);
  });

  it("is counted wherever coverage is reported, and the status route stops saying ok", async () => {
    const node = pickyNode();
    const indexer = build(node, pickyModule());
    await indexer.tick();
    const queries = createQueries(database.db, { modules: [pickyModule()] });

    expect(await queries.coverage()).toMatchObject([{ module: "picky", events: 4, unfolded: 2 }]);
    expect(await queries.source("picky")).toMatchObject({ handler: "ready", unfolded: 2 });
    const app = createApp({ queries, live: () => indexer.live() });
    const status = (await (await app(new Request("http://indexer.test/v1/status"))).json()) as {
      ok: boolean;
      modules: { module: string; unfolded: number; blocksBehind: number }[];
    };
    expect(status.modules).toMatchObject([{ module: "picky", unfolded: 2, blocksBehind: 0 }]);
    // Synced to the head, and still not ok: two logs are missing from the tables.
    expect(status.ok).toBe(false);

    const listed = (await (await app(new Request("http://indexer.test/v1/events?module=picky"))).json()) as {
      events: { blockNumber: number; foldError: string | null }[];
    };
    expect(
      listed.events.filter((event) => event.foldError !== null).map((event) => event.blockNumber),
    ).toEqual([130, 120]);
  });

  it("is tried again by a rebuild, and folded once the handler can", async () => {
    const node = pickyNode();
    await build(node, pickyModule()).tick();

    // The same handler gives the same answer: a rebuild is deterministic.
    expect(await build(node, pickyModule()).reproject(["picky"])).toEqual({
      picky: { folded: 2, unfolded: 2 },
    });
    expect(await pickyRows()).toEqual([{ id: "all", transfers: 2, lastBlock: 140 }]);

    // A corrected handler folds all four, in chain order, and the reasons are cleared.
    expect(await build(node, pickyModule(true)).reproject(["picky"])).toEqual({
      picky: { folded: 4, unfolded: 0 },
    });
    expect(await pickyRows()).toEqual([{ id: "all", transfers: 4, lastBlock: 140 }]);
    const stored = await database.db.select().from(events);
    expect(stored.every((event) => event.foldError === null)).toBe(true);
  });
});

describe("a node that stops answering", () => {
  function outage() {
    let clock = 1_791_000_000_000;
    const node = new FakeNode();
    node.head = 1000;
    node.addFeeTransfer({ block: 990, from: ALICE, value: HALF });
    const indexer = new Indexer({
      db: database.db,
      client: node.client(),
      modules: [feeTransfersModule],
      deployments: NO_DEPLOYMENTS,
      sync: testSync({ start: 900 }),
      now: () => clock,
    });
    const app = createApp({
      queries: createQueries(database.db),
      live: () => indexer.live(),
      now: () => clock,
    });
    const status = async () =>
      (await (await app(new Request("http://indexer.test/v1/status"))).json()) as {
        ok: boolean;
        head: number;
        headAgeSeconds: number;
        lastGoodPassAgeSeconds: number;
        lastPassError: string | null;
        modules: { module: string; blocksBehind: number; lastError: string | null }[];
      };
    return {
      node,
      indexer,
      status,
      advance: (ms: number) => {
        clock += ms;
      },
      now: () => clock,
    };
  }

  // `tick()` used to read the head before noting that a pass had begun, so a failed head read
  // left the last good pass standing: the status route said ok, 0 blocks behind, for as long as
  // the node stayed away.
  it("is reported from the first failed pass, and for as long as it lasts", async () => {
    const { node, indexer, status, advance, now } = outage();
    await indexer.tick();
    const lastGoodPass = now();
    expect(await status()).toMatchObject({ ok: true, headAgeSeconds: 0, lastPassError: null });

    node.intercept = () => {
      throw new Error("fetch failed");
    };
    advance(60_000);
    await expect(indexer.tick()).rejects.toThrow();
    // One minute in: not stale yet by the clock, but the last pass did not run.
    expect(indexer.live()).toMatchObject({
      lastTickOk: false,
      lastTickAtMs: now(),
      lastOkTickAtMs: lastGoodPass,
      head: 1000,
      headAtMs: lastGoodPass,
    });
    expect(await status()).toMatchObject({ ok: false, lastPassError: "An unknown RPC error occurred." });

    for (let pass = 0; pass < 4; pass++) {
      advance(60_000);
      await expect(indexer.tick()).rejects.toThrow();
    }
    advance(6 * 3_600_000);
    const sixHoursIn = await status();
    expect(sixHoursIn.ok).toBe(false);
    expect(sixHoursIn.lastGoodPassAgeSeconds).toBe(6 * 3600 + 300);
    expect(sixHoursIn.headAgeSeconds).toBe(6 * 3600 + 300);
    // The head last read is 1000, which is where the module is; the chain has not stood still.
    expect(sixHoursIn.modules[0]).toMatchObject({ module: "fee_transfers", blocksBehind: 1825 });

    // The node comes back: one good pass and the route says ok again.
    node.intercept = null;
    node.head = 1010;
    await indexer.tick();
    expect(await status()).toMatchObject({ ok: true, head: 1010, lastPassError: null });
  });

  it("is noticed even when no pass fails, because the last good pass grows old", async () => {
    // A loop that hangs (a request that never returns) fails nothing. The age of the last good
    // pass is what gives it away.
    const { indexer, status, advance } = outage();
    await indexer.tick();
    advance(DEFAULT_STALE_AFTER_MS);
    expect(await status()).toMatchObject({ ok: true, lastGoodPassAgeSeconds: 240 });
    advance(1000);
    expect(await status()).toMatchObject({ ok: false, lastGoodPassAgeSeconds: 241 });
  });
});

describe("a pass under way", () => {
  /** A node whose answers to `eth_getLogs` wait for `release()`, or fail when `cut()` is called. */
  function heldNode() {
    const node = new FakeNode();
    node.head = 1000;
    node.addFeeTransfer({ block: 990, from: ALICE, value: HALF });
    const inner = node.client();
    let holding = false;
    let settle: { release: () => void; cut: (error: Error) => void } | null = null;
    const client = createPublicClient({
      chain: mainnet,
      transport: custom(
        {
          request: async (args: { method: string }) => {
            if (holding && args.method === "eth_getLogs") {
              await new Promise<void>((resolve, reject) => {
                settle = { release: resolve, cut: reject };
              });
            }
            return (inner.request as (a: unknown) => Promise<unknown>)(args);
          },
        },
        { retryCount: 0 },
      ),
    });
    const waitUntilHeld = async () => {
      while (settle === null) await new Promise((resolve) => setTimeout(resolve, 1));
      return settle as { release: () => void; cut: (error: Error) => void };
    };
    return {
      node,
      client,
      hold: () => {
        holding = true;
        settle = null;
      },
      waitUntilHeld,
    };
  }

  it("does not make the status route flicker: ok speaks of the last pass that ended", async () => {
    const { node, client, hold, waitUntilHeld } = heldNode();
    const indexer = new Indexer({
      db: database.db,
      client,
      modules: [feeTransfersModule],
      deployments: NO_DEPLOYMENTS,
      sync: testSync({ start: 900 }),
    });
    const app = createApp({ queries: createQueries(database.db), live: () => indexer.live() });
    const ok = async () =>
      ((await (await app(new Request("http://indexer.test/v1/status"))).json()) as { ok: boolean }).ok;
    await indexer.tick();
    expect(await ok()).toBe(true);

    node.head = 1001;
    hold();
    const pass = indexer.tick();
    const held = await waitUntilHeld();
    // The next pass is waiting on the node. Nothing has failed, and the route does not say so.
    expect(indexer.live().lastTickOk).toBe(true);
    expect(await ok()).toBe(true);
    held.release();
    expect((await pass).failed).toEqual([]);
    expect(await ok()).toBe(true);
  });

  it("is dropped without a mark against any module when the process is stopping", async () => {
    const { node, client, hold, waitUntilHeld } = heldNode();
    const controller = new AbortController();
    const indexer = new Indexer({
      db: database.db,
      client,
      modules: [feeTransfersModule, pickyModule(true)],
      deployments: NO_DEPLOYMENTS,
      sync: testSync({ start: 900 }),
      signal: controller.signal,
    });
    await indexer.tick();
    const before = await cursorOf("fee_transfers");

    node.head = 1001;
    hold();
    const pass = indexer.tick().catch((error: unknown) => error);
    const held = await waitUntilHeld();
    controller.abort();
    held.cut(new Error("the request was aborted"));
    expect(await pass).toBeInstanceOf(Error);

    // The pass ended by throwing; the second module was not begun; nothing was concluded from it.
    const live = indexer.live();
    expect(live.lastTickOk).toBe(true);
    expect(live.lastTickError).toBeNull();
    expect(live.modules.map((module) => [module.module, module.lastError, module.failures])).toEqual([
      ["fee_transfers", null, 0],
      ["picky", null, 0],
    ]);
    expect(await cursorOf("fee_transfers")).toEqual(before);
    // A later call does not start work either.
    await expect(indexer.tick()).rejects.toThrow();
  });
});

describe("a module that keeps failing", () => {
  it("is left alone for a growing interval while the others keep their cadence", async () => {
    let clock = 1_791_000_000_000;
    const node = new FakeNode();
    node.head = 50_000;
    node.historyFloor = 40_000;
    node.addFeeTransfer({ block: 45_000, from: ALICE, value: HALF });
    const indexer = new Indexer({
      db: database.db,
      client: node.client(),
      // The fee module starts below what the node serves; the other one does not.
      modules: [feeTransfersModule, pickyModule(true)],
      deployments: NO_DEPLOYMENTS,
      sync: {
        ...testSync({ start: 10_000 }),
        pollIntervalMs: 12_000,
        startBlocks: { picky: { kind: "behind", blocks: 6000 } },
      },
      now: () => clock,
    });
    const feeQueries = () =>
      node.requests.filter(
        (request) =>
          request.method === "eth_getLogs" &&
          (request.params as [{ topics?: unknown }])[0].topics !== undefined,
      ).length;

    // The first failures are retried on the very next pass. (Each try is two requests: a
    // refusal for missing history is asked about once more before it is believed.)
    for (let pass = 1; pass <= 3; pass++) {
      const report = await indexer.tick();
      expect(report.failed.map((failure) => failure.module)).toEqual(["fee_transfers"]);
      expect(report.waiting).toEqual([]);
      expect(report.synced.map((progress) => progress.module)).toEqual(["picky"]);
      expect(feeQueries()).toBe(2 * pass);
    }
    expect(indexer.live().modules[0]).toMatchObject({ failures: 3, retryAtMs: clock + 24_000 });

    // From the third failure on the module waits; the healthy one is synced on every pass.
    clock += 12_000;
    node.addFeeTransfer({ block: 50_010, from: BOB, value: HALF });
    const skipped = await indexer.tick();
    expect(skipped.failed).toEqual([]);
    expect(skipped.waiting).toEqual([{ module: "fee_transfers", retryInMs: 12_000 }]);
    expect(skipped.synced).toMatchObject([{ module: "picky", logs: 1 }]);
    expect(feeQueries()).toBe(6);
    // A pass with a module waiting is not a good pass.
    expect(indexer.live().lastTickOk).toBe(false);

    // When its time comes it is tried again, and each further failure doubles the wait.
    clock += 12_000;
    expect((await indexer.tick()).failed).toHaveLength(1);
    expect(feeQueries()).toBe(8);
    expect(indexer.live().modules[0]).toMatchObject({ failures: 4, retryAtMs: clock + 48_000 });

    // The wait never exceeds five minutes.
    for (let pass = 0; pass < 8; pass++) {
      clock += MAX_MODULE_BACKOFF_MS;
      await indexer.tick();
    }
    expect(indexer.live().modules[0]?.retryAtMs).toBe(clock + MAX_MODULE_BACKOFF_MS);

    // Once the node serves the range the module recovers and the slate is clean.
    node.historyFloor = null;
    clock += MAX_MODULE_BACKOFF_MS;
    const recovered = await indexer.tick();
    expect(recovered.failed).toEqual([]);
    expect(recovered.waiting).toEqual([]);
    expect(indexer.live()).toMatchObject({ lastTickOk: true });
    expect(indexer.live().modules[0]).toMatchObject({ failures: 0, retryAtMs: null, lastError: null });
  });
});

describe("what a node's error text may reach", () => {
  // A gateway in front of a keyed provider can answer with a page that repeats the request path,
  // and the path is the key.
  function leakyNode() {
    const node = new FakeNode();
    node.head = 1000;
    node.intercept = (method) => {
      if (method === "eth_getLogs") throw new Error("upstream error for /v2/SECRETKEY123456\nsecond line");
    };
    return node;
  }
  const build = (node: FakeNode) =>
    new Indexer({
      db: database.db,
      client: node.client(),
      modules: [feeTransfersModule],
      deployments: NO_DEPLOYMENTS,
      sync: testSync({ start: 900 }),
    });

  it("never reaches the public status route", async () => {
    const node = leakyNode();
    const indexer = build(node);
    await indexer.tick();
    const app = createApp({ queries: createQueries(database.db), live: () => indexer.live() });
    const text = await (await app(new Request("http://indexer.test/v1/status"))).text();
    expect(text).not.toMatch(/SECRETKEY|upstream/);
    // What is shown is viem's own sentence for the class of error.
    expect(indexer.live().modules[0]?.lastError).toBe("An unknown RPC error occurred.");
  });

  it("reaches the operator's log on one line, cut, and without a configured key", async () => {
    const node = leakyNode();
    // The report is what `once` prints: the node's words are there for the operator.
    const plain = await build(node).tick();
    expect(plain.failed[0]?.error).toBe(
      "An unknown RPC error occurred. (upstream error for /v2/SECRETKEY123456 second line)",
    );

    // With the RPC URL configured, its key is cut out wherever it turns up.
    registerSecrets(secretsOfUrl("https://keyed.example/v2/SECRETKEY123456"));
    const redacted = await build(node).tick();
    expect(redacted.failed[0]?.error).toBe(
      "An unknown RPC error occurred. (upstream error for [redacted] second line)",
    );
  });
});
