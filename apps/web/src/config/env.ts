/**
 * Runtime configuration, read from the environment when the server needs it (never at build time,
 * so one build runs anywhere). Every variable is optional; the defaults are the public endpoints.
 * `.env.example` lists them all.
 */
import { IMD_API_BASE } from "@help-wanted/shared";
import { DEFAULT_RPC_URL, PUBLIC_LOG_WINDOW_BLOCKS } from "./chain";

export interface AppEnv {
  /** Where this site is served from, without a trailing slash. Used for absolute links only. */
  siteOrigin: string | null;
  /** JSON-RPC endpoint for `eth_call` and recent logs. */
  rpcUrl: string;
  /**
   * An RPC that answers `eth_getLogs` over long ranges, when one is configured. Without it the
   * tally covers only what the public RPC serves (about one day) plus what this process has seen.
   */
  archiveRpcUrl: string | null;
  /**
   * The RPC asked for the WorkRegistry's log further back than `rpcUrl` serves, when looking for
   * IdentityMD's newest receipt. Defaults to `rpcUrl`. Nothing else reads it.
   */
  historyRpcUrl: string;
  /** How many blocks back `rpcUrl` serves logs. */
  logWindowBlocks: number;
  /** How many days of history the tally asks an archive RPC for. */
  tallyDays: number;
  imdApiBase: string;
  /** The most requests a minute this server sends to the IdentityMD API, for all visitors together. */
  apiMaxPerMinute: number;
  /** The most requests a minute this server sends to `rpcUrl`, for all visitors together. */
  rpcMaxPerMinute: number;
  /**
   * The request header that carries the visitor's address, when a proxy in front of this server
   * writes one. Null means the socket's own address is used. Only per-visitor limits read it.
   */
  clientIpHeader: string | null;
  /**
   * Where the keeper bot's status file is, when this server has been told: a path on this machine,
   * or an address to fetch it from. With neither, no keeper status is shown.
   */
  keeperStatusPath: string | null;
  keeperStatusUrl: string | null;
  /** Design aid only. When true every page carries a SAMPLE DATA banner. */
  sampleData: boolean;
  repoUrl: string | null;
  xHandle: string | null;
  /** Shown in `/api/v1/status`; set by the host (Railway sets `RAILWAY_GIT_COMMIT_SHA`). */
  commit: string | null;
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function url(value: string | undefined): string | null {
  const text = clean(value);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return text.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const text = clean(value);
  // `Number(null)` is 0, which would silently turn "not set" into the minimum.
  if (text === null) return fallback;
  const n = Number(text);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function flag(value: string | undefined): boolean {
  const text = clean(value)?.toLowerCase();
  return text === "1" || text === "true" || text === "yes";
}

/** A header name, lowercase, or null for anything that is not one. */
function headerName(value: string | undefined): string | null {
  const text = clean(value)?.toLowerCase() ?? null;
  return text && /^[a-z0-9-]{1,64}$/.test(text) ? text : null;
}

export function readEnv(env: Record<string, string | undefined> = process.env): AppEnv {
  // Railway's edge writes the visitor's address into X-Real-IP on every request it forwards.
  const onRailway = Boolean(clean(env.RAILWAY_ENVIRONMENT_NAME) ?? clean(env.RAILWAY_PUBLIC_DOMAIN));
  return {
    siteOrigin:
      url(env.SITE_ORIGIN) ?? (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : null),
    rpcUrl: url(env.RPC_URL) ?? DEFAULT_RPC_URL,
    archiveRpcUrl: url(env.ARCHIVE_RPC_URL),
    historyRpcUrl: url(env.HISTORY_RPC_URL) ?? url(env.RPC_URL) ?? DEFAULT_RPC_URL,
    logWindowBlocks: int(env.RPC_LOG_WINDOW_BLOCKS, PUBLIC_LOG_WINDOW_BLOCKS, 100, 1_000_000),
    tallyDays: int(env.TALLY_DAYS, 14, 1, 60),
    imdApiBase: url(env.IMD_API_BASE) ?? IMD_API_BASE,
    apiMaxPerMinute: int(env.IMD_API_MAX_PER_MINUTE, 40, 1, 100),
    rpcMaxPerMinute: int(env.RPC_MAX_PER_MINUTE, 240, 10, 6000),
    clientIpHeader: headerName(env.CLIENT_IP_HEADER) ?? (onRailway ? "x-real-ip" : null),
    keeperStatusPath: clean(env.KEEPER_STATUS_PATH),
    keeperStatusUrl: url(env.KEEPER_STATUS_URL),
    sampleData: flag(env.HW_SAMPLE_DATA),
    repoUrl: url(env.REPO_URL),
    xHandle: clean(env.X_HANDLE)?.replace(/^@/, "") ?? null,
    commit: clean(env.RAILWAY_GIT_COMMIT_SHA) ?? clean(env.GIT_COMMIT),
  };
}

/** The host of a URL, for saying where a number was read from without printing a key in a path. */
export function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "unknown host";
  }
}
