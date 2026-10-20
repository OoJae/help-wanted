/**
 * The site's data sources, wired once per process.
 *
 * One module per source, each behind an interface: `api.ts` (the IdentityMD public API, through the
 * shared package's client), `chain.ts` (Ethereum mainnet over JSON-RPC), `house.ts` (our own
 * contracts, read from the chain with the shared package's generated ABIs), `keeper.ts` (the keeper
 * bot's status file, when this server has been told where it is). A page never talks to an
 * upstream directly; it asks `getSources()`. Tests build their own `Sources` from fakes and pass
 * them to the page models.
 */
import { resolveDeployments, type Deployments } from "~/config/deployments";
import { hostOf, readEnv, type AppEnv } from "~/config/env";
import { REFERENCE_JOB } from "~/config/chain";
import { LAUNCH_C_JOB, ORDER_HISTORY } from "~/config/history";
import { SlidingWindowLimiter, TtlCache } from "~/lib/cache";
import { createEthReader } from "~/lib/jsonrpc";
import { HttpApiSource, type ApiSource, type PinnedRecord } from "./api";
import referenceRecord from "./seed/work-record-3db99325.json?raw";
import headerJobRecord from "./seed/work-record-990ae775.json?raw";
import { RpcChainSource, type ChainSource } from "./chain";
import { ChainHouseSource, type HouseSource } from "./house";
import { keeperSource, type KeeperSource } from "./keeper";
import { withSampleData } from "./sample";

export interface Sources {
  env: AppEnv;
  deployments: Deployments;
  api: ApiSource;
  chain: ChainSource;
  house: HouseSource;
  /** The keeper bot's status file, when this server has been told where it is. */
  keeper: KeeperSource;
  /**
   * How many checks of jobs this server has not looked at recently one visitor may start in a
   * minute. Each such check costs the shared upstream budgets a few requests; a job already looked
   * at costs nothing and is never refused.
   */
  freshChecks: SlidingWindowLimiter;
  /** When this process started, for `/api/v1/status`. */
  startedAt: number;
}

/** One visitor may start this many checks of not-yet-seen jobs (or fetches of not-yet-held records) a minute. */
export const FRESH_CHECKS_PER_MINUTE = 12;

export function freshCheckLimiter(now?: () => number): SlidingWindowLimiter {
  return new SlidingWindowLimiter({ max: FRESH_CHECKS_PER_MINUTE, windowMs: 60_000, now });
}

/**
 * The reference job, which "/judges" and "/verify" check on the server's own account. Its record
 * ships with the site (7,339 bytes, byte for byte as IdentityMD serves it) and is used only while
 * IdentityMD's record server cannot be reached, and only because it hashes to the receipt.
 */
export function referencePin(): PinnedRecord {
  return {
    jobId: REFERENCE_JOB.jobId,
    hash: REFERENCE_JOB.receipt,
    bytes: new TextEncoder().encode(referenceRecord),
  };
}

/**
 * The first real swarm job that carried a HELP WANTED order header: bought on 13 October 2026 to
 * find out whether IdentityMD stores a job's objective with the 85 header bytes unchanged. Its work
 * record (3,552 bytes) ships with the site for the same reason the reference record does. The page
 * that shows it reads its receipt from the chain every time and says so while there is none.
 */
export const HEADER_JOB = {
  jobId: "e70c56ce-60f0-4c2c-b413-67e5ae37ddce",
  jobIdBytes16: "0xe70c56ce60f04c2cb41367e5ae37ddce",
  /** keccak256 of its work record, as IdentityMD's API lists it. */
  recordHash: "0x990ae775288252e4b1b12c4a85bbe66db0140ca733e30002a6525814bfdaa17d",
  recordBytes: 3552,
  /** The 64 hex characters the header carried. They name no order: the job was bought before the desk was launched. */
  ticket: "0xde7eddaacedc4110cb3ca3388ecec4dae5bda3eae85c721452c078dc71592041",
} as const;

/**
 * The job that asks IdentityMD's launch pipeline to deploy launch A (Questions, JobsReport,
 * Payroll), paid for on 13 October 2026. The judges page reads its state from the API every time;
 * nothing about it is assumed.
 */
export const LAUNCH_A_JOB = { jobId: "d8bb3d81-820d-42f4-ad7c-1d3ed96b1da8" } as const;

/**
 * The job that asked IdentityMD's launch pipeline to deploy launch B (WorkProof, WorkOrders,
 * CrowdPots, Doorbell), paid for on 13 October 2026. It became IdentityMD launch 1573. The judges
 * page reads its state from the API every time, once the deployments book records that launch.
 */
export const LAUNCH_B_JOB = { jobId: "eb0f6c65-174a-45e8-9fe5-9312c66d4880" } as const;

/**
 * Every job this server reads in full on its own account: the three launch jobs, and the swarm job
 * of each order whose history `config/history.ts` keeps (its media CID is shown on the order page).
 */
export const OWN_JOBS: readonly string[] = [
  LAUNCH_A_JOB.jobId,
  LAUNCH_B_JOB.jobId,
  LAUNCH_C_JOB.jobId,
  ...ORDER_HISTORY.orders.map((order) => order.jobId),
];

export function headerJobPin(): PinnedRecord {
  return {
    jobId: HEADER_JOB.jobId,
    hash: HEADER_JOB.recordHash,
    bytes: new TextEncoder().encode(headerJobRecord),
  };
}

export function buildSources(
  env: AppEnv = readEnv(),
  deployments: Deployments = resolveDeployments(),
): Sources {
  const cache = new TtlCache();
  const api = new HttpApiSource({
    baseUrl: env.imdApiBase,
    maxPerMinute: env.apiMaxPerMinute,
    cache,
    pinned: [referencePin(), headerJobPin()],
    ownJobs: OWN_JOBS,
  });
  const chain = new RpcChainSource({
    reader: createEthReader(env.rpcUrl),
    // The RPC for the search back through the WorkRegistry's log (RPC_URL unless HISTORY_RPC_URL
    // is set), given longer to answer a day of it.
    historyReader: createEthReader(env.historyRpcUrl, { timeoutMs: 15_000 }),
    rpcHost: hostOf(env.rpcUrl),
    logWindowBlocks: env.logWindowBlocks,
    archiveReader: env.archiveRpcUrl ? createEthReader(env.archiveRpcUrl, { timeoutMs: 30_000 }) : null,
    tallyDays: env.tallyDays,
    cache,
    maxPerMinute: env.rpcMaxPerMinute,
    ownJobs: [REFERENCE_JOB.jobIdBytes16, HEADER_JOB.jobIdBytes16],
  });
  const realHouse = new ChainHouseSource(chain, deployments);
  return {
    env,
    deployments,
    api,
    chain,
    house: env.sampleData ? withSampleData(realHouse) : realHouse,
    keeper: keeperSource({ path: env.keeperStatusPath, url: env.keeperStatusUrl, cache }),
    freshChecks: freshCheckLimiter(),
    startedAt: Date.now(),
  };
}

const GLOBAL_KEY = Symbol.for("help-wanted.sources");

/** The process-wide sources. Kept on `globalThis` so a dev-server reload does not drop the caches. */
export function getSources(): Sources {
  const holder = globalThis as unknown as Record<symbol, Sources | undefined>;
  if (!holder[GLOBAL_KEY]) {
    const sources = buildSources();
    holder[GLOBAL_KEY] = sources;
    if (sources.env.siteOrigin === null) {
      console.warn(
        "[help-wanted] SITE_ORIGIN is not set: pages carry no canonical link and /sitemap.xml answers 404 until it is.",
      );
    }
    // Fetch the reference record once at start, so the first reader of "/judges" does not wait for it.
    void sources.api.workRecord(REFERENCE_JOB.receipt).catch(() => undefined);
  }
  return holder[GLOBAL_KEY];
}
