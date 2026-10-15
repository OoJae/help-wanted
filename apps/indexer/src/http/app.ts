/**
 * The read-only JSON API, as one function from a `Request` to a `Response`.
 *
 * It only answers GET (and HEAD and OPTIONS), takes no body, sets no cookie and writes nothing.
 * Every answer is JSON with `access-control-allow-origin: *`, because the data is public: it is
 * the chain and the public IdentityMD API, re-served. Amounts are decimal strings of wei.
 *
 * Every answer about chain data carries `coverage` (see `ChainSource`): the block range it was
 * read from and whether the module's handler is finished. The indexer holds a window of the
 * chain, not all of it, and some of its tables are not filled yet; an answer that did not say so
 * would let "not in the window" or "not indexed yet" be read as "not on chain".
 */
import type { IndexerLive } from "../engine/indexer.js";
import { isUuid } from "../ids.js";
import { toJson } from "../json.js";
import { errorMessage, type Logger } from "../log.js";
import { ORDER_STATES, type OrderState } from "../modules/own/workOrders.js";
import { PAYROLL_KINDS, type PayrollKind } from "../modules/own/payroll.js";
import type { Queries } from "../queries.js";
import { formatImd, type PayerTally, type Split, type Tally } from "../report/tally.js";

export interface AppOptions {
  queries: Queries;
  /** The running engine's view (head, errors). Absent when the API runs without a sync loop. */
  live?: () => IndexerLive | null;
  /**
   * How old the last good sync pass may be before the status route stops saying `ok`. Default
   * `DEFAULT_STALE_AFTER_MS`; the process sets it from its poll interval.
   */
  staleAfterMs?: number;
  /** Whether this process mirrors the IdentityMD API. Left out, the status route says null. */
  mirrorEnabled?: boolean;
  /** Epoch milliseconds. */
  now?: () => number;
  log?: Logger;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const badRequest = (message: string) => new HttpError(400, message);
const notFound = (message = "not found") => new HttpError(404, message);

interface Context {
  params: Record<string, string>;
  query: URLSearchParams;
}

type Handler = (context: Context) => Promise<unknown>;

/** A module is "behind" past this many blocks; the status route then reports `ok: false`. */
export const MAX_BLOCKS_BEHIND = 20;

/** Mainnet's slot time: how fast the chain is expected to move while the node is not answering. */
const SECONDS_PER_BLOCK = 12;

/**
 * The status route reports `ok: false` once the last good sync pass is older than this: the time
 * the chain takes to add `MAX_BLOCKS_BEHIND` blocks.
 */
export const DEFAULT_STALE_AFTER_MS = MAX_BLOCKS_BEHIND * SECONDS_PER_BLOCK * 1000;

/** The mirror counts as fresh while `/health` was last copied within this time. */
export const MIRROR_FRESH_MS = 10 * 60_000;

function whole(query: URLSearchParams, name: string, min: number, max: number): number | undefined {
  const raw = query.get(name);
  if (raw === null || raw === "") return undefined;
  if (!/^[0-9]{1,15}$/.test(raw)) throw badRequest(`${name} must be a whole number`);
  const value = Number(raw);
  if (value < min || value > max) throw badRequest(`${name} must be between ${min} and ${max}`);
  return value;
}

function addressParam(query: URLSearchParams, name: string): string | undefined {
  const raw = query.get(name);
  if (raw === null || raw === "") return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw badRequest(`${name} must be an address`);
  return raw.toLowerCase();
}

function oneOf<T extends string>(query: URLSearchParams, name: string, allowed: readonly T[]): T | undefined {
  const raw = query.get(name);
  if (raw === null || raw === "") return undefined;
  if (!(allowed as readonly string[]).includes(raw))
    throw badRequest(`${name} must be one of ${allowed.join(", ")}`);
  return raw as T;
}

function pathId(context: Context, max = Number.MAX_SAFE_INTEGER): number {
  const raw = context.params.id ?? "";
  if (!/^[0-9]{1,15}$/.test(raw) || Number(raw) > max) throw badRequest("the id must be a whole number");
  return Number(raw);
}

const LIMIT = { min: 1, max: 1000 } as const;
const limitOf = (query: URLSearchParams) => whole(query, "limit", LIMIT.min, LIMIT.max);

function showSplit(split: Split) {
  return {
    amountWei: split.amount,
    amountImd: formatImd(split.amount),
    payments: split.payments,
    payers: split.payers,
  };
}

function showTally(tally: Tally) {
  return {
    ...showSplit(tally),
    house: showSplit(tally.house),
    outside: showSplit(tally.outside),
    zeroValueLogs: tally.zeroValueLogs,
  };
}

function showPayer(payer: PayerTally) {
  return {
    payer: payer.payer,
    amountWei: payer.amount,
    amountImd: formatImd(payer.amount),
    payments: payer.payments,
    label: payer.house ? "HOUSE" : "OUTSIDE",
  };
}

/** The routes, in the order the index lists them. `:name` is a path parameter. */
function routes(options: AppOptions): [pattern: string, about: string, handler: Handler][] {
  const q = options.queries;
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  return [
    [
      "/v1/status",
      "What is indexed, how far behind the chain each module is, and how fresh the API mirror is.",
      async () => {
        const [store, live] = [await q.status(), options.live?.() ?? null];
        const liveByModule = new Map((live?.modules ?? []).map((module) => [module.module, module]));
        const at = now();
        const age = (then: number | null | undefined) =>
          then === null || then === undefined ? null : Math.max(0, Math.round((at - then) / 1000));
        const head = live?.head ?? null;
        const headAgeSeconds = age(live?.headAtMs);
        // While the node is not answering, the head last read is not the head: the chain is taken
        // to have moved on at its usual pace, so an outage shows up as modules falling behind.
        const unseen = headAgeSeconds === null ? 0 : Math.floor(headAgeSeconds / SECONDS_PER_BLOCK);
        const modules = (live?.modules ?? store.modules.map((entry) => ({ module: entry.module }))).map(
          (entry) => {
            const stored = store.modules.find((candidate) => candidate.module === entry.module);
            const running = liveByModule.get(entry.module);
            const behind =
              head !== null && stored?.throughBlock != null
                ? Math.max(0, head - stored.throughBlock) + unseen
                : null;
            return {
              module: entry.module,
              title: running?.title ?? null,
              enabled: running?.enabled ?? null,
              handler: q.handlerOf(entry.module),
              fromBlock: stored?.fromBlock ?? null,
              throughBlock: stored?.throughBlock ?? null,
              throughTime: stored?.throughTime ?? null,
              throughHash: stored?.throughHash ?? null,
              blocksBehind: behind,
              events: stored?.events ?? 0,
              unfolded: stored?.unfolded ?? 0,
              eventsOutside: stored?.eventsOutside ?? 0,
              backfill: stored?.backfill ?? null,
              lastError: running?.lastError ?? null,
              retryInSeconds:
                running?.retryAtMs == null ? null : Math.max(0, Math.round((running.retryAtMs - at) / 1000)),
            };
          },
        );
        const enabled = modules.filter((module) => module.enabled === true);
        const late = enabled.some((module) => (module.blocksBehind ?? 0) > MAX_BLOCKS_BEHIND);
        const unfolded = enabled.some((module) => module.unfolded > 0);
        const goodPassAgeMs = live?.lastOkTickAtMs == null ? null : Math.max(0, at - live.lastOkTickAtMs);
        const stale = goodPassAgeMs === null || goodPassAgeMs > staleAfterMs;
        const healthAge = age(store.mirror.healthFetchedAtMs);
        return {
          // True only when the last pass synced every module, that pass is recent, no module is
          // far behind and no log is waiting for a handler that could not fold it.
          ok: live === null ? null : live.lastTickOk === true && !stale && !late && !unfolded,
          chainId: 1,
          head,
          headAgeSeconds,
          lastTickAtMs: live?.lastTickAtMs ?? null,
          lastGoodPassAgeSeconds: goodPassAgeMs === null ? null : Math.round(goodPassAgeMs / 1000),
          lastPassError: live?.lastTickError ?? null,
          modules,
          rows: store.rows,
          mirror: {
            enabled: options.mirrorEnabled ?? null,
            ok:
              options.mirrorEnabled === true
                ? healthAge !== null && healthAge * 1000 <= MIRROR_FRESH_MS
                : null,
            healthAgeSeconds: healthAge,
            jobsAgeSeconds: age(store.mirror.jobsFetchedAtMs),
            oracleRequestsAgeSeconds: age(store.mirror.oracleRequestsFetchedAtMs),
          },
        };
      },
    ],
    [
      "/v1/receipts",
      "WorkRegistry receipts in the indexed range (see coverage), newest first. ?limit ?fromBlock ?toBlock",
      async ({ query }) => ({
        coverage: await q.source("receipts"),
        receipts: await q.receipts({
          limit: limitOf(query),
          fromBlock: whole(query, "fromBlock", 0, Number.MAX_SAFE_INTEGER),
          toBlock: whole(query, "toBlock", 0, Number.MAX_SAFE_INTEGER),
        }),
      }),
    ],
    [
      "/v1/receipts/:job",
      "The receipts of one job (UUID or 0x bytes16) in the indexed range, newest first. latest: null means none in that range (see coverage), not none on chain.",
      async ({ params }) => {
        const found = await q.jobReceipts(params.job ?? "");
        if (!found) throw badRequest("the job must be a UUID or a 0x bytes16 id");
        return found;
      },
    ],
    [
      "/v1/intake/requests",
      "Oracle requests bought through the Intake in the indexed range (see coverage), newest first. ?limit ?payer ?callbackTarget",
      async ({ query }) => ({
        coverage: await q.source("intake"),
        requests: await q.intakeRequests({
          limit: limitOf(query),
          payer: addressParam(query, "payer"),
          callbackTarget: addressParam(query, "callbackTarget"),
        }),
      }),
    ],
    [
      "/v1/intake/requests/:id",
      "One Intake request by its bytes32 request id.",
      async ({ params }) => {
        if (!/^0x[0-9a-fA-F]{64}$/.test(params.id ?? "")) throw badRequest("the id must be a bytes32");
        const request = await q.intakeRequest(params.id as string);
        if (!request) throw notFound("no such request in the indexed range (see /v1/intake/requests for it)");
        return { coverage: await q.source("intake"), request };
      },
    ],
    [
      "/v1/fee-transfers",
      "IMD transfers to the fee payee, newest first. ?limit ?fromBlock ?toBlock ?from",
      async ({ query }) => {
        const transfers = await q.feeTransfers({
          limit: limitOf(query),
          fromBlock: whole(query, "fromBlock", 0, Number.MAX_SAFE_INTEGER),
          toBlock: whole(query, "toBlock", 0, Number.MAX_SAFE_INTEGER),
          from: addressParam(query, "from"),
        });
        return {
          coverage: await q.source("fee_transfers"),
          transfers: transfers.map((transfer) => ({
            ...transfer,
            label: q.isHouse(transfer.from) ? "HOUSE" : "OUTSIDE",
          })),
        };
      },
    ],
    [
      "/v1/jobs-report/daily",
      "The unofficial Jobs Report tally per UTC day, oldest first, HOUSE and OUTSIDE split. ?days",
      async ({ query }) => {
        const report = await q.jobsReportDaily({ days: whole(query, "days", 1, 366) });
        return {
          unofficial: true,
          source: "IMD Transfer logs to the fee payee, counted by this indexer",
          counting:
            "every Transfer log to the fee payee is a payment, zero-value ones included (zeroValueLogs says how many), as the official hires feed counts",
          coverage: report.coverage,
          days: report.days.map((day) => ({
            day: day.day,
            complete: day.complete,
            firstBlock: day.firstBlock,
            lastBlock: day.lastBlock,
            ...showTally(day),
          })),
        };
      },
    ],
    [
      "/v1/jobs-report/window",
      "The same tally for one inclusive block window, with its top payers. ?fromBlock ?toBlock (both required)",
      async ({ query }) => {
        const fromBlock = whole(query, "fromBlock", 0, Number.MAX_SAFE_INTEGER);
        const toBlock = whole(query, "toBlock", 0, Number.MAX_SAFE_INTEGER);
        if (fromBlock === undefined || toBlock === undefined)
          throw badRequest("fromBlock and toBlock are required");
        if (toBlock < fromBlock) throw badRequest("toBlock must not be below fromBlock");
        const window = await q.jobsReportWindow({ fromBlock, toBlock });
        return {
          unofficial: true,
          coverage: await q.source("fee_transfers"),
          fromBlock: window.fromBlock,
          toBlock: window.toBlock,
          covered: window.covered,
          ...showTally(window.tally),
          topPayers: window.topPayers.map(showPayer),
        };
      },
    ],
    [
      "/v1/orders",
      "Orders on the hire desk, newest first. ?limit ?state ?employer",
      async ({ query }) => {
        const found = await q.orders({
          limit: limitOf(query),
          state: oneOf<OrderState>(query, "state", ORDER_STATES),
          employer: addressParam(query, "employer"),
        });
        return {
          coverage: await q.source("work_orders"),
          orders: found.map((order) => ({
            ...order,
            label: q.isHouse(order.employer) ? "HOUSE" : "OUTSIDE",
          })),
        };
      },
    ],
    [
      "/v1/orders/:id",
      "One order with every claim made on it.",
      async (context) => {
        const found = await q.order(pathId(context));
        if (!found) throw notFound("no such order in the indexed range (see /v1/orders for it)");
        return {
          coverage: await q.source("work_orders"),
          ...found,
          label: q.isHouse(found.order.employer) ? "HOUSE" : "OUTSIDE",
        };
      },
    ],
    [
      "/v1/pots",
      "Crowd pots, newest first. ?limit",
      async ({ query }) => ({
        coverage: await q.source("crowd_pots"),
        pots: await q.pots({ limit: limitOf(query) }),
      }),
    ],
    [
      "/v1/pots/:id",
      "One pot with its contributors.",
      async (context) => {
        const found = await q.pot(pathId(context));
        if (!found) throw notFound("no such pot in the indexed range (see /v1/pots for it)");
        return { coverage: await q.source("crowd_pots"), ...found };
      },
    ],
    [
      "/v1/feeds",
      "Standing Questions feeds.",
      async () => ({ coverage: await q.source("questions"), feeds: await q.feeds() }),
    ],
    [
      "/v1/feeds/:feed/rounds",
      "The rounds of one feed (bytes32 feed id), newest first. ?limit",
      async ({ params, query }) => {
        if (!/^0x[0-9a-fA-F]{64}$/.test(params.feed ?? "")) throw badRequest("the feed id must be a bytes32");
        return {
          coverage: await q.source("questions"),
          feedId: (params.feed as string).toLowerCase(),
          rounds: await q.rounds({ feedId: params.feed, limit: limitOf(query) }),
        };
      },
    ],
    [
      "/v1/rounds",
      "Rounds of every feed, newest first. ?limit",
      async ({ query }) => ({
        coverage: await q.source("questions"),
        rounds: await q.rounds({ limit: limitOf(query) }),
      }),
    ],
    [
      "/v1/prints",
      "Prints of the Jobs Report, newest first. ?limit",
      async ({ query }) => ({
        coverage: await q.source("jobs_report"),
        prints: await q.prints({ limit: limitOf(query) }),
      }),
    ],
    [
      "/v1/payroll/movements",
      "Payroll's ledger, newest first. ?limit ?kind",
      async ({ query }) => ({
        coverage: await q.source("payroll"),
        movements: await q.payrollMovements({
          limit: limitOf(query),
          kind: oneOf<PayrollKind>(query, "kind", PAYROLL_KINDS),
        }),
      }),
    ],
    [
      "/v1/rules",
      "WHEN/THEN rules, newest first. ?limit",
      async ({ query }) => ({
        coverage: await q.source("rules"),
        rules: await q.rules({ limit: limitOf(query) }),
      }),
    ],
    [
      "/v1/events",
      "Stored logs inside each module's indexed range, newest first; foldError is set on a log its handler could not fold. ?module ?event ?limit",
      async ({ query }) => {
        const module = query.get("module") ?? undefined;
        const event = query.get("event") ?? undefined;
        if (module !== undefined && !/^[a-z][a-z0-9_]{0,63}$/.test(module))
          throw badRequest("module is not a module name");
        if (event !== undefined && !/^[A-Za-z0-9_]{1,66}$/.test(event))
          throw badRequest("event is not an event name");
        return { events: await q.events({ module, event, limit: limitOf(query) }) };
      },
    ],
    [
      "/v1/mirror/health",
      "The newest copy of the IdentityMD API's /health, and one row per hour before it. ?limit",
      async ({ query }) => ({
        latest: await q.health(),
        history: await q.healthHistory({ limit: limitOf(query) }),
      }),
    ],
    [
      "/v1/mirror/jobs",
      "Mirrored swarm jobs, newest first. ?limit ?watched=true|false",
      async ({ query }) => {
        const watched = oneOf(query, "watched", ["true", "false"] as const);
        return {
          jobs: await q.jobs({
            limit: limitOf(query),
            watched: watched === undefined ? undefined : watched === "true",
          }),
        };
      },
    ],
    [
      "/v1/mirror/jobs/:id",
      "One mirrored job (UUID) with its work records and any receipts indexed from the chain.",
      async ({ params }) => {
        const id = (params.id ?? "").toLowerCase();
        if (!isUuid(id)) throw badRequest("the id must be a job UUID");
        const found = await q.job(id);
        if (!found) throw notFound("that job is not mirrored");
        return found;
      },
    ],
    [
      "/v1/mirror/oracle-requests",
      "Mirrored oracle requests, newest first. ?limit ?status",
      async ({ query }) => {
        const status = query.get("status") ?? undefined;
        if (status !== undefined && !/^[a-z_]{1,32}$/.test(status))
          throw badRequest("status is not a status name");
        return { requests: await q.oracleRequests({ limit: limitOf(query), status }) };
      },
    ],
  ];
}

interface Compiled {
  pattern: string;
  about: string;
  segments: string[];
  handler: Handler;
}

function match(route: Compiled, path: string[]): Record<string, string> | null {
  if (route.segments.length !== path.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < path.length; i++) {
    const expected = route.segments[i] as string;
    const actual = path[i] as string;
    if (expected.startsWith(":")) params[expected.slice(1)] = actual;
    else if (expected !== actual) return null;
  }
  return params;
}

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "x-content-type-options": "nosniff",
} as const;

/**
 * Writes a JSON answer. The body goes through `toJson` first: it turns bigint amounts into decimal
 * strings and refuses, with an ordinary error, a value nested deeper than `MAX_JSON_DEPTH`. Rows
 * are stored within that bound, so this only ever trips on a row an older version wrote; the
 * caller answers 500 for it and the process is never asked to walk an unbounded value.
 */
function json(status: number, body: unknown, method: string, extra: Record<string, string> = {}): Response {
  const text = `${JSON.stringify(toJson(body))}\n`;
  return new Response(method === "HEAD" ? null : text, { status, headers: { ...HEADERS, ...extra } });
}

export function createApp(options: AppOptions): (request: Request) => Promise<Response> {
  const compiled: Compiled[] = routes(options).map(([pattern, about, handler]) => ({
    pattern,
    about,
    segments: pattern.split("/").filter((segment) => segment.length > 0),
    handler,
  }));
  const index = {
    name: "HELP WANTED indexer",
    about: "Read-only. Chain data for Ethereum mainnet and a mirror of the public IdentityMD API.",
    routes: compiled.map((route) => ({ path: route.pattern, about: route.about })),
  };

  return async (request) => {
    const method = request.method.toUpperCase();
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
    if (method !== "GET" && method !== "HEAD") {
      return json(405, { error: "this API only answers GET" }, method, { allow: "GET, HEAD, OPTIONS" });
    }

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return json(400, { error: "unreadable URL" }, method);
    }
    if (url.pathname.length > 512 || url.search.length > 1024)
      return json(414, { error: "URL too long" }, method);

    let path: string[];
    try {
      path = url.pathname
        .split("/")
        .filter((segment) => segment.length > 0)
        .map(decodeURIComponent);
    } catch {
      return json(400, { error: "unreadable path" }, method);
    }
    if (path.length === 0 || (path.length === 1 && path[0] === "v1")) {
      return json(200, index, method, { "cache-control": "public, max-age=300" });
    }

    for (const route of compiled) {
      const params = match(route, path);
      if (!params) continue;
      try {
        const body = await route.handler({ params, query: url.searchParams });
        return json(200, body, method, { "cache-control": "public, max-age=10" });
      } catch (error) {
        if (error instanceof HttpError) return json(error.status, { error: error.message }, method);
        // Nothing about the failure is sent out; the operator reads it in the process log.
        options.log?.error("request failed", { route: route.pattern, error: errorMessage(error) });
        return json(500, { error: "internal error" }, method);
      }
    }
    return json(404, { error: "no such route", see: "/v1" }, method);
  };
}
