/**
 * The IdentityMD public API as a data source: the swarm's health, its recent jobs, a job's record
 * list and the work records themselves.
 *
 * The routes, the request shapes and the checks on every answer are the shared package's
 * (`ImdClient` and its zod schemas). What this module adds is what a public web server needs in
 * front of that client and a bot does not:
 *
 * - api.imd.fun allows 120 public reads a minute per address for everyone behind it, so visitor
 *   traffic is never passed through. Every read is cached (see `lib/cache.ts`), and the number of
 *   real upstream requests is capped per minute for the whole process; when the cap is reached a
 *   read fails with `UpstreamBusyError` unless an older answer can be served instead.
 * - A page must not wait for a slow upstream. The client is run with one attempt, a short timeout
 *   and no queueing gap, and a breaker leaves the API alone for a moment after it fails to answer.
 *
 * Only GET is ever sent.
 */
import type { Hex } from "viem";
import {
  ImdApiError,
  ImdClient,
  ImdSchemaError,
  isNotFound,
  WorkRecordError,
  type Health,
  type Job,
  type JobRecords,
  type JobsList,
} from "@help-wanted/shared";
import { Breaker, SlidingWindowLimiter, TtlCache, UpstreamBusyError, type Cached } from "~/lib/cache";
import { isJobId, parseHash } from "~/lib/ids";
import { hashServedRecord, type RecordRef } from "~/lib/verify";

export interface SwarmHealth {
  /** Machines connected to the swarm right now. */
  online: number;
  /** Machines with a task in hand right now. */
  working: number;
  awaitingVerdict: number | null;
  /** Pieces of work accepted in the last 24 hours. */
  acceptedLastDay: number | null;
  enrolled: number | null;
  /** Paid orders since the protocol started counting. */
  paidOrders: number | null;
  lastPaidAt: string | null;
  paymentsEnabled: boolean | null;
  /** Work receipts waiting to be written to the WorkRegistry. */
  receiptsQueued: number | null;
  /** Ethereum mainnet Intake request counts, as the API reports them. */
  intakeMainnet: Record<string, number> | null;
  version: string | null;
  computedAt: string | null;
}

export interface SwarmJob {
  id: string;
  state: string;
  template: string | null;
  /** Shortened by the API in lists. Third-party text. */
  objective: string;
  launchKind: string | null;
  blockedReason: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deliveredAt: string | null;
  deliveryUrl: string | null;
  /** `{version, of}` when the job is one version of a project. */
  projectVersion: { version: number; of: number } | null;
}

/** One job as `GET /jobs/:id` gives it, cut down to what a page states about it. */
export interface JobDetail {
  id: string;
  state: string;
  template: string | null;
  /** The whole objective as IdentityMD stored it. Third-party text. */
  objective: string;
  /** The wallet that paid for the job, lowercase; null when nobody did or the API does not say. */
  paidBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** The commit the job started from, when it is one version of a project. */
  baseCommit: string | null;
  /** The job's steps: which role, and where each stands. */
  steps: { key: string; role: string | null; state: string }[];
  /** What the job asked the launch pipeline for, and what the pipeline reports back. */
  launch: {
    requested: boolean;
    kind: string | null;
    id: string | null;
    status: string | null;
    chainId: number | null;
  } | null;
  deliveredAt: string | null;
  deliveryUrl: string | null;
}

export interface ApiUsage {
  usedThisMinute: number;
  maxPerMinute: number;
  /** True while the API is being left alone after failing to answer several times in a row. */
  pausedAfterFailures: boolean;
}

/** A work record this server holds: bytes that were checked against the hash they are kept under. */
export interface ServedRecord {
  /** The exact bytes whose keccak256 is the hash asked for. */
  bytes: Uint8Array;
  /** When this server fetched them from IdentityMD, in epoch milliseconds. Null for a stored copy. */
  fetchedAt: number | null;
  /**
   * `identitymd`: fetched from IdentityMD's record server by this process. `stored`: a copy that
   * ships with the site, used only while IdentityMD cannot be reached. Either way the bytes hash to
   * the hash, which is all a check needs of them.
   */
  origin: "identitymd" | "stored";
}

/**
 * A job this server checks on its own account (the reference job on "/judges" and "/verify"). Its
 * reads are never refused because visitors spent their share of the budget, its record is never
 * pushed out of memory, and `bytes`, when given, stand in while IdentityMD cannot be reached.
 */
export interface PinnedRecord {
  jobId: string;
  hash: Hex;
  bytes: Uint8Array | null;
}

export interface ApiSource {
  readonly baseUrl: string;
  health(): Promise<Cached<SwarmHealth>>;
  recentJobs(limit: number): Promise<Cached<SwarmJob[]>>;
  /** The job's record list; null when the API does not know the job. */
  jobRecords(jobId: string): Promise<Cached<RecordRef[] | null>>;
  /** True when `jobRecords(jobId)` would answer from memory, without asking IdentityMD. */
  hasRecentRecords(jobId: string): boolean;
  /**
   * One job in full: its state, its objective, who paid, its steps and its launch. Null when the API
   * does not know the job. Asked only about jobs this server names itself (`ownJobs`), never about
   * one a visitor typed.
   */
  job(jobId: string): Promise<Cached<JobDetail | null>>;
  /**
   * The record under a hash, as bytes that were checked to hash to it; null when IdentityMD serves
   * no record under that hash. Throws when the server could not be asked, or answered with bytes
   * that are not the record.
   */
  workRecord(hash: Hex): Promise<ServedRecord | null>;
  /** True when `workRecord(hash)` would answer from memory, without asking IdentityMD. */
  holdsRecord(hash: Hex): boolean;
  usage(): ApiUsage;
}

// ---------------------------------------------------------------------------------------------
// From the API's answers to what a page shows. The shared schemas have already checked the fields
// the product depends on; the protocol's own guide says to expect extra fields, and the few extra
// ones a page shows (figures of the swarm's day) are read here as optional.
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** `GET /health`, as checked by the shared `Health` schema, to the figures a page prints. */
export function healthView(health: Health): SwarmHealth {
  const o = health as Health & Json;
  const payments = obj(o.payments);
  const orders = obj(payments?.orders);
  const intake = obj(o.intake);
  let intakeMainnet: Record<string, number> | null = null;
  if (Array.isArray(intake?.chains)) {
    for (const chain of intake.chains) {
      const c = obj(chain);
      const requests = obj(c?.requests);
      if (c?.chainId === 1 && requests) {
        intakeMainnet = {};
        for (const [key, value] of Object.entries(requests)) {
          const n = num(value);
          if (n !== null) intakeMainnet[key] = n;
        }
      }
    }
  }
  return {
    online: health.connectedDaemons,
    working: health.workingNow,
    awaitingVerdict: num(o.awaitingVerdict),
    acceptedLastDay: num(o.acceptedLastDay),
    enrolled: num(o.activeEnrollments),
    paidOrders: num(orders?.paid),
    lastPaidAt: str(payments?.lastPaidAt),
    paymentsEnabled: health.payments?.enabled ?? null,
    receiptsQueued: health.pendingFeedback ?? null,
    intakeMainnet,
    version: health.version,
    computedAt: str(o.computedAt),
  };
}

/** `GET /jobs`, as checked by the shared `JobsList` schema, to cards' raw material. */
export function jobsView(list: JobsList): SwarmJob[] {
  return list.jobs.map((job) => {
    const project = obj((job as Json).project);
    const version = num(project?.version);
    const of = num(project?.of);
    return {
      id: job.id,
      state: job.state,
      template: job.template,
      objective: job.objective,
      launchKind: job.launchKind ?? null,
      blockedReason: job.blockedReason ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      deliveredAt: job.delivery?.deliveredAt ?? null,
      deliveryUrl: safeHttpUrl(job.delivery?.repoUrl ?? null),
      projectVersion: version !== null && of !== null ? { version, of } : null,
    };
  });
}

/** `GET /jobs/:id/records`, as checked by the shared `JobRecords` schema. */
export function recordsView(list: JobRecords): RecordRef[] {
  const records: RecordRef[] = [];
  for (const record of list.records) {
    const hash = parseHash(record.hash);
    if (!hash) continue;
    records.push({
      hash,
      status: record.status,
      txHash: parseHash(record.txHash ?? null),
      failure: record.failure ?? null,
    });
  }
  return records;
}

/** `GET /jobs/:id`, as checked by the shared `Job` schema. */
export function jobView(job: Job): JobDetail {
  const o = job as Job & Json;
  const launch = obj(o.launch);
  const versions = job.project?.versions ?? [];
  const own = versions.find((version) => version.jobId === job.id) ?? null;
  return {
    id: job.id,
    state: job.state,
    template: job.template,
    objective: job.objective,
    paidBy: job.paidBy ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    baseCommit: own?.baseCommit ?? null,
    steps: (job.nodes ?? []).map((node) => ({ key: node.key, role: node.role ?? null, state: node.state })),
    launch: launch
      ? {
          requested: launch.requested === true,
          kind: str(launch.kind),
          id: str(launch.id),
          status: str(launch.status),
          chainId: num(launch.chainId),
        }
      : null,
    deliveredAt: job.delivery?.deliveredAt ?? null,
    deliveryUrl: safeHttpUrl(job.delivery?.repoUrl ?? null),
  };
}

/** A link from the API is shown only when it is plain http(s); anything else is dropped. */
export function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The HTTP source
// ---------------------------------------------------------------------------------------------

export interface HttpApiOptions {
  baseUrl: string;
  maxPerMinute: number;
  fetch?: typeof fetch;
  cache?: TtlCache;
  now?: () => number;
  timeoutMs?: number;
  pinned?: readonly PinnedRecord[];
  /** More jobs this server asks about on its own account (beside the pinned ones). */
  ownJobs?: readonly string[];
}

const RECORD_MAX_BYTES = 1_000_000;
const RECORDS_KEPT = 48;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** A job's record list is reused for a minute, and for four more while one refresh runs behind it. */
const RECORDS_TTL = 60 * SECOND;
const RECORDS_SWR = 4 * MINUTE;
/** One job's page is reused for two minutes, and for ten more while one refresh runs behind it. */
const JOB_TTL = 2 * MINUTE;
const JOB_SWR = 10 * MINUTE;
/** How long a failed record fetch is remembered, so a failing server is not asked on every page view. */
const RECORD_FAILURE_MS = 20 * SECOND;
const UPSTREAM = "The IdentityMD API";

/** Thrown when the record server answers 200 with bytes that are not the record that was asked for. */
export class NotTheRecordError extends Error {
  constructor(detail: string) {
    super(
      `the record server answered with bytes that do not hash to the hash they were asked for (${detail}); they are not the record and were not kept`,
    );
    this.name = "NotTheRecordError";
  }
}

/** Thrown when the API's answer is not in the shape the shared schemas expect. */
export class ApiShapeError extends Error {
  constructor(what: string) {
    super(`the IdentityMD API answered in an unexpected shape: ${what}`);
    this.name = "ApiShapeError";
  }
}

export class HttpApiSource implements ApiSource {
  readonly baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #cache: TtlCache;
  /** Checked record bytes by hash, least recently fetched first. Pinned ones are kept apart, for good. */
  readonly #records = new Map<string, ServedRecord>();
  readonly #pinnedRecords = new Map<string, ServedRecord>();
  readonly #stored = new Map<string, ServedRecord>();
  readonly #ownJobs = new Set<string>();
  readonly #ownHashes = new Set<string>();
  readonly #recordMisses = new Map<string, number>();
  readonly #recordFailures = new Map<string, { at: number; error: unknown }>();
  readonly #recordLoads = new Map<string, Promise<ServedRecord | null>>();
  readonly #now: () => number;
  readonly #all: SlidingWindowLimiter;
  /** Reads a visitor can cause one by one (a job's records, a record) get a smaller share. */
  readonly #visitor: SlidingWindowLimiter;
  readonly #breaker: Breaker;
  readonly #maxPerMinute: number;
  /** The shared client twice over: one for the server's own reads, one for reads a visitor caused. */
  readonly #own: ImdClient;
  readonly #visitorDriven: ImdClient;

  constructor(options: HttpApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#cache = options.cache ?? new TtlCache({ now: options.now });
    this.#now = options.now ?? Date.now;
    this.#maxPerMinute = options.maxPerMinute;
    this.#all = new SlidingWindowLimiter({ max: options.maxPerMinute, windowMs: MINUTE, now: options.now });
    this.#visitor = new SlidingWindowLimiter({
      max: Math.max(1, Math.floor(options.maxPerMinute * 0.8)),
      windowMs: MINUTE,
      now: options.now,
    });
    this.#breaker = new Breaker(UPSTREAM, { now: options.now });
    // A page waits for this at most once: after a failure the caches and the breaker answer at once.
    const client = (visitorDriven: boolean) =>
      new ImdClient({
        baseUrl: this.baseUrl,
        fetch: this.#guarded(visitorDriven),
        // The shared client's own pacing is for a bot with nothing in front of it. Here the cache,
        // the per-minute cap and the breaker do that work, and a page cannot wait for a queue.
        minIntervalMs: 0,
        maxAttempts: 1,
        timeoutMs: options.timeoutMs ?? 4_000,
        userAgent: "help-wanted-web/0.1",
      });
    this.#own = client(false);
    this.#visitorDriven = client(true);
    for (const jobId of options.ownJobs ?? []) this.#ownJobs.add(jobId);
    for (const pin of options.pinned ?? []) {
      const key = pin.hash.toLowerCase();
      this.#ownJobs.add(pin.jobId);
      this.#ownHashes.add(key);
      // A stored copy is trusted exactly as far as a fetched one: only if it hashes to its hash.
      if (pin.bytes && hashServedRecord(pin.bytes, pin.hash).matches) {
        this.#stored.set(key, { bytes: pin.bytes, fetchedAt: null, origin: "stored" });
      }
    }
  }

  usage(): ApiUsage {
    return {
      usedThisMinute: this.#all.used(),
      maxPerMinute: this.#maxPerMinute,
      pausedAfterFailures: this.#breaker.open,
    };
  }

  /** The `fetch` the shared client is given: the budget and the breaker sit in front of every request. */
  #guarded(visitorDriven: boolean): typeof fetch {
    return async (input, init) => {
      this.#breaker.check();
      if (visitorDriven) {
        const slot = this.#visitor.take();
        if (!slot.ok) throw new UpstreamBusyError(UPSTREAM, slot.retryAfterMs);
      }
      const slot = this.#all.take();
      if (!slot.ok) throw new UpstreamBusyError(UPSTREAM, slot.retryAfterMs);
      let response: Response;
      try {
        response = await this.#fetch(input, init);
      } catch (error) {
        this.#breaker.failed(error);
        throw error;
      }
      // "Slow down" and server errors are the API not answering; anything else is an answer.
      if (response.status === 429 || response.status >= 500) {
        this.#breaker.failed(new Error(`HTTP ${response.status}`));
      } else {
        this.#breaker.succeeded();
      }
      if (response.ok && String(input).includes("/work-records/")) return capped(response);
      return response;
    };
  }

  /**
   * Runs one call of the shared client and says what went wrong in this site's own terms. With one
   * attempt the client wraps whatever stopped the request ("… failed after 1 tries"); the thing
   * underneath (a spent budget, an open breaker, a timeout) is what a page reports and acts on.
   */
  async #ask<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ImdSchemaError) throw new ApiShapeError(error.issues.slice(0, 3).join("; "));
      if (error instanceof ImdApiError || error instanceof WorkRecordError) throw error;
      if (error instanceof Error && error.cause !== undefined) throw error.cause;
      throw error;
    }
  }

  health(): Promise<Cached<SwarmHealth>> {
    return this.#cache.get("api:health", { ttlMs: 45 * SECOND }, async () =>
      healthView(await this.#ask(() => this.#own.health())),
    );
  }

  recentJobs(limit: number): Promise<Cached<SwarmJob[]>> {
    const n = Math.min(100, Math.max(1, Math.trunc(limit)));
    return this.#cache.get(`api:jobs:${n}`, { ttlMs: 45 * SECOND }, async () =>
      jobsView(await this.#ask(() => this.#own.jobs({ limit: n, excludeOracle: true }))),
    );
  }

  hasRecentRecords(jobId: string): boolean {
    const hit = this.#cache.peek(`api:records:${jobId}`);
    return hit !== null && this.#now() - hit.fetchedAt < RECORDS_TTL + RECORDS_SWR;
  }

  jobRecords(jobId: string): Promise<Cached<RecordRef[] | null>> {
    if (!isJobId(jobId)) throw new TypeError("not a job id");
    const client = this.#ownJobs.has(jobId) ? this.#own : this.#visitorDriven;
    return this.#cache.get(`api:records:${jobId}`, { ttlMs: RECORDS_TTL, swrMs: RECORDS_SWR }, async () => {
      try {
        return recordsView(await this.#ask(() => client.jobRecords(jobId)));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    });
  }

  job(jobId: string): Promise<Cached<JobDetail | null>> {
    if (!isJobId(jobId)) throw new TypeError("not a job id");
    if (!this.#ownJobs.has(jobId))
      throw new TypeError("this server reads in full only the jobs it names itself");
    return this.#cache.get(`api:job:${jobId}`, { ttlMs: JOB_TTL, swrMs: JOB_SWR }, async () => {
      try {
        return jobView(await this.#ask(() => this.#own.job(jobId)));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    });
  }

  holdsRecord(hash: Hex): boolean {
    const key = hash.toLowerCase();
    return this.#pinnedRecords.has(key) || this.#records.has(key) || this.#stored.has(key);
  }

  async workRecord(hash: Hex): Promise<ServedRecord | null> {
    const key = hash.toLowerCase();
    // A record is addressed by its own hash, so bytes that hash to it never change: once fetched
    // and checked they are kept until the small record store pushes them out.
    const kept = this.#pinnedRecords.get(key) ?? this.#records.get(key);
    if (kept) return kept;
    const stored = this.#stored.get(key) ?? null;
    // A miss is remembered for a minute only, because a record that is not there yet may appear.
    const missedAt = this.#recordMisses.get(key);
    if (missedAt !== undefined && this.#now() - missedAt < MINUTE) return stored;
    const failure = this.#recordFailures.get(key);
    if (failure && this.#now() - failure.at < RECORD_FAILURE_MS) {
      if (stored) return stored;
      throw failure.error;
    }
    const running = this.#recordLoads.get(key);
    if (running) return running;

    const client = this.#ownHashes.has(key) ? this.#own : this.#visitorDriven;
    const load = (async () => {
      try {
        // The shared client fetches the bytes and keeps them only if they hash to the hash asked
        // for. A 200 is not proof of anything: an error page or a cut-off body also arrives as one.
        const checked = await this.#ask(() => client.workRecord(hash));
        const record: ServedRecord = { bytes: checked.bytes, fetchedAt: this.#now(), origin: "identitymd" };
        this.#recordFailures.delete(key);
        this.#keep(key, record);
        return record;
      } catch (raw) {
        if (isNotFound(raw)) {
          if (this.#recordMisses.size > 2000) this.#recordMisses.clear();
          this.#recordMisses.set(key, this.#now());
          return stored;
        }
        const error =
          raw instanceof WorkRecordError && raw.code === "HashMismatch"
            ? new NotTheRecordError(raw.message.replace(/^HashMismatch: /, ""))
            : raw instanceof ImdApiError
              ? new Error(`the record server answered HTTP ${raw.status}`)
              : raw;
        if (this.#recordFailures.size > 2000) this.#recordFailures.clear();
        this.#recordFailures.set(key, { at: this.#now(), error });
        if (stored) return stored;
        throw error;
      } finally {
        this.#recordLoads.delete(key);
      }
    })();
    this.#recordLoads.set(key, load);
    return load;
  }

  #keep(key: string, record: ServedRecord): void {
    if (this.#ownHashes.has(key)) {
      this.#pinnedRecords.set(key, record);
      return;
    }
    this.#records.delete(key);
    this.#records.set(key, record);
    while (this.#records.size > RECORDS_KEPT) {
      const oldest = this.#records.keys().next().value;
      if (oldest === undefined) break;
      this.#records.delete(oldest);
    }
  }
}

/** A record's body, read with a ceiling: this server will not buffer an arbitrarily large answer. */
async function capped(response: Response): Promise<Response> {
  const tooLarge = () => new Error("the record is larger than this site will fetch");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > RECORD_MAX_BYTES) throw tooLarge();
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > RECORD_MAX_BYTES) throw tooLarge();
  return new Response(bytes, { status: response.status, headers: response.headers });
}
