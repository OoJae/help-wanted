/**
 * The evidence snapshot: the same data must give the same bytes, however it got into the database.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { NO_DEPLOYMENTS } from "../src/deployments.js";
import { Indexer } from "../src/engine/indexer.js";
import { stableStringify } from "../src/json.js";
import type { Logger } from "../src/log.js";
import { ALL_MODULES } from "../src/modules/index.js";
import { feeTransfers, intakeRequests } from "../src/db/schema.js";
import { buildSnapshot, chooseCut, writeSnapshot, type SnapshotCut } from "../src/snapshot.js";
import { countRows, emptyDatabase, openTestDatabase, testSync } from "./helpers/db.js";
import { FakeNode, loadLogFixture } from "./helpers/fakeNode.js";

let database: Database;
let dir: string;

beforeAll(async () => {
  database = await openTestDatabase();
  dir = await mkdtemp(join(tmpdir(), "hw-indexer-snapshot-"));
});
afterAll(async () => {
  await database.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await emptyDatabase(database);
});

const HOUSE = ["0x7B8C742f2e1eeB3FB2c10d72967fa6d4A22f0479"];

/** Fills the database from the recorded logs. `head` stops the chain at an earlier block. */
async function fill(chunkSize: number, clock: number, head?: number): Promise<FakeNode> {
  const node = new FakeNode()
    .load(loadLogFixture("work-recorded"))
    .load(loadLogFixture("intake"))
    .load(loadLogFixture("fee-transfers"));
  if (head !== undefined) node.head = head;
  const indexer = new Indexer({
    db: database.db,
    client: node.client(),
    modules: ALL_MODULES,
    deployments: NO_DEPLOYMENTS,
    sync: {
      ...testSync({ start: 26_131_900, chunkSize }),
      startBlocks: { fee_transfers: { kind: "absolute", block: 26_157_615 } },
    },
    now: () => clock,
  });
  const report = await indexer.tick();
  expect(report.failed).toEqual([]);
  return node;
}

async function texts(cut: SnapshotCut | null = null): Promise<Map<string, string>> {
  const built = await buildSnapshot(database.db, { house: HOUSE, cut });
  return new Map(built.map((file) => [file.name, stableStringify(file.value)]));
}

describe("snapshot", () => {
  it("is the same bytes whenever and in however many pieces the data was indexed", async () => {
    await fill(5000, 1_791_000_000_000);
    const first = await texts();

    await emptyDatabase(database);
    // Another run, another day, much smaller ranges, so rows were inserted in another rhythm.
    await fill(311, 1_799_999_999_999);
    const second = await texts();

    expect([...second.keys()]).toEqual([...first.keys()]);
    for (const [name, text] of first) expect([name, second.get(name) === text]).toEqual([name, true]);
  });

  it("holds the indexed rows, sorted, with amounts as decimal strings", async () => {
    await fill(5000, 1_791_000_000_000);
    const files = await texts();

    const receipts = JSON.parse(files.get("receipts.json") ?? "") as {
      rows: { blockNumber: number; jobUuid: string }[];
    };
    expect(receipts.rows.map((row) => row.blockNumber)).toEqual([
      26_131_921, 26_131_933, 26_131_975, 26_132_086, 26_132_096,
    ]);
    expect(receipts.rows[2]?.jobUuid).toBe("e9efec16-56f3-40d3-9243-52c453effc7d");

    const intake = JSON.parse(files.get("intake-requests.json") ?? "") as {
      rows: { amount: string; requestedBlock: number }[];
    };
    expect(intake.rows).toHaveLength(8);
    expect(intake.rows[0]).toMatchObject({ amount: "500000000000000000", requestedBlock: 26_142_980 });

    const report = JSON.parse(files.get("jobs-report.json") ?? "") as {
      unofficial: boolean;
      houseAddresses: string[];
      total: {
        amountImd: string;
        payments: number;
        payers: number;
        house: { amountImd: string };
        outside: { amountImd: string };
      };
      rows: { day: string; amountImd: string; complete: boolean }[];
      topPayers: { payer: string; label: string }[];
    };
    expect(report.unofficial).toBe(true);
    expect(report.houseAddresses).toEqual(["0x7b8c742f2e1eeb3fb2c10d72967fa6d4a22f0479"]);
    expect(report.total).toMatchObject({ amountImd: "118.5", payments: 94, payers: 33 });
    expect(report.total.house.amountImd).toBe("74");
    expect(report.total.outside.amountImd).toBe("44.5");
    expect(report.rows.map((row) => [row.day, row.amountImd, row.complete])).toEqual([
      ["2026-10-09", "77.5", false],
      ["2026-10-10", "41", false],
    ]);
    expect(report.topPayers[0]).toMatchObject({
      payer: "0x7b8c742f2e1eeb3fb2c10d72967fa6d4a22f0479",
      label: "HOUSE",
    });

    const coverage = JSON.parse(files.get("coverage.json") ?? "") as { rows: Record<string, unknown>[] };
    expect(coverage.rows.map((row) => row.module)).toEqual(["fee_transfers", "intake", "receipts"]);
    // Our own clock is in no file derived from the chain.
    for (const [name, text] of files) {
      if (!name.startsWith("mirror-")) expect([name, /AtMs/.test(text)]).toEqual([name, false]);
    }

    // The tables of contracts that do not exist yet are present and empty, so the pack keeps its shape.
    for (const name of [
      "orders.json",
      "claims.json",
      "pots.json",
      "chips.json",
      "feeds.json",
      "rounds.json",
      "prints.json",
      "payroll-movements.json",
      "rules.json",
      "own-events.json",
    ]) {
      expect((JSON.parse(files.get(name) ?? "") as { rows: unknown[] }).rows).toEqual([]);
    }
  });

  it("says in every file which module it was read from and whether that module's handler is finished", async () => {
    await fill(5000, 1_791_000_000_000);
    const files = await texts();
    const read = (name: string) =>
      JSON.parse(files.get(name) ?? "") as { about: string; module: string; handler: string };

    expect(read("receipts.json")).toMatchObject({ module: "receipts", handler: "ready" });
    expect(read("intake-requests.json")).toMatchObject({ module: "intake", handler: "ready" });
    expect(read("fee-transfers.json")).toMatchObject({ module: "fee_transfers", handler: "ready" });
    expect(read("jobs-report.json")).toMatchObject({ module: "fee_transfers", handler: "ready" });
    // An empty orders file must not read as "no orders": its table is not being filled yet.
    for (const [name, module] of [
      ["orders.json", "work_orders"],
      ["claims.json", "work_orders"],
      ["pots.json", "crowd_pots"],
      ["chips.json", "crowd_pots"],
      ["rules.json", "rules"],
    ] as const) {
      const file = read(name);
      expect([name, file.module, file.handler]).toEqual([name, module, "stub"]);
      expect(file.about).toMatch(/NOT INDEXED YET: the handler of module "[a-z_]+" is a stub/);
    }
    // Launch A's handlers are finished. In this store none of its contracts has an address, so its
    // files are empty because nothing was indexed, and each says so: not "nothing happened".
    for (const [name, module] of [
      ["feeds.json", "questions"],
      ["rounds.json", "questions"],
      ["prints.json", "jobs_report"],
      ["payroll-movements.json", "payroll"],
    ] as const) {
      const file = read(name);
      expect([name, file.module, file.handler]).toEqual([name, module, "ready"]);
      expect(file.about).toMatch(/NOT INDEXED: module "[a-z_]+" has indexed no block here/);
    }
    expect(read("receipts.json").about).not.toMatch(/NOT INDEXED/);

    const coverage = JSON.parse(files.get("coverage.json") ?? "") as {
      cut: unknown;
      rows: Record<string, unknown>[];
    };
    expect(coverage.cut).toBeNull();
    expect(coverage.rows[0]).toEqual({
      module: "fee_transfers",
      handler: "ready",
      fromBlock: 26_157_615,
      fromTime: expect.any(Number) as number,
      throughBlock: 26_164_615,
      throughTime: expect.any(Number) as number,
      throughHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) as string,
      events: 94,
      unfolded: 0,
    });
  });

  it("writes the files and a manifest whose hashes match them", async () => {
    await fill(5000, 1_791_000_000_000);
    const out = join(dir, "pack");
    const result = await writeSnapshot(database.db, out, { house: HOUSE });

    const onDisk = (await readdir(out)).sort();
    expect(onDisk).toEqual([...result.files.map((file) => file.name), "manifest.json"].sort());
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8")) as {
      files: { name: string; sha256: string; bytes: number; rows: number; source: string }[];
    };
    expect(manifest.files).toEqual(result.files);
    for (const file of manifest.files) {
      const bytes = await readFile(join(out, file.name));
      expect([file.name, createHash("sha256").update(bytes).digest("hex")]).toEqual([file.name, file.sha256]);
      expect(bytes.length).toBe(file.bytes);
      expect(bytes.at(-1)).toBe(0x0a);
    }
    expect(manifest.files.find((file) => file.name === "fee-transfers.json")).toMatchObject({
      rows: 94,
      source: "chain",
    });
    expect(manifest.files.find((file) => file.name === "mirror-health.json")).toMatchObject({
      rows: 0,
      source: "api",
    });

    // Writing again changes nothing on disk.
    const before = await readFile(join(out, "manifest.json"), "utf8");
    await writeSnapshot(database.db, out, { house: HOUSE });
    expect(await readFile(join(out, "manifest.json"), "utf8")).toBe(before);
  });
});

describe("a snapshot cut at a block", () => {
  // The Intake request bought in block 26,159,930 was answered in block 26,159,943. A cut between
  // the two must show it as bought and not yet answered.
  const CUT_BLOCK = 26_159_935;
  const REQUESTED = 26_159_930;

  it("holds the store as it stood at that block, and leaves the database as it is", async () => {
    const node = await fill(5000, 1_791_000_000_000);
    const cut: SnapshotCut = {
      block: CUT_BLOCK,
      hash: node.hashOf(CUT_BLOCK),
      time: node.timeOf(CUT_BLOCK),
      rule: "given",
    };
    const whole = await texts();
    const files = await texts(cut);

    const transfers = JSON.parse(files.get("fee-transfers.json") ?? "") as {
      rows: { blockNumber: number }[];
    };
    const expected = loadLogFixture("fee-transfers").logs.filter(
      (log) => Number(log.blockNumber) <= CUT_BLOCK,
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(94);
    expect(transfers.rows).toHaveLength(expected.length);
    expect(Math.max(...transfers.rows.map((row) => row.blockNumber))).toBeLessThanOrEqual(CUT_BLOCK);

    // Not a filter over today's rows: the request is there, its answer is not.
    const intake = JSON.parse(files.get("intake-requests.json") ?? "") as {
      rows: { requestedBlock: number; statusName: string | null; completedBlock: number | null }[];
    };
    const bought = intake.rows.find((row) => row.requestedBlock === REQUESTED);
    expect(bought).toMatchObject({ statusName: null, completedBlock: null });
    expect(intake.rows.every((row) => row.requestedBlock <= CUT_BLOCK)).toBe(true);
    expect(intake.rows.length).toBeLessThan(8);

    const coverage = JSON.parse(files.get("coverage.json") ?? "") as {
      cut: SnapshotCut;
      rows: {
        module: string;
        throughBlock: number;
        throughHash: string;
        throughTime: number;
        events: number;
      }[];
    };
    expect(coverage.cut).toEqual(cut);
    for (const row of coverage.rows) {
      expect(row).toMatchObject({ throughBlock: CUT_BLOCK, throughHash: cut.hash, throughTime: cut.time });
    }
    expect(coverage.rows.find((row) => row.module === "fee_transfers")?.events).toBe(expected.length);
    // All five receipts are below the cut.
    expect(coverage.rows.find((row) => row.module === "receipts")?.events).toBe(5);
    expect(files.get("receipts.json")).toBe(whole.get("receipts.json"));

    const report = JSON.parse(files.get("jobs-report.json") ?? "") as { total: { payments: number } };
    expect(report.total.payments).toBe(expected.length);

    // The rebuild happened in a transaction that was rolled back.
    expect(await countRows(database, feeTransfers)).toBe(94);
    const [answered] = await database.db
      .select()
      .from(intakeRequests)
      .where(eq(intakeRequests.requestedBlock, REQUESTED));
    expect(answered).toMatchObject({ statusName: "answered", completedBlock: 26_159_943 });
    const after = await texts();
    for (const [name, text] of whole) expect([name, after.get(name) === text]).toEqual([name, true]);
  });

  it("is the same bytes as the snapshot of a store that never went past that block", async () => {
    const node = await fill(5000, 1_791_000_000_000);
    const cut: SnapshotCut = {
      block: CUT_BLOCK,
      hash: node.hashOf(CUT_BLOCK),
      time: node.timeOf(CUT_BLOCK),
      rule: "given",
    };
    const cutBack = await texts(cut);

    await emptyDatabase(database);
    await fill(311, 1_799_999_999_999, CUT_BLOCK);
    const stoppedThere = await texts(cut);

    expect([...stoppedThere.keys()]).toEqual([...cutBack.keys()]);
    for (const [name, text] of cutBack) expect([name, stoppedThere.get(name) === text]).toEqual([name, true]);
  });

  it("says a module had indexed nothing when it began above the cut", async () => {
    await fill(5000, 1_791_000_000_000);
    // Fee transfers begin at block 26,157,615; this cut lies below that.
    const files = await texts({ block: 26_150_000, hash: null, time: null, rule: "given" });
    const coverage = JSON.parse(files.get("coverage.json") ?? "") as {
      rows: { module: string; fromBlock: number; throughBlock: number | null; events: number }[];
    };
    expect(coverage.rows.find((row) => row.module === "fee_transfers")).toMatchObject({
      fromBlock: 26_157_615,
      throughBlock: null,
      events: 0,
    });
    expect((JSON.parse(files.get("fee-transfers.json") ?? "") as { rows: unknown[] }).rows).toEqual([]);
    // Without the cut block's time no day can be called complete, and none is.
    const report = JSON.parse(files.get("jobs-report.json") ?? "") as { rows: { complete: boolean }[] };
    expect(report.rows.every((row) => !row.complete)).toBe(true);
  });

  it("names the cut in the manifest and in what the command prints", async () => {
    await fill(5000, 1_791_000_000_000);
    const cut: SnapshotCut = {
      block: CUT_BLOCK,
      hash: `0x${"ab".repeat(32)}`,
      time: 1_791_600_000,
      rule: "finalized",
    };
    const out = join(dir, "cut");
    const result = await writeSnapshot(database.db, out, { house: HOUSE, cut });
    expect(result.cut).toEqual(cut);
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8")) as { cut: SnapshotCut };
    expect(manifest.cut).toEqual(cut);
  });
});

describe("choosing the cut", () => {
  function listening() {
    const warnings: string[] = [];
    const log: Logger = {
      debug() {},
      info() {},
      warn: (message) => warnings.push(message),
      error() {},
    };
    return { log, warnings };
  }

  it("takes the node's finalized block when none is named", async () => {
    const node = new FakeNode();
    node.head = 1000;
    node.finalized = 920;
    expect(await chooseCut(node.client())).toEqual({
      block: 920,
      hash: node.hashOf(920),
      time: node.timeOf(920),
      rule: "finalized",
    });
  });

  it("will not take a snapshot without a final block to cut at", async () => {
    const node = new FakeNode();
    node.head = 1000;
    node.intercept = () => {
      throw new Error("fetch failed");
    };
    await expect(chooseCut(node.client())).rejects.toThrow(
      /could not read the finalized block from the node.+--through <block>/,
    );
  });

  it("takes a block the operator names, with its hash, and warns when it is not final yet", async () => {
    const node = new FakeNode();
    node.head = 1000;
    node.finalized = 920;
    const quiet = listening();
    expect(await chooseCut(node.client(), 900, quiet.log)).toEqual({
      block: 900,
      hash: node.hashOf(900),
      time: node.timeOf(900),
      rule: "given",
    });
    expect(quiet.warnings).toEqual([]);

    const early = listening();
    expect((await chooseCut(node.client(), 990, early.log)).block).toBe(990);
    expect(early.warnings).toEqual([
      "the block named with --through is not final yet; the chain may still replace it",
    ]);
  });

  it("names the operator's block without its hash when the node cannot be asked", async () => {
    const node = new FakeNode();
    node.head = 1000;
    node.intercept = () => {
      throw new Error("fetch failed");
    };
    const offline = listening();
    expect(await chooseCut(node.client(), 900, offline.log)).toEqual({
      block: 900,
      hash: null,
      time: null,
      rule: "given",
    });
    expect(offline.warnings).toHaveLength(1);
  });
});

describe("stableStringify", () => {
  it("sorts keys at every depth and writes bigints as strings", () => {
    const a = stableStringify({ b: 1, a: { d: [3, { z: 1n, y: 2 }], c: null } });
    const b = stableStringify({ a: { c: null, d: [3, { y: 2, z: 1n }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe(
      '{\n  "a": {\n    "c": null,\n    "d": [\n      3,\n      {\n        "y": 2,\n        "z": "1"\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
  });
});
