/**
 * A typed client for the public IdentityMD routes HELP WANTED reads, plus the free preflight.
 *
 * It is deliberately slow. `api.imd.fun` allows 120 public reads a minute per IP and the whole
 * product shares that, so every request goes through one queue with a minimum gap (2.1 s by default,
 * under 30 a minute), honours `Retry-After` on 429, and backs off on 5xx and network errors. Nothing
 * here signs, pays or changes state: `check` is the protocol's free `POST /requests/check`.
 */
import type { z } from "zod";
import { IMD_API_BASE } from "../addresses.js";
import { checkRecordBytes, workRecordUrl, type CheckedRecord } from "../workRecord.js";
import {
  ApiErrorBody,
  Capabilities,
  CheckResult,
  Health,
  IntakeRead,
  Job,
  JobRecords,
  JobResult,
  JobsList,
  Launch,
  LaunchesList,
  OracleAttestationDocument,
  OracleRequest,
  OracleRequestsList,
  PaidByList,
  type PaidAction,
} from "./schemas.js";

/** A non-2xx answer. `code` is the protocol's error code (`unknown_record`, `too_many_reads`, …). */
export class ImdApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly url: string;
  readonly body: unknown;

  constructor(status: number, url: string, body: unknown) {
    const parsed = ApiErrorBody.safeParse(body);
    const code = parsed.success ? parsed.data.error : undefined;
    super(`${url} answered ${status}${code ? ` ${code}` : ""}`);
    this.name = "ImdApiError";
    this.status = status;
    this.code = code;
    this.url = url;
    this.body = body;
  }
}

/** A 2xx answer whose body is not what the schema expects. */
export class ImdSchemaError extends Error {
  readonly url: string;
  readonly issues: string[];

  constructor(url: string, issues: string[]) {
    super(`${url} answered in an unexpected shape: ${issues.slice(0, 5).join("; ")}`);
    this.name = "ImdSchemaError";
    this.url = url;
    this.issues = issues;
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ImdApiError && error.status === 404;
}

/** `GET /intake/:chainId/:tx` before the plane has seen the transaction: `404 unknown_transaction`. */
export function isUnknownTransaction(error: unknown): boolean {
  return isNotFound(error) && (error as ImdApiError).code === "unknown_transaction";
}

/** `GET /oracle/requests/:id/attestation` before the answer is signed: `404 not_attested`. */
export function isNotAttested(error: unknown): boolean {
  return isNotFound(error) && (error as ImdApiError).code === "not_attested";
}

export interface ImdClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Minimum gap between the starts of two requests. Default 2,100 ms (under 30 a minute). */
  minIntervalMs?: number;
  /** Tries per request, the first included. Default 4. */
  maxAttempts?: number;
  /** Per-try timeout. Default 30 s. */
  timeoutMs?: number;
  /** The longest a single `Retry-After` or back-off wait may be. Default 60 s. */
  maxBackoffMs?: number;
  userAgent?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** Called once per try, for logs and tests. Never receives a credential: this client has none. */
  onAttempt?: (info: { method: string; url: string; attempt: number; status: number | null }) => void;
}

export interface JobsQuery {
  /** Exclusive creation-time cursor: pass the oldest `createdAt` of the previous page. */
  before?: string;
  /** 1 to 500; the server defaults to 100. */
  limit?: number;
  /** Text in the objective, or an id prefix. At most 200 characters. */
  q?: string;
  /** Jobs that moved after this time. */
  since?: string;
  /** Leave out oracle panel jobs, which are most of the feed. */
  excludeOracle?: boolean;
}

export interface OracleRequestsQuery {
  before?: string;
  limit?: number;
  jobId?: string;
  status?: string[];
  q?: string;
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertId(id: string, what: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new TypeError(`${what} must be a lowercase UUID`);
  }
  return id;
}

/** Seconds or an HTTP date, as `Retry-After` allows. Returns milliseconds, or null when unreadable. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^[0-9]+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

export class ImdClient {
  readonly baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #minIntervalMs: number;
  readonly #maxAttempts: number;
  readonly #timeoutMs: number;
  readonly #maxBackoffMs: number;
  readonly #userAgent: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #onAttempt: ImdClientOptions["onAttempt"];
  /** The tail of the queue: each request waits for the one before it to have started. */
  #gate: Promise<void> = Promise.resolve();
  #lastStart = Number.NEGATIVE_INFINITY;

  constructor(options: ImdClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? IMD_API_BASE).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#minIntervalMs = options.minIntervalMs ?? 2100;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 4);
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.#userAgent = options.userAgent ?? "help-wanted/0.1";
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#onAttempt = options.onAttempt;
  }

  /** Waits for this request's turn. Requests leave in the order they were made. */
  #turn(): Promise<void> {
    const mine = this.#gate.then(async () => {
      const wait = this.#lastStart + this.#minIntervalMs - this.#now();
      if (wait > 0) await this.#sleep(wait);
      this.#lastStart = this.#now();
    });
    // A failed wait must not jam the queue for everyone behind it.
    this.#gate = mine.catch(() => undefined);
    return mine;
  }

  #url(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async #send(method: "GET" | "POST", url: string, body?: unknown): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      await this.#turn();
      let response: Response | null = null;
      try {
        const headers: Record<string, string> = { accept: "application/json", "user-agent": this.#userAgent };
        const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.#timeoutMs) };
        if (body !== undefined) {
          headers["content-type"] = "application/json";
          init.body = JSON.stringify(body);
        }
        response = await this.#fetch(url, init);
      } catch (error) {
        lastError = error;
      }
      this.#onAttempt?.({ method, url, attempt, status: response?.status ?? null });

      if (response && !RETRY_STATUS.has(response.status)) return response;
      if (attempt === this.#maxAttempts) {
        if (response) return response;
        break;
      }
      const retryAfter = response ? parseRetryAfter(response.headers.get("retry-after"), this.#now()) : null;
      const backoff = 1000 * 2 ** (attempt - 1) * (1 + this.#random() * 0.25);
      await this.#sleep(Math.min(this.#maxBackoffMs, retryAfter ?? backoff));
    }
    throw new Error(`${method} ${url} failed after ${this.#maxAttempts} tries`, { cause: lastError });
  }

  async #json<S extends z.ZodType>(
    schema: S,
    method: "GET" | "POST",
    url: string,
    body?: unknown,
  ): Promise<z.infer<S>> {
    const response = await this.#send(method, url, body);
    const text = await response.text();
    let data: unknown;
    try {
      data = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      data = text.slice(0, 500);
    }
    if (!response.ok) throw new ImdApiError(response.status, url, data);
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new ImdSchemaError(
        url,
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
      );
    }
    return parsed.data;
  }

  /** `GET /health`: daemons connected, work in progress, queue depths, and whether payments are on. */
  health(): Promise<Health> {
    return this.#json(Health, "GET", this.#url("/health"));
  }

  /** `GET /requests/capabilities`: the live price, token and recipient of every paid action. */
  capabilities(): Promise<Capabilities> {
    return this.#json(Capabilities, "GET", this.#url("/requests/capabilities"));
  }

  /** `GET /jobs`: newest first. Objectives are shortened here; read one job for the whole text. */
  jobs(query: JobsQuery = {}): Promise<JobsList> {
    return this.#json(
      JobsList,
      "GET",
      this.#url("/jobs", {
        before: query.before,
        limit: query.limit,
        q: query.q,
        since: query.since,
        exclude: query.excludeOracle ? "oracle" : undefined,
      }),
    );
  }

  /** `GET /jobs/:id`: state, the full objective, who paid, and the seats that worked. */
  job(id: string): Promise<Job> {
    return this.#json(Job, "GET", this.#url(`/jobs/${assertId(id, "job id")}`));
  }

  /** `GET /jobs/:id/result`: accepted files with their hashes and download URLs. */
  jobResult(id: string): Promise<JobResult> {
    return this.#json(JobResult, "GET", this.#url(`/jobs/${assertId(id, "job id")}/result`));
  }

  /** `GET /jobs/:id/records`: the work-record hash and whether its receipt has been written. */
  jobRecords(id: string): Promise<JobRecords> {
    return this.#json(JobRecords, "GET", this.#url(`/jobs/${assertId(id, "job id")}/records`));
  }

  /** One job with its result and records: three reads, in the queue like any others. */
  async jobBundle(id: string): Promise<{ job: Job; result: JobResult; records: JobRecords }> {
    const job = await this.job(id);
    const result = await this.jobResult(id);
    const records = await this.jobRecords(id);
    return { job, result, records };
  }

  /**
   * `GET /work-records/:hash.json` as raw bytes, checked against the hash that was asked for. The
   * bytes returned are the ones to submit on chain; never re-serialise them.
   */
  async workRecord(hash: string): Promise<CheckedRecord> {
    const url = workRecordUrl(hash, this.baseUrl);
    const response = await this.#send("GET", url);
    if (!response.ok) {
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // A refusal without a JSON body still carries its status.
      }
      throw new ImdApiError(response.status, url, body);
    }
    return checkRecordBytes(new Uint8Array(await response.arrayBuffer()), hash);
  }

  /** `GET /oracle/requests`: newest first. */
  oracleRequests(query: OracleRequestsQuery = {}): Promise<OracleRequestsList> {
    return this.#json(
      OracleRequestsList,
      "GET",
      this.#url("/oracle/requests", {
        before: query.before,
        limit: query.limit,
        jobId: query.jobId,
        status: query.status?.join(","),
        q: query.q,
      }),
    );
  }

  /**
   * `GET /oracle/requests/:id`. Panel members are left out unless asked for: they are most of the
   * document and nothing on chain depends on them.
   */
  oracleRequest(id: string, options: { members?: boolean } = {}): Promise<OracleRequest> {
    return this.#json(
      OracleRequest,
      "GET",
      this.#url(`/oracle/requests/${assertId(id, "oracle request id")}`, {
        members: options.members ? undefined : 0,
      }),
    );
  }

  /** `GET /oracle/requests/:id/attestation`: 404 `not_attested` until the answer is signed. */
  oracleAttestation(id: string): Promise<OracleAttestationDocument> {
    return this.#json(
      OracleAttestationDocument,
      "GET",
      this.#url(`/oracle/requests/${assertId(id, "oracle request id")}/attestation`),
    );
  }

  /**
   * `GET /intake/:chainId/:transactionHash`: what the plane has made of the Intake requests in one
   * transaction. Each entry carries its state (`received`, `paid`, `admitted`, `completing`, and
   * finally `completed`, `refused` or `failed`), the oracle request it opened
   * (`admission.result.requestId`) and what the writer will write or has written on chain
   * (`completion`). Throws `ImdApiError` with code `unknown_transaction` (see
   * `isUnknownTransaction`) until the plane has seen the transaction.
   */
  intakeRead(chainId: number, transactionHash: string): Promise<IntakeRead> {
    if (!Number.isSafeInteger(chainId) || chainId <= 0)
      throw new TypeError("chainId must be a positive integer");
    if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
      throw new TypeError("transactionHash must be 0x followed by 64 hex characters");
    }
    return this.#json(IntakeRead, "GET", this.#url(`/intake/${chainId}/${transactionHash.toLowerCase()}`));
  }

  /** `GET /launches`: `before` is a launch number here, not a time. */
  launches(query: { limit?: number; before?: number } = {}): Promise<LaunchesList> {
    return this.#json(
      LaunchesList,
      "GET",
      this.#url("/launches", { limit: query.limit, before: query.before }),
    );
  }

  /** `GET /launches/:id`. */
  launch(id: string): Promise<Launch> {
    return this.#json(Launch, "GET", this.#url(`/launches/${assertId(id, "launch id")}`));
  }

  /**
   * `GET /requests/paid-by/:address`: every order a wallet paid or tried to pay for, newest first, at
   * most 100. Public, and needs no request token: it is how a payer that lost its token finds the
   * jobs it already bought, instead of buying them again.
   */
  paidBy(payer: string): Promise<PaidByList> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(payer)) throw new TypeError("payer must be an address");
    return this.#json(PaidByList, "GET", this.#url(`/requests/paid-by/${payer.toLowerCase()}`));
  }

  /**
   * `POST /requests/check`: the free preflight. It says what a quote would say, holds no price and
   * needs no token. A runner calls it before it claims an order, because the 0.5 IMD a job costs
   * buys admission only and is never refunded. The protocol counts a check as a quote for its rate
   * limit (30 a minute), which the queue's default gap already respects.
   */
  check(action: PaidAction, input: unknown): Promise<CheckResult> {
    return this.#json(CheckResult, "POST", this.#url("/requests/check"), { action, input });
  }
}
