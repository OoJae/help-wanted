/**
 * The pages of launch B (the hire desk, orders, pots, the Doorbell, the judges page, the evidence
 * route, /llms.txt) switched on against a mocked chain, on a book with launches A and B written in
 * and launch C not (`BOOKS.aAndB`).
 *
 * Two worlds are played. The first is launch B as mainnet had it on 13 October 2026, the hour it was
 * launched: nothing had been called on any of its contracts, so the desk had opened no order,
 * CrowdPots no pot, and the Doorbell stood 25 rings from a hire, unfunded, at one price of 1 IMD with
 * the claimed path on. Every answer the fake chain gives is encoded with the ABIs the shared package
 * generates, and the figures are the ones read from the chain that day. A page must say of it "live,
 * and nothing yet", never "not launched". The second is the same book on a chain that answers
 * nothing for launch B: there a page must say "could not be read", never zero and never "not
 * launched".
 */
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { describe, expect, it } from "vitest";
import { crowdPotsAbi, doorbellAbi, MAINNET, sameAddress, workOrdersAbi } from "@help-wanted/shared";
import { HOUSE_WALLETS } from "~/config/house";
import { NOT_LAUNCHED, resolveDeployments } from "~/config/deployments";
import { DESK_ADAPTATION } from "~/config/proofs";
import { LAUNCH_B_JOB } from "~/data";
import { handleApi } from "~/lib/api";
import { llmsTxt } from "~/lib/siteDocs";
import type { RawLog } from "~/lib/jsonrpc";
import { loadPath, markdownTwin } from "~/lib/twins";
import type { OrdersModel, RunnersModel } from "~/models/desk";
import type { JudgesModel } from "~/models/judges";
import type { PotsModel, RulesNewModel } from "~/models/money";
import {
  BOOKS,
  ctxFor,
  fakeApi,
  TEST_LAUNCH,
  testSources,
  type FakeChainOptions,
  type TestWorld,
} from "./helpers";

const IMD = 10n ** 18n;
// The addresses the book gives launch B's contracts, as a page prints them (checksummed).
const B = resolveDeployments({}, BOOKS.aAndB).contracts;
const DESK = B.workOrders.address as string;
const POTS = B.crowdPots.address as string;
const BELL = B.doorbell.address as string;
const PROOF = B.workProof.address as string;
const OUTSIDER = "0x1111111111111111111111111111111111111111";
// The house bot key, which rang the Doorbell on the day.
const H1 = HOUSE_WALLETS[1]!.address;

type Views = NonNullable<FakeChainOptions["views"]>;

/** Launch B's own views in the hour of its launch, as read from mainnet on 13 October 2026. */
const LAUNCH_DAY_VIEWS: Views = {
  [`${DESK}:orderCount`]: { abi: workOrdersAbi, result: 0n },
  [`${POTS}:potCount`]: { abi: crowdPotsAbi, result: 0n },
  [`${BELL}:ringsUntilHire`]: { abi: doorbellAbi, result: 25n },
  [`${BELL}:funded`]: { abi: doorbellAbi, result: false },
  [`${BELL}:ALLOW_CLAIMED`]: { abi: doorbellAbi, result: true },
  [`${BELL}:rings`]: { abi: doorbellAbi, result: 0n },
  [`${BELL}:hires`]: { abi: doorbellAbi, result: 0n },
  [`${BELL}:receipts`]: { abi: doorbellAbi, result: 0n },
  [`${BELL}:lastOrderId`]: { abi: doorbellAbi, result: 0n },
  [`${BELL}:MIN_PAY`]: { abi: doorbellAbi, result: IMD },
  [`${BELL}:MAX_PAY`]: { abi: doorbellAbi, result: IMD },
  [`${BELL}:BOND`]: { abi: doorbellAbi, result: IMD / 4n },
  [`${BELL}:DELIVERY_SECS`]: { abi: doorbellAbi, result: 604_800 },
};

const launchDay = (views: Views = {}) =>
  testSources({ book: BOOKS.aAndB, chain: { views: { ...LAUNCH_DAY_VIEWS, ...views } } });

/** The same book on a chain where nothing answers at launch B's addresses. */
const silent = () => testSources({ book: BOOKS.aAndB });

async function page(world: TestWorld, path: string) {
  const loaded = (await loadPath(path, ctxFor(world, path)))!;
  return {
    loaded,
    markdown: markdownTwin(loaded),
    said: `${loaded.meta.description}\n${markdownTwin(loaded)}`,
  };
}

async function api<T>(world: TestWorld, path: string): Promise<T> {
  const url = new URL(`https://help-wanted.test/api/v1/${path}`);
  const response = await handleApi(path, new Request(url), { ...ctxFor(world), url });
  return (await response.json()) as T;
}

/** What no page may say of a contract of launch B once the book holds it. */
const NOT_LAUNCHED_OF_B = /(WorkProof|WorkOrders|CrowdPots|Doorbell|hire desk)[^.\n]{0,40}not launched/;

describe("launch B on the day of its launch: live, and nothing has been called on it", () => {
  it("/orders says the desk is live and has opened no order, in those words", async () => {
    const { loaded, markdown, said } = await page(launchDay(), "/orders");
    expect(loaded.model as OrdersModel).toMatchObject({ launched: true, count: 0, cards: [], error: null });
    expect(markdown).toContain(
      `The hire desk is live at ${DESK}. No order has been opened on it yet: its own counter, orderCount(), read 0 for this page.`,
    );
    expect(loaded.meta.description).toBe("The hire desk is live and no order has been opened on it yet.");
    expect(said).not.toMatch(NOT_LAUNCHED_OF_B);
    expect(said).not.toContain("**No orders.**");
    expect(said).not.toContain("could not be read");
  });

  it("/hire names the desk, its launch, and that it is empty", async () => {
    const { markdown, said } = await page(launchDay(), "/hire");
    expect(markdown).toContain(`The hire desk is live at [${DESK}]`);
    expect(markdown).toContain(`(WorkOrders, IdentityMD launch ${TEST_LAUNCH.b.launchNumber}).`);
    expect(markdown).toContain("No order has been opened on it yet: its own counter, orderCount(), read 0");
    expect(said).not.toMatch(NOT_LAUNCHED_OF_B);
    // An order form is live too: nothing about it waits for a launch.
    const form = await page(launchDay(), "/hire/research");
    expect(form.said).not.toMatch(NOT_LAUNCHED_OF_B);
    expect(form.markdown).toContain(DESK);
  });

  it("/pots says CrowdPots is live and no pot has been opened, and proposes the document's first pot", async () => {
    const { loaded, markdown, said } = await page(launchDay(), "/pots");
    expect(loaded.model as PotsModel).toMatchObject({ launched: true, count: 0, cards: [], error: null });
    expect(markdown).toContain(
      `CrowdPots is live at ${POTS}. No pot has been opened on it yet: its own counter, potCount(), read 0 for this page.`,
    );
    expect(loaded.meta.description).toContain("CrowdPots is live and no pot has been opened yet.");
    expect(said).not.toMatch(NOT_LAUNCHED_OF_B);
    expect(said).not.toContain("**No pots.**");
    // The form starts small and receipt-only: a 1.5 IMD target from 0.8 IMD, the desk's minimum bond.
    expect(markdown).toContain("a target of 1.5 IMD, an order priced from 0.8 IMD");
    expect(markdown).toContain("The pot collects up to 1.5 IMD for 3 d.");
    expect(markdown).toContain("priced from 0.8 IMD and rising over 24 h, with a runner's bond of 0.25 IMD");
    expect(markdown).toContain("The pot's order pays only on an on-chain receipt.");
    // With no pot on chain there is nothing to chip into or claim back: those forms are not shown.
    const model = loaded.model as PotsModel;
    expect(model.flows).toEqual([]);
    expect(model.zapFlow).toBeNull();
    expect(markdown).toContain("No pot exists yet (CrowdPots.potCount() read 0 for this page)");
    expect(markdown).not.toContain("### Chip in\n");
    expect(markdown).not.toContain("## Chip in with ETH");
    expect(markdown).not.toContain("### Claim a pot refund");
  });

  it("the Doorbell reads live, unfunded, 25 rings from a hire, at 1 IMD a picture with the claimed path on", async () => {
    const { loaded, markdown, said } = await page(launchDay(), "/rules/new");
    const model = loaded.model as RulesNewModel;
    expect(model.doorbellState).toEqual({
      ringsUntilHire: 25,
      funded: false,
      allowClaimed: true,
      rings: 0,
      hires: 0,
      receipts: 0,
      lastOrderId: 0,
      minPayWei: IMD,
      maxPayWei: IMD,
      bondWei: IMD / 4n,
      deliverySecs: 604_800,
      balanceWei: 0n,
      // Nobody has rung, so there is no ring log to read and nobody to tell apart.
      ringers: null,
    });
    expect(model.doorbellError).toBeNull();
    expect(markdown).toContain(`It is at [${BELL}]`);
    for (const fact of [
      "25 rings until the next hire. It has not been rung yet, and it has hired nothing.",
      "Every order it opens pays 1 IMD: the bottom and the top of its price range are the same amount (MIN_PAY() and MAX_PAY(), read from the contract), so the price does not rise while an order waits and the escrow of an order is its price.",
      "It is not funded: it holds 0 IMD and one order needs 1 IMD, so a 25th ring that comes now is counted and hires nothing.",
      "Its orders pay on a receipt, or a bonded delivery claim nobody challenges within 24 hours (fixed when it was launched).",
      "With the claimed path on, everything it holds is open to delivery claims that nobody challenges: that is launch B's disclosed limit D2",
      "posts a bond of 0.25 IMD, and the delivery time is 7 d",
    ]) {
      expect(model.doorbellFacts.join(" "), fact).toContain(fact);
      expect(markdown, fact).toContain(fact);
    }
    expect(said).not.toMatch(NOT_LAUNCHED_OF_B);
    expect(said).not.toContain("will be printed here");
    // No ramp is spoken of: the launched Doorbell has one price.
    expect(model.doorbellFacts.join(" ")).not.toMatch(/rises to|ramp/);
    // The one-shot rule on the desk can be written; the standing one still waits for launch C.
    expect(markdown).not.toContain("Rules cannot be written yet: the hire desk");
    expect(markdown).toContain(`Standing rules cannot be written yet: Rules (launch C) is ${NOT_LAUNCHED}.`);
  });

  it("a Doorbell that has been funded and rung says so, and splits the rings it could read HOUSE and OUTSIDE", async () => {
    // As mainnet had it at 16:43 UTC on the day: W1 had sent it 1 IMD and H1 was ringing it.
    const rungBy = (ringer: string, count: number): RawLog => ({
      address: BELL.toLowerCase(),
      topics: encodeEventTopics({
        abi: doorbellAbi,
        eventName: "Rang",
        args: { ringer: ringer as `0x${string}` },
      }) as string[],
      data: encodeAbiParameters([{ type: "uint256" }], [BigInt(count)]),
      // Inside the day of blocks the fake node serves logs for (its head is block 26,164,692).
      blockNumber: `0x${(26_160_000 + count).toString(16)}`,
      transactionHash: `0x${count.toString(16).padStart(64, "0")}`,
      logIndex: "0x0",
    });
    const views: Views = {
      ...LAUNCH_DAY_VIEWS,
      [`${BELL}:ringsUntilHire`]: { abi: doorbellAbi, result: 10n },
      [`${BELL}:funded`]: { abi: doorbellAbi, result: true },
      [`${BELL}:rings`]: { abi: doorbellAbi, result: 15n },
    };
    const house = testSources({
      book: BOOKS.aAndB,
      chain: {
        views,
        imdBalances: { [BELL]: IMD },
        logs: { [BELL]: Array.from({ length: 15 }, (_, i) => rungBy(H1, i + 1)) },
      },
    });
    const { loaded, markdown } = await page(house, "/rules/new");
    expect((loaded.model as RulesNewModel).doorbellState?.ringers).toMatchObject({
      read: 15,
      byRinger: [{ ringer: H1.toLowerCase(), rings: 15 }],
    });
    expect(markdown).toContain(
      "10 rings until the next hire. It has been rung 15 times, and it has hired nothing.",
    );
    expect(markdown).toMatch(
      /Of the 15 rings whose log this server read \(blocks [\d,]+ to [\d,]+\), 15 were sent by our own wallets \(HOUSE\) and 0 by others \(OUTSIDE\)\./,
    );
    expect(markdown).toContain(
      "It is funded: it holds 1 IMD, and the next 25th ring opens an order for 1 IMD.",
    );
    // Our own rings are never outside usage: the judges page says whose they were.
    const judges = (await page(house, "/judges")).loaded.model as JudgesModel;
    const outside = judges.notLive.find((line) =>
      line.startsWith("No use of our contracts by anyone outside"),
    )!;
    expect(outside).toContain(
      "the 15 rings of the Doorbell whose log this server could read were all sent by our own wallets",
    );
    expect(judges.notLive.join("\n")).toContain(
      "The Doorbell has opened no order: it has been rung 15 times, 10 rings stand before its next hire, and it is funded (it holds 1 IMD).",
    );
    const evidence = await api<{ doorbell: Record<string, unknown> }>(house, "evidence");
    expect(evidence.doorbell).toMatchObject({
      rings: 15,
      ringsWhoseSenderWasRead: 15,
      ringsByHouse: 15,
      ringsByOutside: 0,
      funded: true,
      heldWei: IMD.toString(),
    });
    expect(await llmsTxt(ctxFor(house))).toContain(
      "15 were sent by our own wallets (HOUSE) and 0 by others (OUTSIDE).",
    );

    // One ring from anybody else is OUTSIDE, and then the page no longer says nobody outside has used anything.
    const mixed = testSources({
      book: BOOKS.aAndB,
      chain: {
        views,
        logs: { [BELL]: [...Array.from({ length: 14 }, (_, i) => rungBy(H1, i + 1)), rungBy(OUTSIDER, 15)] },
      },
    });
    expect((await page(mixed, "/rules/new")).markdown).toContain(
      "14 were sent by our own wallets (HOUSE) and 1 by others (OUTSIDE).",
    );
    const said = ((await page(mixed, "/judges")).loaded.model as JudgesModel).notLive.join("\n");
    expect(said).not.toContain("No use of our contracts by anyone outside the team");

    // Rings whose log cannot be read are not split, and are not called anybody's.
    const unread = testSources({ book: BOOKS.aAndB, chain: { views } });
    expect((await page(unread, "/rules/new")).markdown).toContain(
      "No ring's log could be read just now, so the rings are not split between HOUSE and OUTSIDE here.",
    );
    const unsaid = ((await page(unread, "/judges")).loaded.model as JudgesModel).notLive.find((line) =>
      line.startsWith("No use of our contracts by anyone outside"),
    )!;
    expect(unsaid).toContain("Not read: the house feeds; who rang the Doorbell.");
    expect(unsaid).not.toContain("rings of the Doorbell whose log");
  });

  it("/runners and the front page say there is nothing to take or show yet, on a desk that exists", async () => {
    const runners = await page(launchDay(), "/runners");
    expect(runners.loaded.model as RunnersModel).toMatchObject({ launched: true, count: 0, open: [] });
    expect(runners.markdown).toContain(
      `The hire desk is live at ${DESK}. There is nothing to take yet: no order has been opened on it`,
    );
    expect(runners.said).not.toContain("**No orders to take.**");
    expect(runners.said).not.toMatch(NOT_LAUNCHED_OF_B);
    const home = await page(launchDay(), "/");
    expect(home.markdown).toContain(
      `The hire desk is live at ${DESK}. No order has been posted on it yet: its own counter, orderCount(), read 0 for this page.`,
    );
    expect(home.said).not.toMatch(NOT_LAUNCHED_OF_B);
  });

  it("an order or a pot that was never opened is 'no such thing' on a live desk, not a page", async () => {
    const world = launchDay({
      [`${DESK}:accountOf`]: {
        abi: workOrdersAbi,
        result: [0, "0x0000000000000000000000000000000000000000", 0n, 0n, 0n],
      },
      [`${POTS}:remaining`]: { abi: crowdPotsAbi, result: 0n },
      [`${POTS}:stageOf`]: { abi: crowdPotsAbi, result: 0 },
    });
    expect(await loadPath("/orders/1", ctxFor(world, "/orders/1"))).toBeNull();
    expect(await loadPath("/pots/1", ctxFor(world, "/pots/1"))).toBeNull();
  });

  it("/judges says 7 of 10, names the launch, and keeps saying what has not been shown", async () => {
    const { loaded, markdown } = await page(launchDay(), "/judges");
    const model = loaded.model as JudgesModel;
    expect(model.launchedCount).toBe(7);
    expect(model.contracts).toHaveLength(10);
    expect(model.launchSummary).toBe(
      "7 of 10 contracts are launched: launch A (Payroll and Questions) and launch B (the hire desk). Not launched yet: launch C (the company).",
    );
    expect(model.summary).toContain("7 of our 10 contracts are launched (launches A and B).");
    const b = model.launches.find((launch) => launch.key === "B")!;
    expect(b).toMatchObject({ launched: true, launchNumber: TEST_LAUNCH.b.launchNumber });
    expect(b.status).toContain(
      `Launched as IdentityMD launch ${TEST_LAUNCH.b.launchNumber}, in block 26,151,000.`,
    );
    // The count is of the accepted submissions, with the judge's first round named beside it, and
    // each grading is said with whose it is.
    expect(b.status).toContain(
      "Its record of the job holds 11 findings in its accepted submissions (the judge's first round, not accepted, raised 3 that its last round restates), the number its pull request gives.",
    );
    expect(b.status).toContain(
      "launches/b-desk/ADAPTATION.md answers 7 of them. It grades a96c4f58 medium, as the judge's first round did (its last round, the one accepted, grades it info), and the other 6 info. The pipeline's judge merged the remaining 4, among them audit_permissions' medium finding, into three of those.",
    );
    expect(b.status).not.toContain("1 medium finding and 6 at level info");
    // One finding answered in words and not in code: said in the launch's own line.
    expect(b.status).toContain(
      "No contract code was changed for any of them; a96c4f58 was answered in words, not in code",
    );
    expect(b.status).toContain("launches/b-desk/ADAPTATION.md");
    expect(model.launches.find((launch) => launch.key === "C")).toMatchObject({ launched: false });

    const said = model.notLive.join("\n");
    for (const line of [
      "The hire desk is launched and no order has been opened on it: its own counter, orderCount(), read 0 for this page. So no order has been taken by a runner, none has been delivered, and none has been settled by a real job.",
      "No crowd pot has been opened: CrowdPots' own counter, potCount(), read 0 for this page.",
      "The Doorbell has opened no order: nobody has rung it, 25 rings stand before its next hire, and it is not funded (it holds 0 IMD), so a 25th ring would hire nothing until somebody sends it IMD.",
      "IdentityMD's receipts are stalled: its WorkRegistry has written no receipt in the last 24 hours of blocks",
      "only an order whose employer allowed the bonded-claim path can be paid",
      "The header job's receipt is not on chain.",
      "Launch B was audited by that pipeline before it was deployed, and by nobody outside IdentityMD's network: we bought no audit of it",
      "Launch C has not been audited by a third party.",
      "its handlers are still stubs, so it holds no table of orders, claims or pots",
    ]) {
      expect(said, line).toContain(line);
    }
    expect(said).toMatch(/^Launch C \(Rules, Endowments, Zap\): Not launched/m);
    expect(said).not.toContain("the hire desk is not launched");
    expect(said).not.toMatch(/^Launch B /m);
    // Nobody outside the team: said of what was read, with what was not read named beside it.
    const outside = model.notLive.find((line) =>
      line.startsWith("No use of our contracts by anyone outside"),
    )!;
    expect(outside).toContain(
      "no order has been opened on the hire desk; no crowd pot has been opened; nobody has rung the Doorbell",
    );
    expect(outside).toContain("Not read: the house feeds.");
    expect(outside).toContain("is HOUSE and is never counted as outside usage");

    // What the pipeline's audits found: seven findings, one medium, none changing a contract.
    expect(model.audits.desk).not.toBeNull();
    expect(model.audits.desk!.counts).toEqual({ medium: 1, info: 6, contractCodeChanged: 0 });
    expect(model.audits.desk!.findings.map((f) => f.id)).toEqual(DESK_ADAPTATION.findings.map((f) => f.id));
    expect(model.audits.desk!.intro).toContain(
      "No contract code was changed for any of them. The medium finding was answered in words, not in code",
    );
    expect(model.audits.desk!.intro).toContain("The limit it describes stands today");
    expect(markdown).toContain("**What the launch pipeline's audits found in launch B.**");
    expect(markdown).toContain("| a96c4f58 | medium | the independent review |");
    expect(markdown).toContain("launches/b-desk/ADAPTATION.md");
    // And the limit itself is in the table, in the document's words.
    const c2 = model.limits.rows.find((row) => row.launch === "B" && row.id === "C2")!;
    expect(c2.text).toContain(
      "A receipt-only pot can also be ended in a refund with no bond forfeited at all, whatever bond the opener chose.",
    );
    expect(c2.text).toContain("No IMD is lost.");

    // Launch B in its README's words: live, audited by the pipeline and by nobody outside IdentityMD's network.
    expect(model.desk.head).toContain("launched");
    expect(model.desk.status[0]).toContain("Live on Ethereum mainnet since 13 October 2026.");
    expect(model.desk.status.join(" ")).toContain(
      "The desk's first order was settled by a real job, on proof.",
    );
    expect(model.desk.status.join(" ")).toContain(
      "Audited by IdentityMD's launch pipeline, and by nobody outside IdentityMD's network.",
    );

    // The integration table counts zero as a reading, and says where the launch stands.
    const registry = model.integration.find((row) => row.primitive.startsWith("WorkRegistry"))!;
    expect(registry).toMatchObject({ launch: "launched", launchLabel: "Launched" });
    expect(registry.usage).toMatchObject({ count: "0", reason: null });
    const pipeline = model.integration.find((row) => row.primitive === "The launch pipeline")!;
    expect(pipeline.statusWords).toBe("Recorded: launch A, B.");
    expect(pipeline.usage.count).toBe("2 of 3");
    expect(pipeline.proofNote).toContain("launches/b-desk/ADAPTATION.md");
    const imd = model.integration.find((row) => row.primitive === "IMD")!;
    expect(imd.proofNote).toContain("WorkOrders holds 0 IMD, CrowdPots holds 0 IMD, Doorbell holds 0 IMD");

    // A reader can ask the launched WorkProof and compare the launched code, with the real address.
    const ask = model.reproduce.find((block) => block.title === "Ask the launched WorkProof")!;
    expect(ask.commands).toContain(`cast call ${PROOF} "prove(bytes16,bytes,uint256)(`);
    expect(ask.commands).toContain("0xe9efec1656f340d3924352c453effc7d");
    expect(model.reproduce.find((block) => block.commands === "pnpm repro")?.note).toContain(
      "one line for each of the 7 launched contracts",
    );
  });

  it("/judges reads launch B's job in IdentityMD's pipeline, once the book records the launch", async () => {
    const world = launchDay();
    const { loaded, markdown } = await page(world, "/judges");
    const model = loaded.model as JudgesModel;
    expect(model.deskPipeline).toMatchObject({
      jobId: LAUNCH_B_JOB.jobId,
      jobUrl: `https://api.imd.fun/jobs/${LAUNCH_B_JOB.jobId}`,
      error: null,
    });
    // As IdentityMD's API described the job after the launch: completed, every step accepted, live.
    expect(model.deskPipeline!.read).toMatchObject({
      state: "completed",
      stepsAccepted: 9,
      launchKind: "evm_contracts",
      launchStatus: "live",
      paidByHouse: "W1",
    });
    expect(model.deskPipeline!.read!.steps.map((step) => step.key)).toContain("audit_judge");
    expect(markdown).toContain(`Launch B's job: [${LAUNCH_B_JOB.jobId}]`);
    expect(markdown).toContain('The pipeline reports the launch as "live"');
    const row = model.integration.find((r) => r.primitive === "The launch pipeline")!;
    expect(row.proofs.map((proof) => proof.label)).toContain("launch B's job eb0f6c65");
    expect(world.api.calls).toContain(`GET /jobs/${LAUNCH_B_JOB.jobId}`);
    // Before the book records launch B the job is not read and nothing is said of it.
    const before = testSources({ book: BOOKS.aOnly });
    const earlier = (await page(before, "/judges")).loaded.model as JudgesModel;
    expect(earlier.deskPipeline).toBeNull();
    expect(before.api.calls).not.toContain(`GET /jobs/${LAUNCH_B_JOB.jobId}`);
    // And when IdentityMD's API does not answer for it, the page says so and claims nothing.
    const down = testSources({
      book: BOOKS.aAndB,
      api: fakeApi({ [`/jobs/${LAUNCH_B_JOB.jobId}`]: () => new Response("busy", { status: 503 }) }),
    });
    const unread = (await page(down, "/judges")).loaded.model as JudgesModel;
    expect(unread.deskPipeline).toMatchObject({ read: null });
    expect(unread.deskPipeline!.words).toContain("could not be read from IdentityMD's API just now");
  });

  it("receipts: stalled by the six-hour test, and still said to be late when the registry's log cannot be read", async () => {
    const stalled = ((await page(launchDay(), "/judges")).loaded.model as JudgesModel).notLive.join("\n");
    // Stalled by the six-hour test, and given its length: nothing in all the blocks searched.
    expect(stalled).toContain(
      "IdentityMD's receipts are stalled: its WorkRegistry has written no receipt in the last 24 hours of blocks (blocks ",
    );
    expect(stalled).toContain(
      "as far back as this server's RPC serves its log; nothing is said here of older blocks). 0 of the newest",
    );
    // The same day on a node that refuses the registry's log, as the public RPC sometimes does.
    const world = launchDay();
    const getLogs = world.chain.reader.getLogs.bind(world.chain.reader);
    world.chain.reader.getLogs = async (filter) => {
      if (sameAddress(filter.address, MAINNET.WORK_REGISTRY))
        throw new Error("eth_getLogs answered HTTP 403");
      return getLogs(filter);
    };
    const model = (await page(world, "/judges")).loaded.model as JudgesModel;
    expect(model.writer.stalled).toBeNull();
    const said = model.notLive.join("\n");
    expect(said).not.toContain("IdentityMD's receipts are stalled:");
    expect(said).toContain("IdentityMD's receipts are late or not arriving: 0 of the newest");
    expect(said).toContain("so the six-hour test was not run for this page");
    expect(said).toContain("only an order whose employer allowed the bonded-claim path can be paid");
  });

  it("the header job is said to have been bought before the desk was launched", async () => {
    const model = (await page(launchDay(), "/judges")).loaded.model as JudgesModel;
    expect(model.headerJob.notShown).toContain(
      "the job was bought before the hire desk was launched, so its header is the header of no order on the desk",
    );
    expect(model.headerJob.notShown).not.toContain("the hire desk is not launched");
    const before = (await page(testSources({ book: BOOKS.aOnly }), "/judges")).loaded.model as JudgesModel;
    expect(before.headerJob.notShown).toContain("the hire desk is not launched");
  });

  it("with launch B not in the book, the judges page quotes nothing about its launch", async () => {
    for (const book of [BOOKS.none, BOOKS.aOnly]) {
      const { loaded, markdown } = await page(testSources({ book }), "/judges");
      const model = loaded.model as JudgesModel;
      expect(model.audits.desk).toBeNull();
      expect(markdown).not.toContain("What the launch pipeline's audits found in launch B");
      expect(model.desk.status.join(" ")).not.toMatch(
        /Live on Ethereum mainnet|Audited by IdentityMD's launch pipeline|first order was settled/,
      );
      expect(model.desk.status.join(" ")).toContain(
        "IdentityMD's receipts stalled from about 8 to 14 October 2026.",
      );
      expect(model.notLive.join(" ")).toContain("Launches B and C have not been audited by a third party.");
      expect(model.reproduce.some((block) => block.title === "Ask the launched WorkProof")).toBe(false);
    }
  });

  it("/api/v1/evidence gives the launches, the empty desk as readings, the Doorbell, and what is not shown", async () => {
    const answer = await api<{
      contracts: { launched: number; of: number };
      launches: {
        launch: string;
        launched: boolean;
        identitymdLaunchNumber: number | null;
        block: number | null;
      }[];
      orders: { opened: number | null; desk: string; outsideEmployers: string[]; note: string };
      pots: { opened: number | null; outsideOpeners: string[]; note: string };
      doorbell: Record<string, unknown>;
      auditsByTheLaunchPipeline: {
        launchB: {
          launched: boolean;
          identitymdLaunchNumber: number;
          document: string;
          mediumFindings: number;
          contractCodeChangedForAFinding: boolean;
          mediumFindingAnswer: string;
          findings: { id: string; severity: string; outcome: string }[];
        };
      };
      notShown: string[] | null;
      notShownError: string | null;
    }>(launchDay(), "evidence");
    expect(answer.contracts).toMatchObject({ launched: 7, of: 10 });
    expect(answer.launches).toEqual([
      expect.objectContaining({
        launch: "A",
        launched: true,
        identitymdLaunchNumber: TEST_LAUNCH.a.launchNumber,
      }),
      expect.objectContaining({
        launch: "B",
        launched: true,
        identitymdLaunchNumber: TEST_LAUNCH.b.launchNumber,
        block: TEST_LAUNCH.b.block,
      }),
      expect.objectContaining({ launch: "C", launched: false, identitymdLaunchNumber: null, block: null }),
    ]);
    // Zero is a reading here: the desk and CrowdPots answered.
    expect(answer.orders).toMatchObject({ opened: 0, desk: DESK, outsideEmployers: [] });
    expect(answer.orders.note).toContain("Zero here is a reading, not a missing figure.");
    expect(answer.pots).toMatchObject({ opened: 0, outsideOpeners: [] });
    expect(answer.doorbell).toMatchObject({
      address: BELL,
      rings: 0,
      hires: 0,
      ringsUntilHire: 25,
      funded: false,
      heldWei: "0",
      minPayWei: IMD.toString(),
      maxPayWei: IMD.toString(),
      bondWei: (IMD / 4n).toString(),
      deliverySecs: 604_800,
      allowsBondedClaims: true,
      deliveriesReported: 0,
    });
    const audit = answer.auditsByTheLaunchPipeline.launchB;
    expect(audit).toMatchObject({
      launched: true,
      identitymdLaunchNumber: TEST_LAUNCH.b.launchNumber,
      document: "launches/b-desk/ADAPTATION.md",
      mediumFindings: 1,
      contractCodeChangedForAFinding: false,
    });
    expect(audit.findings).toHaveLength(7);
    expect(audit.mediumFindingAnswer).toContain("the words were corrected, not the desk");
    expect(answer.notShownError).toBeNull();
    const notShown = (answer.notShown ?? []).join("\n");
    expect(notShown).toContain("The hire desk is launched and no order has been opened on it");
    expect(notShown).toContain("none has been settled by a real job");
    expect(notShown).toContain(
      "No use of our contracts by anyone outside the team was found in what this page read",
    );
    expect(notShown).toContain("IdentityMD's receipts are stalled");
  });

  it("/llms.txt says the same of the desk, the pots and the Doorbell", async () => {
    const text = await llmsTxt(ctxFor(launchDay()));
    expect(text).toContain("**7 of our 10 contracts are launched (launches A and B).**");
    expect(text).toContain(
      "The hire desk is live and no order has been opened on it yet (WorkOrders.orderCount() read 0).",
    );
    expect(text).toContain("No crowd pot has been opened yet (CrowdPots.potCount() read 0).");
    expect(text).toContain(
      "The Doorbell: 0 rings so far, 0 hires, 25 rings until the next hire; not funded (it holds 0 IMD); each order pays 1 IMD; its orders accept a bonded delivery claim.",
    );
    expect(text).toContain(`| B | WorkOrders | ${DESK} |`);
    expect(text).toContain(`| C | Rules | ${NOT_LAUNCHED} |`);
    expect(text).toContain(
      "No contract code was changed for any of them; a96c4f58 (a receipt-only pot can be ended in a refund with no bond forfeited) was answered in words, not in code, and stands as a disclosed limit.",
    );
    // The count is of the accepted submissions, and each grading is said with whose it is.
    expect(text).toContain(
      "Its record of the job, https://api.imd.fun/jobs/eb0f6c65-174a-45e8-9fe5-9312c66d4880/submissions, holds 11 findings in its accepted submissions (the judge's first round, not accepted, raised 3 that its last round restates).",
    );
    expect(text).toContain("It grades a96c4f58 medium, as the judge's first round did");
    expect(text).not.toContain("1 medium finding and 6 at level info");
    // The pages of launch B are no longer listed as waiting, Say When among them (a conditional
    // order is the desk's); the one page that is launch C's alone still is.
    const pages = text.slice(text.indexOf("## Pages"), text.indexOf("## Proven on the live system"));
    expect(pages.match(/Not live until/g)).toHaveLength(1);
    expect(pages).toContain("Not live until Endowments is launched");
    expect(pages).not.toContain("Not live until WorkOrders is launched");
  });
});

describe("the first order from somebody else", () => {
  it("stops the judges page saying nobody outside the team has used anything, and counts it as OUTSIDE", async () => {
    const world = testSources({
      book: BOOKS.aAndB,
      chain: {
        views: {
          ...LAUNCH_DAY_VIEWS,
          [`${DESK}:orderCount`]: { abi: workOrdersAbi, result: 1n },
          [`${DESK}:accountOf`]: { abi: workOrdersAbi, result: [1, OUTSIDER, 3n * IMD, 0n, 0n] },
        },
      },
    });
    const model = (await page(world, "/judges")).loaded.model as JudgesModel;
    const said = model.notLive.join("\n");
    expect(said).not.toContain("No use of our contracts by anyone outside the team");
    expect(said).not.toContain("no order has been opened on it");
    expect(said).toContain(
      "One order has been opened on the hire desk; it was read for this page: 0 from our own wallets and contracts (HOUSE) and 1 from others (OUTSIDE). None has been paid as delivered.",
    );
    const evidence = await api<{
      orders: { opened: number; houseEmployers: string[]; outsideEmployers: string[] };
    }>(world, "evidence");
    expect(evidence.orders).toMatchObject({ opened: 1, houseEmployers: [], outsideEmployers: [OUTSIDER] });
    // An order from the Doorbell is one of ours: HOUSE, and not outside usage.
    const house = testSources({
      book: BOOKS.aAndB,
      chain: {
        views: {
          ...LAUNCH_DAY_VIEWS,
          [`${DESK}:orderCount`]: { abi: workOrdersAbi, result: 1n },
          [`${DESK}:accountOf`]: { abi: workOrdersAbi, result: [1, BELL, IMD, 0n, 0n] },
        },
      },
    });
    const ours = (await page(house, "/judges")).loaded.model as JudgesModel;
    expect(ours.notLive.join("\n")).toContain(
      "the one order read from the hire desk was opened by one of our own wallets or contracts",
    );
    expect(ours.notLive.join("\n")).toContain(
      "1 from our own wallets and contracts (HOUSE) and 0 from others (OUTSIDE)",
    );
  });
});

describe("launch B in the book, and a chain that answers nothing for it", () => {
  it("every page of launch B says it could not be read: never zero, never 'not launched'", async () => {
    const world = silent();
    for (const path of ["/orders", "/pots", "/runners", "/hire", "/rules/new", "/"]) {
      const { said } = await page(world, path);
      expect(said, path).toMatch(/could not be read just now/);
      expect(said, path).not.toMatch(NOT_LAUNCHED_OF_B);
      expect(said, path).not.toMatch(
        /\b0 (orders|pots|rings|hires)\b|No order has been|No pot has been|nothing to take yet/,
      );
      expect(said, path).not.toMatch(/has not been rung|hired nothing|not funded/);
    }
    expect((await page(world, "/orders")).loaded.model as OrdersModel).toMatchObject({
      launched: true,
      count: null,
    });
    const runners = await page(world, "/runners");
    expect(runners.markdown).toContain(
      `The hire desk is at ${DESK}, but its orders could not be read just now`,
    );
    expect(runners.markdown).not.toContain("There are no open orders right now");
    const home = await page(world, "/");
    expect(home.markdown).toContain(`The hire desk is at ${DESK}. Its orders could not be read just now`);
    expect(home.markdown).not.toContain("No orders have been posted yet");
    const pots = await page(world, "/pots");
    expect(pots.markdown).toContain("How many pots have been opened on it could not be read just now");
    const bell = await page(world, "/rules/new");
    expect(bell.markdown).toContain("**The Doorbell could not be read just now");
  });

  it("the judges page, the evidence route and /llms.txt say 'could not be read' too", async () => {
    const world = silent();
    const model = (await page(world, "/judges")).loaded.model as JudgesModel;
    const said = model.notLive.join("\n");
    expect(said).toContain("Whether any order has been opened on the hire desk could not be read just now");
    expect(said).toContain("Whether any crowd pot has been opened could not be read just now");
    expect(said).toContain("What the Doorbell has done could not be read just now");
    expect(said).not.toContain("no order has been opened");
    expect(said).not.toContain("the hire desk is not launched");
    // Nothing was read, so nothing is said about who has and has not used the contracts.
    expect(said).not.toContain("No use of our contracts by anyone outside the team");
    const registry = model.integration.find((row) => row.primitive.startsWith("WorkRegistry"))!;
    expect(registry.usage.count).toBeNull();
    expect(registry.usage.reason).toContain("did not answer");

    const evidence = await api<{
      contracts: { launched: number };
      orders: { opened: number | null; reason: string };
      pots: { opened: number | null; reason: string };
      doorbell: { rings: number | null; reason: string };
    }>(world, "evidence");
    expect(evidence.contracts.launched).toBe(7);
    expect(evidence.orders).toEqual({ opened: null, reason: "WorkOrders.orderCount() did not answer" });
    expect(evidence.pots).toEqual({ opened: null, reason: "CrowdPots.potCount() did not answer" });
    expect(evidence.doorbell).toEqual({ rings: null, reason: "Doorbell.ringsUntilHire() did not answer" });

    const text = await llmsTxt(ctxFor(world));
    expect(text).toContain("The hire desk is launched; its orders could not be read just now");
    expect(text).toContain("CrowdPots is launched; its pots could not be read just now");
    expect(text).toContain("The Doorbell is launched; it could not be read just now");
    expect(text).not.toMatch(/no order has been opened|No crowd pot has been opened/);
  });

  it("before launch B is in the book the same pages say 'not launched', and the evidence route gives the reason", async () => {
    const world = testSources({ book: BOOKS.aOnly });
    const evidence = await api<{
      doorbell: { rings: number | null; reason: string };
      auditsByTheLaunchPipeline: { launchB: { launched: boolean } };
    }>(world, "evidence");
    expect(evidence.doorbell).toEqual({ rings: null, reason: `Doorbell is ${NOT_LAUNCHED}` });
    expect(evidence.auditsByTheLaunchPipeline.launchB.launched).toBe(false);
    const text = await llmsTxt(ctxFor(world));
    expect(text).not.toContain("The hire desk is live");
    expect(text).not.toContain("Not a proof, a disclosure");
  });
});
