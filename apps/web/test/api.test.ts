/**
 * The JSON API under /api/v1/: GET only, open CORS, served from the same cached models as the
 * pages, with a per-visitor limit on the two routes that can cause a fresh upstream read.
 */
import { describe, expect, it } from "vitest";
import { HOUSE_WALLETS } from "~/config/house";
import { MAINNET } from "@help-wanted/shared";
import { REFERENCE_JOB } from "~/config/chain";
import { handleApi } from "~/lib/api";
import { clientKey, errorResponse, jsonResponse, OPEN_CORS, preflightResponse, toJson } from "~/lib/http";
import { API_ROUTES } from "~/lib/siteDocs";
import { DEPLOYMENT_BOOK, flattenBook } from "@help-wanted/shared";
import { BOOK_NAMES, BOOKS, ctxFor, launchedIn, testSources, type TestWorld } from "./helpers";

/** A request to the API. `visitor` is who is asking, as the server worked it out; null is the server itself. */
function get(world: TestWorld, path: string, visitor: string | null = null): Promise<Response> {
  const url = new URL(`https://help-wanted.test/api/v1/${path}`);
  return handleApi(url.pathname.replace(/^\/api\/v1\/?/, ""), new Request(url), {
    ...ctxFor(world, "/", visitor),
    url,
  });
}

async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("/api/v1", () => {
  it("lists its own routes", async () => {
    const response = await get(testSources(), "");
    expect(response.status).toBe(200);
    const index = await body<{ routes: { path: string }[] }>(response);
    expect(index.routes).toEqual(API_ROUTES);
  });

  it("answers every listed route that takes no parameter, with open CORS and a short cache", async () => {
    const world = testSources();
    const fixed = API_ROUTES.map((r) => r.path).filter((p) => !p.includes("{"));
    expect(fixed.length).toBeGreaterThanOrEqual(13);
    for (const path of fixed) {
      const response = await get(world, path.replace(/^\/api\/v1\/?/, ""));
      expect(response.status, path).toBe(200);
      expect(response.headers.get("access-control-allow-origin"), path).toBe("*");
      expect(response.headers.get("content-type"), path).toBe("application/json; charset=utf-8");
      expect(Object.keys(await body(response)).length, path).toBeGreaterThan(0);
    }
  });

  it("answers the parameterised routes for the reference job, seat 1998 and the hire flow", async () => {
    const world = testSources();
    expect((await get(world, `verify/${REFERENCE_JOB.jobId}`)).status).toBe(200);
    expect((await get(world, `work-records/${REFERENCE_JOB.receipt.slice(2)}.json`)).status).toBe(200);
    expect((await get(world, "seats/1998")).status).toBe(200);
    expect((await get(world, "flows/drip")).status).toBe(200);
    // Nothing is launched in this world: there is no order 1 and no pot 1, and the answer says
    // why rather than 404. The same holds with launch A only, which brings no desk.
    for (const bookName of ["none", "aOnly"] as const) {
      const sources = testSources({ book: BOOKS[bookName] });
      const order = await body<{ launched: boolean; order: unknown; statusWords: string }>(
        await get(sources, "orders/1"),
      );
      expect(order, bookName).toMatchObject({ launched: false, order: null });
      expect(order.statusWords).toContain("not launched yet");
      expect((await get(sources, "pots/1")).status).toBe(200);
    }
    // With the desk in the book and no answer from it, the route says the desk could not be read:
    // it does not say the order does not exist.
    const unread = await body<{ launched: boolean; order: unknown; statusWords: string; error: string }>(
      await get(testSources({ book: BOOKS.all }), "orders/1"),
    );
    expect(unread).toMatchObject({ launched: true, order: null });
    expect(unread.statusWords).toContain("could not be read just now");
    expect(unread.error).toContain("did not answer");
  });

  it("answers 404 in one JSON shape for anything else", async () => {
    const world = testSources();
    for (const path of ["nope", "orders/1/extra", "status/extra", "seats/2000", "orders/abc"]) {
      const response = await get(world, path);
      expect(response.status, path).toBe(404);
      const error = await body<{ error: string; message: string }>(response);
      expect(error.error).toBe("not_found");
      expect(error.message.length).toBeGreaterThan(5);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("/verify/:jobId returns the verdict, the two hashes and the steps", async () => {
    const response = await get(testSources(), `verify/${REFERENCE_JOB.jobId}`);
    const result = (
      await body<{
        result: {
          verdict: string;
          receipt: string;
          record: { keccak: string; bytes: number };
          steps: unknown[];
        };
      }>(response)
    ).result;
    expect(result.verdict).toBe("proven");
    expect(result.receipt).toBe(REFERENCE_JOB.receipt);
    expect(result.record).toMatchObject({ keccak: REFERENCE_JOB.receipt, bytes: 7339 });
    expect(result.steps).toHaveLength(4);
    // The id may be given as the 16 bytes too.
    expect((await get(testSources(), `verify/${REFERENCE_JOB.jobIdBytes16}`)).status).toBe(200);
    expect((await get(testSources(), "verify/hello")).status).toBe(400);
  });

  it("limits one visitor to twelve checks of new jobs a minute and answers 429 with Retry-After", async () => {
    const world = testSources();
    const visitor = "203.0.113.9";
    const fresh = (i: number) => `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
    for (let i = 0; i < 12; i++) {
      expect((await get(world, `verify/${fresh(i)}`, visitor)).status).toBe(200);
    }
    const refused = await get(world, `verify/${fresh(12)}`, visitor);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await body<{ error: string }>(refused)).error).toBe("too_many_requests");
    // A job already looked at costs nothing and is never refused, however often it is asked for.
    for (let i = 0; i < 40; i++) {
      expect((await get(world, `verify/${fresh(0)}`, visitor)).status).toBe(200);
    }
    // Neither is the reference job, and another visitor is not held back by the first.
    expect((await get(world, `verify/${REFERENCE_JOB.jobId}`, visitor)).status).toBe(200);
    expect((await get(world, `verify/${fresh(13)}`, "198.51.100.4")).status).toBe(200);
  });

  it("works out who is asking from the socket, or from the one header the operator named", () => {
    const request = (headers: Record<string, string>) =>
      new Request("https://help-wanted.test/", { headers });
    // No header is believed by default: X-Forwarded-For is whatever the caller wrote.
    expect(
      clientKey(request({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7" }), "10.0.0.5", null),
    ).toBe("10.0.0.5");
    // Behind a proxy that writes one, that header is the visitor.
    expect(clientKey(request({ "x-real-ip": "203.0.113.9" }), "10.0.0.5", "x-real-ip")).toBe("203.0.113.9");
    // Of a list, only the last entry was written by the proxy nearest to us.
    expect(clientKey(request({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), null, "x-forwarded-for")).toBe(
      "203.0.113.9",
    );
    // The named header missing: fall back on the socket, never on another header.
    expect(clientKey(request({ "x-forwarded-for": "6.6.6.6" }), "10.0.0.5", "x-real-ip")).toBe("10.0.0.5");
    expect(clientKey(request({}), null, null)).toBe("unknown");
  });

  it("/deployments shows null for every address until the book or the configuration has one", async () => {
    type Answer = {
      launchedCount: number;
      contracts: { key: string; name: string; launch: string; address: string | null }[];
      launches: { key: string; txHash: string | null; block: number | null; launchNumber: number | null }[];
    };
    const none = await body<Answer>(await get(testSources({ book: BOOKS.none }), "deployments"));
    expect(none.launchedCount).toBe(0);
    expect(none.contracts).toHaveLength(10);
    expect(none.contracts.every((c) => c.address === null)).toBe(true);
    expect(none.launches.every((l) => l.txHash === null && l.block === null)).toBe(true);
    const one = await body<Answer>(
      await get(
        testSources({ env: { HW_ADDR_PAYROLL: "0x00000000000000000000000000000000000000A3" } }),
        "deployments",
      ),
    );
    expect(one.launchedCount).toBe(1);

    // Launch A only: three addresses and the launch's own record; nothing for B and C.
    const aOnly = await body<Answer>(await get(testSources({ book: BOOKS.aOnly }), "deployments"));
    expect(aOnly.launchedCount).toBe(3);
    expect(aOnly.contracts.filter((c) => c.address !== null).map((c) => c.name)).toEqual([
      "Questions",
      "JobsReport",
      "Payroll",
    ]);
    expect(aOnly.contracts.filter((c) => c.launch !== "A").every((c) => c.address === null)).toBe(true);
    expect(aOnly.launches.map((l) => [l.key, l.txHash !== null])).toEqual([
      ["A", true],
      ["B", false],
      ["C", false],
    ]);
    // Everything launched.
    const all = await body<Answer>(await get(testSources({ book: BOOKS.all }), "deployments"));
    expect(all.launchedCount).toBe(10);
    expect(all.contracts.every((c) => c.address !== null)).toBe(true);

    // The real book: the route gives exactly what the shared package holds, whatever that is.
    const today = await body<Answer>(await get(testSources({ book: DEPLOYMENT_BOOK }), "deployments"));
    const flat = flattenBook(DEPLOYMENT_BOOK) as unknown as Record<string, string | null>;
    expect(today.contracts.map((c) => [c.key, c.address])).toEqual(
      today.contracts.map((c) => [c.key, flat[c.key] ?? null]),
    );
    expect(today.launches.filter((l) => l.txHash !== null).map((l) => l.key)).toEqual(
      launchedIn(DEPLOYMENT_BOOK),
    );
  });

  it("/integration has one row per IdentityMD primitive", async () => {
    const answer = await body<{
      rows: { primitive: string; where: string; status: string }[];
      contracts: unknown[];
    }>(await get(testSources(), "integration"));
    expect(answer.rows.length).toBeGreaterThanOrEqual(10);
    expect(answer.rows.map((r) => r.where).join(" ")).toContain(MAINNET.WORK_REGISTRY);
    expect(answer.contracts).toHaveLength(10);
  });

  it("/evidence gives null with a reason, never a zero, for what cannot exist yet", async () => {
    const answer = await body<{
      contracts: { launched: number; of: number };
      houseWallets: unknown[];
      centralClaim: { verdict: string; receipt: string; keccakOfRecord: string };
      intakeRequests: {
        everTakenOnMainnet: number;
        everTakenByTheLegacyIntake: number;
        listed: number;
        boughtByOurContracts: number | null;
        boughtByOurContractsReason: string;
        boughtByHouseWallets: number;
      };
      paymentsToTheSwarm: {
        totalWei: string;
        payments: number;
        payers: number;
        housePayments: number;
        unofficial: boolean;
      };
      orders: { opened: number | null; reason: string };
      pots: { opened: number | null; reason: string };
      feeSplit: { receivedWei: string | null; reason: string };
      provenOnTheLiveSystem: {
        houseFeedAnswers: { feed: string; oracleRequest: string; purchase: string }[];
        audits: { job: string; report: string; findings: { id: string; outcome: string }[] }[];
        headerJob: {
          jobId: string;
          recordHash: string;
          registryReceipt: string | null;
          receiptOnChain: boolean | null;
        };
      };
      standingQuestions: { feedsCreated: number | null; reason: string };
      jobsReport: { prints: number | null; reason: string };
    }>(await get(testSources({ book: BOOKS.none }), "evidence"));
    expect(answer.contracts).toMatchObject({ launched: 0, of: 10 });
    expect(answer.houseWallets).toHaveLength(HOUSE_WALLETS.length);
    expect(answer.centralClaim).toMatchObject({
      verdict: "proven",
      receipt: REFERENCE_JOB.receipt,
      keccakOfRecord: REFERENCE_JOB.receipt,
    });
    // Both Intakes by their own counters; the list holds what the recorded files hold (12 of
    // version 1's 13 and 20 of version 2's 44). The four from a house wallet are the purchases
    // that put the house feed questions to the live oracle.
    expect(answer.intakeRequests).toMatchObject({
      everTakenOnMainnet: 44,
      everTakenByTheLegacyIntake: 13,
      listed: 32,
      boughtByOurContracts: null,
      boughtByOurContractsReason: "Questions is not launched yet",
      boughtByHouseWallets: 4,
    });
    expect(answer.paymentsToTheSwarm).toMatchObject({
      totalWei: "121000000000000000000",
      payments: 99,
      payers: 34,
      housePayments: 0,
      unofficial: true,
    });
    expect(answer.orders).toEqual({ opened: null, reason: "WorkOrders is not launched yet" });
    expect(answer.pots).toEqual({ opened: null, reason: "CrowdPots is not launched yet" });
    expect(answer.feeSplit).toEqual({ receivedWei: null, reason: "Payroll is not launched yet" });
    expect(answer.standingQuestions).toEqual({ feedsCreated: null, reason: "Questions is not launched yet" });
    expect(answer.jobsReport).toEqual({ prints: null, reason: "JobsReport is not launched yet" });
    // What has been proven, each with its public address; and the one thing that has not.
    const proven = answer.provenOnTheLiveSystem;
    expect(proven.houseFeedAnswers.map((a) => a.feed)).toEqual(["payrolls", "hires", "employers"]);
    expect(proven.houseFeedAnswers[0]?.oracleRequest).toBe(
      "https://api.imd.fun/oracle/requests/3744d864-8cbf-4fcf-8a8c-3529fb1736cb",
    );
    expect(proven.audits.map((a) => a.report)).toEqual([
      "https://api.imd.fun/jobs/be91e8ae-9f45-495f-a318-60fab672a92e/report.md",
      "https://api.imd.fun/jobs/22624be0-d2da-400e-91c4-51dac0a9a7f5/report.md",
    ]);
    expect(proven.audits.flatMap((a) => a.findings)).toHaveLength(9);
    expect(proven.headerJob).toMatchObject({
      jobId: "e70c56ce-60f0-4c2c-b413-67e5ae37ddce",
      registryReceipt: `0x${"0".repeat(64)}`,
      receiptOnChain: false,
    });
  });

  it("/evidence says 'could not be read', never 'not launched' and never zero, for a launched contract that does not answer", async () => {
    // Launch A in the book, and a chain that answers nothing for it; then all three.
    for (const bookName of ["aOnly", "all"] as const) {
      const answer = await body<{
        contracts: { launched: number };
        standingQuestions: { feedsCreated: number | null; reason: string };
        jobsReport: { prints: number | null; reason: string };
        feeSplit: { receivedWei: string | null; reason: string };
        orders: { opened: number | null; reason: string };
        pots: { opened: number | null; reason: string };
      }>(await get(testSources({ book: BOOKS[bookName] }), "evidence"));
      expect(answer.contracts.launched).toBe(bookName === "aOnly" ? 3 : 10);
      expect(answer.standingQuestions.feedsCreated).toBeNull();
      expect(answer.standingQuestions.reason).toContain("did not answer");
      expect(answer.jobsReport.prints).toBeNull();
      expect(answer.jobsReport.reason).toContain("did not answer");
      expect(answer.feeSplit.receivedWei).toBeNull();
      expect(answer.feeSplit.reason).toContain("did not answer");
      for (const reason of [
        answer.standingQuestions.reason,
        answer.jobsReport.reason,
        answer.feeSplit.reason,
      ]) {
        expect(reason).not.toContain("not launched");
      }
      // The desk: not launched with launch A only, unread once it is in the book.
      expect(answer.orders.opened).toBeNull();
      expect(answer.pots.opened).toBeNull();
      if (bookName === "aOnly") {
        expect(answer.orders.reason).toBe("WorkOrders is not launched yet");
        expect(answer.pots.reason).toBe("CrowdPots is not launched yet");
      } else {
        expect(answer.orders.reason).toContain("did not answer");
        expect(answer.pots.reason).toContain("did not answer");
      }
    }
  });

  it("/evidence never counts sample orders", async () => {
    const answer = await body<{
      sampleData: boolean;
      orders: { opened: number | null; reason: string };
      pots: { opened: number | null };
    }>(await get(testSources({ env: { HW_SAMPLE_DATA: "1" } }), "evidence"));
    expect(answer.sampleData).toBe(true);
    expect(answer.orders.opened).toBeNull();
    expect(answer.orders.reason).toContain("made up");
    expect(answer.pots.opened).toBeNull();
  });

  it("/status reports each source and turns 503 when the essentials do not answer", async () => {
    const healthy = await get(testSources(), "status");
    expect(healthy.status).toBe(200);
    const ok = await body<{
      status: string;
      launchedContracts: number;
      sources: {
        identitymdApi: { ok: boolean; budget: { maxPerMinute: number } };
        rpc: { ok: boolean; headBlock: number; host: string };
        indexer: string;
      };
    }>(healthy);
    expect(ok).toMatchObject({ status: "ok", launchedContracts: 0 });
    // The count follows the book, and each address in it is asked to identify itself. A book's
    // stand-in addresses hold no contract, so each is reported as not answering: never as fine.
    for (const bookName of BOOK_NAMES) {
      const answer = await body<{
        launchedContracts: number;
        contracts: { contract: string; answersAsThatContract: boolean | null }[];
      }>(await get(testSources({ book: BOOKS[bookName] }), "status"));
      const expected = { none: 0, aOnly: 3, aAndB: 7, all: 10 }[bookName];
      expect(answer.launchedContracts, bookName).toBe(expected);
      expect(answer.contracts, bookName).toHaveLength(expected);
      expect(answer.contracts.every((c) => c.answersAsThatContract === false)).toBe(true);
    }
    expect(ok.sources.identitymdApi).toMatchObject({ ok: true, budget: { maxPerMinute: 40 } });
    expect(ok.sources.rpc).toMatchObject({ ok: true, headBlock: 26_164_692, host: "rpc.test" });
    expect(ok.sources.indexer).toContain("not connected");
    expect(healthy.headers.get("cache-control")).toBe("no-store");

    const degraded = await get(testSources({ chain: { failCalls: true } }), "status");
    expect(degraded.status).toBe(503);
    expect((await body<{ status: string }>(degraded)).status).toBe("degraded");
  });

  it("/health answers without reading any upstream", async () => {
    const world = testSources({ chain: { failCalls: true } });
    const response = await get(world, "health");
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ ok: true });
    expect(world.api.calls).toEqual([]);
    expect(world.chain.calls).toEqual([]);
  });

  it("/swarm and /jobs carry where and when their data was read", async () => {
    const world = testSources();
    const swarm = await body<{ online: number; source: string; fetchedAt: string; stale: boolean }>(
      await get(world, "swarm"),
    );
    expect(swarm).toMatchObject({ online: 900, source: "https://api.imd.fun/health", stale: false });
    const jobs = await body<{ jobs: { cards: unknown[] }; sources: unknown[] }>(await get(world, "jobs"));
    expect(jobs.jobs.cards).toHaveLength(3);
    expect(jobs.sources.length).toBeGreaterThan(0);
  });

  it("turns an upstream failure into 502, and a spent budget into 503 with Retry-After", async () => {
    const failing = testSources({
      api: { fetch: (async () => new Response("no", { status: 500 })) as typeof fetch, calls: [] },
    });
    const bad = await get(failing, "swarm");
    expect(bad.status).toBe(502);
    expect((await body<{ error: string }>(bad)).error).toBe("upstream_failed");

    const tight = testSources({ env: { IMD_API_MAX_PER_MINUTE: "1" } });
    expect((await get(tight, "swarm")).status).toBe(200);
    const hash = `0x${"ab".repeat(32)}`;
    const spent = await get(tight, `work-records/${hash.slice(2)}.json`, "192.0.2.77");
    expect(spent.status).toBe(503);
    expect((await body<{ error: string }>(spent)).error).toBe("upstream_budget_spent");
    expect(Number(spent.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("says an upstream is not answering, with when it will be asked again, once it has failed twice", async () => {
    const world = testSources({
      api: { fetch: (async () => new Response("no", { status: 500 })) as typeof fetch, calls: [] },
    });
    // Two different reads fail; from then on the API is left alone and callers are told so at once.
    expect((await get(world, "swarm")).status).toBe(502);
    expect((await get(world, `work-records/${"ab".repeat(32)}.json`)).status).toBe(502);
    const paused = await get(world, `work-records/${"cd".repeat(32)}.json`);
    expect(paused.status).toBe(503);
    expect((await body<{ error: string }>(paused)).error).toBe("upstream_not_answering");
    expect(Number(paused.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("response helpers", () => {
  it("write a bigint as a decimal string, so amounts in wei survive exactly", () => {
    expect(toJson({ wei: 121_000_000_000_000_000_000n, n: 1 }, false)).toBe(
      '{"wei":"121000000000000000000","n":1}',
    );
  });

  it("open CORS on every answer, and answer a preflight", async () => {
    expect(OPEN_CORS["access-control-allow-origin"]).toBe("*");
    expect(jsonResponse({ a: 1 }).headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    const preflight = preflightResponse();
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    const error = errorResponse(418, "teapot", "no coffee");
    expect(error.status).toBe(418);
    expect(await error.json()).toEqual({ error: "teapot", message: "no coffee" });
  });
});
