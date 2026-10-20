/**
 * Our ERC-8004 reviews: the two feedback files on the site, the record the site keeps of them
 * (`config/erc8004.ts`), the script that sends them (`scripts/feedback.sh`), and the seat pages that
 * read them back with IdentityMD's own reviews.
 *
 * The files are held to the spec's feedback file and to the history the site keeps of each order:
 * the x402 payment, the receipt and the settlement must be the very transactions `config/history.ts`
 * pins. Their bytes are hashed as they are on disk, which is what the site serves and what goes on
 * chain. The seat pages are loaded on the real book with the repository's fake chain, which answers
 * the registry as a test asks.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeEventTopics, keccak256, toFunctionSelector, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { DEPLOYMENT_BOOK, MAINNET } from "@help-wanted/shared";
import {
  DESK_REVIEWS,
  ERC8004,
  pinnedReviews,
  reputationRegistryAbi,
  type DeskReview,
} from "~/config/erc8004";
import { HOUSE_X402, ORDER_HISTORY, type PinnedOrder, type TrailKey } from "~/config/history";
import { HOUSE_WALLETS } from "~/config/house";
import { resolveDeployments } from "~/config/deployments";
import { loadPath, markdownTwin } from "~/lib/twins";
import type { SeatModel } from "~/models/money";
import { BANNED, BOOKS, ctxFor, testSources, TRANSFERS, type FakeChainOptions } from "./helpers";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PUBLIC = fileURLToPath(new URL("../public", import.meta.url));
const H1 = HOUSE_WALLETS[1]!.address;
const REGISTRY = ERC8004.reputationRegistry;
const ONE = DESK_REVIEWS.reviews[0]!;

function fileBytes(review: DeskReview): Uint8Array {
  return new Uint8Array(readFileSync(`${PUBLIC}${review.path}`));
}

function fileJson(review: DeskReview): Record<string, any> {
  return JSON.parse(new TextDecoder().decode(fileBytes(review)));
}

function orderOf(review: DeskReview): PinnedOrder {
  return ORDER_HISTORY.orders.find((o) => o.id === review.orderId)!;
}

function step(order: PinnedOrder, key: TrailKey) {
  return order.trail.find((s) => s.key === key)!;
}

describe("the feedback files", () => {
  it("are one per order on record, each for the agent its work record names", () => {
    expect(DESK_REVIEWS.workOrders).toBe(ORDER_HISTORY.workOrders);
    expect(DESK_REVIEWS.reviews.map((r) => r.orderId)).toEqual(ORDER_HISTORY.orders.map((o) => o.id));
    for (const review of DESK_REVIEWS.reviews) {
      const order = orderOf(review);
      expect(order.prove.agentIds).toEqual([review.agentId]);
      expect(order.tipClaims.map((c) => [c.agentId, c.tokenId])).toEqual([[review.agentId, review.tokenId]]);
    }
  });

  it("hash, byte for byte as the site serves them, to the feedbackHash the record keeps", () => {
    for (const review of DESK_REVIEWS.reviews) {
      expect(keccak256(fileBytes(review))).toBe(review.hash);
      expect(review.uri).toBe(`${ERC8004.origin}${review.path}`);
    }
  });

  it("carry every field ERC-8004 makes a must, in its format", () => {
    for (const review of DESK_REVIEWS.reviews) {
      const file = fileJson(review);
      expect(file.agentRegistry).toBe(`eip155:1:${ERC8004.identityRegistry.toLowerCase()}`);
      expect(file.agentId).toBe(Number(review.agentId));
      expect(file.clientAddress).toBe(`eip155:1:${review.client.toLowerCase()}`);
      expect(file.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(Number.isNaN(Date.parse(file.createdAt))).toBe(false);
      // A binary attestation, as the spec's "reachable": 1 with no decimals.
      expect(file.value).toBe(1);
      expect(file.valueDecimals).toBe(0);
      expect([file.tag1, file.tag2]).toEqual([ERC8004.tag1, ERC8004.tag2]);
      expect(file.endpoint).toBe(`https://explorer.imd.fun/jobs/${orderOf(review).jobId}`);
    }
  });

  it("prove payment with the order's own x402 payment, from H1 to IdentityMD's fee address", () => {
    for (const review of DESK_REVIEWS.reviews) {
      const file = fileJson(review);
      const order = orderOf(review);
      expect(review.client).toBe(H1);
      expect(file.proofOfPayment).toEqual({
        fromAddress: H1,
        toAddress: MAINNET.FEE_PAYEE,
        chainId: "1",
        txHash: review.paymentTx,
      });
      expect(step(order, "paid").tx.hash).toBe(review.paymentTx);
      const x402 = HOUSE_X402.payments.find((p) => p.tx.hash === review.paymentTx)!;
      expect(x402).toMatchObject({ payer: "H1", jobId: order.jobId });
      expect(file.helpwanted.payment.block).toBe(step(order, "paid").tx.block);
    }
  });

  it("name the receipt and the settlement the site pins, and say they are HOUSE and what was checked", () => {
    for (const review of DESK_REVIEWS.reviews) {
      const file = fileJson(review);
      const order = orderOf(review);
      const extra = file.helpwanted;
      expect(extra.label).toBe("HOUSE");
      expect(extra.order).toMatchObject({
        id: order.id,
        desk: `eip155:1:${ORDER_HISTORY.workOrders.toLowerCase()}`,
      });
      expect(extra.job).toEqual({
        id: order.jobId,
        url: `https://api.imd.fun/jobs/${order.jobId}`,
        seat: Number(review.tokenId),
      });
      expect(extra.receipt).toEqual({
        registry: `eip155:1:${MAINNET.WORK_REGISTRY.toLowerCase()}`,
        recordHash: order.prove.recordHash,
        txHash: step(order, "receipt").tx.hash,
        block: step(order, "receipt").tx.block,
      });
      expect(extra.settlement).toEqual({
        contract: `eip155:1:${ORDER_HISTORY.workOrders.toLowerCase()}`,
        txHash: review.settlementTx,
        block: step(order, "settled").tx.block,
      });
      expect(step(order, "settled").tx.hash).toBe(review.settlementTx);
      expect(extra.valueMeans).toContain("not a rating");
      expect(extra.notChecked).toContain("How good the work is");
      const text = new TextDecoder().decode(fileBytes(review));
      expect(text).not.toMatch(BANNED);
      expect(text).not.toContain("\u2014");
    }
  });

  it("are left alone by the formatter, so not one byte changes", () => {
    expect(readFileSync(fileURLToPath(new URL("../.prettierignore", import.meta.url)), "utf8")).toContain(
      "public/erc8004/",
    );
  });
});

describe("the registry's interface", () => {
  it("has the selectors and the event topic read from the deployed implementation", () => {
    const selector = (name: string) => {
      const item = reputationRegistryAbi.find((i) => i.type === "function" && i.name === name)!;
      return toFunctionSelector(item as never);
    };
    // As found in the bytecode of 0x16e0fa7f…da34, the registry's implementation, on 20 October 2026.
    expect(selector("giveFeedback")).toBe("0x3c036a7e");
    expect(selector("readAllFeedback")).toBe("0xd9d84224");
    expect(selector("getIdentityRegistry")).toBe("0xbc4d861b");
    expect(ERC8004.newFeedbackTopic).toBe(
      "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc",
    );
    expect(ERC8004.reputationRegistry).toBe(MAINNET.REPUTATION_REGISTRY);
    expect(ERC8004.identityRegistry).toBe(MAINNET.IDENTITY_REGISTRY);
  });
});

describe("scripts/feedback.sh", () => {
  const script = readFileSync(`${ROOT}scripts/feedback.sh`, "utf8");

  it("sends to the registry, files and site this record names", () => {
    expect(script).toContain(`REPUTATION=${MAINNET.REPUTATION_REGISTRY}`);
    expect(script).toContain(`IDENTITY=${MAINNET.IDENTITY_REGISTRY}`);
    expect(script).toContain(`SITE="\${SITE:-${ERC8004.origin}}"`);
    expect(script).toContain("apps/web/public/erc8004");
    expect(script).toContain('GIVE="giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)"');
    expect(script).toContain('RPC="${RPC:-https://rpc.mevblocker.io}"');
  });

  it("signs only through a cast keystore and stops on a pending transaction or a wrong signer", () => {
    expect(script).toContain('--account "$ACCOUNT"');
    expect(script).not.toMatch(/private[-_]key|PRIVATE_KEY|mnemonic/i);
    expect(script).toContain("--block pending");
    expect(script).toContain("use the keystore that holds H1");
    expect(script).not.toMatch(BANNED);
    expect(script).not.toContain("\u2014");
  });
});

// ---------------------------------------------------------------------------------------------
// The seat pages
// ---------------------------------------------------------------------------------------------

type Views = NonNullable<FakeChainOptions["views"]>;
type Feedback = {
  client: string;
  index: bigint;
  value: bigint;
  tag1: string;
  tag2: string;
  revoked?: boolean;
};

/** The registry as a test sets it: the entries each client has given each agent. */
function registry(entries: Record<string, Feedback[]>): Views {
  return {
    [`${REGISTRY}:readAllFeedback`]: {
      abi: reputationRegistryAbi as never,
      result: (args: readonly unknown[]) => {
        const [agentId, clients, tag1, tag2, includeRevoked] = args as [
          bigint,
          string[],
          string,
          string,
          boolean,
        ];
        const rows = (entries[agentId.toString()] ?? []).filter(
          (f) =>
            clients.some((c) => c.toLowerCase() === f.client.toLowerCase()) &&
            (tag1 === "" || f.tag1 === tag1) &&
            (tag2 === "" || f.tag2 === tag2) &&
            (includeRevoked || !f.revoked),
        );
        return [
          rows.map((f) => f.client),
          rows.map((f) => f.index),
          rows.map((f) => f.value),
          rows.map(() => 0),
          rows.map((f) => f.tag1),
          rows.map((f) => f.tag2),
          rows.map((f) => f.revoked ?? false),
        ];
      },
    },
  };
}

/** IdentityMD's reviews of agent 51519 as the registry held them on 20 October 2026, in short: three of them. */
const IMD_REVIEWS: Feedback[] = [
  {
    client: MAINNET.WORK_REGISTRY,
    index: 1n,
    value: 1n,
    tag1: "verification:structural",
    tag2: "acceptance-v2",
  },
  {
    client: MAINNET.WORK_REGISTRY,
    index: 2n,
    value: 1n,
    tag1: "verification:structural",
    tag2: "acceptance-v2",
  },
  { client: MAINNET.WORK_REGISTRY, index: 3n, value: 0n, tag1: "verification:checks", tag2: "acceptance-v2" },
];

const OURS: Feedback = { client: H1, index: 1n, value: 1n, tag1: ERC8004.tag1, tag2: ERC8004.tag2 };

/** The `NewFeedback` log of our review of agent 51519, in a block the RPC still serves. */
function newFeedbackLog(review: DeskReview, overrides: { uri?: string; hash?: Hex } = {}) {
  const topics = encodeEventTopics({
    abi: reputationRegistryAbi,
    eventName: "NewFeedback",
    args: { agentId: BigInt(review.agentId), clientAddress: review.client, indexedTag1: ERC8004.tag1 },
  });
  const data = encodeAbiParameters(
    [
      { type: "uint64" },
      { type: "int128" },
      { type: "uint8" },
      { type: "string" },
      { type: "string" },
      { type: "string" },
      { type: "string" },
      { type: "bytes32" },
    ],
    [
      1n,
      1n,
      0,
      ERC8004.tag1,
      ERC8004.tag2,
      `https://explorer.imd.fun/jobs/${orderOf(review).jobId}`,
      overrides.uri ?? review.uri,
      overrides.hash ?? review.hash,
    ],
  );
  return {
    address: REGISTRY.toLowerCase(),
    topics: topics as string[],
    data,
    blockNumber: `0x${(TRANSFERS.toBlock - 5).toString(16)}`,
    transactionHash: `0x${"fb".repeat(32)}`,
    logIndex: "0x0",
  };
}

function world(views: Views, logs: ReturnType<typeof newFeedbackLog>[] = []) {
  return testSources({ book: DEPLOYMENT_BOOK, chain: { views, logs: { [REGISTRY]: logs } } });
}

async function seat(w: ReturnType<typeof testSources>, tokenId = 1049) {
  const path = `/seats/${tokenId}`;
  const loaded = (await loadPath(path, ctxFor(w, path)))!;
  return { model: loaded.model as SeatModel, markdown: markdownTwin(loaded) };
}

describe("the seat page's reviews", () => {
  it("show IdentityMD's first, then say ours are none yet while the registry holds none", async () => {
    const { model, markdown } = await seat(world(registry({ "51519": IMD_REVIEWS })));
    expect(model.reviews?.imd).toEqual([
      {
        agentId: "51519",
        total: 3,
        categories: [
          { category: "verification:structural", count: 2, accepted: 2 },
          { category: "verification:checks", count: 1, accepted: 0 },
        ],
        error: null,
      },
    ]);
    expect(model.reviews?.ours).toEqual({
      entries: [],
      waiting: [{ orderId: 1, agentId: "51519", fileUrl: "/erc8004/feedback-order-1.json" }],
      error: null,
    });
    expect(markdown).toContain("## Reviews on ERC-8004");
    expect(markdown).toContain("IdentityMD has given agent 51519 3 reviews, 2 with value 1.");
    expect(markdown).toContain("| verification:structural | 2 | 2 |");
    expect(markdown).toContain("None yet.");
    expect(markdown).toContain(
      "Order 1's review of agent 51519 is written and not sent yet. [Feedback file](/erc8004/feedback-order-1.json).",
    );
    expect(markdown.indexOf("### IdentityMD's")).toBeLessThan(markdown.indexOf("### Ours"));
    // Each kind is read from its own client only; one printed command reads both clients.
    const reads = model.commands.filter((c) => c.command.includes("readAllFeedback"));
    expect(reads).toEqual([
      {
        comment:
          "Agent 51519's reviews from IdentityMD's WorkRegistry and from the wallet that paid for order 1's job, revoked ones too.",
        command: `cast call ${REGISTRY} "readAllFeedback(uint256,address[],string,string,bool)(address[],uint64[],int128[],uint8[],string[],string[],bool[])" 51519 "[${MAINNET.WORK_REGISTRY},${H1}]" "" "" true --rpc-url https://ethereum-rpc.publicnode.com`,
      },
    ]);
    expect(model.sources.map((s) => s.name)).toContain("ERC-8004 reviews");
  });

  it("list ours once sent, labelled HOUSE, with the file its log names checked against the record", async () => {
    const { model, markdown } = await seat(
      world(registry({ "51519": [...IMD_REVIEWS, OURS] }), [newFeedbackLog(ONE)]),
    );
    expect(model.reviews?.ours?.waiting).toEqual([]);
    expect(model.reviews?.ours?.entries).toEqual([
      {
        orderId: 1,
        agentId: "51519",
        client: H1,
        clientName: "H1",
        origin: "HOUSE",
        index: 1,
        value: "1",
        tags: "paid-on-receipt, helpwanted",
        revoked: false,
        fileUrl: "/erc8004/feedback-order-1.json",
        paymentTxUrl: `https://etherscan.io/tx/${ONE.paymentTx}`,
        settlementTxUrl: `https://etherscan.io/tx/${ONE.settlementTx}`,
        log: { txUrl: `https://etherscan.io/tx/0x${"fb".repeat(32)}`, matches: true },
      },
    ]);
    // IdentityMD's reviews are not counted as ours, and ours are not counted as IdentityMD's.
    expect(model.reviews?.imd[0]?.total).toBe(3);
    expect(markdown).toContain(
      "HOUSE: Order 1, agent 51519: value 1 (paid-on-receipt, helpwanted), entry 1 from H1, the wallet that paid for the job. Its NewFeedback log names this feedback file and its keccak256.",
    );
    expect(markdown).not.toContain("None yet.");
  });

  it("say when the log names another file, and when the log is out of the RPC's reach", async () => {
    const other = await seat(
      world(registry({ "51519": [OURS] }), [newFeedbackLog(ONE, { hash: `0x${"00".repeat(32)}` })]),
    );
    expect(other.model.reviews?.ours?.entries[0]?.log?.matches).toBe(false);
    expect(other.markdown).toContain("Its NewFeedback log names another file.");
    const old = await seat(world(registry({ "51519": [{ ...OURS, revoked: true }] })));
    expect(old.model.reviews?.ours?.entries[0]).toMatchObject({ revoked: true, log: null });
    expect(old.markdown).toContain("Revoked by its client.");
    expect(old.markdown).toContain("is older than the RPC serves, so the file it names is not checked here");
    expect(old.model.reviews?.imd[0]).toMatchObject({ total: 0, error: null });
    expect(old.markdown).toContain("IdentityMD has given agent 51519 no review yet.");
  });

  it("say the registry could not be read, and claim nothing is waiting, when it does not answer", async () => {
    const { model, markdown } = await seat(world({}));
    expect(model.reviews?.imd[0]?.error).toBeTruthy();
    expect(model.reviews?.ours).toMatchObject({ entries: [], waiting: [] });
    expect(model.reviews?.ours?.error).toBeTruthy();
    expect(markdown).toContain("IdentityMD's reviews of agent 51519 could not be read just now");
    expect(markdown).toContain("Our reviews could not be read just now");
    expect(markdown).not.toContain("None yet.");
  });

  it("borrow nothing in a book whose desk is not mainnet's, and show nothing for a seat with no known agent", async () => {
    expect(
      pinnedReviews(resolveDeployments({}, BOOKS.aAndB).contracts.workOrders.address, ["51519"]),
    ).toEqual([]);
    expect(pinnedReviews(ORDER_HISTORY.workOrders, ["52211"])).toEqual([]);
    const standIn = testSources({ book: BOOKS.aAndB, chain: { views: registry({ "51519": IMD_REVIEWS }) } });
    const { model } = await seat(standIn);
    expect(model.reviews?.ours).toBeNull();
    expect(model.reviews?.imd[0]?.total).toBe(3);
    const none = await seat(world(registry({})), 7);
    expect(none.model.reviews).toBeNull();
    expect(none.markdown).not.toContain("Reviews on ERC-8004");
  });
});
