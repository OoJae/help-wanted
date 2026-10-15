/**
 * Wires a configuration to a node, IdentityMD's API, the store, the chain writer, the payment flow
 * and the order machine.
 *
 * This is the only place an account is built from the key, and it is built only in live mode: in
 * a dry run there is no object in the process that can sign. In live mode two objects hold it: the
 * wallet client, which signs the runner's own transactions and is used by `ChainWriter` alone, and
 * the guarded signer, which is all the payment library is given. The key text is dropped from the
 * configuration as soon as both exist.
 *
 * The token, the WorkRegistry, Permit2 and IdentityMD's payee are the mainnet ones and cannot be
 * pointed elsewhere from here or from the environment.
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { ImdClient, MAINNET } from "@help-wanted/shared";
import { ChainWriter, type PublicLike, type WalletLike } from "./chain.js";
import { rpcSecrets, type CommandDeps } from "./commands.js";
import { ConfigError, describeConfig, type RunnerConfig } from "./config.js";
import { viemDesk, type ReaderLike } from "./desk.js";
import { createLogger, type Logger } from "./log.js";
import { Machine, type JobApi } from "./machine.js";
import { GuardedSigner, PayFlow, fetchPaidHttp, mainnetTerms, type PaidHttp } from "./pay.js";
import { StoreError, openFileStore, paidToken, spentToday, type Store } from "./store.js";

export interface Runtime extends CommandDeps {
  runnerConfig: RunnerConfig;
  log: Logger;
  machine: Machine;
  store: Store;
}

/** Everything that must never reach the terminal, for the logger and the last-resort error printer. */
export const secrets: (string | null)[] = [];

export interface BuildOptions {
  log?: Logger;
  /** The clock, in unix seconds. A rehearsal on a local node gives the node's time. */
  now?: () => number;
  /** Stand-ins for tests. */
  api?: JobApi;
  payHttp?: PaidHttp;
  /** How long `send` waits for a receipt before it leaves the transaction to the next call. */
  receiptTimeoutMs?: number;
  /** How often the node is asked for a receipt. viem's default suits a public chain, not a test. */
  pollingIntervalMs?: number;
}

export async function buildRuntime(config: RunnerConfig, options: BuildOptions = {}): Promise<Runtime> {
  // The RPC URL often carries a provider key, in its path, its query or its credentials, and viem
  // prints URLs in its errors.
  secrets.push(config.privateKey, config.paidToken, ...rpcSecrets(config.rpcUrl));
  const store = openFileStore(config.storePath, config.workOrders, config.runner);
  if (config.mode === "live") {
    // Before anything is staked: a runner that cannot save what it signed must not sign.
    try {
      store.save();
    } catch (error) {
      throw new StoreError(
        `${config.storePath} cannot be written (${error instanceof Error ? error.message : String(error)}); ` +
          "a live runner needs a store that is writable and that survives a restart",
      );
    }
  }
  const token =
    config.mode === "live" ? paidToken(store, config.paidToken) : (config.paidToken ?? store.data.token);
  secrets.push(token);
  const log = options.log ?? createLogger({ secrets, level: config.logLevel });

  const transport = http(config.rpcUrl, { retryCount: 2, timeout: 30_000 });
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
  let signer: GuardedSigner | null = null;
  if (config.mode === "live" && config.privateKey !== null) {
    const account = privateKeyToAccount(config.privateKey);
    wallet = createWalletClient({ account, chain: mainnet, transport }) as unknown as WalletLike;
    signer = new GuardedSigner(account);
    config.privateKey = null;
  }

  const writer = new ChainWriter({
    mode: config.mode,
    public: publicClient as unknown as PublicLike,
    wallet,
    account: config.runner,
    maxFeePerGas: config.maxFeePerGas,
    maxPriorityFeePerGas: config.maxPriorityFeePerGas,
    maxTxCost: config.maxTxCost,
    urgent: { maxFeePerGas: config.urgentMaxFeePerGas, maxTxCost: config.urgentMaxTxCost },
    killed,
    log,
    ...(options.receiptTimeoutMs === undefined ? {} : { receiptTimeoutMs: options.receiptTimeoutMs }),
    // The transaction that is waiting to be mined is kept in the store, so a restart knows it.
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
  const reader = publicClient as unknown as ReaderLike;
  const desk = viemDesk(
    reader,
    writer,
    { workOrders: config.workOrders, imd: MAINNET.IMD, workRegistry: MAINNET.WORK_REGISTRY },
    config.runner,
  );
  const api = options.api ?? new ImdClient({ baseUrl: config.apiBase, userAgent: "help-wanted-runner/0.1" });

  const payHttp = options.payHttp ?? fetchPaidHttp();
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const machine = new Machine({
    config,
    store,
    desk,
    api,
    payFlow:
      signer !== null && token !== null && config.runner !== null
        ? (hooks) =>
            new PayFlow({
              http: payHttp,
              signer,
              token,
              terms: mainnetTerms(config.runner as `0x${string}`, config.orderCap, config.apiBase),
              now,
              log,
              persist: hooks.persist,
              reserve: hooks.reserve,
              release: hooks.release,
              mayPay: hooks.mayPay,
              extraInputKeys: config.preparedInputExtraKeys,
              onChallenge: (seen) => {
                // What the protocol answered, beside the store and readable by its owner only.
                if (!/^[0-9a-f-]{36}$/.test(seen.requestId)) return;
                writeFileSync(
                  join(dirname(config.storePath), `challenge-${seen.requestId}.json`),
                  `${JSON.stringify(seen, null, 2)}\n`,
                  { mode: 0o600 },
                );
              },
            })
        : null,
    now,
    log,
    killed,
  });
  log.info("runner started", {
    ...describeConfig(config),
    killed: killed(),
    spentToday: spentToday(store, now()).toString(),
  });
  if (config.mode === "dry-run") {
    log.info(`DRY RUN (${config.dryRunReason}): nothing will be signed and nothing will be sent`);
  } else if (config.paidToken === null) {
    log.warn(
      "IMD_PAID_TOKEN is not set: the request token lives only in the store file. Set it for a hosted run, so a lost store cannot lose it",
    );
  }
  return {
    runnerConfig: config,
    config,
    log,
    machine,
    store,
    reader,
    send: (call) => writer.send(call),
    killed,
    notes: () => ({
      spentToday: spentToday(store, now()).toString(),
      ...(store.data.breaker === undefined ? {} : { breaker: store.data.breaker }),
      ...(store.data.employerLosses === undefined ? {} : { employerLosses: store.data.employerLosses }),
      ...(store.data.pendingTx === undefined ? {} : { waitingTransaction: store.data.pendingTx }),
      ...(store.data.discoveryFailures === undefined
        ? {}
        : { logReadsFailedInARow: store.data.discoveryFailures }),
    }),
  };
}
