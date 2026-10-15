/**
 * The sync engine.
 *
 * For each module it keeps a cursor (the next block to read), asks the node for the module's logs
 * in bounded block ranges, stores each log once, folds it into the module's tables and moves the
 * cursor, all in one database transaction per range. A crash between ranges loses nothing, and
 * reading a range again repeats nothing: a log is keyed by its transaction hash and log index, a
 * log that is already stored is not folded a second time, and the handlers write by upsert.
 *
 * Coverage. A module's cursor names one unbroken block range, `[start_block, next_block)`, and
 * the module's tables are the fold of the logs inside it. The range grows upwards by syncing and
 * downwards by `backfill`; `skip` gives it up and starts a new one further on. A log stored
 * outside it (fetched by a backfill that has not finished, or left behind by `skip`) is kept and
 * counts for nothing.
 *
 * Reorganisations. Every stored log carries the hash of its block. Each time a module syncs, the
 * same `eth_getLogs` call that fetches the new blocks also covers the last `reorgDepth` blocks it
 * has already synced, and that part of the answer is compared with what is stored. If a stored log
 * has gone, or sits in a block with another hash, or the chain now has a log that was not there
 * before, the chain was reorganised: everything from the first differing block up is deleted, for
 * every module, the cursors go back to that block, the affected tables are rebuilt from the events
 * that remain, and the range is read again. The comparison costs no extra request.
 *
 * Failures. A module that fails is reported and does not stop the others; after three failed
 * passes in a row it is left alone for a growing interval, so a module that cannot recover does
 * not cost the healthy ones their cadence. A single log whose handler throws does not fail the
 * module at all: see `foldEvent`.
 */
import { and, eq, gt, isNotNull, lt, sql } from "drizzle-orm";
import type { PublicClient } from "viem";
import {
  BadNodeAnswerError,
  classifyLogsError,
  getLogsAdaptive,
  HistoryUnavailableError,
  isBlockTime,
  type ChainLog,
} from "../chain/logs.js";
import { resolveStartBlock, type StartBlock, type SyncConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { cursors, events } from "../db/core.js";
import type { Deployments } from "../deployments.js";
import { errorMessage, publicErrorMessage, silentLogger, type Logger } from "../log.js";
import type { ContractModule, LogFilter } from "./module.js";
import {
  firstMismatch,
  foldEvent,
  insertEvent,
  replayModule,
  storedIdentities,
  toIndexedEvent,
  type ReplayResult,
} from "./store.js";

export interface IndexerOptions {
  db: Db;
  client: PublicClient;
  modules: ContractModule[];
  deployments: Deployments;
  sync: SyncConfig;
  log?: Logger;
  /**
   * Fires when the process is stopping. A pass in hand ends by throwing instead of going on to
   * the next module, and a request the shutdown cut off is not written down as a module's failure.
   */
  signal?: AbortSignal;
  /** Epoch milliseconds. Injected by tests. */
  now?: () => number;
}

export interface ModuleProgress {
  module: string;
  /** The inclusive block range read by this call. `toBlock < fromBlock` means nothing was due. */
  fromBlock: number;
  toBlock: number;
  /** Logs stored from that range. */
  logs: number;
  /** `eth_getLogs` calls made, refused ones included. */
  requests: number;
  /** Logs of that range whose handler threw: stored, in no table, the reason kept on the event. */
  unfolded: number;
}

export interface TickReport {
  head: number;
  /** The block this tick synced to: the head less the confirmations. */
  target: number;
  /** Reorganisations handled: the module that noticed, and the last block that was kept. */
  rewinds: { module: string; keptThrough: number }[];
  synced: ModuleProgress[];
  failed: { module: string; error: string }[];
  /** Modules left alone this pass because they keep failing, and for how much longer. */
  waiting: { module: string; retryInMs: number }[];
}

export interface ModuleLive {
  module: string;
  title: string;
  /** False while the module has no address to read (one of our contracts before its launch). */
  enabled: boolean;
  /** True while the module's handler is a placeholder. */
  stub: boolean;
  chunkSize: number;
  /** The last failure in words that are safe to publish (see `publicErrorMessage`); null after a good sync. */
  lastError: string | null;
  lastErrorAtMs: number | null;
  lastSyncedAtMs: number | null;
  /** Failed passes in a row. */
  failures: number;
  /** While the module is being left alone after repeated failures: when it is tried again. */
  retryAtMs: number | null;
}

export interface IndexerLive {
  /** The newest block number the node reported, and when it did. */
  head: number | null;
  headAtMs: number | null;
  target: number | null;
  /** When the last pass began, whether or not it got as far as reading the head. */
  lastTickAtMs: number | null;
  /**
   * Whether the last pass that ended synced every module: false when it could not read the head,
   * when a module failed, or when one was left waiting. Null before the first pass has ended.
   */
  lastTickOk: boolean | null;
  /** When a pass last ended with every module synced. */
  lastOkTickAtMs: number | null;
  /** Why the last pass could not run at all (the head could not be read), in publishable words. */
  lastTickError: string | null;
  modules: ModuleLive[];
}

export interface SkipResult {
  module: string;
  /** The coverage that was given up, inclusive; null when the module had read nothing. */
  gaveUp: { fromBlock: number; throughBlock: number } | null;
  /** Coverage starts again here. */
  restartsAt: number;
  /** Logs of the module still stored below that block. They are kept and count for nothing. */
  eventsLeftOutside: number;
}

interface Header {
  hash: string;
  timestamp: number;
}

interface ModuleState {
  lastError: string | null;
  lastErrorAtMs: number | null;
  lastSyncedAtMs: number | null;
  failures: number;
  retryAtMs: number | null;
}

/** Thrown inside a module's sync when the stored blocks no longer match the chain. */
class ChainReorganised extends Error {
  readonly keepThrough: number;
  constructor(keepThrough: number) {
    super(`the chain was reorganised above block ${keepThrough}`);
    this.name = "ChainReorganised";
    this.keepThrough = keepThrough;
  }
}

/** A module that must begin at its contract's deployment block was given no start block. */
export class MissingStartBlockError extends Error {
  readonly publicMessage: string;

  constructor(module: string) {
    super(
      `module "${module}" has no start block. Its tables are folded from the contract's first event on, so it ` +
        `must begin at the block the contract was deployed in: set START_BLOCK_${module.toUpperCase()}, or give ` +
        `the block with the address (ADDR_…=0x…@<block>).`,
    );
    this.name = "MissingStartBlockError";
    this.publicMessage = this.message;
  }
}

/** A tick gives up after this many rewinds and tries again on the next one. */
const MAX_REWINDS_PER_TICK = 3;
/** A range size is tried again at double only after this many clean requests in a row. */
const GROW_AFTER = 10;
/** After this many failed ticks in a row for a reason we do not recognise, try a smaller range. */
const SHRINK_AFTER_FAILURES = 3;
/** From this many failed passes in a row, a module is left alone for a while before the next try. */
const BACKOFF_FROM_FAILURES = 3;
/** The longest a failing module is left alone. */
export const MAX_MODULE_BACKOFF_MS = 5 * 60_000;

export class Indexer {
  readonly #db: Db;
  readonly #client: PublicClient;
  readonly #modules: ContractModule[];
  readonly #deployments: Deployments;
  readonly #sync: SyncConfig;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #signal: AbortSignal | null;

  readonly #chunk = new Map<string, number>();
  readonly #cleanRequests = new Map<string, number>();
  /** Failures for a reason we do not recognise, counted towards trying a smaller range. */
  readonly #unknownFailures = new Map<string, number>();
  readonly #state = new Map<string, ModuleState>();
  #head: number | null = null;
  #headAtMs: number | null = null;
  #target: number | null = null;
  #lastTickAtMs: number | null = null;
  #lastTickOk: boolean | null = null;
  #lastOkTickAtMs: number | null = null;
  #lastTickError: string | null = null;

  constructor(options: IndexerOptions) {
    const names = new Set<string>();
    for (const module of options.modules) {
      if (!/^[a-z][a-z0-9_]*$/.test(module.name))
        throw new Error(`module name "${module.name}" must be snake_case`);
      if (names.has(module.name)) throw new Error(`two modules are named "${module.name}"`);
      names.add(module.name);
    }
    this.#db = options.db;
    this.#client = options.client;
    this.#modules = options.modules;
    this.#deployments = options.deployments;
    this.#sync = options.sync;
    this.#log = options.log ?? silentLogger;
    this.#now = options.now ?? Date.now;
    this.#signal = options.signal ?? null;
  }

  /** The modules that have something to read, with their filters. */
  active(): { module: ContractModule; filter: LogFilter }[] {
    const out: { module: ContractModule; filter: LogFilter }[] = [];
    for (const module of this.#modules) {
      const filter = module.filter(this.#deployments);
      if (filter) out.push({ module, filter });
    }
    return out;
  }

  /** What the engine knows without asking the database: for the status page. */
  live(): IndexerLive {
    return {
      head: this.#head,
      headAtMs: this.#headAtMs,
      target: this.#target,
      lastTickAtMs: this.#lastTickAtMs,
      lastTickOk: this.#lastTickOk,
      lastOkTickAtMs: this.#lastOkTickAtMs,
      lastTickError: this.#lastTickError,
      modules: this.#modules.map((module) => {
        const state = this.#state.get(module.name);
        return {
          module: module.name,
          title: module.title,
          enabled: module.filter(this.#deployments) !== null,
          stub: module.stub === true,
          chunkSize: this.#chunkOf(module.name),
          lastError: state?.lastError ?? null,
          lastErrorAtMs: state?.lastErrorAtMs ?? null,
          lastSyncedAtMs: state?.lastSyncedAtMs ?? null,
          failures: state?.failures ?? 0,
          retryAtMs: state?.retryAtMs ?? null,
        };
      }),
    };
  }

  /**
   * One pass: read the head, then bring every active module up to `head - confirmations`. A module
   * that fails is reported and does not stop the others. If the head itself cannot be read the
   * pass throws, and `live()` says so (`lastTickOk: false`, `lastTickError`): a node that has gone
   * away must not leave the last good pass standing as the current state.
   *
   * `lastTickOk` speaks of the last pass that ended, so it does not flicker while a pass is under
   * way. A pass that never ends (a request that hangs) is caught by the age of the last good one,
   * `lastOkTickAtMs`, which the status route checks.
   */
  async tick(): Promise<TickReport> {
    this.#lastTickAtMs = this.#now();
    try {
      const report = await this.#pass();
      this.#lastTickError = null;
      this.#lastTickOk = report.failed.length === 0 && report.waiting.length === 0;
      if (this.#lastTickOk) this.#lastOkTickAtMs = this.#now();
      return report;
    } catch (error) {
      // Nothing is concluded from a pass the shutdown cut short.
      if (!this.#signal?.aborted) {
        this.#lastTickOk = false;
        this.#lastTickError = publicErrorMessage(error);
      }
      throw error;
    }
  }

  async #pass(): Promise<TickReport> {
    // viem remembers the block number for a few seconds by default; a sync wants the node's answer.
    const head = Number(await this.#client.getBlockNumber({ cacheTime: 0 }));
    const target = head - this.#sync.confirmations;
    const report: TickReport = { head, target, rewinds: [], synced: [], failed: [], waiting: [] };
    this.#head = head;
    this.#headAtMs = this.#now();
    this.#target = target;
    if (target < 0) return report;

    // Fetched once and shared: the block every module is about to catch up to. A node that does
    // not have it yet is behind the one that reported the head, and the tick is not worth making.
    const tip = await this.#header(target);

    const active = this.active();
    passes: for (;;) {
      report.synced = [];
      report.failed = [];
      report.waiting = [];
      for (const { module, filter } of active) {
        if (this.#signal?.aborted) throw new Error("the process is stopping");
        const state = this.#stateOf(module.name);
        const retryInMs = state.retryAtMs === null ? 0 : state.retryAtMs - this.#now();
        if (retryInMs > 0) {
          report.waiting.push({ module: module.name, retryInMs });
          continue;
        }
        try {
          report.synced.push(await this.#syncModule(module, filter, head, target, tip));
          this.#unknownFailures.set(module.name, 0);
          this.#state.set(module.name, {
            lastError: null,
            lastErrorAtMs: null,
            lastSyncedAtMs: this.#now(),
            failures: 0,
            retryAtMs: null,
          });
        } catch (error) {
          if (error instanceof ChainReorganised) {
            await this.rewindTo(error.keepThrough);
            report.rewinds.push({ module: module.name, keptThrough: error.keepThrough });
            this.#log.warn("chain reorganised; rewound", {
              module: module.name,
              keptThrough: error.keepThrough,
            });
            if (report.rewinds.length >= MAX_REWINDS_PER_TICK) {
              report.failed.push({
                module: module.name,
                error: "the chain kept changing; trying again next tick",
              });
              break passes;
            }
            // Every cursor may have moved back, so start the pass again.
            continue passes;
          }
          if (this.#signal?.aborted) throw error;
          this.#fail(module, error);
          report.failed.push({ module: module.name, error: errorMessage(error) });
        }
      }
      break;
    }
    return report;
  }

  /**
   * Discards everything above `keepThrough` for every module: the events, the rows folded from
   * them (by rebuilding each affected module's tables from the events that remain) and the
   * cursors' progress past that block.
   */
  async rewindTo(keepThrough: number): Promise<{ deleted: number; modules: string[] }> {
    const result = await this.#db.transaction(async (tx) => {
      const gone = await tx
        .delete(events)
        .where(gt(events.blockNumber, keepThrough))
        .returning({ module: events.module });
      const affected = [...new Set(gone.map((row) => row.module))].sort();

      // A cursor never goes below its own start block.
      await tx
        .update(cursors)
        .set({
          nextBlock: sql`GREATEST(${cursors.startBlock}, ${keepThrough + 1})`,
          tipHash: null,
          tipTime: null,
          updatedAtMs: this.#now(),
        })
        .where(gt(cursors.nextBlock, keepThrough + 1));
      // A backfill whose stored part reached above the kept block has lost logs: it starts over.
      await tx
        .update(cursors)
        .set({ backfillFrom: null, backfillNext: null })
        .where(and(isNotNull(cursors.backfillNext), gt(cursors.backfillNext, keepThrough + 1)));

      for (const name of affected) {
        const module = this.#modules.find((candidate) => candidate.name === name);
        if (module) await replayModule(tx, module);
      }
      return { deleted: gone.length, modules: affected };
    });
    this.#forgetFailures();
    return result;
  }

  /**
   * Reads an older range for one module: from `fromBlock` up to where the module already starts.
   * The range must end where the stored range begins, so coverage stays one unbroken interval.
   *
   * The logs are stored range by range, each with a note of how far the backfill has got, and
   * stay outside the module's coverage (in no table) until the whole range is in. Only then, in
   * one transaction, is `start_block` lowered and the module's tables rebuilt in chain order. An
   * interrupted backfill therefore changes nothing a reader can see, and running it again with
   * the same `fromBlock` continues where it stopped.
   */
  async backfill(moduleName: string, fromBlock: number): Promise<ModuleProgress> {
    const entry = this.active().find((candidate) => candidate.module.name === moduleName);
    if (!entry) throw new Error(`module "${moduleName}" is unknown or has no address to read yet`);
    const { module, filter } = entry;

    const [cursor] = await this.#db.select().from(cursors).where(eq(cursors.module, module.name));
    if (!cursor) {
      throw new Error(
        `module "${moduleName}" has not synced yet, so there is nothing to extend: run "once" first, or set ` +
          `START_BLOCK_${moduleName.toUpperCase()} before its first run`,
      );
    }
    const progress: ModuleProgress = {
      module: module.name,
      fromBlock,
      toBlock: cursor.startBlock - 1,
      logs: 0,
      requests: 0,
      unfolded: 0,
    };
    if (fromBlock >= cursor.startBlock) return { ...progress, toBlock: fromBlock - 1 };

    const resumes =
      cursor.backfillFrom === fromBlock &&
      cursor.backfillNext !== null &&
      cursor.backfillNext > fromBlock &&
      cursor.backfillNext <= cursor.startBlock;
    let next = resumes ? (cursor.backfillNext as number) : fromBlock;
    if (resumes) this.#log.info("backfill continues", { module: module.name, fromBlock: next });

    while (next < cursor.startBlock) {
      const end = Math.min(cursor.startBlock - 1, next + this.#chunkOf(module.name) - 1);
      let logs: ChainLog[];
      try {
        logs = await this.#fetchAll(module, filter, next, end, progress);
      } catch (error) {
        if (error instanceof HistoryUnavailableError) {
          throw error.withAdvice(
            `Point RPC_URL at a node that keeps old logs, or backfill from a later block. What was fetched is ` +
              `kept: the same command continues from block ${next}.`,
          );
        }
        throw error;
      }
      await this.#store(module, logs, { kind: "backfill", from: fromBlock, next: end + 1 });
      progress.logs += logs.length;
      this.#log.info("backfilled", { module: module.name, fromBlock: next, toBlock: end, logs: logs.length });
      next = end + 1;
    }

    const startTime = await this.#header(fromBlock).then(
      (header) => header.timestamp,
      () => null,
    );
    const replayed = await this.#db.transaction(async (tx) => {
      await tx
        .update(cursors)
        .set({
          startBlock: fromBlock,
          startTime,
          backfillFrom: null,
          backfillNext: null,
          updatedAtMs: this.#now(),
        })
        .where(eq(cursors.module, module.name));
      return replayModule(tx, module);
    });
    this.#forgetFailures(module.name);
    return { ...progress, unfolded: replayed.unfolded };
  }

  /**
   * Gives up a module's coverage and starts it again at `to`: the way forward when the node no
   * longer serves the blocks the cursor stopped at (the free node keeps about 30 hours of logs).
   *
   * The blocks in between are never read, so the old and the new range cannot be one unbroken
   * coverage. Rather than keep a range with a hole in it, the old one is dropped from the books:
   * coverage begins at `to`, the module's tables are emptied (they fill again from `to`), and the
   * logs already stored stay in `events`, outside coverage, counting for nothing. Nothing is
   * deleted: a later `backfill` through a node with history brings the whole range back.
   *
   * @param to A block number, or how many blocks behind the head. Must lie above what the module
   * has read (`rewind` is the command for going back) and not above the head.
   */
  async skip(moduleName: string, to: StartBlock): Promise<SkipResult> {
    const module = this.#modules.find((candidate) => candidate.name === moduleName);
    if (!module) throw new Error(`unknown module "${moduleName}"`);
    const [cursor] = await this.#db.select().from(cursors).where(eq(cursors.module, module.name));
    if (!cursor) {
      throw new Error(
        `module "${moduleName}" has stored nothing yet, so there is nothing to skip: its first run begins at ` +
          `START_BLOCK_${moduleName.toUpperCase()} (or START_BLOCK)`,
      );
    }
    const head = Number(await this.#client.getBlockNumber({ cacheTime: 0 }));
    const restartsAt = resolveStartBlock(to, head);
    if (restartsAt > head) throw new Error(`block ${restartsAt} is above the head (${head})`);
    if (restartsAt <= cursor.nextBlock) {
      throw new Error(
        `module "${moduleName}" has already read through block ${cursor.nextBlock - 1}; skip only moves ` +
          `forward (to go back, use rewind)`,
      );
    }
    const startTime = await this.#header(restartsAt).then(
      (header) => header.timestamp,
      () => null,
    );
    const result = await this.#db.transaction(async (tx) => {
      await tx
        .update(cursors)
        .set({
          startBlock: restartsAt,
          startTime,
          nextBlock: restartsAt,
          tipHash: null,
          tipTime: null,
          backfillFrom: null,
          backfillNext: null,
          updatedAtMs: this.#now(),
        })
        .where(eq(cursors.module, module.name));
      // Nothing is inside the new coverage yet, so this empties the module's tables.
      await replayModule(tx, module);
      const eventsLeftOutside = await tx.$count(
        events,
        and(eq(events.module, module.name), lt(events.blockNumber, restartsAt)),
      );
      return { eventsLeftOutside };
    });
    this.#forgetFailures(module.name);
    this.#log.warn("coverage restarted", { module: module.name, restartsAt });
    return {
      module: module.name,
      gaveUp:
        cursor.nextBlock > cursor.startBlock
          ? { fromBlock: cursor.startBlock, throughBlock: cursor.nextBlock - 1 }
          : null,
      restartsAt,
      eventsLeftOutside: result.eventsLeftOutside,
    };
  }

  /**
   * Rebuilds modules' tables from the stored events: after a handler or an ABI changed. Events a
   * handler could not fold before are tried again.
   * @returns events folded and events the handler still could not fold, per module.
   */
  async reproject(moduleNames?: string[]): Promise<Record<string, ReplayResult>> {
    const chosen = moduleNames
      ? moduleNames.map((name) => {
          const found = this.#modules.find((module) => module.name === name);
          if (!found) throw new Error(`unknown module "${name}"`);
          return found;
        })
      : this.#modules;
    const result: Record<string, ReplayResult> = {};
    for (const module of chosen) {
      result[module.name] = await this.#db.transaction((tx) => replayModule(tx, module));
    }
    this.#forgetFailures();
    return result;
  }

  // -----------------------------------------------------------------------------------------------

  async #syncModule(
    module: ContractModule,
    filter: LogFilter,
    head: number,
    target: number,
    tip: Header,
  ): Promise<ModuleProgress> {
    const [existing] = await this.#db.select().from(cursors).where(eq(cursors.module, module.name));
    // A module's cursor is written with the first range that is stored, not before: if the first
    // query is refused (a start block the node no longer serves) nothing is left behind, and a
    // corrected START_BLOCK takes effect on the next run.
    let stored = existing !== undefined;
    const startBlock = existing?.startBlock ?? this.#firstBlock(module, head);
    const progress: ModuleProgress = {
      module: module.name,
      fromBlock: existing?.nextBlock ?? startBlock,
      toBlock: (existing?.nextBlock ?? startBlock) - 1,
      logs: 0,
      requests: 0,
      unfolded: 0,
    };

    let next = progress.fromBlock;
    if (next > target) {
      // Nothing to read yet, so no query can be refused: the cursor is written now, which keeps a
      // start block given relative to the head from moving with the head.
      if (!stored) await this.#createCursor(module, startBlock);
      return progress;
    }

    let first = true;
    while (next <= target) {
      const end = Math.min(target, next + this.#chunkOf(module.name) - 1);
      // The first request of a sync reaches back over blocks already stored, to compare them.
      const from = first ? Math.max(startBlock, next - this.#sync.reorgDepth) : next;
      let logs: ChainLog[];
      try {
        logs = await this.#fetchAll(module, filter, from, end, progress);
      } catch (error) {
        if (error instanceof HistoryUnavailableError)
          throw error.withAdvice(this.#historyAdvice(module, stored));
        throw error;
      }

      if (from < next) {
        const seenAgain = logs.filter((log) => log.blockNumber < next);
        const known = await storedIdentities(this.#db, module.name, from, next - 1);
        const differsAt = firstMismatch(known, seenAgain);
        if (differsAt !== null) throw new ChainReorganised(differsAt - 1);
      }

      const fresh = logs.filter((log) => log.blockNumber >= next);
      progress.unfolded += await this.#store(module, fresh, {
        kind: "advance",
        to: end + 1,
        tip: end === target ? tip : null,
        create: stored ? null : { startBlock },
      });
      stored = true;
      progress.logs += fresh.length;
      progress.toBlock = end;
      next = end + 1;
      first = false;
    }
    return progress;
  }

  /** Where a module with no cursor begins. */
  #firstBlock(module: ContractModule, head: number): number {
    const configured = this.#sync.startBlocks[module.name];
    if (!configured && module.needsStartBlock) throw new MissingStartBlockError(module.name);
    return resolveStartBlock(configured ?? this.#sync.startBlock, head);
  }

  /** What an operator can do when the node will not serve the blocks a module is due to read. */
  #historyAdvice(module: ContractModule, stored: boolean): string {
    const variable = `START_BLOCK_${module.name.toUpperCase()}`;
    if (!stored) {
      return (
        `Nothing is stored for this module yet: point RPC_URL at a node that keeps old logs, or begin later ` +
        `by setting ${variable} (the free node serves about the last 9,000 blocks).`
      );
    }
    return (
      `Point RPC_URL at a node that keeps old logs and the module continues where it stopped; or give up ` +
      `the blocks in between with "skip --module ${module.name} --to latest-7000", which starts its ` +
      `coverage again at that block. ${variable} only applies to a module's first run.`
    );
  }

  /** Every log of `[fromBlock, toBlock]`, in as many requests as the node's limits require. */
  async #fetchAll(
    module: ContractModule,
    filter: LogFilter,
    fromBlock: number,
    toBlock: number,
    progress: ModuleProgress,
  ): Promise<ChainLog[]> {
    const all: ChainLog[] = [];
    let next = fromBlock;
    while (next <= toBlock) {
      const end = Math.min(toBlock, next + this.#chunkOf(module.name) - 1);
      const result = await getLogsAdaptive(this.#client, filter, next, end);
      progress.requests += result.requests;
      if (result.halvings > 0) {
        this.#chunk.set(module.name, Math.max(1, result.toBlock - next + 1));
        this.#cleanRequests.set(module.name, 0);
        this.#log.info("node refused the range; using a smaller one", {
          module: module.name,
          blocks: this.#chunkOf(module.name),
        });
      } else {
        this.#grow(module.name);
      }
      all.push(...result.logs);
      next = result.toBlock + 1;
    }
    return all;
  }

  /**
   * One transaction: the events, their fold, and the cursor.
   *
   * `advance` is a sync moving upwards: new events are folded and `next_block` moves (the cursor
   * row is created here on a module's first range). `backfill` is a range below the coverage:
   * events are stored without folding, and only the backfill's own progress is noted.
   *
   * @returns how many of the new events the handler could not fold.
   */
  async #store(
    module: ContractModule,
    logs: ChainLog[],
    step:
      | { kind: "advance"; to: number; tip: Header | null; create: { startBlock: number } | null }
      | { kind: "backfill"; from: number; next: number },
  ): Promise<number> {
    const times = await this.#blockTimes(logs);
    const indexed = logs.map((log) => toIndexedEvent(module, log, times.get(log.blockNumber) as number));
    // Only used to say which days a tally fully covers, so a node that will not serve the header
    // is not a reason to stop.
    const startTime =
      step.kind === "advance" && step.create
        ? await this.#header(step.create.startBlock).then(
            (header) => header.timestamp,
            () => null,
          )
        : null;

    let unfolded = 0;
    await this.#db.transaction(async (tx) => {
      unfolded = 0;
      for (const event of indexed) {
        const isNew = await insertEvent(tx, event);
        if (!isNew || step.kind !== "advance") continue;
        const reason = await foldEvent(tx, module, event);
        if (reason !== null) {
          unfolded++;
          this.#log.error("an event could not be folded; it is stored and the module carries on", {
            module: module.name,
            event: event.event,
            txHash: event.txHash,
            logIndex: event.logIndex,
            error: reason,
          });
        }
      }
      if (step.kind === "backfill") {
        await tx
          .update(cursors)
          .set({ backfillFrom: step.from, backfillNext: step.next, updatedAtMs: this.#now() })
          .where(eq(cursors.module, module.name));
        return;
      }
      const moved = {
        nextBlock: step.to,
        tipHash: step.tip?.hash ?? null,
        tipTime: step.tip?.timestamp ?? null,
        updatedAtMs: this.#now(),
      };
      if (step.create) {
        await tx
          .insert(cursors)
          .values({ module: module.name, startBlock: step.create.startBlock, startTime, ...moved });
        this.#log.info("module starts", { module: module.name, startBlock: step.create.startBlock });
      } else {
        await tx.update(cursors).set(moved).where(eq(cursors.module, module.name));
      }
    });
    return unfolded;
  }

  /** Writes the cursor of a module that has nothing to read yet. */
  async #createCursor(module: ContractModule, startBlock: number): Promise<void> {
    const startTime = await this.#header(startBlock).then(
      (header) => header.timestamp,
      () => null,
    );
    await this.#db
      .insert(cursors)
      .values({ module: module.name, startBlock, startTime, nextBlock: startBlock, updatedAtMs: this.#now() })
      .onConflictDoNothing();
    this.#log.info("module starts", { module: module.name, startBlock });
  }

  /**
   * A timestamp for every block in `logs`. Most nodes put it in the log; for the ones that do not,
   * the header is fetched, and its hash must be the one the log named.
   */
  async #blockTimes(logs: ChainLog[]): Promise<Map<number, number>> {
    const times = new Map<number, number>();
    const missing = new Map<number, string>();
    for (const log of logs) {
      if (log.blockTime !== null) times.set(log.blockNumber, log.blockTime);
      else if (!times.has(log.blockNumber)) missing.set(log.blockNumber, log.blockHash);
    }
    for (const [number, hash] of missing) {
      if (times.has(number)) continue;
      const header = await this.#header(number);
      if (header.hash !== hash) {
        throw new BadNodeAnswerError(`block ${number} changed between two reads; trying again next tick`);
      }
      times.set(number, header.timestamp);
    }
    return times;
  }

  async #header(number: number): Promise<Header> {
    const block = await this.#client.getBlock({ blockNumber: BigInt(number) });
    if (block.hash === null) throw new BadNodeAnswerError(`block ${number} has no hash yet`);
    const timestamp = Number(block.timestamp);
    if (!isBlockTime(timestamp)) {
      throw new BadNodeAnswerError(`block ${number} came with a timestamp no mainnet block can have`);
    }
    return { hash: block.hash.toLowerCase(), timestamp };
  }

  #chunkOf(module: string): number {
    return this.#chunk.get(module) ?? this.#sync.chunkSize;
  }

  #grow(module: string): void {
    const current = this.#chunkOf(module);
    if (current >= this.#sync.chunkSize) return;
    const clean = (this.#cleanRequests.get(module) ?? 0) + 1;
    if (clean < GROW_AFTER) {
      this.#cleanRequests.set(module, clean);
      return;
    }
    this.#cleanRequests.set(module, 0);
    this.#chunk.set(module, Math.min(this.#sync.chunkSize, current * 2));
  }

  #stateOf(module: string): ModuleState {
    let state = this.#state.get(module);
    if (!state) {
      state = { lastError: null, lastErrorAtMs: null, lastSyncedAtMs: null, failures: 0, retryAtMs: null };
      this.#state.set(module, state);
    }
    return state;
  }

  /** After an operator's command changed what is stored, a failing module deserves a fresh try. */
  #forgetFailures(module?: string): void {
    for (const [name, state] of this.#state) {
      if (module !== undefined && name !== module) continue;
      state.failures = 0;
      state.retryAtMs = null;
    }
  }

  #fail(module: ContractModule, error: unknown): void {
    const now = this.#now();
    const state = this.#stateOf(module.name);
    const failures = state.failures + 1;
    // The first failures are tried again on the very next pass; after that the wait doubles.
    const wait =
      failures >= BACKOFF_FROM_FAILURES
        ? Math.min(
            MAX_MODULE_BACKOFF_MS,
            this.#sync.pollIntervalMs * 2 ** Math.min(failures - BACKOFF_FROM_FAILURES + 1, 10),
          )
        : 0;
    this.#state.set(module.name, {
      // What the status route shows. The log line below carries the full text.
      lastError: publicErrorMessage(error),
      lastErrorAtMs: now,
      lastSyncedAtMs: state.lastSyncedAtMs,
      failures,
      retryAtMs: wait > 0 ? now + wait : null,
    });
    this.#log.error("module failed", {
      module: module.name,
      error: errorMessage(error),
      failures,
      retryInMs: wait,
    });

    // A node may refuse a range in words this code does not know. If the same module keeps
    // failing for an unrecognised reason, a smaller range is the one remedy worth trying.
    if (
      error instanceof HistoryUnavailableError ||
      error instanceof MissingStartBlockError ||
      classifyLogsError(error) !== "other"
    ) {
      return;
    }
    const unknown = (this.#unknownFailures.get(module.name) ?? 0) + 1;
    if (unknown < SHRINK_AFTER_FAILURES) {
      this.#unknownFailures.set(module.name, unknown);
      return;
    }
    this.#unknownFailures.set(module.name, 0);
    const current = this.#chunkOf(module.name);
    if (current > 1) {
      this.#chunk.set(module.name, Math.ceil(current / 2));
      this.#cleanRequests.set(module.name, 0);
    }
  }
}
