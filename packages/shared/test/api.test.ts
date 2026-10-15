import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  Capabilities,
  Challenge,
  CheckResult,
  Health,
  INTAKE_COMPLETION_STATUS,
  INTAKE_STATE,
  ImdApiError,
  ImdClient,
  ImdSchemaError,
  IntakeRead,
  Job,
  JobRecords,
  JobResult,
  JobsList,
  LaunchesList,
  OracleAttestationDocument,
  OracleRequest,
  OracleRequestsList,
  PAID_ACTIONS,
  PaidByList,
  Quote,
  RequestStatus,
  isNotAttested,
  isNotFound,
  isUnknownTransaction,
  parseRetryAfter,
} from "../src/api/index.js";
import { MAINNET, isIntake, sameAddress } from "../src/index.js";
import { fixture, readJson } from "./paths.js";

const JOB = "e9efec16-56f3-40d3-9243-52c453effc7d";
const RECEIPT = "3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5";

const text = (name: string) => readFileSync(fixture("api", name), "utf8");

/** A fake `fetch` that answers from a script and records what it was asked. No network is touched. */
function fakeFetch(
  script: (url: string, init: RequestInit | undefined, n: number) => Response | Promise<Response>,
) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return script(String(input), init, calls.length);
  };
  return { impl, calls };
}

/** A clock the client sleeps on, so tests never wait. */
function fakeClock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    sleeps,
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("schemas accept the real responses", () => {
  it("GET /health", () => {
    const health = Health.parse(readJson(fixture("api", "health.json")));
    expect(health.status).toBe("ok");
    expect(health.payments?.enabled).toBe(true);
    expect(health.connectedDaemons).toBeGreaterThan(0);
    expect(health.pendingFeedback).toBeGreaterThan(0);
    // Unknown fields pass through untouched.
    expect((health as Record<string, unknown>).operatorSurface).toBe("authenticated");
  });

  it("GET /requests/capabilities", () => {
    const caps = Capabilities.parse(readJson(fixture("api", "requests-capabilities.json")));
    expect(caps.actions.map((a) => a.action).sort()).toEqual([...PAID_ACTIONS].sort());
    expect(caps.payment.assetTransferMethod).toBe("permit2");
    expect(caps.payment.x402Version).toBe(2);
  });

  it("GET /jobs", () => {
    const list = JobsList.parse(readJson(fixture("api", "jobs-limit3.json")));
    expect(list.count).toBe(3);
    expect(list.jobs).toHaveLength(3);
  });

  it("GET /jobs/:id", () => {
    const job = Job.parse(readJson(fixture("api", "job-e9efec16.json")));
    expect(job.id).toBe(JOB);
    expect(job.state).toBe("completed");
    expect(job.template).toBe("skill:research-report");
    expect(job.paidBy).toBe("0x424f7381b6cfe63963732c52613c87cb54c5c755");
    expect(job.nodes?.[0]?.seat).toEqual({ tokenId: "1998", agentId: "52211" });
    expect(job.objective.startsWith("Design a ")).toBe(true);
  });

  it("GET /jobs/:id/result", () => {
    const result = JobResult.parse(readJson(fixture("api", "job-result-e9efec16.json")));
    expect(result.complete).toBe(true);
    expect(result.files[0]?.url).toBe(`https://api.imd.fun/artifacts/${result.files[0]?.hash}`);
  });

  it("GET /jobs/:id/records", () => {
    const records = JobRecords.parse(readJson(fixture("api", "job-records-e9efec16.json")));
    expect(records.records[0]?.hash).toBe(RECEIPT);
    expect(records.records[0]?.status).toBe("sent");
    expect(sameAddress(records.records[0]?.registry, MAINNET.WORK_REGISTRY)).toBe(true);
  });

  it("GET /oracle/requests and one request", () => {
    const list = OracleRequestsList.parse(readJson(fixture("oracle", "requests-list.json")));
    expect(list.count).toBe(100);
    const one = OracleRequest.parse(
      readJson(fixture("oracle", "requests", "dbcac6c2-6328-47a9-8e07-4c7b55f78e45.json")),
    );
    expect(one.evidence).toBe("chain");
    expect(one.definitions?.recipe).toContain("log-sum");
  });

  it("GET /requests/paid-by/:address", () => {
    const list = PaidByList.parse(readJson(fixture("api", "requests-paid-by-424f7381.json")));
    expect(list.payer).toBe("0x424f7381b6cfe63963732c52613c87cb54c5c755");
    expect(list.orders).toHaveLength(list.count);
    const jobs = list.orders.filter((o) => o.action === "job.open");
    expect(jobs.length).toBeGreaterThan(0);
    // What a payer that lost its token needs: the job each paid order opened.
    for (const order of jobs) {
      expect(order.status).toBe("admitted");
      expect(order.result?.kind).toBe("job");
      expect(order.result?.jobId).toMatch(/^[0-9a-f-]{36}$/);
    }
    // Newest first.
    const times = list.orders.map((o) => Date.parse(o.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // The input and the signatures are never listed.
    for (const order of list.orders) {
      expect("input" in order || "inputJson" in order || "quoteSignature" in order).toBe(false);
    }
  });

  it("GET /launches", () => {
    const list = LaunchesList.parse(readJson(fixture("api", "launches-limit3.json")));
    expect(list.launches).toHaveLength(3);
    expect(list.launches[0]?.launchNumber).toBeGreaterThan(1000);
  });

  it("reject a response that lost a field the product depends on", () => {
    const job = readJson<Record<string, unknown>>(fixture("api", "job-e9efec16.json"));
    delete job.state;
    expect(Job.safeParse(job).success).toBe(false);
    const records = readJson<{ records: Record<string, unknown>[] }>(
      fixture("api", "job-records-e9efec16.json"),
    );
    (records.records[0] as Record<string, unknown>).hash = `0x${RECEIPT}`;
    expect(JobRecords.safeParse(records).success).toBe(false);
  });
});

describe("the Intake read and the signed answer, as served on 13 October 2026", () => {
  const intake = (name: string) => IntakeRead.parse(readJson(fixture("api", "intake", name)));

  it("a request with no callback that the plane has decided and the writer has not written", () => {
    const read = intake("1-c75123bf-no-callback-completing.json");
    expect(read.chainId).toBe(1);
    expect(read.entries).toHaveLength(1);
    const entry = read.entries[0];
    expect(entry?.kind).toBe("request");
    expect(entry?.state).toBe(INTAKE_STATE.completing);
    // Bought through version 1, which the plane still serves.
    expect(sameAddress(entry?.intake, MAINNET.INTAKE_V1)).toBe(true);
    expect(isIntake(entry?.intake)).toBe(true);
    expect(entry?.callback ?? null).toBeNull();
    expect(entry?.admission?.result?.kind).toBe("oracle");
    expect(entry?.admission?.result?.requestId).toBe("3744d864-8cbf-4fcf-8a8c-3529fb1736cb");
    expect(entry?.completion?.state).toBe("queued");
    expect(entry?.completion?.status).toBe(INTAKE_COMPLETION_STATUS.answered);
    expect(entry?.completion?.txHash).toBeNull();
    expect(entry?.completion?.delivered).toBeNull();
    // Seven hours after it was decided, the completion had still not been tried once.
    expect(entry?.completion?.attempts).toBe(0);
    expect(Date.parse(entry?.updatedAt as string) - Date.parse(entry?.receivedAt as string)).toBeLessThan(
      60_000,
    );
  });

  it("a request with a callback: delivered, and one whose answer waits for the writer", () => {
    const done = intake("1-2673172b-callback-completed.json").entries[0];
    expect(done?.state).toBe(INTAKE_STATE.completed);
    expect(sameAddress(done?.intake, MAINNET.INTAKE)).toBe(true);
    expect(done?.callback?.selector).toBe("0x510379c7");
    expect(done?.completion?.state).toBe("confirmed");
    expect(done?.completion?.status).toBe(0);
    expect(done?.completion?.delivered).toBe(true);
    expect(done?.completion?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    // Requested 12 October 22:17 UTC, written 13 October 02:50 UTC: four and a half hours.
    const late = Date.parse(done?.updatedAt as string) - Date.parse(done?.receivedAt as string);
    expect(late).toBeGreaterThan(4 * 3_600_000);

    const waiting = intake("1-60f932bc-callback-completing.json").entries[0];
    expect(waiting?.state).toBe(INTAKE_STATE.completing);
    expect(waiting?.callback?.target).toBe("0x00856bd495941f3b95da5b7e374c76d822c9059e");
    expect(waiting?.completion?.status).toBe(0);
    expect(waiting?.completion?.delivered).toBeNull();
    expect(waiting?.admission?.result?.attestationUrl).toBe(
      "/oracle/requests/ebe551f9-ceb1-4515-becb-2af7e69f5242/attestation",
    );
  });

  it("a transaction that made two requests has two entries, told apart by request id", () => {
    const read = intake("1-f019b4aa-two-requests.json");
    expect(read.entries).toHaveLength(2);
    const ids = read.entries.map((e) => e.requestId);
    expect(new Set(ids).size).toBe(2);
    expect(new Set(read.entries.map((e) => e.admission?.result?.requestId)).size).toBe(2);
    for (const entry of read.entries) expect(entry.state).toBe("completed");
  });

  it("the signed answer is public while its request is still completing", () => {
    const document = OracleAttestationDocument.parse(
      readJson(fixture("oracle", "pending", "ebe551f9-attestation.json")),
    );
    const record = OracleRequest.parse(readJson(fixture("oracle", "pending", "ebe551f9-request.json")));
    expect(record.status).toBe("attested");
    expect(document.requestId).toBe(record.id);
    expect(document.signature).toBe(record.signature);
    // Attested 00:09:15 UTC; the Intake read above still said `completing` at 07:09 UTC.
    expect(document.attestedAt).toBe("2026-10-13T00:09:15.858Z");
    // The domain names the contract the answer is for: here the body's own `consumer`.
    expect(document.domain.verifyingContract).toBe(record.consumer?.verifyingContract);
    expect(sameAddress(document.signer, MAINNET.ORACLE_SIGNER)).toBe(true);
  });

  it("rejects an Intake read that lost what the keeper depends on", () => {
    const good = readJson<{ entries: Record<string, unknown>[] }>(
      fixture("api", "intake", "1-2673172b-callback-completed.json"),
    );
    const without = (key: string) => ({
      ...good,
      entries: good.entries.map((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== key))),
    });
    expect(IntakeRead.safeParse(without("state")).success).toBe(false);
    expect(IntakeRead.safeParse(without("logIndex")).success).toBe(false);
    expect(IntakeRead.safeParse({ ...good, entries: "none" }).success).toBe(false);
    const badId = { ...good, entries: good.entries.map((e) => ({ ...e, requestId: "0x1234" })) };
    expect(IntakeRead.safeParse(badId).success).toBe(false);
    // Fields the guide lists and this package does not use may come and go.
    expect(IntakeRead.safeParse(without("deliverTo")).success).toBe(true);
    expect(IntakeRead.safeParse(without("order")).success).toBe(true);
  });
});

describe("paid-request schemas follow the published OpenAPI document", () => {
  const openapi = readJson<{
    components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> };
    "x-imd-actions": { action: string }[];
  }>(fixture("api", "openapi.json"));

  const quote = {
    v: 1,
    id: "0b6f8f5e-4a7c-4d1e-9b2a-3c5d7e9f1a2b",
    action: "job.open",
    policyVersion: "job-1",
    inputHash: "a".repeat(64),
    issuedAt: 1789999400,
    expiresAt: 1790000000,
    payment: {
      network: "eip155:1",
      asset: "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
      amount: "500000000000000000",
      payTo: "0x4e0fa57bde726079356537e2f34d671e9f41adbc",
      decimals: 18,
      scheme: "exact",
    },
    terms: { purchase: "action-admission", resultGuaranteed: false },
    quoteHash: "b".repeat(64),
  };

  it("Quote requires what the document requires, and nothing unknown", () => {
    expect(Quote.parse(quote)).toEqual(quote);
    for (const key of openapi.components.schemas.Quote?.required ?? []) {
      const copy: Record<string, unknown> = { ...quote };
      delete copy[key];
      expect(Quote.safeParse(copy).success, key).toBe(false);
    }
    expect(Quote.safeParse({ ...quote, surprise: 1 }).success).toBe(false);
    expect(Quote.safeParse({ ...quote, payment: { ...quote.payment, surprise: 1 } }).success).toBe(false);
    expect(Quote.safeParse({ ...quote, payment: { ...quote.payment, scheme: "upto" } }).success).toBe(false);
    expect(
      Quote.safeParse({ ...quote, terms: { purchase: "action-admission", resultGuaranteed: true } }).success,
    ).toBe(false);
  });

  it("Challenge requires what the document requires", () => {
    const challenge = {
      x402Version: 2,
      resource: { url: "https://api.imd.fun/requests/0b6f8f5e-4a7c-4d1e-9b2a-3c5d7e9f1a2b/submit" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:1",
          asset: quote.payment.asset,
          amount: quote.payment.amount,
          payTo: quote.payment.payTo,
          maxTimeoutSeconds: 300,
          extra: { assetTransferMethod: "permit2" },
        },
      ],
      quote,
      requesterScopeHash: "c".repeat(64),
      resourceUrl: "https://api.imd.fun/requests/0b6f8f5e-4a7c-4d1e-9b2a-3c5d7e9f1a2b/submit",
      input: { objective: "x" },
    };
    expect(Challenge.safeParse(challenge).success).toBe(true);
    for (const key of openapi.components.schemas.Challenge?.required ?? []) {
      if (key === "input") continue; // any JSON value, null included
      const copy: Record<string, unknown> = { ...challenge };
      delete copy[key];
      expect(Challenge.safeParse(copy).success, key).toBe(false);
    }
    expect(Challenge.safeParse({ ...challenge, accepts: [] }).success).toBe(false);
    expect(Challenge.safeParse({ ...challenge, x402Version: 1 }).success).toBe(false);
  });

  it("RequestStatus reads the documented admitted answer", () => {
    const status = RequestStatus.parse({
      status: "admitted",
      order: { id: quote.id, status: "paid", quote: { action: "job.open", expiresAt: 1790000000 } },
      payment: { status: "confirmed", paid: true, transactionHash: "0xabc" },
      admission: {
        action: "job.open",
        result: {
          kind: "job",
          jobId: JOB,
          launch: false,
          statusUrl: `/jobs/${JOB}`,
          resultUrl: `/jobs/${JOB}/result`,
        },
      },
    });
    expect(status.admission?.result?.jobId).toBe(JOB);
    expect(
      RequestStatus.safeParse({
        status: "weird",
        order: { id: quote.id, status: "x" },
        payment: null,
        admission: null,
      }).success,
    ).toBe(false);
  });

  it("lists exactly the actions the document lists", () => {
    expect(openapi["x-imd-actions"].map((a) => a.action).sort()).toEqual([...PAID_ACTIONS].sort());
  });
});

describe("client", () => {
  it("asks the documented URLs", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.endsWith("/health")) return json(text("health.json"));
      if (url.includes("/jobs?")) return json(text("jobs-limit3.json"));
      if (url.endsWith("/result")) return json(text("job-result-e9efec16.json"));
      if (url.endsWith("/records")) return json(text("job-records-e9efec16.json"));
      if (url.includes("/jobs/")) return json(text("job-e9efec16.json"));
      if (url.includes("/launches")) return json(text("launches-limit3.json"));
      if (url.includes("/requests/capabilities")) return json(text("requests-capabilities.json"));
      if (url.includes("/requests/paid-by/")) return json(text("requests-paid-by-424f7381.json"));
      if (url.includes("/intake/")) {
        return json(readFileSync(fixture("api", "intake", "1-2673172b-callback-completed.json"), "utf8"));
      }
      if (url.endsWith("/attestation")) {
        return json(readFileSync(fixture("oracle", "pending", "ebe551f9-attestation.json"), "utf8"));
      }
      if (url.includes("/oracle/requests/")) {
        return json(
          readFileSync(fixture("oracle", "requests", "dbcac6c2-6328-47a9-8e07-4c7b55f78e45.json"), "utf8"),
        );
      }
      if (url.includes("/oracle/requests"))
        return json(readFileSync(fixture("oracle", "requests-list.json"), "utf8"));
      return json({ error: "unexpected" }, 500);
    });
    const clock = fakeClock();
    const client = new ImdClient({ fetch: impl, sleep: clock.sleep, now: clock.now, maxAttempts: 1 });

    await client.health();
    await client.capabilities();
    await client.jobs({ limit: 3, excludeOracle: true, since: "2026-10-10T00:00:00Z", q: "audit" });
    const bundle = await client.jobBundle(JOB);
    await client.oracleRequests({ status: ["attested", "disagreed"], limit: 100 });
    await client.oracleRequest("dbcac6c2-6328-47a9-8e07-4c7b55f78e45");
    await client.oracleRequest("dbcac6c2-6328-47a9-8e07-4c7b55f78e45", { members: true });
    await client.launches({ limit: 3, before: 1300 });
    const paid = await client.paidBy("0x424F7381B6cfe63963732c52613C87cb54C5C755");
    expect(paid.count).toBe(59);
    const read = await client.intakeRead(
      1,
      "0x2673172B19f78c88238896631db5f95613c9e803e466a325f3677a2b3e182391",
    );
    expect(read.entries[0]?.state).toBe("completed");
    const signed = await client.oracleAttestation("ebe551f9-ceb1-4515-becb-2af7e69f5242");
    expect(signed.message.agreed).toBe(68);

    expect(bundle.job.id).toBe(JOB);
    expect(bundle.records.records[0]?.hash).toBe(RECEIPT);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.imd.fun/health",
      "https://api.imd.fun/requests/capabilities",
      "https://api.imd.fun/jobs?limit=3&q=audit&since=2026-10-10T00%3A00%3A00Z&exclude=oracle",
      `https://api.imd.fun/jobs/${JOB}`,
      `https://api.imd.fun/jobs/${JOB}/result`,
      `https://api.imd.fun/jobs/${JOB}/records`,
      "https://api.imd.fun/oracle/requests?limit=100&status=attested%2Cdisagreed",
      "https://api.imd.fun/oracle/requests/dbcac6c2-6328-47a9-8e07-4c7b55f78e45?members=0",
      "https://api.imd.fun/oracle/requests/dbcac6c2-6328-47a9-8e07-4c7b55f78e45",
      "https://api.imd.fun/launches?limit=3&before=1300",
      // Lowercase, as the API spells addresses.
      "https://api.imd.fun/requests/paid-by/0x424f7381b6cfe63963732c52613c87cb54c5c755",
      "https://api.imd.fun/intake/1/0x2673172b19f78c88238896631db5f95613c9e803e466a325f3677a2b3e182391",
      "https://api.imd.fun/oracle/requests/ebe551f9-ceb1-4515-becb-2af7e69f5242/attestation",
    ]);
    for (const call of calls) expect(call.init?.method).toBe("GET");
  });

  it("refuses an id that is not a UUID before any request is made", () => {
    const { impl, calls } = fakeFetch(() => json({}));
    const client = new ImdClient({ fetch: impl });
    expect(() => client.job("../health")).toThrow(TypeError);
    expect(() => client.jobRecords("e9efec16")).toThrow(TypeError);
    expect(() => client.oracleRequest("x")).toThrow(TypeError);
    expect(() => client.paidBy("0x1234")).toThrow(TypeError);
    expect(() => client.paidBy("../health")).toThrow(TypeError);
    expect(() => client.intakeRead(1, "0x1234")).toThrow(TypeError);
    expect(() => client.intakeRead(1, "../health")).toThrow(TypeError);
    expect(() => client.intakeRead(0, `0x${"ab".repeat(32)}`)).toThrow(TypeError);
    expect(() => client.oracleAttestation("x")).toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("tells a transaction the plane has not seen, and an answer not yet signed, from other failures", async () => {
    const { impl } = fakeFetch((url) => {
      if (url.includes("/intake/")) return json({ error: "unknown_transaction" }, 404);
      if (url.endsWith("/attestation")) return json({ error: "not_attested" }, 404);
      return json({ error: "unknown_request" }, 404);
    });
    const clock = fakeClock();
    const client = new ImdClient({ fetch: impl, sleep: clock.sleep, now: clock.now });
    const tx = `0x${"ab".repeat(32)}`;
    const id = "ebe551f9-ceb1-4515-becb-2af7e69f5242";
    const unseen = await client.intakeRead(1, tx).catch((e: unknown) => e);
    expect(isUnknownTransaction(unseen)).toBe(true);
    expect(isNotAttested(unseen)).toBe(false);
    const unsigned = await client.oracleAttestation(id).catch((e: unknown) => e);
    expect(isNotAttested(unsigned)).toBe(true);
    expect(isUnknownTransaction(unsigned)).toBe(false);
    const other = await client.oracleRequest(id).catch((e: unknown) => e);
    expect(isNotFound(other)).toBe(true);
    expect(isNotAttested(other)).toBe(false);
    expect(isUnknownTransaction(new Error("network"))).toBe(false);
  });

  it("keeps a minimum gap between requests, in order", async () => {
    const { impl, calls } = fakeFetch(() => json(text("health.json")));
    const clock = fakeClock();
    const client = new ImdClient({ fetch: impl, sleep: clock.sleep, now: clock.now, minIntervalMs: 2000 });
    await Promise.all([client.health(), client.health(), client.health(), client.health()]);
    expect(calls).toHaveLength(4);
    // The first goes at once; each later one waits out the gap.
    expect(clock.sleeps).toEqual([2000, 2000, 2000]);
    clock.advance(5000);
    await client.health();
    expect(clock.sleeps).toEqual([2000, 2000, 2000]);
  });

  it("stays under thirty requests a minute by default", async () => {
    const { impl } = fakeFetch(() => json(text("health.json")));
    const clock = fakeClock();
    const client = new ImdClient({ fetch: impl, sleep: clock.sleep, now: clock.now });
    const start = clock.now();
    for (let i = 0; i < 30; i++) await client.health();
    expect(clock.now() - start).toBeGreaterThan(60_000);
  });

  it("waits as long as Retry-After says on a 429, then succeeds", async () => {
    const { impl, calls } = fakeFetch((_url, _init, n) =>
      n === 1 ? json({ error: "too_many_reads" }, 429, { "retry-after": "7" }) : json(text("health.json")),
    );
    const clock = fakeClock();
    const client = new ImdClient({ fetch: impl, sleep: clock.sleep, now: clock.now, minIntervalMs: 0 });
    const health = await client.health();
    expect(health.status).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(clock.sleeps).toEqual([7000]);
  });

  it("backs off on 503 and on network errors, and gives up after the last try", async () => {
    const { impl, calls } = fakeFetch((_url, _init, n) => {
      if (n === 1) throw new TypeError("fetch failed");
      return json({ error: "paid_request_unavailable" }, 503);
    });
    const clock = fakeClock();
    const client = new ImdClient({
      fetch: impl,
      sleep: clock.sleep,
      now: clock.now,
      minIntervalMs: 0,
      maxAttempts: 4,
      random: () => 0,
    });
    const error = await client.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImdApiError);
    expect((error as ImdApiError).status).toBe(503);
    expect((error as ImdApiError).code).toBe("paid_request_unavailable");
    expect(calls).toHaveLength(4);
    expect(clock.sleeps).toEqual([1000, 2000, 4000]);
  });

  it("reports a network failure that never recovers, with its cause", async () => {
    const { impl } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const clock = fakeClock();
    const client = new ImdClient({
      fetch: impl,
      sleep: clock.sleep,
      now: clock.now,
      minIntervalMs: 0,
      maxAttempts: 2,
    });
    const error = (await client.health().catch((e: unknown) => e)) as Error;
    expect(error.message).toContain("failed after 2 tries");
    expect((error.cause as Error).message).toBe("fetch failed");
  });

  it("caps a wait at maxBackoffMs", async () => {
    const { impl } = fakeFetch((_url, _init, n) =>
      n === 1 ? json({ error: "too_many_reads" }, 429, { "retry-after": "3600" }) : json(text("health.json")),
    );
    const clock = fakeClock();
    const client = new ImdClient({
      fetch: impl,
      sleep: clock.sleep,
      now: clock.now,
      minIntervalMs: 0,
      maxBackoffMs: 5000,
    });
    await client.health();
    expect(clock.sleeps).toEqual([5000]);
  });

  it("does not retry a 404 and exposes the protocol's error code", async () => {
    const { impl, calls } = fakeFetch(() => json({ error: "unknown_record" }, 404));
    const client = new ImdClient({ fetch: impl, minIntervalMs: 0 });
    const error = await client.workRecord(RECEIPT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImdApiError);
    expect(isNotFound(error)).toBe(true);
    expect((error as ImdApiError).code).toBe("unknown_record");
    expect(calls).toHaveLength(1);
  });

  it("reports a 2xx answer in an unexpected shape", async () => {
    const { impl } = fakeFetch(() => json({ status: "ok" }));
    const client = new ImdClient({ fetch: impl, minIntervalMs: 0 });
    const error = await client.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImdSchemaError);
    expect((error as ImdSchemaError).issues.join(" ")).toContain("version");
  });

  it("returns a work record's bytes only when they hash to what was asked for", async () => {
    const bytes = readFileSync(fixture("work-records", `${RECEIPT}.json`));
    const good = fakeFetch(() => new Response(new Uint8Array(bytes)));
    const record = await new ImdClient({ fetch: good.impl, minIntervalMs: 0 }).workRecord(`0x${RECEIPT}`);
    expect(record.bytes.length).toBe(7339);
    expect(good.calls[0]?.url).toBe(`https://api.imd.fun/work-records/${RECEIPT}.json`);

    const bad = fakeFetch(() => new Response("{}"));
    await expect(new ImdClient({ fetch: bad.impl, minIntervalMs: 0 }).workRecord(RECEIPT)).rejects.toThrow(
      "HashMismatch",
    );
  });

  it("sends the free preflight as {action, input} with no credential", async () => {
    const { impl, calls } = fakeFetch(() =>
      json({
        action: "job.open",
        blockers: [],
        suggestions: [],
        kind: "audit",
        plan: ["four specialists", "one judge"],
      }),
    );
    const client = new ImdClient({ fetch: impl, minIntervalMs: 0 });
    const input = { objective: "Audit it.", template: "audit" };
    const result = await client.check("job.open", input);
    expect(result.blockers).toEqual([]);
    expect(calls[0]?.url).toBe("https://api.imd.fun/requests/check");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ action: "job.open", input });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("authorization");
    expect(CheckResult.safeParse({ action: "job.open" }).success).toBe(false);
  });

  it("reads Retry-After as seconds or as a date", () => {
    expect(parseRetryAfter("12", 0)).toBe(12_000);
    expect(parseRetryAfter(" 0 ", 0)).toBe(0);
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT", Date.parse("2026-10-21T07:27:30Z"))).toBe(30_000);
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT", Date.parse("2026-10-21T08:00:00Z"))).toBe(0);
    expect(parseRetryAfter("soon", 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});
