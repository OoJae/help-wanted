/**
 * Typed read functions over the indexer's database: the one way other packages (the web app, the
 * bots, the evidence writer) should read it.
 *
 *   import { openDatabase, createQueries } from "@help-wanted/indexer";
 *   const { db } = await openDatabase({ databaseUrl: process.env.DATABASE_URL });
 *   const q = createQueries(db, { house });
 *   const report = await q.jobsReportDaily({ days: 14 });
 *
 * Amounts are `bigint` wei. Addresses and hashes are lowercase. Nothing here writes.
 */
import { and, asc, desc, eq, getTableColumns, gte, lt, lte, max, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "./db/client.js";
import { cursors, events, type CursorRow, type EventRow } from "./db/core.js";
import type { ContractModule } from "./engine/module.js";
import { normalizeJobId } from "./ids.js";
import { apiHealth, apiJobRecords, apiJobs, apiOracleRequests } from "./mirror/tables.js";
import { feeTransfers } from "./modules/feeTransfers.js";
import { ALL_MODULES } from "./modules/index.js";
import { intakeRequests } from "./modules/intake.js";
import { chips, pots } from "./modules/own/crowdPots.js";
import { prints } from "./modules/own/jobsReport.js";
import { payrollMovements, type PayrollKind } from "./modules/own/payroll.js";
import { feeds, rounds } from "./modules/own/questions.js";
import { rules } from "./modules/own/rules.js";
import { claims, orders, type OrderState } from "./modules/own/workOrders.js";
import { receipts } from "./modules/workRegistry.js";
import {
  dayStart,
  rankPayers,
  SECONDS_PER_DAY,
  tallyAll,
  tallyByDay,
  utcDay,
  type DayTally,
  type PayerTally,
  type Tally,
} from "./report/tally.js";

export type ReceiptRow = typeof receipts.$inferSelect;
export type IntakeRequestRow = typeof intakeRequests.$inferSelect;
export type FeeTransferRow = typeof feeTransfers.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type ClaimRow = typeof claims.$inferSelect;
export type PotRow = typeof pots.$inferSelect;
export type ChipRow = typeof chips.$inferSelect;
export type FeedRow = typeof feeds.$inferSelect;
export type RoundRow = typeof rounds.$inferSelect;
export type PrintRow = typeof prints.$inferSelect;
export type PayrollMovementRow = typeof payrollMovements.$inferSelect;
export type RuleRow = typeof rules.$inferSelect;
export type ApiHealthRow = typeof apiHealth.$inferSelect;
export type ApiJobRow = typeof apiJobs.$inferSelect;
export type ApiJobRecordRow = typeof apiJobRecords.$inferSelect;
export type ApiOracleRequestRow = typeof apiOracleRequests.$inferSelect;

export interface QueryOptions {
  /** Addresses the team controls. Any spelling; they are lowercased here. */
  house?: Iterable<string>;
  /** The modules whose handler state is reported. Default: every module of this package. */
  modules?: ContractModule[];
}

export interface ModuleCoverage {
  module: string;
  /**
   * The inclusive range of blocks whose logs have all been read. `throughBlock` is null while
   * nothing has been synced. A table of the module holds what these blocks hold and nothing else,
   * so a row that is absent means "not in this range", never "not on chain".
   */
  fromBlock: number;
  throughBlock: number | null;
  /** Timestamps of those two blocks, when known. */
  fromTime: number | null;
  throughTime: number | null;
  /** The hash of `throughBlock` as the chain had it when the module caught up. */
  throughHash: string | null;
  /** Logs of this module inside that range. */
  events: number;
  /** Logs inside that range that the module's handler could not fold. They are in no table. */
  unfolded: number;
  /**
   * Logs stored outside the range: fetched by a backfill that has not finished, or left behind
   * by `skip`. They are in no table and in no list.
   */
  eventsOutside: number;
  /** A backfill that has not finished: it reads down to `fromBlock` and continues at `nextBlock`. */
  backfill: { fromBlock: number; nextBlock: number } | null;
  updatedAtMs: number;
}

/**
 * What an answer about chain data was read from: which module, whether its handler is finished,
 * and the block range it has indexed. Sent with every chain list and lookup, so that an empty
 * answer can be read for what it is: "nothing in blocks A to B", or "this table is not being
 * filled yet" (`handler: "stub"`), or "nothing has been indexed at all" (`throughBlock: null`).
 */
export interface ChainSource {
  module: string;
  /** `stub`: the module stores the contract's logs but folds nothing into its tables yet. */
  handler: "ready" | "stub";
  fromBlock: number | null;
  throughBlock: number | null;
  fromTime: number | null;
  throughTime: number | null;
  /** Logs in that range the handler could not fold; they are missing from the rows served. */
  unfolded: number;
}

export interface StoreStatus {
  modules: ModuleCoverage[];
  /** Rows per table that pages read. */
  rows: Record<string, number>;
  mirror: {
    healthFetchedAtMs: number | null;
    jobsFetchedAtMs: number | null;
    oracleRequestsFetchedAtMs: number | null;
  };
}

export interface JobReceipts {
  /** The job id as the chain writes it. */
  jobId: string;
  /** The newest receipt in the indexed range, or null when the range holds none for this job. */
  latest: ReceiptRow | null;
  /** Every receipt of the job in the indexed range, newest first. */
  receipts: ReceiptRow[];
  /** The range that was searched. A job recorded outside it has a receipt this answer cannot show. */
  coverage: ChainSource;
}

export interface JobsReportDaily {
  /**
   * Oldest first. Every day of the indexed range among the days asked for is listed, a day
   * without a payment as zeros; a day outside the range is absent.
   */
  days: DayTally[];
  /** The block range the tally was counted from, and its timestamps. */
  coverage: ModuleCoverage | null;
}

export interface JobsReportWindow {
  fromBlock: number;
  toBlock: number;
  /** False when part of the window lies outside the indexed range: the tally is then a lower bound. */
  covered: boolean;
  tally: Tally;
  /** The ten largest payers of the window. */
  topPayers: PayerTally[];
}

const MAX_LIMIT = 1000;

function clampLimit(limit: number | undefined, fallback = 100): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function all(conditions: (SQL | undefined)[]): SQL | undefined {
  const present = conditions.filter((condition): condition is SQL => condition !== undefined);
  return present.length === 0 ? undefined : and(...present);
}

interface EventCounts {
  inside: number;
  unfolded: number;
  total: number;
}

function coverageOf(cursor: CursorRow, counts: EventCounts | undefined): ModuleCoverage {
  const synced = cursor.nextBlock > cursor.startBlock;
  return {
    module: cursor.module,
    fromBlock: cursor.startBlock,
    throughBlock: synced ? cursor.nextBlock - 1 : null,
    fromTime: cursor.startTime,
    throughTime: synced ? cursor.tipTime : null,
    throughHash: synced ? cursor.tipHash : null,
    events: counts?.inside ?? 0,
    unfolded: counts?.unfolded ?? 0,
    eventsOutside: (counts?.total ?? 0) - (counts?.inside ?? 0),
    backfill:
      cursor.backfillFrom !== null && cursor.backfillNext !== null
        ? { fromBlock: cursor.backfillFrom, nextBlock: cursor.backfillNext }
        : null,
    updatedAtMs: cursor.updatedAtMs,
  };
}

/** The condition "this event lies inside its module's coverage", for a query joined to `cursors`. */
const insideCoverage = sql`${events.blockNumber} >= ${cursors.startBlock} and ${events.blockNumber} < ${cursors.nextBlock}`;

export function createQueries(db: Db, options: QueryOptions = {}) {
  const house: ReadonlySet<string> = new Set(
    [...(options.house ?? [])].map((address) => address.toLowerCase()),
  );
  const stubs: ReadonlySet<string> = new Set(
    (options.modules ?? ALL_MODULES).filter((module) => module.stub === true).map((module) => module.name),
  );

  const rowCount = (table: PgTable): Promise<number> => db.$count(table);

  /**
   * Per module: the block range read so far and how many logs it holds.
   * @param params.through Count only logs up to this block: the store as of an earlier block.
   */
  async function coverage(params: { through?: number } = {}): Promise<ModuleCoverage[]> {
    const upTo = params.through === undefined ? sql`true` : sql`${events.blockNumber} <= ${params.through}`;
    const [cursorRows, counts] = await Promise.all([
      db.select().from(cursors).orderBy(asc(cursors.module)),
      db
        .select({
          module: events.module,
          inside: sql<number>`count(*) filter (where ${insideCoverage} and ${upTo})`.mapWith(Number),
          unfolded:
            sql<number>`count(*) filter (where ${insideCoverage} and ${upTo} and ${events.foldError} is not null)`.mapWith(
              Number,
            ),
          total: sql<number>`count(*)`.mapWith(Number),
        })
        .from(events)
        .leftJoin(cursors, eq(cursors.module, events.module))
        .groupBy(events.module),
    ]);
    const byModule = new Map(counts.map((row) => [row.module, row]));
    return cursorRows.map((cursor) => coverageOf(cursor, byModule.get(cursor.module)));
  }

  async function coverageFor(module: string): Promise<ModuleCoverage | null> {
    return (await coverage()).find((entry) => entry.module === module) ?? null;
  }

  /** What a chain answer was read from: see `ChainSource`. */
  async function source(module: string): Promise<ChainSource> {
    const covered = await coverageFor(module);
    return {
      module,
      handler: stubs.has(module) ? "stub" : "ready",
      fromBlock: covered?.fromBlock ?? null,
      throughBlock: covered?.throughBlock ?? null,
      fromTime: covered?.fromTime ?? null,
      throughTime: covered?.throughTime ?? null,
      unfolded: covered?.unfolded ?? 0,
    };
  }

  /**
   * Every receipt of one job that the indexed range holds, newest first. Takes the job id in
   * either spelling.
   *
   * The first row is what `WorkRegistry.latest(jobId)` returned as of the last indexed block only
   * if the job's newest receipt lies inside the indexed range. An empty list means "no receipt in
   * the indexed range", which is not "no receipt": with the default look-back and the receipt
   * writer stalled, the range holds none at all. Use `jobReceipts` to get the range with the
   * answer.
   */
  async function receiptsOfJob(job: string): Promise<ReceiptRow[]> {
    const jobId = normalizeJobId(job);
    if (!jobId) return [];
    return db
      .select()
      .from(receipts)
      .where(eq(receipts.jobId, jobId))
      .orderBy(desc(receipts.blockNumber), desc(receipts.logIndex));
  }

  return {
    /** True for an address on the published house list. */
    isHouse(address: string): boolean {
      return house.has(address.toLowerCase());
    },

    coverage,
    source,

    /** `ready` or `stub`: whether the module's handler fills its tables yet. */
    handlerOf(module: string): "ready" | "stub" {
      return stubs.has(module) ? "stub" : "ready";
    },

    /** What is in the store: per-module block ranges, row counts, and how fresh the API mirror is. */
    async status(): Promise<StoreStatus> {
      const [modules, health, jobs, oracle] = await Promise.all([
        coverage(),
        db.select({ at: max(apiHealth.fetchedAtMs) }).from(apiHealth),
        db.select({ at: max(apiJobs.fetchedAtMs) }).from(apiJobs),
        db.select({ at: max(apiOracleRequests.fetchedAtMs) }).from(apiOracleRequests),
      ]);
      const tables: Record<string, PgTable> = {
        events,
        receipts,
        intake_requests: intakeRequests,
        fee_transfers: feeTransfers,
        orders,
        claims,
        pots,
        chips,
        feeds,
        rounds,
        prints,
        payroll_movements: payrollMovements,
        rules,
        api_health: apiHealth,
        api_jobs: apiJobs,
        api_job_records: apiJobRecords,
        api_oracle_requests: apiOracleRequests,
      };
      const rows: Record<string, number> = {};
      for (const [name, table] of Object.entries(tables)) rows[name] = await rowCount(table);
      return {
        modules,
        rows,
        mirror: {
          healthFetchedAtMs: health[0]?.at ?? null,
          jobsFetchedAtMs: jobs[0]?.at ?? null,
          oracleRequestsFetchedAtMs: oracle[0]?.at ?? null,
        },
      };
    },

    // ---------------------------------------------------------------------------------------------
    // WorkRegistry receipts
    // ---------------------------------------------------------------------------------------------

    /** Receipts, newest first. */
    async receipts(
      params: { limit?: number; fromBlock?: number; toBlock?: number } = {},
    ): Promise<ReceiptRow[]> {
      return db
        .select()
        .from(receipts)
        .where(
          all([
            params.fromBlock === undefined ? undefined : gte(receipts.blockNumber, params.fromBlock),
            params.toBlock === undefined ? undefined : lte(receipts.blockNumber, params.toBlock),
          ]),
        )
        .orderBy(desc(receipts.blockNumber), desc(receipts.logIndex))
        .limit(clampLimit(params.limit));
    },

    receiptsOfJob,

    /**
     * The receipts of one job together with the block range that was searched, so that "none" can
     * be read correctly. Null when the text is not a job id.
     */
    async jobReceipts(job: string): Promise<JobReceipts | null> {
      const jobId = normalizeJobId(job);
      if (!jobId) return null;
      const [found, covered] = await Promise.all([receiptsOfJob(jobId), source("receipts")]);
      return { jobId, latest: found[0] ?? null, receipts: found, coverage: covered };
    },

    /** Receipts whose document hash is `hash`: which job a work record belongs to. */
    async receiptsByHash(hash: string): Promise<ReceiptRow[]> {
      return db
        .select()
        .from(receipts)
        .where(eq(receipts.documentHash, hash.toLowerCase()))
        .orderBy(desc(receipts.blockNumber), desc(receipts.logIndex));
    },

    // ---------------------------------------------------------------------------------------------
    // Intake requests
    // ---------------------------------------------------------------------------------------------

    /** Oracle requests bought on chain, newest first. Filter by who paid or who is called back. */
    async intakeRequests(
      params: { limit?: number; payer?: string; callbackTarget?: string } = {},
    ): Promise<IntakeRequestRow[]> {
      return db
        .select()
        .from(intakeRequests)
        .where(
          all([
            params.payer === undefined ? undefined : eq(intakeRequests.payer, params.payer.toLowerCase()),
            params.callbackTarget === undefined
              ? undefined
              : eq(intakeRequests.callbackTarget, params.callbackTarget.toLowerCase()),
          ]),
        )
        .orderBy(
          sql`coalesce(${intakeRequests.requestedBlock}, ${intakeRequests.completedBlock}) desc`,
          sql`coalesce(${intakeRequests.requestedLogIndex}, ${intakeRequests.completedLogIndex}) desc`,
        )
        .limit(clampLimit(params.limit));
    },

    async intakeRequest(requestId: string): Promise<IntakeRequestRow | null> {
      const [row] = await db
        .select()
        .from(intakeRequests)
        .where(eq(intakeRequests.requestId, requestId.toLowerCase()));
      return row ?? null;
    },

    // ---------------------------------------------------------------------------------------------
    // Fee transfers and the Jobs Report tally
    // ---------------------------------------------------------------------------------------------

    /** IMD transfers to the fee payee, newest first. */
    async feeTransfers(
      params: { limit?: number; fromBlock?: number; toBlock?: number; from?: string } = {},
    ): Promise<FeeTransferRow[]> {
      return db
        .select()
        .from(feeTransfers)
        .where(
          all([
            params.fromBlock === undefined ? undefined : gte(feeTransfers.blockNumber, params.fromBlock),
            params.toBlock === undefined ? undefined : lte(feeTransfers.blockNumber, params.toBlock),
            params.from === undefined ? undefined : eq(feeTransfers.from, params.from.toLowerCase()),
          ]),
        )
        .orderBy(desc(feeTransfers.blockNumber), desc(feeTransfers.logIndex))
        .limit(clampLimit(params.limit));
    },

    /**
     * The unofficial tally per UTC day for the last `days` days, oldest first. "The last day" is
     * the day of the newest indexed block, not the wall clock, so the answer depends only on what
     * is stored. Every one of those days that the indexed range touches is listed, a day on which
     * nobody paid as zeros; `complete` says whether the range spans the whole day.
     */
    async jobsReportDaily(params: { days?: number } = {}): Promise<JobsReportDaily> {
      const days = Math.min(366, Math.max(1, Math.trunc(params.days ?? 14)));
      const covered = await coverageFor("fee_transfers");
      const [newest] = await db.select({ at: max(feeTransfers.blockTime) }).from(feeTransfers);
      const reference = covered?.throughTime ?? newest?.at ?? null;
      if (reference === null) return { days: [], coverage: covered };

      const since = dayStart(utcDay(reference)) - (days - 1) * SECONDS_PER_DAY;
      const rows = await db
        .select({
          from: feeTransfers.from,
          value: feeTransfers.value,
          blockNumber: feeTransfers.blockNumber,
          blockTime: feeTransfers.blockTime,
        })
        .from(feeTransfers)
        .where(gte(feeTransfers.blockTime, since));
      const tallied = tallyByDay(rows, house, {
        fromTime: covered?.fromTime ?? null,
        toTime: covered?.throughTime ?? null,
      });
      // The rows were cut at `since`, so an older day of the range would show as zeros it never had.
      return { days: tallied.filter((day) => dayStart(day.day) >= since), coverage: covered };
    },

    /**
     * The unofficial tally for one inclusive block window: the number to put beside an official
     * print, which is bought for exactly such a window.
     */
    async jobsReportWindow(params: { fromBlock: number; toBlock: number }): Promise<JobsReportWindow> {
      const rows = await db
        .select({
          from: feeTransfers.from,
          value: feeTransfers.value,
          blockNumber: feeTransfers.blockNumber,
          blockTime: feeTransfers.blockTime,
        })
        .from(feeTransfers)
        .where(
          and(gte(feeTransfers.blockNumber, params.fromBlock), lte(feeTransfers.blockNumber, params.toBlock)),
        );
      const covered = await coverageFor("fee_transfers");
      return {
        fromBlock: params.fromBlock,
        toBlock: params.toBlock,
        covered:
          covered !== null &&
          covered.throughBlock !== null &&
          covered.fromBlock <= params.fromBlock &&
          covered.throughBlock >= params.toBlock,
        tally: tallyAll(rows, house),
        topPayers: rankPayers(rows, house, 10),
      };
    },

    // ---------------------------------------------------------------------------------------------
    // Our own contracts. The tables exist; they fill once the contracts are deployed and their
    // handlers are written (see `src/modules/own`).
    // ---------------------------------------------------------------------------------------------

    /** Orders on the hire desk, newest first. */
    async orders(
      params: { limit?: number; state?: OrderState; employer?: string } = {},
    ): Promise<OrderRow[]> {
      return db
        .select()
        .from(orders)
        .where(
          all([
            params.state === undefined ? undefined : eq(orders.state, params.state),
            params.employer === undefined ? undefined : eq(orders.employer, params.employer.toLowerCase()),
          ]),
        )
        .orderBy(desc(orders.id))
        .limit(clampLimit(params.limit));
    },

    /** One order with every claim made on it, oldest claim first. */
    async order(id: number): Promise<{ order: OrderRow; claims: ClaimRow[] } | null> {
      const [order] = await db.select().from(orders).where(eq(orders.id, id));
      if (!order) return null;
      const made = await db.select().from(claims).where(eq(claims.orderId, id)).orderBy(asc(claims.seq));
      return { order, claims: made };
    },

    async pots(params: { limit?: number } = {}): Promise<PotRow[]> {
      return db.select().from(pots).orderBy(desc(pots.id)).limit(clampLimit(params.limit));
    },

    /** One pot with its contributors, largest stake first. */
    async pot(id: number): Promise<{ pot: PotRow; chips: ChipRow[] } | null> {
      const [pot] = await db.select().from(pots).where(eq(pots.id, id));
      if (!pot) return null;
      const stakes = await db
        .select()
        .from(chips)
        .where(eq(chips.potId, id))
        .orderBy(desc(chips.amount), asc(chips.contributor));
      return { pot, chips: stakes };
    },

    async feeds(): Promise<FeedRow[]> {
      return db.select().from(feeds).orderBy(asc(feeds.createdBlock), asc(feeds.feedId));
    },

    /** Rounds, newest first: of one feed, or of all feeds. */
    async rounds(params: { feedId?: string; limit?: number } = {}): Promise<RoundRow[]> {
      return db
        .select()
        .from(rounds)
        .where(params.feedId === undefined ? undefined : eq(rounds.feedId, params.feedId.toLowerCase()))
        .orderBy(desc(rounds.openedBlock), desc(rounds.round))
        .limit(clampLimit(params.limit));
    },

    /** Prints of the Jobs Report, newest first. */
    async prints(params: { limit?: number } = {}): Promise<PrintRow[]> {
      return db.select().from(prints).orderBy(desc(prints.index)).limit(clampLimit(params.limit));
    },

    async payrollMovements(
      params: { limit?: number; kind?: PayrollKind } = {},
    ): Promise<PayrollMovementRow[]> {
      return db
        .select()
        .from(payrollMovements)
        .where(params.kind === undefined ? undefined : eq(payrollMovements.kind, params.kind))
        .orderBy(desc(payrollMovements.blockNumber), desc(payrollMovements.logIndex))
        .limit(clampLimit(params.limit));
    },

    async rules(params: { limit?: number } = {}): Promise<RuleRow[]> {
      return db.select().from(rules).orderBy(desc(rules.id)).limit(clampLimit(params.limit));
    },

    /**
     * Stored logs inside their module's coverage, newest first: every module's, one module's, or
     * one event's. A log stored outside coverage (see `ModuleCoverage.eventsOutside`) is not
     * listed: its neighbours may be missing, so a list that showed it would be a partial history.
     */
    async events(params: { module?: string; event?: string; limit?: number } = {}): Promise<EventRow[]> {
      return db
        .select(getTableColumns(events))
        .from(events)
        .innerJoin(
          cursors,
          and(
            eq(cursors.module, events.module),
            gte(events.blockNumber, cursors.startBlock),
            lt(events.blockNumber, cursors.nextBlock),
          ),
        )
        .where(
          all([
            params.module === undefined ? undefined : eq(events.module, params.module),
            params.event === undefined ? undefined : eq(events.event, params.event),
          ]),
        )
        .orderBy(desc(events.blockNumber), desc(events.logIndex))
        .limit(clampLimit(params.limit));
    },

    // ---------------------------------------------------------------------------------------------
    // The API mirror
    // ---------------------------------------------------------------------------------------------

    /** The newest copy of `GET /health`, or null before the first poll. */
    async health(): Promise<ApiHealthRow | null> {
      const [row] = await db.select().from(apiHealth).orderBy(desc(apiHealth.fetchedAtMs)).limit(1);
      return row ?? null;
    },

    /** One row per hour, newest first. */
    async healthHistory(params: { limit?: number } = {}): Promise<ApiHealthRow[]> {
      return db.select().from(apiHealth).orderBy(desc(apiHealth.hour)).limit(clampLimit(params.limit, 48));
    },

    /** Mirrored jobs, newest first. */
    async jobs(params: { limit?: number; watched?: boolean } = {}): Promise<ApiJobRow[]> {
      return db
        .select()
        .from(apiJobs)
        .where(params.watched === undefined ? undefined : eq(apiJobs.watched, params.watched))
        .orderBy(sql`${apiJobs.createdAt} desc nulls last`, asc(apiJobs.id))
        .limit(clampLimit(params.limit));
    },

    /**
     * One mirrored job with its work records, and its receipts from the chain if the indexed range
     * (`receiptsCoverage`) holds any.
     */
    async job(id: string): Promise<{
      job: ApiJobRow;
      records: ApiJobRecordRow[];
      receipts: ReceiptRow[];
      receiptsCoverage: ChainSource;
    } | null> {
      const uuid = id.toLowerCase();
      const [job] = await db.select().from(apiJobs).where(eq(apiJobs.id, uuid));
      if (!job) return null;
      const jobId = normalizeJobId(uuid);
      const [records, onChain] = await Promise.all([
        db
          .select()
          .from(apiJobRecords)
          .where(eq(apiJobRecords.jobId, uuid))
          .orderBy(asc(apiJobRecords.recordId)),
        jobId
          ? db
              .select()
              .from(receipts)
              .where(eq(receipts.jobId, jobId))
              .orderBy(desc(receipts.blockNumber), desc(receipts.logIndex))
          : Promise.resolve([]),
      ]);
      return { job, records, receipts: onChain, receiptsCoverage: await source("receipts") };
    },

    /** Mirrored oracle requests, newest first. */
    async oracleRequests(params: { limit?: number; status?: string } = {}): Promise<ApiOracleRequestRow[]> {
      return db
        .select()
        .from(apiOracleRequests)
        .where(params.status === undefined ? undefined : eq(apiOracleRequests.status, params.status))
        .orderBy(sql`${apiOracleRequests.createdAt} desc nulls last`, asc(apiOracleRequests.id))
        .limit(clampLimit(params.limit));
    },

    async oracleRequest(id: string): Promise<ApiOracleRequestRow | null> {
      const [row] = await db
        .select()
        .from(apiOracleRequests)
        .where(eq(apiOracleRequests.id, id.toLowerCase()));
      return row ?? null;
    },
  };
}

export type Queries = ReturnType<typeof createQueries>;
