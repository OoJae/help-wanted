/**
 * Constants and arithmetic of the hire desk (`WorkOrders`), mirrored from the contract so the bots
 * and the web app can say what a transaction will do before it is sent.
 *
 * Source: `launches/b-desk/src/interfaces/IWorkOrders.sol` (frozen) and
 * `launches/b-desk/src/desk/WorkOrders.sol`. The numbers here are also readable from the deployed
 * contract (`FEE_BPS()`, `CLAIM_WINDOW()`, …); read them there when it matters.
 */

/** `IWorkOrders.State`, in declaration order. */
export const ORDER_STATE = {
  None: 0,
  /** Escrowed and waiting for a runner (or for its condition). */
  Open: 1,
  /** A runner posted a bond and holds the order for a short exclusive window. */
  Claimed: 2,
  /** The runner opened the swarm job and registered its id. */
  Registered: 3,
  /** The runner claimed delivery without a receipt; the challenge window is running. */
  Asserted: 4,
  /** A delivery claim was challenged; only a receipt (or the order's arbiter) decides it. */
  Disputed: 5,
  /** Paid out. Terminal. */
  Delivered: 6,
  /** Withdrawn by the employer before any runner took it. Terminal. */
  Cancelled: 7,
  /** Expired or timed out; escrow returned. Terminal. */
  Refunded: 8,
} as const;
export type OrderStateName = keyof typeof ORDER_STATE;
export type OrderStateCode = (typeof ORDER_STATE)[OrderStateName];

const STATE_NAMES = Object.keys(ORDER_STATE) as OrderStateName[];

export function orderStateName(code: number): OrderStateName {
  const name = STATE_NAMES[code];
  if (name === undefined) throw new RangeError(`unknown order state ${code}`);
  return name;
}

export function isTerminalOrderState(code: number): boolean {
  return code === ORDER_STATE.Delivered || code === ORDER_STATE.Cancelled || code === ORDER_STATE.Refunded;
}

/** `WorkOrders.End`: why a claim ended without a delivery, as `ClaimEnded.reason` carries it. */
export const CLAIM_END = {
  Released: 0,
  Evicted: 1,
  TimedOut: 2,
  SwarmFailed: 3,
  WrongJob: 4,
  Refuted: 5,
  DisputeExpired: 6,
} as const;

/** `OrderParams.flags` bits. */
export const ORDER_FLAG = {
  /** The employer accepts the bonded claim path when no receipt is available. */
  ALLOW_CLAIMED: 1,
  /** Call `IWorkEmployer.onWorkDelivered` on the employer at settlement. */
  CALLBACK: 2,
  /** The condition call takes `condArg` as its single argument. */
  COND_ARG: 4,
} as const;

/** `OrderParams.condCmp`. */
export const CONDITION_CMP = { none: 0, gte: 1, lte: 2, gt: 3, lt: 4, eq: 5, neq: 6 } as const;

export const DESK = {
  FEE_BPS: 500n,
  TIP_BPS: 500n,
  RELEASE_BPS: 1000n,
  BPS: 10_000n,
  /** 0.25 IMD. */
  MIN_BOND: 250_000_000_000_000_000n,
  /** Three days, in seconds. */
  MIN_DELIVERY: 259_200,
  /** Ninety days, in seconds: the longest delivery time an order may set. */
  MAX_DELIVERY: 7_776_000,
  /** How long a runner may hold an order without registering a job: one hour. */
  CLAIM_WINDOW: 3_600,
  /** How long a delivery claim can be challenged: 24 hours. */
  CHALLENGE_WINDOW: 86_400,
  /**
   * What must still be left before the delivery deadline once the challenge window ends, so that a
   * claim challenged in its last second leaves a receipt or the arbiter a day to decide: 24 hours.
   * `claimDelivered` reverts `TooLate` unless both windows fit.
   */
  DISPUTE_WINDOW: 86_400,
  CALLBACK_GAS: 150_000n,
  CONDITION_GAS: 100_000n,
  PAYROLL_GAS: 1_000_000n,
} as const;

export interface PriceSplit {
  /** What the runner is paid for the work, before its bond comes back on top. */
  runnerPay: bigint;
  fee: bigint;
  tip: bigint;
}

/**
 * How `WorkOrders._deliver` divides a fixed price: 5% fee and 5% tip, each rounded up to the next
 * wei so the fee side never loses a fraction, and the runner gets what is left. The three parts
 * always sum to `price`.
 */
export function splitPrice(price: bigint): PriceSplit {
  if (price < 0n) throw new RangeError("price must not be negative");
  const fee = (price * DESK.FEE_BPS + DESK.BPS - 1n) / DESK.BPS;
  let tip = (price * DESK.TIP_BPS + DESK.BPS - 1n) / DESK.BPS;
  if (tip > price - fee) tip = price - fee;
  return { runnerPay: price - fee - tip, fee, tip };
}

export interface RampInput {
  minPay: bigint;
  maxPay: bigint;
  rampSecs: number | bigint;
  /** When the price started to rise; zero for a conditional order that has not been triggered. */
  rampFrom: number | bigint;
  /** The block timestamp to price at. */
  now: number | bigint;
}

/**
 * `WorkOrders._price`, line for line: `minPay` rising in a straight line to `maxPay` over
 * `rampSecs`, counted from `rampFrom`.
 *
 * A conditional order that has not been triggered has `rampFrom` zero and sits at the start of its
 * ramp, which is `minPay` when there is a ramp and `maxPay` when `rampSecs` is zero (no ramp: the
 * full price at once, triggered or not). While a runner holds an order `priceNow` answers with the
 * price that claim fixed instead; this function is the price of an open order.
 */
export function priceAt(input: RampInput): bigint {
  const from = BigInt(input.rampFrom);
  const now = BigInt(input.now);
  // The contract subtracts unchecked-safe: `rampFrom` is never later than the block it is read in.
  const elapsed = from === 0n ? 0n : now > from ? now - from : 0n;
  const rampSecs = BigInt(input.rampSecs);
  if (elapsed < rampSecs) return input.minPay + ((input.maxPay - input.minPay) * elapsed) / rampSecs;
  return input.maxPay;
}

/**
 * What a runner that releases an order loses: 10% of the bond, rounded down, to the employer. The
 * same share is what a runner forfeits when a challenged delivery claim reaches the deadline
 * undecided, or is decided against it.
 */
export function releaseCut(bond: bigint): bigint {
  return (bond * DESK.RELEASE_BPS) / DESK.BPS;
}

// ---------------------------------------------------------------------------------------------
// Deadlines of a claim
// ---------------------------------------------------------------------------------------------

/** The times that bound one claim of an order, all in the chain's seconds. */
export interface ClaimTimes {
  /** `claimOf(id).claimedAt`. */
  claimedAt: number | bigint;
  /** `claimOf(id).registeredAt`; zero while no job is registered. */
  registeredAt: number | bigint;
  /** `claimOf(id).assertedAt`; zero while no delivery was claimed. */
  assertedAt: number | bigint;
  /** `orderOf(id).deliverySecs`. */
  deliverySecs: number | bigint;
}

/**
 * When the claim window ends: `release` reverts `TooLate` from this second on, and `evict` stops
 * reverting `TooEarly` at it. Until somebody evicts, the runner can still `register`.
 */
export function claimWindowEndsAt(claimedAt: number | bigint): bigint {
  return BigInt(claimedAt) + BigInt(DESK.CLAIM_WINDOW);
}

/**
 * The delivery deadline, `registeredAt + deliverySecs`: `timeout` stops reverting `TooEarly` at
 * this second. Zero when no job is registered. A retry job does not move it.
 */
export function deliveryDeadline(times: Pick<ClaimTimes, "registeredAt" | "deliverySecs">): bigint {
  const registeredAt = BigInt(times.registeredAt);
  return registeredAt === 0n ? 0n : registeredAt + BigInt(times.deliverySecs);
}

/**
 * The last second at which `claimDelivered` is still accepted: the challenge window and the
 * dispute window after it must both end by the delivery deadline, so the claim has to be made 48
 * hours before it. With the three-day minimum delivery time that leaves a job one day.
 */
export function lastDeliveryClaimAt(times: Pick<ClaimTimes, "registeredAt" | "deliverySecs">): bigint {
  const deadline = deliveryDeadline(times);
  const windows = BigInt(DESK.CHALLENGE_WINDOW + DESK.DISPUTE_WINDOW);
  return deadline > windows ? deadline - windows : 0n;
}

/**
 * When the challenge window of a delivery claim ends: `challenge` reverts `TooLate` from this
 * second on, and `finalize` stops reverting `TooEarly` at it. Zero when no delivery was claimed.
 */
export function challengeEndsAt(assertedAt: number | bigint): bigint {
  const at = BigInt(assertedAt);
  return at === 0n ? 0n : at + BigInt(DESK.CHALLENGE_WINDOW);
}

// ---------------------------------------------------------------------------------------------
// Gas a settlement must be offered
// ---------------------------------------------------------------------------------------------

/**
 * What goes into the gas a `settle`, `stamp` or `reportFailed` must be sent with. The figures are
 * the desk's own measurements (`launches/b-desk/docs/THREATS.md`, W6 and P5, and the NatSpec of
 * `IWorkOrdersRunner`), rounded up:
 *
 * - the desk refuses (`GasShort`) unless it can hand 1,000,000 gas to each of its two Payroll
 *   calls, so a small settlement that uses 0.4M to 0.6M gas needs 1.4M to 1.6M on offer, and one
 *   that tips sixteen agents never tipped before about 0.2M more;
 * - reading the record costs up to about 19 gas a byte of text (the costliest real proof was
 *   under 700,000 gas for an 88 KB record);
 * - the record travels as calldata: 16 gas for each of its bytes (JSON text has no zero bytes),
 *   and since EIP-7623 a transaction is charged at least 40 gas a byte whatever it executes.
 */
export const SETTLE_GAS = {
  /** A transaction's own 21,000. */
  TX_BASE: 21_000n,
  /** Calldata, per byte of record, as execution prices it. */
  CALLDATA_PER_BYTE: 16n,
  /** The least a transaction is charged per byte of calldata (EIP-7623). */
  CALLDATA_FLOOR_PER_BYTE: 40n,
  /** WorkProof's walk over the record, per byte, at the dear end of what was measured for text. */
  PROOF_PER_BYTE: 19n,
  /** What the desk needs on offer beyond the proof: the two Payroll allowances and its own work. */
  DESK_OFFER: 1_800_000n,
  /** `stamp` and `reportFailed` make no Payroll call: the proof and a few writes. */
  NO_PAYROLL_OFFER: 250_000n,
  /** `finalize`: no record, the two Payroll allowances and the callback. */
  FINALIZE_OFFER: 2_000_000n,
} as const;

/**
 * The gas limit a `settle` carrying a record of `recordBytes` bytes should be sent with, by the
 * desk's own figures: the larger of what executing it needs on offer and what the calldata floor
 * charges. It is an upper estimate for refusing a record up front; the limit actually sent comes
 * from a gas estimate, which finds the same floor (`GasShort` makes anything less revert).
 *
 * 7 KB: about 2.07M. 50 KB: about 3.57M. 100 KB: about 5.32M.
 */
export function settleGasNeeded(recordBytes: number | bigint): bigint {
  const n = BigInt(recordBytes);
  if (n < 0n) throw new RangeError("recordBytes must not be negative");
  const executed =
    SETTLE_GAS.TX_BASE +
    n * (SETTLE_GAS.CALLDATA_PER_BYTE + SETTLE_GAS.PROOF_PER_BYTE) +
    SETTLE_GAS.DESK_OFFER;
  const floor = SETTLE_GAS.TX_BASE + n * SETTLE_GAS.CALLDATA_FLOOR_PER_BYTE;
  return executed > floor ? executed : floor;
}

/** The same for `stamp` and `reportFailed`, which read the record and pay nobody through Payroll. */
export function proofGasNeeded(recordBytes: number | bigint): bigint {
  const n = BigInt(recordBytes);
  if (n < 0n) throw new RangeError("recordBytes must not be negative");
  const executed =
    SETTLE_GAS.TX_BASE +
    n * (SETTLE_GAS.CALLDATA_PER_BYTE + SETTLE_GAS.PROOF_PER_BYTE) +
    SETTLE_GAS.NO_PAYROLL_OFFER;
  const floor = SETTLE_GAS.TX_BASE + n * SETTLE_GAS.CALLDATA_FLOOR_PER_BYTE;
  return executed > floor ? executed : floor;
}

/** The largest record, in bytes, whose `settle` fits a gas limit by `settleGasNeeded`. Zero when none does. */
export function largestSettleableRecord(gasLimit: bigint): number {
  const fixed = SETTLE_GAS.TX_BASE + SETTLE_GAS.DESK_OFFER;
  if (gasLimit < fixed) return 0;
  const byExecution = (gasLimit - fixed) / (SETTLE_GAS.CALLDATA_PER_BYTE + SETTLE_GAS.PROOF_PER_BYTE);
  const byFloor = (gasLimit - SETTLE_GAS.TX_BASE) / SETTLE_GAS.CALLDATA_FLOOR_PER_BYTE;
  return Number(byExecution < byFloor ? byExecution : byFloor);
}
