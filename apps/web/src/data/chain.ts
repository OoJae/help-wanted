/**
 * Ethereum mainnet as a data source: receipts in the WorkRegistry, payments to the swarm's fee
 * address, the Intake's request history, seats and their owners, and sIMD's share price.
 *
 * Reads go to a public RPC that answers `eth_call` freely but serves `eth_getLogs` only for about
 * the newest 7,200 blocks. So log-based history is kept in this process and grows while it runs,
 * and each read-out says exactly which blocks it covers. A second, archive-capable RPC can be
 * configured (`ARCHIVE_RPC_URL`) to fill in older blocks; without one nothing older is claimed.
 * Everything is cached, so page views do not become RPC calls one for one.
 */
import type { Hex } from "viem";
import {
  erc20Abi,
  erc4626Abi,
  erc721Abi,
  intakeAbi,
  MAINNET,
  sameAddress,
  seatAdapterAbi,
  workRegistryAbi,
} from "@help-wanted/shared";
import { PUBLIC_LOG_WINDOW_BLOCKS, REFERENCE_JOB, SECONDS_PER_BLOCK, TOPIC } from "~/config/chain";
import { Breaker, messageOf, SlidingWindowLimiter, TtlCache, type Cached } from "~/lib/cache";
import { isZeroHash, parseHash } from "~/lib/ids";
import {
  decodeIntakeLogs,
  INTAKE_ADDRESS,
  intakeVersionOf,
  type IntakeRequest,
  type IntakeVersion,
} from "~/lib/intake";
import { guardReader, type CallRequest, type EthReader, type LogFilter, type RawLog } from "~/lib/jsonrpc";
import { readMany, readOne, type ViewCall, type ViewResult } from "~/lib/multicall";
import { decodePayment, uniquePayments, type Payment, type TallyWindow } from "~/lib/tally";
import { decodeZapQuote, zapQuoteRequest } from "~/lib/zapQuote";
import intakeSeedLegacy from "./seed/intake-logs-mainnet.json";
import intakeSeedWindow from "./seed/intake-logs-mainnet-26172396-26182396.json";

export interface Head {
  block: number;
  /** Seconds; null when the node did not return the block. */
  timestamp: number | null;
}

export type ArchiveState = "not_configured" | "running" | "done" | "failed";

export interface PaymentHistory {
  payments: Payment[];
  /** Every block this process holds payments for. It grows while the process runs. */
  window: TallyWindow;
  /**
   * The newest day of `window` (at most 7,200 blocks): the range the public RPC named in the
   * printed commands still serves, so figures for it can be reproduced by anyone. Headline figures
   * are for this range. It does not depend on how long the process has been running.
   */
  recent: TallyWindow;
  /** How older blocks were (or were not) filled in from an archive RPC. */
  archive: ArchiveState;
  archiveNote: string | null;
  /** True when some payment times were estimated from block numbers. */
  approxTimes: boolean;
  fetchedAt: number;
  stale: boolean;
  error: string | null;
}

/** A range of blocks whose Intake logs ship with the site as a recorded copy. */
export interface RecordedRange {
  fromBlock: number;
  toBlock: number;
}

/** One Intake contract's own figures, and how much of its history this server can list. */
export interface IntakeBook {
  /** 2 is the Intake IdentityMD names for anything new; 1 is the legacy one. */
  version: IntakeVersion;
  address: `0x${string}`;
  /** `Intake.nonce()`: how many requests the contract has ever taken. Null when unread. */
  nonce: number | null;
  priceWei: bigint | null;
  callbackGas: number | null;
  /** How many of its requests are in `requests`. */
  listed: number;
  /** True when the list has as many of its requests as its counter says exist. Null when unread. */
  complete: boolean | null;
  /** The recorded ranges that cover this contract, oldest first. */
  recorded: RecordedRange[];
}

export interface IntakeHistory {
  /** Requests of both Intake contracts, oldest first. Each says which contract logged it. */
  requests: IntakeRequest[];
  /** Version 2, the one launch A is built on. */
  current: IntakeBook;
  /** Version 1: legacy, and where the earlier history is. */
  legacy: IntakeBook;
  /** The newest block this process has scanned for newer logs; null before the first scan. */
  scannedToBlock: number | null;
  fetchedAt: number;
  stale: boolean;
  error: string | null;
}

/**
 * Whether IdentityMD's registry is writing receipts, from the registry's own log: its newest
 * `WorkRecorded` events in the last six hours of blocks and, when there are none, its newest
 * receipt before them, searched for as far back as the RPCs this server is given serve the log.
 */
export interface ReceiptWriterRead {
  /**
   * True when the newest six hours of blocks hold no `WorkRecorded` event at all: the newest
   * receipt is more than six hours old. False when they hold one. Null when the log could not be
   * read.
   */
  stalled: boolean | null;
  /** How many blocks the six-hour test looks at: 1,800. */
  windowBlocks: number;
  /** The six-hour test's range. */
  fromBlock: number | null;
  toBlock: number | null;
  /** How many `WorkRecorded` events were in the six-hour range. */
  events: number | null;
  /** The block of the newest `WorkRecorded` event found, in the six hours or before them. */
  newestBlock: number | null;
  /** That block's time, in Unix seconds. Null when there is no such block or its time was not read. */
  newestAt: number | null;
  /**
   * The oldest block of the range an RPC this server trusts for it answered, up to `toBlock`. When
   * `newestBlock` is null, the registry wrote nothing in all of `searchedFrom` to `toBlock`; how far
   * back that reaches is what the RPCs this server is given serve, and nothing is said of the
   * blocks before it.
   */
  searchedFrom: number | null;
  fetchedAt: number;
  stale: boolean;
  error: string | null;
}

export interface AgentBinding {
  agentId: string;
  /** False when the Adapter knows no token for the agent. */
  bound: boolean;
  /** True when the token is an IdentityMD seat. */
  isSeat: boolean;
  tokenId: string | null;
  /** The seat's current owner, lowercase; null when unbound or unread. */
  owner: string | null;
}

export interface StakingFacts {
  /** IMD held by sIMD, which is what all sIMD shares together are worth. */
  totalAssetsWei: bigint;
  totalShares: bigint;
  /** IMD-wei one whole sIMD share (10^24 share units) converts to. */
  assetsPerShareWei: bigint;
}

export interface RpcUsage {
  usedThisMinute: number;
  maxPerMinute: number;
  /** True while the RPC is being left alone after failing to answer several times in a row. */
  pausedAfterFailures: boolean;
}

export interface ChainSource {
  readonly rpcHost: string;
  readonly reader: EthReader;
  head(): Promise<Cached<Head>>;
  /** `WorkRegistry.latest(jobId)`; the zero hash when there is no receipt. */
  receipt(jobIdBytes16: Hex): Promise<Hex>;
  /** The same, with the time the registry was actually read. */
  receiptRead(jobIdBytes16: Hex): Promise<Cached<Hex>>;
  /** True when a read of this job's receipt is recent enough to be answered without asking the RPC. */
  hasRecentReceipt(jobIdBytes16: Hex): boolean;
  /** The same for many jobs in one call. A job whose read failed maps to null. */
  receipts(jobIdsBytes16: readonly Hex[]): Promise<Map<string, Hex | null>>;
  payments(): Promise<PaymentHistory>;
  intake(): Promise<IntakeHistory>;
  /** Whether the WorkRegistry has recorded any receipt in the last six hours of blocks. Never throws. */
  receiptWriter(): Promise<ReceiptWriterRead>;
  /** The owner of a seat, lowercase; null for an id that is not a seat. */
  seatOwner(tokenId: number): Promise<Cached<string | null>>;
  bindings(agentIds: readonly string[]): Promise<AgentBinding[]>;
  /**
   * Agents this process has seen bound to a seat. The Adapter answers agent to seat only, so a
   * seat's agent is known here only after that agent turned up in a lookup.
   */
  agentsSeenForSeat(tokenId: number): string[];
  staking(): Promise<Cached<StakingFacts>>;
  /** IMD balance of an address. */
  imdBalance(address: string): Promise<Cached<bigint>>;
  /** True when the address has code. */
  isContract(address: string): Promise<boolean>;
  /** Cached view calls against any contract, for the pages about our own deployments. */
  views(cacheKey: string, calls: readonly ViewCall[], ttlMs?: number): Promise<Cached<ViewResult[]>>;
  /**
   * What `ethWei` buys through Zap now, in IMD-wei: a simulated `buy` from an address given ETH for
   * the call (lib/zapQuote.ts). Rejects when the RPC cannot simulate it.
   */
  zapQuote(zap: string, ethWei: bigint): Promise<Cached<bigint>>;
  /**
   * What one call would cost in gas if it were sent now: `eth_estimateGas` for it, times
   * `eth_gasPrice`. An estimate, not a quote: the price moves block by block and a wallet sets its
   * own. Cached; rejects when the RPC cannot answer either.
   */
  gasCost(cacheKey: string, request: CallRequest, ttlMs?: number): Promise<Cached<GasCost>>;
  /** The timestamp of a block in seconds, kept once read; null when it could not be read. */
  blockTime(block: number): Promise<number | null>;
  /**
   * Cached logs of one contract over the newest blocks the RPC serves (or from `fromBlock`, when
   * that is newer). A page view never becomes a log query of its own.
   */
  recentLogs(
    cacheKey: string,
    filter: Pick<LogFilter, "address" | "topics"> & { fromBlock?: number | null },
    ttlMs?: number,
  ): Promise<Cached<{ logs: RawLog[]; fromBlock: number; toBlock: number }>>;
  /** How many blocks back this source's RPC serves logs. */
  readonly logWindowBlocks: number;
  usage(): RpcUsage;
}

/** The gas one call would use now, the network's gas price, and their product in wei. */
export interface GasCost {
  gas: bigint;
  gasPriceWei: bigint;
  costWei: bigint;
}

export interface RpcChainOptions {
  reader: EthReader;
  rpcHost: string;
  /** How many blocks back `reader` serves logs. */
  logWindowBlocks: number;
  archiveReader?: EthReader | null;
  /**
   * The same endpoint as `reader`, with a longer timeout, for the search back through the
   * registry's log for its newest receipt: a day of logs can take a node longer than a page
   * should wait. Its failures pause only that search. Defaults to `reader`.
   */
  historyReader?: EthReader | null;
  /** How many days of payments to ask the archive reader for. */
  tallyDays: number;
  cache?: TtlCache;
  now?: () => number;
  /** The most requests a minute this process sends to `reader`, whatever the traffic. Default 240. */
  maxPerMinute?: number;
  /** Jobs (as bytes16) this server checks on its own account; their reads do not use the visitors' share. */
  ownJobs?: readonly Hex[];
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const BLOCKS_PER_DAY = 7200;
/** Logs this close to the head are read again on every refresh, in case the chain reorganised. */
const REORG_DEPTH = 12;
const ARCHIVE_CHUNK = 5000;
const PAYEE_TOPIC = `0x${"0".repeat(24)}${MAINNET.FEE_PAYEE.slice(2).toLowerCase()}`;
/**
 * The length of the range headline figures are printed for: one day of blocks, which is also what
 * the public RPC named in the printed commands serves logs for.
 */
const REPORT_BLOCKS = PUBLIC_LOG_WINDOW_BLOCKS;

/** Six hours of blocks: the test for "IdentityMD's receipts are stalled" that the launch documents use. */
export const RECEIPT_STALL_BLOCKS = (6 * 3600) / SECONDS_PER_BLOCK;
/** How far back the newest receipt is looked for once six hours hold none: fourteen days of blocks. */
export const RECEIPT_SEARCH_BLOCKS = 14 * BLOCKS_PER_DAY;
/** One log query of the backward search: a day of blocks. */
const RECEIPT_SEARCH_CHUNK = 7200;
/** How many days past its log window the main RPC is asked, when nothing shows it keeps them. */
const RECEIPT_HOPEFUL_CHUNKS = 3;

interface IntakeSeed {
  fromBlock: number;
  toBlock: number;
  /** The Intake contracts whose logs the file holds for that range. */
  versions: IntakeVersion[];
  logs: RawLog[];
}

/**
 * The recorded history that ships with the site. The first file holds the legacy Intake up to 10
 * October 2026, from an archive node. The second holds both Intakes for the range the public RPC
 * still served on 13 October. The blocks between the two are in neither.
 */
const INTAKE_SEEDS: readonly IntakeSeed[] = [
  {
    fromBlock: intakeSeedLegacy.fromBlock,
    toBlock: intakeSeedLegacy.toBlock,
    versions: [1],
    logs: intakeSeedLegacy.logs as RawLog[],
  },
  {
    fromBlock: intakeSeedWindow.fromBlock,
    toBlock: intakeSeedWindow.toBlock,
    versions: [1, 2],
    logs: intakeSeedWindow.logs as RawLog[],
  },
];
const INTAKE_RECORDED_TO = Math.max(...INTAKE_SEEDS.map((seed) => seed.toBlock));
/**
 * Where an archive RPC, when one is configured, starts looking for Intake logs the seeds do not
 * hold: the block after the first recorded file ends. IdentityMD's API named no version 2 before
 * that day, and the legacy Intake is recorded in full up to it.
 */
const INTAKE_GAP_FROM = intakeSeedLegacy.toBlock + 1;

function recordedRanges(version: IntakeVersion): RecordedRange[] {
  return INTAKE_SEEDS.filter((seed) => seed.versions.includes(version)).map((seed) => ({
    fromBlock: seed.fromBlock,
    toBlock: seed.toBlock,
  }));
}

interface IntakeFacts {
  nonce: number | null;
  priceWei: bigint | null;
  callbackGas: number | null;
}
const NO_INTAKE_FACTS: IntakeFacts = { nonce: null, priceWei: null, callbackGas: null };

/** How long a read receipt is served without asking again, and for how long after that it is served while one refresh runs. */
const RECEIPT_TTL = 45 * SECOND;
/** On the Work Wire's cards a written receipt is reused a little longer; the full check is on /verify. */
const CARD_RECEIPT_TTL = 2 * MINUTE;

export class RpcChainSource implements ChainSource {
  readonly rpcHost: string;
  /** Every request through this reader counts against the per-minute ceiling and the breaker. */
  readonly reader: EthReader;
  /** The same endpoint for reads a visitor can cause one by one; they also count against a smaller share. */
  readonly #visitorReader: EthReader;
  readonly #all: SlidingWindowLimiter;
  readonly #breaker: Breaker;
  readonly #maxPerMinute: number;
  readonly #ownJobs: ReadonlySet<string>;
  readonly #archive: EthReader | null;
  /** The search back through the registry's log: counted with every other read, paused on its own. */
  readonly #history: EthReader;
  readonly logWindowBlocks: number;
  readonly #tallyDays: number;
  readonly #cache: TtlCache;
  readonly #now: () => number;

  // Payments to the fee address, as far back as this process has been able to read.
  readonly #payments = new Map<string, Payment>();
  #paymentsFrom: number | null = null;
  #paymentsTo: number | null = null;
  #archiveState: ArchiveState;
  #archiveNote: string | null = null;

  // Intake logs newer than the recorded history, of both Intake contracts.
  readonly #intakeLogs = new Map<string, RawLog>();
  #intakeScannedTo: number | null = null;
  /** True once an archive RPC has filled the blocks between the two recorded files. */
  #intakeGapFilled = false;

  readonly #blockTimes = new Map<number, number>();
  readonly #seatAgents = new Map<string, Set<string>>();

  // The registry's log as far as it has been searched: blocks `from` to `to`, and the newest
  // receipt in them (null for none).
  #writerCover: { from: number; to: number; newest: number | null } | null = null;
  /** Whether the main RPC was seen to serve the registry's log at the reference receipt's block. */
  #oldLogs: { value: boolean; at: number } | null = null;
  /** When the main RPC was last asked past its log window and returned no receipt. */
  #hopefulAt: number | null = null;

  constructor(options: RpcChainOptions) {
    this.#maxPerMinute = options.maxPerMinute ?? 240;
    this.#all = new SlidingWindowLimiter({ max: this.#maxPerMinute, windowMs: MINUTE, now: options.now });
    this.#breaker = new Breaker("The Ethereum RPC", { now: options.now });
    const name = "The Ethereum RPC";
    this.reader = guardReader(options.reader, {
      name,
      all: this.#all,
      visitor: null,
      breaker: this.#breaker,
    });
    this.#visitorReader = guardReader(options.reader, {
      name,
      all: this.#all,
      visitor: new SlidingWindowLimiter({
        max: Math.max(1, Math.floor(this.#maxPerMinute * 0.75)),
        windowMs: MINUTE,
        now: options.now,
      }),
      breaker: this.#breaker,
    });
    this.#history = guardReader(options.historyReader ?? options.reader, {
      name: "The Ethereum RPC's older logs",
      all: this.#all,
      visitor: null,
      breaker: new Breaker("The Ethereum RPC's older logs", { now: options.now }),
    });
    this.#ownJobs = new Set((options.ownJobs ?? []).map((id) => id.toLowerCase()));
    this.rpcHost = options.rpcHost;
    this.#archive = options.archiveReader ?? null;
    this.logWindowBlocks = options.logWindowBlocks;
    this.#tallyDays = options.tallyDays;
    this.#now = options.now ?? Date.now;
    this.#cache = options.cache ?? new TtlCache({ now: options.now });
    this.#archiveState = this.#archive ? "running" : "not_configured";
  }

  usage(): RpcUsage {
    return {
      usedThisMinute: this.#all.used(),
      maxPerMinute: this.#maxPerMinute,
      pausedAfterFailures: this.#breaker.open,
    };
  }

  head(): Promise<Cached<Head>> {
    return this.#cache.get("chain:head", { ttlMs: 20 * SECOND }, async () => {
      const block = Number(await this.reader.blockNumber());
      return { block, timestamp: await this.#timeOf(block) };
    });
  }

  async #timeOf(block: number): Promise<number | null> {
    const known = this.#blockTimes.get(block);
    if (known !== undefined) return known;
    try {
      const timestamp = await this.reader.blockTimestamp(BigInt(block));
      if (timestamp !== null) {
        if (this.#blockTimes.size > 5000) this.#blockTimes.clear();
        this.#blockTimes.set(block, timestamp);
      }
      return timestamp;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Receipts
  // -------------------------------------------------------------------------------------------

  #receiptFresh(key: string): Hex | undefined {
    const hit = this.#cache.peek<Hex>(key);
    if (!hit) return undefined;
    // A written receipt changes only if the job is continued; an absent one may land any minute.
    const ttl = isZeroHash(hit.value) ? RECEIPT_TTL : CARD_RECEIPT_TTL;
    return this.#now() - hit.fetchedAt < ttl ? hit.value : undefined;
  }

  hasRecentReceipt(jobIdBytes16: Hex): boolean {
    const hit = this.#cache.peek<Hex>(`chain:receipt:${jobIdBytes16.toLowerCase()}`);
    return hit !== null && this.#now() - hit.fetchedAt < 2 * RECEIPT_TTL;
  }

  receiptRead(jobIdBytes16: Hex): Promise<Cached<Hex>> {
    const id = jobIdBytes16.toLowerCase();
    // A job this server checks on its own account is not at the mercy of the visitors' share.
    const reader = this.#ownJobs.has(id) ? this.reader : this.#visitorReader;
    return this.#cache.get(`chain:receipt:${id}`, { ttlMs: RECEIPT_TTL }, async () => {
      const value = parseHash(
        (await readOne(reader, {
          to: MAINNET.WORK_REGISTRY,
          abi: workRegistryAbi,
          functionName: "latest",
          args: [jobIdBytes16],
        })) as string,
      );
      if (!value) throw new Error("the WorkRegistry did not return a 32-byte word");
      return value;
    });
  }

  async receipt(jobIdBytes16: Hex): Promise<Hex> {
    return (await this.receiptRead(jobIdBytes16)).value;
  }

  async receipts(jobIdsBytes16: readonly Hex[]): Promise<Map<string, Hex | null>> {
    const out = new Map<string, Hex | null>();
    const missing: Hex[] = [];
    for (const id of jobIdsBytes16) {
      const fresh = this.#receiptFresh(`chain:receipt:${id.toLowerCase()}`);
      if (fresh) out.set(id.toLowerCase(), fresh);
      else missing.push(id);
    }
    if (missing.length === 0) return out;
    try {
      const results = await readMany(
        this.reader,
        missing.map((id) => ({
          to: MAINNET.WORK_REGISTRY,
          abi: workRegistryAbi,
          functionName: "latest",
          args: [id],
        })),
      );
      missing.forEach((id, index) => {
        const result = results[index];
        const value = result?.ok ? parseHash(result.value as string) : null;
        if (value) this.#cache.set(`chain:receipt:${id.toLowerCase()}`, value);
        out.set(id.toLowerCase(), value);
      });
    } catch {
      for (const id of missing) out.set(id.toLowerCase(), null);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Payments to the fee address
  // -------------------------------------------------------------------------------------------

  async #transferLogs(reader: EthReader, fromBlock: number, toBlock: number): Promise<RawLog[]> {
    return reader.getLogs({
      address: MAINNET.IMD,
      topics: [TOPIC.TRANSFER, null, PAYEE_TOPIC],
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(toBlock),
    });
  }

  #storePayments(logs: readonly RawLog[]): void {
    for (const log of logs) {
      // Only a log that is itself an IMD transfer to the fee address counts: the node is asked for
      // those and nothing else, but what it returns is checked rather than taken on trust.
      const payment = decodePayment(log);
      if (payment) this.#payments.set(`${payment.txHash}:${payment.logIndex}`, payment);
    }
  }

  async #refreshPayments(): Promise<void> {
    const head = Number(await this.reader.blockNumber());
    const windowStart = Math.max(0, head - this.logWindowBlocks + 1);

    if (this.#paymentsTo === null || this.#paymentsFrom === null || this.#paymentsTo < windowStart) {
      // First read, or this process fell further behind than the RPC serves logs: start over from
      // what can be read now rather than present a history with a hole in it.
      const logs = await this.#transferLogs(this.reader, windowStart, head);
      this.#payments.clear();
      this.#storePayments(logs);
      this.#paymentsFrom = windowStart;
      this.#paymentsTo = head;
      if (this.#archive) {
        this.#archiveState = "running";
        void this.#backfillPayments(windowStart - 1);
      }
      return;
    }

    const from = Math.max(this.#paymentsFrom, this.#paymentsTo - REORG_DEPTH + 1);
    const logs = await this.#transferLogs(this.reader, from, head);
    for (const [key, payment] of this.#payments) {
      if (payment.block >= from) this.#payments.delete(key);
    }
    this.#storePayments(logs);
    this.#paymentsTo = head;

    // Keep a bounded history.
    const keepFrom = head - Math.max(this.#tallyDays, 1) * BLOCKS_PER_DAY * 2;
    if (this.#paymentsFrom < keepFrom) {
      for (const [key, payment] of this.#payments) {
        if (payment.block < keepFrom) this.#payments.delete(key);
      }
      this.#paymentsFrom = keepFrom;
    }
  }

  /** Reads older blocks from the archive RPC, newest chunk first, extending the covered range. */
  async #backfillPayments(newestMissing: number): Promise<void> {
    const archive = this.#archive;
    if (!archive || this.#paymentsFrom === null) return;
    const oldestWanted = Math.max(0, newestMissing - this.#tallyDays * BLOCKS_PER_DAY + 1);
    try {
      for (let to = newestMissing; to >= oldestWanted; to -= ARCHIVE_CHUNK) {
        const from = Math.max(oldestWanted, to - ARCHIVE_CHUNK + 1);
        this.#storePayments(await this.#transferLogs(archive, from, to));
        this.#paymentsFrom = from;
      }
      this.#archiveState = "done";
      this.#archiveNote = null;
    } catch (error) {
      this.#archiveState = "failed";
      this.#archiveNote = `The archive RPC stopped answering: ${messageOf(error)}`;
    }
  }

  async payments(): Promise<PaymentHistory> {
    const cached = await this.#cache.get("chain:payments", { ttlMs: 45 * SECOND }, async () => {
      await this.#refreshPayments();
      return this.#now();
    });
    const fromBlock = this.#paymentsFrom ?? 0;
    const toBlock = this.#paymentsTo ?? 0;
    const recentFrom = Math.max(fromBlock, toBlock - REPORT_BLOCKS + 1);
    const [fromTime, toTime, recentFromTime] = await Promise.all([
      this.#timeOf(fromBlock),
      this.#timeOf(toBlock),
      this.#timeOf(recentFrom),
    ]);

    // Nodes that do not put a timestamp on a log get one estimated from the two ends of the window.
    let approxTimes = false;
    const payments = uniquePayments(this.#payments.values()).map((payment) => {
      if (payment.timestamp !== null || fromTime === null || toTime === null || toBlock === fromBlock) {
        return payment;
      }
      approxTimes = true;
      const share = (payment.block - fromBlock) / (toBlock - fromBlock);
      return { ...payment, timestamp: Math.round(fromTime + share * (toTime - fromTime)) };
    });

    return {
      payments,
      window: { fromBlock, toBlock, fromTime, toTime },
      recent: { fromBlock: recentFrom, toBlock, fromTime: recentFromTime, toTime },
      archive: this.#archiveState,
      archiveNote: this.#archiveNote,
      approxTimes,
      fetchedAt: cached.fetchedAt,
      stale: cached.stale,
      error: cached.error,
    };
  }

  // -------------------------------------------------------------------------------------------
  // The Intake's request history
  // -------------------------------------------------------------------------------------------

  async #refreshIntake(): Promise<Record<IntakeVersion, IntakeFacts>> {
    const head = Number(await this.reader.blockNumber());
    const windowStart = Math.max(0, head - this.logWindowBlocks + 1);
    const versions: IntakeVersion[] = [2, 1];
    const filter = (version: IntakeVersion, fromBlock: number, toBlock: number) => ({
      address: INTAKE_ADDRESS[version],
      topics: [[TOPIC.INTAKE_REQUESTED, TOPIC.INTAKE_COMPLETED]],
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(toBlock),
    });

    // Blocks no recorded file holds and the public RPC no longer serves need the archive RPC: the
    // gap between the two files, once, and anything between the newest file and the log window.
    if (this.#archive && !this.#intakeGapFilled) {
      const gapTo = intakeSeedWindow.fromBlock - 1;
      for (const version of versions) {
        for (let from = INTAKE_GAP_FROM; from <= gapTo; from += ARCHIVE_CHUNK * 4) {
          const to = Math.min(gapTo, from + ARCHIVE_CHUNK * 4 - 1);
          for (const log of await this.#archive.getLogs(filter(version, from, to))) this.#keepIntakeLog(log);
        }
      }
      this.#intakeGapFilled = true;
    }
    const resumeFrom = (this.#intakeScannedTo ?? INTAKE_RECORDED_TO) - REORG_DEPTH + 1;
    let from = Math.max(resumeFrom, INTAKE_RECORDED_TO + 1);
    if (from < windowStart && this.#archive) {
      for (const version of versions) {
        for (let chunkFrom = from; chunkFrom < windowStart; chunkFrom += ARCHIVE_CHUNK * 4) {
          const chunkTo = Math.min(windowStart - 1, chunkFrom + ARCHIVE_CHUNK * 4 - 1);
          for (const log of await this.#archive.getLogs(filter(version, chunkFrom, chunkTo))) {
            this.#keepIntakeLog(log);
          }
        }
      }
    }
    from = Math.max(from, windowStart);
    if (from <= head) {
      for (const version of versions) {
        for (const log of await this.reader.getLogs(filter(version, from, head))) this.#keepIntakeLog(log);
      }
    }
    this.#intakeScannedTo = head;

    const calls = versions.flatMap((version): ViewCall[] => [
      { to: INTAKE_ADDRESS[version], abi: intakeAbi, functionName: "nonce" },
      {
        to: INTAKE_ADDRESS[version],
        abi: intakeAbi,
        functionName: "priceOf",
        args: [MAINNET.ORACLE_ACTION, MAINNET.IMD],
      },
      { to: INTAKE_ADDRESS[version], abi: intakeAbi, functionName: "callbackGas" },
    ]);
    const read = await readMany(this.reader, calls).catch(() => [] as ViewResult[]);
    const facts = (index: number): IntakeFacts => {
      const [nonce, price, gas] = read.slice(index * 3, index * 3 + 3);
      return {
        nonce: nonce?.ok ? Number(nonce.value as bigint) : null,
        priceWei: price?.ok ? (price.value as bigint) : null,
        callbackGas: gas?.ok ? Number(gas.value as bigint) : null,
      };
    };
    return { 2: facts(0), 1: facts(1) };
  }

  #keepIntakeLog(log: RawLog): void {
    if (log.removed || intakeVersionOf(log.address) === null) return;
    this.#intakeLogs.set(`${log.transactionHash}:${log.logIndex}`, log);
  }

  async intake(): Promise<IntakeHistory> {
    let facts: Record<IntakeVersion, IntakeFacts> = { 1: NO_INTAKE_FACTS, 2: NO_INTAKE_FACTS };
    let fetchedAt = this.#now();
    let stale = false;
    let error: string | null = null;
    try {
      const cached = await this.#cache.get("chain:intake", { ttlMs: 60 * SECOND }, () =>
        this.#refreshIntake(),
      );
      facts = cached.value;
      fetchedAt = cached.fetchedAt;
      stale = cached.stale;
      error = cached.error;
    } catch (failure) {
      // The recorded history is still true when the chain cannot be read; say that it is all we have.
      stale = true;
      error = messageOf(failure);
    }
    const seen = new Map<string, RawLog>();
    for (const seed of INTAKE_SEEDS) {
      for (const log of seed.logs) seen.set(`${log.transactionHash}:${log.logIndex}`, log);
    }
    for (const [key, log] of this.#intakeLogs) seen.set(key, log);
    const requests = decodeIntakeLogs([...seen.values()]);
    const book = (version: IntakeVersion): IntakeBook => {
      const listed = requests.filter((request) => request.version === version).length;
      const nonce = facts[version].nonce;
      return {
        version,
        address: INTAKE_ADDRESS[version],
        ...facts[version],
        listed,
        complete: nonce === null ? null : listed === nonce,
        recorded: recordedRanges(version),
      };
    };
    return {
      requests,
      current: book(2),
      legacy: book(1),
      scannedToBlock: this.#intakeScannedTo,
      fetchedAt,
      stale,
      error,
    };
  }

  // -------------------------------------------------------------------------------------------
  // The registry's own log: is it writing receipts?
  // -------------------------------------------------------------------------------------------

  /** The registry's `WorkRecorded` logs in a range, as block numbers: only its own logs count. */
  async #registryBlocks(reader: EthReader, fromBlock: number, toBlock: number): Promise<number[]> {
    const logs = await reader.getLogs({
      address: MAINNET.WORK_REGISTRY,
      topics: [TOPIC.WORK_RECORDED],
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(toBlock),
    });
    // Whatever the node chose to return, only the registry's own WorkRecorded logs count.
    return logs
      .filter(
        (log) =>
          !log.removed &&
          sameAddress(log.address, MAINNET.WORK_REGISTRY) &&
          log.topics[0]?.toLowerCase() === TOPIC.WORK_RECORDED,
      )
      .map((log) => Number(BigInt(log.blockNumber)));
  }

  /**
   * Whether the main RPC serves the registry's log further back than it is said to: it must return
   * the reference job's own receipt, in the block it was written in. A node that refuses, or that
   * answers with nothing, is not trusted for older blocks. Asked once an hour at most.
   */
  async #servesOldRegistryLogs(): Promise<boolean> {
    const known = this.#oldLogs;
    if (known && (known.value || this.#now() - known.at < 60 * MINUTE)) return known.value;
    let value = false;
    try {
      const logs = await this.#history.getLogs({
        address: MAINNET.WORK_REGISTRY,
        topics: [TOPIC.WORK_RECORDED],
        fromBlock: BigInt(REFERENCE_JOB.receiptBlock),
        toBlock: BigInt(REFERENCE_JOB.receiptBlock),
      });
      value = logs.some(
        (log) =>
          !log.removed &&
          sameAddress(log.address, MAINNET.WORK_REGISTRY) &&
          log.transactionHash.toLowerCase() === REFERENCE_JOB.receiptTx.toLowerCase(),
      );
    } catch {
      value = false;
    }
    this.#oldLogs = { value, at: this.#now() };
    return value;
  }

  /**
   * The reader for blocks older than the main RPC's log window, and the oldest block it may be
   * asked about: the archive RPC when one is configured, or else the main RPC once it has shown it
   * keeps the registry's log that old. Either one's empty answer counts as "none there".
   *
   * Otherwise the main RPC is still asked a few days further back, but only a receipt it returns
   * counts: a node that keeps less history drops the oldest blocks first, so a receipt it returns
   * means it served every block after it, while an empty answer may only mean it no longer keeps
   * those blocks, and is never said to be "none". Such a search that found nothing is not repeated
   * for ten minutes. Null when nothing more is to be asked.
   */
  async #deepReader(
    head: number,
    windowStart: number,
  ): Promise<{ reader: EthReader; floor: number; trusted: boolean } | null> {
    const floor = Math.max(0, head - RECEIPT_SEARCH_BLOCKS + 1);
    if (this.#archive) return { reader: this.#archive, floor, trusted: true };
    if (await this.#servesOldRegistryLogs())
      return { reader: this.#history, floor: Math.max(floor, REFERENCE_JOB.receiptBlock), trusted: true };
    if (this.#hopefulAt !== null && this.#now() - this.#hopefulAt < 10 * MINUTE) return null;
    return {
      reader: this.#history,
      floor: Math.max(floor, windowStart - RECEIPT_HOPEFUL_CHUNKS * RECEIPT_SEARCH_CHUNK),
      trusted: false,
    };
  }

  async receiptWriter(): Promise<ReceiptWriterRead> {
    const empty = {
      windowBlocks: RECEIPT_STALL_BLOCKS,
      fromBlock: null,
      toBlock: null,
      events: null,
      newestBlock: null,
      newestAt: null,
      searchedFrom: null,
    };
    try {
      const cached = await this.#cache.get("chain:receipt-writer", { ttlMs: 60 * SECOND }, async () => {
        const head = Number(await this.reader.blockNumber());
        const fromBlock = Math.max(0, head - RECEIPT_STALL_BLOCKS + 1);
        // The six-hour test: one query.
        const blocks = await this.#registryBlocks(this.reader, fromBlock, head);
        const inWindow = blocks.length > 0 ? Math.max(...blocks) : null;
        // What an earlier read covered carries on, when it reaches up to this one's range and its
        // newest receipt is older than it: the newest receipt only ever moves forward.
        const before = this.#writerCover;
        const carried =
          before !== null &&
          before.to >= fromBlock - 1 &&
          before.from <= fromBlock &&
          (before.newest === null || before.newest < fromBlock);
        const cover = carried
          ? { from: before.from, to: head, newest: inWindow ?? before.newest }
          : { from: fromBlock, to: head, newest: inWindow };
        // None in six hours: look further back, newest blocks first, as far as this server's RPCs
        // serve the registry's log, and stop at the first receipt or the first refusal.
        if (cover.newest === null) {
          const windowStart = Math.max(0, head - this.logWindowBlocks + 1);
          // Asked for only when the search passes the main RPC's log window.
          let deeper: { reader: EthReader; floor: number; trusted: boolean } | null | undefined;
          let to = cover.from - 1;
          while (cover.newest === null && to >= 0) {
            let source: { reader: EthReader; floor: number; trusted: boolean } | null;
            if (to >= windowStart) {
              source = {
                reader: this.#history,
                floor: Math.max(windowStart, head - RECEIPT_SEARCH_BLOCKS + 1),
                trusted: true,
              };
            } else {
              if (deeper === undefined) deeper = await this.#deepReader(head, windowStart);
              source = deeper;
            }
            if (!source || to < source.floor) break;
            const from = Math.max(source.floor, to - RECEIPT_SEARCH_CHUNK + 1);
            let found: number[];
            try {
              found = await this.#registryBlocks(source.reader, from, to);
            } catch {
              break;
            }
            // Only blocks a trusted answer covered are said to hold no receipt.
            if (source.trusted) cover.from = from;
            if (found.length > 0) cover.newest = Math.max(...found);
            to = from - 1;
          }
          if (deeper && !deeper.trusted && cover.newest === null) this.#hopefulAt = this.#now();
        }
        this.#writerCover = cover;
        return {
          fromBlock,
          toBlock: head,
          events: blocks.length,
          newestBlock: cover.newest,
          newestAt: cover.newest === null ? null : await this.#timeOf(cover.newest),
          searchedFrom: cover.from,
        };
      });
      return {
        stalled: cached.value.events === 0,
        windowBlocks: RECEIPT_STALL_BLOCKS,
        ...cached.value,
        fetchedAt: cached.fetchedAt,
        stale: cached.stale,
        error: cached.error,
      };
    } catch (failure) {
      return {
        stalled: null,
        ...empty,
        fetchedAt: this.#now(),
        stale: true,
        error: messageOf(failure),
      };
    }
  }

  // -------------------------------------------------------------------------------------------
  // Seats, agents, staking
  // -------------------------------------------------------------------------------------------

  seatOwner(tokenId: number): Promise<Cached<string | null>> {
    if (!Number.isInteger(tokenId) || tokenId < 0 || tokenId >= MAINNET.SEAT_COUNT) {
      return Promise.resolve({ value: null, fetchedAt: this.#now(), stale: false, error: null });
    }
    return this.#cache.get(`chain:seat:${tokenId}`, { ttlMs: 2 * MINUTE }, async () => {
      const owner = (await readOne(this.#visitorReader, {
        to: MAINNET.SEATS,
        abi: erc721Abi,
        functionName: "ownerOf",
        args: [BigInt(tokenId)],
      })) as string;
      return owner.toLowerCase();
    });
  }

  async bindings(agentIds: readonly string[]): Promise<AgentBinding[]> {
    const ids = agentIds.filter((id) => /^\d{1,30}$/.test(id)).slice(0, 16);
    if (ids.length === 0) return [];
    const cached = await this.#cache.get(
      `chain:bindings:${ids.join(",")}`,
      { ttlMs: 5 * MINUTE },
      async () => {
        const bound = await readMany(
          this.#visitorReader,
          ids.map((id) => ({
            to: MAINNET.SEAT_ADAPTER,
            abi: seatAdapterAbi,
            functionName: "bindingOf",
            args: [BigInt(id)],
          })),
        );
        const rows: AgentBinding[] = ids.map((agentId, index) => {
          const result = bound[index];
          if (!result?.ok) return { agentId, bound: false, isSeat: false, tokenId: null, owner: null };
          const binding = result.value as { tokenContract: string; tokenId: bigint };
          return {
            agentId,
            bound: true,
            isSeat: binding.tokenContract.toLowerCase() === MAINNET.SEATS.toLowerCase(),
            tokenId: binding.tokenId.toString(),
            owner: null,
          };
        });
        const seats = rows.filter((row) => row.isSeat && row.tokenId !== null);
        const owners = await readMany(
          this.#visitorReader,
          seats.map((row) => ({
            to: MAINNET.SEATS,
            abi: erc721Abi,
            functionName: "ownerOf",
            args: [BigInt(row.tokenId as string)],
          })),
        );
        seats.forEach((row, index) => {
          const owner = owners[index];
          if (owner?.ok) row.owner = (owner.value as string).toLowerCase();
        });
        return rows;
      },
    );
    for (const row of cached.value) {
      if (!row.isSeat || row.tokenId === null) continue;
      const seen = this.#seatAgents.get(row.tokenId) ?? new Set<string>();
      seen.add(row.agentId);
      this.#seatAgents.set(row.tokenId, seen);
    }
    return cached.value;
  }

  agentsSeenForSeat(tokenId: number): string[] {
    return [...(this.#seatAgents.get(String(tokenId)) ?? [])];
  }

  staking(): Promise<Cached<StakingFacts>> {
    return this.#cache.get("chain:staking", { ttlMs: 60 * SECOND }, async () => {
      const [assets, shares, perShare] = await readMany(this.reader, [
        { to: MAINNET.SIMD, abi: erc4626Abi, functionName: "totalAssets" },
        { to: MAINNET.SIMD, abi: erc4626Abi, functionName: "totalSupply" },
        { to: MAINNET.SIMD, abi: erc4626Abi, functionName: "convertToAssets", args: [10n ** 24n] },
      ]);
      if (!assets?.ok || !shares?.ok || !perShare?.ok) throw new Error("sIMD could not be read");
      return {
        totalAssetsWei: assets.value as bigint,
        totalShares: shares.value as bigint,
        assetsPerShareWei: perShare.value as bigint,
      };
    });
  }

  imdBalance(address: string): Promise<Cached<bigint>> {
    return this.#cache.get(`chain:imd:${address.toLowerCase()}`, { ttlMs: 60 * SECOND }, async () => {
      return (await readOne(this.reader, {
        to: MAINNET.IMD,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      })) as bigint;
    });
  }

  async isContract(address: string): Promise<boolean> {
    const cached = await this.#cache.get(
      `chain:code:${address.toLowerCase()}`,
      { ttlMs: 60 * MINUTE },
      async () => {
        const code = await this.#visitorReader.getCode(address);
        return code !== "0x" && code.length > 2;
      },
    );
    return cached.value;
  }

  views(cacheKey: string, calls: readonly ViewCall[], ttlMs = 30 * SECOND): Promise<Cached<ViewResult[]>> {
    return this.#cache.get(`chain:views:${cacheKey}`, { ttlMs }, () => readMany(this.#visitorReader, calls));
  }

  zapQuote(zap: string, ethWei: bigint): Promise<Cached<bigint>> {
    return this.#cache.get(
      `chain:zap-quote:${zap.toLowerCase()}:${ethWei}`,
      { ttlMs: 60 * SECOND },
      async () => {
        const callWith = this.#visitorReader.callWith;
        if (!callWith) throw new Error("this RPC reader cannot simulate a call that carries ETH");
        const request = zapQuoteRequest(zap, ethWei, Math.floor(this.#now() / 1000));
        return decodeZapQuote(
          await callWith(
            { to: request.to, data: request.data, from: request.from, value: request.value },
            request.overrides,
          ),
        );
      },
    );
  }

  gasCost(cacheKey: string, request: CallRequest, ttlMs = 60 * SECOND): Promise<Cached<GasCost>> {
    return this.#cache.get(`chain:gas:${cacheKey}`, { ttlMs }, async () => {
      const { estimateGas, gasPrice } = this.#visitorReader;
      if (!estimateGas || !gasPrice) throw new Error("this RPC reader cannot estimate gas");
      const [gas, gasPriceWei] = await Promise.all([estimateGas(request), gasPrice()]);
      return { gas, gasPriceWei, costWei: gas * gasPriceWei };
    });
  }

  blockTime(block: number): Promise<number | null> {
    return this.#timeOf(block);
  }

  recentLogs(
    cacheKey: string,
    filter: Pick<LogFilter, "address" | "topics"> & { fromBlock?: number | null },
    ttlMs = 60 * SECOND,
  ): Promise<Cached<{ logs: RawLog[]; fromBlock: number; toBlock: number }>> {
    return this.#cache.get(`chain:logs:${cacheKey}`, { ttlMs }, async () => {
      const head = Number(await this.#visitorReader.blockNumber());
      const windowStart = Math.max(0, head - this.logWindowBlocks + 1);
      const fromBlock = Math.max(windowStart, filter.fromBlock ?? 0);
      const logs = await this.#visitorReader.getLogs({
        address: filter.address,
        topics: filter.topics,
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(head),
      });
      // A node is asked for one contract's logs; what it returns is checked, not taken on trust.
      return {
        logs: logs.filter((log) => !log.removed && sameAddress(log.address, filter.address)),
        fromBlock,
        toBlock: head,
      };
    });
  }
}
