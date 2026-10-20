/**
 * The receipt check, against a recorded work record and a mocked WorkRegistry. No network.
 *
 * The record is the real one for job e9efec16-…: 7,339 bytes as IdentityMD served them. Its
 * keccak256 must be the receipt the chain holds, 0x3db99325…b2c5. If these tests pass, the page's
 * central claim is computed correctly; if someone changes how bytes are hashed, they fail.
 */
import { encodeFunctionData, keccak256, stringToBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MAINNET } from "@help-wanted/shared";
import { MULTICALL3, REFERENCE_JOB } from "~/config/chain";
import { workRegistryAbi } from "@help-wanted/shared";
import { handleApi } from "~/lib/api";
import { jobIdToBytes16, latestCalldata, parseJobId, ZERO_HASH } from "~/lib/ids";
import {
  hashServedRecord,
  notRunResult,
  provenDelivery,
  readRecordFacts,
  STAMP,
  verifyCommands,
  verifyJob,
  type RecordRef,
  type VerifyDeps,
} from "~/lib/verify";
import { twinResponse } from "~/lib/twins";
import { twinPaths } from "~/models/registry";
import { readsSentence, verifyIndexPage, verifyJobPage } from "~/models/verify";
import {
  ctxFor,
  fakeApi,
  fixtureJson,
  RECORD,
  SEAT_OWNER,
  testSources,
  TRANSFERS,
  UNRECEIPTED_HASH,
  UNRECEIPTED_JOB,
  workRecordedLog,
} from "./helpers";

const JOB = REFERENCE_JOB.jobId;
const RECEIPT = REFERENCE_JOB.receipt as Hex;

function deps(overrides: Partial<VerifyDeps> = {}): VerifyDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    readReceipt: async (id) => {
      calls.push(`receipt ${id}`);
      return RECEIPT;
    },
    fetchRecord: async (hash) => {
      calls.push(`record ${hash}`);
      return RECORD.slice();
    },
    ...overrides,
  };
}

describe("the recorded record", () => {
  it("is 7,339 bytes and hashes to the on-chain receipt exactly as served", () => {
    expect(RECORD.length).toBe(REFERENCE_JOB.recordBytes);
    expect(keccak256(RECORD)).toBe(RECEIPT);
    // Served with no trailing newline: the last byte closes the JSON object.
    expect(RECORD[RECORD.length - 1]).toBe(0x7d);
  });

  it("hashServedRecord matches as served, and after one trailing newline a server added", () => {
    expect(hashServedRecord(RECORD, RECEIPT)).toEqual({
      keccak: RECEIPT,
      matches: true,
      strippedNewline: false,
      bytes: 7339,
    });
    const withNewline = new Uint8Array([...RECORD, 0x0a]);
    expect(hashServedRecord(withNewline, RECEIPT)).toEqual({
      keccak: RECEIPT,
      matches: true,
      strippedNewline: true,
      bytes: 7339,
    });
    // Two newlines are not forgiven, and neither is any other change.
    expect(hashServedRecord(new Uint8Array([...RECORD, 0x0a, 0x0a]), RECEIPT).matches).toBe(false);
  });

  it("does not match when a single byte differs", () => {
    const altered = RECORD.slice();
    altered[100] = (altered[100] ?? 0) ^ 0x01;
    const hashed = hashServedRecord(altered, RECEIPT);
    expect(hashed.matches).toBe(false);
    expect(hashed.keccak).not.toBe(RECEIPT);
  });

  it("names its job, kind, state and the agent the record names", () => {
    const facts = readRecordFacts(RECORD);
    expect(facts).toMatchObject({
      schema: "identitymd-work-v1",
      jobId: JOB,
      kind: "skill:research-report",
      state: "completed",
      agentIds: ["52211"],
      parentJobId: null,
      previousHash: null,
    });
    expect(facts?.objective?.startsWith("Design a hackathon for identity MD")).toBe(true);
  });

  it("readRecordFacts refuses bytes that are not a JSON object", () => {
    expect(readRecordFacts(stringToBytes("not json"))).toBeNull();
    expect(readRecordFacts(stringToBytes("[1,2]"))).toBeNull();
    expect(readRecordFacts(stringToBytes("null"))).toBeNull();
  });

  it("reads agent ids once each, as numbers or strings, and ignores anything else", () => {
    const facts = readRecordFacts(
      stringToBytes(
        JSON.stringify({
          signals: [
            { agentId: 7 },
            { agentId: "7" },
            { agentId: "12" },
            { agentId: "0x1f" },
            null,
            { other: 1 },
          ],
          previousHash: "ab".repeat(32),
        }),
      ),
    );
    expect(facts?.agentIds).toEqual(["7", "12"]);
    expect(facts?.previousHash).toBe("ab".repeat(32));
  });
});

describe("verifyJob", () => {
  it("stamps PROVEN ON CHAIN when keccak256(record) equals WorkRegistry.latest(jobId)", async () => {
    const d = deps();
    const result = await verifyJob(JOB, d);
    expect(result.verdict).toBe("proven");
    expect(result.stamp).toBe("PROVEN ON CHAIN");
    expect(result.receipt).toBe(RECEIPT);
    expect(result.record).toEqual({
      hash: RECEIPT,
      bytes: 7339,
      keccak: RECEIPT,
      matches: true,
      strippedNewline: false,
    });
    expect(result.steps.map((s) => [s.key, s.ok])).toEqual([
      ["receipt", true],
      ["record", true],
      ["hash", true],
      ["compare", true],
    ]);
    expect(result.problems).toEqual([]);
    expect(provenDelivery(result)).toBe(true);
    // The registry is asked with the UUID's 16 bytes, and the record is fetched under the hash the
    // registry returned, not under anything the caller supplied.
    expect(d.calls).toEqual([`receipt ${REFERENCE_JOB.jobIdBytes16}`, `record ${RECEIPT}`]);
  });

  it("accepts the job id as pasted: upper case, bytes16 hex, or an explorer link", async () => {
    for (const typed of [
      JOB.toUpperCase(),
      ` ${JOB} `,
      REFERENCE_JOB.jobIdBytes16,
      REFERENCE_JOB.jobIdBytes16.slice(2),
      `https://explorer.imd.fun/jobs/${JOB}`,
      `https://explorer.imd.fun/jobs/${JOB}?tab=record#top`,
    ]) {
      expect(parseJobId(typed)).toBe(JOB);
      expect((await verifyJob(typed, deps())).verdict).toBe("proven");
    }
  });

  it("refuses anything that is not a job id before reading anything", async () => {
    const d = deps();
    await expect(verifyJob("not-a-job", d)).rejects.toThrow(TypeError);
    await expect(verifyJob("", d)).rejects.toThrow(TypeError);
    expect(d.calls).toEqual([]);
  });

  it("stamps NO RECEIPT YET when the registry returns zero, and fetches no record", async () => {
    const listed: RecordRef[] = [{ hash: UNRECEIPTED_HASH, status: "queued", txHash: null, failure: null }];
    const d = deps({ readReceipt: async () => ZERO_HASH, listRecords: async () => listed });
    const result = await verifyJob(UNRECEIPTED_JOB, d);
    expect(result.verdict).toBe("no_receipt");
    expect(result.stamp).toBe("NO RECEIPT YET");
    expect(result.receipt).toBe(ZERO_HASH);
    expect(result.record).toBeNull();
    expect(result.facts).toBeNull();
    expect(result.listed).toEqual(listed[0]);
    expect(result.summary).toContain("still queued");
    // What the API lists is the swarm's own statement. It is reported, never hashed as if proven.
    expect(d.calls.some((c) => c.startsWith("record"))).toBe(false);
    expect(provenDelivery(result)).toBeNull();
  });

  it("says so when there is neither a receipt nor a listed record", async () => {
    const result = await verifyJob(
      UNRECEIPTED_JOB,
      deps({ readReceipt: async () => ZERO_HASH, listRecords: async () => [] }),
    );
    expect(result.verdict).toBe("no_receipt");
    expect(result.listed).toBeNull();
    expect(result.summary).toContain("lists no work record");
  });

  it("explains a receipt whose writing failed", async () => {
    const result = await verifyJob(
      UNRECEIPTED_JOB,
      deps({
        readReceipt: async () => ZERO_HASH,
        listRecords: async () => [
          { hash: UNRECEIPTED_HASH, status: "failed", txHash: null, failure: "dropped" },
        ],
      }),
    );
    expect(result.summary).toContain("failed");
  });

  it("is COULD NOT CHECK, not a verdict about the job, when the chain read fails", async () => {
    const result = await verifyJob(
      JOB,
      deps({
        readReceipt: async () => {
          throw new Error("the RPC is down");
        },
      }),
    );
    expect(result.verdict).toBe("unchecked");
    expect(result.stamp).toBe(STAMP.unchecked);
    expect(result.receipt).toBeNull();
    expect(result.problems.join(" ")).toContain("the RPC is down");
    expect(result.steps[0]?.ok).toBe(false);
  });

  it("is COULD NOT CHECK when the registry answers something that is not a 32-byte word", async () => {
    const result = await verifyJob(JOB, deps({ readReceipt: async () => "0x1234" as Hex }));
    expect(result.verdict).toBe("unchecked");
  });

  it("is COULD NOT CHECK when a receipt exists but the record cannot be fetched", async () => {
    const missing = await verifyJob(JOB, deps({ fetchRecord: async () => null }));
    expect(missing.verdict).toBe("unchecked");
    expect(missing.receipt).toBe(RECEIPT);
    const failing = await verifyJob(
      JOB,
      deps({
        fetchRecord: async () => {
          throw new Error("HTTP 500");
        },
      }),
    );
    expect(failing.verdict).toBe("unchecked");
    expect(failing.problems.join(" ")).toContain("HTTP 500");
  });

  it("stamps DOES NOT MATCH when the served bytes are not the ones the chain committed to", async () => {
    const altered = RECORD.slice();
    altered[altered.length - 2] = 0x20;
    const result = await verifyJob(JOB, deps({ fetchRecord: async () => altered }));
    expect(result.verdict).toBe("mismatch");
    expect(result.stamp).toBe("DOES NOT MATCH");
    expect(result.record?.matches).toBe(false);
    expect(result.facts).toBeNull();
  });

  it("stamps DOES NOT MATCH when the record hashes to the receipt but names another job", async () => {
    // A registry that pointed job B at job A's record: the hash agrees, the record does not.
    const other = "11111111-2222-4333-8444-555555555555";
    const result = await verifyJob(other, deps());
    expect(result.verdict).toBe("mismatch");
    expect(result.summary).toContain("different job");
  });

  it("proves a record of a job that ended blocked, and says that it is not a delivery", async () => {
    const jobId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const record = stringToBytes(
      JSON.stringify({
        jobId,
        kind: "audit",
        objective: "x",
        schema: "identitymd-work-v1",
        signals: [],
        state: "blocked",
      }),
    );
    const receipt = keccak256(record);
    const result = await verifyJob(
      jobId,
      deps({ readReceipt: async () => receipt, fetchRecord: async () => record }),
    );
    expect(result.verdict).toBe("proven");
    expect(result.summary).toContain('ended "blocked"');
    expect(provenDelivery(result)).toBe(false);
  });

  it("follows a superseding receipt: the registry's newest hash is the one fetched and listed", async () => {
    const first = `0x${"11".repeat(32)}` as Hex;
    const d = deps({
      listRecords: async () => [
        { hash: first, status: "sent", txHash: `0x${"aa".repeat(32)}`, failure: null },
        { hash: RECEIPT, status: "sent", txHash: `0x${"bb".repeat(32)}`, failure: null },
      ],
    });
    const result = await verifyJob(JOB, d);
    expect(result.verdict).toBe("proven");
    expect(result.listed?.hash).toBe(RECEIPT);
    expect(result.listed?.txHash).toBe(`0x${"bb".repeat(32)}`);
  });

  it("keeps its verdict when the API's record list cannot be read", async () => {
    const result = await verifyJob(
      JOB,
      deps({
        listRecords: async () => {
          throw new Error("HTTP 503");
        },
      }),
    );
    expect(result.verdict).toBe("proven");
    expect(result.problems).toHaveLength(1);
  });

  it("does not say the API lists no record when the API could not be asked", async () => {
    const result = await verifyJob(UNRECEIPTED_JOB, {
      readReceipt: async () => ZERO_HASH,
      fetchRecord: async () => null,
      listRecords: async () => {
        throw new Error("The IdentityMD API budget for this minute is spent; try again in 31 s");
      },
    });
    expect(result.verdict).toBe("no_receipt");
    expect(result.problems).toHaveLength(1);
    // A read that failed is reported as a failed read. Nothing is known about what the list holds.
    expect(result.summary).toBe(
      "The WorkRegistry holds no receipt for this job. What the IdentityMD API lists for it could not be read just now.",
    );
    expect(result.steps[1]?.detail).toBe(
      "Not fetched: there is no receipt. Whether the IdentityMD API lists a record for this job could not be read just now.",
    );
    expect(`${result.summary} ${result.steps[1]?.detail}`).not.toContain("lists no");
  });

  it("says nothing about the API's list when nobody was asked for one, as in the browser's own check", async () => {
    const result = await verifyJob(UNRECEIPTED_JOB, {
      readReceipt: async () => ZERO_HASH,
      fetchRecord: async () => null,
    });
    expect(result.summary).toBe("The WorkRegistry holds no receipt for this job.");
    expect(result.steps[1]?.detail).toBe("Not fetched: there is no receipt to fetch a record under.");
  });

  it("a check that was never started has every step unreached and is no finding about the job", () => {
    const result = notRunResult(JOB, "Not checked.");
    expect(result).toMatchObject({
      verdict: "unchecked",
      stamp: "COULD NOT CHECK",
      receipt: null,
      record: null,
    });
    expect(result.steps.map((step) => step.ok)).toEqual([null, null, null, null]);
    expect(provenDelivery(result)).toBeNull();
    expect(() => notRunResult("nope", "x")).toThrow(TypeError);
  });
});

describe("the commands that repeat the check by hand", () => {
  it("call latest(bytes16) with the job's 16 bytes and hash the record URL without 0x", () => {
    const commands = verifyCommands({
      jobId: JOB,
      rpcUrl: "https://ethereum-rpc.publicnode.com",
      workRegistry: MAINNET.WORK_REGISTRY,
      apiBase: "https://api.imd.fun/",
      recordHash: RECEIPT,
    });
    expect(commands.map((c) => c.command)).toEqual([
      `cast call ${MAINNET.WORK_REGISTRY} "latest(bytes16)(bytes32)" 0xe9efec1656f340d3924352c453effc7d --rpc-url https://ethereum-rpc.publicnode.com`,
      "curl -s https://api.imd.fun/work-records/3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5.json | cast keccak",
      `[ "$(cast call ${MAINNET.WORK_REGISTRY} "latest(bytes16)(bytes32)" 0xe9efec1656f340d3924352c453effc7d --rpc-url https://ethereum-rpc.publicnode.com)" = "$(curl -s https://api.imd.fun/work-records/3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5.json | cast keccak)" ] && echo PROVEN || echo "NOT PROVEN"`,
    ]);
  });

  it("read the hash from the chain when none is known yet", () => {
    const [, fetch] = verifyCommands({
      jobId: JOB,
      rpcUrl: "https://rpc.example",
      workRegistry: MAINNET.WORK_REGISTRY,
      apiBase: "https://api.imd.fun",
      recordHash: null,
    });
    expect(fetch?.command).toContain("| cut -c3-).json | cast keccak");
  });

  it("the browser's hand-built calldata is what an ABI encoder produces", () => {
    const id = jobIdToBytes16(JOB);
    expect(id).toBe(REFERENCE_JOB.jobIdBytes16);
    expect(latestCalldata(id)).toBe(
      encodeFunctionData({ abi: workRegistryAbi, functionName: "latest", args: [id] }),
    );
    expect(latestCalldata(id).slice(0, 10)).toBe("0xebe9712c");
    expect(() => latestCalldata("0x1234")).toThrow(TypeError);
  });
});

describe("/verify/:jobId, built from the data sources", () => {
  it("proves the reference job and names the seat behind the agent the record names", async () => {
    const world = testSources();
    const model = await verifyJobPage.load(ctxFor(world, `/verify/${JOB}`), { jobId: JOB });
    expect(model?.result.verdict).toBe("proven");
    expect(model?.delivered).toBe(true);
    expect(model?.headline).toBe("The record is the one the chain committed to.");
    expect(model?.recordUrl).toBe(`https://api.imd.fun/work-records/${RECEIPT.slice(2)}.json`);
    expect(model?.recordProxyPath).toBe(`/api/v1/work-records/${RECEIPT.slice(2)}.json`);
    expect(model?.receiptTxUrl).toBe(`https://etherscan.io/tx/${REFERENCE_JOB.receiptTx}`);
    expect(model?.seats).toEqual([
      { agentId: "52211", bound: true, isSeat: true, tokenId: "1998", owner: SEAT_OWNER },
    ]);
    // The printed commands always name the public RPC, whatever RPC_URL the server itself uses.
    expect(model?.commands[0]?.command).toContain("--rpc-url https://ethereum-rpc.publicnode.com");

    const markdown = verifyJobPage.markdown(model!);
    expect(markdown).toContain("**PROVEN ON CHAIN.**");
    expect(markdown).toContain(RECEIPT);
    expect(markdown).toContain(
      "| keccak256(record bytes) | 0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5 |",
    );
    expect(markdown).toContain("#1998");
    // A tip has followed this path (order 1's, on 15 October 2026): the twin no longer says it will.
    expect(markdown).toContain("This is the path HELP WANTED's per-job tips follow.");
    expect(markdown).not.toContain("tips will follow");
    expect(verifyJobPage.meta(model!).title).toBe("PROVEN ON CHAIN: job e9efec16");
  });

  it("does not turn page views into upstream requests one for one", async () => {
    const world = testSources();
    for (let i = 0; i < 5; i++) {
      await verifyJobPage.load(ctxFor(world, `/verify/${JOB}`), { jobId: JOB });
    }
    expect(world.api.calls).toEqual([
      `GET /jobs/${JOB}/records`,
      `GET /work-records/${RECEIPT.slice(2)}.json`,
    ]);
    expect(
      world.chain.calls.filter((c) => c === `eth_call ${MAINNET.WORK_REGISTRY.toLowerCase()}`),
    ).toHaveLength(1);
  });

  it("says NO RECEIPT YET for a finished job whose receipt is still queued", async () => {
    const world = testSources();
    const model = await verifyJobPage.load(ctxFor(world), { jobId: UNRECEIPTED_JOB });
    expect(model?.result.verdict).toBe("no_receipt");
    expect(model?.result.listed?.status).toBe("queued");
    expect(model?.recordUrl).toBeNull();
    expect(model?.seats).toEqual([]);
    const markdown = verifyJobPage.markdown(model!);
    expect(markdown).toContain("**NO RECEIPT YET.**");
    // With no hash known, the hand check reads it from the chain.
    expect(markdown).toContain("cut -c3-");
    expect(world.api.calls).toEqual([`GET /jobs/${UNRECEIPTED_JOB}/records`]);
  });

  it("says COULD NOT CHECK when the RPC is down, and the API answers 503 rather than a verdict", async () => {
    const world = testSources({ chain: { failCalls: true } });
    const model = await verifyJobPage.load(ctxFor(world), { jobId: JOB });
    expect(model?.result.verdict).toBe("unchecked");
    expect(model?.headline).toBe("This job could not be checked just now.");

    const response = await handleApi(
      `verify/${JOB}`,
      new Request(`https://help-wanted.test/api/v1/verify/${JOB}`),
      ctxFor(world),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
  });

  it("answers 404 for a path that is not a job id", async () => {
    const world = testSources();
    expect(await verifyJobPage.load(ctxFor(world), { jobId: "nonsense" })).toBeNull();
    expect(world.api.calls).toEqual([]);
    expect(world.chain.calls).toEqual([]);
  });

  it("passes a record's bytes through untouched so a browser can hash them itself", async () => {
    const world = testSources();
    const path = `work-records/${RECEIPT.slice(2)}.json`;
    const response = await handleApi(
      path,
      new Request(`https://help-wanted.test/api/v1/${path}`),
      ctxFor(world),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toContain("immutable");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBe(7339);
    expect(keccak256(bytes)).toBe(RECEIPT);

    const unknown = `work-records/${"cd".repeat(32)}.json`;
    expect(
      (await handleApi(unknown, new Request(`https://help-wanted.test/api/v1/${unknown}`), ctxFor(world)))
        .status,
    ).toBe(404);
    expect(
      (await handleApi("work-records/zz.json", new Request("https://help-wanted.test/x"), ctxFor(world)))
        .status,
    ).toBe(400);
  });

  it("refuses a record larger than a megabyte instead of buffering it", async () => {
    const hash = `0x${"ef".repeat(32)}` as Hex;
    const api = fakeApi({
      [`/work-records/${hash.slice(2)}.json`]: () =>
        new Response("{}", { headers: { "content-length": "5000000" } }),
    });
    const world = testSources({ api });
    await expect(world.sources.api.workRecord(hash)).rejects.toThrow("larger than this site will fetch");
  });
});

describe("/verify/:jobId: what the server will not be talked into", () => {
  const RECORD_PATH = `/work-records/${RECEIPT.slice(2)}.json`;
  const proxy = (world: ReturnType<typeof testSources>, visitor: string | null = null) =>
    handleApi(
      `work-records/${RECEIPT.slice(2)}.json`,
      new Request("https://help-wanted.test/"),
      ctxFor(world, "/", visitor),
    );

  it("one wrong answer from the record server is never kept: the job is proven again once the server recovers", async () => {
    let now = 1_800_000_000_000;
    let upstreamHealthy = false;
    const api = fakeApi({
      [RECORD_PATH]: () =>
        upstreamHealthy
          ? new Response(RECORD.slice(), { headers: { "content-type": "application/json" } })
          : // What a CDN error page or a bot checkpoint looks like: status 200, not the record.
            new Response("<html><body>Checkpoint</body></html>", {
              headers: { "content-type": "text/html" },
            }),
    });
    const world = testSources({ api, now: () => now });

    // While the record server answers with something that is not the record, the honest verdict is
    // that the check could not be made. It is not a finding that the job's record does not match.
    const during = await verifyJobPage.load(ctxFor(world), { jobId: JOB });
    expect(during?.result.verdict).toBe("unchecked");
    expect(during?.result.stamp).toBe("COULD NOT CHECK");
    expect(during?.result.problems.join(" ")).toContain("do not hash to the hash they were asked for");
    expect(during?.reads.recordOrigin).toBeNull();
    // The wrong bytes are not handed to browsers either, let alone marked as never changing.
    const refused = await proxy(world);
    expect(refused.status).toBe(502);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(await refused.text()).not.toContain("Checkpoint");

    // The record server is healthy again.
    upstreamHealthy = true;
    now += 30_000;
    const after = await verifyJobPage.load(ctxFor(world), { jobId: JOB });
    expect(after?.result.verdict).toBe("proven");
    expect(after?.result.stamp).toBe("PROVEN ON CHAIN");
    const served = await proxy(world);
    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(keccak256(new Uint8Array(await served.arrayBuffer()))).toBe(RECEIPT);
  });

  it("with the record that ships with the site, the reference job is proven even while IdentityMD's record server is down, and the page says which bytes it hashed", async () => {
    const api = fakeApi({ [RECORD_PATH]: () => new Response("down", { status: 503 }) });
    const world = testSources({ api, storedReferenceRecord: true });
    const model = await verifyJobPage.load(ctxFor(world), { jobId: JOB });
    expect(model?.result.verdict).toBe("proven");
    expect(model?.result.record).toMatchObject({ keccak: RECEIPT, bytes: 7339, matches: true });
    expect(model?.reads).toMatchObject({ recordOrigin: "stored", recordFetchedAt: null });
    expect(model?.result.steps[1]?.detail).toContain("this site's stored copy of the record");
    expect(readsSentence(model!.reads)).toContain("Record: this site's stored copy");
    expect(verifyJobPage.markdown(model!)).toContain("this site's stored copy");
    // No other job has a stored copy to fall back on.
    const other = `0x${"ab".repeat(32)}` as Hex;
    await expect(world.sources.api.workRecord(other)).resolves.toBeNull();
  });

  it("dates each read by when it was made, not by when the page was made", async () => {
    let now = Date.parse("2026-10-10T21:00:00Z");
    const world = testSources({ now: () => now });
    const first = await verifyJobPage.load(ctxFor(world), { jobId: JOB });
    expect(first?.reads).toEqual({
      receiptReadAt: "2026-10-10T21:00:00.000Z",
      recordFetchedAt: "2026-10-10T21:00:00.000Z",
      recordOrigin: "identitymd",
      listReadAt: "2026-10-10T21:00:00.000Z",
    });
    // Half a minute later the same reads are reused, and the page still says when they were made.
    now += 30_000;
    const second = await verifyJobPage.load(ctxFor(world), { jobId: JOB });
    expect(second?.reads.receiptReadAt).toBe("2026-10-10T21:00:00.000Z");
    expect(second?.reads.recordFetchedAt).toBe("2026-10-10T21:00:00.000Z");
    expect(readsSentence(second!.reads)).toBe(
      "Receipt read from the WorkRegistry 10 Oct 2026, 21:00 UTC. Record fetched from IdentityMD 10 Oct 2026, 21:00 UTC.",
    );
    expect(verifyJobPage.markdown(second!)).toContain(
      "Receipt read from the WorkRegistry 10 Oct 2026, 21:00 UTC.",
    );
    // A record never changes, so hours later it still carries its own fetch time; the receipt is re-read.
    now += 3 * 3_600_000;
    const third = await verifyJobPage.load(ctxFor(world), { jobId: JOB });
    expect(third?.reads.recordFetchedAt).toBe("2026-10-10T21:00:00.000Z");
    expect(third?.reads.receiptReadAt).toBe("2026-10-11T00:00:30.000Z");
  });

  it("lets one visitor start only twelve checks of new jobs a minute, and never refuses a job already looked at", async () => {
    const world = testSources();
    const visitor = "203.0.113.9";
    const fresh = (i: number) => `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
    for (let i = 0; i < 12; i++) {
      const page = await verifyJobPage.load(ctxFor(world, "/", visitor), { jobId: fresh(i) });
      expect(page?.limited).toBeNull();
      expect(page?.result.verdict).toBe("no_receipt");
    }
    const before = world.chain.calls.length;
    const refused = await verifyJobPage.load(ctxFor(world, "/", visitor), { jobId: fresh(99) });
    expect(refused?.limited?.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused?.result.verdict).toBe("unchecked");
    expect(refused?.result.summary).toContain("you have started several checks of new jobs");
    expect(refused?.result.steps.every((step) => step.ok === null)).toBe(true);
    expect(verifyJobPage.status?.(refused!)).toBe(429);
    // The twins say the same as the page: 429, when to come back, and not to be cached.
    const twin = twinResponse(
      {
        page: verifyJobPage,
        model: refused,
        meta: verifyJobPage.meta(refused!),
        status: verifyJobPage.status?.(refused!) ?? 200,
        headers: verifyJobPage.headers?.(refused!) ?? {},
        paths: twinPaths(`/verify/${fresh(99)}`),
        ctx: ctxFor(world),
      },
      "json",
    );
    expect(twin.status).toBe(429);
    expect(Number(twin.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(twin.headers.get("cache-control")).toBe("no-store");
    // Refusing cost the upstreams nothing.
    expect(world.chain.calls.length).toBe(before);
    // A job that visitor already looked at is answered from memory...
    const again = await verifyJobPage.load(ctxFor(world, "/", visitor), { jobId: fresh(3) });
    expect(again?.limited).toBeNull();
    // ...the reference job is the server's own check and is never refused...
    const reference = await verifyJobPage.load(ctxFor(world, "/", visitor), { jobId: JOB });
    expect(reference?.result.verdict).toBe("proven");
    expect(verifyJobPage.status?.(reference!)).toBe(200);
    // ...and another visitor is not held back by the first.
    const someoneElse = await verifyJobPage.load(ctxFor(world, "/", "198.51.100.4"), { jobId: fresh(50) });
    expect(someoneElse?.limited).toBeNull();
  });

  it("a visitor following the front page's Check links is limited too, though the front page already read their receipts", async () => {
    const world = testSources();
    const ids = Array.from(
      { length: 20 },
      (_, i) => `${(i + 500).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    // What the Work Wire does for its cards: one multicall, which leaves every receipt remembered.
    await world.sources.chain.receipts(ids.map((id) => jobIdToBytes16(id)));
    expect(world.sources.chain.hasRecentReceipt(jobIdToBytes16(ids[0]!))).toBe(true);
    // Each check still costs one request to IdentityMD's API, so it still counts against the visitor.
    const outcomes: boolean[] = [];
    for (const id of ids) {
      const page = await verifyJobPage.load(ctxFor(world, "/", "203.0.113.50"), { jobId: id });
      outcomes.push(page?.limited === null);
    }
    expect(outcomes.filter(Boolean)).toHaveLength(12);
    expect(world.api.calls.filter((call) => call.includes("/records"))).toHaveLength(12);
  });

  it("no number of visitors asking for records that do not exist can stop the reference job from being checked", async () => {
    const world = testSources();
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const response = await handleApi(
        `work-records/${(i + 1).toString(16).padStart(64, "0")}.json`,
        new Request("https://help-wanted.test/"),
        // Forty different visitors, so no single one is over its own allowance.
        ctxFor(world, "/", `203.0.113.${i}`),
      );
      statuses.push(response.status);
    }
    // The visitors' share of the API budget (32 of 40 a minute) runs out; the rest are told to wait.
    expect(statuses.filter((status) => status === 404)).toHaveLength(32);
    expect(statuses.slice(32).every((status) => status === 503)).toBe(true);
    // The server's own check of the reference job still goes through.
    const page = await verifyJobPage.load(ctxFor(world), { jobId: JOB });
    expect(page?.result.verdict).toBe("proven");
    expect(page?.busy).toBeNull();
  });

  it("counts a record the server would have to fetch against the visitor, but not one it already holds", async () => {
    const world = testSources();
    const visitor = "203.0.113.77";
    const unknown = (i: number) =>
      handleApi(
        `work-records/${(i + 1).toString(16).padStart(64, "0")}.json`,
        new Request("https://help-wanted.test/"),
        ctxFor(world, "/", visitor),
      );
    for (let i = 0; i < 12; i++) expect((await unknown(i)).status).toBe(404);
    const refused = await unknown(12);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    // The record behind a check the server has made is held, and is handed to the same visitor freely.
    await verifyJobPage.load(ctxFor(world), { jobId: JOB });
    expect((await proxy(world, visitor)).status).toBe(200);
  });
});

describe("/verify", () => {
  it("prints the hand check for the reference job and remembers a rejected input", async () => {
    const world = testSources();
    const ctx = { ...ctxFor(world), url: new URL("https://help-wanted.test/verify?job=hello") };
    const model = await verifyIndexPage.load(ctx, {});
    expect(model?.rejectedInput).toBe("hello");
    expect(model?.commands).toHaveLength(3);
    const markdown = verifyIndexPage.markdown(model!);
    expect(markdown).toContain(REFERENCE_JOB.receipt);
    expect(markdown).toContain("0xebe9712c");
    // What the page says about receipts is read, with the reads the front page already makes: the
    // swarm's state, the newest jobs, the registry's own log (the six hours, then back through the
    // day the RPC serves, one look at whether it keeps older logs, and three more days in which only
    // a receipt it returned would count) and one multicall to the registry. A second view reads
    // nothing.
    expect(world.api.calls).toEqual(["GET /health", "GET /jobs"]);
    const head = TRANSFERS.toBlock;
    const registry = MAINNET.WORK_REGISTRY.toLowerCase();
    expect(world.chain.calls).toEqual([
      "eth_blockNumber",
      `eth_getLogs ${registry} ${head - 1799}-${head}`,
      `eth_getLogs ${registry} ${head - 7199}-${head - 1800}`,
      `eth_getLogs ${registry} ${REFERENCE_JOB.receiptBlock}-${REFERENCE_JOB.receiptBlock}`,
      `eth_getLogs ${registry} ${head - 14399}-${head - 7200}`,
      `eth_getLogs ${registry} ${head - 21599}-${head - 14400}`,
      `eth_getLogs ${registry} ${head - 28799}-${head - 21600}`,
      `eth_call ${MULTICALL3.toLowerCase()}`,
    ]);
    await verifyIndexPage.load(ctx, {});
    expect(world.api.calls).toHaveLength(2);
    expect(world.chain.calls).toHaveLength(8);
  });

  it("says receipts are late only while the figures say so", async () => {
    const stalled = await verifyIndexPage.load(ctxFor(testSources()), {});
    expect(stalled?.receipts.state).toBe("late");
    expect(verifyIndexPage.markdown(stalled!)).toContain("1,774 receipts waiting to go on chain");
    expect(verifyIndexPage.markdown(stalled!)).toContain(
      "IdentityMD's WorkRegistry has written no receipt in the last 24 hours of blocks",
    );
    expect(verifyIndexPage.markdown(stalled!)).toContain("is refunded at its deadline if none comes");

    // Every recent job has a receipt and nothing is queued: the page must not go on saying "stalled".
    const jobs = fixtureJson<{ jobs: { id: string }[] }>("jobs-limit3.json").jobs;
    const receipts = Object.fromEntries(
      jobs.map((job) => [jobIdToBytes16(job.id), `0x${"77".repeat(32)}` as Hex]),
    );
    const health = { ...fixtureJson<Record<string, unknown>>("health.json"), pendingFeedback: 0 };
    const flowing = await verifyIndexPage.load(
      ctxFor(
        testSources({
          api: fakeApi({ "/health": () => new Response(JSON.stringify(health)) }),
          // And the registry's own log shows a receipt half an hour before the head.
          chain: { receipts, registryLogs: [workRecordedLog(TRANSFERS.toBlock - 150)] },
        }),
      ),
      {},
    );
    expect(flowing?.receipts.state).toBe("flowing");
    const text = verifyIndexPage.markdown(flowing!);
    expect(text).toContain("0 receipts waiting to go on chain");
    expect(text).toContain("IdentityMD's WorkRegistry is writing receipts");
    expect(text).not.toMatch(/stalled|has written no receipt|refunded at its deadline/);
  });
});
