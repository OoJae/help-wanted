/**
 * A JSON-RPC client that can only read.
 *
 * The evidence builder holds no key and must not be able to change anything, so this client knows
 * eight methods, all of them reads, and refuses every other name before a request is made. It
 * takes one RPC URL or several: a request one node cannot serve is tried on the next, in the order
 * given. Logs are read in block chunks, because every node caps a log query in its own way and the
 * free ones keep only recent history.
 *
 * Nothing a node says is believed unchecked: a log from another address or from outside the range
 * asked for, or one that is not shaped like a log, makes that node's answer worthless and the next
 * node is asked. When no node gives a usable answer the read fails, and so does the run.
 */
import { classifyLogsError, type Address, type Hex } from "./shared.js";

/** The reads this client makes. Anything else is refused: there is no way to send a transaction through it. */
export const READ_METHODS = [
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getLogs",
  "eth_call",
  "eth_getCode",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
] as const;
export type ReadMethod = (typeof READ_METHODS)[number];

/** The part of `fetch` this client uses, so a test can put a recording in its place. */
export type HttpPost = (
  url: string,
  body: string,
  signal: AbortSignal,
) => Promise<{ status: number; text: string }>;

export const httpPost: HttpPost = async (url, body, signal) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body,
    signal,
  });
  return { status: response.status, text: await response.text() };
};

/** A node answered with a JSON-RPC error, or with an HTTP status that is not 200. */
export class RpcAnswerError extends Error {
  readonly code: number | null;
  readonly status: number | null;
  /** The node's own sentence. Somebody else's text: it is shortened and never written into the evidence. */
  readonly details: string;

  constructor(
    method: string,
    details: string,
    code: number | null,
    status: number | null,
  ) {
    super(
      `${method} was refused: ${details.replace(/\s+/g, " ").trim().slice(0, 200)}`,
    );
    this.name = "RpcAnswerError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** The node answered, and the answer cannot be right. */
export class BadNodeAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadNodeAnswerError";
  }
}

/** No node of the list gave a usable answer. */
export class ReadFailedError extends Error {
  constructor(what: string, reasons: string[], advice = "") {
    super(
      `${what} could not be read: ${reasons.join("; ")}${advice ? `. ${advice}` : ""}`,
    );
    this.name = "ReadFailedError";
  }
}

/** A log as the builder handles it: numbers as numbers, hex lowercased. */
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

export interface RpcOptions {
  post?: HttpPost;
  /** Tries on one node for a failure that may pass (network trouble, 429, 5xx). Default 3. */
  attempts?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called once per request that got an answer, for the run's own count. */
  onRequest?: (info: { method: string; host: string }) => void;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const WORD = /^0x[0-9a-f]{64}$/;
const BYTES = /^0x(?:[0-9a-f]{2})*$/;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;

/** A JSON-RPC quantity as a number. Throws for anything that is not one or does not fit. */
export function quantity(value: unknown, what: string): number {
  if (typeof value !== "string" || !QUANTITY.test(value.toLowerCase())) {
    throw new BadNodeAnswerError(`${what} is not a hex quantity`);
  }
  const n = Number(BigInt(value));
  if (!Number.isSafeInteger(n))
    throw new BadNodeAnswerError(`${what} does not fit a whole number`);
  return n;
}

export function hexWord(value: unknown, what: string): Hex {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (!WORD.test(text))
    throw new BadNodeAnswerError(`${what} is not a 32-byte word`);
  return text as Hex;
}

export function hexAddress(value: unknown, what: string): Address {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (!ADDRESS.test(text))
    throw new BadNodeAnswerError(`${what} is not an address`);
  return text as Address;
}

export function hexBytes(value: unknown, what: string): Hex {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (!BYTES.test(text))
    throw new BadNodeAnswerError(`${what} is not hex bytes`);
  return text as Hex;
}

function toChainLog(raw: unknown): ChainLog | null {
  if (typeof raw !== "object" || raw === null)
    throw new BadNodeAnswerError(
      "eth_getLogs returned an entry that is not a log",
    );
  const log = raw as Record<string, unknown>;
  // A log of a block that was replaced, or of a transaction not mined yet, is not part of the chain.
  if (log.removed === true) return null;
  if (
    log.blockNumber == null ||
    log.blockHash == null ||
    log.transactionHash == null ||
    log.logIndex == null
  )
    return null;
  if (!Array.isArray(log.topics) || log.topics.length > 4) {
    throw new BadNodeAnswerError(
      "eth_getLogs returned a log without a list of at most four topics",
    );
  }
  return {
    address: hexAddress(log.address, "a log's address"),
    topics: log.topics.map((topic) => hexWord(topic, "a log's topic")),
    data: hexBytes(log.data, "a log's data"),
    blockNumber: quantity(log.blockNumber, "a log's block number"),
    blockHash: hexWord(log.blockHash, "a log's block hash"),
    blockTime:
      log.blockTimestamp == null
        ? null
        : quantity(log.blockTimestamp, "a log's block timestamp"),
    txHash: hexWord(log.transactionHash, "a log's transaction hash"),
    txIndex: quantity(log.transactionIndex, "a log's transaction index"),
    logIndex: quantity(log.logIndex, "a log's index"),
  };
}

export function compareLogs(
  a: { blockNumber: number; logIndex: number },
  b: { blockNumber: number; logIndex: number },
): number {
  return a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;
}

/**
 * Refusals that may pass on a second try: a busy node, or a machine of a node's pool that is a few
 * blocks behind the one that answered a moment ago ("block range extends beyond current head").
 */
const MAY_PASS =
  /rate limit|too many requests|capacity|beyond (the )?current head|header not found|unknown block|block not found|not yet available/i;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "an RPC URL that is not a URL";
  }
}

/** What is said about a failure: our own sentences and the node's, shortened. Never a URL (it can hold a key). */
function reasonOf(error: unknown): string {
  if (error instanceof RpcAnswerError || error instanceof BadNodeAnswerError)
    return error.message;
  if (error instanceof Error)
    return error.name === "TimeoutError"
      ? "the request timed out"
      : "the request failed";
  return "the request failed";
}

export interface LogsRead {
  logs: ChainLog[];
  /** Requests that returned logs. */
  chunks: number;
  /** The narrowest block range a node had to be asked for. */
  smallestChunk: number;
}

export class Rpc {
  readonly hosts: string[];
  readonly #urls: string[];
  readonly #post: HttpPost;
  readonly #attempts: number;
  readonly #timeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onRequest: RpcOptions["onRequest"];
  #id = 0;

  constructor(urls: readonly string[], options: RpcOptions = {}) {
    if (urls.length === 0) throw new Error("no RPC URL was given");
    this.#urls = [...urls];
    this.hosts = this.#urls.map(hostOf);
    this.#post = options.post ?? httpPost;
    this.#attempts = Math.max(1, options.attempts ?? 3);
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#onRequest = options.onRequest;
  }

  /**
   * One request to one node of the list. A failure that may pass (network trouble, a busy node, a
   * machine of the node's pool that has not caught up with the block asked about) is tried again
   * after a pause; a refusal is thrown at once, for the caller to judge.
   */
  async requestOn(
    index: number,
    method: ReadMethod,
    params: readonly unknown[],
  ): Promise<unknown> {
    if (!(READ_METHODS as readonly string[]).includes(method)) {
      throw new Error(
        `${String(method)} is not a read: this client refuses it`,
      );
    }
    const url = this.#urls[index];
    if (url === undefined) throw new Error("no such RPC URL");
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: ++this.#id,
      method,
      params,
    });
    let last: unknown = new Error("the request failed");
    for (let attempt = 1; attempt <= this.#attempts; attempt++) {
      if (attempt > 1) await this.#sleep(500 * 2 ** (attempt - 2));
      const outcome = await this.#once(url, method, body);
      if (outcome.ok) {
        this.#onRequest?.({ method, host: this.hosts[index] ?? "" });
        return outcome.result;
      }
      last = outcome.error;
      if (!outcome.mayPass) break;
    }
    throw last;
  }

  async #once(
    url: string,
    method: string,
    body: string,
  ): Promise<
    | { ok: true; result: unknown }
    | { ok: false; error: unknown; mayPass: boolean }
  > {
    let answer: { status: number; text: string };
    try {
      answer = await this.#post(
        url,
        body,
        AbortSignal.timeout(this.#timeoutMs),
      );
    } catch (error) {
      return { ok: false, error, mayPass: true };
    }
    let envelope: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(answer.text);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        envelope = parsed as Record<string, unknown>;
      }
    } catch {
      envelope = null;
    }
    const error = envelope?.error;
    if (typeof error === "object" && error !== null) {
      const e = error as Record<string, unknown>;
      const refusal = new RpcAnswerError(
        method,
        typeof e.message === "string" ? e.message : "an error with no message",
        typeof e.code === "number" ? e.code : null,
        answer.status,
      );
      return {
        ok: false,
        error: refusal,
        mayPass: answer.status === 429 || MAY_PASS.test(refusal.details),
      };
    }
    if (answer.status !== 200 || envelope === null || !("result" in envelope)) {
      return {
        ok: false,
        error: new RpcAnswerError(
          method,
          `HTTP ${answer.status} without a result`,
          null,
          answer.status,
        ),
        // 413 means the answer would be too large: asking again changes nothing, asking for less does.
        mayPass: answer.status !== 413,
      };
    }
    return { ok: true, result: envelope.result };
  }

  /**
   * One read, on the first node that serves it. `check` turns the raw result into what the caller
   * wants and throws when the result cannot be right; a node whose answer fails the check is
   * treated like a node that did not answer.
   */
  async read<T>(
    method: ReadMethod,
    params: readonly unknown[],
    check: (result: unknown) => T,
    what: string,
  ): Promise<T> {
    const reasons: string[] = [];
    for (let index = 0; index < this.#urls.length; index++) {
      try {
        return check(await this.requestOn(index, method, params));
      } catch (error) {
        reasons.push(`${this.hosts[index]}: ${reasonOf(error)}`);
      }
    }
    throw new ReadFailedError(what, reasons);
  }

  /**
   * Every log of the given addresses in `[fromBlock, toBlock]`, in chain order, read in chunks of
   * at most `chunkSize` blocks. A range a node finds too large is halved; history a node does not
   * keep is asked of the next node. The read fails when a chunk is served by no node.
   */
  async logs(
    addresses: readonly Address[],
    fromBlock: number,
    toBlock: number,
    chunkSize: number,
  ): Promise<LogsRead> {
    const wanted = addresses.map((address) => address.toLowerCase() as Address);
    const out: ChainLog[] = [];
    let size = Math.max(1, Math.floor(chunkSize));
    let chunks = 0;
    let smallest = size;
    let from = fromBlock;
    while (from <= toBlock) {
      let to = Math.min(toBlock, from + size - 1);
      let served: ChainLog[] | null = null;
      const reasons: string[] = [];
      let history = false;
      for (
        let index = 0;
        index < this.#urls.length && served === null;
        index++
      ) {
        // Each node gets the whole chunk first, whatever the one before it made of it.
        let end = to;
        for (;;) {
          try {
            served = this.#checkLogs(
              await this.requestOn(index, "eth_getLogs", [
                {
                  address: wanted.length === 1 ? wanted[0] : wanted,
                  fromBlock: `0x${from.toString(16)}`,
                  toBlock: `0x${end.toString(16)}`,
                },
              ]),
              wanted,
              from,
              end,
            );
            to = end;
            break;
          } catch (error) {
            // A node that is behind or busy was already asked again; a smaller range would not help it.
            const settled =
              error instanceof BadNodeAnswerError ||
              (error instanceof RpcAnswerError && MAY_PASS.test(error.details));
            const kind = settled ? "other" : classifyLogsError(error);
            if (kind === "range" && end > from) {
              end = from + Math.floor((end - from) / 2);
              continue;
            }
            if (kind === "history") history = true;
            reasons.push(`${this.hosts[index]}: ${reasonOf(error)}`);
            break;
          }
        }
      }
      if (served === null) {
        throw new ReadFailedError(
          `the logs of blocks ${from} to ${to}`,
          reasons,
          history
            ? "A node that keeps old logs is needed: set RPC_URL to one (several URLs separated by commas are tried in order)"
            : "",
        );
      }
      out.push(...served);
      chunks++;
      const width = to - from + 1;
      smallest = Math.min(smallest, width);
      // A node that wanted less keeps getting less: asking for more would only be refused again.
      if (width < size) size = width;
      from = to + 1;
    }
    return { logs: out.sort(compareLogs), chunks, smallestChunk: smallest };
  }

  #checkLogs(
    result: unknown,
    wanted: readonly Address[],
    from: number,
    to: number,
  ): ChainLog[] {
    if (!Array.isArray(result))
      throw new BadNodeAnswerError("eth_getLogs did not return a list");
    const logs: ChainLog[] = [];
    for (const entry of result) {
      const log = toChainLog(entry);
      if (log === null) continue;
      if (!wanted.includes(log.address)) {
        throw new BadNodeAnswerError(
          "eth_getLogs returned a log of an address that was not asked for",
        );
      }
      if (log.blockNumber < from || log.blockNumber > to) {
        throw new BadNodeAnswerError(
          `eth_getLogs returned a log of block ${log.blockNumber}, outside ${from} to ${to}`,
        );
      }
      logs.push(log);
    }
    return logs;
  }
}
