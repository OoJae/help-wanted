/**
 * The data layer: the cache that stands between visitors and the upstreams, the IdentityMD API
 * source with its request budget, and the chain source. Everything here runs on fakes; a clock the
 * test controls stands in for time.
 */
import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { Health, JobRecords, JobsList, MAINNET, sameAddress } from "@help-wanted/shared";
import { MULTICALL3, REFERENCE_JOB } from "~/config/chain";
import { EMPLOYERS_FIRST_ATTEMPT, FEED_PROOFS } from "~/config/proofs";
import { HEADER_JOB, LAUNCH_A_JOB, referencePin } from "~/data";
import {
  ApiShapeError,
  healthView,
  HttpApiSource,
  jobsView,
  NotTheRecordError,
  recordsView,
  safeHttpUrl,
} from "~/data/api";
import {
  Breaker,
  SlidingWindowLimiter,
  TtlCache,
  UpstreamBusyError,
  UpstreamDownError,
  within,
} from "~/lib/cache";
import { decodeIntakeLogs, parseQuestionBody } from "~/lib/intake";
import { guardReader, RpcError, type EthReader, type RawLog } from "~/lib/jsonrpc";
import { hashServedRecord } from "~/lib/verify";
import intakeSeed from "~/data/seed/intake-logs-mainnet.json";
import intakeWindowSeed from "~/data/seed/intake-logs-mainnet-26172396-26182396.json";
import { RpcChainSource } from "~/data/chain";
import { fakeApi, fakeChain, fixtureJson, RECORD, SEAT_OWNER, testSources, TRANSFERS } from "./helpers";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("TtlCache", () => {
  it("loads once while fresh, however many readers ask", async () => {
    const c = clock();
    const cache = new TtlCache({ now: c.now });
    let loads = 0;
    const load = async () => ++loads;
    const reads = await Promise.all(Array.from({ length: 20 }, () => cache.get("k", { ttlMs: 1000 }, load)));
    expect(loads).toBe(1);
    expect(reads.every((r) => r.value === 1 && !r.stale)).toBe(true);
    c.advance(999);
    expect((await cache.get("k", { ttlMs: 1000 }, load)).value).toBe(1);
    expect(loads).toBe(1);
  });

  it("past its life, serves the old value at once and refreshes behind the reader", async () => {
    const c = clock();
    const cache = new TtlCache({ now: c.now });
    let loads = 0;
    const load = async () => ++loads;
    await cache.get("k", { ttlMs: 1000, swrMs: 1000 }, load);
    c.advance(1500);
    const stale = await cache.get("k", { ttlMs: 1000, swrMs: 1000 }, load);
    expect(stale).toMatchObject({ value: 1, stale: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(loads).toBe(2);
    expect(await cache.get("k", { ttlMs: 1000, swrMs: 1000 }, load)).toMatchObject({
      value: 2,
      stale: false,
    });
  });

  it("past that too, waits for a fresh value", async () => {
    const c = clock();
    const cache = new TtlCache({ now: c.now });
    let loads = 0;
    const load = async () => ++loads;
    await cache.get("k", { ttlMs: 1000, swrMs: 1000 }, load);
    c.advance(2500);
    expect(await cache.get("k", { ttlMs: 1000, swrMs: 1000 }, load)).toMatchObject({
      value: 2,
      stale: false,
    });
  });

  it("keeps serving the old value, marked stale with the reason, when the refresh fails", async () => {
    const c = clock();
    const cache = new TtlCache({ now: c.now });
    await cache.get("k", { ttlMs: 1000, swrMs: 0 }, async () => "good");
    c.advance(5000);
    const failed = await cache.get("k", { ttlMs: 1000, swrMs: 0, staleIfErrorMs: 60_000 }, async () => {
      throw new Error("upstream down");
    });
    expect(failed).toEqual({ value: "good", fetchedAt: 1_000_000, stale: true, error: "upstream down" });
    // But not for ever: past the limit the failure is the answer.
    c.advance(120_000);
    await expect(
      cache.get("k", { ttlMs: 1000, swrMs: 0, staleIfErrorMs: 60_000 }, async () => {
        throw new Error("still down");
      }),
    ).rejects.toThrow("still down");
  });

  it("fails when there is nothing to fall back on, and then leaves the upstream alone for a while", async () => {
    const c = clock();
    const cache = new TtlCache({ now: c.now, failureTtlMs: 20_000 });
    let loads = 0;
    const failing = async () => {
      loads++;
      throw new Error("no");
    };
    await expect(cache.get("k", { ttlMs: 1000 }, failing)).rejects.toThrow("no");
    // Five more readers, a second apart: each is told of the failure at once, and none of them
    // makes the upstream answer again. A failing upstream is not asked once per page view.
    for (let i = 0; i < 5; i++) {
      c.advance(1000);
      await expect(cache.get("k", { ttlMs: 1000 }, failing)).rejects.toThrow("no");
    }
    expect(loads).toBe(1);
    expect(cache.summary().failuresRemembered).toBe(1);
    // After the pause one reader asks again, and a good answer is kept as usual.
    c.advance(20_000);
    expect(await cache.get("k", { ttlMs: 1000 }, async () => "yes")).toMatchObject({
      value: "yes",
      stale: false,
    });
    expect(cache.summary().failuresRemembered).toBe(0);
  });

  it("during that pause serves the old value at once, with the failure, and does not refresh", async () => {
    const c = clock();
    const cache = new TtlCache({ now: c.now, failureTtlMs: 20_000 });
    let loads = 0;
    const options = { ttlMs: 1000, swrMs: 1000 };
    await cache.get("k", options, async () => "good");
    const failing = async () => {
      loads++;
      throw new Error("upstream down");
    };
    c.advance(5000);
    expect(await cache.get("k", options, failing)).toMatchObject({
      value: "good",
      stale: true,
      error: "upstream down",
    });
    for (let i = 0; i < 5; i++) {
      c.advance(1000);
      expect(await cache.get("k", options, failing)).toMatchObject({ value: "good", stale: true });
    }
    expect(loads).toBe(1);
  });

  it("does not refresh in the background either while a failure is remembered", async () => {
    const c = clock();
    const cache = new TtlCache({ now: c.now, failureTtlMs: 20_000 });
    let loads = 0;
    const options = { ttlMs: 1000, swrMs: 60_000 };
    await cache.get("k", options, async () => "good");
    const failing = async () => {
      loads++;
      throw new Error("down");
    };
    for (let i = 0; i < 6; i++) {
      c.advance(1500);
      expect((await cache.get("k", options, failing)).value).toBe("good");
      await Promise.resolve();
    }
    expect(loads).toBe(1);
  });

  it("makes only a first reader wait for a slow answer; a later one is answered within the grace time", async () => {
    const c = clock();
    const cache = new TtlCache({ now: c.now, failureTtlMs: 1000, graceMs: 20 });
    const options = { ttlMs: 1000, swrMs: 0, staleIfErrorMs: 600_000 };
    await cache.get("k", options, async () => "old");
    c.advance(10_000);
    // A refresh that never comes back, as from an upstream that accepts the connection and hangs.
    let release: (value: string) => void = () => undefined;
    const hanging = () => new Promise<string>((resolve) => (release = resolve));
    const started = Date.now();
    const read = await cache.get("k", options, hanging);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(read).toMatchObject({ value: "old", stale: true });
    // The slow load was not thrown away: when it lands, the next reader has the new value.
    release("new");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await cache.get("k", options, hanging)).toMatchObject({ value: "new", stale: false });
  });

  it("answers with the remembered failure, not a long wait, when a retry after a failure is slow", async () => {
    const c = clock();
    const cache = new TtlCache({ now: c.now, failureTtlMs: 1000, graceMs: 20 });
    await expect(
      cache.get("k", { ttlMs: 1000 }, async () => Promise.reject(new Error("first failure"))),
    ).rejects.toThrow("first failure");
    c.advance(5000);
    const started = Date.now();
    await expect(cache.get("k", { ttlMs: 1000 }, () => new Promise<string>(() => undefined))).rejects.toThrow(
      "first failure",
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("within() gives up waiting without cancelling, and passes a rejection on", async () => {
    expect(await within(Promise.resolve(7), 50)).toEqual({ done: true, value: 7 });
    expect(await within(new Promise(() => undefined), 5)).toEqual({ done: false });
    await expect(within(Promise.reject(new Error("boom")), 50)).rejects.toThrow("boom");
  });

  it("holds a bounded number of entries, dropping the oldest written", async () => {
    const cache = new TtlCache({ maxEntries: 3 });
    for (const key of ["a", "b", "c", "d"]) cache.set(key, key);
    expect(cache.peek("a")).toBeNull();
    expect(cache.peek<string>("d")?.value).toBe("d");
    expect(cache.summary().entries).toBe(3);
  });
});

describe("SlidingWindowLimiter", () => {
  it("lets through at most the limit in any window, and says how long to wait", () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter({ max: 3, windowMs: 60_000, now: c.now });
    expect([1, 2, 3].map(() => limiter.take("a").ok)).toEqual([true, true, true]);
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterMs: 60_000 });
    // Another caller has its own window.
    expect(limiter.take("b").ok).toBe(true);
    c.advance(59_999);
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterMs: 1 });
    c.advance(1);
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.used("a")).toBe(1);
  });
});

describe("the IdentityMD API source", () => {
  function source(
    options: {
      max?: number;
      now?: () => number;
      api?: ReturnType<typeof fakeApi>;
      pinned?: ConstructorParameters<typeof HttpApiSource>[0]["pinned"];
      ownJobs?: readonly string[];
    } = {},
  ) {
    const api = options.api ?? fakeApi();
    return {
      api,
      source: new HttpApiSource({
        baseUrl: "https://api.imd.fun/",
        maxPerMinute: options.max ?? 40,
        fetch: api.fetch,
        now: options.now,
        pinned: options.pinned,
        ownJobs: options.ownJobs,
      }),
    };
  }
  const RECORD_ROUTE = `/work-records/${REFERENCE_JOB.receipt.slice(2)}.json`;

  it("reads the swarm's state from /health", async () => {
    const { source: s } = source();
    const health = await s.health();
    expect(health.value).toMatchObject({
      online: 900,
      working: 6,
      acceptedLastDay: 1731,
      enrolled: 909,
      receiptsQueued: 1774,
      computedAt: "2026-10-10T19:29:25.185Z",
    });
    expect(health.value.paidOrders).toBeGreaterThan(3000);
    expect(health.stale).toBe(false);
  });

  it("serves a hundred visitors from one upstream request", async () => {
    const { source: s, api } = source();
    await Promise.all(Array.from({ length: 100 }, () => s.health()));
    await Promise.all(Array.from({ length: 100 }, () => s.recentJobs(24)));
    expect(api.calls).toEqual(["GET /health", "GET /jobs"]);
    expect(s.usage()).toEqual({ usedThisMinute: 2, maxPerMinute: 40, pausedAfterFailures: false });
  });

  it("asks again only after its answer has aged, about once a minute at most", async () => {
    const c = clock();
    const { source: s, api } = source({ now: c.now });
    await s.health();
    c.advance(44_000);
    await s.health();
    expect(api.calls).toHaveLength(1);
    c.advance(100_000);
    await s.health();
    expect(api.calls).toHaveLength(2);
  });

  it("only ever sends GET, and leaves oracle panels out of the job list", async () => {
    const seen: { method: string; url: string }[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ method: init?.method ?? "GET", url: String(input) });
      return new Response(JSON.stringify(fixtureJson("jobs-limit3.json")));
    }) as typeof globalThis.fetch;
    const s = new HttpApiSource({ baseUrl: "https://api.imd.fun", maxPerMinute: 40, fetch });
    await s.recentJobs(500);
    expect(seen).toEqual([{ method: "GET", url: "https://api.imd.fun/jobs?limit=100&exclude=oracle" }]);
  });

  it("stops at its own budget instead of passing the load on, and says when to come back", async () => {
    const c = clock();
    const { source: s, api } = source({ max: 5, now: c.now });
    // Reads a visitor can cause one by one get four fifths of the budget.
    const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    const results = await Promise.allSettled(ids.map((id) => s.jobRecords(id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(UpstreamBusyError);
    expect((refused.reason as UpstreamBusyError).retryAfterMs).toBe(60_000);
    expect(api.calls).toHaveLength(4);
    // The swarm's own state still has room in the budget.
    await expect(s.health()).resolves.toBeDefined();
    expect(api.calls).toHaveLength(5);
    c.advance(60_001);
    await expect(s.jobRecords(ids[5]!)).resolves.toBeDefined();
  });

  it("returns a record's bytes exactly as served, and keeps them: a record never changes", async () => {
    const c = clock();
    const { source: s, api } = source({ now: c.now });
    expect(s.holdsRecord(REFERENCE_JOB.receipt)).toBe(false);
    const first = await s.workRecord(REFERENCE_JOB.receipt);
    c.advance(86_400_000);
    const second = await s.workRecord(
      REFERENCE_JOB.receipt.toUpperCase().replace("0X", "0x") as `0x${string}`,
    );
    expect(first?.bytes).toEqual(RECORD);
    // The time it was fetched travels with it, so a page can say when, not "just now".
    expect(first).toMatchObject({ origin: "identitymd", fetchedAt: 1_000_000 });
    expect(second).toBe(first);
    expect(s.holdsRecord(REFERENCE_JOB.receipt)).toBe(true);
    expect(api.calls).toEqual([`GET ${RECORD_ROUTE}`]);
  });

  it("keeps and returns only bytes that hash to the hash they were asked for", async () => {
    const c = clock();
    let healthy = false;
    const api = fakeApi({
      [RECORD_ROUTE]: () =>
        healthy
          ? new Response(RECORD.slice(), { headers: { "content-type": "application/json" } })
          : // What an error page or a bot checkpoint in front of the server looks like: status 200.
            new Response("<html><body>Checkpoint</body></html>", {
              headers: { "content-type": "text/html" },
            }),
    });
    const { source: s } = source({ api, now: c.now });
    await expect(s.workRecord(REFERENCE_JOB.receipt)).rejects.toBeInstanceOf(NotTheRecordError);
    await expect(s.workRecord(REFERENCE_JOB.receipt)).rejects.toThrow("do not hash to the hash");
    // Nothing was kept, and the failing server was asked once, not once per reader.
    expect(s.holdsRecord(REFERENCE_JOB.receipt)).toBe(false);
    expect(api.calls).toHaveLength(1);

    // The server recovers. After the short pause the real record is fetched, checked and kept.
    healthy = true;
    c.advance(21_000);
    const record = await s.workRecord(REFERENCE_JOB.receipt);
    expect(record?.bytes).toEqual(RECORD);
    expect(hashServedRecord(record!.bytes, REFERENCE_JOB.receipt).matches).toBe(true);
    expect(api.calls).toHaveLength(2);
  });

  it("refuses a cut-off record and a record served under the wrong hash", async () => {
    const cut = source({
      api: fakeApi({ [RECORD_ROUTE]: () => new Response(RECORD.slice(0, 4000)) }),
    });
    await expect(cut.source.workRecord(REFERENCE_JOB.receipt)).rejects.toBeInstanceOf(NotTheRecordError);
    const other = `0x${"cd".repeat(32)}` as const;
    const swapped = source({
      api: fakeApi({ [`/work-records/${other.slice(2)}.json`]: () => new Response(RECORD.slice()) }),
    });
    await expect(swapped.source.workRecord(other)).rejects.toBeInstanceOf(NotTheRecordError);
    expect(swapped.source.holdsRecord(other)).toBe(false);
  });

  it("accepts a record served with one trailing newline, and keeps the bytes that hash", async () => {
    const withNewline = new Uint8Array(RECORD.length + 1);
    withNewline.set(RECORD);
    withNewline[RECORD.length] = 0x0a;
    const { source: s } = source({ api: fakeApi({ [RECORD_ROUTE]: () => new Response(withNewline) }) });
    // The shared package's check hands back the bytes whose keccak256 is the hash asked for: the
    // record itself, without the newline some proxy added. Those are the bytes a settlement takes.
    const kept = (await s.workRecord(REFERENCE_JOB.receipt))?.bytes;
    expect(kept).toEqual(RECORD);
    expect(keccak256(kept!)).toBe(REFERENCE_JOB.receipt);
  });

  it("falls back on the record that ships with the site only while IdentityMD cannot be reached", async () => {
    const c = clock();
    let up = false;
    const api = fakeApi({
      [RECORD_ROUTE]: () => (up ? new Response(RECORD.slice()) : new Response("down", { status: 503 })),
    });
    const { source: s } = source({ api, now: c.now, pinned: [referencePin()] });
    const stored = await s.workRecord(REFERENCE_JOB.receipt);
    // The stored copy is the same 7,339 bytes, says that it is a stored copy, and claims no fetch time.
    expect(stored).toMatchObject({ origin: "stored", fetchedAt: null });
    expect(stored?.bytes).toEqual(RECORD);
    expect(api.calls).toHaveLength(1);
    // It is not mistaken for a fetched record: once IdentityMD answers, the fetched one replaces it.
    up = true;
    c.advance(21_000);
    expect(await s.workRecord(REFERENCE_JOB.receipt)).toMatchObject({ origin: "identitymd" });
    expect(api.calls).toHaveLength(2);
  });

  it("ignores a stored record that does not hash to its hash", async () => {
    const tampered = RECORD.slice();
    tampered[100] = (tampered[100] ?? 0) ^ 1;
    const api = fakeApi({ [RECORD_ROUTE]: () => new Response("down", { status: 503 }) });
    const { source: s } = source({
      api,
      pinned: [{ jobId: REFERENCE_JOB.jobId, hash: REFERENCE_JOB.receipt, bytes: tampered }],
    });
    expect(s.holdsRecord(REFERENCE_JOB.receipt)).toBe(false);
    await expect(s.workRecord(REFERENCE_JOB.receipt)).rejects.toThrow("HTTP 503");
  });

  it("the record that ships with the site is the reference record, byte for byte", () => {
    const pin = referencePin();
    expect(pin.bytes).toEqual(RECORD);
    expect(pin.bytes?.length).toBe(REFERENCE_JOB.recordBytes);
    expect(hashServedRecord(pin.bytes!, REFERENCE_JOB.receipt)).toMatchObject({
      matches: true,
      strippedNewline: false,
      keccak: REFERENCE_JOB.receipt,
    });
  });

  it("checks the reference job on its own account, whatever visitors have spent", async () => {
    const c = clock();
    const { source: s, api } = source({
      max: 5,
      now: c.now,
      pinned: [{ jobId: REFERENCE_JOB.jobId, hash: REFERENCE_JOB.receipt, bytes: null }],
    });
    // Visitors spend their whole share (four fifths of the budget) on records that do not exist.
    for (let i = 0; i < 4; i++) {
      expect(await s.workRecord(`0x${(i + 1).toString(16).padStart(64, "0")}`)).toBeNull();
    }
    await expect(s.workRecord(`0x${"9".repeat(64)}`)).rejects.toBeInstanceOf(UpstreamBusyError);
    // The reference record is still fetched, and then never pushed out by other records.
    expect((await s.workRecord(REFERENCE_JOB.receipt))?.bytes).toEqual(RECORD);
    expect(api.calls).toHaveLength(5);
    expect(s.holdsRecord(REFERENCE_JOB.receipt)).toBe(true);
  });

  it("leaves the API alone after it fails to answer twice in a row, and tries again later", async () => {
    const c = clock();
    let up = false;
    let requests = 0;
    const s = new HttpApiSource({
      baseUrl: "https://api.imd.test",
      maxPerMinute: 40,
      now: c.now,
      // Each key gets its own cache entry, so only the breaker stands between these reads and the API.
      cache: new TtlCache({ now: c.now, failureTtlMs: 0 }),
      fetch: (async () => {
        requests++;
        if (!up) throw new Error("fetch failed");
        return new Response(JSON.stringify({ records: [] }));
      }) as typeof fetch,
    });
    const job = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    await expect(s.jobRecords(job(1))).rejects.toThrow("fetch failed");
    await expect(s.jobRecords(job(2))).rejects.toThrow("fetch failed");
    expect(s.usage().pausedAfterFailures).toBe(true);
    // Now nothing is sent: readers are told at once, with when the next attempt will be.
    await expect(s.jobRecords(job(3))).rejects.toBeInstanceOf(UpstreamDownError);
    await expect(s.workRecord(`0x${"7".repeat(64)}`)).rejects.toThrow("not asked again for 15 s");
    expect(requests).toBe(2);
    // After the pause one request goes through as a probe; its success ends the pause.
    up = true;
    c.advance(15_001);
    await expect(s.jobRecords(job(4))).resolves.toBeDefined();
    expect(s.usage().pausedAfterFailures).toBe(false);
    expect(requests).toBe(3);
  });

  it("does not count a 404 as the API failing", async () => {
    const { source: s } = source();
    for (let i = 0; i < 5; i++) {
      expect((await s.jobRecords(`00000000-0000-4000-8000-00000000001${i}`)).value).toBeNull();
    }
    expect(s.usage().pausedAfterFailures).toBe(false);
  });

  it("remembers a missing record for a minute only, because it may still appear", async () => {
    const c = clock();
    const { source: s, api } = source({ now: c.now });
    const hash = `0x${"ab".repeat(32)}` as const;
    expect(await s.workRecord(hash)).toBeNull();
    expect(await s.workRecord(hash)).toBeNull();
    expect(api.calls).toHaveLength(1);
    c.advance(61_000);
    expect(await s.workRecord(hash)).toBeNull();
    expect(api.calls).toHaveLength(2);
  });

  it("answers null for a job the API does not know, and throws for a server error", async () => {
    const { source: s } = source();
    expect((await s.jobRecords("00000000-0000-4000-8000-000000000000")).value).toBeNull();
    const failing = source({ api: fakeApi({ "/health": () => new Response("oops", { status: 500 }) }) });
    await expect(failing.source.health()).rejects.toThrow("/health answered 500");
    expect(() => s.jobRecords("nope")).toThrow(TypeError);
  });

  it("refuses a body in an unexpected shape rather than print nonsense", async () => {
    const json = (body: unknown) => () =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    // The shapes are the shared package's schemas; what they refuse reaches a page as one error.
    for (const body of [{}, { connectedDaemons: "900", workingNow: 6 }, null]) {
      const { source: s } = source({ api: fakeApi({ "/health": json(body) }) });
      await expect(s.health()).rejects.toBeInstanceOf(ApiShapeError);
    }
    const jobs = source({ api: fakeApi({ "/jobs": json({ jobs: "none" }) }) });
    await expect(jobs.source.recentJobs(3)).rejects.toBeInstanceOf(ApiShapeError);
    const records = source({
      api: fakeApi({ [`/jobs/${REFERENCE_JOB.jobId}/records`]: json({ records: [{ hash: "short" }] }) }),
    });
    await expect(records.source.jobRecords(REFERENCE_JOB.jobId)).rejects.toBeInstanceOf(ApiShapeError);
    // Optional parts that are missing come back as null, not as zero.
    expect(
      healthView(Health.parse({ status: "ok", version: "1", connectedDaemons: 5, workingNow: 1 })),
    ).toMatchObject({
      online: 5,
      working: 1,
      receiptsQueued: null,
      paidOrders: null,
      acceptedLastDay: null,
    });
  });

  it("shows a link from the API only when it is plain http(s)", () => {
    const job = {
      id: "10d225a6-92cb-4cde-9d4b-ec076b078f7d",
      state: "completed",
      template: "skill:research-report",
      objective: "x",
      createdAt: "2026-10-10T19:34:00Z",
      updatedAt: "2026-10-10T19:46:00Z",
    };
    const jobs = jobsView(
      JobsList.parse({
        count: 2,
        jobs: [
          { ...job, delivery: { repoUrl: "javascript:alert(1)" } },
          {
            ...job,
            id: "20d225a6-92cb-4cde-9d4b-ec076b078f7d",
            delivery: { repoUrl: "https://github.com/a/b" },
          },
        ],
      }),
    );
    expect(jobs.map((j) => j.deliveryUrl)).toEqual([null, "https://github.com/a/b"]);
    expect(safeHttpUrl("https://github.com/a/b")).toBe("https://github.com/a/b");
    expect(safeHttpUrl("data:text/html,x")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    // A list with a job that has no proper id is not a list this site prints from.
    expect(() => JobsList.parse({ count: 1, jobs: [{ ...job, id: "not-a-uuid" }] })).toThrow();
  });

  it("reads a job's record list with hashes normalised to 0x and lower case", () => {
    expect(recordsView(JobRecords.parse(fixtureJson("job-records-e9efec16.json")))).toEqual([
      { hash: REFERENCE_JOB.receipt, status: "sent", txHash: REFERENCE_JOB.receiptTx, failure: null },
    ]);
    expect(recordsView(JobRecords.parse(fixtureJson("job-records-e70c56ce.json")))).toEqual([
      { hash: HEADER_JOB.recordHash, status: "queued", txHash: null, failure: null },
    ]);
  });

  it("reads one job in full, but only a job this server names itself", async () => {
    const { source: s, api } = source({ ownJobs: [LAUNCH_A_JOB.jobId] });
    const job = (await s.job(LAUNCH_A_JOB.jobId)).value;
    expect(job).toMatchObject({
      id: LAUNCH_A_JOB.jobId,
      state: "executing",
      template: "shape:chain",
      paidBy: "0x871e507b6a70f858ad4b414bddb77473630c366b",
      baseCommit: "4124672e6121e7333917934e6da24fd433132d68",
      launch: { requested: true, kind: "evm_contracts", id: null, status: null, chainId: 1 },
    });
    expect(job?.steps.length).toBeGreaterThan(5);
    expect(job?.steps.find((step) => step.key === "audit_flow")).toEqual({
      key: "audit_flow",
      role: "review",
      state: "accepted",
    });
    // Cached: a second reader costs IdentityMD nothing.
    await s.job(LAUNCH_A_JOB.jobId);
    expect(api.calls).toEqual([`GET /jobs/${LAUNCH_A_JOB.jobId}`]);
    // A job nobody told this server to read in full is refused before anything is asked.
    expect(() => s.job(REFERENCE_JOB.jobId)).toThrow(TypeError);
    expect(() => s.job("nope")).toThrow(TypeError);
    expect(api.calls).toHaveLength(1);
    // A pinned job is one of the server's own; one the API does not know reads as null.
    const pinned = source({
      pinned: [{ jobId: HEADER_JOB.jobId, hash: HEADER_JOB.recordHash, bytes: null }],
    });
    const header = (await pinned.source.job(HEADER_JOB.jobId)).value;
    expect(header).toMatchObject({ state: "completed", template: "skill:research-report" });
    expect(header?.objective.startsWith("[help-wanted order de7eddaa")).toBe(true);
    const unknown = source({ ownJobs: ["00000000-0000-4000-8000-000000000000"] });
    expect((await unknown.source.job("00000000-0000-4000-8000-000000000000")).value).toBeNull();
  });
});

describe("the chain source", () => {
  it("reads a receipt once and remembers it", async () => {
    const world = testSources();
    const { chain } = world.sources;
    expect(await chain.receipt(REFERENCE_JOB.jobIdBytes16)).toBe(REFERENCE_JOB.receipt);
    expect(await chain.receipt(REFERENCE_JOB.jobIdBytes16)).toBe(REFERENCE_JOB.receipt);
    expect(world.chain.calls).toEqual([`eth_call ${MAINNET.WORK_REGISTRY.toLowerCase()}`]);
  });

  it("says when the registry was actually read, not when the page was made", async () => {
    const c = clock();
    const world = testSources({ now: c.now });
    const { chain } = world.sources;
    expect(chain.hasRecentReceipt(REFERENCE_JOB.jobIdBytes16)).toBe(false);
    const first = await chain.receiptRead(REFERENCE_JOB.jobIdBytes16);
    expect(first).toMatchObject({ value: REFERENCE_JOB.receipt, fetchedAt: 1_000_000, stale: false });
    c.advance(30_000);
    // Thirty seconds on, the same read is reused and still carries the time it was made.
    expect(await chain.receiptRead(REFERENCE_JOB.jobIdBytes16)).toMatchObject({ fetchedAt: 1_000_000 });
    expect(chain.hasRecentReceipt(REFERENCE_JOB.jobIdBytes16)).toBe(true);
    expect(world.chain.calls).toHaveLength(1);
  });

  it("re-reads a written receipt within about a minute, so a superseding one is not missed for long", async () => {
    const c = clock();
    const id = "0x000000000000400080000000000000cc" as const;
    const before = fakeChain({ receipts: { [id]: `0x${"11".repeat(32)}` } });
    const after = fakeChain({ receipts: { [id]: `0x${"22".repeat(32)}` } });
    let registry = before;
    const chain = new RpcChainSource({
      reader: { ...before.reader, call: (to, data) => registry.reader.call(to, data) },
      rpcHost: "rpc.test",
      logWindowBlocks: 7200,
      tallyDays: 14,
      now: c.now,
    });
    expect(await chain.receipt(id)).toBe(`0x${"11".repeat(32)}`);
    // The job is continued and the registry now holds a newer receipt.
    registry = after;
    c.advance(46_000);
    // Past 45 seconds the old read is served once more while a new one is made behind it...
    expect(await chain.receiptRead(id)).toMatchObject({ value: `0x${"11".repeat(32)}`, stale: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // ...and the next reader has the new receipt, with the time of the new read.
    expect(await chain.receiptRead(id)).toMatchObject({
      value: `0x${"22".repeat(32)}`,
      fetchedAt: 1_046_000,
      stale: false,
    });
  });

  it("asks again about a missing receipt after 45 seconds, since one may land any minute", async () => {
    const c = clock();
    const world = testSources({ now: c.now });
    const id = "0x000000000000400080000000000000aa" as const;
    expect(await world.sources.chain.receipt(id)).toBe(`0x${"0".repeat(64)}`);
    c.advance(44_000);
    await world.sources.chain.receipt(id);
    expect(world.chain.calls).toHaveLength(1);
    c.advance(2_000);
    await world.sources.chain.receipt(id);
    expect(world.chain.calls).toHaveLength(2);
  });

  it("asks about many jobs in one multicall, and answers null per job when the call cannot be made", async () => {
    const world = testSources();
    const other = "0x000000000000400080000000000000bb" as const;
    const read = await world.sources.chain.receipts([REFERENCE_JOB.jobIdBytes16, other]);
    expect(read.get(REFERENCE_JOB.jobIdBytes16)).toBe(REFERENCE_JOB.receipt);
    expect(read.get(other)).toBe(`0x${"0".repeat(64)}`);
    expect(world.chain.calls).toEqual([`eth_call ${MULTICALL3.toLowerCase()}`]);
    expect((await world.sources.chain.receipts([])).size).toBe(0);

    const down = testSources({ chain: { failCalls: true } });
    const failed = await down.sources.chain.receipts([other]);
    expect(failed.get(other)).toBeNull();
  });

  it("resolves an agent to its seat and the seat's owner, and an unknown agent to nothing", async () => {
    const world = testSources();
    const bindings = await world.sources.chain.bindings(["52211", "7", "not-a-number"]);
    expect(bindings).toEqual([
      { agentId: "52211", bound: true, isSeat: true, tokenId: "1998", owner: SEAT_OWNER },
      { agentId: "7", bound: false, isSeat: false, tokenId: null, owner: null },
    ]);
    expect(world.sources.chain.agentsSeenForSeat(1998)).toEqual(["52211"]);
    expect(world.sources.chain.agentsSeenForSeat(5)).toEqual([]);
  });

  it("knows a seat number from an id that is not one without asking the chain", async () => {
    const world = testSources();
    expect((await world.sources.chain.seatOwner(2000)).value).toBeNull();
    expect((await world.sources.chain.seatOwner(-1)).value).toBeNull();
    expect((await world.sources.chain.seatOwner(1.5)).value).toBeNull();
    expect(world.chain.calls).toEqual([]);
    expect((await world.sources.chain.seatOwner(0)).value).toBe(SEAT_OWNER);
  });

  it("serves the recorded Intake history even when the chain cannot be read, and says so", async () => {
    const world = testSources({ chain: { failCalls: true } });
    const history = await world.sources.chain.intake();
    // Two recorded files: version 1 up to block 26,164,626 (8 requests) and both versions for
    // blocks 26,172,396 to 26,182,396 (4 of version 1, 20 of version 2).
    expect(history.requests).toHaveLength(32);
    expect(history.legacy).toMatchObject({ version: 1, listed: 12, nonce: null, complete: null });
    expect(history.current).toMatchObject({ version: 2, listed: 20, nonce: null, complete: null });
    expect(history.legacy.address).toBe(MAINNET.INTAKE_V1);
    expect(history.current.address).toBe(MAINNET.INTAKE);
    expect(history.legacy.recorded).toEqual([
      { fromBlock: 24117248, toBlock: 26164626 },
      { fromBlock: 26172396, toBlock: 26182396 },
    ]);
    expect(history.current.recorded).toEqual([{ fromBlock: 26172396, toBlock: 26182396 }]);
    expect(history.stale).toBe(true);
    expect(history.error).toContain("the RPC is down");
  });

  it("counts each Intake against its own counter, and says a list is incomplete when it is", async () => {
    const world = testSources();
    const history = await world.sources.chain.intake();
    // As read on 13 October 2026: version 1 had taken 13 requests, version 2 had taken 44.
    expect(history.legacy).toMatchObject({ nonce: 13, listed: 12, complete: false });
    expect(history.current).toMatchObject({ nonce: 44, listed: 20, complete: false });
    expect(history.current.priceWei).toBe(500_000_000_000_000_000n);
    expect(history.requests.every((r) => r.version === 1 || r.version === 2)).toBe(true);
    // The four purchases that put the house feed questions to the live oracle are in the list.
    const w1 = "0x871e507b6a70f858ad4b414bddb77473630c366b";
    const ours = history.requests.filter((r) => r.payer === w1);
    expect(ours).toHaveLength(4);
    expect(ours.every((r) => r.version === 1 && r.callbackTarget === null)).toBe(true);
    expect(ours.map((r) => r.txHash)).toEqual(
      expect.arrayContaining([
        FEED_PROOFS.payrolls.transaction,
        FEED_PROOFS.hires.transaction,
        FEED_PROOFS.employers.transaction,
        EMPLOYERS_FIRST_ATTEMPT.transaction,
      ]),
    );
  });

  it("adds a newer Intake request to the recorded ones when a scan finds it", async () => {
    const seedRequest = (intakeWindowSeed.logs as RawLog[]).find(
      (log) => log.topics[0]?.startsWith("0x1c521a43") && sameAddress(log.address, MAINNET.INTAKE),
    );
    const newer: RawLog = {
      ...seedRequest!,
      topics: [
        seedRequest!.topics[0]!,
        `0x${"fe".repeat(32)}`,
        seedRequest!.topics[2]!,
        seedRequest!.topics[3]!,
      ],
      blockNumber: `0x${(26_182_450).toString(16)}`,
      transactionHash: `0x${"ee".repeat(32)}`,
      logIndex: "0x1",
    };
    // A log of some other contract that a node returned all the same is not an Intake request.
    const stranger: RawLog = { ...newer, address: MAINNET.IMD, transactionHash: `0x${"ef".repeat(32)}` };
    const world = testSources({
      chain: { head: 26_182_500, intakeLogs: [newer, stranger], intakeNonce: 21n, intakeV1Nonce: 12n },
    });
    const history = await world.sources.chain.intake();
    expect(history.requests).toHaveLength(33);
    expect(history.requests.find((r) => r.requestId === `0x${"fe".repeat(32)}`)).toMatchObject({
      version: 2,
      block: 26_182_450,
    });
    expect(history.current).toMatchObject({ listed: 21, nonce: 21, complete: true });
    expect(history.legacy).toMatchObject({ listed: 12, nonce: 12, complete: true });
    expect(history.scannedToBlock).toBe(26_182_500);
    // Only blocks after the recorded history are scanned, once for each Intake.
    expect(world.chain.calls.filter((c) => c.startsWith("eth_getLogs"))).toEqual([
      `eth_getLogs ${MAINNET.INTAKE.toLowerCase()} 26182397-26182500`,
      `eth_getLogs ${MAINNET.INTAKE_V1.toLowerCase()} 26182397-26182500`,
    ]);
  });
});

describe("the ceiling and the breaker in front of the RPC", () => {
  function reader(behaviour: () => Promise<`0x${string}`>): { reader: EthReader; calls: () => number } {
    let calls = 0;
    const base = fakeChain().reader;
    return {
      calls: () => calls,
      reader: {
        ...base,
        call: async () => {
          calls++;
          return behaviour();
        },
      },
    };
  }
  const guards = (c: { now: () => number }, max = 5, visitor: number | null = null) => ({
    name: "The Ethereum RPC",
    all: new SlidingWindowLimiter({ max, windowMs: 60_000, now: c.now }),
    visitor:
      visitor === null ? null : new SlidingWindowLimiter({ max: visitor, windowMs: 60_000, now: c.now }),
    breaker: new Breaker("The Ethereum RPC", { now: c.now }),
  });

  it("sends at most the ceiling a minute, whatever asks", async () => {
    const c = clock();
    const raw = reader(async () => "0x01");
    const guarded = guardReader(raw.reader, guards(c, 5));
    for (let i = 0; i < 5; i++) await guarded.call("0x00", "0x");
    await expect(guarded.call("0x00", "0x")).rejects.toBeInstanceOf(UpstreamBusyError);
    expect(raw.calls()).toBe(5);
    c.advance(60_001);
    await expect(guarded.call("0x00", "0x")).resolves.toBe("0x01");
  });

  it("gives reads a visitor can cause a smaller share than the server's own", async () => {
    const c = clock();
    const raw = reader(async () => "0x01");
    const shared = guards(c, 5, 3);
    const visitors = guardReader(raw.reader, shared);
    const own = guardReader(raw.reader, { ...shared, visitor: null });
    for (let i = 0; i < 3; i++) await visitors.call("0x00", "0x");
    await expect(visitors.call("0x00", "0x")).rejects.toBeInstanceOf(UpstreamBusyError);
    // The server's own reads still have room.
    await expect(own.call("0x00", "0x")).resolves.toBe("0x01");
    expect(raw.calls()).toBe(4);
  });

  it("stops asking an RPC that does not answer, and treats a reverted call as an answer", async () => {
    const c = clock();
    let mode: "down" | "reverts" | "up" = "down";
    const raw = reader(async () => {
      if (mode === "down") throw new Error("fetch failed");
      if (mode === "reverts") throw new RpcError("eth_call: execution reverted", 3);
      return "0x01";
    });
    const guarded = guardReader(raw.reader, guards(c, 100));
    await expect(guarded.call("0x00", "0x")).rejects.toThrow("fetch failed");
    await expect(guarded.call("0x00", "0x")).rejects.toThrow("fetch failed");
    await expect(guarded.call("0x00", "0x")).rejects.toBeInstanceOf(UpstreamDownError);
    expect(raw.calls()).toBe(2);
    c.advance(15_001);
    // A node that answers "reverted" is answering: ten of those do not pause anything.
    mode = "reverts";
    for (let i = 0; i < 10; i++) await expect(guarded.call("0x00", "0x")).rejects.toThrow("reverted");
    mode = "up";
    await expect(guarded.call("0x00", "0x")).resolves.toBe("0x01");
    expect(raw.calls()).toBe(13);
  });

  it("leaves the RPC alone after a single timeout, the failure that costs a reader seconds", async () => {
    const c = clock();
    const raw = reader(async () => {
      // What AbortSignal.timeout raises when the node accepts the connection and never answers.
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const guarded = guardReader(raw.reader, guards(c, 100));
    await expect(guarded.call("0x00", "0x")).rejects.toThrow("timeout");
    // The very next reader is not made to wait out another timeout.
    await expect(guarded.call("0x00", "0x")).rejects.toBeInstanceOf(UpstreamDownError);
    expect(raw.calls()).toBe(1);
    const breaker = new Breaker("x", { now: c.now });
    breaker.failed(new Error("refused"));
    expect(breaker.open).toBe(false);
    breaker.failed(new Error("refused"));
    expect(breaker.open).toBe(true);
    breaker.succeeded();
    expect(breaker.open).toBe(false);
  });

  it("caps what any number of new job ids can make the server send to the registry", async () => {
    const world = testSources({ env: { RPC_MAX_PER_MINUTE: "20" } });
    const { chain } = world.sources;
    const results = await Promise.allSettled(
      Array.from({ length: 60 }, (_, i) =>
        chain.receipt(`0x${i.toString(16).padStart(32, "0")}` as `0x${string}`),
      ),
    );
    // Three quarters of the ceiling is the visitors' share; the rest stays for the server's own reads.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(15);
    expect(world.chain.calls.filter((call) => call.startsWith("eth_call"))).toHaveLength(15);
    expect(chain.usage()).toEqual({ usedThisMinute: 15, maxPerMinute: 20, pausedAfterFailures: false });
    // The reference job is the server's own check and is still read.
    await expect(chain.receipt(REFERENCE_JOB.jobIdBytes16)).resolves.toBe(REFERENCE_JOB.receipt);
  });
});

describe("payment history: the range a release prints", () => {
  it("is the whole range on a first read, and stays one day long however long the process runs", async () => {
    let now = 1_800_000_000_000;
    let head = 26_170_000;
    const start = head;
    const base = fakeChain({ head, transferLogs: [] });
    const chain = new RpcChainSource({
      reader: { ...base.reader, blockNumber: async () => BigInt(head) },
      rpcHost: "rpc.test",
      logWindowBlocks: 7200,
      tallyDays: 14,
      now: () => now,
    });
    const first = await chain.payments();
    expect(first.window).toMatchObject({ fromBlock: start - 7199, toBlock: start });
    expect(first.recent).toEqual(first.window);

    // Ten hours later (3,000 blocks). What is held has grown; what a release prints has not.
    head += 3000;
    now += 10 * 3_600_000;
    const later = await chain.payments();
    expect(later.window).toMatchObject({ fromBlock: start - 7199, toBlock: head });
    expect(later.recent.fromBlock).toBe(head - 7199);
    expect(later.recent.toBlock).toBe(head);
    expect(later.recent.toBlock - later.recent.fromBlock + 1).toBe(7200);
    // Its start has a time of its own, read for that block.
    expect(later.recent.fromTime).not.toBeNull();
    expect(later.recent.fromTime).toBeGreaterThan(later.window.fromTime as number);
  });

  it("counts only IMD transfers to the fee address, whatever logs the node hands back", async () => {
    const stray: RawLog = {
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      topics: [
        `0x${"11".repeat(32)}`,
        `0x${"0".repeat(24)}${"ab".repeat(20)}`,
        `0x${"0".repeat(24)}${"cd".repeat(20)}`,
      ],
      data: `0x${(10n ** 24n).toString(16)}`,
      blockNumber: "0x18f4d40",
      transactionHash: `0x${"ee".repeat(32)}`,
      logIndex: "0x0",
    };
    // A log with a field missing must not stop the refresh either.
    const broken = { ...TRANSFERS.logs[0]!, blockNumber: undefined } as unknown as RawLog;
    const head = TRANSFERS.toBlock;
    const base = fakeChain({ head });
    const chain = new RpcChainSource({
      reader: { ...base.reader, getLogs: async () => [stray, broken, ...TRANSFERS.logs] },
      rpcHost: "rpc.test",
      logWindowBlocks: 7200,
      tallyDays: 14,
    });
    const history = await chain.payments();
    expect(history.payments).toHaveLength(99);
    expect(history.payments.reduce((sum, p) => sum + p.amountWei, 0n)).toBe(121n * 10n ** 18n);
  });
});

describe("payment history with an archive RPC", () => {
  const IMD_TOKEN = MAINNET.IMD.toLowerCase();
  const older = (block: number, n: number): RawLog => ({
    ...TRANSFERS.logs[0]!,
    blockNumber: `0x${block.toString(16)}`,
    blockTimestamp: `0x${(1_791_580_691 - (TRANSFERS.fromBlock - block) * 12).toString(16)}`,
    transactionHash: `0x${n.toString(16).padStart(64, "0")}`,
    logIndex: "0x0",
  });

  async function settled(source: RpcChainSource) {
    for (let i = 0; i < 50; i++) {
      const history = await source.payments();
      if (history.archive !== "running") return history;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("the backfill did not finish");
  }

  it("fills in older days behind the public window, newest first, and says so", async () => {
    const live = fakeChain();
    const archive = fakeChain({
      transferLogs: [older(TRANSFERS.fromBlock - 10, 1), older(TRANSFERS.fromBlock - 7000, 2)],
    });
    const source = new RpcChainSource({
      reader: live.reader,
      archiveReader: archive.reader,
      rpcHost: "rpc.test",
      logWindowBlocks: 7200,
      tallyDays: 1,
    });
    expect((await source.payments()).window.toBlock).toBe(TRANSFERS.toBlock);
    const history = await settled(source);
    expect(history.archive).toBe("done");
    expect(history.payments).toHaveLength(101);
    // One more day of 7,200 blocks, contiguous with the public window: no hole in the range.
    expect(history.window.fromBlock).toBe(TRANSFERS.fromBlock - 7200);
    expect(history.window.toBlock).toBe(TRANSFERS.toBlock);
    expect(archive.calls.filter((c) => c.startsWith("eth_getLogs"))).toEqual([
      `eth_getLogs ${IMD_TOKEN} ${TRANSFERS.fromBlock - 5000}-${TRANSFERS.fromBlock - 1}`,
      `eth_getLogs ${IMD_TOKEN} ${TRANSFERS.fromBlock - 7200}-${TRANSFERS.fromBlock - 5001}`,
    ]);
    // The public RPC was asked only for what it serves.
    expect(live.calls.filter((c) => c.startsWith("eth_getLogs"))).toEqual([
      `eth_getLogs ${IMD_TOKEN} ${TRANSFERS.fromBlock}-${TRANSFERS.toBlock}`,
    ]);
  });

  it("claims nothing older when the archive RPC fails, and reports the failure", async () => {
    const source = new RpcChainSource({
      reader: fakeChain().reader,
      archiveReader: fakeChain({ failCalls: true }).reader,
      rpcHost: "rpc.test",
      logWindowBlocks: 7200,
      tallyDays: 14,
    });
    await source.payments();
    const history = await settled(source);
    expect(history.archive).toBe("failed");
    expect(history.archiveNote).toContain("the RPC is down");
    expect(history.window.fromBlock).toBe(TRANSFERS.fromBlock);
    expect(history.payments).toHaveLength(99);
  });
});

describe("Intake logs", () => {
  const requests = decodeIntakeLogs(intakeSeed.logs as RawLog[]);

  it("the older recorded history is eight requests of version 1, five of them completed, oldest first", () => {
    expect(intakeSeed.intakeNonceAtFetch).toBe(8);
    expect(requests).toHaveLength(8);
    expect(requests.every((r) => r.version === 1)).toBe(true);
    expect(requests.filter((r) => r.completion !== null)).toHaveLength(5);
    expect(requests.map((r) => r.block)).toEqual([...requests.map((r) => r.block)].sort((a, b) => a - b));
    expect(requests[0]?.block).toBe(26_142_980);
  });

  it("the newer recorded range holds both Intakes, and each request says which one logged it", () => {
    expect(intakeWindowSeed.noncesAtFetch).toEqual({ v1: 13, v2: 44 });
    const both = decodeIntakeLogs(intakeWindowSeed.logs as RawLog[]);
    expect(both.filter((r) => r.version === 1)).toHaveLength(4);
    expect(both.filter((r) => r.version === 2)).toHaveLength(20);
    expect(both.filter((r) => r.version === 2 && r.completion !== null)).toHaveLength(18);
    for (const r of both) {
      expect(r.block).toBeGreaterThanOrEqual(intakeWindowSeed.fromBlock);
      expect(r.block).toBeLessThanOrEqual(intakeWindowSeed.toBlock);
    }
    // The two contracts count separately: the same request id under both stays two requests.
    const one = (intakeWindowSeed.logs as RawLog[]).find(
      (log) => log.topics[0]?.startsWith("0x1c521a43") && sameAddress(log.address, MAINNET.INTAKE),
    )!;
    const twin: RawLog = { ...one, address: MAINNET.INTAKE_V1, transactionHash: `0x${"ad".repeat(32)}` };
    expect(
      decodeIntakeLogs([one, twin])
        .map((r) => r.version)
        .sort(),
    ).toEqual([1, 2]);
  });

  it("each request names its payer, its price in IMD and the oracle action", () => {
    for (const r of requests) {
      expect(r.payer).toMatch(/^0x[0-9a-f]{40}$/);
      expect(r.action).toBe("oracle.request@oracle-1");
      expect(r.asset).toBe(MAINNET.IMD.toLowerCase());
      expect(r.amountWei).toBe(500_000_000_000_000_000n);
      expect(r.bodyBytes).toBeGreaterThan(0);
      expect(r.timestamp).toBeGreaterThan(1_790_000_000);
    }
  });

  it("joins each completion to its request, and skips logs it cannot read", () => {
    const junk: RawLog = { ...(intakeSeed.logs[0] as RawLog), topics: ["0xdeadbeef"], logIndex: "0x99" };
    const removed: RawLog = { ...(intakeSeed.logs[0] as RawLog), removed: true };
    expect(decodeIntakeLogs([junk, removed])).toEqual([]);
    expect(decodeIntakeLogs([...(intakeSeed.logs as RawLog[]), junk])).toHaveLength(8);
    for (const r of requests) {
      if (r.completion) expect(r.completion.block).toBeGreaterThanOrEqual(r.block);
    }
  });

  it("reads a question body as data and refuses anything that is not the expected JSON", () => {
    expect(
      parseQuestionBody(
        '{"question":"How many?","answerType":"uint256","panelSize":5,"quorum":3,"window":{"fromBlock":1,"toBlock":2},"evidence":"chain"}',
      ),
    ).toEqual({
      text: "How many?",
      answerType: "uint256",
      panelSize: 5,
      quorum: 3,
      evidence: "chain",
      window: "blocks 1 to 2",
      validForSeconds: null,
    });
    expect(parseQuestionBody('{"question":"x","window":{"hours":1}}')?.window).toBe("the last 1 hour");
    expect(parseQuestionBody('{"question":"x","window":{"fromBlock":7,"toBlock":7}}')?.window).toBe(
      "block 7",
    );
    expect(parseQuestionBody("not json")).toBeNull();
    expect(parseQuestionBody("[]")).toBeNull();
    expect(parseQuestionBody('{"question":5}')).toBeNull();
  });
});
