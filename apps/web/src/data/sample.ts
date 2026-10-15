/**
 * Made-up orders and pots, for design work only.
 *
 * This module is used only when the process is started with `HW_SAMPLE_DATA=1`, and then every page
 * carries a SAMPLE DATA banner and every sample item is marked. Nothing here is ever mixed into a
 * count, a tally or a twin without that mark. The addresses are obviously artificial on purpose.
 */
import type { Hex } from "viem";
import { kindHash, specHash } from "@help-wanted/shared";
import type { HouseSource, Live, Order, OrderBook, Pot, PotBook } from "./house";

const IMD = 10n ** 18n;
const A = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(20)}`;
const H = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}` as Hex;

function order(
  id: number,
  state: Order["state"],
  kind: string,
  spec: string,
  pay: bigint,
  extra: { proven?: boolean; jobId?: string; cond?: boolean; spent?: bigint; returned?: bigint } = {},
): Order {
  const now = Math.floor(Date.now() / 1000);
  const open = state === "Open" || state === "Claimed" || state === "Registered" || state === "Asserted";
  return {
    id,
    state,
    employer: A(0xa0 + id),
    escrowWei: open ? pay : 0n,
    spentWei: extra.spent ?? (state === "Delivered" ? pay : 0n),
    returnedWei: extra.returned ?? (state === "Refunded" || state === "Cancelled" ? pay : 0n),
    terms: {
      kindHash: kindHash(kind),
      specHash: specHash(spec),
      minPayWei: (pay * 2n) / 3n,
      maxPayWei: pay,
      rampSecs: 3600,
      rampFrom: extra.cond ? 0 : now - 1800,
      deliverySecs: 259_200,
      expiresAt: now + 5 * 86_400,
      bondWei: IMD / 4n,
      flags: 1,
      runnerOnly: null,
      arbiter: null,
      condTarget: extra.cond ? A(0xc0) : null,
      condSelector: extra.cond ? "0x18160ddd" : null,
      condCmp: extra.cond ? 1 : 0,
      condThreshold: extra.cond ? 1_000_000n * IMD : 0n,
      condMet: false,
      proven: extra.proven ?? false,
      claims: state === "Open" ? 0 : 1,
    },
    claim:
      state === "Open" || state === "Cancelled"
        ? null
        : {
            runner: A(0xb1),
            claimedAt: now - 7200,
            registeredAt: state === "Claimed" ? 0 : now - 7000,
            priceWei: pay,
            jobId: extra.jobId ?? null,
            challenger: null,
            assertedAt: state === "Asserted" ? now - 600 : 0,
            recordHash: state === "Delivered" || state === "Asserted" ? H(0xd0 + id) : null,
          },
    spec,
    sample: true,
  };
}

const ORDERS: Order[] = [
  order(
    8,
    "Open",
    "audit",
    "Audit the smart contracts in this repository at the given commit and report every defect you find, most serious first. Inputs: repoUrl=https://github.com/example/vault; baseCommit=0123456789abcdef0123456789abcdef01234567",
    3n * IMD,
  ),
  order(
    7,
    "Open",
    "skill:create-image",
    "A square picture of a brass doorbell beside a blue front door, morning light, no text.",
    2n * IMD,
    { cond: true },
  ),
  order(
    6,
    "Registered",
    "skill:research-report",
    "Compare the fee models of the three largest on-chain job escrows and say which suits a small DAO.",
    2n * IMD,
    { jobId: "00000000-0000-4000-8000-000000000006" },
  ),
  order(
    5,
    "Asserted",
    "skill:create-video",
    "A 30-second explainer of how a contract hires a robot, in the style of a newsreel.",
    3n * IMD,
    { jobId: "00000000-0000-4000-8000-000000000005" },
  ),
  order(
    4,
    "Delivered",
    "skill:research-report",
    "Write a plain-language summary of how sIMD staking yield is produced.",
    2n * IMD,
    { proven: true, jobId: "00000000-0000-4000-8000-000000000004" },
  ),
  order(3, "Delivered", "skill:create-image", "Draw the doorbell of the day.", (3n * IMD) / 2n, {
    proven: false,
    jobId: "00000000-0000-4000-8000-000000000003",
  }),
  order(
    2,
    "Refunded",
    "audit",
    "Audit the contracts in this repository. Inputs: repoUrl=https://github.com/example/pool; baseCommit=89abcdef0123456789abcdef0123456789abcdef",
    3n * IMD,
  ),
  order(1, "Cancelled", "skill:research-report", "Is the moon made of cheese? Cite sources.", IMD),
];

const POT_TERMS = {
  minPayWei: IMD,
  bondWei: IMD / 4n,
  deliverySecs: 259_200,
  hireSecs: 604_800,
  seriesId: 0,
};

const POTS: Pot[] = [
  {
    id: 3,
    stage: "Funding",
    remainingWei: (3n * IMD) / 2n,
    targetWei: 3n * IMD,
    raisedWei: (3n * IMD) / 2n,
    deadline: Math.floor(Date.now() / 1000) + 40_000,
    kindHash: kindHash("audit"),
    kind: "audit",
    specHash: H(0xe3),
    opener: A(0xa9),
    orderId: null,
    allowClaimed: true,
    ...POT_TERMS,
    spec: "Audit the smart contracts in this repository at the given commit and report every defect you find, most serious first. Inputs: repoUrl=https://github.com/example/vault; baseCommit=0123456789abcdef0123456789abcdef01234567",
    sample: true,
  },
  {
    id: 2,
    stage: "Delivered",
    remainingWei: 0n,
    targetWei: 2n * IMD,
    raisedWei: 2n * IMD,
    deadline: Math.floor(Date.now() / 1000) - 90_000,
    kindHash: kindHash("skill:create-image"),
    kind: "skill:create-image",
    specHash: H(0xe2),
    opener: A(0xa8),
    orderId: 3,
    allowClaimed: true,
    ...POT_TERMS,
    spec: "Draw the doorbell of the day.",
    sample: true,
  },
  {
    id: 1,
    stage: "Refundable",
    remainingWei: 0n,
    targetWei: 2n * IMD,
    raisedWei: IMD / 2n,
    deadline: Math.floor(Date.now() / 1000) - 200_000,
    kindHash: kindHash("skill:create-video"),
    kind: "skill:create-video",
    specHash: H(0xe1),
    opener: A(0xa7),
    orderId: null,
    allowClaimed: false,
    ...POT_TERMS,
    spec: null,
    sample: true,
  },
];

function live<T>(contract: "workOrders" | "crowdPots", data: T): Live<T> {
  return {
    live: true,
    contract,
    address: A(0xee),
    data,
    fetchedAt: Date.now(),
    stale: false,
    error: null,
    sample: true,
  };
}

/** Wraps the real source: orders and pots are replaced by the samples, everything else passes through. */
export function withSampleData(real: HouseSource): HouseSource {
  return {
    orders: async (limit = 30): Promise<Live<OrderBook>> =>
      live("workOrders", { count: ORDERS.length, orders: ORDERS.slice(0, limit) }),
    order: async (id): Promise<Live<Order | null>> =>
      live("workOrders", ORDERS.find((o) => o.id === id) ?? null),
    pots: async (limit = 30): Promise<Live<PotBook>> =>
      live("crowdPots", { count: POTS.length, pots: POTS.slice(0, limit) }),
    pot: async (id): Promise<Live<Pot | null>> => live("crowdPots", POTS.find((p) => p.id === id) ?? null),
    ledger: () => real.ledger(),
    seatPay: (tokenId) => real.seatPay(tokenId),
    tipOwed: (agentId) => real.tipOwed(agentId),
    feeds: () => real.feeds(),
    keeperTips: (keeper) => real.keeperTips(keeper),
    report: (limit) => real.report(limit),
    endowments: (limit) => real.endowments(limit),
    rules: (limit) => real.rules(limit),
    doorbell: () => real.doorbell(),
    identity: (contract) => real.identity(contract),
  };
}
