/**
 * A small in-process cache for upstream reads, and the two guards that sit in front of an upstream.
 *
 * Visitor traffic must never be passed one-to-one to api.imd.fun or to the public RPC, so every
 * upstream read goes through `TtlCache.get`: one load per key at a time, an answer that stays fresh
 * for `ttlMs`, and after that the old answer keeps being served while one refresh runs in the
 * background (`swrMs`). If the refresh fails the old answer is still served, marked stale, for
 * `staleIfErrorMs`. A page therefore says how old its numbers are instead of failing.
 *
 * A slow or failing upstream must not make pages slow either. Two rules see to that:
 *
 * - A failed load is remembered for `failureTtlMs`. While it is remembered nobody loads that key
 *   again: readers get the old answer (marked stale, with the failure) or the failure itself, at once.
 * - Only a first read waits for its load to finish. Any later read that has something else to say
 *   (an old answer, or a remembered failure) waits `graceMs` at most and then says that, while the
 *   load carries on in the background.
 */

export interface Cached<T> {
  value: T;
  /** When the value was loaded, in epoch milliseconds. */
  fetchedAt: number;
  /** True when the value is older than its time to live. */
  stale: boolean;
  /** The message of the last failed refresh, when the value is being served past a failure. */
  error: string | null;
}

export interface CacheOptions {
  ttlMs: number;
  /** How long past `ttlMs` the old value may be served while a refresh runs. Default: `ttlMs`. */
  swrMs?: number;
  /** How long past `ttlMs` the old value may be served after a failed refresh. Default: 10 minutes. */
  staleIfErrorMs?: number;
}

interface Entry {
  value: unknown;
  fetchedAt: number;
  error: string | null;
}

interface Failure {
  at: number;
  error: unknown;
}

export interface TtlCacheOptions {
  now?: () => number;
  maxEntries?: number;
  /** How long a failed load is remembered, during which the key is not loaded again. Default 20 s. */
  failureTtlMs?: number;
  /** The longest a read that has an older answer or a remembered failure waits for a load. Default 1.5 s. */
  graceMs?: number;
}

/**
 * Waits for `promise` for at most `ms`. Resolves to `{ done: false }` when the time runs out (the
 * promise keeps running); rejects only if the promise rejects first.
 */
export function within<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ done: true; value: T } | { done: false }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ done: false }), Math.max(0, ms));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ done: true, value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export class TtlCache {
  readonly #entries = new Map<string, Entry>();
  readonly #inflight = new Map<string, Promise<unknown>>();
  readonly #failures = new Map<string, Failure>();
  readonly #now: () => number;
  readonly #maxEntries: number;
  readonly #failureTtlMs: number;
  readonly #graceMs: number;

  constructor(options: TtlCacheOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxEntries = options.maxEntries ?? 2000;
    this.#failureTtlMs = options.failureTtlMs ?? 20_000;
    this.#graceMs = options.graceMs ?? 1500;
  }

  /** The cached value if there is one, whatever its age. Never loads. */
  peek<T>(key: string): Cached<T> | null {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    return { value: entry.value as T, fetchedAt: entry.fetchedAt, stale: true, error: entry.error };
  }

  async get<T>(key: string, options: CacheOptions, load: () => Promise<T>): Promise<Cached<T>> {
    const now = this.#now();
    const entry = this.#entries.get(key);
    const swrMs = options.swrMs ?? options.ttlMs;
    const staleIfErrorMs = options.staleIfErrorMs ?? 600_000;
    const age = entry ? now - entry.fetchedAt : Number.POSITIVE_INFINITY;

    if (entry && age < options.ttlMs) {
      return { value: entry.value as T, fetchedAt: entry.fetchedAt, stale: false, error: null };
    }

    const failure = this.#failures.get(key);
    const backingOff = failure !== undefined && now - failure.at < this.#failureTtlMs;
    const old = (error: string | null): Cached<T> => ({
      value: (entry as Entry).value as T,
      fetchedAt: (entry as Entry).fetchedAt,
      stale: true,
      error,
    });

    if (entry && age < options.ttlMs + swrMs) {
      // Serve what we have and refresh behind the visitor's back, unless a refresh just failed.
      if (!backingOff) void this.#load(key, load).catch(() => undefined);
      return old(entry.error);
    }

    // Past the refresh window an old answer is only a fallback: used when no new one can be had.
    const fallback = entry !== undefined && age < options.ttlMs + staleIfErrorMs;
    if (backingOff) {
      if (fallback) return old(messageOf(failure.error));
      throw failure.error;
    }

    const loading = this.#load(key, load);
    const fresh = (value: T): Cached<T> => ({
      value,
      fetchedAt: this.#entries.get(key)?.fetchedAt ?? this.#now(),
      stale: false,
      error: null,
    });
    if (!fallback && failure === undefined) {
      // A first read: there is nothing else to say, so it waits for its answer.
      return fresh(await loading);
    }
    try {
      const settled = await within(loading, this.#graceMs);
      if (settled.done) return fresh(settled.value);
    } catch (error) {
      if (fallback) return old(messageOf(error));
      throw error;
    }
    // The load is slow. It carries on for the next reader; this one is answered now.
    void loading.catch(() => undefined);
    if (fallback) return old(entry?.error ?? (failure ? messageOf(failure.error) : null));
    throw (failure as Failure).error;
  }

  /** Runs `load` unless a load for the same key is already running, and stores what it returns. */
  #load<T>(key: string, load: () => Promise<T>): Promise<T> {
    const running = this.#inflight.get(key);
    if (running) return running as Promise<T>;
    const promise = (async () => {
      try {
        const value = await load();
        this.#failures.delete(key);
        this.#store(key, { value, fetchedAt: this.#now(), error: null });
        return value;
      } catch (error) {
        const old = this.#entries.get(key);
        if (old) old.error = messageOf(error);
        if (this.#failures.size > this.#maxEntries) this.#failures.clear();
        this.#failures.set(key, { at: this.#now(), error });
        throw error;
      } finally {
        this.#inflight.delete(key);
      }
    })();
    this.#inflight.set(key, promise);
    return promise;
  }

  #store(key: string, entry: Entry): void {
    // Re-inserting moves the key to the end, so the first key is always the least recently written.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  set<T>(key: string, value: T): void {
    this.#failures.delete(key);
    this.#store(key, { value, fetchedAt: this.#now(), error: null });
  }

  /** Ages of what is held, for `/api/v1/status`. */
  summary(): { entries: number; inflight: number; failuresRemembered: number } {
    return {
      entries: this.#entries.size,
      inflight: this.#inflight.size,
      failuresRemembered: this.#failures.size,
    };
  }
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * At most `max` events in any window of `windowMs`. Used to keep this server's own calls to
 * api.imd.fun and to the RPC far below their public limits, and to keep one visitor from spending
 * those budgets alone.
 */
export class SlidingWindowLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #hits = new Map<string, number[]>();

  constructor(options: { max: number; windowMs: number; now?: () => number }) {
    this.#max = options.max;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? Date.now;
  }

  /** Records one event for `key` if the window has room. Returns how long to wait when it has not. */
  take(key = "all"): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.#now();
    const hits = (this.#hits.get(key) ?? []).filter((at) => now - at < this.#windowMs);
    if (hits.length >= this.#max) {
      this.#hits.set(key, hits);
      const oldest = hits[0] ?? now;
      return { ok: false, retryAfterMs: Math.max(1, oldest + this.#windowMs - now) };
    }
    hits.push(now);
    this.#hits.set(key, hits);
    if (this.#hits.size > 5000) this.#prune(now);
    return { ok: true };
  }

  /** Events counted for `key` in the current window. */
  used(key = "all"): number {
    const now = this.#now();
    return (this.#hits.get(key) ?? []).filter((at) => now - at < this.#windowMs).length;
  }

  #prune(now: number): void {
    for (const [key, hits] of this.#hits) {
      if (hits.every((at) => now - at >= this.#windowMs)) this.#hits.delete(key);
    }
  }
}

/** Thrown when this server's own budget for an upstream is spent. Carries when to try again. */
export class UpstreamBusyError extends Error {
  readonly retryAfterMs: number;

  constructor(upstream: string, retryAfterMs: number) {
    super(`${upstream} budget for this minute is spent; try again in ${Math.ceil(retryAfterMs / 1000)} s`);
    this.name = "UpstreamBusyError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Thrown, without asking, while an upstream that has just failed repeatedly is being left alone. */
export class UpstreamDownError extends Error {
  readonly retryAfterMs: number;

  constructor(upstream: string, retryAfterMs: number, last: string) {
    super(
      `${upstream} did not answer just now (${last}); not asked again for ${Math.ceil(retryAfterMs / 1000)} s`,
    );
    this.name = "UpstreamDownError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Stops asking an upstream that is not answering. After `threshold` failures in a row, or after a
 * single timeout, the upstream is left alone for `openMs`: `check` throws at once instead of letting
 * a request wait out its timeout. The first request after that is let through as a probe; one
 * success closes the breaker.
 *
 * A timeout opens it at once because it is the failure that costs a reader seconds: one page may
 * wait for it, the next must not. Only failures to get an answer count (a timeout, a refused
 * connection, a 5xx). An answer the caller does not like, such as a 404 or a reverted call, is an
 * answer.
 */
export class Breaker {
  readonly #upstream: string;
  readonly #threshold: number;
  readonly #openMs: number;
  readonly #now: () => number;
  #failures = 0;
  #openedAt: number | null = null;
  #last = "no answer";

  constructor(upstream: string, options: { threshold?: number; openMs?: number; now?: () => number } = {}) {
    this.#upstream = upstream;
    this.#threshold = options.threshold ?? 2;
    this.#openMs = options.openMs ?? 15_000;
    this.#now = options.now ?? Date.now;
  }

  /** Throws `UpstreamDownError` while the upstream is being left alone. */
  check(): void {
    if (this.#openedAt === null) return;
    const left = this.#openedAt + this.#openMs - this.#now();
    if (left > 0) throw new UpstreamDownError(this.#upstream, left, this.#last);
  }

  succeeded(): void {
    this.#failures = 0;
    this.#openedAt = null;
  }

  failed(error: unknown): void {
    this.#failures++;
    this.#last = messageOf(error);
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (timedOut || this.#failures >= this.#threshold) this.#openedAt = this.#now();
  }

  get open(): boolean {
    return this.#openedAt !== null && this.#openedAt + this.#openMs - this.#now() > 0;
  }
}
