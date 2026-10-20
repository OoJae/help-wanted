/**
 * Ringing the Doorbell, as the site offers it: the band under the front page's hero, the one-step
 * section on /rules/new#doorbell (the wallet form, the EIP-681 link and its QR code, the gas one ring
 * costs, the next hire said plainly, who rang), and the heartbeat of the team's hosted runner on
 * /runners. Played on mainnet's own book against a mocked chain, the figures as mainnet had them
 * on 20 October 2026: 25 rings, all from house wallet H1, one hire, 25 rings from the next.
 */
import { encodeAbiParameters, encodeEventTopics, type AbiEvent, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { DEPLOYMENT_BOOK, doorbellAbi, workOrdersAbi } from "@help-wanted/shared";
import { resolveDeployments } from "~/config/deployments";
import { ORDER_HISTORY } from "~/config/history";
import { HOUSE_WALLETS } from "~/config/house";
import { RpcChainSource } from "~/data/chain";
import { ChainHouseSource } from "~/data/house";
import type { EthReader, RawLog } from "~/lib/jsonrpc";
import { loadPath, markdownTwin } from "~/lib/twins";
import type { RunnersModel } from "~/models/desk";
import type { RulesNewModel } from "~/models/money";
import type { WireModel } from "~/models/wire";
import { BOOKS, ctxFor, fakeChain, testSources, type FakeChainOptions, type TestWorld } from "./helpers";

const IMD = 10n ** 18n;
const H1 = HOUSE_WALLETS[1]!.address;
const BOOK = resolveDeployments({}, DEPLOYMENT_BOOK).contracts;
const BELL = BOOK.doorbell.address as string;
const DESK = BOOK.workOrders.address as string;
const OUTSIDER = "0x00000000000000000000000000000000000a11ce";
const OUTSIDER_SUM = "0x00000000000000000000000000000000000A11cE";
const HEAD = 26_230_000;
const SECOND = ORDER_HISTORY.orders[1]!;
/** A page made on 20 October 2026, the day the campaign began. */
const TODAY = new Date("2026-10-20T12:00:00Z");

type Views = NonNullable<FakeChainOptions["views"]>;

/** The Doorbell's views on 20 October 2026, with what the test changes. */
function bell(o: { rings?: number; until?: number; funded?: boolean } = {}): Views {
  return {
    [`${BELL}:ringsUntilHire`]: { abi: doorbellAbi, result: BigInt(o.until ?? 25) },
    [`${BELL}:funded`]: { abi: doorbellAbi, result: o.funded ?? false },
    [`${BELL}:ALLOW_CLAIMED`]: { abi: doorbellAbi, result: true },
    [`${BELL}:rings`]: { abi: doorbellAbi, result: BigInt(o.rings ?? 25) },
    [`${BELL}:hires`]: { abi: doorbellAbi, result: 1n },
    [`${BELL}:receipts`]: { abi: doorbellAbi, result: 1n },
    [`${BELL}:lastOrderId`]: { abi: doorbellAbi, result: 1n },
    [`${BELL}:MIN_PAY`]: { abi: doorbellAbi, result: IMD },
    [`${BELL}:MAX_PAY`]: { abi: doorbellAbi, result: IMD },
    [`${BELL}:BOND`]: { abi: doorbellAbi, result: IMD / 4n },
    [`${BELL}:DELIVERY_SECS`]: { abi: doorbellAbi, result: 604_800 },
  };
}

/** A log of one of our contracts' events, encoded with the shared package's ABI. */
function eventLog(
  abi: readonly unknown[],
  address: string,
  eventName: string,
  args: Record<string, unknown>,
  block: number,
  n: number,
): RawLog {
  const event = (abi as AbiEvent[]).find((item) => item.type === "event" && item.name === eventName)!;
  const unindexed = event.inputs.filter((input) => !input.indexed);
  return {
    address: address.toLowerCase(),
    topics: encodeEventTopics({ abi: [event], eventName, args } as never) as string[],
    data: encodeAbiParameters(
      unindexed,
      unindexed.map((input) => args[input.name!]),
    ),
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: `0x${n.toString(16).padStart(64, "0")}`,
    logIndex: "0x0",
  };
}

const rang = (ringer: string, count: number, block: number) =>
  eventLog(doorbellAbi, BELL, "Rang", { ringer, count: BigInt(count) }, block, 1000 + count);

function world(
  options: { views?: Views; gas?: boolean; logs?: Record<string, RawLog[]>; funded?: boolean } = {},
) {
  return testSources({
    book: DEPLOYMENT_BOOK,
    chain: {
      head: HEAD,
      views: { ...bell(), ...options.views },
      imdBalances: { [BELL]: options.funded ? IMD : 0n },
      logs: options.logs,
      ...(options.gas === false ? {} : { gas: { estimate: 28_788n, priceWei: 75_445_729n } }),
    },
  });
}

async function page<M>(w: TestWorld, path: string) {
  const loaded = (await loadPath(path, { ...ctxFor(w, path), now: TODAY }))!;
  return { model: loaded.model as M, markdown: markdownTwin(loaded) };
}

describe("/rules/new#doorbell: ringing in one step", () => {
  it("offers the wallet form, the EIP-681 link as a QR code, the gas of one ring and the next hire", async () => {
    const { model, markdown } = await page<RulesNewModel>(world(), "/rules/new");
    expect(model.ringFlow.id).toBe("ring");
    expect(model.ringPhone).toEqual({
      url: "ethereum:0xFd5ab7E03E8554210Faa3cCd3b9D47C622fffcCb@1/ring",
      words:
        "Open the link in a wallet app on your phone, or scan the code with one. It asks your wallet to call ring() on the Doorbell on Ethereum mainnet; you pay only the gas.",
      key: "Open in a wallet",
      note: "The link is an EIP-681 request. A wallet that does not read one may open nothing: open this page in the wallet's own browser and use the key above instead.",
      qrLabel: "QR code of the link ethereum:0xFd5ab7E03E8554210Faa3cCd3b9D47C622fffcCb@1/ring",
    });
    // 28,788 gas at 75,445,729 wei a unit is 0.00000217 ETH; said as an estimate, to two figures.
    expect(model.ringCost).toBe(
      "One ring costs about 0.0000022 ETH in gas now. That is an estimate: 28,788 gas (estimateGas of ring()) at 0.075 gwei (the network's gas price), read for this page. A ring sends no ETH and no IMD.",
    );
    expect(model.doorbellNext).toBe(
      "The 50th ring hires the swarm for a picture of the day only if the Doorbell holds 1 IMD by then, paid from its own IMD; it does not hold it now. The order pays its runner on proof, the job's receipt on chain, or on a bonded delivery claim nobody challenges for 24 hours, the path a runner takes while IdentityMD's receipts are late.",
    );
    expect(model.sources.map((s) => s.name)).toContain("Gas for one ring");
    // Every sentence the section prints is in its twin, in the page's order.
    const at = (text: string) => {
      const index = markdown.indexOf(text);
      expect(index, text).toBeGreaterThan(-1);
      return index;
    };
    const order = [
      at(`${model.doorbellIntro} It is at [${BELL}]`),
      at(`**${model.doorbellNext}**`),
      at(model.ringCost!),
      at("### Ring the Doorbell"),
      at(`### On a phone\n\n${model.ringPhone!.words}`),
      at(`Open in a wallet: [${model.ringPhone!.url}](${model.ringPhone!.url})`),
      at(model.ringPhone!.note),
      at("### Where it stands"),
      at("### Who rang"),
      at(`${model.doorbellLimits} ([/judges#limit-B-D1](/judges#limit-B-D1))`),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const fact of model.doorbellFacts) at(fact);
  });

  it("says when the next ring is the one that hires, and when the Doorbell is funded", async () => {
    const { model } = await page<RulesNewModel>(
      world({ views: bell({ rings: 49, until: 1, funded: true }), funded: true }),
      "/rules/new",
    );
    expect(model.doorbellNext).toBe(
      "The 50th ring hires the swarm for a picture of the day: it opens an order on the hire desk and escrows 1 IMD of the Doorbell's own IMD. The order pays its runner on proof, the job's receipt on chain, or on a bonded delivery claim nobody challenges for 24 hours, the path a runner takes while IdentityMD's receipts are late.",
    );
    expect(model.ringCost).toContain(
      "The next ring is the one that hires, so it uses more gas than an ordinary ring.",
    );
  });

  it("says the gas could not be estimated, never a made-up cost, on an RPC that cannot estimate", async () => {
    const { model, markdown } = await page<RulesNewModel>(world({ gas: false }), "/rules/new");
    expect(model.ringCost).toBe("What a ring costs in gas could not be estimated just now.");
    expect(markdown).toContain(model.ringCost!);
    expect(markdown).not.toMatch(/costs about [\d.]+ ETH/);
  });

  it("lists the newest outside ringers once each, newest first, with their transactions", async () => {
    const logs = [rang(OUTSIDER, 26, HEAD - 300), rang(H1, 27, HEAD - 200), rang(OUTSIDER, 28, HEAD - 100)];
    const { model, markdown } = await page<RulesNewModel>(
      world({ views: bell({ rings: 28, until: 22 }), logs: { [BELL]: logs } }),
      "/rules/new",
    );
    expect(model.doorbellWho?.words).toContain(
      "26 were sent by our own wallets (HOUSE) and 2 by others (OUTSIDE).",
    );
    expect(model.doorbellWho?.listWords).toBe("The newest ringer from outside the team:");
    expect(model.doorbellWho?.outside).toEqual([
      {
        address: OUTSIDER_SUM,
        short: "0x0000…11cE",
        url: `https://etherscan.io/address/${OUTSIDER_SUM}`,
        ring: 28,
        rings: 2,
        txUrl: `https://etherscan.io/tx/0x${(1028).toString(16).padStart(64, "0")}`,
        words: "0x0000…11cE rang ring 28, the newest of its 2 rings",
      },
    ]);
    expect(markdown).toContain(
      `- [0x0000…11cE](https://etherscan.io/address/${OUTSIDER_SUM}) rang ring 28, the newest of its 2 rings ([its transaction](https://etherscan.io/tx/0x${(1028).toString(16).padStart(64, "0")}))`,
    );
  });

  it("says nothing of ringing before the Doorbell is launched", async () => {
    const loaded = (await loadPath("/rules/new", ctxFor(testSources())))!;
    const model = loaded.model as RulesNewModel;
    expect(model.ringPhone).toBeNull();
    expect(model.ringCost).toBeNull();
    expect(model.doorbellNext).toBeNull();
    expect(model.doorbellWho).toBeNull();
    expect(markdownTwin(loaded)).not.toContain("ethereum:");
  });
});

describe("the front page's band", () => {
  it("says what the Doorbell is, where it stands and who rang, and keys to /rules/new#doorbell", async () => {
    const { model, markdown } = await page<WireModel>(world({ views: bell(), funded: false }), "/");
    const band = model.actions.ring.doorbell!;
    expect(band.what).toBe(
      "The Doorbell is a contract with no owner. Anyone may ring it for the gas alone, and every 25th ring hires the swarm for a picture of the day, paid from the Doorbell's own IMD.",
    );
    expect(band.count).toBe(
      "0 of 25 rings toward its next hire. Not funded: it holds 0 IMD and a hire needs 1 IMD, so a 25th ring now would hire nothing.",
    );
    expect(band.key).toEqual({ label: "Ring the Doorbell", path: "/rules/new#doorbell" });
    expect(markdown).toContain(`## The Doorbell\n\n${band.what} ${band.count}`);

    const funded = await page<WireModel>(world({ views: bell({ funded: true }), funded: true }), "/");
    expect(funded.model.actions.ring.doorbell?.count).toBe(
      "0 of 25 rings toward its next hire. Funded: it holds 1 IMD, so the 50th ring opens an order.",
    );
  });

  it("says when some rings' logs were older than the server could read, and leaves them unsplit", async () => {
    const { model } = await page<WireModel>(world({ views: bell({ rings: 30, until: 20 }) }), "/");
    const band = model.actions.ring.doorbell!;
    expect(band.split).toEqual({ read: 25, house: 25, outside: 0 });
    expect(band.splitWords).toBe(
      "Counted from the Rang log of each of the 25 rings read, which names who rang: HOUSE is the team's own wallets, OUTSIDE is anyone else. The logs of 5 other rings are older than this server could read, so they are not counted here.",
    );
  });
});

describe("rings outlive the RPC's log window", () => {
  it("keeps counting a ring this server read once its block has left the window", async () => {
    let head = HEAD;
    let now = Date.parse("2026-10-20T12:00:00Z");
    const fake = fakeChain({
      head: HEAD,
      views: bell({ rings: 26, until: 24 }),
      logs: { [BELL]: [rang(OUTSIDER, 26, HEAD - 100)] },
    });
    const reader: EthReader = { ...fake.reader, blockNumber: async () => BigInt(head) };
    const chain = new RpcChainSource({
      reader,
      rpcHost: "rpc.test",
      logWindowBlocks: 7200,
      tallyDays: 14,
      now: () => now,
    });
    const house = new ChainHouseSource(chain, resolveDeployments({}, DEPLOYMENT_BOOK));
    const ringersNow = async () => {
      const read = await house.doorbell();
      return read.live && read.data ? read.data.ringers : null;
    };
    expect(await ringersNow()).toMatchObject({ read: 26, recent: [{ ringer: OUTSIDER, count: 26 }] });
    // A day later the ring's block is out of the window the node serves; the count still holds it.
    head += 8000;
    now += 10 * 60_000;
    const later = await ringersNow();
    expect(later).toMatchObject({ read: 26, toBlock: head, recent: [{ ringer: OUTSIDER, count: 26 }] });
    expect(later?.byRinger).toContainEqual({ ringer: OUTSIDER, rings: 1 });
  });
});

describe("/runners: the hosted runner's heartbeat", () => {
  const claimed = (id: number, runner: string, block: number) =>
    eventLog(
      workOrdersAbi,
      DESK,
      "Claimed",
      { id: BigInt(id), runner, seq: 1n, price: IMD, bond: IMD / 4n, ticket: `0x${"ab".repeat(32)}` as Hex },
      block,
      2000 + (block % 1000),
    );
  const registered = (id: number, block: number) =>
    eventLog(
      workOrdersAbi,
      DESK,
      "Registered",
      { id: BigInt(id), jobId: `0x${"cd".repeat(16)}` as Hex },
      block,
      3000 + (block % 1000),
    );
  /** The desk with order 2 on it, its claim as the desk keeps it: taken and registered by H1 on 16 October. */
  const desk: Views = {
    [`${DESK}:orderCount`]: { abi: workOrdersAbi, result: 2n },
    [`${DESK}:accountOf`]: { abi: workOrdersAbi, result: [6, BELL, 0n, IMD, 0n] },
    [`${DESK}:claimOf`]: {
      abi: workOrdersAbi,
      result: {
        runner: H1,
        claimedAt: 1_792_146_635,
        registeredAt: 1_792_146_959,
        price: IMD,
        jobId: "0x42f26c64eea946f2822a33547ec18abf",
        challenger: "0x0000000000000000000000000000000000000000",
        assertedAt: 0,
        recordHash: SECOND.prove.recordHash,
      },
    },
  };

  it("falls back to the history kept with the site when the logs read live hold nothing of H1's", async () => {
    const { model, markdown } = await page<RunnersModel>(world({ views: desk }), "/runners");
    const beat = model.heartbeat!;
    expect(beat.seenAt).toBe("16 Oct 2026, 10:37 UTC");
    expect(beat.seenAgo).toBe("4 d ago");
    expect(beat.seenNote).toBe("paid for order 2, 4 d ago");
    expect(beat.words).toBe(
      "Delivered on order 2, block 26,204,543, from the history kept with this site: nothing newer of H1's is in the desk's logs of the newest 7,200 blocks or in its record of its orders.",
    );
    expect(beat.tx).toEqual({
      label: "the transaction",
      url: `https://etherscan.io/tx/${SECOND.trail.find((s) => s.key === "settled")!.tx.hash}`,
    });
    // What it serves today, plainly: the team's statement, said to be one.
    expect(beat.serves).toEqual([
      { value: "skill:research-report, skill:create-image", label: "kinds it takes: reports, pictures" },
      { value: "1", label: "order at a time" },
      { value: "1", label: "swarm fee per UTC day", note: "at most; 0.5 IMD each" },
    ]);
    expect(beat.servesNote).toBe(
      "The last three figures are the team's statement of 16 October 2026, not a reading.",
    );
    expect(markdown).toContain("## The team's runner, now");
    expect(markdown).toContain(
      "| 16 Oct 2026, 10:37 UTC | last seen on the desk (paid for order 2, 4 d ago) |",
    );
    expect(markdown).toContain(
      "| skill:research-report, skill:create-image | kinds it takes: reports, pictures |",
    );
    expect(markdown).toContain("| 1 | swarm fee per UTC day (at most; 0.5 IMD each) |");
    expect(markdown).toContain(`${beat.words} [The transaction](${beat.tx!.url}).`);
    expect(markdown).toContain(beat.servesNote!);
  });

  it("reads a newer event live from the desk's logs, and gives a holder's Registered to the holder", async () => {
    const logs = { [DESK]: [claimed(3, H1, HEAD - 400), registered(3, HEAD - 300)] };
    const { model } = await page<RunnersModel>(world({ views: desk, logs }), "/runners");
    expect(model.heartbeat?.words).toBe(
      `Registered on order 3, block ${(HEAD - 300).toLocaleString("en-US")}, read live from the desk's logs.`,
    );
    expect(model.heartbeat?.seenNote).toMatch(/^registered order 3's job, /);
    expect(model.heartbeat?.tx?.url).toBe(
      `https://etherscan.io/tx/0x${(3000 + ((HEAD - 300) % 1000)).toString(16).padStart(64, "0")}`,
    );
    // Another runner's claim is not H1's heartbeat, and neither is what follows it on that order.
    const theirs = {
      [DESK]: [claimed(3, H1, HEAD - 400), claimed(4, OUTSIDER, HEAD - 50), registered(4, HEAD - 40)],
    };
    const other = await page<RunnersModel>(world({ views: desk, logs: theirs }), "/runners");
    expect(other.model.heartbeat?.words).toBe(
      `Claimed on order 3, block ${(HEAD - 400).toLocaleString("en-US")}, read live from the desk's logs.`,
    );
  });

  it("states what it serves only for mainnet's desk, and has no heartbeat before the desk is launched", async () => {
    const fork = testSources({ book: BOOKS.aAndB, chain: { head: HEAD } });
    const { model } = await page<RunnersModel>(fork, "/runners");
    expect(model.heartbeat?.serves).toEqual([]);
    expect(model.heartbeat?.servesNote).toBeNull();
    expect(model.heartbeat?.seenAt).toBeNull();
    expect(model.heartbeat?.words).toBe(
      `No event of house wallet H1 was found on the desk: none in its logs over the newest 7,200 blocks this server reads (blocks ${(HEAD - 7199).toLocaleString("en-US")} to ${HEAD.toLocaleString("en-US")}); the desk's record of its orders could not be read just now.`,
    );
    const none = await page<RunnersModel>(testSources(), "/runners");
    expect(none.model.heartbeat).toBeNull();
    expect(none.markdown).not.toContain("## The team's runner, now");
  });
});
