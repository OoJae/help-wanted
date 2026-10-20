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
  queueWords,
  receiptFlow,
  receiptFlowMeaning,
  stallPhrase,
  writerWords,
} from "~/models/receipts";
import { wirePage } from "~/models/wire";
import { MAINNET, sameAddress } from "@help-wanted/shared";
import { REFERENCE_JOB, TOPIC } from "~/config/chain";
import { formatUtc } from "~/lib/format";
import { RECEIPT_STALL_BLOCKS } from "~/data/chain";
import { PUBLIC_RPC } from "~/models/common";
import { ctxFor, fakeApi, fakeChain, fixtureJson, testSources, TRANSFERS, workRecordedLog } from "./helpers";

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
      "0 of the newest 18 ended jobs have a receipt in the WorkRegistry; IdentityMD's API counted 1,794 receipts waiting to go on chain.",
    );
    // What it means for an order, said as the escrow's safety, not as anyone's fault.
    expect(receiptFlowMeaning(flow)).toBe(
      "Until receipts are written again, an order that pays only on a receipt waits for one, and is refunded at its deadline if none comes: the escrow is safe either way.",
    );
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
      "1 of the newest 5 ended jobs has a receipt in the WorkRegistry; IdentityMD's API counted 1 receipt waiting to go on chain (read 10 Oct 2026, 21:21 UTC).",
    );
    // The queue is said in one wording everywhere, never without the moment it was read.
    expect(queueWords(2, "2026-10-20T11:34:00Z")).toBe(
      "IdentityMD's API counted 2 receipts waiting to go on chain (read 20 Oct 2026, 11:34 UTC)",
    );
  });

  it("leads with the registry's own log when it was read, and a stalled log alone makes it late", () => {
    const read = {
      stalled: true,
      windowBlocks: 1800,
      fromBlock: 26_231_901,
      toBlock: 26_233_700,
      events: 0,
      newestBlock: 26_224_887,
      newestAt: Date.UTC(2026, 9, 19, 6, 39, 35) / 1000,
      searchedFrom: 26_224_801,
      fetchedAt: Date.UTC(2026, 9, 20, 11, 40),
      stale: false,
      error: null,
    };
    // The stall as every page says it: since the newest receipt, in whole hours at the read.
    expect(stallPhrase(read)).toBe("no receipt since 19 Oct 2026, 06:39 UTC (29 hours)");
    expect(writerWords(read)).toBe(
      "IdentityMD's WorkRegistry has written no receipt since 19 Oct 2026, 06:39 UTC (29 hours), when it recorded one in block 26,224,887.",
    );
    // A small queue and receipted jobs do not hide a registry that has stopped writing.
    const flow = receiptFlow({ queued: 0, asked: 18, withReceipt: 18, writer: read });
    expect(flow.state).toBe("late");
    expect(flow.stall).toBe("no receipt since 19 Oct 2026, 06:39 UTC (29 hours)");
    expect(flow.observed).toBe(
      "IdentityMD's WorkRegistry has written no receipt since 19 Oct 2026, 06:39 UTC (29 hours), when it recorded one in block 26,224,887. 18 of the newest 18 ended jobs have a receipt in the WorkRegistry; IdentityMD's API counted 0 receipts waiting to go on chain.",
    );
    expect(flow.figures).toBe(
      "18 of the newest 18 ended jobs have a receipt in the WorkRegistry; IdentityMD's API counted 0 receipts waiting to go on chain.",
    );
    // Searched and found nothing: how far back the search reached, and nothing about older blocks.
    const none = { ...read, newestBlock: null, newestAt: null, searchedFrom: 26_226_501 };
    expect(stallPhrase(none)).toBe("no receipt in the last 24 hours of blocks");
    expect(writerWords(none)).toContain(
      "has written no receipt in the last 24 hours of blocks (blocks 26,226,501 to 26,233,700, as far back as this server's RPC serves its log; nothing is said here of older blocks).",
    );
    // A registry that is writing is never said to be stalled.
    expect(stallPhrase({ ...read, stalled: false, events: 3 })).toBeNull();
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
    expect(judges?.writer).toMatchObject({ stalled: true });
    expect(judges?.claims[1]?.readNow).toContain("1,774 receipts waiting to go on chain");
    // The registry's log holds no receipt as far back as this server's RPC serves it (a day).
    expect(judges?.claims[1]?.readNow).toContain(
      "IdentityMD's WorkRegistry has written no receipt in the last 24 hours of blocks",
    );
    const wire = await loadPath("/", ctxFor(world));
    expect(markdownTwin(wire!)).toContain(
      "IdentityMD's WorkRegistry has written no receipt in the last 24 hours of blocks",
    );
    expect(markdownTwin(wire!)).toContain("is refunded at its deadline if none comes");
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
    expect(judges?.claims[1]?.readNow).toContain("0 receipts waiting to go on chain");
    expect(judges?.claims[1]?.readNow).toContain(
      "Receipts appear to be reaching the registry at the moment.",
    );
    expect(judges?.claims[1]?.readNow).toContain(
      "IdentityMD's WorkRegistry is writing receipts: it recorded 1 in the last six hours of blocks",
    );
    expect(judges?.writer).toMatchObject({ stalled: false });

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
    // The box starts unticked whatever the registry does; no page says a stall that is not there.
    expect(everything).not.toMatch(
      /Ticked for you|Receipts are stalled:|Receipts are late:|has written no receipt/,
    );
    expect(everything).toContain(
      "Starts unticked. Receipts are arriving, so an order can wait for its receipt.",
    );
    expect(everything).not.toContain("is refunded at its deadline if none comes");
    // The judges page quotes the launch documents, which describe the day they were written, each
    // with its date; its own sentences about today follow the read.
    const judgesText = markdownTwin((await loadPath("/judges", ctxFor(world, "/judges")))!);
    expect(judgesText).not.toContain("is refunded at its deadline if none comes");
    expect(judgesText).not.toContain("has written no receipt");
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
    expect(judges?.writer).toMatchObject({ stalled: null });
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
      newestAt: null,
      // Searched back to the edge of the day the RPC serves logs for, and no further.
      searchedFrom: head - 7199,
      error: null,
    });
    // The six-hour range, then the rest of the RPC's log window, then one look at the reference
    // receipt's block to see whether the RPC keeps older logs (here it does not), then three more
    // days in which only a receipt it returned would count. A second reader costs nothing.
    await world.sources.chain.receiptWriter();
    const registry = MAINNET.WORK_REGISTRY.toLowerCase();
    expect(world.chain.calls.filter((call) => call.startsWith(`eth_getLogs ${registry}`))).toEqual([
      `eth_getLogs ${registry} ${head - 1799}-${head}`,
      `eth_getLogs ${registry} ${head - 7199}-${head - 1800}`,
      `eth_getLogs ${registry} ${REFERENCE_JOB.receiptBlock}-${REFERENCE_JOB.receiptBlock}`,
      `eth_getLogs ${registry} ${head - 14399}-${head - 7200}`,
      `eth_getLogs ${registry} ${head - 21599}-${head - 14400}`,
      `eth_getLogs ${registry} ${head - 28799}-${head - 21600}`,
    ]);
    const choice = claimDefault(read, PUBLIC_RPC);
    expect(choice.command).toBe(
      `cast logs --address ${MAINNET.WORK_REGISTRY} --from-block ${head - 1799} --to-block ${head} ${TOPIC.WORK_RECORDED} --rpc-url ${PUBLIC_RPC} | grep -c transactionHash`,
    );
  });

  it("a stall is given its length: the time since the newest receipt, found by searching back", async () => {
    // The newest receipt is 5,000 blocks (16 h 40 min) before the head; the page is read at the head.
    const headTime = await fakeChain().reader.blockTimestamp(BigInt(head));
    const world = testSources({
      chain: { registryLogs: [workRecordedLog(head - 5000)] },
      now: () => (headTime as number) * 1000,
    });
    const read = await world.sources.chain.receiptWriter();
    expect(read).toMatchObject({ stalled: true, events: 0, newestBlock: head - 5000 });
    expect(read.newestAt).toBe((headTime as number) - 5000 * 12);
    expect(stallPhrase(read)).toBe(`no receipt since ${formatUtc(read.newestAt! * 1000)} (16 hours)`);
    const model = await hireTemplatePage.load(ctxFor(world, "/hire/research"), { template: "research" });
    expect(model?.claim.box).toContain(`IdentityMD has written ${stallPhrase(read)}.`);
    expect(model?.claim.why).toContain(
      `when it recorded one in block ${(head - 5000).toLocaleString("en-US")}`,
    );
    // The figures on the same page say the same.
    expect(model?.receipts.observed).toContain(`has written ${stallPhrase(read)}`);
  });

  it("an RPC that refuses older logs ends the search there, and never pauses the site's other reads", async () => {
    const world = testSources();
    const getLogs = world.chain.reader.getLogs.bind(world.chain.reader);
    // As a public node refuses a range it no longer keeps: an HTTP error, not a JSON-RPC answer.
    world.chain.reader.getLogs = async (filter) => {
      if (sameAddress(filter.address, MAINNET.WORK_REGISTRY) && filter.fromBlock < BigInt(head - 7199))
        throw new Error("eth_getLogs answered HTTP 403");
      return getLogs(filter);
    };
    const read = await world.sources.chain.receiptWriter();
    expect(read).toMatchObject({ stalled: true, newestBlock: null, searchedFrom: head - 7199, error: null });
    // Two refusals in a row would pause the RPC for every page; these pause only the search.
    expect(world.sources.chain.usage().pausedAfterFailures).toBe(false);
    expect((await world.sources.chain.head()).value.block).toBe(head);
  });

  it("past the RPC's log window, a receipt it returns counts, and its silence is never said to be none", async () => {
    // A receipt 9,000 blocks back, beyond the day the RPC is said to serve: it returned it, so it
    // served every block after it, and that is the newest receipt.
    const near = testSources({ chain: { registryLogs: [workRecordedLog(head - 9000)] } });
    expect(await near.sources.chain.receiptWriter()).toMatchObject({
      stalled: true,
      newestBlock: head - 9000,
    });
    // Nothing found at all: only the day the RPC is said to serve is said to hold no receipt.
    const none = await testSources().sources.chain.receiptWriter();
    expect(none).toMatchObject({ newestBlock: null, searchedFrom: head - 7199 });
    expect(stallPhrase(none)).toBe("no receipt in the last 24 hours of blocks");
    // A receipt older than the few days asked on hope is not found by an RPC that has not shown it
    // keeps that history...
    const old = workRecordedLog(head - 30_000);
    expect(await testSources({ chain: { registryLogs: [old] } }).sources.chain.receiptWriter()).toMatchObject(
      { newestBlock: null, searchedFrom: head - 7199 },
    );
    // ...and is found once the RPC returns the reference job's own receipt in its block: it keeps
    // logs that old, so its empty answers count, and the search goes on until the newest receipt.
    const reference = {
      ...workRecordedLog(REFERENCE_JOB.receiptBlock),
      transactionHash: REFERENCE_JOB.receiptTx,
    };
    const keeps = testSources({ chain: { registryLogs: [reference, old] } });
    expect(await keeps.sources.chain.receiptWriter()).toMatchObject({
      stalled: true,
      newestBlock: head - 30_000,
    });
  });

  it("stalled: the box starts unticked, and beside it the form says why and what ticking means", async () => {
    const world = testSources();
    const model = await hireTemplatePage.load(ctxFor(world, "/hire/research"), { template: "research" });
    expect(model?.claim).toMatchObject({ stalled: true });
    expect(model?.claim.why).toContain(
      "IdentityMD's WorkRegistry has written no receipt in the last 24 hours of blocks",
    );
    expect(model?.claim.why).toContain(
      "Until it writes again, an order that pays only on a receipt waits for one, and is refunded at its deadline if none comes.",
    );
    expect(model?.claim.why).toContain("The box starts unticked all the same");
    // Beside the box: that it starts unticked, the stall, and exactly what ticking it means.
    expect(model?.claim.box).toBe(
      "Starts unticked. Receipts are late: IdentityMD has written no receipt in the last 24 hours of blocks. Ticked, the runner is paid 24 hours after a bonded delivery claim unless someone challenges it, and the team hosts no watcher that would.",
    );
    expect(model?.flow.preset).toMatchObject({ allowClaimed: "false", claimNote: model?.claim.box });
    // The worked example the page prints without JavaScript carries the same choice.
    expect(model?.flow.exampleValues.allowClaimed).toBe("false");
    expect(model?.flow.summary.join(" ")).toMatch(/Only an on-chain receipt pays/);
    // The box's help is that note alone: the limits are printed once, under the form.
    const box = model?.flow.fields.find((field) => field.name === "allowClaimed");
    expect(box?.help).toBe(model?.claim.box);

    const index = await hireIndexPage.load(ctxFor(world, "/hire"), {});
    expect(index?.claim.stalled).toBe(true);
    const markdown = hireIndexPage.markdown(index!);
    expect(markdown).toContain(
      "The box that also accepts a bonded delivery claim starts unticked on every order.",
    );
    expect(markdown).toContain("Receipts today: IdentityMD's WorkRegistry has written no receipt");
    expect(markdown).toContain("| grep -c transactionHash");
    expect(markdown).not.toMatch(/Ticked for you|ticked only while/);
    const runners = await runnersPage.load(ctxFor(world, "/runners"), {});
    expect(runners?.receiptsNow).toContain(
      "Receipts are stalled: IdentityMD's WorkRegistry has written no receipt in the last 24 hours of blocks",
    );
  });

  it("arriving: the box starts unticked, and the form says why", async () => {
    const world = testSources({
      chain: { registryLogs: [workRecordedLog(head - 1799), workRecordedLog(head - 20, 1)] },
    });
    const model = await hireTemplatePage.load(ctxFor(world, "/hire/audit"), { template: "audit" });
    expect(model?.claim).toMatchObject({ stalled: false });
    expect(model?.claim.why).toContain(
      "IdentityMD's WorkRegistry is writing receipts: it recorded 2 in the last six hours of blocks",
    );
    expect(model?.claim.why).toContain(`(block ${(head - 20).toLocaleString("en-US")})`);
    expect(model?.flow.preset.allowClaimed).toBe("false");
    expect(model?.flow.preset.claimNote).toBe(model?.claim.box);
    expect(model?.claim.box).toBe(
      "Starts unticked. Receipts are arriving, so an order can wait for its receipt. Ticked, the runner is paid 24 hours after a bonded delivery claim unless someone challenges it, and the team hosts no watcher that would.",
    );
    expect(model?.flow.exampleValues.allowClaimed).toBe("false");
    const runners = await runnersPage.load(ctxFor(world, "/runners"), {});
    expect(runners?.receiptsNow).toContain("Receipts are arriving");
  });

  it("a receipt one block older than six hours does not count", async () => {
    const world = testSources({ chain: { registryLogs: [workRecordedLog(head - 1800)] } });
    const read = await world.sources.chain.receiptWriter();
    // Stalled by the six-hour test, and the search behind it finds that receipt as the newest.
    expect(read).toMatchObject({ stalled: true, events: 0, newestBlock: head - 1800 });
  });

  it("unread: the box starts unticked, the stricter choice, and the form says it could not read", async () => {
    const world = testSources({ chain: { failCalls: true } });
    const model = await hireTemplatePage.load(ctxFor(world, "/hire/image"), { template: "image" });
    expect(model?.claim).toMatchObject({ stalled: null });
    expect(model?.claim.why).toContain("could not be read just now");
    expect(model?.claim.box).toContain(
      "Starts unticked. Whether IdentityMD's receipts are arriving could not be read just now.",
    );
    expect(model?.flow.preset.allowClaimed).toBe("false");
  });
});
