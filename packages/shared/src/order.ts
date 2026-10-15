/**
 * The order ticket, the 85-byte header and the spec character rules.
 *
 * These must match `WorkOrders` byte for byte: the runner bot puts the header at byte 0 of the job
 * objective, IdentityMD copies the objective verbatim into the work record, and the desk pays only
 * when `keccak256(first 85 bytes of the record's objective)` equals the header it expects.
 *
 *   ticket    = keccak256(abi.encode(block.chainid, address(workOrders), orderId, claimSeq, runner))
 *   HEADER    = "[help-wanted order " ‖ 64 lowercase hex of ticket ‖ "] "        (exactly 85 bytes)
 *   objective = HEADER ‖ spec
 *
 * `claimSeq` counts claims of that order from 1, so a second runner taking a released order gets a
 * different ticket and an old receipt cannot be replayed.
 */
import {
  bytesToString,
  encodeAbiParameters,
  getAddress,
  isHex,
  keccak256,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";

export const HEADER_PREFIX = "[help-wanted order " as const;
export const HEADER_SUFFIX = "] " as const;
export const HEADER_LENGTH = 85 as const;

/** A spec is 1 to 7,900 bytes; with the header the objective stays under IdentityMD's 8,000 limit. */
export const SPEC_MIN_BYTES = 1 as const;
export const SPEC_MAX_BYTES = 7900 as const;
/** IdentityMD's own cap on a job objective, in characters. */
export const OBJECTIVE_MAX_CHARS = 8000 as const;
/** A `template: "research"` objective is capped at 4,000 characters, so its spec at 3,915 bytes. */
export const RESEARCH_SPEC_MAX_BYTES = 4000 - HEADER_LENGTH;

export interface TicketInput {
  chainId: number | bigint;
  /** The `WorkOrders` address the order lives on. */
  workOrders: Address;
  orderId: number | bigint;
  /** Counts claims of this order, starting at 1. */
  claimSeq: number | bigint;
  runner: Address;
}

const TICKET_ABI = [
  { type: "uint256" },
  { type: "address" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "address" },
] as const;

function toUint(name: string, value: number | bigint): bigint {
  const n = typeof value === "bigint" ? value : BigInt(value);
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer`);
  }
  if (n < 0n) throw new RangeError(`${name} must not be negative`);
  return n;
}

/** The 160 ABI-encoded bytes that are hashed into the ticket. */
export function ticketPreimage(input: TicketInput): Hex {
  return encodeAbiParameters(TICKET_ABI, [
    toUint("chainId", input.chainId),
    getAddress(input.workOrders),
    toUint("orderId", input.orderId),
    toUint("claimSeq", input.claimSeq),
    getAddress(input.runner),
  ]);
}

/**
 * `keccak256(abi.encode(chainId, workOrders, orderId, claimSeq, runner))`, as `OrderHeader.ticket`
 * computes it. The desk numbers orders and claims from 1; zero is accepted here only because the
 * library on chain accepts it too.
 */
export function orderTicket(input: TicketInput): Hex {
  return keccak256(ticketPreimage(input));
}

function assertTicket(ticket: string): asserts ticket is Hex {
  if (!isHex(ticket, { strict: true }) || ticket.length !== 66) {
    throw new TypeError("ticket must be 0x followed by 64 hex characters");
  }
}

/** The header text for a ticket. Always 85 ASCII characters, hex in lowercase. */
export function orderHeader(ticket: Hex): string {
  assertTicket(ticket);
  return `${HEADER_PREFIX}${ticket.slice(2).toLowerCase()}${HEADER_SUFFIX}`;
}

/** The header as the 85 bytes the contract hashes. */
export function orderHeaderBytes(ticket: Hex): Uint8Array {
  return stringToBytes(orderHeader(ticket));
}

/** `keccak256(HEADER)`: what `WorkProof` returns as `headHash` for `headLen = 85`. */
export function orderHeadHash(ticket: Hex): Hex {
  return keccak256(orderHeaderBytes(ticket));
}

export type SpecProblem =
  | { code: "empty"; at: 0 }
  | { code: "too_long"; at: number; bytes: number; max: number }
  | { code: "leading_space"; at: 0 }
  | { code: "trailing_space"; at: number }
  | { code: "bad_byte"; at: number; byte: number };

export type SpecCheck = { ok: true; bytes: number } | { ok: false; problem: SpecProblem };

function specBytes(spec: string | Uint8Array): Uint8Array {
  return typeof spec === "string" ? stringToBytes(spec) : spec;
}

function isSpecByte(b: number): boolean {
  return b >= 0x20 && b <= 0x7e && b !== 0x22 && b !== 0x5c;
}

/**
 * The contract's rule for a spec (`SpecText.firstBad` in launches/b-desk): 1 to 7,900 bytes; every
 * byte printable ASCII (0x20 to 0x7E); no `"` (0x22) and no `\` (0x5C); the first and the last byte
 * are not a space.
 *
 * The rule exists so that the raw text equals its JSON-escaped form: the desk can then hash a slice
 * of the work record directly, with no unescaping on chain. A newline, a tab, a quote, a backslash
 * or any non-ASCII character would break that, so they are refused when the order is created.
 *
 * `problem.at` is the index `createOrder` reverts with in `SpecInvalid(at)`: 0 for an empty spec or
 * a leading space, 7,900 for one that is too long, otherwise the lowest index of a byte that is not
 * allowed where it stands (a trailing space reports the last index).
 */
export function checkSpec(spec: string | Uint8Array): SpecCheck {
  const bytes = specBytes(spec);
  const len = bytes.length;
  if (len < SPEC_MIN_BYTES) return { ok: false, problem: { code: "empty", at: 0 } };
  if (len > SPEC_MAX_BYTES) {
    return { ok: false, problem: { code: "too_long", at: SPEC_MAX_BYTES, bytes: len, max: SPEC_MAX_BYTES } };
  }
  if (bytes[0] === 0x20) return { ok: false, problem: { code: "leading_space", at: 0 } };
  for (let i = 0; i < len; i++) {
    const b = bytes[i] as number;
    if (!isSpecByte(b)) return { ok: false, problem: { code: "bad_byte", at: i, byte: b } };
  }
  if (bytes[len - 1] === 0x20) return { ok: false, problem: { code: "trailing_space", at: len - 1 } };
  return { ok: true, bytes: len };
}

/** `SpecText.firstBad`: the index the contract would revert with, or null for an acceptable spec. */
export function specFirstBad(spec: string | Uint8Array): number | null {
  const check = checkSpec(spec);
  return check.ok ? null : check.problem.at;
}

export function isValidSpec(spec: string | Uint8Array): boolean {
  return checkSpec(spec).ok;
}

export function describeSpecProblem(problem: SpecProblem): string {
  switch (problem.code) {
    case "empty":
      return "the spec is empty";
    case "too_long":
      return `the spec is ${problem.bytes} bytes; the limit is ${problem.max}`;
    case "leading_space":
      return "the spec starts with a space";
    case "trailing_space":
      return "the spec ends with a space";
    case "bad_byte":
      return `byte 0x${problem.byte.toString(16).padStart(2, "0")} at offset ${problem.at} is not allowed (printable ASCII without " and \\ only)`;
  }
}

/** `keccak256(spec)`: the `specHash` an order pins and `WorkProof` recomputes from the record. */
export function specHash(spec: string | Uint8Array): Hex {
  return keccak256(specBytes(spec));
}

/** `keccak256(kind)`, e.g. `kindHash("audit")`: the `OrderParams.kindHash` for a work-record kind. */
export function kindHash(kind: string): Hex {
  return keccak256(stringToBytes(kind));
}

/** `HEADER ‖ spec`: the objective the runner sends to the swarm. Refuses a spec the desk would refuse. */
export function buildObjective(ticket: Hex, spec: string): string {
  const check = checkSpec(spec);
  if (!check.ok) throw new RangeError(`invalid spec: ${describeSpecProblem(check.problem)}`);
  return orderHeader(ticket) + spec;
}

export interface ParsedObjective {
  ticket: Hex;
  header: string;
  spec: string;
}

/**
 * Splits an objective into header and spec. Returns null unless the text begins with a well-formed
 * header: the fixed prefix, exactly 64 lowercase hex characters, then `"] "`.
 */
export function parseObjective(objective: string | Uint8Array): ParsedObjective | null {
  const text = typeof objective === "string" ? objective : bytesToString(objective);
  if (text.length < HEADER_LENGTH) return null;
  const header = text.slice(0, HEADER_LENGTH);
  if (!header.startsWith(HEADER_PREFIX) || !header.endsWith(HEADER_SUFFIX)) return null;
  const hex = header.slice(HEADER_PREFIX.length, HEADER_LENGTH - HEADER_SUFFIX.length);
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return { ticket: `0x${hex}`, header, spec: text.slice(HEADER_LENGTH) };
}

/** True when `objective` begins with the header for exactly this ticket. */
export function objectiveHasHeader(objective: string, ticket: Hex): boolean {
  return objective.startsWith(orderHeader(ticket));
}

/** True when `objective` is exactly `HEADER(ticket) ‖ spec`, byte for byte. */
export function objectiveMatches(objective: string, ticket: Hex, spec: string): boolean {
  return objective === orderHeader(ticket) + spec;
}
