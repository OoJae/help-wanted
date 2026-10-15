/**
 * A deliberately slow HTTP GET for somebody else's API.
 *
 * `api.imd.fun` allows 120 public reads a minute per address and everything HELP WANTED runs
 * shares that allowance, so the indexer takes a small fixed slice of it: requests leave one at a
 * time with a fixed gap between starts (never more than 19 a minute, 12 by default). When the
 * server says to slow down (429) or is not serving (503, and the gateway errors 502 and 504), the
 * whole queue stops for as long as `Retry-After` asks, or for a doubling pause when it does not
 * say, before the same request is tried again. When the process is told to stop, whatever is
 * waiting is let go at once and nothing more is sent.
 *
 * It only ever sends GET, with no credential.
 */
import { MAX_API_CALLS_PER_MINUTE } from "../config.js";

export interface PoliteFetchOptions {
  fetch?: typeof fetch;
  /** Requests per minute. Clamped to 1..19. */
  callsPerMinute: number;
  /** Tries per request, the first included. Default 4. */
  maxAttempts?: number;
  /** The first pause after a refusal that names no `Retry-After`. Doubles each time. Default 5 s. */
  baseBackoffMs?: number;
  /** No single pause is longer than this, whatever the server asks. Default 5 minutes. */
  maxBackoffMs?: number;
  /** Per-try timeout. Default 20 s. */
  timeoutMs?: number;
  /** The largest body accepted, in characters. Default 5,000,000. */
  maxBodyChars?: number;
  userAgent?: string;
  /**
   * Fires when the process is stopping. A request waiting for its turn is released at once and
   * fails, one in flight is cut off, and nothing new is sent, so shutting down never has to wait
   * out a pause.
   */
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called once per try, for logs and tests. */
  onAttempt?: (info: { url: string; attempt: number; status: number | null; startedAt: number }) => void;
}

/** A request that still failed after every try, or that the server refused outright. */
export class ApiRequestError extends Error {
  readonly url: string;
  /** The HTTP status of the last try; null when no response arrived. */
  readonly status: number | null;

  constructor(url: string, status: number | null, detail: string) {
    super(`GET ${url} failed: ${detail}`);
    this.name = "ApiRequestError";
    this.url = url;
    this.status = status;
  }
}

const SLOW_DOWN = new Set([429, 502, 503, 504]);

const STOPPING = "the process is stopping";

/** Resolves after `ms`, or at once when the signal fires. */
function interruptibleSleep(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** `Retry-After` as milliseconds: a number of seconds or an HTTP date. Null when it is neither. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^[0-9]+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

export class PoliteFetcher {
  readonly minIntervalMs: number;
  readonly #fetch: typeof fetch;
  readonly #maxAttempts: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #timeoutMs: number;
  readonly #maxBodyChars: number;
  readonly #userAgent: string;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #signal: AbortSignal | null;
  readonly #onAttempt: PoliteFetchOptions["onAttempt"];
  /** The tail of the queue: each request waits for the one before it to have finished. */
  #queue: Promise<unknown> = Promise.resolve();
  #lastStart = Number.NEGATIVE_INFINITY;
  /** No request starts before this time: set when the server asks for a pause. */
  #pausedUntil = Number.NEGATIVE_INFINITY;

  constructor(options: PoliteFetchOptions) {
    const perMinute = Math.min(MAX_API_CALLS_PER_MINUTE, Math.max(1, Math.trunc(options.callsPerMinute)));
    this.minIntervalMs = Math.ceil(60_000 / perMinute);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 4);
    this.#baseBackoffMs = options.baseBackoffMs ?? 5000;
    this.#maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#maxBodyChars = options.maxBodyChars ?? 5_000_000;
    this.#userAgent = options.userAgent ?? "help-wanted-indexer/0.1";
    this.#now = options.now ?? Date.now;
    this.#signal = options.signal ?? null;
    this.#sleep = options.sleep ?? ((ms) => interruptibleSleep(ms, this.#signal));
    this.#onAttempt = options.onAttempt;
  }

  /** GETs `url` and parses the body as JSON. Requests made at the same time leave in order. */
  getJson(url: string): Promise<unknown> {
    const mine = this.#queue.then(() => this.#get(url));
    // A failed request must not jam the queue for the ones behind it.
    this.#queue = mine.catch(() => undefined);
    return mine;
  }

  /** @throws ApiRequestError when the process is stopping: nothing is sent after that. */
  async #waitForTurn(url: string): Promise<number> {
    for (;;) {
      if (this.#signal?.aborted) throw new ApiRequestError(url, null, STOPPING);
      const wait = Math.max(this.#lastStart + this.minIntervalMs, this.#pausedUntil) - this.#now();
      if (wait <= 0) break;
      await this.#sleep(wait);
    }
    this.#lastStart = this.#now();
    return this.#lastStart;
  }

  async #get(url: string): Promise<unknown> {
    let lastStatus: number | null = null;
    let lastDetail = "no attempt was made";
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      const startedAt = await this.#waitForTurn(url);
      let response: Response | null = null;
      try {
        const timeout = AbortSignal.timeout(this.#timeoutMs);
        response = await this.#fetch(url, {
          method: "GET",
          headers: { accept: "application/json", "user-agent": this.#userAgent },
          signal: this.#signal ? AbortSignal.any([timeout, this.#signal]) : timeout,
        });
      } catch (error) {
        if (this.#signal?.aborted) throw new ApiRequestError(url, null, STOPPING);
        lastDetail = error instanceof Error ? error.message : String(error);
      }
      lastStatus = response?.status ?? null;
      this.#onAttempt?.({ url, attempt, status: lastStatus, startedAt });

      if (response?.ok) {
        const text = await response.text();
        if (text.length > this.#maxBodyChars) {
          throw new ApiRequestError(
            url,
            response.status,
            `the body is larger than ${this.#maxBodyChars} characters`,
          );
        }
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new ApiRequestError(url, response.status, "the body is not JSON");
        }
      }

      if (response && !SLOW_DOWN.has(response.status)) {
        // 404 and the like: asking again would get the same answer.
        throw new ApiRequestError(url, response.status, `status ${response.status}`);
      }

      if (response) lastDetail = `status ${response.status}`;
      const asked = response ? parseRetryAfter(response.headers.get("retry-after"), this.#now()) : null;
      const pause = Math.min(this.#maxBackoffMs, asked ?? this.#baseBackoffMs * 2 ** (attempt - 1));
      this.#pausedUntil = Math.max(this.#pausedUntil, this.#now() + pause);
    }
    throw new ApiRequestError(url, lastStatus, `${lastDetail}, after ${this.#maxAttempts} tries`);
  }
}
