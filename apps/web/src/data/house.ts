/**
 * HELP WANTED's own contracts as a data source: Standing Questions and its feeds, the Jobs Report's
 * prints, the Payroll ledger, orders on the hire desk, crowd pots, the Doorbell, rules and
 * endowments.
 *
 * Every read first asks `deployments` for the contract's address and answers `{ live: false }` when
 * there is none. The pages turn that into a plain "not launched yet". When an address exists the
 * reads go straight to the chain, through the ABIs the shared package generates from the launch
 * projects' build output: nothing is decoded by a signature typed here. Reads are batched through
 * Multicall3 and cached by the chain source, and a view that does not answer only leaves its own
 * fields empty.
 *
 * The indexer, when it is connected, can replace this module behind the same `HouseSource`
 * interface and add what the chain alone cannot give cheaply (the job text of old orders, the
 * events of rounds older than the RPC's log window, contributor lists).
 */
import {
  decodeEventLog,
  encodeEventTopics,
  encodeFunctionData,
  hexToString,
  keccak256,
  toHex,
  type Abi,
  type Hex,
} from "viem";
import {
  abandonStepName,
  answerDelivery,
  bytes16ToUuid,
  crowdPotsAbi,
  doorbellAbi,
  endowmentsAbi,
  HOUSE_FEED_NAMES,
  HOUSE_FEEDS,
  houseFeedById,
  jobsReportAbi,
  MAINNET,
  payrollAbi,
  questionsAbi,
  requestBlockerName,
  roundStatusName,
  rulesAbi,
  workOrdersAbi,
  workProofAbi,
  zapAbi,
  type AbandonStepName,
  type HouseFeedName,
  type RequestBlockerName,
  type RoundStatusName,
} from "@help-wanted/shared";
import type { ContractKey, Deployments } from "~/config/deployments";
import { pinnedRings, pinnedRounds, type PinnedRings } from "~/config/history";
import { messageOf } from "~/lib/cache";
import {
  ENDOWMENT_KINDS,
  ORDER_STATES,
  POT_STAGES,
  RULE_STATUSES,
  type EndowmentKind,
  type OrderState,
  type PotStage,
  type RuleStatus,
} from "~/lib/contracts";
import type { RawLog } from "~/lib/jsonrpc";
import type { ViewCall, ViewResult } from "~/lib/multicall";
import type { ChainSource, GasCost } from "./chain";

export type Live<T> =
  | { live: false; contract: ContractKey }
  | {
      live: true;
      contract: ContractKey;
      address: string;
      data: T;
      fetchedAt: number;
      stale: boolean;
      error: string | null;
      /** True when the data is made up for design work (sample mode) and was read from no chain. */
      sample?: boolean;
    }
  | {
      live: true;
      contract: ContractKey;
      address: string;
      data: null;
      fetchedAt: number;
      stale: true;
      error: string;
    };

// ---------------------------------------------------------------------------------------------
// The hire desk
// ---------------------------------------------------------------------------------------------

export interface OrderClaim {
  runner: string;
  claimedAt: number;
  registeredAt: number;
  priceWei: bigint;
  /** The swarm job as a UUID, or null before one is registered. */
  jobId: string | null;
  challenger: string | null;
  assertedAt: number;
  recordHash: Hex | null;
}

export interface OrderTerms {
  kindHash: Hex;
  specHash: Hex;
  minPayWei: bigint;
  maxPayWei: bigint;
  rampSecs: number;
  /** When the price started to rise (seconds); zero for a conditional order not yet triggered. */
  rampFrom: number;
  deliverySecs: number;
  expiresAt: number;
  bondWei: bigint;
  flags: number;
  runnerOnly: string | null;
  arbiter: string | null;
  condTarget: string | null;
  condSelector: Hex | null;
  condCmp: number;
  condThreshold: bigint;
  condMet: boolean;
  /** True once a registry receipt has been matched for the order. */
  proven: boolean;
  claims: number;
}

export interface Order {
  id: number;
  state: OrderState;
  employer: string;
  /** IMD the desk still holds for the order. */
  escrowWei: bigint;
  /** IMD paid out for delivered work. */
  spentWei: bigint;
  /** IMD sent back to the employer. */
  returnedWei: bigint;
  /** From `orderOf`; null when that view did not answer. */
  terms: OrderTerms | null;
  claim: OrderClaim | null;
  /** The job text, when its `OrderOpened` log is still within reach of the RPC. Third-party text. */
  spec: string | null;
  /** True for an order made up for design work. Never true outside sample mode. */
  sample?: boolean;
}

export interface OrderBook {
  /** `orderCount()`: orders ever opened. */
  count: number;
  /** Newest first, at most the page size. */
  orders: Order[];
}

export interface Pot {
  id: number;
  stage: PotStage;
  /** What the pot still needs before it can hire. */
  remainingWei: bigint;
  targetWei: bigint | null;
  raisedWei: bigint | null;
  deadline: number | null;
  kindHash: Hex | null;
  /**
   * The job kind in text, as the pot's opener wrote it and as `kindOf(kindHash)` returns it. Null
   * when it could not be read. Third-party text, though bound by the contract to printable ASCII.
   */
  kind: string | null;
  specHash: Hex | null;
  opener: string | null;
  orderId: number | null;
  allowClaimed: boolean | null;
  minPayWei: bigint | null;
  bondWei: bigint | null;
  deliverySecs: number | null;
  hireSecs: number | null;
  /** Zero for a pot that belongs to no series. */
  seriesId: number | null;
  /**
   * The job text the pot will order, from its `SpecPinned` log, when that log is still within reach
   * of the RPC and hashes to `specHash`. Null otherwise (a list never reads it). Third-party text.
   */
  spec: string | null;
  sample?: boolean;
}

export interface PotBook {
  count: number;
  pots: Pot[];
}

export interface DoorbellState {
  ringsUntilHire: number;
  /** `funded()`: whether the next 25th ring would open an order. Null when unread, never "no". */
  funded: boolean | null;
  /** Whether the Doorbell's orders accept a bonded delivery claim (fixed when it was launched). Null when unread. */
  allowClaimed: boolean | null;
  rings: number | null;
  hires: number | null;
  /** Deliveries the desk has told the Doorbell about. */
  receipts: number | null;
  lastOrderId: number | null;
  /** `MIN_PAY()` and `MAX_PAY()`: the price range of every order it opens (fixed when it was launched). Null when unread. */
  minPayWei: bigint | null;
  maxPayWei: bigint | null;
  /** `BOND()` and `DELIVERY_SECS()` of its orders (fixed when it was launched). Null when unread. */
  bondWei: bigint | null;
  deliverySecs: number | null;
  /** The IMD the Doorbell holds, as the token says. Null when unread. */
  balanceWei: bigint | null;
  /**
   * Who rang, from the `Rang` logs this server could read. The contract counts rings and names no
   * ringer in any view, so this is the only way to tell our own rings from anybody else's. Null
   * when the logs could not be read.
   */
  ringers: DoorbellRingers | null;
}

export interface DoorbellRingers {
  /** How many `Rang` logs were read, and the blocks they were read over. */
  read: number;
  fromBlock: number;
  toBlock: number;
  /** Rings by sender (lowercase address), most first. */
  byRinger: { ringer: string; rings: number }[];
  /**
   * How many of `read` come from the rings this site keeps (config/history.ts), read from the chain
   * by hand because the public RPC no longer serves their logs. Zero when none do.
   */
  pinned: number;
  /** The day those kept rings were read. Null when none are kept. */
  pinnedOn: string | null;
  /**
   * The rings whose log this server read itself (not the kept ones), newest first, at most
   * `RECENT_RINGS`: who rang, which ring it was and the transaction.
   */
  recent: DoorbellRing[];
}

/** One ring, from its `Rang(ringer, count)` log. */
export interface DoorbellRing {
  /** Lowercase. */
  ringer: string;
  /** The ring count after this ring: the ring's number. */
  count: number;
  block: number;
  tx: string;
}

/** One of the four desk events a runner's own work writes. */
export type RunnerEventName = "Claimed" | "Registered" | "DeliveryClaimed" | "Delivered";

/** A desk event of one runner, from its log. */
export interface RunnerEvent {
  name: RunnerEventName;
  orderId: number;
  block: number;
  tx: string;
  /** The block's time in seconds; null when it could not be read. */
  at: number | null;
}

/**
 * A runner's newest action on the desk in the blocks this server reads logs for: `Claimed` and
 * `Delivered` name the runner; `Registered` and `DeliveryClaimed` can be sent only by the runner
 * that holds the order, so they are the holder's.
 */
export interface RunnerBeat {
  /** Lowercase. */
  runner: string;
  /** Null when none of its events is in the blocks read. */
  last: RunnerEvent | null;
  fromBlock: number;
  toBlock: number;
}

// ---------------------------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------------------------

export interface PayrollLedger {
  receivedWei: bigint;
  toStakersWei: bigint;
  toSeatsWei: bigint;
  /** Feed budget still booked for the feeds (it falls when budget is released to stakers). */
  toFeedsWei: bigint;
  drippedWei: bigint;
  seatClaimedWei: bigint;
  tipsInWei: bigint;
  tipsClaimedWei: bigint;
  feedsFundedWei: bigint;
  /** Tips that fell to the seat pool: no agent named, a split's remainder, or swept after their wait. */
  tipsToSeatsWei: bigint;
  /** Feed budget no meter needed in time, released to the stakers' stream. */
  feedsReleasedWei: bigint;
  /** `stream()`; null when the view did not answer. */
  stream: {
    outstandingWei: bigint;
    unvestedWei: bigint;
    endsAt: number;
    perDripWei: bigint;
    nextDripAt: number;
    /** What `drip()` would send in this block. Zero inside the ten-minute gap and while sIMD is not ready. */
    dueNowWei: bigint;
  } | null;
  /** `owed()`: what the contract still holds for each party; null when the view did not answer. */
  owed: { stakersWei: bigint; seatsWei: bigint; tipsWei: bigint; feedsWei: bigint; totalWei: bigint } | null;
  /** `feedBudget()`; null when the view did not answer. */
  feedBudget: { totalWei: bigint; oldWei: bigint; releasableNowWei: bigint; nextReleaseAt: number } | null;
  /**
   * `feedShortfalls()`: how far Payroll's own position on each house meter is below its runway, in
   * the order payrolls, hires, employers. It is what `fundFeeds` would offer with budget to spare,
   * not what it can place: that also depends on the budget on hand.
   */
  feedShortfallsWei: [bigint, bigint, bigint] | null;
  /** IMD that arrived by plain transfer and has not been split: what `book()` would book. */
  unbookedWei: bigint | null;
  /** The split as the contract states it: `SEAT_BPS`, `FEED_BPS`, `STREAM_DURATION`. Null when unread. */
  constants: { seatBps: number; feedBps: number; streamSecs: number } | null;
}

export interface SeatPay {
  tokenId: number;
  /** `Payroll.seatClaimable(tokenId)`. */
  claimableWei: bigint;
  /**
   * `Payroll.seatPaid(tokenId)`: what the seat has been paid from the seat pool so far. Tips paid
   * through `claimTip` are not in it. Null when unread.
   */
  paidWei: bigint | null;
}

// ---------------------------------------------------------------------------------------------
// Standing Questions and the Jobs Report
// ---------------------------------------------------------------------------------------------

/** How a round's keeper tip ended up. */
export type TipOutcome =
  /** The round was answered and the tip credited to `tipEarner`, the keeper that opened it. */
  | "earned"
  /** The round failed: the tip went back onto the meter. */
  | "returned"
  /** The round is still pending: the tip is set aside for the keeper that opened it. */
  | "pending"
  /** The round has ended, but its events are older than this server can read. */
  | "unread";

export interface FeedRound {
  round: number;
  status: RoundStatusName;
  /** The answer as one word. For a list-typed feed this is `uint256(keccak256(answer))`. */
  value: bigint;
  fromBlock: number;
  toBlock: number;
  /** When the answer was stored, or the round closed; zero while pending. */
  updatedAt: number;
  /** When the request was made (seconds). Null when `roundRequest` did not answer. */
  requestedAt: number | null;
  intakeRequestId: Hex | null;
  questionHash: Hex | null;
  /** The keeper that opened the round, from its `RoundOpened` log. Null when that log is out of reach. */
  keeper: string | null;
  tipWei: bigint | null;
  priceWei: bigint | null;
  openedTx: Hex | null;
  /** Who handed the answer in: the Intake (its callback) or the caller of `submit`. */
  deliveredBy: string | null;
  /** True when the Intake's own callback delivered the answer; false when `submit` did. */
  byCallback: boolean | null;
  /** How many panel members agreed, as the attestation states. */
  agreed: number | null;
  /** The oracle request the answer came from, as a UUID. */
  oracleRequestId: string | null;
  settledTx: Hex | null;
  tipOutcome: TipOutcome;
  /**
   * Who was credited the tip: always the keeper that opened the round, whoever delivered the
   * answer. Null unless `tipOutcome` is `earned`.
   */
  tipEarner: string | null;
  /** For a list-typed round: the list itself, when `reveal` has published it and the log is in reach. */
  revealed: string[] | null;
}

export interface FeedParamsRead {
  answerType: number;
  panelSize: number;
  quorum: number;
  minAgreed: number;
  validFor: number;
  cadenceBlocks: number;
  maxWindowBlocks: number;
  lagBlocks: number;
  contiguous: boolean;
  pinHash: boolean;
  maxPriceWei: bigint;
  tipWei: bigint;
  /** Zero when the feed has no WHEN gate. */
  gateCmp: number;
  gateTarget: string | null;
  gateThreshold: bigint;
}

export interface Feed {
  id: Hex;
  /** Which house feed this is, when it is one of the three Payroll and the Jobs Report are bound to. */
  house: HouseFeedName | null;
  rounds: number;
  /** The newest answered round; zeros when the feed has no answer yet. */
  latest: { value: bigint; fromBlock: number; toBlock: number; round: number; updatedAt: number };
  meterWei: bigint;
  meterShares: bigint;
  /** What the next request costs the meter now: the Intake's price plus the keeper tip. Zero while none can be bought. */
  costWei: bigint;
  /** True while a round is waiting for its answer. */
  pending: boolean;
  failStreak: number;
  lastRequestBlock: number;
  /** The first block the cadence (and any back-off) allows the next request at. */
  nextRequestBlock: number;
  /** Why `request` cannot be made right now; `None` when it can. */
  blocker: RequestBlockerName | null;
  /** Whether `submit` is open for the pending round. Null when unread. */
  canSubmit: boolean | null;
  /** What `abandon` would do now, and when the pending round can be closed. Null when unread. */
  abandon: { step: AbandonStepName; closableAt: number } | null;
  params: FeedParamsRead | null;
  /** The question's stored prefix and tail, as text. Our own text for a house feed; its creator's otherwise. */
  questionPrefix: string | null;
  tail: string | null;
  /** What Payroll's own meter shares would fetch, for a house feed. Null when unread or Payroll is not launched. */
  payrollPositionWei: bigint | null;
  /** The newest rounds, newest first. Empty for a feed that is not a house feed (only its latest answer is read). */
  roundList: FeedRound[];
}

export interface FeedBook {
  /** `feedCount()`: feeds ever created, by anyone. */
  count: number;
  feeds: Feed[];
  /** The block range the round events were read over; null when no log could be read. */
  eventsFrom: number | null;
  eventsTo: number | null;
  /** Said when the round events could not be read at all. */
  eventsError: string | null;
}

export interface KeeperTips {
  keeper: string;
  /** What `collectTips` would pay now. */
  earnedWei: bigint;
  /** Set aside for rounds the keeper opened that are still pending. */
  pendingWei: bigint;
}

export interface JobsReportPrint {
  /** The print's index, counting from zero. Null when it could not be worked out. */
  index: number | null;
  amountWei: bigint;
  /** The hires count attached to the print. Meaningful only when `hiresRound` is not zero. */
  count: number;
  fromBlock: number;
  toBlock: number;
  payrollsRound: number;
  /** Zero while no count is attached. */
  hiresRound: number;
}

export interface JobsReportSummary {
  prints: number;
  totalWei: bigint;
  counts: number;
  totalCount: bigint;
  bestAmountWei: bigint;
  bestIndex: number;
  streak: number;
  longestStreak: number;
  crowns: number;
  latestCrownedRound: number;
}

export interface JobsReportCrown {
  round: number;
  /** One to three addresses, largest payer first. */
  places: string[];
  fromBlock: number;
  toBlock: number;
  crownedAt: number;
}

export interface JobsReportRead {
  summary: JobsReportSummary | null;
  /** Newest first. */
  prints: JobsReportPrint[];
  /** The newest crowned round of the employers feed, when one exists. */
  crown: JobsReportCrown | null;
}

// ---------------------------------------------------------------------------------------------
// Launch C
// ---------------------------------------------------------------------------------------------

export interface EndowmentRead {
  id: number;
  kind: EndowmentKind;
  /** The feed id (meter), the pot id as 32 bytes (pot), or zero (recipient). */
  target: Hex;
  beneficiary: string | null;
  principalWei: bigint;
  /** Deposits still waiting to be staked. */
  bufferedWei: bigint;
  harvestedWei: bigint;
  /** What `harvest` would send now. Null when the view reverted (for a meter: Questions could not be read). */
  harvestableWei: bigint | null;
  /**
   * Who created it, from its `Created` log, lowercase. Null when that log is out of the RPC's reach
   * or could not be read: the contract keeps no creator in its state.
   */
  creator: string | null;
}

export interface EndowmentBook {
  count: number;
  /** Newest first. */
  endowments: EndowmentRead[];
  meterRunway: number | null;
  nextStakeBlock: number | null;
  pendingWei: bigint | null;
  /** True in a block where sIMD pays nothing out to the contract. */
  vaultHold: boolean | null;
}

export interface RuleRead {
  id: number;
  status: RuleStatus;
  creator: string;
  /** 1 HIRE, 2 PAY. */
  action: number;
  /** 1 VIEW, 2 FEED. */
  conditionKind: number;
  conditionTarget: string;
  cmp: number;
  threshold: bigint;
  feedId: Hex | null;
  escrowWei: bigint;
  tipWei: bigint;
  fires: number;
  maxFires: number;
  cooldownSecs: number;
  /** HIRE: the most one order costs. PAY: the amount. */
  spendWei: bigint;
  payRecipient: string | null;
  /** Whether `fire` would go through now. Null when unread. */
  canFire: boolean | null;
}

export interface RuleBook {
  count: number;
  /** Newest first. */
  rules: RuleRead[];
}

/** Whether the address configured for one of our contracts answers as that contract. */
export interface ContractIdentity {
  /** True when the address answered the identifying call with the expected value. */
  confirmed: boolean;
  /** The call that was made, e.g. `IMD()`. */
  asked: string;
  /** What was found, in plain words. */
  detail: string;
}

export interface HouseSource {
  orders(limit?: number): Promise<Live<OrderBook>>;
  order(id: number): Promise<Live<Order | null>>;
  pots(limit?: number): Promise<Live<PotBook>>;
  pot(id: number): Promise<Live<Pot | null>>;
  doorbell(): Promise<Live<DoorbellState>>;
  /** What the Doorbell's next ring would cost in gas now: `estimateGas` of ring() and the gas price. */
  ringCost(): Promise<Live<GasCost>>;
  /** A runner's newest action on the desk, from the desk's logs over the blocks this server reads. */
  runnerBeat(runner: string): Promise<Live<RunnerBeat>>;
  ledger(): Promise<Live<PayrollLedger>>;
  seatPay(tokenId: number): Promise<Live<SeatPay>>;
  tipOwed(agentId: string): Promise<Live<bigint>>;
  feeds(): Promise<Live<FeedBook>>;
  keeperTips(keeper: string): Promise<Live<KeeperTips>>;
  report(limit?: number): Promise<Live<JobsReportRead>>;
  endowments(limit?: number): Promise<Live<EndowmentBook>>;
  rules(limit?: number): Promise<Live<RuleBook>>;
  /**
   * Asks the configured address a question only the real contract answers correctly (which IMD it
   * was built for, or which registry). A wrong address pasted after a launch fails here, before
   * any visitor is offered a button that approves IMD to it.
   */
  identity(contract: ContractKey): Promise<Live<ContractIdentity>>;
}

const ZERO_ADDRESS = /^0x0{40}$/;
/** How many feeds beyond the three house feeds are read, and how many rounds of each house feed. */
const OTHER_FEEDS_READ = 9;
const ROUNDS_READ = 20;
/** How many of the rings read from logs are handed on with their ringer and transaction. */
export const RECENT_RINGS = 200;
/** The most ring logs this process keeps once the RPC no longer serves them. */
const RINGS_KEPT_MAX = 100_000;

function addr(value: unknown): string | null {
  return typeof value === "string" && !ZERO_ADDRESS.test(value) ? value.toLowerCase() : null;
}

function jobUuid(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{32}$/.test(value) || /^0x0+$/.test(value)) return null;
  return bytes16ToUuid(value as Hex);
}

function nonZeroHash(value: unknown): Hex | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0+$/.test(value)
    ? (value.toLowerCase() as Hex)
    : null;
}

function ok<T>(result: ViewResult | undefined): T | null {
  return result?.ok ? (result.value as T) : null;
}

function safeText(hex: Hex): string {
  try {
    return hexToString(hex);
  } catch {
    return toHex(hex);
  }
}

/** A request id as it appears in an attestation (a UUID's sixteen bytes, left-aligned in 32) as the UUID. */
function uuidOfBytes32(value: string): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value) || !/^0{32}$/.test(value.slice(34))) return null;
  return jobUuid(value.slice(0, 34));
}

interface RoundEvents {
  opened?: { keeper: string; tipWei: bigint; priceWei: bigint; tx: Hex };
  answered?: { deliveredBy: string; agreed: number; oracleRequestId: string; tx: Hex };
  failed?: { tx: Hex };
  revealed?: string[] | null;
}

export class ChainHouseSource implements HouseSource {
  readonly #chain: ChainSource;
  readonly #deployments: Deployments;
  /** Round events seen so far, by `feedId:round`. Kept while the process runs, so they outlive the log window. */
  readonly #roundEvents = new Map<string, RoundEvents>();
  /**
   * The Doorbell's ring logs this process has read, by `tx:logIndex`, after the kept history. Kept
   * while it runs, so a ring is still counted, and still named HOUSE or OUTSIDE, once its block has
   * left the RPC's log window.
   */
  readonly #rings = new Map<string, DoorbellRing>();
  /** The newest block the ring logs were read to. */
  #ringsReadTo: number | null = null;

  constructor(chain: ChainSource, deployments: Deployments) {
    this.#chain = chain;
    this.#deployments = deployments;
    this.#seedRoundEvents();
  }

  /**
   * The events of the rounds whose logs have left the RPC's reach, as `config/history.ts` keeps
   * them: only for the Questions contract they were read from, and never over an event read live.
   */
  #seedRoundEvents(): void {
    for (const r of pinnedRounds(this.#address("questions"))) {
      const key = `${r.feedId.toLowerCase()}:${r.round}`;
      const held = this.#roundEvents.get(key) ?? {};
      held.opened ??= {
        keeper: r.opened.keeper.toLowerCase(),
        tipWei: r.opened.tipWei,
        priceWei: r.opened.priceWei,
        tx: r.opened.hash,
      };
      held.answered ??= {
        deliveredBy: r.answered.deliveredBy.toLowerCase(),
        agreed: r.answered.agreed,
        oracleRequestId: r.answered.oracleRequestId,
        tx: r.answered.hash,
      };
      this.#roundEvents.set(key, held);
    }
  }

  #address(contract: ContractKey): string | null {
    return this.#deployments.contracts[contract].address;
  }

  #launchBlock(contract: ContractKey): number | null {
    return this.#deployments.launches[this.#deployments.contracts[contract].launch].block;
  }

  /** Runs `load` when the contract has an address and wraps what it returns, or its failure. */
  async #live<T>(
    contract: ContractKey,
    load: (address: string) => Promise<{ data: T; fetchedAt: number; stale: boolean; error: string | null }>,
  ): Promise<Live<T>> {
    const address = this.#address(contract);
    if (!address) return { live: false, contract };
    try {
      return { live: true, contract, address, ...(await load(address)) };
    } catch (error) {
      return {
        live: true,
        contract,
        address,
        data: null,
        fetchedAt: Date.now(),
        stale: true,
        error: messageOf(error),
      };
    }
  }

  // -------------------------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------------------------

  #orderCalls(address: string, id: number): ViewCall[] {
    return [
      { to: address, abi: workOrdersAbi, functionName: "accountOf", args: [BigInt(id)] },
      { to: address, abi: workOrdersAbi, functionName: "orderOf", args: [BigInt(id)] },
      { to: address, abi: workOrdersAbi, functionName: "claimOf", args: [BigInt(id)] },
    ];
  }

  #readOrder(id: number, results: readonly (ViewResult | undefined)[]): Order | null {
    const account = ok<readonly [number, string, bigint, bigint, bigint]>(results[0]);
    if (!account) return null;
    const state = ORDER_STATES[account[0]] ?? "None";
    if (state === "None") return null;
    const o = ok<Record<string, unknown>>(results[1]);
    const c = ok<Record<string, unknown>>(results[2]);
    const terms: OrderTerms | null = o
      ? {
          kindHash: (o.kindHash as string).toLowerCase() as Hex,
          specHash: (o.specHash as string).toLowerCase() as Hex,
          minPayWei: o.minPay as bigint,
          maxPayWei: o.maxPay as bigint,
          rampSecs: Number(o.rampSecs),
          rampFrom: Number(o.rampFrom),
          deliverySecs: Number(o.deliverySecs),
          expiresAt: Number(o.expiresAt),
          bondWei: o.bond as bigint,
          flags: Number(o.flags),
          runnerOnly: addr(o.runnerOnly),
          arbiter: addr(o.arbiter),
          condTarget: addr(o.condTarget),
          condSelector: addr(o.condTarget) ? (o.condSelector as Hex) : null,
          condCmp: Number(o.condCmp),
          condThreshold: o.condThreshold as bigint,
          condMet: Boolean(o.condMet),
          proven: Boolean(o.proven),
          claims: Number(o.seq),
        }
      : null;
    const runner = c ? addr(c.runner) : null;
    const claim: OrderClaim | null =
      c && runner
        ? {
            runner,
            claimedAt: Number(c.claimedAt),
            registeredAt: Number(c.registeredAt),
            priceWei: c.price as bigint,
            jobId: jobUuid(c.jobId),
            challenger: addr(c.challenger),
            assertedAt: Number(c.assertedAt),
            recordHash: nonZeroHash(c.recordHash),
          }
        : null;
    return {
      id,
      state,
      employer: account[1].toLowerCase(),
      escrowWei: account[2],
      spentWei: account[3],
      returnedWei: account[4],
      terms,
      claim,
      spec: null,
    };
  }

  orders(limit = 30): Promise<Live<OrderBook>> {
    return this.#live("workOrders", async (address) => {
      const counted = await this.#chain.views("orders:count", [
        { to: address, abi: workOrdersAbi, functionName: "orderCount" },
      ]);
      // A desk that does not say how many orders it has opened was not read: "no orders" is a
      // statement only its own counter can make.
      const opened = ok<bigint>(counted.value[0]);
      if (opened === null) throw new Error("WorkOrders.orderCount() did not answer");
      const count = Number(opened);
      // The desk numbers orders from 1.
      const ids: number[] = [];
      for (let id = count; id >= 1 && ids.length < limit; id--) ids.push(id);
      const calls = ids.flatMap((id) => this.#orderCalls(address, id));
      const read = await this.#chain.views(`orders:list:${count}:${limit}`, calls);
      const orders: Order[] = [];
      ids.forEach((id, index) => {
        const order = this.#readOrder(id, read.value.slice(index * 3, index * 3 + 3));
        if (order) orders.push(order);
      });
      return {
        data: { count, orders },
        fetchedAt: read.fetchedAt,
        stale: read.stale || counted.stale,
        error: read.error ?? counted.error,
      };
    });
  }

  order(id: number): Promise<Live<Order | null>> {
    return this.#live("workOrders", async (address) => {
      const read = await this.#chain.views(`orders:one:${id}`, this.#orderCalls(address, id));
      // The desk answers `accountOf` for any id (state None for one it never issued). No answer
      // means the desk was not read, which is not the same as "no such order".
      if (!read.value[0]?.ok) throw new Error("WorkOrders.accountOf() did not answer");
      const order = this.#readOrder(id, read.value);
      if (order) order.spec = await this.#specOf(address, id);
      return { data: order, fetchedAt: read.fetchedAt, stale: read.stale, error: read.error };
    });
  }

  /** The job text from the order's `OrderOpened` log, if the RPC still serves that block. */
  async #specOf(address: string, id: number): Promise<string | null> {
    try {
      const topics = encodeEventTopics({
        abi: workOrdersAbi,
        eventName: "OrderOpened",
        args: { id: BigInt(id) },
      });
      const read = await this.#chain.recentLogs(
        `order-opened:${id}`,
        { address, topics: topics as (string | null)[], fromBlock: this.#launchBlock("workOrders") },
        5 * 60_000,
      );
      const log = read.value.logs[0];
      if (!log) return null;
      const { args } = decodeEventLog({
        abi: workOrdersAbi,
        eventName: "OrderOpened",
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data as Hex,
      });
      return hexToString(args.spec);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Pots
  // -------------------------------------------------------------------------------------------

  #potCalls(address: string, id: number): ViewCall[] {
    return [
      { to: address, abi: crowdPotsAbi, functionName: "remaining", args: [BigInt(id)] },
      { to: address, abi: crowdPotsAbi, functionName: "stageOf", args: [BigInt(id)] },
      { to: address, abi: crowdPotsAbi, functionName: "potOf", args: [BigInt(id)] },
    ];
  }

  #readPot(id: number, results: readonly (ViewResult | undefined)[]): Pot | null {
    const remaining = ok<bigint>(results[0]);
    if (remaining === null) return null;
    const stageCode = ok<number>(results[1]);
    const p = ok<Record<string, unknown>>(results[2]);
    const stage = stageCode === null ? "None" : (POT_STAGES[stageCode] ?? "None");
    if (stageCode !== null && stage === "None") return null;
    return {
      id,
      stage,
      remainingWei: remaining,
      targetWei: p ? (p.target as bigint) : null,
      raisedWei: p ? (p.raised as bigint) : null,
      deadline: p ? Number(p.deadline) : null,
      kindHash: p ? nonZeroHash(p.kindHash) : null,
      kind: null,
      specHash: p ? nonZeroHash(p.specHash) : null,
      opener: p ? addr(p.opener) : null,
      orderId: p && (p.orderId as bigint) > 0n ? Number(p.orderId) : null,
      allowClaimed: p ? Boolean(p.allowClaimed) : null,
      minPayWei: p ? (p.minPay as bigint) : null,
      bondWei: p ? (p.bond as bigint) : null,
      deliverySecs: p ? Number(p.deliverySecs) : null,
      hireSecs: p ? Number(p.hireSecs) : null,
      seriesId: p ? Number(p.seriesId) : null,
      spec: null,
    };
  }

  /** Fills in each pot's kind text from `kindOf(kindHash)`: one read for all the distinct hashes. */
  async #nameKinds(address: string, pots: readonly Pot[]): Promise<void> {
    const hashes = [...new Set(pots.map((pot) => pot.kindHash).filter((h): h is Hex => h !== null))];
    if (hashes.length === 0) return;
    try {
      const read = await this.#chain.views(
        `pots:kinds:${hashes.join(",")}`,
        hashes.map((hash) => ({ to: address, abi: crowdPotsAbi, functionName: "kindOf", args: [hash] })),
        10 * 60_000,
      );
      const byHash = new Map<string, string>();
      hashes.forEach((hash, index) => {
        const text = ok<string>(read.value[index]);
        // Shown only when it is the text the hash stands for.
        if (text && keccak256(toHex(text)) === hash) byHash.set(hash, text);
      });
      for (const pot of pots) if (pot.kindHash) pot.kind = byHash.get(pot.kindHash) ?? null;
    } catch {
      // The kind stays unread; the pot's page says so.
    }
  }

  /**
   * The job text behind a pot's `specHash`, from the `SpecPinned` log CrowdPots writes the first
   * time a text is pinned. Returned only when the text hashes to the hash, so what a contributor
   * reads is what the pot will order. Null when the log is out of the RPC's reach.
   */
  async #potSpec(address: string, specHash: Hex): Promise<string | null> {
    try {
      const topics = encodeEventTopics({ abi: crowdPotsAbi, eventName: "SpecPinned", args: { specHash } });
      const read = await this.#chain.recentLogs(
        `spec-pinned:${specHash}`,
        { address, topics: topics as (string | null)[], fromBlock: this.#launchBlock("crowdPots") },
        5 * 60_000,
      );
      for (const log of read.value.logs) {
        const { args } = decodeEventLog({
          abi: crowdPotsAbi,
          eventName: "SpecPinned",
          topics: log.topics as [Hex, ...Hex[]],
          data: log.data as Hex,
        });
        if (keccak256(args.spec) === specHash.toLowerCase()) return hexToString(args.spec);
      }
      return null;
    } catch {
      return null;
    }
  }

  pots(limit = 30): Promise<Live<PotBook>> {
    return this.#live("crowdPots", async (address) => {
      const counted = await this.#chain.views("pots:count", [
        { to: address, abi: crowdPotsAbi, functionName: "potCount" },
      ]);
      const opened = ok<bigint>(counted.value[0]);
      if (opened === null) throw new Error("CrowdPots.potCount() did not answer");
      const count = Number(opened);
      const ids: number[] = [];
      for (let id = count; id >= 1 && ids.length < limit; id--) ids.push(id);
      const read = await this.#chain.views(
        `pots:list:${count}:${limit}`,
        ids.flatMap((id) => this.#potCalls(address, id)),
      );
      const pots: Pot[] = [];
      ids.forEach((id, index) => {
        const pot = this.#readPot(id, read.value.slice(index * 3, index * 3 + 3));
        if (pot) pots.push(pot);
      });
      await this.#nameKinds(address, pots);
      return { data: { count, pots }, fetchedAt: read.fetchedAt, stale: read.stale, error: read.error };
    });
  }

  pot(id: number): Promise<Live<Pot | null>> {
    return this.#live("crowdPots", async (address) => {
      const read = await this.#chain.views(`pots:one:${id}`, this.#potCalls(address, id));
      // `remaining` answers for any id (zero for a pot that was never opened), so no answer means
      // CrowdPots was not read.
      if (!read.value[0]?.ok) throw new Error("CrowdPots.remaining() did not answer");
      const pot = this.#readPot(id, read.value);
      if (pot) await this.#nameKinds(address, [pot]);
      if (pot?.specHash) pot.spec = await this.#potSpec(address, pot.specHash);
      return {
        data: pot,
        fetchedAt: read.fetchedAt,
        stale: read.stale,
        error: read.error,
      };
    });
  }

  /**
   * Who sent the rings whose `Rang` log is still within reach of the RPC, from the launch block on.
   * Null when the log could not be read: "no ringer read" is never "nobody rang".
   */
  async #ringers(address: string): Promise<DoorbellRingers | null> {
    // The rings this site keeps are counted from the history; the logs are read only after them.
    const kept = pinnedRings(address);
    try {
      const topics = encodeEventTopics({ abi: doorbellAbi, eventName: "Rang" });
      const launched = this.#launchBlock("doorbell");
      const read = await this.#chain.recentLogs(
        "doorbell:rang",
        {
          address,
          topics: topics as (string | null)[],
          fromBlock: kept ? Math.max(kept.toBlock + 1, launched ?? 0) : launched,
        },
        60_000,
      );
      // Inside the blocks just read, the RPC's answer stands (a ring a reorganisation took away goes
      // with it); a ring read earlier whose block has since left the log window stays as it was read.
      const { fromBlock, toBlock } = read.value;
      for (const [key, ring] of this.#rings) {
        if (ring.block >= fromBlock && ring.block <= toBlock) this.#rings.delete(key);
      }
      for (const log of read.value.logs) {
        const block = Number(BigInt(log.blockNumber));
        // A ring the history already counts is never counted twice.
        if (kept && block <= kept.toBlock) continue;
        const { args } = decodeEventLog({
          abi: doorbellAbi,
          eventName: "Rang",
          topics: log.topics as [Hex, ...Hex[]],
          data: log.data as Hex,
        });
        if (this.#rings.size >= RINGS_KEPT_MAX) this.#rings.clear();
        const tx = log.transactionHash.toLowerCase();
        this.#rings.set(`${tx}:${Number(BigInt(log.logIndex))}`, {
          ringer: args.ringer.toLowerCase(),
          count: Number(args.count),
          block,
          tx,
        });
      }
      this.#ringsReadTo = Math.max(this.#ringsReadTo ?? 0, read.value.toBlock);
      return this.#ringersSoFar(kept, read.value.fromBlock);
    } catch {
      // The kept rings, and the rings this process read before, stand on their own when the log
      // cannot be read now. With neither, who rang is unread: never "nobody".
      return kept || this.#rings.size > 0 ? this.#ringersSoFar(kept, null) : null;
    }
  }

  /** The kept rings and every ring this process has read, as one count by ringer. */
  #ringersSoFar(kept: PinnedRings | null, windowFrom: number | null): DoorbellRingers {
    const count = new Map<string, number>();
    for (const r of kept?.byRinger ?? []) count.set(r.ringer, r.rings);
    const live = [...this.#rings.values()].sort((a, b) => b.block - a.block || b.count - a.count);
    for (const ring of live) count.set(ring.ringer, (count.get(ring.ringer) ?? 0) + 1);
    const starts = [windowFrom, live.at(-1)?.block ?? null].filter((n): n is number => n !== null);
    return {
      read: (kept?.rings ?? 0) + live.length,
      fromBlock: kept ? kept.fromBlock : starts.length > 0 ? Math.min(...starts) : 0,
      toBlock: Math.max(this.#ringsReadTo ?? 0, kept?.toBlock ?? 0),
      byRinger: [...count.entries()]
        .map(([ringer, rings]) => ({ ringer, rings }))
        .sort((a, b) => b.rings - a.rings || a.ringer.localeCompare(b.ringer)),
      pinned: kept?.rings ?? 0,
      pinnedOn: kept?.read ?? null,
      recent: live.slice(0, RECENT_RINGS).map((ring) => ({ ...ring })),
    };
  }

  ringCost(): Promise<Live<GasCost>> {
    return this.#live("doorbell", async (address) => {
      // Asked with no sender: ring() checks none, and the estimate is the same for any wallet.
      const read = await this.#chain.gasCost("doorbell:ring", {
        to: address,
        data: encodeFunctionData({ abi: doorbellAbi, functionName: "ring" }),
      });
      return { data: read.value, fetchedAt: read.fetchedAt, stale: read.stale, error: read.error };
    });
  }

  runnerBeat(runner: string): Promise<Live<RunnerBeat>> {
    return this.#live("workOrders", async (address) => {
      const names: RunnerEventName[] = ["Claimed", "Registered", "DeliveryClaimed", "Delivered"];
      const read = await this.#chain.recentLogs(
        "desk:runner-events",
        {
          address,
          topics: [
            names.map((eventName) => encodeEventTopics({ abi: workOrdersAbi, eventName })[0] as string),
          ],
          fromBlock: this.#launchBlock("workOrders"),
        },
        60_000,
      );
      const logs = [...read.value.logs].sort(
        (a, b) =>
          Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
          Number(BigInt(a.logIndex) - BigInt(b.logIndex)),
      );
      // Who held each order when its later events were written: the runner of its newest Claimed.
      const holder = new Map<number, string>();
      const seen: (RunnerEvent & { by: string | null; stamp: string | undefined })[] = [];
      for (const log of logs) {
        let decoded;
        try {
          decoded = decodeEventLog({
            abi: workOrdersAbi,
            topics: log.topics as [Hex, ...Hex[]],
            data: log.data as Hex,
          });
        } catch {
          continue;
        }
        const name = decoded.eventName as string;
        if (!(names as string[]).includes(name)) continue;
        const args = decoded.args as { id: bigint; runner?: string };
        const id = Number(args.id);
        let by: string | null = null;
        if (name === "Claimed" || name === "Delivered") by = args.runner?.toLowerCase() ?? null;
        else by = holder.get(id) ?? null;
        if (name === "Claimed" && by) holder.set(id, by);
        seen.push({
          name: name as RunnerEventName,
          orderId: id,
          block: Number(BigInt(log.blockNumber)),
          tx: log.transactionHash.toLowerCase(),
          at: null,
          by,
          stamp: log.blockTimestamp,
        });
      }
      // An order whose claim is older than the blocks read: the desk's own record names its runner,
      // unless the order was claimed again inside them (then the earlier holder is not known here).
      const open = [
        ...new Set(seen.filter((e) => e.by === null && !holder.has(e.orderId)).map((e) => e.orderId)),
      ];
      if (open.length > 0) {
        const claims = await this.#chain.views(
          `desk:holders:${open.join(",")}`,
          open.map((id) => ({
            to: address,
            abi: workOrdersAbi,
            functionName: "claimOf",
            args: [BigInt(id)],
          })),
        );
        open.forEach((id, index) => {
          const claim = ok<Record<string, unknown>>(claims.value[index]);
          const by = claim ? addr(claim.runner) : null;
          for (const e of seen) if (e.orderId === id && e.by === null) e.by = by;
        });
      }
      const who = runner.toLowerCase();
      const newest = seen.filter((e) => e.by === who).at(-1) ?? null;
      let last: RunnerEvent | null = null;
      if (newest) {
        const at = newest.stamp ? Number(BigInt(newest.stamp)) : await this.#chain.blockTime(newest.block);
        last = { name: newest.name, orderId: newest.orderId, block: newest.block, tx: newest.tx, at };
      }
      return {
        data: { runner: who, last, fromBlock: read.value.fromBlock, toBlock: read.value.toBlock },
        fetchedAt: read.fetchedAt,
        stale: read.stale,
        error: read.error,
      };
    });
  }

  doorbell(): Promise<Live<DoorbellState>> {
    return this.#live("doorbell", async (address) => {
      const call = (functionName: string): ViewCall => ({ to: address, abi: doorbellAbi, functionName });
      const read = await this.#chain.views("doorbell", [
        call("ringsUntilHire"),
        call("funded"),
        call("ALLOW_CLAIMED"),
        call("rings"),
        call("hires"),
        call("receipts"),
        call("lastOrderId"),
        call("MIN_PAY"),
        call("MAX_PAY"),
        call("BOND"),
        call("DELIVERY_SECS"),
      ]);
      const rings = ok<bigint>(read.value[0]);
      if (rings === null) throw new Error("Doorbell.ringsUntilHire() did not answer");
      const count = (index: number) => {
        const value = ok<bigint | number>(read.value[index]);
        return value === null ? null : Number(value);
      };
      // What it holds is the token's to say. A read that fails is "unread", never "nothing".
      const balance = await this.#chain.imdBalance(address).then(
        (held) => held.value,
        () => null,
      );
      // The log is read only for a Doorbell that has been rung, or whose counter did not answer.
      const rung = count(3);
      const ringers = rung === 0 ? null : await this.#ringers(address);
      return {
        data: {
          ringsUntilHire: Number(rings),
          funded: ok<boolean>(read.value[1]),
          allowClaimed: ok<boolean>(read.value[2]),
          rings: count(3),
          hires: count(4),
          receipts: count(5),
          lastOrderId: count(6),
          minPayWei: ok<bigint>(read.value[7]),
          maxPayWei: ok<bigint>(read.value[8]),
          bondWei: ok<bigint>(read.value[9]),
          deliverySecs: count(10),
          balanceWei: balance,
          ringers,
        },
        fetchedAt: read.fetchedAt,
        stale: read.stale,
        error: read.error,
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Payroll
  // -------------------------------------------------------------------------------------------

  ledger(): Promise<Live<PayrollLedger>> {
    return this.#live("payroll", async (address) => {
      const call = (functionName: string): ViewCall => ({ to: address, abi: payrollAbi, functionName });
      const read = await this.#chain.views("payroll:ledger", [
        call("ledger"),
        call("stream"),
        call("owed"),
        call("feedBudget"),
        call("feedShortfalls"),
        call("unbooked"),
        call("SEAT_BPS"),
        call("FEED_BPS"),
        call("STREAM_DURATION"),
      ]);
      const l = ok<Record<string, bigint>>(read.value[0]);
      if (!l) throw new Error("Payroll.ledger() did not answer");
      const stream = ok<readonly bigint[]>(read.value[1]);
      const owed = ok<readonly bigint[]>(read.value[2]);
      const budget = ok<readonly bigint[]>(read.value[3]);
      const shortfalls = ok<readonly bigint[]>(read.value[4]);
      const [seatBps, feedBps, streamSecs] = [6, 7, 8].map((index) => ok<bigint>(read.value[index]));
      return {
        data: {
          receivedWei: l.received ?? 0n,
          toStakersWei: l.toStakers ?? 0n,
          toSeatsWei: l.toSeats ?? 0n,
          toFeedsWei: l.toFeeds ?? 0n,
          drippedWei: l.dripped ?? 0n,
          seatClaimedWei: l.seatClaimed ?? 0n,
          tipsInWei: l.tipsIn ?? 0n,
          tipsClaimedWei: l.tipsClaimed ?? 0n,
          feedsFundedWei: l.feedsFunded ?? 0n,
          tipsToSeatsWei: l.tipsToSeats ?? 0n,
          feedsReleasedWei: l.feedsReleased ?? 0n,
          stream:
            stream && stream.length >= 6
              ? {
                  outstandingWei: stream[0] as bigint,
                  unvestedWei: stream[1] as bigint,
                  endsAt: Number(stream[2]),
                  perDripWei: stream[3] as bigint,
                  nextDripAt: Number(stream[4]),
                  dueNowWei: stream[5] as bigint,
                }
              : null,
          owed:
            owed && owed.length >= 5
              ? {
                  stakersWei: owed[0] as bigint,
                  seatsWei: owed[1] as bigint,
                  tipsWei: owed[2] as bigint,
                  feedsWei: owed[3] as bigint,
                  totalWei: owed[4] as bigint,
                }
              : null,
          feedBudget:
            budget && budget.length >= 4
              ? {
                  totalWei: budget[0] as bigint,
                  oldWei: budget[1] as bigint,
                  releasableNowWei: budget[2] as bigint,
                  nextReleaseAt: Number(budget[3]),
                }
              : null,
          feedShortfallsWei:
            shortfalls && shortfalls.length === 3
              ? [shortfalls[0] as bigint, shortfalls[1] as bigint, shortfalls[2] as bigint]
              : null,
          unbookedWei: ok<bigint>(read.value[5]),
          constants:
            seatBps != null && feedBps != null && streamSecs != null
              ? { seatBps: Number(seatBps), feedBps: Number(feedBps), streamSecs: Number(streamSecs) }
              : null,
        },
        fetchedAt: read.fetchedAt,
        stale: read.stale,
        error: read.error,
      };
    });
  }

  seatPay(tokenId: number): Promise<Live<SeatPay>> {
    return this.#live("payroll", async (address) => {
      const read = await this.#chain.views(`payroll:seat:${tokenId}`, [
        { to: address, abi: payrollAbi, functionName: "seatClaimable", args: [BigInt(tokenId)] },
        { to: address, abi: payrollAbi, functionName: "seatPaid", args: [BigInt(tokenId)] },
      ]);
      const claimable = ok<bigint>(read.value[0]);
      if (claimable === null) throw new Error("Payroll.seatClaimable() did not answer");
      return {
        data: { tokenId, claimableWei: claimable, paidWei: ok<bigint>(read.value[1]) },
        fetchedAt: read.fetchedAt,
        stale: read.stale,
        error: read.error,
      };
    });
  }

  tipOwed(agentId: string): Promise<Live<bigint>> {
    return this.#live("payroll", async (address) => {
      const read = await this.#chain.views(`payroll:tip:${agentId}`, [
        { to: address, abi: payrollAbi, functionName: "tipOwed", args: [BigInt(agentId)] },
      ]);
      const owed = ok<bigint>(read.value[0]);
      if (owed === null) throw new Error("Payroll.tipOwed() did not answer");
      return { data: owed, fetchedAt: read.fetchedAt, stale: read.stale, error: read.error };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Standing Questions
  // -------------------------------------------------------------------------------------------

  /** Reads the round events the RPC still serves and adds them to what this process already holds. */
  async #readRoundEvents(
    address: string,
  ): Promise<{ fromBlock: number | null; toBlock: number | null; error: string | null }> {
    try {
      const topic = (eventName: "RoundOpened" | "RoundAnswered" | "RoundFailed" | "AnswerRevealed") =>
        encodeEventTopics({ abi: questionsAbi, eventName })[0] as string;
      const read = await this.#chain.recentLogs("questions:rounds", {
        address,
        topics: [
          [topic("RoundOpened"), topic("RoundAnswered"), topic("RoundFailed"), topic("AnswerRevealed")],
        ],
        fromBlock: this.#launchBlock("questions"),
      });
      for (const log of read.value.logs) this.#keepRoundEvent(log);
      return { fromBlock: read.value.fromBlock, toBlock: read.value.toBlock, error: read.error };
    } catch (error) {
      return { fromBlock: null, toBlock: null, error: messageOf(error) };
    }
  }

  #keepRoundEvent(log: RawLog): void {
    try {
      const decoded = decodeEventLog({
        abi: questionsAbi,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data as Hex,
      });
      const tx = log.transactionHash.toLowerCase() as Hex;
      const at = (feedId: string, round: bigint) => {
        const key = `${feedId.toLowerCase()}:${round}`;
        let held = this.#roundEvents.get(key);
        if (!held) {
          if (this.#roundEvents.size > 5000) {
            this.#roundEvents.clear();
            this.#seedRoundEvents();
          }
          held = this.#roundEvents.get(key) ?? {};
          this.#roundEvents.set(key, held);
        }
        return held;
      };
      if (decoded.eventName === "RoundOpened") {
        const a = decoded.args;
        at(a.feedId, a.round).opened = {
          keeper: a.keeper.toLowerCase(),
          tipWei: a.tip,
          priceWei: a.price,
          tx,
        };
      } else if (decoded.eventName === "RoundAnswered") {
        const a = decoded.args;
        at(a.feedId, a.round).answered = {
          deliveredBy: a.deliveredBy.toLowerCase(),
          agreed: Number(a.agreed),
          oracleRequestId: a.oracleRequestId,
          tx,
        };
      } else if (decoded.eventName === "RoundFailed") {
        const a = decoded.args;
        at(a.feedId, a.round).failed = { tx };
      } else if (decoded.eventName === "AnswerRevealed") {
        const a = decoded.args;
        at(a.feedId, a.round).revealed = addressList(a.answer);
      }
    } catch {
      // Not one of the four, or not decodable: leave it out.
    }
  }

  feeds(): Promise<Live<FeedBook>> {
    return this.#live("questions", async (address) => {
      const counted = await this.#chain.views("feeds:count", [
        { to: address, abi: questionsAbi, functionName: "feedCount" },
        { to: address, abi: questionsAbi, functionName: "INTAKE" },
      ]);
      // "No feed has been created" is a statement only the contract's own counter can make: an
      // address that does not answer it was not read, and the page says so instead.
      const created_ = ok<bigint>(counted.value[0]);
      if (created_ === null) throw new Error("Questions.feedCount() did not answer");
      const count = Number(created_);
      // The Intake this Questions contract was built on: the caller of its callback.
      const intake = ok<string>(counted.value[1]) ?? MAINNET.INTAKE;
      const listed = Math.min(count, 40);
      const idRead = await this.#chain.views(
        `feeds:ids:${listed}`,
        Array.from({ length: listed }, (_, index) => ({
          to: address,
          abi: questionsAbi,
          functionName: "feedAt",
          args: [BigInt(index)],
        })),
        5 * 60_000,
      );
      const created = idRead.value
        .map((r) => nonZeroHash(ok<string>(r)))
        .filter((id): id is Hex => id !== null);
      // The three house feeds first, whether or not anyone has created them yet, then the oldest others.
      const houseIds = HOUSE_FEED_NAMES.map((name) => HOUSE_FEEDS[name].id.toLowerCase() as Hex);
      const others = created.filter((id) => !houseIds.includes(id)).slice(0, OTHER_FEEDS_READ);
      const ids = [...houseIds, ...others];
      const payroll = this.#address("payroll");
      const PER = 7;
      const read = await this.#chain.views(
        `feeds:state:${ids.join(",")}:${payroll ?? ""}`,
        ids.flatMap((id): ViewCall[] => [
          { to: address, abi: questionsAbi, functionName: "feedState", args: [id] },
          { to: address, abi: questionsAbi, functionName: "latest", args: [id] },
          { to: address, abi: questionsAbi, functionName: "feedParams", args: [id] },
          { to: address, abi: questionsAbi, functionName: "feedText", args: [id] },
          { to: address, abi: questionsAbi, functionName: "canSubmit", args: [id] },
          { to: address, abi: questionsAbi, functionName: "canAbandon", args: [id] },
          {
            to: address,
            abi: questionsAbi,
            functionName: "redeemable",
            args: [id, payroll ?? "0x0000000000000000000000000000000000000000"],
          },
        ]),
      );
      const events = await this.#readRoundEvents(address);

      const feeds: Feed[] = [];
      const roundCalls: ViewCall[] = [];
      const roundSlots: { feed: Feed; round: number }[] = [];
      ids.forEach((id, index) => {
        const base = index * PER;
        const state = ok<Record<string, unknown>>(read.value[base]);
        // A house feed nobody has created yet is not in the contract: the page shows its definition
        // from the shared package and says it does not exist on chain.
        if (!state || state.exists !== true) return;
        const latest = ok<readonly [bigint, bigint, bigint, bigint, bigint]>(read.value[base + 1]);
        const p = ok<Record<string, unknown>>(read.value[base + 2]);
        const text = ok<readonly [Hex, Hex]>(read.value[base + 3]);
        const abandon = ok<readonly [number, bigint]>(read.value[base + 5]);
        const blocker = Number(state.blocker);
        const house = houseFeedById(id)?.name ?? null;
        const feed: Feed = {
          id,
          house,
          rounds: Number(state.rounds),
          latest: {
            value: latest?.[0] ?? 0n,
            fromBlock: Number(latest?.[1] ?? 0n),
            toBlock: Number(latest?.[2] ?? 0n),
            round: Number(latest?.[3] ?? 0n),
            updatedAt: Number(latest?.[4] ?? 0n),
          },
          meterWei: state.meterBalance as bigint,
          meterShares: state.totalShares as bigint,
          costWei: state.cost as bigint,
          pending: Boolean(state.pending),
          failStreak: Number(state.failStreak),
          lastRequestBlock: Number(state.lastRequestBlock),
          nextRequestBlock: Number(state.nextRequestBlock),
          blocker: named(() => requestBlockerName(blocker)),
          canSubmit: ok<boolean>(read.value[base + 4]),
          abandon: abandon
            ? {
                step: named(() => abandonStepName(Number(abandon[0]))) ?? "Wait",
                closableAt: Number(abandon[1]),
              }
            : null,
          params: p
            ? {
                answerType: Number(p.answerType),
                panelSize: Number(p.panelSize),
                quorum: Number(p.quorum),
                minAgreed: Number(p.minAgreed),
                validFor: Number(p.validFor),
                cadenceBlocks: Number(p.cadenceBlocks),
                maxWindowBlocks: Number(p.maxWindowBlocks),
                lagBlocks: Number(p.lagBlocks),
                contiguous: Boolean(p.contiguous),
                pinHash: Boolean(p.pinHash),
                maxPriceWei: p.maxPrice as bigint,
                tipWei: p.tip as bigint,
                gateCmp: Number(p.gateCmp),
                gateTarget: addr(p.gateTarget),
                gateThreshold: p.gateThreshold as bigint,
              }
            : null,
          questionPrefix: text ? safeText(text[0]) : null,
          tail: text ? safeText(text[1]) : null,
          payrollPositionWei: payroll && house ? ok<bigint>(read.value[base + 6]) : null,
          roundList: [],
        };
        feeds.push(feed);
        if (house) {
          for (let round = feed.rounds; round >= 1 && round > feed.rounds - ROUNDS_READ; round--) {
            roundSlots.push({ feed, round });
            roundCalls.push(
              { to: address, abi: questionsAbi, functionName: "roundOf", args: [id, BigInt(round)] },
              { to: address, abi: questionsAbi, functionName: "roundRequest", args: [id, BigInt(round)] },
            );
          }
        }
      });

      const roundsKey = feeds.map((f) => `${f.id.slice(0, 10)}:${f.rounds}`).join(",");
      const rounds =
        roundCalls.length > 0 ? await this.#chain.views(`feeds:rounds:${roundsKey}`, roundCalls) : null;
      roundSlots.forEach(({ feed, round }, index) => {
        const r = ok<readonly [number, bigint, bigint, bigint, bigint]>(rounds?.value[index * 2]);
        if (!r) return;
        const request = ok<readonly [Hex, Hex, Hex, bigint]>(rounds?.value[index * 2 + 1]);
        const status = named(() => roundStatusName(Number(r[0]))) ?? "None";
        const seen = this.#roundEvents.get(`${feed.id}:${round}`) ?? {};
        const byCallback = seen.answered
          ? answerDelivery(seen.answered.deliveredBy, intake) === "callback"
          : null;
        // The tip rule of the contract as launched: an answered round's tip is credited to the
        // keeper that opened the round (`RoundOpened.keeper`), whether the Intake's callback
        // delivered the answer or somebody handed it in with `submit`. Handing in earns nothing.
        // So the earner is known only while the round's opening log is in reach.
        let tipOutcome: TipOutcome = "unread";
        let tipEarner: string | null = null;
        if (status === "Pending") tipOutcome = "pending";
        else if (status === "Failed") tipOutcome = "returned";
        else if (status === "Answered") {
          tipEarner = seen.opened?.keeper ?? null;
          tipOutcome = tipEarner ? "earned" : "unread";
        }
        feed.roundList.push({
          round,
          status,
          value: r[1],
          fromBlock: Number(r[2]),
          toBlock: Number(r[3]),
          updatedAt: Number(r[4]),
          requestedAt: request ? Number(request[3]) : null,
          intakeRequestId: request ? nonZeroHash(request[0]) : null,
          questionHash: request ? nonZeroHash(request[1]) : null,
          keeper: seen.opened?.keeper ?? null,
          tipWei: seen.opened?.tipWei ?? null,
          priceWei: seen.opened?.priceWei ?? null,
          openedTx: seen.opened?.tx ?? null,
          deliveredBy: seen.answered?.deliveredBy ?? null,
          byCallback,
          agreed: seen.answered?.agreed ?? null,
          oracleRequestId: seen.answered ? uuidOfBytes32(seen.answered.oracleRequestId) : null,
          settledTx: seen.answered?.tx ?? seen.failed?.tx ?? null,
          tipOutcome,
          tipEarner,
          revealed: seen.revealed ?? null,
        });
      });

      return {
        data: {
          count,
          feeds,
          eventsFrom: events.fromBlock,
          eventsTo: events.toBlock,
          eventsError: events.error,
        },
        fetchedAt: read.fetchedAt,
        stale: read.stale || counted.stale,
        error: read.error ?? counted.error,
      };
    });
  }

  keeperTips(keeper: string): Promise<Live<KeeperTips>> {
    return this.#live("questions", async (address) => {
      const read = await this.#chain.views(`questions:tips:${keeper.toLowerCase()}`, [
        { to: address, abi: questionsAbi, functionName: "tipsOf", args: [keeper] },
      ]);
      const tips = ok<readonly [bigint, bigint]>(read.value[0]);
      if (!tips) throw new Error("Questions.tipsOf() did not answer");
      return {
        data: { keeper: keeper.toLowerCase(), earnedWei: tips[0], pendingWei: tips[1] },
        fetchedAt: read.fetchedAt,
        stale: read.stale,
        error: read.error,
      };
    });
  }

  report(limit = 14): Promise<Live<JobsReportRead>> {
    return this.#live("jobsReport", async (address) => {
      const read = await this.#chain.views(`report:${limit}`, [
        { to: address, abi: jobsReportAbi, functionName: "latestPrints", args: [0n, BigInt(limit)] },
        { to: address, abi: jobsReportAbi, functionName: "summary" },
        { to: address, abi: jobsReportAbi, functionName: "latestCrown" },
      ]);
      const page = ok<readonly Record<string, bigint>[]>(read.value[0]);
      if (!page) throw new Error("JobsReport.latestPrints() did not answer");
      const s = ok<Record<string, bigint>>(read.value[1]);
      const crown = ok<readonly [boolean, bigint, Record<string, unknown>]>(read.value[2]);
      const total = s ? Number(s.prints ?? 0n) : null;
      const crowned = crown?.[0] ? crown[2] : null;
      return {
        data: {
          summary: s
            ? {
                prints: Number(s.prints ?? 0n),
                totalWei: s.total ?? 0n,
                counts: Number(s.counts ?? 0n),
                totalCount: s.totalCount ?? 0n,
                bestAmountWei: s.bestAmount ?? 0n,
                bestIndex: Number(s.bestIndex ?? 0n),
                streak: Number(s.streak ?? 0n),
                longestStreak: Number(s.longestStreak ?? 0n),
                crowns: Number(s.crowns ?? 0n),
                latestCrownedRound: Number(s.latestCrownedRound ?? 0n),
              }
            : null,
          // `latestPrints` answers newest first, so the first entry is print number `prints - 1`.
          prints: page.map((p, position) => ({
            index: total === null ? null : total - 1 - position,
            amountWei: p.amount ?? 0n,
            count: Number(p.count ?? 0n),
            fromBlock: Number(p.fromBlock ?? 0n),
            toBlock: Number(p.toBlock ?? 0n),
            payrollsRound: Number(p.payrollsRound ?? 0n),
            hiresRound: Number(p.hiresRound ?? 0n),
          })),
          crown:
            crown && crowned
              ? {
                  round: Number(crown[1]),
                  places: [crowned.first, crowned.second, crowned.third]
                    .slice(0, Number(crowned.places))
                    .map((a) => addr(a))
                    .filter((a): a is string => a !== null),
                  fromBlock: Number(crowned.fromBlock),
                  toBlock: Number(crowned.toBlock),
                  crownedAt: Number(crowned.crownedAt),
                }
              : null,
        },
        fetchedAt: read.fetchedAt,
        stale: read.stale,
        error: read.error,
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Launch C
  // -------------------------------------------------------------------------------------------

  endowments(limit = 20): Promise<Live<EndowmentBook>> {
    return this.#live("endowments", async (address) => {
      const call = (functionName: string, args?: readonly unknown[]): ViewCall => ({
        to: address,
        abi: endowmentsAbi,
        functionName,
        args,
      });
      const head = await this.#chain.views("endowments:head", [
        call("endowmentCount"),
        call("METER_RUNWAY"),
        call("nextStakeBlock"),
        call("pendingTotal"),
        call("vaultHold"),
      ]);
      const counted = ok<bigint>(head.value[0]);
      if (counted === null) throw new Error("Endowments.endowmentCount() did not answer");
      const count = Number(counted);
      const ids: number[] = [];
      for (let id = count; id >= 1 && ids.length < limit; id--) ids.push(id);
      const read = await this.#chain.views(
        `endowments:list:${count}:${limit}`,
        ids.flatMap((id) => [call("endowment", [BigInt(id)]), call("harvestable", [BigInt(id)])]),
      );
      const creators = ids.length > 0 ? await this.#endowmentCreators(address) : new Map<number, string>();
      const endowments: EndowmentRead[] = [];
      ids.forEach((id, index) => {
        const e = ok<readonly [number, Hex, string, bigint, bigint, bigint, bigint]>(read.value[index * 2]);
        if (!e) return;
        const kind = ENDOWMENT_KINDS[Number(e[0])] ?? "None";
        if (kind === "None") return;
        endowments.push({
          id,
          kind,
          target: e[1].toLowerCase() as Hex,
          beneficiary: addr(e[2]),
          principalWei: e[3],
          bufferedWei: e[4],
          harvestedWei: e[6],
          harvestableWei: ok<bigint>(read.value[index * 2 + 1]),
          creator: creators.get(id) ?? null,
        });
      });
      const number = (index: number) => {
        const value = ok<bigint>(head.value[index]);
        return value === null ? null : Number(value);
      };
      return {
        data: {
          count,
          endowments,
          meterRunway: number(1),
          nextStakeBlock: number(2),
          pendingWei: ok<bigint>(head.value[3]),
          vaultHold: ok<boolean>(head.value[4]),
        },
        fetchedAt: read.fetchedAt,
        stale: read.stale || head.stale,
        error: read.error ?? head.error,
      };
    });
  }

  /**
   * Who created each endowment whose `Created` log is still within reach of the RPC, from the launch
   * block on. Empty when the logs could not be read: an unread creator is never "nobody".
   */
  async #endowmentCreators(address: string): Promise<Map<number, string>> {
    const creators = new Map<number, string>();
    try {
      const topics = encodeEventTopics({ abi: endowmentsAbi, eventName: "Created" });
      const read = await this.#chain.recentLogs(
        "endowments:created",
        { address, topics: topics as (string | null)[], fromBlock: this.#launchBlock("endowments") },
        60_000,
      );
      for (const log of read.value.logs) {
        const { args } = decodeEventLog({
          abi: endowmentsAbi,
          eventName: "Created",
          topics: log.topics as [Hex, ...Hex[]],
          data: log.data as Hex,
        });
        creators.set(Number(args.id), args.creator.toLowerCase());
      }
    } catch {
      // The creators stay unread; the page says so.
    }
    return creators;
  }

  rules(limit = 20): Promise<Live<RuleBook>> {
    return this.#live("rules", async (address) => {
      const call = (functionName: string, args?: readonly unknown[]): ViewCall => ({
        to: address,
        abi: rulesAbi,
        functionName,
        args,
      });
      const head = await this.#chain.views("rules:count", [call("ruleCount")]);
      const counted = ok<bigint>(head.value[0]);
      if (counted === null) throw new Error("Rules.ruleCount() did not answer");
      const count = Number(counted);
      const ids: number[] = [];
      for (let id = count; id >= 1 && ids.length < limit; id--) ids.push(id);
      const read = await this.#chain.views(
        `rules:list:${count}:${limit}`,
        ids.flatMap((id) => [
          call("getRule", [BigInt(id)]),
          call("statusOf", [BigInt(id)]),
          call("canFire", [BigInt(id)]),
        ]),
      );
      const rules: RuleRead[] = [];
      ids.forEach((id, index) => {
        const r = ok<Record<string, unknown>>(read.value[index * 3]);
        if (!r) return;
        const status = RULE_STATUSES[Number(ok<number>(read.value[index * 3 + 1]) ?? 0)] ?? "None";
        if (status === "None") return;
        const when = r.when as Record<string, unknown>;
        const hire = r.hire as Record<string, unknown>;
        const pay = r.pay as Record<string, unknown>;
        const action = Number(r.action);
        rules.push({
          id,
          status,
          creator: (r.creator as string).toLowerCase(),
          action,
          conditionKind: Number(when.kind),
          conditionTarget: (when.target as string).toLowerCase(),
          cmp: Number(when.cmp),
          threshold: when.threshold as bigint,
          feedId: nonZeroHash(when.feedId),
          escrowWei: r.escrow as bigint,
          tipWei: r.tip as bigint,
          fires: Number(r.fires),
          maxFires: Number(r.maxFires),
          cooldownSecs: Number(r.cooldown),
          spendWei: action === 1 ? (hire.maxPay as bigint) : (pay.amount as bigint),
          payRecipient: action === 2 ? addr(pay.recipient) : null,
          canFire: ok<boolean>(read.value[index * 3 + 2]),
        });
      });
      return {
        data: { count, rules },
        fetchedAt: read.fetchedAt,
        stale: read.stale || head.stale,
        error: read.error ?? head.error,
      };
    });
  }

  identity(contract: ContractKey): Promise<Live<ContractIdentity>> {
    return this.#live(contract, async (address) => {
      // Every contract of ours was built around one protocol address it can be asked for: the IMD
      // token for most, the WorkRegistry for the checker, the Questions contract for the report.
      const probe: { abi: Abi; functionName: string; expect: string | null; what: string } =
        contract === "workProof"
          ? {
              abi: workProofAbi,
              functionName: "WORK_REGISTRY",
              expect: MAINNET.WORK_REGISTRY,
              what: "IdentityMD's WorkRegistry",
            }
          : contract === "jobsReport"
            ? {
                abi: jobsReportAbi,
                functionName: "QUESTIONS",
                expect: this.#address("questions"),
                what: "our Questions contract",
              }
            : {
                abi: IDENTITY_ABI[contract],
                functionName: "IMD",
                expect: MAINNET.IMD,
                what: "the IMD token",
              };
      const asked = `${probe.functionName}()`;
      const read = await this.#chain.views(
        `identity:${contract}:${address.toLowerCase()}`,
        [{ to: address, abi: probe.abi, functionName: probe.functionName }],
        60_000,
      );
      const result = read.value[0];
      const answer = ok<string>(result);
      let data: ContractIdentity;
      if (answer === null) {
        data = {
          confirmed: false,
          asked,
          detail: `the address configured for it did not answer ${asked} (${result && !result.ok ? result.error : "no result"})`,
        };
      } else if (probe.expect === null) {
        data = {
          confirmed: false,
          asked,
          detail: `it answered ${asked} with ${answer}, but ${probe.what} has no configured address to compare with`,
        };
      } else if (answer.toLowerCase() !== probe.expect.toLowerCase()) {
        data = {
          confirmed: false,
          asked,
          detail: `the address configured for it answered ${asked} with ${answer}, which is not ${probe.what} (${probe.expect})`,
        };
      } else {
        data = { confirmed: true, asked, detail: `it answers ${asked} with ${probe.what}` };
      }
      return { data, fetchedAt: read.fetchedAt, stale: read.stale, error: read.error };
    });
  }
}

/** Each contract's own generated ABI holds its `IMD()` getter. */
const IDENTITY_ABI: Record<Exclude<ContractKey, "workProof" | "jobsReport">, Abi> = {
  questions: questionsAbi,
  payroll: payrollAbi,
  workOrders: workOrdersAbi,
  crowdPots: crowdPotsAbi,
  doorbell: doorbellAbi,
  rules: rulesAbi,
  endowments: endowmentsAbi,
  zap: zapAbi,
};

/** An enum's name, or null for a code the shared table does not know. */
function named<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** The addresses in an ABI-encoded `address[]`, lowercase; null when the bytes are not one. */
export function addressList(encoded: Hex): string[] | null {
  const hex = encoded.slice(2);
  if (hex.length < 128 || hex.length % 64 !== 0) return null;
  const word = (index: number) => hex.slice(index * 64, index * 64 + 64);
  if (BigInt(`0x${word(0)}`) !== 32n) return null;
  const length = Number(BigInt(`0x${word(1)}`));
  if (length > 64 || hex.length !== (2 + length) * 64) return null;
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    const w = word(2 + i);
    if (!/^0{24}/.test(w)) return null;
    out.push(`0x${w.slice(24)}`);
  }
  return out;
}
