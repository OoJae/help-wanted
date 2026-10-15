/**
 * The keeper bot's status file as a data source.
 *
 * The keeper (`bots/keeper`) is a separate program. After every pass it writes a small JSON
 * document that says what it checked, what it sent, what it is waiting for and when each feed is
 * next due. It holds nothing secret. This server shows it when it has been told where it is: a file
 * path (`KEEPER_STATUS_PATH`) when the two run on one machine, or an address (`KEEPER_STATUS_URL`)
 * when they do not. With neither set the pages say plainly that no keeper status is connected.
 *
 * The document is somebody else's output: only the few fields a page prints are read, each
 * defensively, and anything that is not the expected shape is left out.
 */
import { readFile } from "node:fs/promises";
import { messageOf, TtlCache } from "~/lib/cache";

export interface KeeperAction {
  module: string;
  label: string;
  /** `sent`, `dry-run`, `failed`, `planned` or `left`. */
  outcome: string;
  hash: string | null;
}

export interface KeeperDue {
  feed: string;
  block: string | null;
  /** Unix seconds; null while a round is pending or the feed does not exist. */
  at: number | null;
  note: string;
}

export interface KeeperStatus {
  /** When the keeper wrote the file (ISO 8601). */
  at: string;
  mode: string;
  /** The keeper's address, when it has one. */
  keeper: string | null;
  block: number | null;
  killed: boolean;
  /** What an operator should look at; empty when all is well. */
  attention: string[];
  nextDue: KeeperDue[];
  /** What the last pass sent, would have sent, or failed to send. */
  done: KeeperAction[];
  errors: string[];
}

export type KeeperRead =
  | { configured: false }
  | { configured: true; from: string; status: KeeperStatus | null; fetchedAt: number; error: string | null };

export interface KeeperSource {
  status(): Promise<KeeperRead>;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function strings(value: unknown, max = 20): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, max) : [];
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Reads the fields a page prints out of a status document. Null when it is not one. */
export function parseKeeperStatus(body: unknown): KeeperStatus | null {
  const o = obj(body);
  const at = str(o?.at);
  if (!o || o.v !== 1 || !at || Number.isNaN(Date.parse(at))) return null;
  const block = obj(o.block);
  const blockNumber = str(block?.number);
  const list = (value: unknown) => (Array.isArray(value) ? value.map(obj).filter((v) => v !== null) : []);
  return {
    at,
    mode: str(o.mode) ?? "unknown",
    keeper: /^0x[0-9a-fA-F]{40}$/.test(str(o.keeper) ?? "") ? (o.keeper as string).toLowerCase() : null,
    block: blockNumber && /^\d{1,12}$/.test(blockNumber) ? Number(blockNumber) : null,
    killed: o.killed === true,
    attention: strings(o.attention),
    nextDue: list(o.nextDue)
      .slice(0, 12)
      .map((d) => ({
        feed: str(d.feed) ?? "",
        block: str(d.block),
        at: typeof d.at === "number" && Number.isFinite(d.at) ? d.at : null,
        note: str(d.note) ?? "",
      }))
      .filter((d) => d.feed !== ""),
    done: list(o.done)
      .slice(-12)
      .map((a) => ({
        module: str(a.module) ?? "",
        label: str(a.label) ?? "",
        outcome: str(a.outcome) ?? "",
        hash: /^0x[0-9a-fA-F]{64}$/.test(str(a.hash) ?? "") ? (a.hash as string) : null,
      }))
      .filter((a) => a.label !== ""),
    errors: list(o.errors)
      .slice(0, 12)
      .map((e) => `${str(e.module) ?? "keeper"}: ${str(e.error) ?? "error"}`),
  };
}

export interface KeeperOptions {
  path: string | null;
  url: string | null;
  fetch?: typeof fetch;
  cache?: TtlCache;
  /** Reads the file; replaced in tests. */
  read?: (path: string) => Promise<string>;
}

/** The status file is small, and nothing on a page depends on it: one read a minute is plenty. */
const TTL_MS = 60_000;
const MAX_BYTES = 512_000;

export function keeperSource(options: KeeperOptions): KeeperSource {
  const { path, url } = options;
  if (!path && !url) return { status: async () => ({ configured: false }) };
  const cache = options.cache ?? new TtlCache();
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const read = options.read ?? ((file: string) => readFile(file, "utf8"));
  // Said on the page without the path or the address itself, which are the operator's business.
  const from = path ? "a file beside this server" : "an address this server was given";
  const load = async (): Promise<KeeperStatus> => {
    let text: string;
    if (path) {
      text = await read(path);
    } else {
      const response = await doFetch(url as string, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok) throw new Error(`the keeper's status answered HTTP ${response.status}`);
      text = await response.text();
    }
    if (text.length > MAX_BYTES) throw new Error("the keeper's status file is larger than this site reads");
    const status = parseKeeperStatus(JSON.parse(text) as unknown);
    if (!status) throw new Error("the keeper's status file is not in the shape this site reads");
    return status;
  };
  return {
    async status(): Promise<KeeperRead> {
      try {
        const cached = await cache.get("keeper:status", { ttlMs: TTL_MS }, load);
        return {
          configured: true,
          from,
          status: cached.value,
          fetchedAt: cached.fetchedAt,
          error: cached.error,
        };
      } catch (error) {
        return { configured: true, from, status: null, fetchedAt: Date.now(), error: messageOf(error) };
      }
    },
  };
}
