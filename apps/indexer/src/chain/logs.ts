/**
 * `eth_getLogs` with the manners free and paid nodes demand.
 *
 * Every provider caps a log query differently: by block range (800, 2,000, 10,000), by result
 * count, by response size or by time. None says so in a standard way. So a refused range is cut in
 * half and tried again, down to a single block, and the size that worked is remembered by the
 * caller. One refusal is different: a node that has dropped old history ("archive requests require
 * a token") will refuse a single old block too, so halving is pointless. It is asked once more
 * (see `getLogsAdaptive`) and then the error is passed up as `HistoryUnavailableError`; the engine
 * adds the advice that fits (another node, a later start block, or the `skip` command).
 */
import { formatLog, numberToHex, type Address, type Hex, type PublicClient, type RpcLog } from "viem";
import { classifyLogsError, errorText, HISTORY_REFUSAL, type LogsErrorKind } from "@help-wanted/shared";
import { filterAddresses, type LogFilter } from "../engine/module.js";

/** A log as the engine handles it: numbers as numbers, the address lowercased. */
export interface ChainLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: number;
  blockHash: Hex;
  /** Seconds. Null when the node does not put the timestamp in its logs. */
  blockTime: number | null;
  txHash: Hex;
  txIndex: number;
  logIndex: number;
}

/** What to do about a node without history, when the caller knows nothing more specific. */
const DEFAULT_HISTORY_ADVICE = "Point RPC_URL at a node that keeps old logs.";

/** The node will not serve logs this old. Halving the range cannot help. */
export class HistoryUnavailableError extends Error {
  readonly fromBlock: number;
  readonly toBlock: number;
  /** The node's own sentence, cut to one short line. Somebody else's text: for the log only. */
  readonly detail: string;
  /** The same message without the node's words, for a public status page. */
  readonly publicMessage: string;

  constructor(fromBlock: number, toBlock: number, detail: string, advice = DEFAULT_HISTORY_ADVICE) {
    const what = `the node refused logs for blocks ${fromBlock} to ${toBlock} because it does not keep history that far back`;
    super(`${what} (${detail}). ${advice}`);
    this.name = "HistoryUnavailableError";
    this.fromBlock = fromBlock;
    this.toBlock = toBlock;
    this.detail = detail;
    this.publicMessage = `${what}. ${advice}`;
  }

  /** The same refusal with advice that fits where it happened. */
  withAdvice(advice: string): HistoryUnavailableError {
    return new HistoryUnavailableError(this.fromBlock, this.toBlock, this.detail, advice);
  }
}

/**
 * The node answered with something that cannot be right. The chunk is not stored. The message is
 * written here from checked values only, so it may be shown publicly.
 */
export class BadNodeAnswerError extends Error {
  readonly publicMessage: string;

  constructor(message: string) {
    super(message);
    this.name = "BadNodeAnswerError";
    this.publicMessage = message;
  }
}

// Why a node refused a log query is told by `classifyLogsError` of the shared package: the evidence
// builder at the repository root reads logs in chunks too and must sort refusals the same way.
export { classifyLogsError };
export type { LogsErrorKind };

/** A node's "I do not keep that history" is taken as true when it says so this many times running. */
const HISTORY_REFUSALS_BELIEVED = 2;

/** The node's own sentence about missing history, on one line, for the error we raise. */
function nodeWords(error: unknown): string {
  const { parts } = errorText(error);
  const said =
    [...parts].reverse().find((part) => HISTORY_REFUSAL.test(part.toLowerCase())) ?? parts[0] ?? "no detail";
  return said.replace(/\s+/g, " ").trim().slice(0, 160);
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const WORD = /^0x[0-9a-f]{64}$/;
const BYTES = /^0x(?:[0-9a-f]{2})*$/;

/** Ethereum's genesis block, and a date no block of this deployment will see (1 January 2200). */
const EARLIEST_BLOCK_TIME = 1_438_269_973;
const LATEST_BLOCK_TIME = 7_258_118_400;

/**
 * Whether a number can be a mainnet block's timestamp. Times end up as calendar days in the
 * tally, so a node is not allowed to hand over one that no calendar holds.
 */
export function isBlockTime(seconds: number): boolean {
  return Number.isSafeInteger(seconds) && seconds >= EARLIEST_BLOCK_TIME && seconds <= LATEST_BLOCK_TIME;
}

/**
 * One entry of an `eth_getLogs` answer as the engine handles it, or null for a log the node marks
 * as removed or not yet mined. Every field is checked for its shape first: what a node sends ends
 * up in the database and in error messages, so text that is not hex never gets that far.
 */
function toChainLog(raw: RpcLog): ChainLog | null {
  let log: ReturnType<typeof formatLog>;
  try {
    log = formatLog(raw);
  } catch {
    throw new BadNodeAnswerError("eth_getLogs returned an entry that is not shaped like a log");
  }
  if (log.removed) return null;
  if (log.blockNumber === null || log.blockHash === null) return null;
  if (log.transactionHash === null || log.logIndex === null || log.transactionIndex === null) return null;

  const address = String(log.address).toLowerCase();
  const topics = Array.isArray(log.topics) ? log.topics.map((topic) => String(topic).toLowerCase()) : null;
  const data = String(log.data).toLowerCase();
  const blockHash = String(log.blockHash).toLowerCase();
  const txHash = String(log.transactionHash).toLowerCase();
  const blockNumber = Number(log.blockNumber);
  const blockTime =
    log.blockTimestamp === null || log.blockTimestamp === undefined ? null : Number(log.blockTimestamp);
  const shaped =
    ADDRESS.test(address) &&
    topics !== null &&
    topics.length <= 4 &&
    topics.every((topic) => WORD.test(topic)) &&
    BYTES.test(data) &&
    WORD.test(blockHash) &&
    WORD.test(txHash) &&
    Number.isSafeInteger(blockNumber) &&
    Number.isSafeInteger(log.logIndex) &&
    Number.isSafeInteger(log.transactionIndex) &&
    (blockTime === null || isBlockTime(blockTime));
  if (!shaped || topics === null) {
    throw new BadNodeAnswerError("eth_getLogs returned an entry that is not shaped like a log");
  }
  return {
    address: address as Address,
    topics: topics as Hex[],
    data: data as Hex,
    blockNumber,
    blockHash: blockHash as Hex,
    blockTime,
    txHash: txHash as Hex,
    txIndex: log.transactionIndex,
    logIndex: log.logIndex,
  };
}

export function compareLogs(
  a: { blockNumber: number; logIndex: number },
  b: { blockNumber: number; logIndex: number },
): number {
  return a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;
}

/**
 * One `eth_getLogs` call for one inclusive block range, for one address or for the several a
 * filter names. The answer is checked before it is believed: a log from any other address or from
 * outside the range is a reason to drop the whole answer, not to store it.
 */
export async function fetchLogs(
  client: PublicClient,
  filter: LogFilter,
  fromBlock: number,
  toBlock: number,
): Promise<ChainLog[]> {
  const wanted = filterAddresses(filter);
  const raw = (await client.request({
    method: "eth_getLogs",
    params: [
      {
        address: wanted.length === 1 ? (wanted[0] as Address) : wanted,
        ...(filter.topics ? { topics: filter.topics } : {}),
        fromBlock: numberToHex(fromBlock),
        toBlock: numberToHex(toBlock),
      },
    ],
  })) as RpcLog[];
  if (!Array.isArray(raw)) throw new BadNodeAnswerError("eth_getLogs did not return a list");

  const logs: ChainLog[] = [];
  for (const entry of raw) {
    const log = toChainLog(entry);
    if (!log) continue;
    if (!wanted.includes(log.address)) {
      throw new BadNodeAnswerError(
        `eth_getLogs returned a log of ${log.address}, not of ${wanted.join(" or ")}`,
      );
    }
    if (log.blockNumber < fromBlock || log.blockNumber > toBlock) {
      throw new BadNodeAnswerError(
        `eth_getLogs returned a log of block ${log.blockNumber}, outside ${fromBlock} to ${toBlock}`,
      );
    }
    logs.push(log);
  }
  return logs.sort(compareLogs);
}

export interface AdaptiveResult {
  logs: ChainLog[];
  /** The last block the answer covers. Less than what was asked when the range had to shrink. */
  toBlock: number;
  /** How many times the range was halved before the node accepted it. */
  halvings: number;
  /** Requests made in all, refused ones included. */
  requests: number;
}

/**
 * Asks for `[fromBlock, toBlock]` and, when the node finds the range too large, for the first
 * half of it, and so on. Returns the logs of the range the node did serve.
 *
 * A refusal for missing history is asked about once more before it is believed. The free node is
 * a pool of machines that do not always agree on what they keep: on 11 October 2026 it refused a
 * range 7,000 blocks behind the head as an "archive request" and, seconds later, served ranges
 * 9,000 blocks behind. One more request costs little; a module stopped by a refusal that was
 * never true costs a first run.
 */
export async function getLogsAdaptive(
  client: PublicClient,
  filter: LogFilter,
  fromBlock: number,
  toBlock: number,
): Promise<AdaptiveResult> {
  let end = toBlock;
  let halvings = 0;
  let requests = 0;
  let historyRefusals = 0;
  for (;;) {
    try {
      requests++;
      const logs = await fetchLogs(client, filter, fromBlock, end);
      return { logs, toBlock: end, halvings, requests };
    } catch (error) {
      const kind = classifyLogsError(error);
      if (kind === "history") {
        if (++historyRefusals < HISTORY_REFUSALS_BELIEVED) continue;
        throw new HistoryUnavailableError(fromBlock, end, nodeWords(error));
      }
      if (kind !== "range" || end === fromBlock) throw error;
      end = fromBlock + Math.floor((end - fromBlock) / 2);
      halvings++;
    }
  }
}
