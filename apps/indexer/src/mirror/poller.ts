/**
 * Copies the few public IdentityMD documents the pages need into the database.
 *
 * Four things are mirrored: `GET /health` (the headline numbers), the newest jobs, the newest
 * oracle requests, and, for the jobs we care about, the whole job and its work records. Pages read
 * these tables; a visitor's request never reaches `api.imd.fun`.
 *
 * Everything served is somebody else's text. It is validated just enough to file it, cleaned of
 * the characters Postgres cannot store, and kept as data. No URL found inside a document is ever
 * fetched.
 */
import { eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { MirrorConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { isUuid, jobIdToUuid } from "../ids.js";
import { scrubText, storableJson, type JsonValue } from "../json.js";
import { errorMessage, silentLogger, type Logger } from "../log.js";
import { orders } from "../modules/own/workOrders.js";
import type { PoliteFetcher } from "./politeFetch.js";
import { apiHealth, apiJobRecords, apiJobs, apiOracleRequests } from "./tables.js";

const text = z.string().nullish();
const whole = z.number().int().nullish();

const Health = z.looseObject({
  status: text,
  connectedDaemons: whole,
  workingNow: whole,
  acceptedLastDay: whole,
  pendingFeedback: whole,
  computedAt: text,
  payments: z
    .looseObject({
      enabled: z.boolean().nullish(),
      orders: z.looseObject({ paid: whole }).nullish(),
    })
    .nullish(),
});

const JobEntry = z.looseObject({
  id: z.string().refine(isUuid, "not a UUID"),
  state: text,
  template: text,
  objective: text,
  paidBy: text,
  launchKind: text,
  blockedReason: text,
  createdAt: text,
  updatedAt: text,
});

const JobsList = z.looseObject({ jobs: z.array(z.unknown()) });

const JobRecords = z.looseObject({
  records: z.array(
    z.looseObject({
      id: z.string().min(1),
      hash: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/),
      chainId: whole,
      registry: text,
      status: text,
      txHash: text,
      // The API sends `failure: null` on a record without one. A record that leaves the key out
      // is the same record, and must not make the whole job unreadable.
      failure: z.unknown().optional(),
    }),
  ),
  // Oracle work is recorded once a day, not once a job: such a job has no record of its own and
  // is named in the day's batch instead.
  oracleBatches: z.array(z.unknown()).nullish(),
});

const OracleRequestEntry = z.looseObject({
  id: z.string().refine(isUuid, "not a UUID"),
  status: text,
  question: text,
  chainId: whole,
  answerType: text,
  jobId: text,
  signer: text,
  window: z.looseObject({ fromBlock: whole, toBlock: whole }).nullish(),
  attestedAt: text,
  createdAt: text,
  updatedAt: text,
});

const OracleRequestsList = z.looseObject({ requests: z.array(z.unknown()) });

const clean = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : scrubText(value);
const lower = (value: string | null | undefined): string | null => clean(value)?.toLowerCase() ?? null;
/** A served document as it is kept: cleaned for Postgres, refused when nested absurdly deep. */
const raw = (value: unknown): JsonValue => storableJson(value);

/** States in which a job is no longer being worked on. */
const ENDED_JOB_STATES = new Set(["completed", "failed", "cancelled", "canceled", "blocked"]);

/**
 * How fast a watched job's documents are expected to change.
 *  - `moving`: the job is still being worked on.
 *  - `waiting`: the job has ended but a receipt is still to be written, or it has no record yet.
 *    While IdentityMD's receipt writer is stalled every ended job sits here, and some completed
 *    jobs never get a record at all, so this is polled slowly: nothing about it changes fast.
 *  - `settled`: the job has ended and every record is written or failed. Still looked at now and
 *    then, because a job can get a second record that replaces the first.
 */
export type JobPace = "moving" | "waiting" | "settled";

export interface MirrorIntervals {
  healthMs: number;
  jobsMs: number;
  oracleRequestsMs: number;
  /** A watched job that is `moving`. */
  watchedJobMs: number;
  /** A watched job that is `waiting`. */
  waitingJobMs: number;
  /** A watched job that is `settled`. */
  settledJobMs: number;
  /** The longest wait before another try at a job that keeps failing (an id the API does not know). */
  maxJobBackoffMs: number;
}

export const DEFAULT_INTERVALS: MirrorIntervals = {
  healthMs: 60_000,
  jobsMs: 60_000,
  oracleRequestsMs: 120_000,
  watchedJobMs: 5 * 60_000,
  waitingJobMs: 30 * 60_000,
  settledJobMs: 60 * 60_000,
  maxJobBackoffMs: 6 * 60 * 60_000,
};

export interface MirrorReport {
  /** What was fetched and stored, by task. */
  done: string[];
  failed: { task: string; error: string }[];
}

export interface ApiMirrorOptions {
  db: Db;
  fetcher: PoliteFetcher;
  config: MirrorConfig;
  intervals?: Partial<MirrorIntervals>;
  log?: Logger;
  /** Fires when the process is stopping: no task is begun after that. */
  signal?: AbortSignal;
  now?: () => number;
}

export class ApiMirror {
  readonly #db: Db;
  readonly #fetcher: PoliteFetcher;
  readonly #config: MirrorConfig;
  readonly #intervals: MirrorIntervals;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #signal: AbortSignal | null;
  /** When each task last ran, by task name. */
  readonly #lastRun = new Map<string, number>();
  readonly #pace = new Map<string, JobPace>();
  /** Failed polls in a row, by job id. */
  readonly #jobFailures = new Map<string, number>();

  constructor(options: ApiMirrorOptions) {
    this.#db = options.db;
    this.#fetcher = options.fetcher;
    this.#config = options.config;
    this.#intervals = { ...DEFAULT_INTERVALS, ...options.intervals };
    this.#log = options.log ?? silentLogger;
    this.#now = options.now ?? Date.now;
    this.#signal = options.signal ?? null;
  }

  #url(path: string, query: Record<string, string | number> = {}): string {
    const url = new URL(this.#config.baseUrl + path);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    return url.toString();
  }

  /**
   * The jobs whose full document and records are mirrored: the configured ones, and every job a
   * runner registered on one of our orders.
   */
  async watchedJobs(): Promise<string[]> {
    const registered = await this.#db
      .select({ jobId: orders.jobId })
      .from(orders)
      .where(isNotNull(orders.jobId));
    const fromOrders = registered.flatMap((row) => {
      try {
        return row.jobId ? [jobIdToUuid(row.jobId)] : [];
      } catch {
        return [];
      }
    });
    return [...new Set([...this.#config.watchJobs, ...fromOrders])].sort();
  }

  async pollHealth(): Promise<void> {
    const body = await this.#fetcher.getJson(this.#url("/health"));
    const health = Health.parse(body);
    const fetchedAtMs = this.#now();
    const row = {
      fetchedAtMs,
      status: clean(health.status),
      connectedDaemons: health.connectedDaemons ?? null,
      workingNow: health.workingNow ?? null,
      acceptedLastDay: health.acceptedLastDay ?? null,
      pendingFeedback: health.pendingFeedback ?? null,
      paymentsEnabled: health.payments?.enabled ?? null,
      paidOrders: health.payments?.orders?.paid ?? null,
      computedAt: clean(health.computedAt),
      raw: raw(body),
    };
    const hour = new Date(fetchedAtMs).toISOString().slice(0, 13);
    await this.#db
      .insert(apiHealth)
      .values({ hour, ...row })
      .onConflictDoUpdate({ target: apiHealth.hour, set: row });
  }

  /** @returns how many jobs were stored. An entry that is not shaped like a job is skipped. */
  async pollJobs(): Promise<number> {
    const body = await this.#fetcher.getJson(this.#url("/jobs", { limit: this.#config.jobsLimit }));
    const list = JobsList.parse(body);
    const fetchedAtMs = this.#now();
    let stored = 0;
    for (const entry of list.jobs) {
      const parsed = JobEntry.safeParse(entry);
      if (!parsed.success) continue;
      const job = parsed.data;
      try {
        const listed = {
          state: clean(job.state),
          template: clean(job.template),
          launchKind: clean(job.launchKind),
          blockedReason: clean(job.blockedReason),
          createdAt: clean(job.createdAt),
          updatedAt: clean(job.updatedAt),
          listed: raw(entry),
          fetchedAtMs,
        };
        await this.#db
          .insert(apiJobs)
          .values({ id: job.id.toLowerCase(), objective: clean(job.objective), ...listed })
          .onConflictDoUpdate({
            target: apiJobs.id,
            set: {
              ...listed,
              // The list shortens objectives; keep the whole text once the job's own page gave it.
              objective: sql`case when ${apiJobs.detail} is null then excluded.objective else ${apiJobs.objective} end`,
            },
          });
        stored++;
      } catch (error) {
        this.#skipped("jobs", job.id, error);
      }
    }
    return stored;
  }

  /** One entry of a list could not be filed. The others still are. */
  #skipped(task: string, id: string, error: unknown): void {
    this.#log.warn("mirror entry skipped", { task, id, error: errorMessage(error) });
  }

  /** @returns how many oracle requests were stored. */
  async pollOracleRequests(): Promise<number> {
    const body = await this.#fetcher.getJson(
      this.#url("/oracle/requests", { limit: this.#config.oracleRequestsLimit }),
    );
    const list = OracleRequestsList.parse(body);
    const fetchedAtMs = this.#now();
    let stored = 0;
    for (const entry of list.requests) {
      const parsed = OracleRequestEntry.safeParse(entry);
      if (!parsed.success) continue;
      const request = parsed.data;
      try {
        const row = {
          status: clean(request.status),
          question: clean(request.question),
          chainId: request.chainId ?? null,
          answerType: clean(request.answerType),
          jobId: lower(request.jobId),
          signer: lower(request.signer),
          fromBlock: request.window?.fromBlock ?? null,
          toBlock: request.window?.toBlock ?? null,
          attestedAt: clean(request.attestedAt),
          createdAt: clean(request.createdAt),
          updatedAt: clean(request.updatedAt),
          raw: raw(entry),
          fetchedAtMs,
        };
        await this.#db
          .insert(apiOracleRequests)
          .values({ id: request.id.toLowerCase(), ...row })
          .onConflictDoUpdate({ target: apiOracleRequests.id, set: row });
        stored++;
      } catch (error) {
        this.#skipped("oracle-requests", request.id, error);
      }
    }
    return stored;
  }

  /**
   * One watched job: its whole document and its work records. Two requests.
   * @returns how fast the job's documents are expected to change from here on.
   */
  async pollJob(id: string): Promise<JobPace> {
    if (!isUuid(id)) throw new TypeError(`not a job UUID: ${id}`);
    const body = await this.#fetcher.getJson(this.#url(`/jobs/${id}`));
    const job = JobEntry.parse(body);
    if (job.id.toLowerCase() !== id) throw new Error(`asked for job ${id}, was served ${job.id}`);
    const fetchedAtMs = this.#now();
    const detail = {
      state: clean(job.state),
      template: clean(job.template),
      objective: clean(job.objective),
      paidBy: lower(job.paidBy),
      blockedReason: clean(job.blockedReason),
      createdAt: clean(job.createdAt),
      updatedAt: clean(job.updatedAt),
      watched: true,
      detail: raw(body),
      fetchedAtMs,
      detailFetchedAtMs: fetchedAtMs,
    };
    await this.#db
      .insert(apiJobs)
      .values({ id, ...detail })
      .onConflictDoUpdate({ target: apiJobs.id, set: detail });

    const recordsBody = await this.#fetcher.getJson(this.#url(`/jobs/${id}/records`));
    const { records, oracleBatches } = JobRecords.parse(recordsBody);
    const recordsFetchedAtMs = this.#now();
    // Nothing recorded yet, in a record of its own or in a day's batch: a receipt may still come.
    let open = records.length === 0 && (oracleBatches?.length ?? 0) === 0;
    for (const record of records) {
      const hash = record.hash.toLowerCase();
      const row = {
        hash: hash.startsWith("0x") ? hash : `0x${hash}`,
        chainId: record.chainId ?? null,
        registry: lower(record.registry),
        status: clean(record.status),
        txHash: lower(record.txHash),
        failure: record.failure === undefined || record.failure === null ? null : raw(record.failure),
        fetchedAtMs: recordsFetchedAtMs,
      };
      if (row.status !== "sent" && row.status !== "failed") open = true;
      await this.#db
        .insert(apiJobRecords)
        .values({ jobId: id, recordId: scrubText(record.id), ...row })
        .onConflictDoUpdate({ target: [apiJobRecords.jobId, apiJobRecords.recordId], set: row });
    }
    if (!ENDED_JOB_STATES.has(detail.state ?? "")) return "moving";
    return open ? "waiting" : "settled";
  }

  /** Everything once, whatever the schedule says: for `once --mirror` and for tests. */
  async runOnce(): Promise<MirrorReport> {
    return this.#run(false);
  }

  /**
   * Whatever is due now. The long-running loop calls this again and again.
   *
   * The three lists come first, on their own schedule: the headline numbers must not depend on
   * how long the watch list is. Watched jobs take what is left of the request budget, the one
   * that has waited longest first, and the pass ends as soon as a list is due again, so a watch
   * list of any length delays the lists by at most one job (two requests). At least one due job
   * is taken per pass, so the watch list moves even when the budget is too small for both.
   */
  async runDue(): Promise<MirrorReport> {
    return this.#run(true);
  }

  #isDue(task: string, everyMs: number): boolean {
    const last = this.#lastRun.get(task);
    return last === undefined || this.#now() - last >= everyMs;
  }

  /** How long to leave a watched job alone: by its pace, and longer each time it fails. */
  #jobInterval(id: string): number {
    const pace = this.#pace.get(id) ?? "moving";
    const base =
      pace === "settled"
        ? this.#intervals.settledJobMs
        : pace === "waiting"
          ? this.#intervals.waitingJobMs
          : this.#intervals.watchedJobMs;
    const failures = this.#jobFailures.get(id) ?? 0;
    if (failures === 0) return base;
    return Math.min(Math.max(base, this.#intervals.maxJobBackoffMs), base * 2 ** Math.min(failures, 16));
  }

  async #run(scheduled: boolean): Promise<MirrorReport> {
    const report: MirrorReport = { done: [], failed: [] };
    /** @returns whether the work was done; false when it was not due or failed. */
    const attempt = async (task: string, everyMs: number, work: () => Promise<unknown>): Promise<boolean> => {
      if (this.#signal?.aborted) return false;
      if (scheduled && !this.#isDue(task, everyMs)) return false;
      // Marked before the work, so a task that keeps failing is not retried faster than scheduled.
      this.#lastRun.set(task, this.#now());
      try {
        await work();
        report.done.push(task);
        return true;
      } catch (error) {
        // Cut short by the shutdown: neither done nor failed.
        if (this.#signal?.aborted) return false;
        const message = errorMessage(error);
        report.failed.push({ task, error: message });
        this.#log.warn("mirror task failed", { task, error: message });
        return false;
      }
    };

    const lists: [task: string, everyMs: number, work: () => Promise<unknown>][] = [
      ["health", this.#intervals.healthMs, () => this.pollHealth()],
      ["jobs", this.#intervals.jobsMs, () => this.pollJobs()],
      ["oracle-requests", this.#intervals.oracleRequestsMs, () => this.pollOracleRequests()],
    ];
    for (const [task, everyMs, work] of lists) await attempt(task, everyMs, work);

    let watched: string[] | null = null;
    try {
      watched = await this.watchedJobs();
    } catch (error) {
      report.failed.push({ task: "watch-list", error: errorMessage(error) });
    }
    if (watched === null) return report;

    // The job that has waited longest goes first; one never polled before any other.
    const lastRunOf = (id: string) => this.#lastRun.get(`job:${id}`) ?? Number.NEGATIVE_INFINITY;
    const inTurn = [...watched].sort((a, b) => {
      const [ranA, ranB] = [lastRunOf(a), lastRunOf(b)];
      return ranA === ranB ? (a < b ? -1 : 1) : ranA < ranB ? -1 : 1;
    });
    let taken = 0;
    for (const id of inTurn) {
      if (this.#signal?.aborted) break;
      if (scheduled && !this.#isDue(`job:${id}`, this.#jobInterval(id))) continue;
      // The lists are served first; the rest of the watch list keeps its place for the next
      // pass. One job is taken in every pass all the same, so that a request budget so small
      // that the lists use all of it cannot shut the watch list out altogether.
      if (scheduled && taken > 0 && lists.some(([task, everyMs]) => this.#isDue(task, everyMs))) break;
      taken++;
      const failuresBefore = this.#jobFailures.get(id) ?? 0;
      const polled = await attempt(`job:${id}`, 0, async () => {
        this.#pace.set(id, await this.pollJob(id));
      });
      if (polled) this.#jobFailures.delete(id);
      else if (!this.#signal?.aborted) this.#jobFailures.set(id, failuresBefore + 1);
    }
    if (this.#signal?.aborted) return report;

    // A job that left the watch list keeps its rows but is no longer marked.
    const marked = await this.#db.select({ id: apiJobs.id }).from(apiJobs).where(eq(apiJobs.watched, true));
    const keep = new Set(watched);
    for (const row of marked) {
      if (!keep.has(row.id))
        await this.#db.update(apiJobs).set({ watched: false }).where(eq(apiJobs.id, row.id));
    }
    return report;
  }
}
