/**
 * Wires a configuration to a node, IdentityMD's API, the state file and the chain writer.
 *
 * This is the only place an account is built from the key, and it is built only in live mode: in
 * a dry run there is no object in the process that can sign. The key text is dropped from the
 * configuration as soon as the wallet client holds the account.
 */
import { existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { ImdClient } from "@help-wanted/shared";
import { ChainWriter, type PublicLike, type WalletLike } from "./chain.js";
import { ConfigError, describeConfig, type KeeperConfig } from "./config.js";
import { createLogger, type Logger } from "./log.js";
import { newCache, type Reader, type ServiceApi } from "./observe/common.js";
import type { Runtime } from "./pass.js";
import { memoryStore, openFileStore, spendLimit, StoreError, type Store } from "./store.js";

/** Everything that must never reach the terminal, for the logger and the last-resort error printer. */
export const secrets: (string | null)[] = [];

/**
 * Everything in an RPC URL that may be a provider key, for the log's redaction list: the URL
 * itself when it has a path, a query or credentials, and each long piece of those on its own.
 * viem prints the request URL in its errors, and a key can sit in any of the three places.
 */
export function rpcSecrets(rpcUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    return [];
  }
  const carriesKey =
    url.pathname.length > 1 || url.search.length > 1 || url.username !== "" || url.password !== "";
  if (!carriesKey) return [];
  const out = new Set<string>([rpcUrl, url.href, `${url.pathname}${url.search}`]);
  for (const segment of url.pathname.split("/")) out.add(segment);
  for (const value of url.searchParams.values()) out.add(value);
  out.add(url.password);
  out.add(decodeURIComponent(url.password));
  out.add(url.username);
  // Short pieces are words, not keys; the logger ignores anything under sixteen characters.
  return [...out].filter((piece) => piece.length >= 16);
}

export interface BuildOptions {
  log?: Logger;
  /** The wall clock in unix seconds. */
  now?: () => number;
  /** Stand-ins for tests. */
  api?: ServiceApi;
  store?: Store;
  receiptTimeoutMs?: number;
  /** How often the node is asked for a receipt. viem's default suits a public chain, not a test. */
  pollingIntervalMs?: number;
}

export async function buildRuntime(config: KeeperConfig, options: BuildOptions = {}): Promise<Runtime> {
  // The RPC URL often carries a provider key, in its path, its query or its credentials.
  secrets.push(config.privateKey, ...rpcSecrets(config.rpcUrl));
  const log = options.log ?? createLogger({ secrets, level: config.logLevel });
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  let store: Store;
  if (options.store !== undefined) store = options.store;
  else {
    try {
      store = openFileStore(config.statePath);
      // Before anything is sent: a keeper that cannot record what it spent must not spend.
      store.save();
    } catch (error) {
      if (config.mode === "live") {
        throw new StoreError(
          `${error instanceof Error ? error.message : String(error)}; a live keeper needs a state file that is writable and that survives a restart`,
        );
      }
      log.warn("the state file cannot be used; this dry run keeps its notes in memory", {
        path: config.statePath,
        error: error instanceof Error ? error.message : String(error),
      });
      store = memoryStore();
    }
  }

  const transport = http(config.rpcUrl, {
    retryCount: 2,
    timeout: 30_000,
    // A pass makes about fifty small reads at one block; in batches they are a few requests.
    ...(config.rpcBatch ? { batch: { batchSize: 32, wait: 8 } } : {}),
  });
  const publicClient = createPublicClient({
    chain: mainnet,
    transport,
    ...(options.pollingIntervalMs === undefined ? {} : { pollingInterval: options.pollingIntervalMs }),
  });
  const chainId = await publicClient.getChainId();
  if (chainId !== config.chainId)
    throw new ConfigError(`RPC_URL serves chain ${chainId}, not ${config.chainId}`);

  const killed = () => config.killSwitch || existsSync(config.killFile);

  let wallet: WalletLike | null = null;
  if (config.mode === "live" && config.privateKey !== null) {
    const account = privateKeyToAccount(config.privateKey);
    wallet = createWalletClient({ account, chain: mainnet, transport }) as unknown as WalletLike;
    config.privateKey = null;
  }

  const writer = new ChainWriter({
    mode: config.mode,
    public: publicClient as unknown as PublicLike,
    wallet,
    account: config.keeper,
    maxFeePerGas: config.maxFeePerGas,
    maxPriorityFeePerGas: config.maxPriorityFeePerGas,
    maxTxCost: config.maxTxCost,
    spend: spendLimit(store, config.dailySpendCap, now),
    killed,
    log,
    ...(options.receiptTimeoutMs === undefined ? {} : { receiptTimeoutMs: options.receiptTimeoutMs }),
    // The transaction that is waiting to be mined is kept in the state file, so a restart knows it.
    memory: {
      get: () => {
        const kept = store.data.pendingTx;
        return kept === undefined ? null : { ...kept, hashes: kept.hashes as Hex[] };
      },
      set: (pending) => {
        if (pending === null) delete store.data.pendingTx;
        else store.data.pendingTx = pending;
        store.save();
      },
    },
  });

  const api =
    options.api ??
    new ImdClient({
      baseUrl: config.apiBase,
      userAgent: "help-wanted-keeper/0.1",
      minIntervalMs: config.apiMinIntervalMs,
    });

  log.info("keeper started", { ...describeConfig(config), killed: killed() });
  if (config.mode === "dry-run") {
    log.info(`DRY RUN (${config.dryRunReason}): nothing will be signed and nothing will be sent`);
  }
  return {
    config,
    reader: publicClient as unknown as Reader,
    api,
    store,
    writer,
    log,
    cache: newCache(),
    killed,
    now,
  };
}
