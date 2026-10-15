/**
 * Small pure pieces for reading a contract from a node: naming a log under an ABI, building and
 * reading back a view call, and telling why a node refused an `eth_getLogs`.
 *
 * They are here because two readers need the same answers: the indexer, which stores every log of
 * our contracts, and the evidence builder at the repository root (`scripts/evidence`), which counts
 * them. One decoder, not two. Nothing here talks to a node: each function takes what a node
 * returned and says what it means.
 */
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  keccak256,
  type Abi,
  type Address,
  type Hex,
} from "viem";

export type { Abi, Address, Hex };

/** A log named under an ABI: the event's name and its arguments, as viem decodes them. */
export interface NamedLog {
  event: string;
  /**
   * By name for an event whose inputs are named (all of ours are), a list otherwise. Integers are
   * `bigint` (or `number` up to 48 bits), addresses checksummed, structs objects.
   */
  args: Record<string, unknown> | readonly unknown[];
}

/**
 * Names a log under an ABI, strictly: the topics and the data must fit the event exactly. Returns
 * null for a log the ABI does not know (another contract's event, an anonymous log, an event whose
 * signature has changed) and for an ABI with no events. A log that is not known is never an error
 * here; what to do about it is the caller's decision.
 */
export function decodeLogUnder(abi: Abi, topics: readonly string[], data: string): NamedLog | null {
  if (abi.length === 0 || topics.length === 0) return null;
  try {
    const decoded = decodeEventLog({
      abi,
      topics: topics as [Hex, ...Hex[]],
      data: data as Hex,
      strict: true,
    });
    if (typeof decoded.eventName !== "string") return null;
    const args = (decoded.args ?? {}) as NamedLog["args"];
    return { event: decoded.eventName, args };
  } catch {
    return null;
  }
}

/** The names of the events an ABI declares, in the ABI's order. */
export function eventNamesOf(abi: Abi): string[] {
  return abi.flatMap((item) => (item.type === "event" ? [item.name] : []));
}

/** The calldata of a view call, for `eth_call`. Throws when the ABI has no such function or the arguments do not fit. */
export function viewCallData(abi: Abi, functionName: string, args: readonly unknown[] = []): Hex {
  return encodeFunctionData({ abi, functionName, args: args as unknown[] });
}

/**
 * What an `eth_call` returned, read under the ABI: one value for a function with one output, a
 * list for several. Throws when the bytes do not fit the function's outputs, which is also what
 * an address without that function (or with no code at all, which returns `0x`) leads to.
 */
export function viewResult(abi: Abi, functionName: string, data: string): unknown {
  return decodeFunctionResult({ abi, functionName, data: data as Hex });
}

/** An address in its EIP-55 checksummed spelling. Throws for anything that is not an address. */
export function checksumAddress(address: string): Address {
  return getAddress(address);
}

/** keccak256 of bytes given as hex: of a contract's code this is the account's code hash. */
export function keccakOfHex(hex: string): Hex {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new TypeError("expected 0x followed by whole bytes of hex");
  return keccak256(hex as Hex);
}

export type LogsErrorKind = "history" | "range" | "other";

/** Every message in an error's cause chain, lowercased, plus any HTTP status and RPC code. */
export function errorText(error: unknown): {
  text: string;
  parts: string[];
  status: number | null;
  code: number | null;
} {
  const parts: string[] = [];
  let status: number | null = null;
  let code: number | null = null;
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth++) {
    const e = current as Record<string, unknown>;
    for (const key of ["shortMessage", "details", "message"]) {
      if (typeof e[key] === "string") parts.push(e[key]);
    }
    if (typeof e.status === "number" && status === null) status = e.status;
    if (typeof e.code === "number" && code === null) code = e.code;
    current = e.cause;
  }
  if (typeof error === "string") parts.push(error);
  return { text: parts.join(" | ").toLowerCase(), parts, status, code };
}

const RATE_LIMIT = /rate limit|too many requests|request limit|credits|capacity/;
/** What a node says when it has dropped the history a query asks for. */
export const HISTORY_REFUSAL =
  /archive (requests?|node|data)|requires? an? archive|missing trie node|history (is |has been )?pruned|pruned history|historical (state|data) (is )?not available|block not found in (history|database)/;
const RANGE =
  /range (is )?too (large|wide|big)|block range|max(imum)? (block )?range|exceeds? (the )?(max|limit|range)|limit exceeded|more than \d+ (results|logs)|query returned more than|too many (results|logs|blocks)|response (size )?(is )?(too large|exceeded|larger)|log response size|query timeout|ranges over|up to a \d+ block range|result set too large|payload too large|limited to a/;

/**
 * Sorts a failed `eth_getLogs` into: history the node does not keep (asking for fewer blocks
 * cannot help), a range it finds too large (asking for half of it can), or anything else (network
 * trouble, rate limits) that a smaller range would not cure.
 *
 * Every provider caps a log query differently, by block range, result count, response size or
 * time, and none says so in a standard way; the patterns are the sentences real nodes use.
 */
export function classifyLogsError(error: unknown): LogsErrorKind {
  const { text, status } = errorText(error);
  if (status === 429 || RATE_LIMIT.test(text)) return "other";
  if (HISTORY_REFUSAL.test(text)) return "history";
  if (status === 413 || RANGE.test(text)) return "range";
  return "other";
}
