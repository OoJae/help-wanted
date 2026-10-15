/**
 * The read-only API and the query functions behind it, over a database filled from the recorded
 * logs. Requests are handed straight to the app function: no socket is opened, except in the one
 * test that checks the server adapter on a loopback port.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { NO_DEPLOYMENTS } from "../src/deployments.js";
import { Indexer } from "../src/engine/indexer.js";
import { createApp } from "../src/http/app.js";
import { answer } from "../src/http/server.js";
import { ALL_MODULES } from "../src/modules/index.js";
import { createQueries } from "../src/queries.js";
import { openTestDatabase, testSync } from "./helpers/db.js";
import { FakeNode, loadLogFixture } from "./helpers/fakeNode.js";

const TOP_PAYER = "0x7b8c742f2e1eeb3fb2c10d72967fa6d4a22f0479";
const NOW = 1_791_670_000_000;

let database: Database;
let indexer: Indexer;
let node: FakeNode;
let app: (request: Request) => Promise<Response>;

beforeAll(async () => {
  database = await openTestDatabase();
  node = new FakeNode()
    .load(loadLogFixture("work-recorded"))
    .load(loadLogFixture("intake"))
    .load(loadLogFixture("fee-transfers"));
  indexer = new Indexer({
    db: database.db,
    client: node.client(),
    modules: ALL_MODULES,
    deployments: NO_DEPLOYMENTS,
    // Receipts and Intake from the start of their fixtures; fee transfers over their own window.
    sync: {
      ...testSync({ start: 26_131_900 }),
      startBlocks: { fee_transfers: { kind: "absolute", block: 26_157_615 } },
    },
    // The engine and the API share one made-up clock, so "how long ago" never depends on the day
    // the tests are run.
    now: () => NOW,
  });
  await indexer.tick();
  app = createApp({
    queries: createQueries(database.db, { house: [TOP_PAYER.toUpperCase().replace("0X", "0x")] }),
    live: () => indexer.live(),
    now: () => NOW,
  });
});

afterAll(async () => {
  await database.close();
});

async function get(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await app(new Request(`http://indexer.test${path}`, init));
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

describe("the API as a whole", () => {
  it("lists its routes at the root", async () => {
    const { status, body } = await get("/");
    expect(status).toBe(200);
    const paths = (body.routes as { path: string }[]).map((route) => route.path);
    for (const path of [
      "/v1/status",
      "/v1/orders",
      "/v1/receipts",
      "/v1/feeds",
      "/v1/rounds",
      "/v1/jobs-report/daily",
    ]) {
      expect(paths).toContain(path);
    }
    expect((await get("/v1")).body).toEqual(body);
  });

  it("answers in JSON, to any origin, and only to reads", async () => {
    const ok = await get("/v1/receipts");
    expect(ok.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const refused = await get("/v1/receipts", { method });
      expect(refused.status).toBe(405);
      expect(refused.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    }
    const preflight = await app(new Request("http://indexer.test/v1/receipts", { method: "OPTIONS" }));
    expect(preflight.status).toBe(204);
    const head = await app(new Request("http://indexer.test/v1/receipts", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("says 404 for a route it does not have and 400 for a parameter it cannot read", async () => {
    expect((await get("/v1/nothing")).status).toBe(404);
    expect((await get("/admin")).status).toBe(404);
    for (const path of [
      "/v1/receipts?limit=0",
      "/v1/receipts?limit=5000",
      "/v1/receipts?limit=ten",
      "/v1/receipts?fromBlock=-1",
      "/v1/receipts/not-a-job",
      "/v1/intake/requests?payer=0x123",
      "/v1/intake/requests/0xabc",
      "/v1/orders?state=Paid",
      "/v1/orders/first",
      "/v1/events?module=Robert'); DROP TABLE events;--",
      "/v1/jobs-report/window?fromBlock=10",
      "/v1/jobs-report/window?fromBlock=10&toBlock=9",
      "/v1/mirror/jobs/123",
      "/v1/feeds/0x12/rounds",
      "/v1/payroll/movements?kind=bribed",
    ]) {
      const { status, body } = await get(path);
      expect([path, status]).toEqual([path, 400]);
      expect(body.error).toBeTypeOf("string");
    }
    expect((await get(`/v1/${"a".repeat(600)}`)).status).toBe(414);
    expect((await get("/v1/receipts/%E0%A4%A")).status).toBe(400);
  });
});

describe("status", () => {
  it("reports each module's range, its handler and how far behind it is", async () => {
    const { body } = await get("/v1/status");
    expect(body.ok).toBe(true);
    expect(body.chainId).toBe(1);
    expect(body.head).toBe(26_164_615);
    const byName = Object.fromEntries(
      (body.modules as { module: string }[]).map((module) => [module.module, module]),
    );
    expect(byName.receipts).toMatchObject({
      enabled: true,
      handler: "ready",
      fromBlock: 26_131_900,
      throughBlock: 26_164_615,
      blocksBehind: 0,
      events: 5,
      lastError: null,
    });
    expect(byName.fee_transfers).toMatchObject({ fromBlock: 26_157_615, events: 94 });
    expect(byName.intake).toMatchObject({ events: 13 });
    // Our own contracts are listed, idle and honest about their handlers.
    expect(byName.work_orders).toMatchObject({
      enabled: false,
      handler: "stub",
      throughBlock: null,
      events: 0,
    });
    // Launch A's handlers are finished; with no address in this configuration the module is idle.
    expect(byName.questions).toMatchObject({
      enabled: false,
      handler: "ready",
      throughBlock: null,
      events: 0,
    });
    expect(body.rows).toMatchObject({
      events: 112,
      receipts: 5,
      intake_requests: 8,
      fee_transfers: 94,
      orders: 0,
    });
    expect(body).toMatchObject({ headAgeSeconds: 0, lastGoodPassAgeSeconds: 0, lastPassError: null });
    // Nothing is waiting on a handler, nothing lies outside coverage, no backfill is under way.
    expect(byName.receipts).toMatchObject({ unfolded: 0, eventsOutside: 0, backfill: null });
    // This app was not told whether the mirror runs, and says so rather than guess.
    expect(body.mirror).toEqual({
      enabled: null,
      ok: null,
      healthAgeSeconds: null,
      jobsAgeSeconds: null,
      oracleRequestsAgeSeconds: null,
    });
  });

  it("is not ok once a module is more than 20 blocks behind", async () => {
    const statusWithHead = async (head: number) => {
      const app = createApp({
        queries: createQueries(database.db),
        live: () => ({ ...indexer.live(), head }),
        now: () => NOW,
      });
      return (await (await app(new Request("http://indexer.test/v1/status"))).json()) as { ok: boolean };
    };
    expect((await statusWithHead(26_164_615 + 20)).ok).toBe(true);
    expect((await statusWithHead(26_164_615 + 21)).ok).toBe(false);
  });

  it("says whether the mirror is fresh when it is told the mirror runs", async () => {
    const mirrored = createApp({
      queries: createQueries(database.db),
      live: () => indexer.live(),
      mirrorEnabled: true,
      now: () => NOW,
    });
    const body = (await (await mirrored(new Request("http://indexer.test/v1/status"))).json()) as {
      ok: boolean;
      mirror: { enabled: boolean; ok: boolean };
    };
    // Nothing has been mirrored in this database: the mirror is not ok, the chain sync is.
    expect(body.mirror).toMatchObject({ enabled: true, ok: false });
    expect(body.ok).toBe(true);
  });
});

describe("receipts", () => {
  it("lists them newest first and finds a job by either spelling of its id", async () => {
    const { body } = await get("/v1/receipts?limit=2");
    expect((body.receipts as { blockNumber: number }[]).map((receipt) => receipt.blockNumber)).toEqual([
      26_132_096, 26_132_086,
    ]);

    const byUuid = await get("/v1/receipts/e9efec16-56f3-40d3-9243-52c453effc7d");
    const byBytes = await get("/v1/receipts/0xE9EFEC1656F340D3924352C453EFFC7D");
    expect(byBytes.body).toEqual(byUuid.body);
    expect(byUuid.body.jobId).toBe("0xe9efec1656f340d3924352c453effc7d");
    expect(byUuid.body.latest).toMatchObject({
      documentHash: "0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5",
      blockNumber: 26_131_975,
      txHash: "0xee0fe8ac1d27324676b65c3e86d89bb2359bf708648115ec59a1ab3325f000ec",
    });

    const unknown = await get("/v1/receipts/00000000-0000-4000-8000-000000000000");
    expect(unknown.status).toBe(200);
    expect(unknown.body).toMatchObject({ latest: null, receipts: [] });
    // Every answer about chain data names the range it was read from.
    for (const answer of [unknown.body, byUuid.body, body]) {
      expect(answer.coverage).toMatchObject({
        module: "receipts",
        handler: "ready",
        fromBlock: 26_131_900,
        throughBlock: 26_164_615,
      });
    }
  });

  it("filters by block range", async () => {
    const { body } = await get("/v1/receipts?fromBlock=26131930&toBlock=26131980");
    expect((body.receipts as { blockNumber: number }[]).map((receipt) => receipt.blockNumber)).toEqual([
      26_131_975, 26_131_933,
    ]);
  });
});

describe("intake requests", () => {
  it("lists every request newest first, amounts as strings", async () => {
    const { body } = await get("/v1/intake/requests");
    const requests = body.requests as { requestedBlock: number; amount: string; statusName: string | null }[];
    expect(requests).toHaveLength(8);
    expect(requests[0]).toMatchObject({
      requestedBlock: 26_163_827,
      amount: "500000000000000000",
      statusName: "answered",
    });
    expect(requests.map((request) => request.requestedBlock)).toEqual(
      [...requests.map((request) => request.requestedBlock)].sort((a, b) => b - a),
    );
  });

  it("filters by payer and by callback target, and fetches one by id", async () => {
    const byPayer = await get("/v1/intake/requests?payer=0xD5377ec56E0eb63Ba4B1EB40c49DBB82Db06b10a");
    expect(byPayer.body.requests).toHaveLength(3);
    const consumer = "0x70c1b03ccc02905b2ad5683156592418424c787b";
    const byCallback = await get(`/v1/intake/requests?callbackTarget=${consumer}`);
    expect(byCallback.body.requests).toHaveLength(1);

    const id = (byCallback.body.requests as { requestId: string }[])[0]?.requestId as string;
    const one = await get(`/v1/intake/requests/${id}`);
    expect(one.body.request).toMatchObject({
      requestId: id,
      delivered: true,
      callbackSelector: "0x510379c7",
    });
    expect(one.body.coverage).toMatchObject({ module: "intake", fromBlock: 26_131_900 });
    expect(byPayer.body.coverage).toMatchObject({ module: "intake", handler: "ready" });
    expect((await get(`/v1/intake/requests/0x${"00".repeat(32)}`)).status).toBe(404);
  });
});

describe("jobs report", () => {
  it("serves the daily tally with the house split and the coverage it was counted from", async () => {
    const { body } = await get("/v1/jobs-report/daily?days=14");
    expect(body.unofficial).toBe(true);
    expect(body.counting).toMatch(
      /every Transfer log to the fee payee is a payment, zero-value ones included/,
    );
    expect(body.coverage).toMatchObject({
      module: "fee_transfers",
      fromBlock: 26_157_615,
      throughBlock: 26_164_615,
    });
    expect(body.days).toEqual([
      {
        day: "2026-10-09",
        // The look-back starts partway through the 9th, and the 10th had not ended.
        complete: false,
        firstBlock: 26_157_626,
        lastBlock: 26_158_174,
        amountWei: "77500000000000000000",
        amountImd: "77.5",
        payments: 15,
        payers: 6,
        house: { amountWei: "73500000000000000000", amountImd: "73.5", payments: 7, payers: 1 },
        outside: { amountWei: "4000000000000000000", amountImd: "4", payments: 8, payers: 5 },
        zeroValueLogs: 0,
      },
      {
        day: "2026-10-10",
        complete: false,
        firstBlock: 26_158_312,
        lastBlock: 26_164_612,
        amountWei: "41000000000000000000",
        amountImd: "41",
        payments: 79,
        payers: 32,
        house: { amountWei: "500000000000000000", amountImd: "0.5", payments: 1, payers: 1 },
        outside: { amountWei: "40500000000000000000", amountImd: "40.5", payments: 78, payers: 31 },
        zeroValueLogs: 0,
      },
    ]);
  });

  it("limits the tally to the newest days asked for", async () => {
    const { body } = await get("/v1/jobs-report/daily?days=1");
    expect((body.days as { day: string }[]).map((day) => day.day)).toEqual(["2026-10-10"]);
  });

  it("tallies a block window and says whether the window is fully indexed", async () => {
    const inside = await get("/v1/jobs-report/window?fromBlock=26160000&toBlock=26162000");
    expect(inside.body).toMatchObject({
      unofficial: true,
      covered: true,
      amountImd: "9",
      payments: 18,
      payers: 12,
      coverage: { module: "fee_transfers", fromBlock: 26_157_615, throughBlock: 26_164_615 },
    });
    expect((inside.body.topPayers as unknown[]).length).toBeLessThanOrEqual(10);

    const whole = await get("/v1/jobs-report/window?fromBlock=26157615&toBlock=26164615");
    expect(whole.body).toMatchObject({ covered: true, amountImd: "118.5", payments: 94, payers: 33 });
    expect(whole.body.topPayers[0]).toEqual({
      payer: TOP_PAYER,
      amountWei: "74000000000000000000",
      amountImd: "74",
      payments: 8,
      label: "HOUSE",
    });
    expect(whole.body.topPayers[1]).toMatchObject({ label: "OUTSIDE", amountImd: "6.5" });

    // A window that reaches below the first indexed block is a lower bound, and is labelled so.
    const partly = await get("/v1/jobs-report/window?fromBlock=26150000&toBlock=26164615");
    expect(partly.body).toMatchObject({ covered: false, payments: 94 });
  });

  it("labels each transfer HOUSE or OUTSIDE", async () => {
    const { body } = await get(`/v1/fee-transfers?from=${TOP_PAYER}&limit=1000`);
    expect(body.transfers).toHaveLength(8);
    expect(new Set((body.transfers as { label: string }[]).map((transfer) => transfer.label))).toEqual(
      new Set(["HOUSE"]),
    );
    const all = await get("/v1/fee-transfers?limit=1000");
    expect(
      (all.body.transfers as { label: string }[]).filter((transfer) => transfer.label === "OUTSIDE"),
    ).toHaveLength(86);
    expect(all.body.coverage).toMatchObject({ module: "fee_transfers", fromBlock: 26_157_615 });
  });
});

describe("our own contracts, before they exist", () => {
  /**
   * What every answer about one of our tables carries until its module has indexed a block. The
   * modules of launches B and C are stubs; launch A's are finished and, with no address in this
   * configuration, have simply indexed nothing (`throughBlock: null`).
   */
  const notIndexed = (module: string) => ({
    module,
    handler: ["questions", "jobs_report", "payroll"].includes(module) ? "ready" : "stub",
    fromBlock: null,
    throughBlock: null,
    fromTime: null,
    throughTime: null,
    unfolded: 0,
  });

  it("answers every route with an empty list that says nothing has been indexed for it", async () => {
    expect((await get("/v1/orders")).body).toEqual({ coverage: notIndexed("work_orders"), orders: [] });
    expect(
      (await get("/v1/orders?state=Open&employer=0x871e507B6a70F858Ad4B414bddb77473630C366b")).body,
    ).toEqual({ coverage: notIndexed("work_orders"), orders: [] });
    expect((await get("/v1/pots")).body).toEqual({ coverage: notIndexed("crowd_pots"), pots: [] });
    expect((await get("/v1/feeds")).body).toEqual({ coverage: notIndexed("questions"), feeds: [] });
    expect((await get("/v1/rounds")).body).toEqual({ coverage: notIndexed("questions"), rounds: [] });
    expect((await get(`/v1/feeds/0x${"ab".repeat(32)}/rounds`)).body).toEqual({
      coverage: notIndexed("questions"),
      feedId: `0x${"ab".repeat(32)}`,
      rounds: [],
    });
    expect((await get("/v1/prints")).body).toEqual({ coverage: notIndexed("jobs_report"), prints: [] });
    expect((await get("/v1/payroll/movements?kind=tipped")).body).toEqual({
      coverage: notIndexed("payroll"),
      movements: [],
    });
    expect((await get("/v1/rules")).body).toEqual({ coverage: notIndexed("rules"), rules: [] });
    expect((await get("/v1/orders/1")).status).toBe(404);
    expect((await get("/v1/pots/1")).status).toBe(404);
  });
});

describe("events", () => {
  it("serves the stored logs of one module or one event", async () => {
    const receipts = await get("/v1/events?module=receipts");
    expect(receipts.body.events).toHaveLength(5);
    const completed = await get("/v1/events?module=intake&event=Completed&limit=2");
    const events = completed.body.events as {
      event: string;
      blockNumber: number;
      args: { status: number };
    }[];
    expect(events.map((event) => [event.event, event.blockNumber])).toEqual([
      ["Completed", 26_163_839],
      ["Completed", 26_159_943],
    ]);
    expect(events[0]?.args.status).toBe(0);
  });
});

describe("the server adapter", () => {
  // The adapter is exercised with stand-ins for Node's request and response, so no socket is opened.
  function exchange(method: string, url: string) {
    const sent = { status: 0, headers: {} as Record<string, string>, body: "" };
    const outgoing = {
      writeHead(status: number, headers?: unknown) {
        sent.status = status;
        sent.headers = (headers ?? {}) as Record<string, string>;
        return this;
      },
      end(chunk?: unknown) {
        sent.body = chunk === undefined ? "" : Buffer.from(chunk as Uint8Array | string).toString("utf8");
        return this;
      },
    };
    const incoming = { method, url, headers: { host: "127.0.0.1", accept: "application/json" } };
    return answer(app, incoming, outgoing as unknown as Parameters<typeof answer>[2]).then(() => sent);
  }

  it("passes a Node request to the app and writes the answer back", async () => {
    const sent = await exchange("GET", "/v1/receipts?limit=1");
    expect(sent.status).toBe(200);
    expect(sent.headers["access-control-allow-origin"]).toBe("*");
    expect((JSON.parse(sent.body) as { receipts: unknown[] }).receipts).toHaveLength(1);
  });

  it("refuses writes and overlong URLs without reading a body", async () => {
    expect((await exchange("POST", "/v1/receipts")).status).toBe(405);
    expect((await exchange("GET", `/v1/receipts?x=${"a".repeat(3000)}`)).status).toBe(414);
    expect((await exchange("GET", "http://elsewhere.example/v1/receipts")).status).toBe(400);
  });
});
