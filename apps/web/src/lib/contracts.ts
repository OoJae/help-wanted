/**
 * What a page needs on top of the ABIs in `@help-wanted/shared`.
 *
 * Every signature this site encodes or decodes comes from the shared package, whose ABIs for our
 * ten contracts are generated from the launch projects' build output. This module holds no ABI. It
 * holds two kinds of thing:
 *
 * 1. Helpers that read a signature out of a shared ABI, so that a `cast` command printed on a page
 *    is spelled by the compiler's own output and not by hand.
 * 2. The few names a number has on a page and that the ABI does not carry: a Solidity enum is a
 *    `uint8` in an ABI. The shared package names the desk's and the Questions enums; the four
 *    below (pot stages, rule statuses, endowment kinds, and the fixed shares of Payroll's split)
 *    are not in it yet. `test/contracts.test.ts` reads the Solidity sources, when they are in the
 *    repository beside this app, and fails if one of these lists differs from its enum.
 */
import { getAbiItem, toFunctionSignature, type Abi, type AbiFunction, type AbiParameter } from "viem";
import { CONDITION_CMP, ORDER_STATE, type OrderStateName } from "@help-wanted/shared";

// ---------------------------------------------------------------------------------------------
// Signatures, from the ABI
// ---------------------------------------------------------------------------------------------

function abiFunction(abi: Abi, name: string): AbiFunction {
  const item = getAbiItem({ abi, name }) as AbiFunction | undefined;
  if (!item || item.type !== "function") throw new Error(`the ABI has no function ${name}`);
  return item;
}

function typeOf(parameter: AbiParameter): string {
  if (!parameter.type.startsWith("tuple")) return parameter.type;
  const components = (parameter as AbiParameter & { components: readonly AbiParameter[] }).components;
  return `(${components.map(typeOf).join(",")})${parameter.type.slice("tuple".length)}`;
}

/** `createOrder((bytes32,uint96,…),bytes)`: what `cast send` takes. */
export function signatureOf(abi: Abi, name: string): string {
  return toFunctionSignature(abiFunction(abi, name));
}

/** `latest(bytes32)(uint256,uint64,uint64,uint64,uint64)`: what `cast call` takes, outputs included. */
export function callSignatureOf(abi: Abi, name: string): string {
  const fn = abiFunction(abi, name);
  return `${toFunctionSignature(fn)}(${fn.outputs.map(typeOf).join(",")})`;
}

/** The names of a function's inputs, in order, for a line that says what each argument is. */
export function inputNamesOf(abi: Abi, name: string): string[] {
  return abiFunction(abi, name).inputs.map((input, index) => input.name || `arg${index}`);
}

/** True when the function is payable: the call may carry ETH. */
export function isPayable(abi: Abi, name: string): boolean {
  return abiFunction(abi, name).stateMutability === "payable";
}

// ---------------------------------------------------------------------------------------------
// Names for numbers
// ---------------------------------------------------------------------------------------------

/** `IWorkOrders.State`, by code, from the shared table. */
export const ORDER_STATES = (Object.keys(ORDER_STATE) as OrderStateName[]).sort(
  (a, b) => ORDER_STATE[a] - ORDER_STATE[b],
);
export type OrderState = OrderStateName;

/** `CrowdPots.Stage`, in declaration order. */
export const POT_STAGES = ["None", "Funding", "Hiring", "Delivered", "Refundable", "Series"] as const;
export type PotStage = (typeof POT_STAGES)[number];

/** `Rules.Status`, in declaration order. */
export const RULE_STATUSES = ["None", "Armed", "Exhausted", "Cancelled"] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

/** `Endowments.Kind`, in declaration order. */
export const ENDOWMENT_KINDS = ["None", "Meter", "Pot", "Recipient"] as const;
export type EndowmentKind = (typeof ENDOWMENT_KINDS)[number];

/** `Rules.COND_VIEW`, `COND_FEED`, `ACT_HIRE`, `ACT_PAY`. Each is also a public constant of the contract. */
export const RULE = { COND_VIEW: 1, COND_FEED: 2, ACT_HIRE: 1, ACT_PAY: 2 } as const;

/**
 * How a comparison code reads in a sentence. The codes are the shared `CONDITION_CMP` (the desk's
 * `condCmp`, a feed's gate and a rule's `cmp` are numbered alike); the words are this site's.
 */
export const COMPARISONS = [
  { code: CONDITION_CMP.gte, symbol: ">=", words: "is at least" },
  { code: CONDITION_CMP.lte, symbol: "<=", words: "is at most" },
  { code: CONDITION_CMP.gt, symbol: ">", words: "is more than" },
  { code: CONDITION_CMP.lt, symbol: "<", words: "is less than" },
  { code: CONDITION_CMP.eq, symbol: "==", words: "equals" },
  { code: CONDITION_CMP.neq, symbol: "!=", words: "is not" },
] as const;

/**
 * Payroll's fixed split of everything it books, for the sentences that explain it before the
 * contract exists. Once it is launched the page prints `SEAT_BPS()`, `FEED_BPS()` and
 * `STREAM_DURATION()` as read from the contract beside these.
 */
export const PAYROLL_SPLIT = { stakersBps: 5000, seatsBps: 3000, feedsBps: 2000, streamDays: 7 } as const;

/** Values fixed in launch C's contracts that a form explains before the contracts exist. */
export const ENDOWMENT = {
  /** `SEED`: paid once by whoever creates an endowment, never refunded. 0.000001 IMD. */
  SEED: 1_000_000_000_000n,
  /** `METER_RUNWAY`: a harvest never lifts a meter above the cost of this many requests. */
  METER_RUNWAY: 30,
  /** `STAKE_INTERVAL`: `stake` runs at most once in this many blocks. */
  STAKE_INTERVAL_BLOCKS: 50,
  /** The gas limit to send a pot endowment's harvest with (below about 800,000 it reverts `LowGas`). */
  POT_HARVEST_GAS: 850_000n,
} as const;

/** Bounds `CrowdPots` checks when a pot opens; each is also a public constant of the contract. */
export const POTS = {
  MIN_TARGET: 1_000_000_000_000_000_000n,
  MIN_FUND_SECS: 3_600,
  MAX_FUND_SECS: 2_592_000,
  MIN_HIRE_SECS: 86_400,
  MAX_HIRE_SECS: 2_592_000,
  MAX_DELIVERY_SECS: 2_592_000,
  MAX_KIND_LENGTH: 64,
} as const;

/** Gas limits the launch documents say to send with, where a call must be offered more than it uses. */
export const GAS_LIMIT = {
  /** `WorkOrders.settle`: the desk needs 1,000,000 in hand for each of its two Payroll calls. */
  SETTLE: 3_000_000n,
  /** `WorkOrders.finalize` and `resolve`. */
  FINALIZE: 2_000_000n,
  /** `Rules.fire` of a HIRE rule, and of a PAY rule. */
  FIRE_HIRE: 700_000n,
  FIRE_PAY: 300_000n,
  /** The 25th `Doorbell.ring`, which opens an order. */
  RING: 600_000n,
} as const;
