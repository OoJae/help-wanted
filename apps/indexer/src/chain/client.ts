/**
 * The viem client the indexer reads the chain with. It only ever reads: no account, no wallet.
 */
import { createPublicClient, fallback, http, type PublicClient, type Transport } from "viem";
import { mainnet } from "viem/chains";
import { CHAIN_ID } from "../constants.js";
import type { Logger } from "../log.js";

export interface ChainClientOptions {
  /**
   * With several URLs, each answer is noted at debug level with the node it came from (its origin
   * only): the log is the one place that shows which node served a backfill.
   */
  log?: Logger;
  /**
   * Fires when the process is stopping: a request in flight is cut off instead of being waited
   * for, so a node that has stopped answering cannot hold up the shutdown.
   */
  signal?: AbortSignal;
}

/**
 * @param rpcUrls One URL, or several in order of preference. With several, a request that one
 * node refuses (for example old logs on a node without history) is tried on the next.
 */
export function createChainClient(rpcUrls: string[], options: ChainClientOptions = {}): PublicClient {
  if (rpcUrls.length === 0) throw new Error("at least one RPC URL is needed");
  const { log, signal } = options;
  const transports = rpcUrls.map((url) =>
    http(url, {
      timeout: 30_000,
      retryCount: 2,
      retryDelay: 400,
      // viem aborts a request on its own timeout; the shutdown signal is added to that one.
      onFetchRequest: signal
        ? (_request, init) => ({
            ...init,
            signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal,
          })
        : undefined,
    }),
  );
  const transport: Transport = transports.length === 1 ? (transports[0] as Transport) : fallback(transports);
  const client = createPublicClient({ chain: mainnet, transport });
  if (log && transports.length > 1) {
    const hooks = client.transport as { onResponse?: (fn: (info: RpcOutcome) => void) => void };
    hooks.onResponse?.(({ method, status, transport: used }) => {
      const url = used?.value?.url;
      log.debug("rpc", {
        method,
        node: typeof url === "string" ? redactRpcUrl(url) : "(unknown)",
        served: status === "success",
      });
    });
  }
  return client;
}

/** What viem's fallback transport reports after each try: which transport, and whether it answered. */
interface RpcOutcome {
  method: string;
  status: "success" | "error";
  transport?: { value?: { url?: unknown } };
}

/** Refuses to run against the wrong network: every address in `constants.ts` is a mainnet one. */
export async function assertMainnet(client: PublicClient): Promise<void> {
  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(
      `the RPC serves chain ${chainId}; this indexer reads Ethereum mainnet (chain ${CHAIN_ID})`,
    );
  }
}

/** An RPC URL without its path or query, which is where providers put the key. For logs only. */
export function redactRpcUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(unreadable RPC URL)";
  }
}

/** A block's hash and timestamp, for naming it in an evidence file. */
export interface BlockRef {
  number: number;
  /** Lowercase. */
  hash: string;
  /** Seconds. */
  time: number;
}

/** The newest block the node calls finalized: one that can no longer be replaced. */
export async function finalizedBlock(client: PublicClient): Promise<BlockRef> {
  const block = await client.getBlock({ blockTag: "finalized" });
  if (block.number === null || block.hash === null) {
    throw new Error("the node did not name a finalized block");
  }
  return { number: Number(block.number), hash: block.hash.toLowerCase(), time: Number(block.timestamp) };
}

/** One block by number. */
export async function blockRef(client: PublicClient, number: number): Promise<BlockRef> {
  const block = await client.getBlock({ blockNumber: BigInt(number) });
  if (block.hash === null) throw new Error(`block ${number} has no hash yet`);
  return { number, hash: block.hash.toLowerCase(), time: Number(block.timestamp) };
}
