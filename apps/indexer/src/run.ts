/**
 * Puts the pieces together: the database, the chain client, the sync engine, the API mirror and
 * the HTTP server, as one process.
 */
import { assertMainnet, createChainClient, redactRpcUrl } from "./chain/client.js";
import type { Config } from "./config.js";
import { openDatabase, type Database } from "./db/client.js";
import { Indexer } from "./engine/indexer.js";
import { createApp, DEFAULT_STALE_AFTER_MS } from "./http/app.js";
import { serve, type RunningServer } from "./http/server.js";
import { errorMessage, registerSecrets, secretsOfUrl, type Logger } from "./log.js";
import { PoliteFetcher } from "./mirror/politeFetch.js";
import { ApiMirror } from "./mirror/poller.js";
import { ALL_MODULES } from "./modules/index.js";
import { createQueries } from "./queries.js";

export interface Runtime {
  database: Database;
  indexer: Indexer;
  mirror: ApiMirror;
  close(): Promise<void>;
}

/**
 * Tells the logger which strings of the configuration are credentials: the key in an RPC URL's
 * path or query, the password in a database URL. They are then cut out of every log line and
 * error text, whoever wrote it. Call before anything is opened.
 */
export function protectSecrets(config: Config): void {
  for (const url of config.rpcUrls) registerSecrets(secretsOfUrl(url));
  if (config.databaseUrl) registerSecrets(secretsOfUrl(config.databaseUrl, { path: false }));
}

/** Opens everything a command needs. Nothing is fetched yet except the chain id. */
export async function openRuntime(
  config: Config,
  log: Logger,
  options: { checkChain?: boolean; signal?: AbortSignal } = {},
): Promise<Runtime> {
  protectSecrets(config);
  const database = await openDatabase({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir });
  try {
    const client = createChainClient(config.rpcUrls, { log, signal: options.signal });
    if (options.checkChain ?? true) await assertMainnet(client);
    const indexer = new Indexer({
      db: database.db,
      client,
      modules: ALL_MODULES,
      deployments: config.deployments,
      sync: config.sync,
      log,
      signal: options.signal,
    });
    const mirror = new ApiMirror({
      db: database.db,
      fetcher: new PoliteFetcher({ callsPerMinute: config.mirror.callsPerMinute, signal: options.signal }),
      config: config.mirror,
      log,
      signal: options.signal,
    });
    log.info("opened", {
      database: database.where,
      rpc: config.rpcUrls.map(redactRpcUrl),
      modules: indexer.active().map((entry) => entry.module.name),
    });
    return { database, indexer, mirror, close: () => database.close() };
  } catch (error) {
    await database.close();
    throw error;
  }
}

/** Resolves after `ms`, or at once when the signal fires. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Runs until the signal fires: syncs the chain every `pollIntervalMs`, keeps the API mirror
 * fresh, and serves the read-only API. A module that fails is retried by the engine on its own
 * schedule and does not slow the others. Only a pass that could not run at all (the head could
 * not be read) slows the loop: after several in a row the wait grows, up to a minute, so a node
 * that is down is not hammered.
 */
export async function runForever(config: Config, log: Logger, signal: AbortSignal): Promise<void> {
  const runtime = await openRuntime(config, log, { signal });
  let server: RunningServer | null = null;
  try {
    if (config.http.enabled) {
      const app = createApp({
        queries: createQueries(runtime.database.db, { house: config.houseAddresses }),
        live: () => runtime.indexer.live(),
        // A slow poll interval must not make a healthy indexer look stale.
        staleAfterMs: Math.max(DEFAULT_STALE_AFTER_MS, 3 * config.sync.pollIntervalMs),
        mirrorEnabled: config.mirror.enabled,
        log,
      });
      server = await serve(app, { host: config.http.host, port: config.http.port, log });
      log.info("listening", { host: config.http.host, port: server.port });
    }

    const chainLoop = async () => {
      let unreadable = 0;
      while (!signal.aborted) {
        try {
          const report = await runtime.indexer.tick();
          unreadable = 0;
          const logs = report.synced.reduce((sum, progress) => sum + progress.logs, 0);
          if (logs > 0 || report.rewinds.length > 0 || report.failed.length > 0) {
            log.info("synced", {
              head: report.head,
              target: report.target,
              logs,
              rewinds: report.rewinds,
              failed: report.failed,
              waiting: report.waiting,
            });
          } else {
            log.debug("synced", { head: report.head, target: report.target, waiting: report.waiting });
          }
        } catch (error) {
          // Cut short by the shutdown: not a failure, and not worth a line.
          if (signal.aborted) break;
          unreadable++;
          log.error("sync pass failed", { error: errorMessage(error) });
        }
        const backoff =
          unreadable > 2
            ? Math.min(60_000, config.sync.pollIntervalMs * 2 ** Math.min(unreadable - 2, 4))
            : 0;
        await pause(Math.max(config.sync.pollIntervalMs, backoff), signal);
      }
    };

    const mirrorLoop = async () => {
      if (!config.mirror.enabled) return;
      while (!signal.aborted) {
        try {
          const report = await runtime.mirror.runDue();
          if (report.done.length > 0) log.debug("mirrored", { done: report.done });
        } catch (error) {
          log.error("mirror pass failed", { error: errorMessage(error) });
        }
        await pause(5000, signal);
      }
    };

    await Promise.all([chainLoop(), mirrorLoop()]);
  } finally {
    if (server) await server.close();
    await runtime.close();
    log.info("stopped");
  }
}
