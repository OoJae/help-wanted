/**
 * What the site says about IdentityMD's receipts follows what it read, and nothing else. In October
 * 2026 the registry's writer stopped for days; these tests hold the pages to saying "late" only
 * while the figures do, so the wording cannot outlive the condition.
 */
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { flowById } from "~/flows";
import { jobIdToBytes16 } from "~/lib/ids";
import { llmsTxt } from "~/lib/siteDocs";
import { loadPath, markdownTwin } from "~/lib/twins";
import { hireIndexPage, hireTemplatePage, runnersPage } from "~/models/desk";
import { judgesPage } from "~/models/judges";
import {
  claimDefault,
  countReceipts,
  loadReceiptFlow,
  receiptFlow,
  receiptFlowMeaning,
} from "~/models/receipts";
import { wirePage } from "~/models/wire";
import { MAINNET } from "@help-wanted/shared";
import { TOPIC } from "~/config/chain";
import { RECEIPT_STALL_BLOCKS } from "~/data/chain";
import { PUBLIC_RPC } from "~/models/common";
import { ctxFor, fakeApi, fixtureJson, testSources, TRANSFERS, workRecordedLog } from "./helpers";

/** A world in which every recent job has a receipt and nothing is queued. */
function flowingWorld() {
  const jobs = fixtureJson<{ jobs: { id: string }[] }>("jobs-limit3.json").jobs;
  const receipts = Object.fromEntries(
    jobs.map((job) => [jobIdToBytes16(job.id), `0x${"77".repeat(32)}` as Hex]),
  );
  const health = { ...fixtureJson<Record<string, unknown>>("health.json"), pendingFeedback: 0 };
  return testSources({
    api: fakeApi({
      "/health": () =>
        new Response(JSON.stringify(health), { headers: { "content-type": "application/json" } }),
    }),
    // And the registry's own log shows a receipt recorded half an hour before the head.
    chain: { receipts, registryLogs: [workRecordedLog(TRANSFERS.toBlock - 150)] },
  });
}

describe("receiptFlow", () => {
  it("is late when most of the newest ended jobs have no receipt", () => {
    const flow = receiptFlow({ queued: 1794, asked: 18, withReceipt: 0 });
    expect(flow.state).toBe("late");
    expect(flow.observed).toBe(
      "0 of the newest 18 ended jobs have a receipt in the WorkRegistry; IdentityMD's API counts 1,794 receipts waiting to be written.",
    );
    expect(receiptFlowMeaning(flow)).toContain("arriving late or not at all at the moment");
  });

  it("is flowing when the newest jobs have receipts, even while an old backlog is still being written", () => {
    expect(receiptFlow({ queued: 0, asked: 18, withReceipt: 18 }).state).toBe("flowing");
    expect(receiptFlow({ queued: 900, asked: 18, withReceipt: 18 }).state).toBe("flowing");
    expect(receiptFlow({ queued: 3, asked: 18, withReceipt: 15 }).state).toBe("flowing");
    expect(receiptFlowMeaning(receiptFlow({ queued: 0, asked: 18, withReceipt: 18 }))).not.toMatch(
      /late|stalled/,
    );
  });

  it("is late on a backlog alone when too few jobs were read to say otherwise", () => {
    expect(receiptFlow({ queued: 1794, asked: 0, withReceipt: 0 }).state).toBe("late");
    expect(receiptFlow({ queued: 1794, asked: 2, withReceipt: 2 }).state).toBe("late");
  });

  it("is unknown, and says so, when neither figure could be read", () => {
    const flow = receiptFlow({ queued: null, asked: 0, withReceipt: 0 });
    expect(flow.state).toBe("unknown");
    expect(flow.observed).toContain("could be read just now");
    expect(receiptFlowMeaning(flow)).toBe(
      "Whether receipts are being written at the moment could not be read.",
    );
  });

  it("writes one receipt in the singular and dates the figures when it knows when they were read", () => {
    const flow = receiptFlow({ queued: 1, asked: 5, withReceipt: 1, readAt: "2026-10-10T21:21:00Z" });
    expect(flow.observed).toBe(
      "1 of the newest 5 ended jobs has a receipt in the WorkRegistry; IdentityMD's API counts 1 receipt waiting to be written (read 10 Oct 2026, 21:21 UTC).",
    );
  });

  it("counts only jobs the registry was really asked about", () => {
    const zero = `0x${"0".repeat(64)}`;
    expect(countReceipts([`0x${"7".repeat(64)}`, zero, null, undefined, zero])).toEqual({
      asked: 3,
      withReceipt: 1,
    });
    expect(countReceipts([])).toEqual({ asked: 0, withReceipt: 0 });
  });
});

describe("the pages say what was read", () => {
  it("with the recorded data (1,774 queued, no receipt on the newest jobs) they say receipts are late", async () => {
    const world = testSources();
    const flow = await loadReceiptFlow(world.sources);
    expect(flow).toMatchObject({ state: "late", queued: 1774, withReceipt: 0 });
    const judges = await judgesPage.load(ctxFor(world), {});
    expect(judges?.receipts.state).toBe("late");
    expect(judges?.writer).toMatchObject({ stalled: true, preselected: true });
    expect(judges?.claims[1]?.readNow).toContain("1,774 receipts waiting to be written");
    expect(judges?.claims[1]?.readNow).toContain(
      "The WorkRegistry recorded no receipt in the last six hours of blocks.",
    );
    const wire = await loadPath("/", ctxFor(world));
    expect(markdownTwin(wire!)).toContain("Receipts are arriving late or not at all at the moment");
    // Reading the figures cost nothing beyond what the front page reads anyway.
    expect(world.api.calls.filter((call) => call === "GET /health")).toHaveLength(1);
    expect(world.api.calls.filter((call) => call === "GET /jobs")).toHaveLength(1);
  });

  it("once every finished job has a receipt and none is queued, no page goes on saying the writer is stalled", async () => {
    const world = flowingWorld();
    const wire = await wirePage.load(ctxFor(world), {});
    expect(wire?.swarm?.receiptsQueued).toBe(0);
    expect(wire?.jobs.finished).toBeGreaterThan(0);
    expect(wire?.jobs.withReceipt).toBe(wire?.jobs.finished);
    expect(wire?.receipts.state).toBe("flowing");

    const judges = await judgesPage.load(ctxFor(world), {});
    // The claim is about what the product does when a receipt is missing, not a report of an outage.
    expect(judges?.claims[1]?.claim).not.toMatch(/stopped arriving|is stalled/);
    expect(judges?.claims[1]?.readNow).toContain("0 receipts waiting to be written");
    expect(judges?.claims[1]?.readNow).toContain(
      "Receipts appear to be reaching the registry at the moment.",
    );
    expect(judges?.claims[1]?.readNow).toContain(
      "The WorkRegistry recorded a receipt within the last six hours of blocks.",
    );
    expect(judges?.writer).toMatchObject({ stalled: false, preselected: false });

    const everything = [
      markdownTwin((await loadPath("/", ctxFor(world)))!),
      markdownTwin((await loadPath("/verify", ctxFor(world, "/verify")))!),
      markdownTwin((await loadPath("/hire", ctxFor(world, "/hire")))!),
      markdownTwin((await loadPath("/hire/research", ctxFor(world, "/hire/research")))!),
      markdownTwin((await loadPath("/runners", ctxFor(world, "/runners")))!),
      await llmsTxt(ctxFor(world)),
    ].join("\n");
    expect(everything).not.toMatch(
      /writer is stalled|has been stalled|have stopped arriving|arriving late at the moment/,
    );
    // The rule is stated ("ticked only while receipts are stalled"); the condition is not.
    expect(everything).not.toMatch(
      /Ticked for you|Receipts are stalled:|because IdentityMD's receipts are stalled/,
    );
    expect(everything).toContain("Left unticked, because IdentityMD's receipts are arriving");
    expect(everything).not.toContain("Receipts are arriving late or not at all at the moment");
    // The judges page quotes the launch documents, which describe the day they were written, each
    // with its date; its own sentences about today follow the read.
    const judgesText = markdownTwin((await loadPath("/judges", ctxFor(world, "/judges")))!);
    expect(judgesText).not.toContain("Receipts are arriving late or not at all at the moment");
    expect(judgesText).not.toContain("The WorkRegistry recorded no receipt in the last six hours");
  });

  it("the hire form itself states no condition of IdentityMD's as a fact", () => {
    const hire = flowById("hire")!;
    const text = JSON.stringify(hire.fields({ template: "research" }));
    expect(text).not.toMatch(/at the moment|stalled|are late/);
  });

  it("does not hold a page up for the figures when an upstream hangs", async () => {
    // The API never answers. A page that only quotes these figures must still go out promptly.
    const world = testSources({
      api: { fetch: (() => new Promise<Response>(() => undefined)) as typeof fetch, calls: [] },
    });
    const started = Date.now();
    const flow = await loadReceiptFlow(world.sources);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(flow.state).toBe("unknown");
    expect(flow.error).toBe("the figures were still being read");
    expect(flow.observed).toContain("could be read just now");
  });

  it("says the figures could not be read when both upstreams are down, rather than guess", async () => {
    const world = testSources({
      api: { fetch: (async () => new Response("no", { status: 503 })) as typeof fetch, calls: [] },
      chain: { failCalls: true },
    });
    const flow = await loadReceiptFlow(world.sources);
    expect(flow.state).toBe("unknown");
    const judges = await judgesPage.load(ctxFor(world), {});
    expect(judges?.claims[1]?.readNow).toBeNull();
    expect(judges?.writer).toMatchObject({ stalled: null, preselected: false });
  });
});

describe("the hire form's claim box follows the registry's own log", () => {
  const head = TRANSFERS.toBlock;

  it("the rule is six hours of blocks, and the test is one anyone can run", async () => {
    expect(RECEIPT_STALL_BLOCKS).toBe(1800);
    const world = testSources();
    const read = await world.sources.chain.receiptWriter();
    expect(read).toMatchObject({
      stalled: true,
      windowBlocks: 1800,
      fromBlock: head - 1799,
      toBlock: head,
      events: 0,
      newestBlock: null,
      error: null,
    });
    // One log query of the registry, for exactly that range, and a second reader costs nothing.
    await world.sources.chain.receiptWriter();
    expect(
      world.chain.calls.filter((call) =>
        call.startsWith(`eth_getLogs ${MAINNET.WORK_REGISTRY.toLowerCase()}`),
      ),
    ).toEqual([`eth_getLogs ${MAINNET.WORK_REGISTRY.toLowerCase()} ${head - 1799}-${head}`]);
    const choice = claimDefault(read, PUBLIC_RPC);
    expect(choice.command).toBe(
      `cast logs --address ${MAINNET.WORK_REGISTRY} --from-block ${head - 1799} --to-block ${head} ${TOPIC.WORK_RECORDED} --rpc-url ${PUBLIC_RPC} | grep -c transactionHash`,
    );
  });

  it("stalled: the box starts ticked, and the form says why", async () => {
    const world = testSources();
    const model = await hireTemplatePage.load(ctxFor(world, "/hire/research"), { template: "research" });
    expect(model?.claim).toMatchObject({ preselected: true, stalled: true });
    expect(model?.claim.why).toContain("Ticked for you, because IdentityMD's receipts are stalled");
    expect(model?.claim.why).toContain("recorded no receipt in the last six hours");
    expect(model?.claim.why).toContain("Untick the box to wait for receipts all the same");
    expect(model?.flow.preset).toMatchObject({ allowClaimed: "true", claimNote: model?.claim.why });
    // The worked example the page prints without JavaScript carries the same choice.
    expect(model?.flow.exampleValues.allowClaimed).toBe("true");
    expect(model?.flow.summary.join(" ")).toMatch(/bonded delivery claim/);
    const box = model?.flow.fields.find((field) => field.name === "allowClaimed");
    expect(box?.help).toContain("Ticked for you, because IdentityMD's receipts are stalled");

    const index = await hireIndexPage.load(ctxFor(world, "/hire"), {});
    expect(index?.claim.preselected).toBe(true);
    const markdown = hireIndexPage.markdown(index!);
    expect(markdown).toContain("How the order form's claim box starts today: Ticked for you");
    expect(markdown).toContain("| grep -c transactionHash");
    const runners = await runnersPage.load(ctxFor(world, "/runners"), {});
    expect(runners?.receiptsNow).toContain("Receipts are stalled");
  });

  it("arriving: the box starts unticked, and the form says why", async () => {
    const world = testSources({
      chain: { registryLogs: [workRecordedLog(head - 1799), workRecordedLog(head - 20, 1)] },
    });
    const model = await hireTemplatePage.load(ctxFor(world, "/hire/audit"), { template: "audit" });
    expect(model?.claim).toMatchObject({ preselected: false, stalled: false });
    expect(model?.claim.why).toContain("Left unticked, because IdentityMD's receipts are arriving");
    expect(model?.claim.why).toContain("recorded 2 receipts in the last six hours");
    expect(model?.claim.why).toContain(`the newest in block ${(head - 20).toLocaleString("en-US")}`);
    expect(model?.flow.preset.allowClaimed).toBe("false");
    expect(model?.flow.exampleValues.allowClaimed).toBe("false");
    const runners = await runnersPage.load(ctxFor(world, "/runners"), {});
    expect(runners?.receiptsNow).toContain("Receipts are arriving");
  });

  it("a receipt one block older than six hours does not count", async () => {
    const world = testSources({ chain: { registryLogs: [workRecordedLog(head - 1800)] } });
    const read = await world.sources.chain.receiptWriter();
    expect(read).toMatchObject({ stalled: true, events: 0 });
  });

  it("unread: the box starts unticked, the stricter choice, and the form says it could not read", async () => {
    const world = testSources({ chain: { failCalls: true } });
    const model = await hireTemplatePage.load(ctxFor(world, "/hire/image"), { template: "image" });
    expect(model?.claim).toMatchObject({ preselected: false, stalled: null });
    expect(model?.claim.why).toContain("could not be read just now");
    expect(model?.claim.why).toContain("the form starts with the stricter choice");
    expect(model?.flow.preset.allowClaimed).toBe("false");
  });
});
