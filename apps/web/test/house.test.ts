/**
 * Our own contracts as a data source. A contract with no address in the deployments book answers
 * "not live" to every read; one with an address is read from the chain. The book is injected: a
 * test names the situation it is about (nothing launched, launch A only, everything), or switches
 * one contract on with an address in the configuration, the way a fork or a rehearsal does.
 */
import { encodeAbiParameters, encodeEventTopics, parseAbi, stringToHex, type Abi } from "viem";
import { describe, expect, it } from "vitest";
import { HOUSE_WALLETS } from "~/config/house";
import {
  crowdPotsAbi,
  doorbellAbi,
  kindHash,
  MAINNET,
  orderHeader,
  orderTicket,
  payrollAbi,
  specHash,
  workOrdersAbi,
} from "@help-wanted/shared";
import { handleApi } from "~/lib/api";
import { loadPath, markdownTwin } from "~/lib/twins";
import type { RawLog } from "~/lib/jsonrpc";
import { BOOKS, ctxFor, testSources } from "./helpers";

const IMD = 10n ** 18n;
const DESK = "0x00000000000000000000000000000000000000d1";
const POTS = "0x00000000000000000000000000000000000000c2";
const PAYROLL = "0x00000000000000000000000000000000000000a3";
const EMPLOYER = "0x1111111111111111111111111111111111111111";
const RUNNER = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";

type Views = Record<string, { abi: Abi; result: unknown }>;

function orderOf(overrides: Record<string, unknown> = {}) {
  return {
    employer: EMPLOYER,
    expiresAt: 1_792_300_000,
    rampFrom: 1_791_660_000,
    state: 1,
    flags: 1,
    kindHash: kindHash("audit"),
    specHash: specHash("Audit it."),
    minPay: 2n * IMD,
    maxPay: 3n * IMD,
    rampSecs: 3600,
    deliverySecs: 259_200,
    runnerOnly: ZERO,
    bond: IMD / 4n,
    arbiter: ZERO,
    escrow: 3n * IMD,
    condTarget: ZERO,
    condSelector: "0x00000000",
    condCmp: 0,
    condMet: true,
    proven: false,
    notified: false,
    seq: 0,
    condArg: `0x${"0".repeat(64)}`,
    condThreshold: 0n,
    spent: 0n,
    returned: 0n,
    ...overrides,
  };
}

function claimOf(overrides: Record<string, unknown> = {}) {
  return {
    runner: ZERO,
    claimedAt: 0,
    registeredAt: 0,
    price: 0n,
    jobId: `0x${"0".repeat(32)}`,
    challenger: ZERO,
    assertedAt: 0,
    recordHash: `0x${"0".repeat(64)}`,
    ...overrides,
  };
}

describe("what is live follows the deployments book", () => {
  const readAll = (house: ReturnType<typeof testSources>["sources"]["house"]) =>
    Promise.all([
      house.orders(),
      house.order(1),
      house.pots(),
      house.pot(1),
      house.ledger(),
      house.seatPay(1998),
      house.tipOwed("52211"),
      house.feeds(),
      house.report(),
      house.doorbell(),
      house.keeperTips(HOUSE_WALLETS[1]!.address),
      house.rules(),
      house.endowments(),
    ]);
  const CONTRACTS = [
    "workOrders",
    "workOrders",
    "crowdPots",
    "crowdPots",
    "payroll",
    "payroll",
    "payroll",
    "questions",
    "jobsReport",
    "doorbell",
    "questions",
    "rules",
    "endowments",
  ];
  const LAUNCH_A = ["payroll", "questions", "jobsReport"];

  it("before any launch, every read answers 'not live' without touching the chain", async () => {
    const world = testSources({ book: BOOKS.none });
    const { house } = world.sources;
    const reads = await readAll(house);
    expect(reads.map((r) => r.live)).toEqual(Array(13).fill(false));
    expect((await house.identity("workOrders")).live).toBe(false);
    expect(reads.map((r) => r.contract)).toEqual(CONTRACTS);
    expect(world.chain.calls).toEqual([]);
  });

  it("with launch A only, launch A's reads go to the chain and the desk's and the company's stay 'not live'", async () => {
    const world = testSources({ book: BOOKS.aOnly });
    const { house } = world.sources;
    const reads = await readAll(house);
    expect(reads.map((r) => r.live)).toEqual(CONTRACTS.map((contract) => LAUNCH_A.includes(contract)));
    for (const read of reads) {
      if (!read.live) continue;
      // Nothing answers at the book's stand-in addresses: each read says so and gives no figure.
      expect(read.data, read.contract).toBeNull();
      expect(read.error, read.contract).toContain("did not answer");
      expect(read.address.toLowerCase()).toBe(
        BOOKS.aOnly.a.contracts[read.contract as keyof typeof BOOKS.aOnly.a.contracts],
      );
    }
    expect((await house.identity("workOrders")).live).toBe(false);
    expect((await house.identity("payroll")).live).toBe(true);
    // Only launch A's three addresses were ever called.
    const called = new Set(
      world.chain.calls.filter((c) => c.startsWith("eth_getLogs")).map((c) => c.split(" ")[1]),
    );
    for (const address of called) expect(Object.values(BOOKS.aOnly.a.contracts)).toContain(address);
  });

  it("with everything launched, every read goes to the chain", async () => {
    const reads = await readAll(testSources({ book: BOOKS.all }).sources.house);
    expect(reads.map((r) => r.live)).toEqual(Array(13).fill(true));
    for (const read of reads) if (read.live) expect(read.error, read.contract).toContain("did not answer");
  });
});

describe("with the hire desk launched", () => {
  const env = { HW_ADDR_WORK_ORDERS: DESK };

  it("an order reads from the frozen view alone when the richer views do not answer", async () => {
    const views: Views = {
      [`${DESK}:orderCount`]: { abi: workOrdersAbi, result: 1n },
      [`${DESK}:accountOf`]: { abi: workOrdersAbi, result: [1, EMPLOYER, 3n * IMD, 0n, 0n] },
    };
    const world = testSources({ env, chain: { views, contracts: [EMPLOYER] } });
    const book = await world.sources.house.orders();
    expect(book).toMatchObject({ live: true, contract: "workOrders", error: null });
    if (!book.live || !book.data) throw new Error("expected data");
    expect(book.data.count).toBe(1);
    expect(book.data.orders).toEqual([
      {
        id: 1,
        state: "Open",
        employer: EMPLOYER,
        escrowWei: 3n * IMD,
        spentWei: 0n,
        returnedWei: 0n,
        terms: null,
        claim: null,
        spec: null,
      },
    ]);

    const loaded = await loadPath("/orders", ctxFor(world, "/orders"));
    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain("1 order has been opened on the hire desk");
    // An employer with code is a contract; one that is not ours is OUTSIDE.
    expect(markdown).toContain("HELP WANTED: robots. Pay up to 3 IMD.");
    expect(markdown).toContain("| OUTSIDE | OPEN |");
    expect(markdown).not.toContain("not launched yet");

    const home = await loadPath("/", ctxFor(world));
    const ours = (
      home!.model as {
        ourOrders: { launched: boolean; count: number; cards: { employerWords: string; origin: string }[] };
      }
    ).ourOrders;
    expect(ours).toMatchObject({ launched: true, count: 1 });
    expect(ours.cards[0]).toMatchObject({ employerWords: "Employer: a contract.", origin: "OUTSIDE" });
  });

  it("labels an order HOUSE when its employer is one of our wallets", async () => {
    const house = HOUSE_WALLETS[0]!.address;
    const views: Views = {
      [`${DESK}:orderCount`]: { abi: workOrdersAbi, result: 1n },
      [`${DESK}:accountOf`]: { abi: workOrdersAbi, result: [1, house, 3n * IMD, 0n, 0n] },
    };
    const world = testSources({ env, chain: { views } });
    const loaded = await loadPath("/orders", ctxFor(world, "/orders"));
    const cards = (loaded!.model as { cards: { origin: string; employerWords: string }[] }).cards;
    expect(cards[0]).toMatchObject({ origin: "HOUSE", employerWords: "Employer: a wallet." });
  });

  it("a delivered, proven order carries its stamp, its money and the header its job began with", async () => {
    const jobId = "0xe9efec1656f340d3924352c453effc7d";
    const recordHash = `0x${"3d".repeat(32)}`;
    const views: Views = {
      [`${DESK}:accountOf`]: { abi: workOrdersAbi, result: [6, EMPLOYER, 0n, 2n * IMD, IMD] },
      [`${DESK}:orderOf`]: {
        abi: workOrdersAbi,
        result: orderOf({ state: 6, escrow: 0n, spent: 2n * IMD, returned: IMD, proven: true, seq: 2 }),
      },
      [`${DESK}:claimOf`]: {
        abi: workOrdersAbi,
        result: claimOf({
          runner: RUNNER,
          claimedAt: 1_791_661_000,
          registeredAt: 1_791_661_600,
          price: 2n * IMD,
          jobId,
          recordHash,
        }),
      },
    };
    const world = testSources({ env, chain: { views } });
    const loaded = await loadPath("/orders/7", ctxFor(world, "/orders/7"));
    const model = loaded!.model as {
      card: { stamp: { text: string }; headline: string };
      order: { state: string; claim: { jobId: string; runner: string } };
      money: { label: string; imd: string }[];
      ticket: string;
      header: string;
      verifyPath: string;
      timeline: { label: string; at: string }[];
      kind: string;
    };
    expect(model.card.stamp.text).toBe("PROVEN ON CHAIN");
    expect(model.card.headline).toBe("HELP WANTED: 4 robot auditors.");
    expect(model.kind).toBe("audit");
    expect(model.order.claim).toMatchObject({
      jobId: "e9efec16-56f3-40d3-9243-52c453effc7d",
      runner: RUNNER,
    });
    expect(model.verifyPath).toBe("/verify/e9efec16-56f3-40d3-9243-52c453effc7d");
    expect(model.timeline.map((s) => s.at)).toEqual(["done", "done", "done", "done", "done"]);
    const money = Object.fromEntries(model.money.map((row) => [row.label, row.imd]));
    expect(money).toMatchObject({
      "Still in escrow": "0",
      "Paid out for delivered work": "2",
      "Sent back to the employer": "1",
      "Price fixed by the runner's claim": "2",
      "of which fee (to Payroll)": "0.1",
      "of which tip (to the seats of the agents the record names)": "0.1",
      "of which to the runner": "1.8",
    });
    // The ticket is recomputed from public facts: chain, desk, order, claim number, runner.
    const ticket = orderTicket({ chainId: 1, workOrders: DESK, orderId: 7, claimSeq: 2, runner: RUNNER });
    expect(model.ticket).toBe(ticket);
    expect(model.header).toBe(orderHeader(ticket));
    expect(model.header).toHaveLength(85);
    expect(markdownTwin(loaded!)).toContain("Stamp: PROVEN ON CHAIN");
  });

  it("shows the job text from the order's OrderOpened log, as the employer wrote it", async () => {
    // The event exactly as WorkOrders declares it; the desk itself keeps only the text's hash.
    const event = parseAbi([
      "struct OrderParams { bytes32 kindHash; uint96 minPay; uint96 maxPay; uint32 rampSecs; uint32 deliverySecs; uint40 expiresAt; uint96 bond; uint8 flags; address runnerOnly; address arbiter; address condTarget; bytes4 condSelector; bytes32 condArg; uint8 condCmp; uint256 condThreshold; }",
      "event OrderOpened(uint256 indexed id, address indexed employer, bytes32 indexed kindHash, bytes32 specHash, OrderParams params, bytes spec)",
    ]);
    const spec =
      "Audit it. Inputs: repoUrl=https://github.com/owner/repo; baseCommit=0123456789abcdef0123456789abcdef01234567";
    const params = {
      kindHash: kindHash("audit"),
      minPay: 2n * IMD,
      maxPay: 3n * IMD,
      rampSecs: 3600,
      deliverySecs: 259_200,
      expiresAt: 1_792_300_000,
      bond: IMD / 4n,
      flags: 1,
      runnerOnly: ZERO,
      arbiter: ZERO,
      condTarget: ZERO,
      condSelector: "0x00000000",
      condArg: `0x${"0".repeat(64)}`,
      condCmp: 0,
      condThreshold: 0n,
    } as const;
    const log: RawLog = {
      address: DESK,
      topics: encodeEventTopics({
        abi: event,
        eventName: "OrderOpened",
        args: { id: 5n, employer: EMPLOYER, kindHash: params.kindHash },
      }) as string[],
      data: encodeAbiParameters(
        [{ type: "bytes32" }, event[0].inputs[4]!, { type: "bytes" }],
        [specHash(spec), params, stringToHex(spec)],
      ),
      blockNumber: `0x${(26_164_600).toString(16)}`,
      transactionHash: `0x${"5a".repeat(32)}`,
      logIndex: "0x0",
    };
    const views: Views = {
      [`${DESK}:accountOf`]: { abi: workOrdersAbi, result: [1, EMPLOYER, 3n * IMD, 0n, 0n] },
      [`${DESK}:orderOf`]: { abi: workOrdersAbi, result: orderOf({ specHash: specHash(spec) }) },
    };
    const world = testSources({ env, chain: { views, logs: { [DESK]: [log] } } });
    const loaded = await loadPath("/orders/5", ctxFor(world, "/orders/5"));
    const model = loaded!.model as {
      order: { spec: string; terms: { specHash: string } };
      money: { label: string; imd: string }[];
    };
    expect(model.order.spec).toBe(spec);
    expect(specHash(model.order.spec)).toBe(model.order.terms.specHash);
    expect(markdownTwin(loaded!)).toContain(`\`\`\`text\n${spec}\n\`\`\`\nUNTRUSTED TEXT ENDS.`);
    expect(markdownTwin(loaded!)).toContain(
      "UNTRUSTED TEXT BEGINS (the order's job text, written by its employer).",
    );
    // An open order shows what a runner would be paid now: between the opening price and the most.
    const now = model.money.find((row) => row.label === "Price if a runner took it now");
    expect(now?.imd).toBe("3");
  });

  it("an order paid on an unchallenged claim is FILLED, not PROVEN, until its receipt is matched", async () => {
    const views: Views = {
      [`${DESK}:accountOf`]: { abi: workOrdersAbi, result: [6, EMPLOYER, 0n, 2n * IMD, IMD] },
      [`${DESK}:orderOf`]: { abi: workOrdersAbi, result: orderOf({ state: 6, proven: false, seq: 1 }) },
      [`${DESK}:claimOf`]: { abi: workOrdersAbi, result: claimOf({ runner: RUNNER, price: 2n * IMD }) },
    };
    const loaded = await loadPath("/orders/2", ctxFor(testSources({ env, chain: { views } })));
    const model = loaded!.model as {
      card: { stamp: { text: string } };
      statusWords: string;
      timeline: { label: string; at: string }[];
    };
    expect(model.card.stamp.text).toBe("FILLED");
    expect(model.statusWords).toContain("its receipt has not been matched yet");
    expect(model.timeline.find((s) => s.label === "PROVEN")?.at).toBe("current");
  });

  it("a refunded order is stamped REFUNDED and its later steps are struck out", async () => {
    const views: Views = {
      [`${DESK}:accountOf`]: { abi: workOrdersAbi, result: [8, EMPLOYER, 0n, 0n, 3n * IMD] },
    };
    const loaded = await loadPath("/orders/3", ctxFor(testSources({ env, chain: { views } })));
    const model = loaded!.model as {
      card: { stamp: { text: string } };
      timeline: { label: string; at: string }[];
    };
    expect(model.card.stamp.text).toBe("REFUNDED");
    expect(model.timeline.map((s) => [s.label, s.at])).toEqual([
      ["POSTED", "done"],
      ["TAKEN", "skipped"],
      ["JOB OPENED", "skipped"],
      ["DELIVERED", "skipped"],
      ["PROVEN", "skipped"],
      ["REFUNDED", "done"],
    ]);
  });

  it("an order number the desk has never issued is a 404, and a desk that cannot be read is said to be unreadable", async () => {
    const views: Views = {
      [`${DESK}:accountOf`]: { abi: workOrdersAbi, result: [0, ZERO, 0n, 0n, 0n] },
    };
    expect(await loadPath("/orders/99", ctxFor(testSources({ env, chain: { views } })))).toBeNull();

    const down = testSources({ env, chain: { failCalls: true } });
    const loaded = await loadPath("/orders", ctxFor(down, "/orders"));
    const model = loaded!.model as { launched: boolean; cards: unknown[]; error: string };
    expect(model.launched).toBe(true);
    expect(model.cards).toEqual([]);
    expect(model.error).toContain("the RPC is down");
    expect(markdownTwin(loaded!)).toContain("The desk could not be read just now");
  });

  it("counts real orders as evidence, HOUSE and OUTSIDE apart", async () => {
    const views: Views = {
      [`${DESK}:orderCount`]: { abi: workOrdersAbi, result: 1n },
      [`${DESK}:accountOf`]: { abi: workOrdersAbi, result: [6, EMPLOYER, 0n, 2n * IMD, IMD] },
      [`${DESK}:orderOf`]: { abi: workOrdersAbi, result: orderOf({ state: 6, proven: true, seq: 1 }) },
    };
    const world = testSources({ env, chain: { views } });
    const response = await handleApi(
      "evidence",
      new Request("https://help-wanted.test/api/v1/evidence"),
      ctxFor(world),
    );
    const body = (await response.json()) as {
      contracts: { launched: number };
      orders: Record<string, unknown>;
    };
    expect(body.contracts.launched).toBe(1);
    expect(body.orders).toMatchObject({
      opened: 1,
      delivered: 1,
      provenOnChain: 1,
      refunded: 0,
      houseEmployers: [],
      outsideEmployers: [EMPLOYER],
    });
  });
});

describe("with the pots and Payroll launched", () => {
  it("a pot reads its remaining need from the frozen view", async () => {
    const views: Views = {
      [`${POTS}:potCount`]: { abi: crowdPotsAbi, result: 1n },
      [`${POTS}:remaining`]: { abi: crowdPotsAbi, result: (3n * IMD) / 2n },
    };
    const world = testSources({ env: { HW_ADDR_CROWD_POTS: POTS }, chain: { views } });
    const loaded = await loadPath("/pots", ctxFor(world, "/pots"));
    const model = loaded!.model as {
      launched: boolean;
      count: number;
      cards: { progress: string; stage: string }[];
    };
    expect(model).toMatchObject({ launched: true, count: 1 });
    expect(model.cards[0]?.progress).toBe("1.5 IMD still needed.");
  });

  it("a seat shows what it can claim, and the ledger shows the split to the wei", async () => {
    const ledger = {
      received: 100n * IMD,
      toStakers: 50n * IMD,
      toSeats: 30n * IMD,
      toFeeds: 20n * IMD,
      dripped: 5n * IMD,
      seatClaimed: IMD,
      tipsIn: 4n * IMD,
      tipsClaimed: IMD,
      feedsFunded: 2n * IMD,
      tipsToSeats: 0n,
      feedsReleased: 0n,
    };
    const views: Views = {
      [`${PAYROLL}:seatClaimable`]: { abi: payrollAbi, result: 15_000_000_000_000_000n },
      [`${PAYROLL}:tipOwed`]: { abi: payrollAbi, result: IMD / 10n },
      [`${PAYROLL}:ledger`]: { abi: payrollAbi, result: ledger },
      [`${PAYROLL}:stream`]: {
        abi: payrollAbi,
        result: [45n * IMD, 40n * IMD, 1_792_000_000n, IMD, 1_791_670_000n, IMD / 2n],
      },
      [`${PAYROLL}:unbooked`]: { abi: payrollAbi, result: 0n },
    };
    const world = testSources({ env: { HW_ADDR_PAYROLL: PAYROLL }, chain: { views } });

    const seat = await loadPath("/seats/1998", ctxFor(world, "/seats/1998"));
    const seatModel = seat!.model as { claimableImd: string; tips: { agentId: string; owedImd: string }[] };
    expect(seatModel.claimableImd).toBe("0.015");
    expect(seatModel.tips).toEqual([{ agentId: "52211", owedImd: "0.1" }]);
    expect(markdownTwin(seat!)).toContain("| Claimable from the seat pool | 0.015 IMD |");

    const company = await loadPath("/company", ctxFor(world, "/company"));
    const sections = (
      company!.model as { sections: { title: string; rows: { label: string; imd: string }[] }[] }
    ).sections;
    expect(sections.map((s) => s.title)).toEqual([
      "What came in",
      "The stream to stakers",
      "The seat pool",
      "Tips",
      "The feed budget",
    ]);
    const rows = Object.fromEntries(sections.flatMap((s) => s.rows).map((r) => [r.label, r.imd]));
    expect(rows).toMatchObject({
      "Received and split, all time": "100",
      "Booked for sIMD stakers": "50",
      "Sent to sIMD so far": "5",
      "Still to be sent": "45",
      "Booked for seat owners": "30",
      "Claimed by seat owners": "1",
      "Tips received for agents": "4",
      "Tips claimed": "1",
      "Placed on feed meters so far": "2",
      "Due to sIMD right now": "0.5",
      "Arrived but not yet split": "0",
    });
    expect(markdownTwin(company!)).not.toContain("The ledger is empty");

    const evidence = await handleApi("evidence", new Request("https://help-wanted.test/x"), ctxFor(world));
    const body = (await evidence.json()) as { feeSplit: Record<string, string> };
    expect(body.feeSplit).toMatchObject({
      receivedWei: (100n * IMD).toString(),
      sentToStakersWei: (5n * IMD).toString(),
    });
  });
});

describe("a pot's page shows what the pot will order", () => {
  const specPinned = parseAbi(["event SpecPinned(bytes32 indexed specHash, bytes spec)"]);
  const SPEC =
    "Audit the vault. Inputs: repoUrl=https://github.com/owner/repo; baseCommit=0123456789abcdef0123456789abcdef01234567";

  function potOf(overrides: Record<string, unknown> = {}) {
    return {
      specHash: specHash(SPEC),
      kindHash: kindHash("audit"),
      target: 3n * IMD,
      raised: IMD,
      deadline: 1_792_300_000,
      stage: 1,
      allowClaimed: false,
      minPay: 2n * IMD,
      bond: IMD / 4n,
      rampSecs: 3600,
      deliverySecs: 259_200,
      opener: EMPLOYER,
      hireSecs: 86_400,
      fundSecs: 86_400,
      pool: 0n,
      chipsLeft: 0n,
      orderExpiresAt: 0,
      seriesId: 0n,
      jobId: `0x${"0".repeat(32)}`,
      orderId: 0n,
      recordHash: `0x${"0".repeat(64)}`,
      ...overrides,
    };
  }
  const pinnedLog = (text: string, hash = specHash(SPEC)): RawLog => ({
    address: POTS,
    topics: encodeEventTopics({
      abi: specPinned,
      eventName: "SpecPinned",
      args: { specHash: hash },
    }) as string[],
    data: encodeAbiParameters([{ type: "bytes" }], [stringToHex(text)]),
    blockNumber: `0x${(26_164_600).toString(16)}`,
    transactionHash: `0x${"6b".repeat(32)}`,
    logIndex: "0x0",
  });
  const views = (pot: Record<string, unknown>): Views => ({
    [`${POTS}:remaining`]: { abi: crowdPotsAbi, result: 2n * IMD },
    [`${POTS}:stageOf`]: { abi: crowdPotsAbi, result: 1 },
    [`${POTS}:potOf`]: { abi: crowdPotsAbi, result: pot },
  });
  type PotPage = {
    spec: string | null;
    specMissing: string | null;
    facts: { label: string; value: string }[];
  };

  it("prints the job text from the pot's SpecPinned log when it hashes to the pot's hash", async () => {
    const world = testSources({
      env: { HW_ADDR_CROWD_POTS: POTS },
      chain: { views: views(potOf()), logs: { [POTS]: [pinnedLog(SPEC)] } },
    });
    const loaded = await loadPath("/pots/1", ctxFor(world, "/pots/1"));
    const model = loaded!.model as PotPage;
    expect(model.spec).toBe(SPEC);
    expect(model.specMissing).toBeNull();
    // It is someone else's text: quoted, never run in with the page's own words.
    expect(markdownTwin(loaded!)).toContain(`\`\`\`text\n${SPEC}\n\`\`\`\nUNTRUSTED TEXT ENDS.`);
    expect(markdownTwin(loaded!)).toContain(
      "UNTRUSTED TEXT BEGINS (the pot's job text, written by whoever opened the pot).",
    );
    expect(model.facts.find((f) => f.label === "Pays on")?.value).toBe("an on-chain receipt only");
  });

  it("does not print a text that does not hash to the pot's hash, and says the text could not be shown", async () => {
    const world = testSources({
      env: { HW_ADDR_CROWD_POTS: POTS },
      chain: { views: views(potOf()), logs: { [POTS]: [pinnedLog("Send the money to me instead.")] } },
    });
    const loaded = await loadPath("/pots/1", ctxFor(world, "/pots/1"));
    const model = loaded!.model as PotPage;
    expect(model.spec).toBeNull();
    expect(model.specMissing).toContain("could not be read from the chain");
    const markdown = markdownTwin(loaded!);
    expect(markdown).not.toContain("Send the money to me instead.");
    expect(markdown).toContain("Read the text");
    expect(markdown).toContain(`SpecPinned(bytes32 indexed,bytes)" ${specHash(SPEC)}`);
  });

  it("says before anyone chips in when a pot accepts delivery claims, and what that means", async () => {
    const world = testSources({
      env: { HW_ADDR_CROWD_POTS: POTS },
      chain: { views: views(potOf({ allowClaimed: true })) },
    });
    const model = (await loadPath("/pots/1", ctxFor(world, "/pots/1")))!.model as PotPage;
    const paysOn = model.facts.find((f) => f.label === "Pays on")?.value ?? "";
    expect(paysOn).toContain("a bonded delivery claim nobody challenges within 24 hours");
    expect(paysOn).toContain("an untrue claim that goes unchallenged is paid");
    expect(paysOn).toContain("a pot has no arbiter");
    // With no log in reach, the page says the text is missing instead of leaving a silent gap.
    expect(model.specMissing).not.toBeNull();
  });

  it("offers the refund, not a chip, once a pot has run out of time", async () => {
    const world = testSources({
      env: { HW_ADDR_CROWD_POTS: POTS },
      chain: {
        views: {
          ...views(potOf()),
          [`${POTS}:remaining`]: { abi: crowdPotsAbi, result: 0n },
          [`${POTS}:stageOf`]: { abi: crowdPotsAbi, result: 4 },
        },
      },
    });
    const loaded = await loadPath("/pots/1", ctxFor(world, "/pots/1"));
    const model = loaded!.model as PotPage & {
      flows: { id: string }[];
      flowsHeading: { title: string } | null;
      card: { deadlineWords: string | null };
    };
    expect(model.flows.map((f) => f.id)).toEqual(["claim-refund"]);
    expect(model.flowsHeading?.title).toBe("Claim a refund");
    expect(model.facts.find((f) => f.label === "Still needed")?.value).toBe(
      "none: it takes no more chips (stage Refundable)",
    );
    expect(model.card.deadlineWords).toContain("every chip can be claimed back");
    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain("Claim a pot refund");
    expect(markdown).not.toContain("Chip in with ETH");
  });
});

describe("the address in the configuration is asked to identify itself", () => {
  const identityAbi = parseAbi([
    "function IMD() view returns (address)",
    "function WORK_REGISTRY() view returns (address)",
    "function QUESTIONS() view returns (address)",
  ]);
  const WORK_PROOF = "0x00000000000000000000000000000000000000b4";
  const QUESTIONS = "0x00000000000000000000000000000000000000e5";
  const JOBS_REPORT = "0x00000000000000000000000000000000000000f6";

  it("is confirmed when the contract answers with the IMD token it was built for", async () => {
    const world = testSources({
      env: { HW_ADDR_WORK_ORDERS: DESK },
      chain: { views: { [`${DESK}:IMD`]: { abi: identityAbi, result: MAINNET.IMD } } },
    });
    const read = await world.sources.house.identity("workOrders");
    expect(read).toMatchObject({ live: true, data: { confirmed: true, asked: "IMD()" } });
  });

  it("is not confirmed for an address with no contract, or one that answers with another token", async () => {
    const empty = testSources({ env: { HW_ADDR_WORK_ORDERS: DESK } });
    const nothing = await empty.sources.house.identity("workOrders");
    expect(nothing.live && nothing.data).toMatchObject({ confirmed: false });
    expect(nothing.live && nothing.data?.detail).toContain("did not answer IMD()");

    const other = testSources({
      env: { HW_ADDR_WORK_ORDERS: DESK },
      chain: { views: { [`${DESK}:IMD`]: { abi: identityAbi, result: EMPLOYER } } },
    });
    const wrong = await other.sources.house.identity("workOrders");
    expect(wrong.live && wrong.data).toMatchObject({ confirmed: false });
    expect(wrong.live && wrong.data?.detail).toContain("which is not the IMD token");
  });

  it("asks the checker for its registry and the report for its Questions contract", async () => {
    const world = testSources({
      env: { HW_ADDR_WORK_PROOF: WORK_PROOF, HW_ADDR_QUESTIONS: QUESTIONS, HW_ADDR_JOBS_REPORT: JOBS_REPORT },
      chain: {
        views: {
          [`${WORK_PROOF}:WORK_REGISTRY`]: { abi: identityAbi, result: MAINNET.WORK_REGISTRY },
          [`${JOBS_REPORT}:QUESTIONS`]: { abi: identityAbi, result: QUESTIONS },
          [`${QUESTIONS}:IMD`]: { abi: identityAbi, result: MAINNET.IMD },
        },
      },
    });
    const { house } = world.sources;
    expect((await house.identity("workProof")).live && (await house.identity("workProof"))).toMatchObject({
      data: { confirmed: true, asked: "WORK_REGISTRY()" },
    });
    expect(await house.identity("jobsReport")).toMatchObject({
      data: { confirmed: true, asked: "QUESTIONS()" },
    });
    expect(await house.identity("questions")).toMatchObject({ data: { confirmed: true, asked: "IMD()" } });
  });

  it("reports in /api/v1/status whether each configured address answers as its contract", async () => {
    const world = testSources({
      env: { HW_ADDR_WORK_ORDERS: DESK, HW_ADDR_CROWD_POTS: POTS },
      chain: { views: { [`${DESK}:IMD`]: { abi: identityAbi, result: MAINNET.IMD } } },
    });
    const response = await handleApi("status", new Request("https://help-wanted.test/x"), ctxFor(world));
    const body = (await response.json()) as {
      contracts: { contract: string; answersAsThatContract: boolean | null; detail: string }[];
    };
    expect(body.contracts).toHaveLength(2);
    expect(body.contracts.find((c) => c.contract === "WorkOrders")?.answersAsThatContract).toBe(true);
    const pots = body.contracts.find((c) => c.contract === "CrowdPots");
    expect(pots?.answersAsThatContract).toBe(false);
    expect(pots?.detail).toContain("did not answer IMD()");
  });
});

describe("the Doorbell says how its orders pay, and never guesses", () => {
  const BELL = "0x00000000000000000000000000000000000000b7";
  const terms = parseAbi(["function ALLOW_CLAIMED() view returns (bool)"]);
  const base: Views = {
    [`${BELL}:ringsUntilHire`]: { abi: doorbellAbi, result: 7n },
    [`${BELL}:funded`]: { abi: doorbellAbi, result: true },
  };

  it.each([
    [true, "a receipt, or a bonded delivery claim nobody challenges within 24 hours"],
    [false, "an on-chain receipt only"],
  ])("ALLOW_CLAIMED %s reads as: %s", async (allow, words) => {
    const world = testSources({
      env: { HW_ADDR_DOORBELL: BELL },
      chain: {
        views: { ...base, [`${BELL}:ALLOW_CLAIMED`]: { abi: terms, result: allow } },
        imdBalances: { [BELL]: 3n * IMD },
      },
    });
    const loaded = await loadPath("/rules/new", ctxFor(world, "/rules/new"));
    expect((loaded!.model as { doorbellState: unknown }).doorbellState).toMatchObject({
      ringsUntilHire: 7,
      funded: true,
      allowClaimed: allow,
      balanceWei: 3n * IMD,
    });
    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain("- 7 rings until the next hire.");
    expect(markdown).toContain("- It is funded: it holds 3 IMD, and the next 25th ring opens an order");
    expect(markdown).toContain(`- Its orders pay on ${words} (fixed when it was launched).`);
    // The limit of the claimed path is said beside a Doorbell that has it on, and only there.
    expect(markdown.includes("that is launch B's disclosed limit D2")).toBe(allow);
  });

  it("does not guess when the Doorbell does not say", async () => {
    const world = testSources({ env: { HW_ADDR_DOORBELL: BELL }, chain: { views: base } });
    const loaded = await loadPath("/rules/new", ctxFor(world, "/rules/new"));
    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain("Its orders pay on terms that could not be read just now");
    // The views this fake does not answer are said to be unread, one by one: no zero, no "no".
    expect(markdown).toContain(
      "How often it has been rung could not be read just now, and how often it has hired could not be read just now.",
    );
    expect(markdown).toContain("What its orders pay could not be read just now.");
    expect(markdown).not.toMatch(/0 hires|has hired nothing|has not been rung/);
  });

  it("a view that does not answer is never read as 'not funded'", async () => {
    const world = testSources({
      env: { HW_ADDR_DOORBELL: BELL },
      chain: { views: { [`${BELL}:ringsUntilHire`]: { abi: doorbellAbi, result: 25n } } },
    });
    const read = await world.sources.house.doorbell();
    expect(read.live && read.data).toMatchObject({ ringsUntilHire: 25, funded: null, rings: null });
    const markdown = markdownTwin((await loadPath("/rules/new", ctxFor(world, "/rules/new")))!);
    expect(markdown).toContain("Whether it is funded could not be read just now (funded() did not answer).");
    expect(markdown).not.toContain("It is not funded");
  });

  it("a Doorbell that is launched and does not answer is 'could not be read', not 'will be printed here'", async () => {
    const world = testSources({ env: { HW_ADDR_DOORBELL: BELL } });
    const loaded = await loadPath("/rules/new", ctxFor(world, "/rules/new"));
    const model = loaded!.model as { doorbellState: unknown; doorbellError: string | null };
    expect(model.doorbellState).toBeNull();
    expect(model.doorbellError).toContain("Doorbell.ringsUntilHire() did not answer");
    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain("**The Doorbell could not be read just now");
    expect(markdown).not.toContain("will be printed here");
    // And before it has an address the page says only what will be fixed at its launch.
    const before = markdownTwin((await loadPath("/rules/new", ctxFor(testSources(), "/rules/new")))!);
    expect(before).toContain("will be printed here");
    expect(before).toContain("It is not launched yet.");
    expect(before).not.toContain("could not be read just now**");
  });
});
