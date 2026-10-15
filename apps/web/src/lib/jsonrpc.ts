/**
 * The few JSON-RPC reads the site makes, over plain `fetch`, so the same code runs on the server
 * and in a visitor's browser. Nothing here can sign or send a transaction.
 */
import type { Hex } from "viem";
import { UpstreamBusyError, type Breaker, type SlidingWindowLimiter } from "./cache";

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  /** Present on nodes that add it (the public RPC we default to does); absent on older ones. */
  blockTimestamp?: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

export interface LogFilter {
  address: string;
  topics: (string | string[] | null)[];
  fromBlock: bigint;
  toBlock: bigint;
}

export interface EthReader {
  /** `eth_call` at the latest block. */
  call(to: string, data: Hex): Promise<Hex>;
  blockNumber(): Promise<bigint>;
  getLogs(filter: LogFilter): Promise<RawLog[]>;
  /** The timestamp of a block in seconds, or null when the node does not have the block. */
  blockTimestamp(block: bigint): Promise<number | null>;
  /** The deployed code at an address (`0x` for none). */
  getCode(address: string): Promise<Hex>;
}

export class RpcError extends Error {
  readonly code: number | null;

  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

export interface RpcOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function toQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

/** A reader over one JSON-RPC endpoint. Each call is one POST; nothing is retried here. */
export function createEthReader(url: string, options: RpcOptions = {}): EthReader {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  // A page waits for this at most once: after a failure the caches and the breaker answer at once.
  const timeoutMs = options.timeoutMs ?? 4_000;
  let nextId = 1;

  async function request<T>(method: string, params: unknown[]): Promise<T> {
    const response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new RpcError(`${method} answered HTTP ${response.status}`);
    const body = (await response.json()) as { result?: T; error?: { code?: number; message?: string } };
    if (body.error)
      throw new RpcError(`${method}: ${body.error.message ?? "error"}`, body.error.code ?? null);
    if (body.result === undefined) throw new RpcError(`${method} returned no result`);
    return body.result;
  }

  return {
    call: (to, data) => request<Hex>("eth_call", [{ to, data }, "latest"]),
    blockNumber: async () => BigInt(await request<string>("eth_blockNumber", [])),
    getLogs: (filter) =>
      request<RawLog[]>("eth_getLogs", [
        {
          address: filter.address,
          topics: filter.topics,
          fromBlock: toQuantity(filter.fromBlock),
          toBlock: toQuantity(filter.toBlock),
        },
      ]),
    blockTimestamp: async (block) => {
      const result = await request<{ timestamp?: string } | null>("eth_getBlockByNumber", [
        toQuantity(block),
        false,
      ]);
      return result?.timestamp ? Number(BigInt(result.timestamp)) : null;
    },
    getCode: (address) => request<Hex>("eth_getCode", [address, "latest"]),
  };
}

export interface ReaderGuards {
  /** What the endpoint is called in messages: "The Ethereum RPC". */
  name: string;
  /** Every request counts against this. */
  all: SlidingWindowLimiter;
  /** Requests a visitor can cause one by one count against this too. Null for a reader with no such share. */
  visitor: SlidingWindowLimiter | null;
  breaker: Breaker;
}

/**
 * Puts a per-minute ceiling and a breaker in front of a reader, so that no amount of page views can
 * make this server send more than the ceiling to the RPC, and an RPC that is not answering is left
 * alone instead of being waited for by every page.
 *
 * A JSON-RPC error (a reverted call, a refused filter) is an answer and does not trip the breaker;
 * only a request that got no usable answer does.
 */
export function guardReader(reader: EthReader, guards: ReaderGuards): EthReader {
  async function run<T>(request: () => Promise<T>): Promise<T> {
    guards.breaker.check();
    if (guards.visitor) {
      const share = guards.visitor.take();
      if (!share.ok) throw new UpstreamBusyError(guards.name, share.retryAfterMs);
    }
    const slot = guards.all.take();
    if (!slot.ok) throw new UpstreamBusyError(guards.name, slot.retryAfterMs);
    try {
      const value = await request();
      guards.breaker.succeeded();
      return value;
    } catch (error) {
      if (error instanceof RpcError && error.code !== null) guards.breaker.succeeded();
      else guards.breaker.failed(error);
      throw error;
    }
  }
  return {
    call: (to, data) => run(() => reader.call(to, data)),
    blockNumber: () => run(() => reader.blockNumber()),
    getLogs: (filter) => run(() => reader.getLogs(filter)),
    blockTimestamp: (block) => run(() => reader.blockTimestamp(block)),
    getCode: (address) => run(() => reader.getCode(address)),
  };
}
