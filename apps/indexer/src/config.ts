/**
 * Everything that can be configured, read once from the environment.
 *
 * With no variable set at all the indexer runs: embedded database in `.data/pglite`, the free
 * public node, the last 7,000 blocks. See `.env.example` and the README for each knob.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, type Address } from "viem";
import { z } from "zod";
import { DEPLOYMENT_BOOK, type DeploymentBook } from "@help-wanted/shared";
import { DEFAULT_RPC_URL, IMD_API_BASE } from "./constants.js";
import {
  deploymentEnvKey,
  deploymentsFromBook,
  moduleNameOf,
  OWN_CONTRACTS,
  type Deployments,
  type OwnContract,
} from "./deployments.js";
import { isUuid } from "./ids.js";

/** Where a module begins on its first run: at a fixed block, or a number of blocks behind the head. */
export type StartBlock = { kind: "absolute"; block: number } | { kind: "behind"; blocks: number };

export interface SyncConfig {
  /** The default first block for every module. */
  startBlock: StartBlock;
  /** Per-module overrides, keyed by module name (`START_BLOCK_FEE_TRANSFERS` → `fee_transfers`). */
  startBlocks: Record<string, StartBlock>;
  /** The widest block range asked for in one `eth_getLogs`. Halved when a node refuses it. */
  chunkSize: number;
  /** How many blocks behind the head the indexer stays. */
  confirmations: number;
  /** How many already-synced blocks are read again each time, to notice a reorganisation. */
  reorgDepth: number;
  pollIntervalMs: number;
}

export interface MirrorConfig {
  enabled: boolean;
  baseUrl: string;
  /** Requests to the IdentityMD API per minute, all routes together. Never above 19. */
  callsPerMinute: number;
  /** Job UUIDs whose full document and records are mirrored. */
  watchJobs: string[];
  /** How many of the newest jobs and oracle requests to list per poll. */
  jobsLimit: number;
  oracleRequestsLimit: number;
}

export interface HttpConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface Config {
  databaseUrl: string | null;
  pgliteDir: string;
  rpcUrls: string[];
  sync: SyncConfig;
  deployments: Deployments;
  /** Contracts whose address came from the environment and not from the deployments book. */
  deploymentsFromEnv: OwnContract[];
  mirror: MirrorConfig;
  http: HttpConfig;
  /** Lowercase addresses the team controls. Their activity is labelled HOUSE in every count. */
  houseAddresses: string[];
}

/** The most this indexer will ever ask of `api.imd.fun` in a minute, whatever the configuration says. */
export const MAX_API_CALLS_PER_MINUTE = 19;

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_HOUSE_FILE = resolve(PACKAGE_ROOT, "../../evidence/house-wallets.json");

type Env = Record<string, string | undefined>;

function fail(name: string, why: string): never {
  throw new Error(`configuration: ${name} ${why}`);
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) fail(name, `must be a whole number, got "${raw}"`);
  const value = Number(raw);
  if (value < min || value > max) fail(name, `must be between ${min} and ${max}, got ${value}`);
  return value;
}

function flag(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fail(name, `must be true or false, got "${raw}"`);
}

/**
 * `26142962` is that block. `-7000` (or `latest-7000`) is 7,000 blocks behind the head at the
 * module's first run.
 */
export function parseStartBlock(raw: string, name = "START_BLOCK"): StartBlock {
  const text = raw.trim().toLowerCase();
  const behind = /^(?:latest)?-([0-9]+)$/.exec(text);
  if (behind) return { kind: "behind", blocks: Number(behind[1]) };
  if (text === "latest") return { kind: "behind", blocks: 0 };
  if (/^[0-9]+$/.test(text)) return { kind: "absolute", block: Number(text) };
  return fail(name, `must be a block number, or -N for N blocks behind the head, got "${raw}"`);
}

export function resolveStartBlock(start: StartBlock, head: number): number {
  return start.kind === "absolute" ? start.block : Math.max(0, head - start.blocks);
}

const HouseFile = z.object({
  wallets: z.array(z.object({ address: z.string() })).default([]),
  contracts: z.array(z.object({ address: z.string() })).default([]),
});

/**
 * Reads the published list of wallets and contracts the team controls. A missing file means
 * "nobody is house"; a file that is present but unreadable is an error, because silently counting
 * our own activity as outside adoption is the mistake this list exists to prevent.
 */
export function loadHouseAddresses(file: string | null): string[] {
  if (!file) return [];
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = HouseFile.parse(JSON.parse(text));
  const all = [...parsed.wallets, ...parsed.contracts].map((entry) =>
    getAddress(entry.address).toLowerCase(),
  );
  return [...new Set(all)].sort();
}

/**
 * @param book The deployments book our own contracts' addresses are taken from. The shared
 * package's real book unless a caller (a test, a rehearsal) passes another.
 */
export function loadConfig(env: Env = process.env, book: DeploymentBook = DEPLOYMENT_BOOK): Config {
  const rpcUrls = (env.RPC_URL ?? DEFAULT_RPC_URL)
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  if (rpcUrls.length === 0) fail("RPC_URL", "is empty");
  for (const url of rpcUrls) {
    if (!/^https?:\/\//.test(url)) fail("RPC_URL", "must hold http(s) URLs separated by commas");
  }

  const startBlocks: Record<string, StartBlock> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("START_BLOCK_") || value === undefined || value.trim() === "") continue;
    startBlocks[key.slice("START_BLOCK_".length).toLowerCase()] = parseStartBlock(value, key);
  }

  // Our own contracts. The deployments book comes first: a launch written there brings its
  // addresses and its block, and its modules start at that block. An explicit
  // START_BLOCK_<MODULE> still wins over the book's block: it is the more specific instruction.
  const fromBook = deploymentsFromBook(book);
  const deployments: Deployments = { ...fromBook.deployments };
  for (const contract of OWN_CONTRACTS) {
    const block = fromBook.startBlocks[contract];
    if (block !== undefined) startBlocks[moduleNameOf(contract)] ??= { kind: "absolute", block };
  }

  // `ADDR_WORK_ORDERS=0x…@26170000` replaces the book's entry for that contract: the address and
  // the block it was deployed in. The block is where the module starts. It is required, one way or
  // the other, because a module that began at the default look-back would skip the contract's
  // earlier events without a word, and every table folded from creation events would be short
  // from the start. The book's block is not borrowed for an address the book did not give.
  const deploymentsFromEnv: OwnContract[] = [];
  for (const contract of OWN_CONTRACTS) {
    const key = deploymentEnvKey(contract);
    const raw = env[key]?.trim();
    if (!raw) continue;
    const [addressText = "", blockText, ...more] = raw.split("@");
    try {
      deployments[contract] = getAddress(addressText.trim()) as Address;
    } catch {
      fail(key, `is not an address: "${addressText}"`);
    }
    deploymentsFromEnv.push(contract);
    const module = moduleNameOf(contract);
    const startKey = `START_BLOCK_${module.toUpperCase()}`;
    const explicit = env[startKey]?.trim();
    if (blockText !== undefined) {
      if (more.length > 0 || !/^[0-9]+$/.test(blockText.trim())) {
        fail(key, `must be <address>@<deployment block>, got "${raw}"`);
      }
      // An explicit START_BLOCK_<MODULE> still wins: it is the more specific instruction.
      startBlocks[module] = explicit
        ? parseStartBlock(explicit, startKey)
        : { kind: "absolute", block: Number(blockText.trim()) };
    } else if (!explicit) {
      fail(
        key,
        `needs the block the contract was deployed in, so its first events are not skipped: write ` +
          `${key}=<address>@<block>, or set ${startKey}`,
      );
    }
  }

  const watchJobs = (env.WATCH_JOBS ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id.length > 0);
  for (const id of watchJobs) {
    if (!isUuid(id)) fail("WATCH_JOBS", `must hold job UUIDs separated by commas, got "${id}"`);
  }

  const houseFile =
    env.HOUSE_WALLETS_FILE === undefined ? DEFAULT_HOUSE_FILE : env.HOUSE_WALLETS_FILE.trim() || null;

  return {
    databaseUrl: env.DATABASE_URL?.trim() || null,
    pgliteDir: resolve(PACKAGE_ROOT, env.PGLITE_DIR?.trim() || ".data/pglite"),
    rpcUrls,
    sync: {
      startBlock: parseStartBlock(env.START_BLOCK?.trim() || "-7000"),
      startBlocks,
      chunkSize: integer(env, "CHUNK_SIZE", 2000, 1, 1_000_000),
      confirmations: integer(env, "CONFIRMATIONS", 2, 0, 1000),
      reorgDepth: integer(env, "REORG_DEPTH", 64, 0, 10_000),
      pollIntervalMs: integer(env, "POLL_INTERVAL_MS", 12_000, 1000, 3_600_000),
    },
    deployments,
    deploymentsFromEnv,
    mirror: {
      enabled: flag(env, "API_MIRROR", true),
      baseUrl: (env.API_BASE?.trim() || IMD_API_BASE).replace(/\/+$/, ""),
      callsPerMinute: integer(env, "API_CALLS_PER_MINUTE", 12, 1, MAX_API_CALLS_PER_MINUTE),
      watchJobs: [...new Set(watchJobs)],
      jobsLimit: integer(env, "API_JOBS_LIMIT", 50, 1, 500),
      oracleRequestsLimit: integer(env, "API_ORACLE_REQUESTS_LIMIT", 100, 1, 500),
    },
    http: {
      enabled: flag(env, "HTTP", true),
      host: env.HOST?.trim() || "127.0.0.1",
      port: integer(env, "PORT", 8787, 0, 65_535),
    },
    // Our own contracts pay too (Questions buys its oracle requests from the Intake), so a
    // configured contract address is house whether or not the published list names it yet.
    houseAddresses: [
      ...new Set([
        ...loadHouseAddresses(houseFile),
        ...Object.values(deployments)
          .filter((address): address is Address => address !== null)
          .map((address) => address.toLowerCase()),
      ]),
    ].sort(),
  };
}
