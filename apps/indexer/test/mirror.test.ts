/**
 * The API mirror: that it is polite (a fixed gap, a hard ceiling, a pause when told to slow
 * down), and that it files the real documents of `test/fixtures/api` correctly. The clock and the
 * network are both made up: nothing waits and nothing is fetched.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MirrorConfig } from "../src/config.js";
import type { Database } from "../src/db/client.js";
import { apiHealth, apiJobRecords, apiJobs, apiOracleRequests } from "../src/db/schema.js";
import { ApiRequestError, parseRetryAfter, PoliteFetcher } from "../src/mirror/politeFetch.js";
import { ApiMirror } from "../src/mirror/poller.js";
import { createQueries } from "../src/queries.js";
import { countRows, emptyDatabase, openTestDatabase } from "./helpers/db.js";

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/api/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

/** A clock that only moves when somebody sleeps, and a server that answers from a script. */
function world(script: (url: string, call: number) => Response | Promise<Response> | Error) {
  let now = 1_760_000_000_000;
  const starts: { url: string; at: number }[] = [];
  const sleeps: number[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    starts.push({ url, at: now });
    // Each request takes 200 ms of made-up time.
    now += 200;
    const answer = await script(url, starts.length);
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof fetch;
  return {
    fetch: fetchFn,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance(ms: number) {
      now += ms;
    },
    starts,
    sleeps,
  };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const refuse = (status: number, headers: Record<string, string> = {}) =>
  new Response('{"error":"slow_down"}', { status, headers });

describe("PoliteFetcher", () => {
  it("never lets two requests start closer together than the gap", async () => {
    const w = world(() => ok({}));
    const fetcher = new PoliteFetcher({ fetch: w.fetch, now: w.now, sleep: w.sleep, callsPerMinute: 12 });
    expect(fetcher.minIntervalMs).toBe(5000);

    await Promise.all(Array.from({ length: 30 }, (_, i) => fetcher.getJson(`https://api.example/x/${i}`)));
    expect(w.starts).toHaveLength(30);
    for (let i = 1; i < w.starts.length; i++) {
      expect((w.starts[i]?.at ?? 0) - (w.starts[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(5000);
    }
    // In order, too: the queue is first come, first served.
    expect(w.starts.map((start) => start.url)).toEqual(
      Array.from({ length: 30 }, (_, i) => `https://api.example/x/${i}`),
    );
  });

  it("stays under 20 requests in any minute, whatever it is configured with", async () => {
    const w = world(() => ok({}));
    const fetcher = new PoliteFetcher({ fetch: w.fetch, now: w.now, sleep: w.sleep, callsPerMinute: 500 });
    await Promise.all(Array.from({ length: 100 }, () => fetcher.getJson("https://api.example/health")));

    const times = w.starts.map((start) => start.at);
    let worst = 0;
    for (const from of times)
      worst = Math.max(worst, times.filter((at) => at >= from && at < from + 60_000).length);
    expect(worst).toBeLessThan(20);
    expect(worst).toBe(19);
  });

  it("waits as long as Retry-After says on a 429, then asks again", async () => {
    const w = world((_url, call) => (call === 1 ? refuse(429, { "retry-after": "30" }) : ok({ fine: true })));
    const fetcher = new PoliteFetcher({ fetch: w.fetch, now: w.now, sleep: w.sleep, callsPerMinute: 12 });
    expect(await fetcher.getJson("https://api.example/jobs")).toEqual({ fine: true });
    expect(w.starts).toHaveLength(2);
    // 30 s from the moment the refusal arrived (200 ms after the first request started).
    expect((w.starts[1]?.at ?? 0) - (w.starts[0]?.at ?? 0)).toBe(30_200);
  });

  it("backs off for longer each time on a 503 that names no delay", async () => {
    const w = world((_url, call) => (call <= 3 ? refuse(503) : ok({ up: true })));
    const fetcher = new PoliteFetcher({ fetch: w.fetch, now: w.now, sleep: w.sleep, callsPerMinute: 12 });
    expect(await fetcher.getJson("https://api.example/health")).toEqual({ up: true });
    const gaps = w.starts.slice(1).map((start, i) => start.at - (w.starts[i]?.at ?? 0));
    expect(gaps).toEqual([5200, 10_200, 20_200]);
  });

  it("holds back every queued request while the server asks for a pause", async () => {
    const w = world((url) =>
      url.endsWith("/first") && w.starts.length === 1 ? refuse(429, { "retry-after": "120" }) : ok({ url }),
    );
    const fetcher = new PoliteFetcher({ fetch: w.fetch, now: w.now, sleep: w.sleep, callsPerMinute: 12 });
    await Promise.all([
      fetcher.getJson("https://api.example/first"),
      fetcher.getJson("https://api.example/second"),
    ]);
    // Nothing at all left for two minutes after the refusal, not even the other request.
    expect(w.starts.map((start) => start.at - (w.starts[0]?.at ?? 0))).toEqual([0, 120_200, 125_200]);
  });

  it("caps a pause, however long the server asks for", async () => {
    const w = world((_url, call) => (call === 1 ? refuse(503, { "retry-after": "86400" }) : ok({})));
    const fetcher = new PoliteFetcher({
      fetch: w.fetch,
      now: w.now,
      sleep: w.sleep,
      callsPerMinute: 12,
      maxBackoffMs: 60_000,
    });
    await fetcher.getJson("https://api.example/health");
    expect((w.starts[1]?.at ?? 0) - (w.starts[0]?.at ?? 0)).toBe(60_200);
  });

  it("gives up after its tries and reports the last status", async () => {
    const w = world(() => refuse(503));
    const fetcher = new PoliteFetcher({
      fetch: w.fetch,
      now: w.now,
      sleep: w.sleep,
      callsPerMinute: 12,
      maxAttempts: 3,
    });
    const error = await fetcher.getJson("https://api.example/health").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(503);
    expect(w.starts).toHaveLength(3);

    // The queue is not jammed by the failure, and still honours the last pause.
    const before = w.now();
    const w2Answer = fetcher.getJson("https://api.example/health").catch(() => "failed again");
    expect(await w2Answer).toBe("failed again");
    expect((w.starts[3]?.at ?? 0) - before).toBeGreaterThanOrEqual(0);
  });

  it("does not repeat a request the server answered with a plain refusal", async () => {
    const w = world(() => refuse(404));
    const fetcher = new PoliteFetcher({ fetch: w.fetch, now: w.now, sleep: w.sleep, callsPerMinute: 12 });
    await expect(fetcher.getJson("https://api.example/jobs/none")).rejects.toMatchObject({ status: 404 });
    expect(w.starts).toHaveLength(1);
  });

  it("treats a network failure like a server that is not there, and tries again later", async () => {
    const w = world((_url, call) => (call === 1 ? new Error("socket hang up") : ok({ back: true })));
    const fetcher = new PoliteFetcher({ fetch: w.fetch, now: w.now, sleep: w.sleep, callsPerMinute: 12 });
    expect(await fetcher.getJson("https://api.example/health")).toEqual({ back: true });
    expect((w.starts[1]?.at ?? 0) - (w.starts[0]?.at ?? 0)).toBe(5200);
  });

  it("refuses a body that is not JSON", async () => {
    const w = world(() => new Response("<html>checkpoint</html>", { status: 200 }));
    const fetcher = new PoliteFetcher({ fetch: w.fetch, now: w.now, sleep: w.sleep, callsPerMinute: 12 });
    await expect(fetcher.getJson("https://api.example/health")).rejects.toThrow(/not JSON/);
  });

  it("lets go of everything at once when the process is stopping", async () => {
    // A real clock here: the point is that a request waiting out a five-second gap does not keep
    // the process alive for five seconds.
    const controller = new AbortController();
    const urls: string[] = [];
    const fetcher = new PoliteFetcher({
      fetch: (async (input: string | URL | Request) => {
        urls.push(String(input));
        return ok({});
      }) as typeof fetch,
      callsPerMinute: 12,
      signal: controller.signal,
    });
    await fetcher.getJson("https://api.example/first");
    const began = Date.now();
    const waiting = fetcher.getJson("https://api.example/second").catch((error: unknown) => error);
    const queued = fetcher.getJson("https://api.example/third").catch((error: unknown) => error);
    controller.abort();
    for (const outcome of [await waiting, await queued]) {
      expect(outcome).toBeInstanceOf(ApiRequestError);
      expect((outcome as ApiRequestError).message).toMatch(/the process is stopping/);
    }
    expect(Date.now() - began).toBeLessThan(1000);
    // Nothing was sent after the signal, and nothing is sent later either.
    await expect(fetcher.getJson("https://api.example/fourth")).rejects.toThrow(/stopping/);
    expect(urls).toEqual(["https://api.example/first"]);
  });

  it("reads Retry-After as seconds or as a date", () => {
    const now = Date.parse("2026-10-10T12:00:00Z");
    expect(parseRetryAfter("7", now)).toBe(7000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
    expect(parseRetryAfter("Sat, 10 Oct 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Sat, 10 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

describe("ApiMirror", () => {
  let database: Database;
  const JOB = "e9efec16-56f3-40d3-9243-52c453effc7d";
  const config: MirrorConfig = {
    enabled: true,
    baseUrl: "https://api.example",
    callsPerMinute: 12,
    watchJobs: [JOB],
    jobsLimit: 3,
    oracleRequestsLimit: 6,
  };

  beforeAll(async () => {
    database = await openTestDatabase();
  });
  afterAll(async () => {
    await database.close();
  });
  beforeEach(async () => {
    await emptyDatabase(database);
  });

  function serveFixtures(url: string): Response {
    const { pathname } = new URL(url);
    if (pathname === "/health") return ok(fixture("health"));
    if (pathname === "/jobs") return ok(fixture("jobs-limit3"));
    if (pathname === "/oracle/requests") return ok(fixture("oracle-requests"));
    if (pathname === `/jobs/${JOB}`) return ok(fixture("job-e9efec16"));
    if (pathname === `/jobs/${JOB}/records`) return ok(fixture("job-records-e9efec16"));
    return refuse(404);
  }

  function mirrorOver(w: ReturnType<typeof world>, overrides: Partial<MirrorConfig> = {}) {
    return new ApiMirror({
      db: database.db,
      fetcher: new PoliteFetcher({ fetch: w.fetch, now: w.now, sleep: w.sleep, callsPerMinute: 12 }),
      config: { ...config, ...overrides },
      now: w.now,
    });
  }

  it("files health, jobs, oracle requests and the watched job from the real documents", async () => {
    const w = world(serveFixtures);
    const report = await mirrorOver(w).runOnce();
    expect(report).toEqual({ done: ["health", "jobs", "oracle-requests", `job:${JOB}`], failed: [] });
    // Five requests: three lists, then the job and its records.
    expect(w.starts.map((start) => new URL(start.url).pathname + new URL(start.url).search)).toEqual([
      "/health",
      "/jobs?limit=3",
      "/oracle/requests?limit=6",
      `/jobs/${JOB}`,
      `/jobs/${JOB}/records`,
    ]);

    const [health] = await database.db.select().from(apiHealth);
    expect(health).toMatchObject({
      hour: "2025-10-09T08",
      status: "ok",
      connectedDaemons: 900,
      workingNow: 6,
      acceptedLastDay: 1731,
      pendingFeedback: 1774,
      paymentsEnabled: true,
      paidOrders: 3540,
      computedAt: "2026-10-10T19:29:25.185Z",
    });
    expect((health?.raw as { version: string }).version).toBe("0.1.0+4ba55555");

    const jobs = await database.db.select().from(apiJobs).orderBy(asc(apiJobs.id));
    expect(jobs.map((job) => [job.id, job.state, job.watched])).toEqual([
      ["10d225a6-92cb-4cde-9d4b-ec076b078f7d", "completed", false],
      ["66dbbe30-2e7c-42d8-936a-e1630ed8075d", "executing", false],
      ["c79a7b64-df51-4cc7-b991-6357053f8a35", "executing", false],
      [JOB, "completed", true],
    ]);
    const watched = jobs.find((job) => job.id === JOB);
    expect(watched?.paidBy).toBe("0x424f7381b6cfe63963732c52613c87cb54c5c755");
    expect(watched?.objective).toMatch(/^Design a .+ for identity MD, with \$10k in the prize pool/);
    expect(watched?.detail).not.toBeNull();

    expect(await database.db.select().from(apiJobRecords)).toEqual([
      {
        jobId: JOB,
        recordId: "86bc68be-4145-4300-9154-9b6db4968c59",
        hash: "0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5",
        chainId: 1,
        registry: "0xb6d0a187b050fa5bb0b87033a203f37becf4a775",
        status: "sent",
        txHash: "0xee0fe8ac1d27324676b65c3e86d89bb2359bf708648115ec59a1ab3325f000ec",
        failure: null,
        fetchedAtMs: expect.any(Number) as number,
      },
    ]);

    const requests = await database.db.select().from(apiOracleRequests);
    expect(requests).toHaveLength(6);
    expect(requests.map((request) => request.status).sort()).toEqual([
      "attested",
      "attested",
      "blocked",
      "blocked",
      "disagreed",
      "disagreed",
    ]);
    const newest = requests.find((request) => request.id === "0e21ab1a-ca72-4618-b814-d1909aeb5437");
    expect(newest).toMatchObject({
      status: "attested",
      chainId: 1,
      answerType: "bool",
      fromBlock: 26_142_390,
      toBlock: 26_142_390,
      signer: "0x5598aa9146215bc13eb26f2c692ad1461fd32982",
      jobId: "d5e14361-5a7e-4fb1-bae6-e57bff912efb",
    });
  });

  it("writes nothing twice when the same documents are served again", async () => {
    const w = world(serveFixtures);
    const mirror = mirrorOver(w);
    await mirror.runOnce();
    await mirror.runOnce();
    expect(await countRows(database, apiHealth)).toBe(1);
    expect(await countRows(database, apiJobs)).toBe(4);
    expect(await countRows(database, apiJobRecords)).toBe(1);
    expect(await countRows(database, apiOracleRequests)).toBe(6);
  });

  it("keeps a job's full objective when the list later serves the shortened one", async () => {
    const listed = fixture("jobs-limit3") as { jobs: { id: string; objective: string }[] };
    const detail = fixture("job-e9efec16") as { objective: string };
    const short = `${detail.objective.slice(0, 40)}…`;
    const w = world((url) => {
      const { pathname } = new URL(url);
      if (pathname === "/jobs") return ok({ jobs: [{ ...listed.jobs[0], id: JOB, objective: short }] });
      return serveFixtures(url);
    });
    const mirror = mirrorOver(w);
    await mirror.pollJobs();
    expect((await database.db.select().from(apiJobs).where(eq(apiJobs.id, JOB)))[0]?.objective).toBe(short);
    await mirror.pollJob(JOB);
    await mirror.pollJobs();
    expect((await database.db.select().from(apiJobs).where(eq(apiJobs.id, JOB)))[0]?.objective).toBe(
      detail.objective,
    );
  });

  it("carries on with the other documents when one cannot be fetched", async () => {
    const w = world((url) => (new URL(url).pathname === "/jobs" ? refuse(500) : serveFixtures(url)));
    const report = await mirrorOver(w).runOnce();
    expect(report.done).toEqual(["health", "oracle-requests", `job:${JOB}`]);
    expect(report.failed).toEqual([{ task: "jobs", error: expect.stringMatching(/status 500/) as string }]);
    expect(await countRows(database, apiOracleRequests)).toBe(6);
  });

  it("skips entries that are not shaped like what it asked for, and stores the rest", async () => {
    const good = (fixture("oracle-requests") as { requests: unknown[] }).requests[0];
    const w = world((url) =>
      new URL(url).pathname === "/oracle/requests"
        ? ok({ requests: [good, { id: "not-a-uuid", status: "attested" }, "nonsense", null] })
        : serveFixtures(url),
    );
    expect(await mirrorOver(w).pollOracleRequests()).toBe(1);
    expect(await countRows(database, apiOracleRequests)).toBe(1);
  });

  it("stores text that Postgres would refuse by replacing the offending characters", async () => {
    const w = world((url) =>
      new URL(url).pathname === "/jobs"
        ? ok({ jobs: [{ id: JOB, state: "completed", objective: "before\u0000after", note: "\ud800" }] })
        : serveFixtures(url),
    );
    expect(await mirrorOver(w).pollJobs()).toBe(1);
    const [job] = await database.db.select().from(apiJobs);
    expect(job?.objective).toBe("before�after");
    expect((job?.listed as { note: string }).note).toBe("�");
  });

  it("refuses to file a job document that is not the job it asked for", async () => {
    const other = { ...(fixture("job-e9efec16") as object), id: "10d225a6-92cb-4cde-9d4b-ec076b078f7d" };
    const w = world((url) => (new URL(url).pathname === `/jobs/${JOB}` ? ok(other) : serveFixtures(url)));
    await expect(mirrorOver(w).pollJob(JOB)).rejects.toThrow(/was served/);
    expect(await countRows(database, apiJobs)).toBe(0);
  });

  it("polls on a schedule: what is not due is not fetched", async () => {
    const w = world(serveFixtures);
    const mirror = mirrorOver(w);
    await mirror.runDue();
    expect(w.starts).toHaveLength(5);

    // Ten seconds later nothing is due.
    w.advance(10_000);
    expect((await mirror.runDue()).done).toEqual([]);
    expect(w.starts).toHaveLength(5);

    // After a minute: health and jobs. Oracle requests are every two minutes; the watched job has
    // settled (completed, receipt sent), so it is only looked at once an hour.
    w.advance(60_000);
    expect((await mirror.runDue()).done).toEqual(["health", "jobs"]);
    w.advance(120_000);
    expect((await mirror.runDue()).done).toEqual(["health", "jobs", "oracle-requests"]);
    w.advance(60 * 60_000);
    expect((await mirror.runDue()).done).toEqual(["health", "jobs", "oracle-requests", `job:${JOB}`]);
  });

  it("joins a mirrored job to its records through the query functions", async () => {
    const w = world(serveFixtures);
    await mirrorOver(w).runOnce();
    const q = createQueries(database.db);
    const found = await q.job(JOB);
    expect(found?.records.map((record) => record.status)).toEqual(["sent"]);
    expect(found?.receipts).toEqual([]);
    // No receipt, and the answer says why that proves nothing here: no block has been indexed.
    expect(found?.receiptsCoverage).toMatchObject({
      module: "receipts",
      fromBlock: null,
      throughBlock: null,
    });
    expect((await q.health())?.connectedDaemons).toBe(900);
    expect(await q.oracleRequests({ status: "blocked" })).toHaveLength(2);
    expect((await q.jobs({ watched: true })).map((job) => job.id)).toEqual([JOB]);
    expect((await q.status()).mirror.healthFetchedAtMs).toBeTypeOf("number");
  });

  it("files the other entries of a list when one of them cannot be kept", async () => {
    // An entry nested deeper than anything the API serves is not stored; its neighbours are.
    let deep: unknown = "bottom";
    for (let i = 0; i < 200; i++) deep = { deeper: deep };
    const listed = fixture("jobs-limit3") as { jobs: { id: string }[] };
    const requests = fixture("oracle-requests") as { requests: { id: string }[] };
    const w = world((url) => {
      const { pathname } = new URL(url);
      if (pathname === "/jobs") return ok({ jobs: [{ ...listed.jobs[0], extra: deep }, listed.jobs[1]] });
      if (pathname === "/oracle/requests")
        return ok({ requests: [requests.requests[0], { ...requests.requests[1], extra: deep }] });
      return serveFixtures(url);
    });
    const mirror = mirrorOver(w);
    expect(await mirror.pollJobs()).toBe(1);
    expect((await database.db.select().from(apiJobs)).map((job) => job.id)).toEqual([listed.jobs[1]?.id]);
    expect(await mirror.pollOracleRequests()).toBe(1);
    expect((await database.db.select().from(apiOracleRequests)).map((request) => request.id)).toEqual([
      requests.requests[0]?.id,
    ]);
    // A watched job whose own document is that deep is reported as a failed task, not stored.
    const w2 = world((url) =>
      new URL(url).pathname === `/jobs/${JOB}`
        ? ok({ ...(fixture("job-e9efec16") as object), extra: deep })
        : serveFixtures(url),
    );
    await expect(mirrorOver(w2).pollJob(JOB)).rejects.toThrow(/nested deeper than 32 levels/);
  });

  describe("the watch list and the request budget", () => {
    const jobId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

    /** An API whose jobs have all ended but whose receipts are still queued, as while the writer is stalled. */
    function stalledWriter(url: string): Response {
      const { pathname } = new URL(url);
      if (pathname === "/health") return ok({ status: "ok", connectedDaemons: 900 });
      if (pathname === "/jobs") return ok({ jobs: [] });
      if (pathname === "/oracle/requests") return ok({ requests: [] });
      if (/^\/jobs\/[0-9a-f-]{36}\/records$/.test(pathname)) {
        return ok({
          records: [{ id: "r1", hash: "ab".repeat(32), status: "queued", txHash: null, failure: null }],
          oracleBatches: [],
        });
      }
      const job = /^\/jobs\/([0-9a-f-]{36})$/.exec(pathname);
      if (job) return ok({ id: job[1], state: "completed" });
      return refuse(404);
    }

    /** Runs the long-running loop's cadence on the made-up clock: whatever is due, then a five-second pause. */
    async function runFor(w: ReturnType<typeof world>, mirror: ApiMirror, ms: number): Promise<void> {
      const until = w.now() + ms;
      while (w.now() < until) {
        await mirror.runDue();
        w.advance(5000);
      }
    }

    const pathsOf = (w: ReturnType<typeof world>) =>
      w.starts.map((start) => ({ path: new URL(start.url).pathname, at: start.at }));
    const largestGap = (times: number[]) =>
      Math.max(...times.slice(1).map((at, i) => at - (times[i] as number)));

    // Every watched job costs two requests, and all tasks leave through one queue at one request
    // per five seconds. Thirty unsettled jobs used to fill five minutes on their own, in one
    // pass, so `/health` (the "robots online" headline) went unpolled that long.
    it("keeps the headline polls on schedule however long the watch list is", async () => {
      const w = world(stalledWriter);
      const watchJobs = Array.from({ length: 30 }, (_, i) => jobId(i));
      const mirror = mirrorOver(w, { watchJobs });
      await runFor(w, mirror, 60 * 60_000);
      const starts = pathsOf(w);

      // A list is late by at most the job in hand (two requests) and the loop's own pause.
      const at = (path: string) => starts.filter((start) => start.path === path).map((start) => start.at);
      expect(largestGap(at("/health"))).toBeLessThanOrEqual(80_000);
      expect(largestGap(at("/jobs"))).toBeLessThanOrEqual(80_000);
      expect(largestGap(at("/oracle/requests"))).toBeLessThanOrEqual(140_000);
      expect(at("/health").length).toBeGreaterThanOrEqual(50);

      // The watch list is worked through in turn with what the lists leave: every job is reached
      // within the first ten minutes.
      const first = w.starts[0]?.at ?? 0;
      for (const id of watchJobs) {
        const polls = at(`/jobs/${id}`);
        expect([id, (polls[0] ?? Infinity) - first <= 10 * 60_000]).toEqual([id, true]);
        // Ended, with a receipt still queued: nothing about it changes fast, so it is looked at
        // every half hour, not every five minutes.
        expect([id, polls.length]).toEqual([id, 2]);
        expect((polls[1] ?? 0) - (polls[0] ?? 0)).toBeGreaterThanOrEqual(29 * 60_000);
      }

      // And the ceiling holds throughout.
      const all = starts.map((start) => start.at);
      for (const from of all) {
        expect(all.filter((time) => time >= from && time < from + 60_000).length).toBeLessThanOrEqual(12);
      }
    });

    it("still works through the watch list when the budget does not even cover the lists", async () => {
      // One request a minute is less than the lists alone ask for: by the time the third list is
      // in, the first is due again. The watch list is not shut out all the same: one job is taken
      // in every pass, and the lists are late by that one job at most.
      const w = world(stalledWriter);
      const watchJobs = [jobId(1), jobId(2), jobId(3)];
      const mirror = new ApiMirror({
        db: database.db,
        fetcher: new PoliteFetcher({ fetch: w.fetch, now: w.now, sleep: w.sleep, callsPerMinute: 1 }),
        config: { ...config, watchJobs, callsPerMinute: 1 },
        now: w.now,
      });
      await runFor(w, mirror, 40 * 60_000);
      const starts = pathsOf(w);
      for (const id of watchJobs) {
        expect([id, starts.some((start) => start.path === `/jobs/${id}/records`)]).toEqual([id, true]);
      }
      const health = starts.filter((start) => start.path === "/health").map((start) => start.at);
      // Three lists and one job: five requests a minute apart, and the loop's pause.
      expect(largestGap(health)).toBeLessThanOrEqual(6 * 60_000);
      const all = starts.map((start) => start.at);
      for (const from of all) {
        expect(all.filter((time) => time >= from && time < from + 60_000).length).toBe(1);
      }
    });

    it("looks at a job by how fast it can still change", async () => {
      const state: Record<string, { state: string; status: string | null; batches?: unknown[] }> = {
        [jobId(1)]: { state: "executing", status: null },
        [jobId(2)]: { state: "completed", status: "queued" },
        [jobId(3)]: { state: "completed", status: "sent" },
        // Some completed jobs never get a record at all.
        [jobId(4)]: { state: "completed", status: null },
        // A job that ended blocked gets a receipt too.
        [jobId(5)]: { state: "blocked", status: "sent" },
        // Oracle work has no record of its own: it is named in the day's batch.
        [jobId(6)]: { state: "completed", status: null, batches: [{ day: "2026-10-09" }] },
      };
      const w = world((url) => {
        const { pathname } = new URL(url);
        const records = /^\/jobs\/([0-9a-f-]{36})\/records$/.exec(pathname);
        if (records) {
          const known = state[records[1] as string];
          const status = known?.status ?? null;
          // No `failure` key here, where the real API sends `failure: null`: the same record.
          return ok({
            records: status === null ? [] : [{ id: "r1", hash: "ab".repeat(32), status }],
            oracleBatches: known?.batches ?? [],
          });
        }
        const job = /^\/jobs\/([0-9a-f-]{36})$/.exec(pathname);
        if (job) return ok({ id: job[1], state: state[job[1] as string]?.state });
        return stalledWriter(url);
      });
      const mirror = mirrorOver(w, { watchJobs: Object.keys(state) });
      expect(await mirror.pollJob(jobId(1))).toBe("moving");
      expect(await mirror.pollJob(jobId(2))).toBe("waiting");
      expect(await mirror.pollJob(jobId(3))).toBe("settled");
      expect(await mirror.pollJob(jobId(4))).toBe("waiting");
      expect(await mirror.pollJob(jobId(5))).toBe("settled");
      expect(await mirror.pollJob(jobId(6))).toBe("settled");

      w.starts.length = 0;
      await runFor(w, mirror, 2 * 60 * 60_000 + 5 * 60_000);
      const polls = (i: number) =>
        w.starts.filter((start) => new URL(start.url).pathname === `/jobs/${jobId(i)}`);
      // Two hours and a little: every five minutes, every half hour, every hour.
      expect(polls(1).length).toBeGreaterThanOrEqual(22);
      expect(polls(1).length).toBeLessThanOrEqual(27);
      expect(polls(2).length).toBe(5);
      expect(polls(4).length).toBe(5);
      expect(polls(3).length).toBe(3);
      expect(polls(5).length).toBe(3);
    });

    it("asks less and less often for a job the API does not know", async () => {
      // Any runner can register a job id on an order, and the watch list follows the orders. An
      // id the API answers 404 for was asked for again every five minutes, for ever.
      const unknown = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      const known = jobId(7);
      const answers = world((url) =>
        new URL(url).pathname.startsWith(`/jobs/${unknown}`) ? refuse(404) : stalledWriter(url),
      );
      const mirror = mirrorOver(answers, { watchJobs: [unknown, known] });
      await runFor(answers, mirror, 6 * 60 * 60_000);

      const asked = answers.starts
        .filter((start) => new URL(start.url).pathname === `/jobs/${unknown}`)
        .map((start) => start.at);
      // Five minutes doubled each time: 10, 20, 40, 80 and 160 minutes apart (and a little, for
      // the lists that go first). Six requests in six hours, where there used to be 72.
      const gaps = asked.slice(1).map((at, i) => at - (asked[i] as number));
      expect(gaps).toHaveLength(5);
      // The wait is counted from when a poll was taken up; its request may have left up to one
      // request gap (five seconds) later, so two requests can be that much closer together.
      [10, 20, 40, 80, 160].forEach((minutes, i) => {
        expect(gaps[i]).toBeGreaterThanOrEqual(minutes * 60_000 - 5000);
        expect(gaps[i]).toBeLessThan((minutes + 1) * 60_000);
      });
      // A 404 is never followed by a request for the records of the same job.
      expect(answers.starts.filter((start) => start.url.endsWith(`${unknown}/records`))).toEqual([]);
      // The job beside it is looked at every half hour all the same.
      const neighbour = answers.starts.filter((start) => new URL(start.url).pathname === `/jobs/${known}`);
      expect(neighbour.length).toBe(12);
    });
  });

  it("begins no task once the process is stopping, and counts none as failed", async () => {
    const controller = new AbortController();
    const w = world(serveFixtures);
    const mirror = new ApiMirror({
      db: database.db,
      fetcher: new PoliteFetcher({
        fetch: w.fetch,
        now: w.now,
        sleep: w.sleep,
        callsPerMinute: 12,
        signal: controller.signal,
      }),
      config,
      now: w.now,
      signal: controller.signal,
    });
    controller.abort();
    expect(await mirror.runDue()).toEqual({ done: [], failed: [] });
    expect(await mirror.runOnce()).toEqual({ done: [], failed: [] });
    expect(w.starts).toEqual([]);
  });

  it("stops marking a job as watched when it leaves the watch list", async () => {
    const w = world(serveFixtures);
    await mirrorOver(w).runOnce();
    await mirrorOver(w, { watchJobs: [] }).runOnce();
    const [job] = await database.db.select().from(apiJobs).where(eq(apiJobs.id, JOB));
    expect(job?.watched).toBe(false);
    expect(job?.detail).not.toBeNull();
  });
});
