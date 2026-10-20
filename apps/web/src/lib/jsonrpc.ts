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

/** An `eth_call` that carries a sender and ETH, as a simulated payable call needs. */
export interface CallRequest {
  to: string;
  data: Hex;
  from?: string;
  value?: bigint;
}

/** Balances given to addresses for the length of one simulated call (an `eth_call` state override). */
export type StateOverrides = Record<string, { balance: string }>;

export interface EthReader {
  /** `eth_call` at the latest block. */
  call(to: string, data: Hex): Promise<Hex>;
  /**
   * `eth_call` with a sender, ETH and state overrides, for a quote that must not depend on what
   * the asker holds. Optional: a reader without it cannot quote.
   */
  callWith?(request: CallRequest, overrides?: StateOverrides): Promise<Hex>;
  /**
   * `eth_estimateGas` for a call at the latest block: the gas it would use now. Optional: a reader
   * without it cannot estimate, and nothing is said of the cost.
   */
  estimateGas?(request: CallRequest): Promise<bigint>;
  /** `eth_gasPrice`: the node's suggested price of one unit of gas, in wei. Optional, as above. */
  gasPrice?(): Promise<bigint>;
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
    callWith: (call, overrides) =>
      request<Hex>("eth_call", [
        {
          to: call.to,
          data: call.data,
          ...(call.from ? { from: call.from } : {}),
          ...(call.value !== undefined ? { value: toQuantity(call.value) } : {}),
        },
        "latest",
        ...(overrides ? [overrides] : []),
      ]),
    estimateGas: async (call) =>
      BigInt(
        await request<string>("eth_estimateGas", [
          {
            to: call.to,
            data: call.data,
            ...(call.from ? { from: call.from } : {}),
            ...(call.value !== undefined ? { value: toQuantity(call.value) } : {}),
          },
        ]),
      ),
    gasPrice: async () => BigInt(await request<string>("eth_gasPrice", [])),
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
  const callWith = reader.callWith?.bind(reader);
  const estimateGas = reader.estimateGas?.bind(reader);
  const gasPrice = reader.gasPrice?.bind(reader);
  return {
    call: (to, data) => run(() => reader.call(to, data)),
    ...(callWith
      ? { callWith: (call: CallRequest, overrides?: StateOverrides) => run(() => callWith(call, overrides)) }
      : {}),
    ...(estimateGas ? { estimateGas: (call: CallRequest) => run(() => estimateGas(call)) } : {}),
    ...(gasPrice ? { gasPrice: () => run(() => gasPrice()) } : {}),
    blockNumber: () => run(() => reader.blockNumber()),
    getLogs: (filter) => run(() => reader.getLogs(filter)),
    blockTimestamp: (block) => run(() => reader.blockTimestamp(block)),
    getCode: (address) => run(() => reader.getCode(address)),
  };
}
