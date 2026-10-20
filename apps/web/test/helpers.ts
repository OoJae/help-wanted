/**
 * Fakes for the two upstreams, built from recorded data, so that every test runs with no network:
 * a `fetch` that answers like api.imd.fun from the fixtures, and an `EthReader` that answers like a
 * mainnet RPC (WorkRegistry receipts and its log, both Intakes' counters, seat bindings, sIMD,
 * Transfer logs). Every ABI is the shared package's.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, encodeFunctionResult, type Abi, type Address, type Hex } from "viem";
import { resolveDeployments, type Deployments } from "~/config/deployments";
import { readEnv, type AppEnv } from "~/config/env";
import {
  DEPLOYMENT_BOOK,
  erc20Abi,
  erc4626Abi,
  erc721Abi,
  intakeAbi,
  isLaunched,
  MAINNET,
  sameAddress,
  seatAdapterAbi,
  workRegistryAbi,
  zapAbi,
  type DeploymentBook,
  type LaunchKey,
} from "@help-wanted/shared";
import { MULTICALL3, REFERENCE_JOB, TOPIC } from "~/config/chain";
import { LAUNCH_C_JOB } from "~/config/history";
import {
  freshCheckLimiter,
  HEADER_JOB,
  headerJobPin,
  LAUNCH_A_JOB,
  LAUNCH_B_JOB,
  OWN_JOBS,
  referencePin,
  type Sources,
} from "~/data";
import { HttpApiSource } from "~/data/api";
import { RpcChainSource } from "~/data/chain";
import { ChainHouseSource } from "~/data/house";
import { keeperSource, type KeeperSource } from "~/data/keeper";
import { withSampleData } from "~/data/sample";
import { TtlCache } from "~/lib/cache";
import { RpcError, type EthReader, type LogFilter, type RawLog } from "~/lib/jsonrpc";
import { answerMulticall } from "~/lib/multicall";

// ---------------------------------------------------------------------------------------------
// Deployment books
// ---------------------------------------------------------------------------------------------

/**
 * Stand-in addresses for a launch in a test book, in manifest order. They hold no contract, so a
 * page that reads one says it could not be read unless the test gives the fake chain an answer.
 */
export const TEST_ADDRESSES = {
  a: {
    questions: "0x00000000000000000000000000000000000000a1",
    jobsReport: "0x00000000000000000000000000000000000000a2",
    payroll: "0x00000000000000000000000000000000000000a3",
  },
  b: {
    workProof: "0x00000000000000000000000000000000000000b1",
    workOrders: "0x00000000000000000000000000000000000000b2",
    crowdPots: "0x00000000000000000000000000000000000000b3",
    doorbell: "0x00000000000000000000000000000000000000b4",
  },
  c: {
    rules: "0x00000000000000000000000000000000000000c1",
    endowments: "0x00000000000000000000000000000000000000c2",
    zap: "0x00000000000000000000000000000000000000c3",
  },
} as const satisfies { [K in LaunchKey]: Record<keyof DeploymentBook[K]["contracts"], Address> };

/**
 * The block and launch number a test book records for each launch it holds. The blocks are older
 * than the recorded day of logs (blocks 26,157,493 to 26,164,692), so every recorded log is one a
 * launched contract could have written.
 */
export const TEST_LAUNCH = {
  a: { block: 26_150_000, launchNumber: 9001, transaction: `0x${"a1".repeat(32)}` },
  b: { block: 26_151_000, launchNumber: 9002, transaction: `0x${"b2".repeat(32)}` },
  c: { block: 26_152_000, launchNumber: 9003, transaction: `0x${"c3".repeat(32)}` },
} as const satisfies Record<LaunchKey, { block: number; launchNumber: number; transaction: Hex }>;

const emptied = (contracts: object): Record<string, null> =>
  Object.fromEntries(Object.keys(contracts).map((name) => [name, null]));

/**
 * A deployments book in which exactly the named launches are written in. It is built on the shape
 * of the shared book (its projects, its contract names), so a contract added there appears here;
 * nothing about which launches the real book holds today is carried over.
 */
export function bookWith(launched: readonly LaunchKey[]): DeploymentBook {
  const record = <K extends LaunchKey>(key: K): DeploymentBook[K] =>
    (launched.includes(key)
      ? { project: DEPLOYMENT_BOOK[key].project, contracts: TEST_ADDRESSES[key], ...TEST_LAUNCH[key] }
      : {
          project: DEPLOYMENT_BOOK[key].project,
          contracts: emptied(DEPLOYMENT_BOOK[key].contracts),
          transaction: null,
          block: null,
          launchNumber: null,
        }) as DeploymentBook[K];
  return { chainId: DEPLOYMENT_BOOK.chainId, a: record("a"), b: record("b"), c: record("c") };
}

/**
 * The situations a page behaves differently in. A test names the one it is about and injects it;
 * no test reads the real book to decide what "today" is, so writing launch C into the real book
 * changes none of these.
 */
export const BOOKS = {
  /** Before any launch. */
  none: bookWith([]),
  /** Launch A only: Questions, JobsReport and Payroll exist, the hire desk and the company do not. */
  aOnly: bookWith(["a"]),
  /** Launches A and B: the hire desk, the pots and the Doorbell exist too; the company does not. */
  aAndB: bookWith(["a", "b"]),
  /** All three launches. */
  all: bookWith(["a", "b", "c"]),
} as const;

export type BookName = keyof typeof BOOKS;
export const BOOK_NAMES = Object.keys(BOOKS) as BookName[];

/** The launches a book holds, as the page spells them: `["A"]`. */
export function launchedIn(book: DeploymentBook): ("A" | "B" | "C")[] {
  return (["a", "b", "c"] as const)
    .filter((key) => isLaunched(key, book))
    .map((key) => key.toUpperCase() as "A" | "B" | "C");
}

/** The words this site does not use in its own text (the build brief, section 9). */
export const BANNED = /\b(exploit|attack|attacker|hack|steal|drain|rug|malicious|backdoor|phishing)/i;

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fixturePath(name)));
}

export function fixtureJson<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(fixturePath(name), "utf8")) as T;
}

export const RECORD = fixtureBytes("work-record-3db99325.json");
/** The work record of the job that carried our order header (3,552 bytes). */
export const HEADER_RECORD = fixtureBytes("work-record-990ae775.json");
export const TRANSFERS = fixtureJson<{ fromBlock: number; toBlock: number; logs: RawLog[] }>(
  "transfers-26157493-26164692.json",
);
export const SEAT_OWNER = "0xf98c3bf5f3544f64e60560304b58dca900a3c4db";
/** A finished job that has no receipt, as most jobs since the writer stalled. */
export const UNRECEIPTED_JOB = "10d225a6-92cb-4cde-9d4b-ec076b078f7d";
export const UNRECEIPTED_HASH = `0x${"ab".repeat(32)}` as Hex;
/** The counters of the two Intakes as read on 13 October 2026, the day the newer seed was taken. */
export const INTAKE_NONCE = { v2: 44n, v1: 13n } as const;

/** A `WorkRecorded` log of the registry in a block, for tests of the six-hour stall rule. */
export function workRecordedLog(block: number, index = 0): RawLog {
  return {
    address: MAINNET.WORK_REGISTRY.toLowerCase(),
    topics: [TOPIC.WORK_RECORDED, `0x${"e9".repeat(16)}${"00".repeat(16)}`, `0x${"3d".repeat(32)}`],
    data: "0x",
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: `0x${(block * 1000 + index).toString(16).padStart(64, "0")}`,
    logIndex: `0x${index.toString(16)}`,
  } as RawLog;
}

export interface FakeApi {
  fetch: typeof fetch;
  /** Every request the fake received, as `METHOD path`. */
  calls: string[];
}

/** Answers like api.imd.fun for the handful of routes the site reads. Anything else is a 404. */
export function fakeApi(overrides: Record<string, () => Response> = {}): FakeApi {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const routes: Record<string, () => Response> = {
    "/health": () => json(fixtureJson("health.json")),
    "/jobs": () => json(fixtureJson("jobs-limit3.json")),
    [`/jobs/${REFERENCE_JOB.jobId}/records`]: () => json(fixtureJson("job-records-e9efec16.json")),
    [`/jobs/${UNRECEIPTED_JOB}/records`]: () =>
      json({
        records: [
          {
            id: "7e7a00d2-5c4c-430e-9de2-396ac6d216d4",
            hash: UNRECEIPTED_HASH.slice(2),
            chainId: 1,
            registry: MAINNET.WORK_REGISTRY.toLowerCase(),
            status: "queued",
            txHash: null,
            failure: null,
          },
        ],
      }),
    [`/work-records/${REFERENCE_JOB.receipt.slice(2)}.json`]: () =>
      new Response(RECORD.slice(), {
        headers: { "content-type": "application/json", "content-length": String(RECORD.length) },
      }),
    // The job that carried our order header: finished, its record served, its receipt still queued.
    [`/jobs/${HEADER_JOB.jobId}`]: () => json(fixtureJson("job-e70c56ce.json")),
    [`/jobs/${HEADER_JOB.jobId}/records`]: () => json(fixtureJson("job-records-e70c56ce.json")),
    [`/work-records/${HEADER_JOB.recordHash.slice(2)}.json`]: () =>
      new Response(HEADER_RECORD.slice(), {
        headers: { "content-type": "application/json", "content-length": String(HEADER_RECORD.length) },
      }),
    // Launch A's job in IdentityMD's launch pipeline, as its API described it on 13 October 2026.
    [`/jobs/${LAUNCH_A_JOB.jobId}`]: () => json(fixtureJson("job-d8bb3d81.json")),
    // Launch B's job in the same pipeline, as the API described it on 13 October 2026, after the
    // launch: completed, nine steps accepted, the launch reported live.
    [`/jobs/${LAUNCH_B_JOB.jobId}`]: () => json(fixtureJson("job-eb0f6c65.json")),
    // Launch C's job, as the API described it on 15 October 2026, after the launch: completed,
    // nine steps accepted, launch 833dbd2c reported live.
    [`/jobs/${LAUNCH_C_JOB.jobId}`]: () => json(fixtureJson("job-7f2023fc.json")),
    ...overrides,
  };
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const route = routes[url.pathname];
    return route ? route() : json({ error: "not_found" }, 404);
  }) as typeof fetch;
  return { fetch: fake, calls };
}

export interface FakeChainOptions {
  head?: number;
  /** Receipts by job id as bytes16. Anything else reads zero. */
  receipts?: Record<string, Hex>;
  transferLogs?: RawLog[];
  /** Logs of either Intake; each is served for the contract its `address` names. */
  intakeLogs?: RawLog[];
  /** `nonce()` of the Intake, version 2. */
  intakeNonce?: bigint;
  /** `nonce()` of the legacy Intake, version 1. */
  intakeV1Nonce?: bigint;
  /** The registry's `WorkRecorded` logs. None by default: the writer is stalled, as it was that week. */
  registryLogs?: RawLog[];
  /** Logs of any other contract, by address. */
  logs?: Record<string, RawLog[]>;
  /** Addresses that have code. */
  contracts?: string[];
  /** IMD balances by holder, in wei. A holder not named holds nothing (sIMD always holds its assets). */
  imdBalances?: Record<string, bigint>;
  /**
   * Extra view answers: `address:functionName` to the value the view returns, or to a function of
   * the call's arguments that returns it (undefined makes the call revert).
   */
  views?: Record<string, { abi: Abi; result: unknown }>;
  failCalls?: boolean;
  /**
   * What `eth_estimateGas` answers for any call and what `eth_gasPrice` answers. Left out, the node
   * has neither method, as a reader that cannot estimate; a page then says the cost is unread.
   */
  gas?: { estimate: bigint; priceWei: bigint };
  /**
   * IMD-wei that one ETH buys through Zap, for the simulated `buy` a page quotes with. By default
   * the rate read on mainnet on 15 October 2026 (0.01 ETH bought 3.5475 IMD); null makes every
   * quote revert, as on an RPC that cannot simulate it.
   */
  zapImdPerEth?: bigint | null;
}

/** 0.01 ETH bought 3,547,506,876,144,594,614 IMD-wei through Zap on 15 October 2026. */
export const ZAP_IMD_PER_ETH = 354_750_687_614_459_461_400n;

export interface FakeChain {
  reader: EthReader;
  calls: string[];
}

const ZERO32 = `0x${"0".repeat(64)}` as Hex;

export function fakeChain(options: FakeChainOptions = {}): FakeChain {
  const head = options.head ?? TRANSFERS.toBlock;
  const receipts: Record<string, Hex> = {
    [REFERENCE_JOB.jobIdBytes16]: REFERENCE_JOB.receipt,
    ...options.receipts,
  };
  const transfers = options.transferLogs ?? TRANSFERS.logs;
  const calls: string[] = [];
  const times = new Map<number, number>();
  for (const log of transfers) {
    if (log.blockTimestamp) times.set(Number(BigInt(log.blockNumber)), Number(BigInt(log.blockTimestamp)));
  }
  // Mainnet blocks are 12 seconds apart; anchor on a block whose time the fixture records.
  const [anchorBlock, anchorTime] = [...times.entries()][0] ?? [head, 1_791_000_000];

  function answer(target: string, data: Hex): Hex | null {
    const to = target.toLowerCase();
    const is = (address: string) => to === address.toLowerCase();
    try {
      if (is(MAINNET.WORK_REGISTRY)) {
        const { args } = decodeFunctionData({ abi: workRegistryAbi, data });
        const id = (args[0] as string).toLowerCase();
        return encodeFunctionResult({
          abi: workRegistryAbi,
          functionName: "latest",
          result: receipts[id] ?? ZERO32,
        });
      }
      if (is(MAINNET.INTAKE) || is(MAINNET.INTAKE_V1)) {
        const { functionName } = decodeFunctionData({ abi: intakeAbi, data });
        if (functionName === "nonce") {
          const result = is(MAINNET.INTAKE)
            ? (options.intakeNonce ?? INTAKE_NONCE.v2)
            : (options.intakeV1Nonce ?? INTAKE_NONCE.v1);
          return encodeFunctionResult({ abi: intakeAbi, functionName, result });
        }
        if (functionName === "priceOf") {
          return encodeFunctionResult({ abi: intakeAbi, functionName, result: 500_000_000_000_000_000n });
        }
        if (functionName === "callbackGas")
          return encodeFunctionResult({ abi: intakeAbi, functionName, result: 200_000n });
      }
      if (is(MAINNET.SEAT_ADAPTER)) {
        const { args } = decodeFunctionData({ abi: seatAdapterAbi, data });
        // 52211 is the reference job's agent; 51519 is order 1's, bound to seat 1049 (15 Oct 2026).
        const seat = args[0] === 52211n ? 1998n : args[0] === 51519n ? 1049n : null;
        if (seat === null) return null; // UnknownAgent
        return encodeFunctionResult({
          abi: seatAdapterAbi,
          functionName: "bindingOf",
          result: { standard: 0, tokenContract: MAINNET.SEATS, tokenId: seat },
        });
      }
      if (is(MAINNET.SEATS)) {
        const { args } = decodeFunctionData({ abi: erc721Abi, data });
        if ((args[0] as bigint) >= 2000n) return null;
        return encodeFunctionResult({ abi: erc721Abi, functionName: "ownerOf", result: SEAT_OWNER });
      }
      if (is(MAINNET.SIMD)) {
        const { functionName } = decodeFunctionData({ abi: erc4626Abi, data });
        const result =
          functionName === "totalAssets"
            ? 1_824_178_363_500_000_000_000_000n
            : functionName === "totalSupply"
              ? 1_800_000n * 10n ** 24n
              : 1_013_432_424_166_666_666n;
        return encodeFunctionResult({ abi: erc4626Abi, functionName, result });
      }
      if (is(MAINNET.IMD)) {
        // sIMD holds what its `totalAssets` says; any other holder holds what the test gave it.
        const { args } = decodeFunctionData({ abi: erc20Abi, data });
        const holder = String(args?.[0] ?? "").toLowerCase();
        const given = Object.entries(options.imdBalances ?? {}).find(([key]) => key.toLowerCase() === holder);
        return encodeFunctionResult({
          abi: erc20Abi,
          functionName: "balanceOf",
          result: sameAddress(holder, MAINNET.SIMD) ? 1_824_178_363_500_000_000_000_000n : (given?.[1] ?? 0n),
        });
      }
      for (const [key, view] of Object.entries(options.views ?? {})) {
        const [address, name] = key.split(":");
        if (!address || !name || !is(address)) continue;
        try {
          // A call for a function this view's ABI does not have simply is not this view.
          const decoded = decodeFunctionData({ abi: view.abi, data });
          if (decoded.functionName === name) {
            const result =
              typeof view.result === "function"
                ? (view.result as (args: readonly unknown[]) => unknown)(decoded.args ?? [])
                : view.result;
            if (result === undefined) return null;
            return encodeFunctionResult({ abi: view.abi, functionName: name, result: result as never });
          }
        } catch {
          continue;
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  const gas = options.gas;
  const reader: EthReader = {
    ...(gas
      ? {
          async estimateGas(request: { to: string }) {
            calls.push(`eth_estimateGas ${request.to.toLowerCase()}`);
            if (options.failCalls) throw new Error("the RPC is down");
            return gas.estimate;
          },
          async gasPrice() {
            calls.push("eth_gasPrice");
            if (options.failCalls) throw new Error("the RPC is down");
            return gas.priceWei;
          },
        }
      : {}),
    async callWith(request) {
      calls.push(`eth_call ${request.to.toLowerCase()} with value`);
      if (options.failCalls) throw new Error("the RPC is down");
      const perEth = options.zapImdPerEth === undefined ? ZAP_IMD_PER_ETH : options.zapImdPerEth;
      let buy = false;
      try {
        buy = decodeFunctionData({ abi: zapAbi, data: request.data }).functionName === "buy";
      } catch {
        buy = false;
      }
      if (!buy || perEth === null) throw new RpcError("eth_call: execution reverted", 3);
      return encodeFunctionResult({
        abi: zapAbi,
        functionName: "buy",
        result: ((request.value ?? 0n) * perEth) / 10n ** 18n,
      });
    },
    async call(to, data) {
      calls.push(`eth_call ${to.toLowerCase()}`);
      if (options.failCalls) throw new Error("the RPC is down");
      if (to.toLowerCase() === MULTICALL3.toLowerCase()) return answerMulticall(data, answer);
      const out = answer(to, data);
      // As a node answers a reverted call: a JSON-RPC error with a code, which is an answer.
      if (out === null) throw new RpcError("eth_call: execution reverted", 3);
      return out;
    },
    async blockNumber() {
      calls.push("eth_blockNumber");
      if (options.failCalls) throw new Error("the RPC is down");
      return BigInt(head);
    },
    async getLogs(filter: LogFilter) {
      calls.push(`eth_getLogs ${filter.address.toLowerCase()} ${filter.fromBlock}-${filter.toBlock}`);
      if (options.failCalls) throw new Error("the RPC is down");
      const address = filter.address.toLowerCase();
      const extra = Object.entries(options.logs ?? {}).find(([key]) => key.toLowerCase() === address);
      const source = sameAddress(address, MAINNET.IMD)
        ? transfers
        : sameAddress(address, MAINNET.WORK_REGISTRY)
          ? (options.registryLogs ?? [])
          : sameAddress(address, MAINNET.INTAKE) || sameAddress(address, MAINNET.INTAKE_V1)
            ? (options.intakeLogs ?? []).filter((log) => sameAddress(log.address, address))
            : (extra?.[1] ?? []);
      // As a node filters: by block range, and by each topic position the filter names.
      const wanted = (filter.topics ?? []) as (string | string[] | null)[];
      return source.filter((log) => {
        const block = BigInt(log.blockNumber);
        if (block < filter.fromBlock || block > filter.toBlock) return false;
        return wanted.every((want, position) => {
          if (want === null || want === undefined) return true;
          const have = log.topics[position]?.toLowerCase();
          const any = (Array.isArray(want) ? want : [want]).map((topic) => topic.toLowerCase());
          return have !== undefined && any.includes(have);
        });
      });
    },
    async blockTimestamp(block) {
      calls.push(`eth_getBlockByNumber ${block}`);
      return times.get(Number(block)) ?? anchorTime + (Number(block) - anchorBlock) * 12;
    },
    async getCode(address) {
      calls.push(`eth_getCode ${address.toLowerCase()}`);
      return (options.contracts ?? []).some((c) => c.toLowerCase() === address.toLowerCase())
        ? "0x6080"
        : "0x";
    },
  };
  return { reader, calls };
}

export interface TestWorld {
  sources: Sources;
  api: FakeApi;
  chain: FakeChain;
}

export function testSources(
  options: {
    api?: FakeApi;
    chain?: FakeChainOptions;
    env?: Record<string, string | undefined>;
    /**
     * The deployments book this world is built on. Left out, it is `BOOKS.none`: a world in which
     * nothing is launched, whatever the real book holds. Pass `DEPLOYMENT_BOOK` for the real one.
     */
    book?: DeploymentBook;
    /** Deployments resolved by the test itself; wins over `book` and `env`. */
    deployments?: Deployments;
    now?: () => number;
    /**
     * True to give the API source the reference record that ships with the site, as the running
     * server has it. Off by default, so a test that takes IdentityMD's record server away sees
     * exactly what the check does without a copy to fall back on.
     */
    storedReferenceRecord?: boolean;
    /** How long the cache lets a reader wait for a slow refresh. Tests that hang a load set it low. */
    graceMs?: number;
    /** The keeper's status source. By default none is connected, as on a server told nothing. */
    keeper?: KeeperSource;
  } = {},
): TestWorld {
  const env: AppEnv = readEnv({ SITE_ORIGIN: "https://help-wanted.test", ...options.env });
  const deployments =
    options.deployments ?? resolveDeployments(options.env ?? {}, options.book ?? BOOKS.none);
  const api = options.api ?? fakeApi();
  const chain = fakeChain(options.chain);
  const cache = new TtlCache({ now: options.now, graceMs: options.graceMs });
  const pin = referencePin();
  const apiSource = new HttpApiSource({
    baseUrl: env.imdApiBase,
    maxPerMinute: env.apiMaxPerMinute,
    fetch: api.fetch,
    cache,
    now: options.now,
    pinned: options.storedReferenceRecord
      ? [pin, headerJobPin()]
      : [
          { ...pin, bytes: null },
          { ...headerJobPin(), bytes: null },
        ],
    ownJobs: OWN_JOBS,
  });
  const chainSource = new RpcChainSource({
    reader: chain.reader,
    rpcHost: "rpc.test",
    logWindowBlocks: env.logWindowBlocks,
    tallyDays: env.tallyDays,
    cache,
    now: options.now,
    maxPerMinute: env.rpcMaxPerMinute,
    ownJobs: [REFERENCE_JOB.jobIdBytes16, HEADER_JOB.jobIdBytes16],
  });
  const house = new ChainHouseSource(chainSource, deployments);
  return {
    sources: {
      env,
      deployments,
      api: apiSource,
      chain: chainSource,
      house: env.sampleData ? withSampleData(house) : house,
      keeper: options.keeper ?? keeperSource({ path: null, url: null }),
      freshChecks: freshCheckLimiter(options.now),
      startedAt: 0,
    },
    api,
    chain,
  };
}

/** A fixed moment a little after the recorded data was taken. */
export const NOW = new Date("2026-10-10T21:30:00Z");

/** A request's context. `visitor` is who is asking; leave it out for a read the server makes itself. */
export function ctxFor(world: TestWorld, path = "/", visitor: string | null = null) {
  return { sources: world.sources, now: NOW, url: new URL(`https://help-wanted.test${path}`), visitor };
}
