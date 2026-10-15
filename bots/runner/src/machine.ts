/**
 * The order state machine: what the runner does with each order it sees, one small step at a time.
 *
 *   seen ──▶ claimed ──▶ paid ──▶ registered ──▶ delivered            (receipt proven, or)
 *     │         │          │           │
 *     │         │          │           └──▶ asserted ──▶ unproven ──▶ delivered
 *     │         │          │                (claimed, unchallenged, then stamped with the receipt)
 *     │         │          └──▶ releasing ──▶ released                 (the job blocked before it
 *     │         └──▶ releasing ──▶ released                             was registered, or could
 *     └──▶ skipped                                                      not be bought)
 *
 *   any held state ──▶ lost     the chain says, pass after pass, that the order is no longer ours
 *
 * Every step reads the chain first and believes it over the local file: the file only remembers
 * intent (which job was paid for which claim, which bytes were signed). An order this runner holds
 * on chain is taken up again from the chain alone, in whatever state it is, so a lost or replaced
 * file does not strand a bond.
 *
 * What protects the runner's money here:
 * - an order is taken only if its kind is on the allow-list, its spec is one the desk could settle,
 *   its price covers the swarm's fee, a margin and an allowance for failures, and its bond is
 *   within the limits (per order, and over all orders held);
 * - an order that only a receipt can pay is taken only while the WorkRegistry is writing receipts
 *   (its newest `WorkRecorded` event is recent), unless the operator chose to wait for them:
 *   IdentityMD's receipt writer has been behind since 8 Oct 2026, and such an order would put the
 *   bond at risk of the delivery deadline;
 * - an order whose kind has only been seen with records too large for this runner's gas limit is
 *   taken only if it allows the bonded claim, and no settlement is sent with a gas limit set by
 *   hand: the limit comes from an estimate and is refused above `MAX_SETTLE_GAS`;
 * - before a job is paid for, the header the desk itself reports for the claim (`headerOf`) is
 *   compared with the header this runner built: a job under any other header could never settle;
 * - before a bond is posted, the free preflight has run and the quote and its payment challenge
 *   have passed every check, so what the protocol makes of the job is known while a refusal still
 *   costs nothing;
 * - a job is registered only once it has completed or the claim window is about to end: a job that
 *   ends blocked before that is given back for a tenth of the bond instead of risking all of it;
 * - what settles an order is whatever record the registry holds for the job, read from the
 *   registry; delivery is claimed only on a record that passes locally every check the desk makes;
 * - one reading of the chain never ends an order: it takes several passes that agree, from blocks
 *   no older than the last one this runner acted on;
 * - payments are reserved against a per-order cap and a daily cap before anything is signed;
 * - after payments keep failing, the runner stops taking orders until an operator has looked;
 * - the kill switch stops every payment and every transaction;
 * - in dry-run nothing is signed or sent: the machine reads, decides, and says what it would do.
 */
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import {
  DESK,
  HEADER_LENGTH,
  JOB_TEMPLATES,
  MAINNET,
  ORDER_FLAG,
  ORDER_STATE,
  PAID_ACTION_PRICE,
  buildJobInput,
  bytes16ToUuid,
  checkSpec,
  describeSpecProblem,
  judgeRecord,
  kindHash,
  orderHeadHash,
  orderHeader,
  orderStateName,
  orderTicket,
  releaseCut,
  sameAddress,
  settleGasNeeded,
  specHash,
  splitPrice,
  templateByKindHash,
  uuidToBytes16,
  type JobTemplate,
} from "@help-wanted/shared";
import type { ChainWriteError } from "./chain.js";
import type { DeskChain, DeskOrder, DeskSnapshot } from "./desk.js";
import type { Logger } from "./log.js";
import { newPayState, type PayFlow, type PayJob, type PayOutcome } from "./pay.js";
import { addSpend, addSpendOn, spentToday, type OrderRecord, type OrderStatus, type Store } from "./store.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = `0x${"0".repeat(64)}`;
const RECOVERED = "recovered from chain";

/** The part of the IdentityMD client the machine uses. `ImdClient` satisfies it. */
export interface JobApi {
  check(action: "job.open", input: unknown): Promise<{ blockers: unknown[]; kind?: string | undefined }>;
  job(id: string): Promise<{
    id: string;
    state: string;
    template: string | null;
    objective: string;
    paidBy?: string | null | undefined;
    blockedReason?: string | null | undefined;
  }>;
  /** Newest first, as the API lists them. */
  jobRecords(id: string): Promise<{ records: { hash: string; status: string }[] }>;
  workRecord(hash: string): Promise<{ bytes: Uint8Array; recordHash: Hex }>;
  /** `GET /requests/capabilities`: the live price, token and recipient of every paid action. */
  capabilities(): Promise<{
    actions: { action: string; payment: { network: string; asset: string; amount: string; payTo: string } }[];
  }>;
  /** `GET /requests/paid-by/:address`: what a wallet paid for, newest first. Public; needs no token. */
  paidBy(payer: string): Promise<{
    orders: {
      action: string;
      createdAt: string;
      result?: { kind?: string | undefined; jobId?: string | undefined } | null | undefined;
    }[];
  }>;
}

export interface MachineConfig {
  mode: "live" | "dry-run";
  chainId: number;
  workOrders: Address;
  runner: Address | null;
  templates: ReadonlyMap<Hex, string>;
  dailyCap: bigint;
  orderCap: bigint;
  maxBond: bigint;
  maxBondsAtRisk: bigint;
  minMargin: bigint;
  failureBps: bigint;
  maxConcurrent: number;
  /** Which orders that only a receipt can pay are taken: see `RECEIPT_ONLY_MODES` in config. */
  receiptOnlyOrders: "never" | "when-receipts-flow" | "always";
  /** Receipts count as stalled when the WorkRegistry wrote none in this many blocks. */
  receiptStallBlocks: number;
  latchConditions: boolean;
  stampAfterFinalize: boolean;
  stampWatchSeconds: number;
  disputeTimeoutAfter: number;
  arbiters: ReadonlySet<string>;
  employers: ReadonlySet<string>;
  maxEmployerLosses: number;
  minOrderLifetime: number;
  maxPayFailures: number;
  maxJobsPerOrder: number;
  registerAtOnce: boolean;
  claimSettleSeconds: number;
  maxSettleRecordBytes: number;
  /** The most gas a `settle`, `stamp` or `reportFailed` is sent with. */
  maxSettleGas: bigint;
  dryRunPreflight: boolean;
  lookOnly: boolean;
  startBlock: bigint | null;
  confirmations: number;
  logChunkBlocks: bigint;
  /** The ETH the wallet must hold before a new order is claimed: gas for the steps that follow. */
  minGasBalance: bigint;
}

export interface MachineDeps {
  config: MachineConfig;
  store: Store;
  desk: DeskChain;
  api: JobApi;
  /**
   * Makes the payment flow for one order, wired to that order's cap hooks. Present in live mode
   * only: without it the machine cannot pay, and says what it would do instead.
   */
  payFlow: ((hooks: PayHooks) => PayFlow) | null;
  /** Unix seconds. */
  now: () => number;
  log: Logger;
  killed: () => boolean;
  /** What the swarm charges for a job, in atomic IMD. Read from the protocol; 0.5 IMD today. */
  jobFee?: bigint;
}

export interface PayHooks {
  reserve: (amount: bigint) => boolean;
  release: (amount: bigint, day?: string) => void;
  persist: () => void;
  /** A reason not to sign a payment right now, or null. */
  mayPay: () => Promise<string | null>;
}

/** Statuses in which the runner holds an order on chain. */
const HOLDING: readonly OrderStatus[] = ["claimed", "paid", "registered", "asserted", "releasing"];
/** Desk states in which a claim is live. */
const HELD_STATES: readonly number[] = [
  ORDER_STATE.Claimed,
  ORDER_STATE.Registered,
  ORDER_STATE.Asserted,
  ORDER_STATE.Disputed,
];

/** How long before the end of the one-hour claim window an unpaid claim is given back. */
const CLAIM_SAFETY_SECONDS = 600;
/** How long before the end of the claim window a job that was held back is registered regardless. */
const REGISTER_SAFETY_SECONDS = 900;
/** `release` reverts once the claim window is over; it is not tried this close to its end. */
const RELEASE_MARGIN_SECONDS = 120;
/** A quote must have this long left when the claim goes out, or it is asked for again first. */
const QUOTE_LIFE_FOR_CLAIM_SECONDS = 240;
/** Kept in hand before the desk's own `TooLate` on a delivery claim. */
const CLAIM_DEADLINE_MARGIN_SECONDS = 300;
/** A second job is bought only if at least this much of the delivery time would be left for it. */
const RETRY_MIN_SECONDS = 6 * 3600;
/** An order is given up only after this many passes in a row, over at least this long, say so. */
const LOST_CONFIRMATIONS = 3;
const LOST_MIN_SECONDS = 120;
/** For this long after an order was given up, the chain is asked again whether it is ours after all. */
const LOST_RECHECK_SECONDS = 7 * 86_400;
/** The most log chunks read in one tick, so a long backlog cannot starve the orders in hand. */
const MAX_CHUNKS_PER_TICK = 20;
/** Where a first run starts reading logs when no start block is configured (dry runs only). */
const DEFAULT_LOOKBACK_BLOCKS = 5_000n;
/** The most orders the runner is not holding that are looked at in one pass. */
const CANDIDATES_PER_TICK = 25;
/**
 * An order that does not qualify is looked at again on the next pass, then less and less often,
 * up to this.
 */
const MAX_BACKOFF_SECONDS = 1_800;
const FIRST_BACKOFF_SECONDS = 60;
/**
 * A payment that went out with no job id learned is given up, and the claim given back, this long
 * before the claim window ends.
 */
const PENDING_RELEASE_SECONDS = 300;
/** After this many unreadable status answers the job is looked for through the public route. */
const STATUS_FALLBACK_AFTER = 3;
/** The most jobs read when looking for one this wallet already paid for. */
const PAID_LOOKUPS = 8;
/** How long a reading of the protocol's payment terms is trusted. */
const TERMS_TTL_SECONDS = 600;
/** Failed log reads in a row after which it is said at error. */
const DISCOVERY_ERROR_AFTER = 5;
/** How long a reading of whether the registry is writing receipts is trusted. */
const RECEIPTS_TTL_SECONDS = 600;
/** A settlement this close to the delivery deadline may pay the higher gas limits: its delay costs the bond. */
const SETTLE_URGENT_SECONDS = 6 * 3600;
/** How often an order that was paid out unproven is looked at for its receipt. */
const UNPROVEN_LOOK_SECONDS = 600;

/** A kind as work records spell it: a template name, `skill:<id>` or `shape:<shape>`. */
const RECORD_KIND =
  /^(?:skill:.+|shape:.+|single|impl_tests|impl_tests_review|multi_contract|fuzz|research|audit)$/;

interface Verdict {
  reason: string;
  permanent: boolean;
  /**
   * Set when the order is one to take but for its price, and its price cannot rise until its
   * condition, which holds now, has been latched on the desk (`trigger`).
   */
  latch?: boolean;
}

/** What a work record means for the order, by the desk's own tests (`judgeRecord` in the shared package). */
type RecordVerdict = ReturnType<typeof judgeRecord>;

/** A reading from a node that is behind what this runner already acted on. */
class StaleReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleReadError";
  }
}

function isChainWriteError(error: unknown): error is ChainWriteError {
  return error instanceof Error && error.name === "ChainWriteError";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Machine {
  readonly #d: MachineDeps;
  /** What the swarm charges for a job. Replaced by the live figure before any order is claimed. */
  #fee: bigint;
  /** Why no new order may be claimed, when the protocol's payment terms are not the expected ones. */
  #termsProblem: string | null = null;
  #termsReadAt: number | null = null;
  /** Orders whose dry-run plan has been printed. */
  readonly #planned = new Set<string>();
  /** The last reading of whether the WorkRegistry is writing receipts. */
  #receipts: { at: number; flowing: boolean; detail: string } | null = null;

  constructor(deps: MachineDeps) {
    this.#d = deps;
    this.#fee = deps.jobFee ?? PAID_ACTION_PRICE;
  }

  /**
   * Reads what `job.open` costs now, and where the money goes. A claim costs a bond, and giving an
   * order back costs a tenth of it, so the runner looks before it claims: if the protocol no longer
   * sells jobs for IMD on mainnet to the known payee, or the fee is above the per-order cap, no new
   * order is taken.
   */
  async #refreshTerms(): Promise<void> {
    const { api, config, now, log } = this.#d;
    if (this.#termsReadAt !== null && now() - this.#termsReadAt < TERMS_TTL_SECONDS) return;
    let problem: string | null = null;
    try {
      const job = (await api.capabilities()).actions.find((a) => a.action === "job.open");
      if (job === undefined) problem = "the protocol does not list job.open";
      else if (job.payment.network !== `eip155:${config.chainId}`)
        problem = `jobs are sold on ${job.payment.network}`;
      else if (!sameAddress(job.payment.asset, MAINNET.IMD))
        problem = `jobs are priced in ${job.payment.asset}`;
      else if (!sameAddress(job.payment.payTo, MAINNET.FEE_PAYEE))
        problem = `the fee goes to ${job.payment.payTo}`;
      else if (BigInt(job.payment.amount) > config.orderCap) {
        problem = `a job costs ${job.payment.amount}, above the per-order cap of ${config.orderCap}`;
      } else this.#fee = BigInt(job.payment.amount);
    } catch (error) {
      problem = `the payment terms could not be read: ${messageOf(error)}`;
    }
    if (problem !== null && problem !== this.#termsProblem)
      log.error("not taking new orders", { reason: problem });
    this.#termsProblem = problem;
    this.#termsReadAt = problem === null ? now() : null;
  }

  /**
   * Whether IdentityMD's WorkRegistry is writing receipts: whether it wrote one in the last
   * `receiptStallBlocks` blocks. An order that only a receipt can pay is worth a bond only while
   * it is. A registry that cannot be read counts as stalled: the question decides money, and no
   * answer is not a yes.
   */
  async receiptsFlow(): Promise<{ flowing: boolean; detail: string }> {
    const { desk, config, now, log } = this.#d;
    if (this.#receipts !== null && now() - this.#receipts.at < RECEIPTS_TTL_SECONDS) return this.#receipts;
    let flowing = false;
    let detail: string;
    try {
      const block = await desk.lastReceiptBlock(BigInt(config.receiptStallBlocks));
      flowing = block !== null;
      detail = flowing
        ? `the WorkRegistry last wrote a receipt in block ${block}`
        : `the WorkRegistry has written no receipt in the last ${config.receiptStallBlocks} blocks`;
    } catch (error) {
      detail = `the WorkRegistry's receipts could not be read (${messageOf(error).slice(0, 120)})`;
    }
    if (this.#receipts === null || this.#receipts.flowing !== flowing) {
      log.info(flowing ? "receipts are being written" : "receipts are stalled", { detail });
    }
    this.#receipts = { at: now(), flowing, detail };
    return this.#receipts;
  }

  #records(): OrderRecord[] {
    return Object.values(this.#d.store.data.orders).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  #holding(): OrderRecord[] {
    return this.#records().filter((r) => HOLDING.includes(r.status));
  }

  /** Saves now. For the points a crash must not lose: a claim, a job id, a delivery claim. */
  #touch(rec: OrderRecord): void {
    rec.updatedAt = this.#d.now();
    this.#d.store.save();
  }

  #setStatus(rec: OrderRecord, status: OrderStatus): void {
    if (rec.status !== status) delete rec.said;
    rec.status = status;
  }

  #finish(rec: OrderRecord, status: OrderStatus, outcome: string): void {
    this.#setStatus(rec, status);
    rec.outcome = outcome;
    delete rec.lastError;
    delete rec.suspect;
    delete rec.mine;
    if (status === "lost") rec.lostAt = this.#d.now();
    this.#d.log.info("order finished", { order: rec.id, status, outcome });
    this.#touch(rec);
  }

  /** Says a thing about an order once while it stays in its present status, not on every pass. */
  #say(
    rec: OrderRecord,
    level: "info" | "warn" | "error",
    msg: string,
    fields: Record<string, unknown> = {},
  ): void {
    const detail = JSON.stringify(fields, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    const key = `${level}:${msg}:${detail}`.slice(0, 300);
    const said = rec.said ?? [];
    if (said.includes(key)) return;
    // Bounded: an order in one status has only so many different things to say.
    rec.said = [...said, key].slice(-12);
    this.#d.log[level](msg, { order: rec.id, ...fields });
  }

  /**
   * What decides which orders this runner takes, as one string. An order is skipped for good on
   * the settings of the day it was looked at; when those settings change (a kind is added to the
   * allow-list, an employer or an arbiter is listed, a limit is raised), the orders that were
   * skipped deserve another look.
   */
  #policy(): string {
    const { config } = this.#d;
    return JSON.stringify([
      [...config.templates.values()].sort(),
      [...config.employers].map((e) => e.toLowerCase()).sort(),
      [...config.arbiters].map((a) => a.toLowerCase()).sort(),
      config.maxBond.toString(),
      config.receiptOnlyOrders,
      config.minOrderLifetime,
      config.maxSettleGas.toString(),
      config.maxEmployerLosses,
    ]);
  }

  /**
   * Looks again at the orders skipped under other settings. A skipped order no longer carries its
   * text, so it is dropped and the desk's logs are read again from the start block: an order that
   * is still open comes back with its text and is judged afresh. Orders in hand are not touched.
   */
  #lookAgainAfterPolicyChange(): void {
    const { store, log, config } = this.#d;
    const policy = this.#policy();
    if (store.data.policy === policy) return;
    const first = store.data.policy === undefined;
    store.data.policy = policy;
    if (!first) {
      let dropped = 0;
      for (const [id, rec] of Object.entries(store.data.orders)) {
        if (rec.status !== "skipped") continue;
        delete store.data.orders[id];
        dropped++;
      }
      if (dropped > 0) {
        store.data.cursor = null;
        log.info(
          "the settings that decide which orders are taken have changed; looking at skipped orders again",
          {
            orders: dropped,
            from: config.startBlock?.toString() ?? "the default lookback",
          },
        );
      }
    }
    store.save();
  }

  /** One pass: read new orders, then take each order in hand, and some of the others, one step further. */
  async tick(): Promise<void> {
    const { log, killed, now } = this.#d;
    if (killed()) {
      log.warn("kill switch is on: reading only, no payments and no transactions");
    }
    this.#lookAgainAfterPolicyChange();
    await this.#discoverSafely();

    const all = this.#records();
    const held = all.filter((r) => HOLDING.includes(r.status));
    // An order given up is asked about again for a while: giving up is the one decision here that
    // costs a bond if it was wrong.
    const lost = all.filter(
      (r) => r.status === "lost" && r.lostAt !== undefined && now() - r.lostAt < LOST_RECHECK_SECONDS,
    );
    const mine = all.filter((r) => r.status === "seen" && r.mine === true);
    // Paid out and not yet proven: nothing is at stake, so these are looked at now and then.
    const unproven = all.filter((r) => r.status === "unproven" && (r.nextLookAt ?? 0) <= now());
    // The orders in hand are looked at on every pass. The rest share a budget and back off, so
    // that a flood of orders the runner will never take cannot slow down the ones it holds.
    const candidates = all
      .filter((r) => r.status === "seen" && r.mine !== true && (r.nextLookAt ?? 0) <= now())
      .slice(0, CANDIDATES_PER_TICK);
    for (const rec of [...held, ...lost, ...mine, ...unproven, ...candidates]) await this.#guarded(rec);
  }

  /** Takes one step for an order, records a failure on it, and saves only if something changed. */
  async #guarded(rec: OrderRecord): Promise<void> {
    const { log, store, now } = this.#d;
    const before = JSON.stringify(rec);
    // Whatever went wrong last time is said again if it goes wrong again, and gone if it does not.
    delete rec.lastError;
    try {
      await this.step(rec);
    } catch (error) {
      const message = messageOf(error);
      rec.lastError = message.slice(0, 300);
      // A fee above the cap, a transaction still waiting, a node that is behind, or the kill
      // switch: reasons to wait, not faults.
      const calm =
        error instanceof StaleReadError ||
        (isChainWriteError(error) &&
          (error.code === "fee_too_high" || error.code === "killed" || error.code === "pending"));
      (calm ? log.warn : log.error)("step did not complete", {
        order: rec.id,
        status: rec.status,
        error: message,
      });
    }
    if (JSON.stringify(rec) !== before) {
      rec.updatedAt = now();
      store.save();
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Discover
  // -----------------------------------------------------------------------------------------------

  /**
   * Reads new orders, and does not let a refusing node keep the runner from the orders it holds.
   * A node may refuse a range for its size, so a refused read is tried once more in small pieces.
   * If that fails too it is counted, and said louder the longer it lasts: a runner that reads no
   * logs takes no new orders and, after a lost store, does not find the ones it holds.
   */
  async #discoverSafely(): Promise<void> {
    const { log, store, config } = this.#d;
    try {
      try {
        await this.discover();
      } catch {
        const small = config.logChunkBlocks / 8n;
        await this.discover(small > 0n ? small : 1n);
      }
      if ((store.data.discoveryFailures ?? 0) > 0) {
        delete store.data.discoveryFailures;
        store.save();
      }
    } catch (error) {
      const failures = (store.data.discoveryFailures ?? 0) + 1;
      store.data.discoveryFailures = failures;
      store.save();
      const fields = {
        error,
        passes: failures,
        stuckAfterBlock: store.data.cursor,
        hint: "public nodes serve logs only for recent blocks; a keyed RPC_URL reads the whole history",
      };
      if (failures >= DISCOVERY_ERROR_AFTER)
        log.error("new orders have not been read for several passes", fields);
      else log.warn("could not read new orders this pass", fields);
    }
  }

  /**
   * Reads the desk's logs from where the last pass stopped, a bounded number of chunks at a time:
   * `OrderOpened` for every order, and `Claimed` for the orders this runner took, which are then
   * looked at first. Returns how many orders were new.
   */
  async discover(chunkBlocks: bigint = this.#d.config.logChunkBlocks): Promise<number> {
    const { desk, store, config, log, now } = this.#d;
    const head = (await desk.blockNumber()) - BigInt(config.confirmations);
    let from: bigint;
    if (store.data.cursor !== null) from = BigInt(store.data.cursor) + 1n;
    else if (config.startBlock !== null) from = config.startBlock;
    else from = head > DEFAULT_LOOKBACK_BLOCKS ? head - DEFAULT_LOOKBACK_BLOCKS : 0n;

    let found = 0;
    for (let chunk = 0; chunk < MAX_CHUNKS_PER_TICK && from <= head; chunk++) {
      const to = from + chunkBlocks - 1n < head ? from + chunkBlocks - 1n : head;
      const opened = await desk.ordersOpened(from, to);
      const claimed = config.runner === null ? [] : await desk.claimedBy(config.runner, from, to);
      for (const order of opened) {
        const id = order.id.toString();
        if (store.data.orders[id] !== undefined) continue;
        store.data.orders[id] = {
          id,
          status: "seen",
          employer: order.employer,
          kindHash: order.kindHash,
          specHash: order.specHash,
          spec: order.spec,
          openedBlock: order.block.toString(),
          expiresAt: order.expiresAt,
          spent: "0",
          updatedAt: now(),
        };
        found++;
        log.info("order seen", { order: id, employer: order.employer, kindHash: order.kindHash });
      }
      for (const claimedId of claimed) {
        const id = claimedId.toString();
        let rec = store.data.orders[id];
        if (rec === undefined) {
          // Claimed by this runner, and opened before the logs this store has read. What the chain
          // says about it is enough to finish it; only its text is missing.
          const { order, block } = await desk.snapshot(claimedId);
          rec = {
            id,
            status: "seen",
            employer: order.employer,
            kindHash: order.kindHash,
            specHash: order.specHash,
            spec: "",
            openedBlock: block.toString(),
            expiresAt: order.expiresAt,
            spent: "0",
            updatedAt: now(),
          };
          store.data.orders[id] = rec;
          found++;
        }
        if (rec.status === "seen") rec.mine = true;
      }
      store.data.cursor = to.toString();
      store.save();
      from = to + 1n;
    }
    return found;
  }

  // -----------------------------------------------------------------------------------------------
  // Decide
  // -----------------------------------------------------------------------------------------------

  #template(rec: OrderRecord): JobTemplate | undefined {
    const kind = this.#d.config.templates.get(rec.kindHash.toLowerCase() as Hex);
    return kind === undefined ? undefined : JOB_TEMPLATES[kind];
  }

  /** The objective this runner's claim `seq` of the order carries, and the job input for it. */
  #job(rec: OrderRecord, seq: number, template: JobTemplate): PayJob | Verdict {
    const { config } = this.#d;
    if (config.runner === null) return { reason: "no runner address is configured", permanent: false };
    if (rec.spec === "") return { reason: "the order's text is not known to this runner", permanent: true };
    const claim = {
      chainId: config.chainId,
      workOrders: config.workOrders,
      orderId: BigInt(rec.id),
      claimSeq: seq,
      runner: config.runner,
    };
    const header = orderHeader(orderTicket(claim));
    const objective = header + rec.spec;
    const built = buildJobInput(template, objective, rec.spec);
    if (!built.ok) return { reason: `cannot build the job: ${built.reason}`, permanent: true };
    return { claim, header, objective, input: built.input };
  }

  /** What the runner needs an order to pay it: the fee, the margin, and an allowance for failures. */
  #needed(bond: bigint): bigint {
    const { config } = this.#d;
    return this.#fee + config.minMargin + ((bond + this.#fee) * config.failureBps) / 10_000n;
  }

  /** The bonds this runner has posted on the orders it holds, in atomic IMD. */
  bondsAtRisk(): bigint {
    return this.#holding().reduce((sum, r) => sum + BigInt(r.claim?.bond ?? "0"), 0n);
  }

  /** Why no new order is being claimed, when payments have kept failing. */
  #breakerReason(): string | null {
    const breaker = this.#d.store.data.breaker;
    if (breaker === undefined || breaker.trippedAt === null) return null;
    return (
      `${breaker.failures} payments in a row ended without a usable job after a bond was posted` +
      `${breaker.reason ? ` (last: ${breaker.reason})` : ""}; run the resume command once the cause is understood`
    );
  }

  /** Counts a payment that ended without a usable job after a claim, or clears the count. */
  #breaker(failed: boolean, reason?: string): void {
    const { store, config, now, log } = this.#d;
    if (!failed) {
      if (store.data.breaker !== undefined && store.data.breaker.trippedAt === null)
        delete store.data.breaker;
      return;
    }
    const failures = (store.data.breaker?.failures ?? 0) + 1;
    const tripped = failures >= config.maxPayFailures;
    store.data.breaker = {
      failures,
      trippedAt: tripped ? (store.data.breaker?.trippedAt ?? now()) : null,
      ...(reason === undefined ? {} : { reason: reason.slice(0, 200) }),
    };
    if (tripped) {
      log.error("stopped taking new orders: payments keep ending without a usable job", {
        failures,
        last: reason,
        resume: "run the resume command once the cause is understood",
      });
    }
  }

  /**
   * An operator's decision, made with the `resume` command. It clears the breaker if it is set,
   * and has every order that was put off looked at again on the next pass instead of after its
   * back-off (after a fix, say, to whatever kept the runner from taking it). Returns whether the
   * breaker was set.
   */
  resume(): boolean {
    const { store } = this.#d;
    const tripped = store.data.breaker !== undefined;
    delete store.data.breaker;
    for (const rec of this.#records()) {
      if (rec.status !== "seen") continue;
      delete rec.nextLookAt;
      delete rec.looks;
    }
    store.save();
    return tripped;
  }

  /**
   * Whether this order is one to take now. `permanent` verdicts end the order for this runner; the
   * others are looked at again later (a price ramps up, a condition comes true).
   */
  async evaluate(rec: OrderRecord, order: DeskOrder): Promise<Verdict | null> {
    const { config, desk, store, now } = this.#d;
    const id = BigInt(rec.id);
    const no = (reason: string): Verdict => ({ reason, permanent: true });
    const later = (reason: string): Verdict => ({ reason, permanent: false });

    if (order.state !== ORDER_STATE.Open) {
      const name = orderStateName(order.state);
      return order.state >= ORDER_STATE.Delivered
        ? no(`the order is ${name}`)
        : later(`the order is ${name}`);
    }
    if (
      order.kindHash.toLowerCase() !== rec.kindHash.toLowerCase() ||
      order.specHash.toLowerCase() !== rec.specHash.toLowerCase()
    ) {
      return no("the order on chain does not match the event that announced it");
    }
    // The desk pins the hash of a kind and cannot know whether the swarm writes it. The shared
    // table (`JOB_TEMPLATES`) lists the kinds a real work record has been seen to carry and that
    // a job body is known for. A hash that is not in it is a kind the swarm does not write, or
    // one no job this runner could buy would yield: either way no record would settle the order.
    const known = templateByKindHash(rec.kindHash as Hex);
    if (known === undefined) {
      return no(
        "its kind is not in the shared table of kinds the swarm is known to write and a runner can open: no job this runner could buy would settle it",
      );
    }
    if (!known.kindVerified) {
      return no(`no real work record of kind ${known.kind} has been seen: no record is known to settle it`);
    }
    const template = this.#template(rec);
    if (template === undefined) return no(`its kind (${known.kind}) is not on this runner's allow-list`);
    if (rec.spec === "") return no("the order's text is not known to this runner");
    const spec = checkSpec(rec.spec);
    if (!spec.ok) return no(`its spec is not one the desk accepts: ${describeSpecProblem(spec.problem)}`);
    if (specHash(rec.spec).toLowerCase() !== order.specHash.toLowerCase())
      return no("the spec text does not hash to the order's specHash");
    if (config.runner === null) return later("no runner address is configured");
    if (order.runnerOnly !== ZERO_ADDRESS && !sameAddress(order.runnerOnly, config.runner)) {
      return no("the order is reserved for another runner");
    }
    if (config.employers.size > 0 && ![...config.employers].some((e) => sameAddress(e, order.employer))) {
      return no(`its employer ${order.employer} is not on this runner's list`);
    }
    const losses = store.data.employerLosses?.[order.employer.toLowerCase()] ?? 0;
    if (losses >= config.maxEmployerLosses) {
      return no(`orders of its employer ${order.employer} have cost this runner a bond ${losses} time(s)`);
    }
    if (order.arbiter !== ZERO_ADDRESS && ![...config.arbiters].some((a) => sameAddress(a, order.arbiter))) {
      return no(`its arbiter ${order.arbiter} is not one this runner accepts`);
    }
    const allowsClaim = (order.flags & ORDER_FLAG.ALLOW_CLAIMED) !== 0;
    if (!allowsClaim) {
      if (config.receiptOnlyOrders === "never") {
        return no(
          "it can only be settled by a receipt, and this runner takes only orders that allow a bonded claim",
        );
      }
      // Without the claimed path the record itself has to travel in a `settle`, within this
      // runner's gas limit. The largest record of the kind seen so far is what it is judged by.
      const gas = settleGasNeeded(template.largestRecordSeen);
      if (template.largeRecords || gas > config.maxSettleGas) {
        return no(
          `records of kind ${template.kind} have run to ${template.largestRecordSeen} bytes, which takes about ${gas} gas to settle against this runner's limit of ${config.maxSettleGas}, and the order allows no bonded claim`,
        );
      }
    }
    if (order.bond > config.maxBond) return no(`its bond of ${order.bond} is above this runner's limit`);
    if (order.expiresAt - now() < config.minOrderLifetime) return no("it expires too soon");
    if (await desk.barred(id, config.runner)) return no("this runner released the order before");

    const job = this.#job(rec, order.seq + 1, template);
    if ("reason" in job) return job;

    // A conditional order can be taken once its condition has been seen true. A claim latches a
    // condition that holds now, so no separate call is needed for that; but until it is latched
    // the price stands at the start of its ramp.
    let unlatched = false;
    if (order.condTarget !== ZERO_ADDRESS && !order.condMet) {
      const condition = await desk.condition(id);
      if (!condition.holdsNow) return later("its condition does not hold yet");
      unlatched = true;
    }
    const price = await desk.priceNow(id);
    const pay = splitPrice(price).runnerPay;
    const needed = this.#needed(order.bond);
    if (pay < needed) {
      const atTop = splitPrice(order.maxPay).runnerPay;
      if (unlatched && atTop >= needed) {
        return {
          reason: `its condition holds, but it pays the runner ${pay} until the condition is latched and the price has risen to ${needed}`,
          permanent: false,
          latch: true,
        };
      }
      return later(
        `it pays the runner ${pay}, less than ${needed}: the swarm's fee of ${this.#fee}, the margin of ${config.minMargin} and the allowance for failures${atTop < needed ? ` (and its top price would pay ${atTop})` : ""}`,
      );
    }
    // Asked last of the reasons that can change, because it reads the chain: an order that only a
    // receipt can pay is worth a bond only while receipts are being written.
    if (!allowsClaim && config.receiptOnlyOrders === "when-receipts-flow") {
      const receipts = await this.receiptsFlow();
      if (!receipts.flowing) {
        return later(
          `it can only be settled by a receipt, and ${receipts.detail}: its bond would be forfeited at the delivery deadline (set RECEIPT_ONLY_ORDERS=always to take such orders and wait)`,
        );
      }
    }
    if (BigInt(rec.spent) + this.#fee > config.orderCap) return no("the per-order spending cap is used up");
    if (spentToday(store, now()) + this.#fee > config.dailyCap)
      return later("today's spending cap is used up");
    const breaker = this.#breakerReason();
    if (breaker !== null) return later(breaker);
    if (this.#holding().length >= config.maxConcurrent)
      return later("the runner already holds as many orders as it may");
    if (this.bondsAtRisk() + order.bond > config.maxBondsAtRisk) {
      return later("its bond would take the bonds this runner has posted above the limit");
    }
    return null;
  }

  // -----------------------------------------------------------------------------------------------
  // Step
  // -----------------------------------------------------------------------------------------------

  async step(rec: OrderRecord): Promise<void> {
    switch (rec.status) {
      case "seen":
        return this.#considerAndClaim(rec);
      case "claimed":
        return this.#pay(rec);
      case "releasing":
        return this.#release(rec);
      case "paid":
        return this.#register(rec);
      case "registered":
        return this.#watch(rec);
      case "asserted":
        return this.#afterAssert(rec);
      case "unproven":
        return this.#stampWhenProven(rec);
      case "lost":
        return this.#recheckLost(rec);
      default:
        return;
    }
  }

  #ours(snap: DeskSnapshot): boolean {
    const { config } = this.#d;
    return (
      config.runner !== null &&
      HELD_STATES.includes(snap.order.state) &&
      sameAddress(snap.claim.runner, config.runner)
    );
  }

  /** Puts off the next look at an order that does not qualify, a little longer each time. */
  #later(rec: OrderRecord): void {
    const looks = (rec.looks ?? 0) + 1;
    rec.looks = looks;
    const wait =
      looks === 1 ? 0 : Math.min(MAX_BACKOFF_SECONDS, FIRST_BACKOFF_SECONDS * 2 ** Math.min(looks - 2, 10));
    rec.nextLookAt = this.#d.now() + wait;
  }

  #skip(rec: OrderRecord, verdict: Verdict, level: "info" | "warn" = "info"): void {
    if (rec.skip?.reason !== verdict.reason) {
      this.#d.log[level]("order not taken", {
        order: rec.id,
        reason: verdict.reason,
        permanent: verdict.permanent,
      });
    }
    rec.skip = { reason: verdict.reason, permanent: verdict.permanent };
    if (verdict.permanent) {
      this.#setStatus(rec, "skipped");
      // Never needed again, and the bulk of what an order takes in the file.
      rec.spec = "";
      delete rec.pay;
      delete rec.mine;
      delete rec.nextLookAt;
      delete rec.looks;
    } else {
      this.#later(rec);
    }
  }

  /**
   * Rebuilds what the runner knows of an order it holds from what the chain says: the claim, and
   * past it the job id, the times and the hash it named. This is what lets a runner with an empty
   * or replaced store finish the orders it has a bond on.
   */
  #recover(rec: OrderRecord, snap: DeskSnapshot, how: string): void {
    const { config, log } = this.#d;
    const { order, claim, block } = snap;
    const runner = config.runner as Address;
    const ticket = orderTicket({
      chainId: config.chainId,
      workOrders: config.workOrders,
      orderId: BigInt(rec.id),
      claimSeq: order.seq,
      runner,
    });
    const sameClaim = rec.claim?.seq === order.seq;
    rec.claim = {
      seq: order.seq,
      ticket,
      price: claim.price.toString(),
      bond: order.bond.toString(),
      claimedAt: claim.claimedAt,
      tx: sameClaim && rec.claim !== undefined ? rec.claim.tx : RECOVERED,
    };
    rec.kindHash = order.kindHash.toLowerCase();
    rec.specHash = order.specHash.toLowerCase();
    rec.expiresAt = order.expiresAt;
    rec.lastBlock = block.toString();
    delete rec.skip;
    delete rec.suspect;
    delete rec.lostAt;
    delete rec.mine;
    delete rec.nextLookAt;
    delete rec.looks;
    delete rec.outcome;
    // A payment saved for another claim of this order is not this claim's.
    const objective = rec.spec === "" ? null : orderHeader(ticket) + rec.spec;
    if (rec.pay !== undefined && rec.pay.objective !== objective) delete rec.pay;
    if (rec.retry !== undefined && rec.retry.objective !== objective) delete rec.retry;
    if (!sameClaim) {
      delete rec.jobId;
      delete rec.pastJobs;
      delete rec.recordSeen;
    }

    if (order.state === ORDER_STATE.Claimed) {
      if (rec.jobId === undefined && rec.pay?.stage === "admitted") rec.jobId = rec.pay.jobId;
      this.#setStatus(rec, rec.jobId === undefined ? "claimed" : "paid");
    } else {
      rec.jobId = bytes16ToUuid(claim.jobId);
      rec.registeredAt = claim.registeredAt;
      if (order.state === ORDER_STATE.Registered) this.#setStatus(rec, "registered");
      else {
        rec.assertedAt = claim.assertedAt;
        rec.recordHash = claim.recordHash.toLowerCase();
        this.#setStatus(rec, "asserted");
      }
    }
    log.warn("took up an order this runner holds on chain", {
      order: rec.id,
      state: orderStateName(order.state),
      seq: order.seq,
      how,
    });
    this.#touch(rec);
  }

  async #considerAndClaim(rec: OrderRecord): Promise<void> {
    const { desk, config, log, api, killed, now } = this.#d;
    const id = BigInt(rec.id);
    const snap = await desk.snapshot(id);
    const { order } = snap;
    rec.expiresAt = order.expiresAt;

    // An order of ours that the file does not know about: a transaction was mined and the process
    // stopped before it could write that down, or the file was lost. Take it up again in whatever
    // state it is, or the bond is lost to the clock.
    if (this.#ours(snap)) {
      this.#recover(rec, snap, "the store did not know it");
      return;
    }
    if (rec.mine === true) delete rec.mine;

    const verdict = await this.evaluate(rec, order);
    if (verdict !== null) {
      if (verdict.latch === true) await this.#latch(rec);
      this.#skip(rec, verdict);
      return;
    }
    const waitedFor = rec.skip?.reason;
    delete rec.skip;
    const template = this.#template(rec) as JobTemplate;
    const job = this.#job(rec, order.seq + 1, template) as PayJob;
    const price = await desk.priceNow(id);

    if (config.mode === "dry-run" || this.#d.payFlow === null) {
      // Said once per run, not once per pass.
      if (this.#planned.has(rec.id)) return;
      this.#planned.add(rec.id);
      // A dry run makes no POST, the free preflight included, unless it was asked to.
      let preflight: unknown = "not asked (set DRY_RUN_PREFLIGHT=1 to ask the free preflight in a dry run)";
      if (config.dryRunPreflight) {
        try {
          const check = await api.check("job.open", job.input);
          preflight = { blockers: check.blockers, kind: check.kind ?? null };
        } catch (error) {
          preflight = `could not be asked: ${messageOf(error)}`;
        }
      }
      log.info("dry run: would take this order", {
        order: rec.id,
        steps: [
          `preflight POST /requests/check for a ${template.kind} job (free)`,
          "quote the job and read its payment challenge; go on only if both pass every check",
          `claim(${rec.id}), posting a bond of ${order.bond}`,
          `pay the swarm ${this.#fee} for job.open with the objective below`,
          `register(${rec.id}, jobId) once the job has completed, or before the claim window ends`,
          "settle with the receipt, or claimDelivered and finalize when the order allows it",
        ],
        preflight,
        price: price.toString(),
        runnerPay: splitPrice(price).runnerPay.toString(),
        objective: job.objective,
      });
      this.#later(rec);
      return;
    }
    if (killed()) return;

    await this.#refreshTerms();
    if (this.#termsProblem !== null) {
      rec.skip = { reason: this.#termsProblem, permanent: false };
      this.#later(rec);
      return;
    }
    // The fee may have changed since the order was looked at.
    if (splitPrice(price).runnerPay < this.#needed(order.bond)) {
      rec.skip = {
        reason: "its price no longer covers the swarm's fee, the margin and the allowance for failures",
        permanent: false,
      };
      this.#later(rec);
      return;
    }

    // The wallet must be able to finish what it starts: gas for the steps after the claim, IMD for
    // the bond and the fee, and Permit2's allowance for the fee. Fees of orders already claimed and
    // not yet paid for are owed too. A claim that cannot be followed through costs bond.
    const runner = config.runner as Address;
    const [eth, balance, permit2] = await Promise.all([
      desk.ethBalance(runner),
      desk.imdBalance(runner),
      desk.imdAllowance(runner, MAINNET.PERMIT2),
    ]);
    const owed = BigInt(this.#records().filter((r) => r.status === "claimed").length) * this.#fee;
    let shortOf: string | null = null;
    if (eth < config.minGasBalance)
      shortOf = `the wallet holds ${eth} wei of ETH, less than the ${config.minGasBalance} kept for gas`;
    else if (balance < order.bond + this.#fee + owed)
      shortOf = `the wallet holds ${balance} IMD wei, less than the bond plus the fee${owed > 0n ? ` plus the ${owed} owed for orders already claimed` : ""}`;
    else if (permit2 < this.#fee + owed)
      shortOf = `Permit2 is approved for ${permit2}, less than the fee${owed > 0n ? ` plus the ${owed} owed for orders already claimed` : ""}: run the bootstrap command`;
    if (shortOf !== null) {
      if (waitedFor !== shortOf) log.warn("order not taken", { order: rec.id, reason: shortOf });
      rec.skip = { reason: shortOf, permanent: false };
      this.#later(rec);
      return;
    }

    // The free preflight, with the exact objective the job would have if this claim is the next one.
    if (rec.preflightedAt === undefined || now() - rec.preflightedAt > 900) {
      const check = await api.check("job.open", job.input);
      if (check.blockers.length > 0) {
        log.warn("preflight refused", { order: rec.id, blockers: check.blockers });
        this.#skip(rec, {
          reason: `the protocol's preflight names blockers: ${JSON.stringify(check.blockers).slice(0, 200)}`,
          permanent: true,
        });
        return;
      }
      if (
        typeof check.kind === "string" &&
        kindHash(check.kind).toLowerCase() !== rec.kindHash.toLowerCase()
      ) {
        if (RECORD_KIND.test(check.kind)) {
          // The desk pays only for a record of the order's kind.
          this.#skip(
            rec,
            {
              reason: `the protocol would open a job of kind "${check.kind}", not the kind the order pins`,
              permanent: true,
            },
            "warn",
          );
          return;
        }
        // Not a kind as work records spell them: the preflight is speaking of something else.
        // The live preflight answered `report` for a research-report job with our header on 11
        // October 2026, so this is the ordinary case and is said quietly.
        this.#say(rec, "info", "the preflight names a kind that is not a work-record kind; not acted on", {
          preflightKind: check.kind,
        });
      }
      rec.preflightedAt = now();
    }

    // The quote and the payment challenge, before any bond is posted. What IdentityMD makes of the
    // job is learned here, where a refusal costs nothing, and the same order is paid after the claim.
    const flow = this.#d.payFlow(this.#hooks(rec));
    if (rec.pay !== undefined && rec.pay.objective !== job.objective) delete rec.pay;
    rec.pay ??= newPayState(job);
    const pre = await flow.precheck(rec.pay, job);
    if (!pre.ok) {
      if (pre.retry) {
        // The saved state stays: it counts the quotes asked for, so that a cause which repeats
        // (a payment window as long as the quote's life, say) ends in a refusal that is reported
        // instead of in quotes without end.
        rec.skip = { reason: `the quote is not ready: ${pre.detail}`, permanent: false };
        this.#later(rec);
        return;
      }
      delete rec.pay;
      // A check failed on what the protocol answered. Nothing was staked. It is said loudly: the
      // same answer is likely for every order, and an operator should know why none is taken.
      log.error("the protocol's quote did not pass the runner's checks; order not claimed", {
        order: rec.id,
        code: pre.code,
        detail: pre.detail,
      });
      this.#skip(rec, {
        reason: `the quote did not pass the checks (${pre.code}): ${pre.detail}`.slice(0, 300),
        // What the protocol refuses for this job's own content it will refuse again; anything
        // else may be the protocol's state of the day, and is looked at again later.
        permanent: pre.code === "input_refused",
      });
      return;
    }
    if (config.lookOnly) {
      // The operator asked to see what the protocol answers and go no further. The quote was free
      // and runs out by itself; nothing was claimed and nothing was signed.
      delete rec.pay;
      this.#say(
        rec,
        "info",
        "look only: the quote and the payment challenge passed every check; not claiming",
        {
          note: "LOOK_ONLY=1 is set. Run without it to take the order",
        },
      );
      // No back-off: the next pass without LOOK_ONLY takes the order at once.
      rec.skip = { reason: "LOOK_ONLY=1: checked, not claimed", permanent: false };
      delete rec.looks;
      delete rec.nextLookAt;
      return;
    }
    if (
      rec.pay.quoteExpiresAt !== undefined &&
      rec.pay.quoteExpiresAt - now() < QUOTE_LIFE_FOR_CLAIM_SECONDS
    ) {
      // A quote under a new key next time: asking again with this one would return it unchanged.
      rec.pay = newPayState(job, rec.pay.attempt + 1);
      rec.skip = { reason: "the quote would run out during the claim; asking again", permanent: false };
      this.#later(rec);
      return;
    }
    this.#touch(rec);

    if ((await desk.imdAllowance(runner, config.workOrders)) < order.bond) {
      await desk.approveImd(config.workOrders, order.bond);
    }
    const sent = await desk.claim(id);
    if (sent.kind !== "sent") return;

    // Believe the chain, not the transaction: read back what the claim fixed.
    const after = await desk.snapshot(id);
    if (after.order.state !== ORDER_STATE.Claimed || !sameAddress(after.claim.runner, runner)) {
      rec.lastError = "the claim was mined but this reading does not show the order held by this runner";
      this.#touch(rec);
      return;
    }
    const ticket = orderTicket({
      chainId: config.chainId,
      workOrders: config.workOrders,
      orderId: id,
      claimSeq: after.order.seq,
      runner,
    });
    rec.claim = {
      seq: after.order.seq,
      ticket,
      price: after.claim.price.toString(),
      bond: after.order.bond.toString(),
      claimedAt: after.claim.claimedAt,
      tx: sent.hash,
    };
    rec.lastBlock = (sent.blockNumber > after.block ? sent.blockNumber : after.block).toString();
    // The quote was made for the claim this was expected to be. If another claim came and went in
    // between, the ticket is another one and the quote is for a job that could not settle.
    if (rec.pay.objective !== orderHeader(ticket) + rec.spec) delete rec.pay;
    this.#setStatus(rec, "claimed");
    delete rec.nextLookAt;
    delete rec.looks;
    delete rec.headerChecked;
    log.info("order claimed", {
      order: rec.id,
      seq: after.order.seq,
      price: after.claim.price.toString(),
      tx: sent.hash,
    });
    this.#touch(rec);
    // The claim fixed the price. It is the price that was read before the claim, or more: but if
    // the chain shows less than buying the job costs even after what giving the order back would
    // lose, giving it back is the cheaper way out, and nothing has been paid yet.
    const fixedPay = splitPrice(after.claim.price).runnerPay;
    if (fixedPay + releaseCut(after.order.bond) < this.#fee) {
      log.error("the claim fixed a price below the swarm's fee; giving the order back", {
        order: rec.id,
        price: after.claim.price.toString(),
        runnerPay: fixedPay.toString(),
        fee: this.#fee.toString(),
      });
      this.#toRelease(
        rec,
        `the claim fixed a price that pays the runner ${fixedPay}, less than the swarm's fee of ${this.#fee}`,
      );
    }
  }

  /**
   * Latches the condition of an order that holds now, so that its price starts to rise. The call
   * is open to anyone and moves no money; it costs this runner gas, within its ordinary limits.
   */
  async #latch(rec: OrderRecord): Promise<void> {
    const { desk, config, killed, log, payFlow } = this.#d;
    if (!config.latchConditions || config.mode === "dry-run" || payFlow === null || killed()) return;
    try {
      const sent = await desk.trigger(BigInt(rec.id));
      if (sent.kind === "sent") {
        log.info("latched the order's condition; its price now rises", { order: rec.id, tx: sent.hash });
      }
    } catch (error) {
      // Somebody else may have latched it first, or the condition stopped holding: both show on
      // the next look. A fee above the cap is a reason to wait.
      log.warn("the order's condition could not be latched on this pass", {
        order: rec.id,
        error: messageOf(error).slice(0, 200),
      });
    }
  }

  /**
   * Confirms on chain that the runner still holds the order under the claim it remembers. A reading
   * that says otherwise is not believed at once: it must come from a block no older than the last
   * one this runner acted on, and be repeated over several passes, before the order is given up.
   * Returns null when there is nothing to do for the order on this pass.
   */
  async #stillOurs(rec: OrderRecord, allowed: readonly number[]): Promise<DeskSnapshot | null> {
    const { desk, config, now, log, store } = this.#d;
    const snap = await desk.snapshot(BigInt(rec.id));
    if (rec.lastBlock !== undefined && snap.block < BigInt(rec.lastBlock)) {
      throw new StaleReadError(
        `the node answered from block ${snap.block}, behind block ${rec.lastBlock} this runner already acted on; not believing it`,
      );
    }
    const { order, claim } = snap;
    const sameClaim =
      rec.claim !== undefined && order.seq === rec.claim.seq && sameAddress(claim.runner, config.runner);
    if (order.state === ORDER_STATE.Delivered && sameClaim) {
      if (!order.proven && config.stampAfterFinalize && rec.jobId !== undefined) {
        // Paid on the claim (somebody finalized it, or the arbiter upheld it): the receipt, when
        // it lands, marks the order proven.
        this.#toUnproven(rec, "the order was paid out on chain on the delivery claim; not yet proven");
      } else {
        this.#finish(rec, "delivered", "the order was paid out on chain");
      }
      return null;
    }
    if (sameClaim && allowed.includes(order.state)) {
      delete rec.suspect;
      return snap;
    }
    if (sameClaim && HELD_STATES.includes(order.state)) {
      // Still ours, further along than the file knew (a transaction was mined before it was saved).
      this.#recover(rec, snap, "the chain is further along than the store");
      return null;
    }
    const reason = `the chain shows the order as ${orderStateName(order.state)} and not held under this runner's claim`;
    const suspect =
      rec.suspect !== undefined && rec.suspect.reason === reason
        ? { ...rec.suspect, count: rec.suspect.count + 1 }
        : { reason, count: 1, since: now() };
    rec.suspect = suspect;
    if (suspect.count < LOST_CONFIRMATIONS || now() - suspect.since < LOST_MIN_SECONDS) {
      if (suspect.count === 1)
        log.warn("a reading says the order is no longer held; looking again before believing it", {
          order: rec.id,
          reason,
        });
      return null;
    }
    // An order that was held and is not any more ended by eviction, timeout or a refuted claim:
    // the bond, or part of it, went to the employer.
    const employer = rec.employer.toLowerCase();
    store.data.employerLosses = {
      ...(store.data.employerLosses ?? {}),
      [employer]: (store.data.employerLosses?.[employer] ?? 0) + 1,
    };
    this.#finish(rec, "lost", reason);
    return null;
  }

  /** An order given up as lost is asked about again: if the chain shows it ours after all, it is taken up. */
  async #recheckLost(rec: OrderRecord): Promise<void> {
    const snap = await this.#d.desk.snapshot(BigInt(rec.id));
    if (rec.lastBlock !== undefined && snap.block < BigInt(rec.lastBlock)) return;
    if (!this.#ours(snap)) return;
    const employer = rec.employer.toLowerCase();
    const losses = this.#d.store.data.employerLosses;
    if (losses?.[employer] !== undefined && losses[employer] > 0) losses[employer] -= 1;
    this.#recover(rec, snap, "it had been given up as lost");
  }

  #payJob(rec: OrderRecord): PayJob | null {
    const template = this.#template(rec);
    if (template === undefined || rec.claim === undefined) return null;
    const job = this.#job(rec, rec.claim.seq, template);
    return "reason" in job ? null : job;
  }

  /** Whether an objective is this claim's: its header, then text that hashes to the order's spec. */
  #objectiveIsOurs(rec: OrderRecord, objective: string): boolean {
    if (rec.claim === undefined) return false;
    const header = orderHeader(rec.claim.ticket as Hex);
    return (
      objective.startsWith(header) &&
      specHash(objective.slice(HEADER_LENGTH)).toLowerCase() === rec.specHash.toLowerCase()
    );
  }

  /**
   * Looks, through the protocol's public route, for a job this wallet already paid for with this
   * claim's objective. It is how a paid job is found again when the request token or the saved
   * payment is gone, instead of being bought a second time. The objective carries the claim's
   * ticket, so a match cannot be another claim's job.
   */
  async #findPaidJob(rec: OrderRecord): Promise<string | null> {
    const { api, config } = this.#d;
    if (config.runner === null || rec.claim === undefined) return null;
    const since = (rec.claim.claimedAt - 3600) * 1000;
    const list = await api.paidBy(config.runner);
    const jobs = list.orders
      .filter((o) => o.action === "job.open" && o.result?.kind === "job" && Date.parse(o.createdAt) >= since)
      .map((o) => o.result?.jobId)
      .filter((jobId): jobId is string => jobId !== undefined && !(rec.pastJobs ?? []).includes(jobId))
      .slice(0, PAID_LOOKUPS);
    for (const jobId of jobs) {
      const job = await api.job(jobId);
      if (sameAddress(job.paidBy ?? null, config.runner) && this.#objectiveIsOurs(rec, job.objective)) {
        return jobId;
      }
    }
    return null;
  }

  #adopt(rec: OrderRecord, jobId: string, how: string): void {
    rec.jobId = jobId;
    this.#setStatus(rec, "paid");
    this.#d.log.warn("found the job this wallet already paid for; not buying another", {
      order: rec.id,
      jobId,
      how,
    });
    this.#touch(rec);
  }

  #toRelease(rec: OrderRecord, outcome: string): void {
    this.#setStatus(rec, "releasing");
    rec.outcome = outcome;
    this.#touch(rec);
  }

  /**
   * A claim for which nothing more can be done: no job that could settle it, and too late to give
   * it back. It can be removed by anyone for the whole bond. Said once, at error.
   */
  #stuck(rec: OrderRecord, what: string): void {
    rec.outcome = what;
    this.#say(rec, "error", "nothing more can be done for this claim; it can be removed for the whole bond", {
      what,
    });
  }

  async #pay(rec: OrderRecord): Promise<void> {
    const { payFlow, log, now, store, config, killed } = this.#d;
    const held = await this.#stillOurs(rec, [ORDER_STATE.Claimed]);
    if (held === null) return;
    if (payFlow === null || config.mode === "dry-run") {
      this.#say(rec, "info", "dry run: would pay for the job of a claimed order");
      return;
    }
    if (killed()) return;
    if (rec.claim === undefined) throw new Error("claimed without a claim");
    const windowEnds = held.claim.claimedAt + DESK.CLAIM_WINDOW;
    const canRelease = now() < windowEnds - RELEASE_MARGIN_SECONDS;

    // A claim taken up from the chain has no saved payment. Before one is started, ask whether a
    // job was already bought for it: the saved payment may have been lost with the store.
    const recovered = rec.claim.tx === RECOVERED;
    if (rec.pay === undefined && recovered && rec.paidLookupAt === undefined) {
      // If the question cannot be asked, this throws and it is asked again on the next pass:
      // paying without an answer could buy the job a second time.
      const found = await this.#findPaidJob(rec);
      rec.paidLookupAt = now();
      if (found !== null) return this.#adopt(rec, found, "the claim was taken up from the chain");
    }

    const job = this.#payJob(rec);
    if (job === null) {
      if (canRelease) this.#toRelease(rec, "the job for this order cannot be built");
      else this.#say(rec, "error", "the job for this claim cannot be built and the claim window is over");
      return;
    }
    // The header must be the one the desk expects for this claim, or no record could ever settle it.
    if (orderHeadHash(rec.claim.ticket as Hex) !== keccak256(stringToBytes(job.header))) {
      throw new Error("the local header does not match the claim's ticket");
    }

    rec.pay ??= newPayState(job);
    const state = rec.pay;
    const nothingSigned = state.submit === undefined && (state.stage === "new" || state.stage === "quoted");
    if (nothingSigned && now() > windowEnds - CLAIM_SAFETY_SECONDS) {
      // Too close to the end of the claim window to start paying: give the order back for a tenth
      // of the bond rather than risk being removed and losing all of it. Past the point where a
      // release is still accepted, nothing is paid either: the job could not be registered in time.
      if (canRelease) this.#toRelease(rec, "the claim window was about to end before the job was paid for");
      else {
        this.#say(
          rec,
          "error",
          "the claim window is over with no job bought; the claim can be removed for the whole bond",
          {
            windowEnds,
          },
        );
      }
      return;
    }

    if (state.stage === "failed" && !canRelease) {
      // The payment ended without a job and the order can no longer be given back. Nothing is left
      // to do for this claim; it is said once, not counted again on every pass.
      this.#stuck(rec, rec.outcome ?? `the job could not be bought (${state.failure?.code ?? "unknown"})`);
      return;
    }

    // The desk's own word on the header of this claim, read before anything is signed. The local
    // header comes from the same five values, so the two agree unless this runner is pointed at
    // another chain or desk than it believes; a job under a header the desk does not expect could
    // never settle, and its fee would be spent for nothing.
    if (nothingSigned && rec.headerChecked !== true) {
      const deskHeader = await this.#d.desk.headerOf(BigInt(rec.id));
      if (deskHeader !== job.header) {
        const what =
          "the header the desk reports for this claim is not the one this runner built; a job under it could never settle the order";
        log.error(what, { order: rec.id, desk: deskHeader, built: job.header });
        this.#breaker(true, what);
        if (canRelease) this.#toRelease(rec, what);
        else this.#stuck(rec, what);
        return;
      }
      rec.headerChecked = true;
      this.#touch(rec);
    }

    const flow = payFlow(this.#hooks(rec));
    const outcome = await flow.advance(state, job);
    store.save();
    if (outcome.kind === "admitted") {
      rec.jobId = outcome.jobId;
      this.#setStatus(rec, "paid");
      log.info("job opened", { order: rec.id, jobId: outcome.jobId });
      this.#touch(rec);
      return;
    }
    if (outcome.kind === "failed") {
      const what = `the job could not be bought (${outcome.code}); fee charged: ${outcome.charged}`;
      log.warn("payment ended without a job", {
        order: rec.id,
        code: outcome.code,
        charged: outcome.charged,
        detail: outcome.detail,
      });
      // A cap of the runner's own is not a failure of the protocol.
      if (outcome.code !== "cap_exceeded") this.#breaker(true, `${outcome.code}: ${outcome.detail ?? ""}`);
      if (canRelease) this.#toRelease(rec, what);
      else this.#stuck(rec, what);
      return;
    }
    await this.#whilePending(rec, outcome, canRelease, windowEnds);
  }

  /** A payment that is neither admitted nor over: look for the job another way, and watch the clock. */
  async #whilePending(
    rec: OrderRecord,
    outcome: Extract<PayOutcome, { kind: "pending" }>,
    canRelease: boolean,
    windowEnds: number,
  ): Promise<void> {
    const { log, now } = this.#d;
    log.debug("payment pending", { order: rec.id, why: outcome.why });
    const state = rec.pay;
    const signed = state?.submit !== undefined || state?.stage === "submitted";
    if (!signed) return;
    // The status route gives no answer. The job may well exist: ask the public route, which needs
    // no token, before the claim window runs out on a job that was paid for.
    if ((outcome.unreadable ?? 0) >= STATUS_FALLBACK_AFTER) {
      const found = await this.#findPaidJob(rec);
      if (found !== null) return this.#adopt(rec, found, "the status of the paid order could not be read");
    }
    // A payment went out and no job id has come back. Past the window the claim can be removed
    // for the whole bond; giving it back now costs a tenth. The fee may be spent either way.
    if (canRelease && now() > windowEnds - PENDING_RELEASE_SECONDS) {
      this.#toRelease(
        rec,
        "a payment was sent but no job id was learned before the claim window ended; fee charged: maybe",
      );
      return;
    }
    if (now() > windowEnds - CLAIM_SAFETY_SECONDS) {
      this.#say(
        rec,
        "error",
        "a payment is signed, no job id is known, and the claim window is about to end",
        {
          why: outcome.why,
          windowEnds,
        },
      );
    }
  }

  async #release(rec: OrderRecord): Promise<void> {
    const { desk, config, now, log } = this.#d;
    const id = BigInt(rec.id);
    const snap = await desk.snapshot(id);
    if (
      snap.order.state === ORDER_STATE.Open &&
      config.runner !== null &&
      (await desk.barred(id, config.runner))
    ) {
      // The release was mined before the store could say so.
      this.#finish(rec, "released", rec.outcome ?? "the order was given back");
      return;
    }
    const held = await this.#stillOurs(rec, [ORDER_STATE.Claimed]);
    if (held === null) return;
    if (now() >= held.claim.claimedAt + DESK.CLAIM_WINDOW) {
      // The desk no longer accepts a release. Until somebody removes the runner it can still
      // register: with a job in hand that keeps a way to the bond open (its receipt may yet land),
      // where being removed loses the bond for certain.
      if (rec.jobId !== undefined) {
        log.warn("too late to give the order back; registering its job instead", {
          order: rec.id,
          jobId: rec.jobId,
        });
        this.#setStatus(rec, "paid");
        this.#touch(rec);
        return;
      }
      this.#stuck(rec, rec.outcome ?? "the claim window ended before the order could be given back");
      return;
    }
    const sent = await desk.release(id);
    if (sent.kind !== "sent") return;
    this.#finish(rec, "released", rec.outcome ?? "the order was given back");
  }

  /**
   * Registers the job, when it is time to. A registered job can no longer be given back: from then
   * on only a record ends the claim well, and if the job ends blocked while no receipt is being
   * written, the whole bond goes to the employer at the deadline. So the job is watched first, and
   * registered once it has completed or the claim window is about to end. If it ends blocked
   * before that, the order is released for a tenth of the bond.
   */
  async #register(rec: OrderRecord): Promise<void> {
    const { desk, api, log, now, config } = this.#d;
    if (rec.jobId === undefined) throw new Error("paid without a job id");
    const held = await this.#stillOurs(rec, [ORDER_STATE.Claimed, ORDER_STATE.Registered]);
    if (held === null) return;
    const id = BigInt(rec.id);
    const wanted = uuidToBytes16(rec.jobId);
    if (held.order.state === ORDER_STATE.Registered && held.claim.jobId.toLowerCase() === wanted) {
      this.#setStatus(rec, "registered");
      rec.registeredAt = held.claim.registeredAt;
      this.#touch(rec);
      return;
    }
    if (config.mode === "dry-run") return;

    const windowEnds = held.claim.claimedAt + DESK.CLAIM_WINDOW;
    const canRelease =
      held.order.state === ORDER_STATE.Claimed && now() < windowEnds - RELEASE_MARGIN_SECONDS;
    const mustRegisterNow =
      held.order.state === ORDER_STATE.Claimed && now() >= windowEnds - REGISTER_SAFETY_SECONDS;
    let job: Awaited<ReturnType<JobApi["job"]>>;
    try {
      job = await api.job(rec.jobId);
    } catch (error) {
      // The job cannot be read. While there is time, try again on the next pass. With the claim
      // window about to end, an unread job is registered all the same: the protocol admitted it
      // for this claim's payment, and an unregistered claim loses the whole bond for certain.
      if (!mustRegisterNow) throw error;
      log.warn("the job cannot be read and the claim window is about to end; registering it unread", {
        order: rec.id,
        jobId: rec.jobId,
        error,
      });
      job = { id: rec.jobId, state: "unknown", template: null, objective: "", paidBy: null };
    }
    const unread = job.state === "unknown" && job.objective === "";
    if (
      !unread &&
      (!this.#objectiveIsOurs(rec, job.objective) || !sameAddress(job.paidBy ?? null, config.runner))
    ) {
      // The swarm holds another objective than the one that was paid for, or the job is not this
      // wallet's. No record of it can settle this claim. The same is likely for every order.
      const what =
        "the job the swarm opened does not carry this claim's objective; it could never settle the order";
      if (rec.outcome !== what) {
        this.#breaker(true, what);
        log.error(what, { order: rec.id, jobId: rec.jobId, paidBy: job.paidBy });
      }
      if (canRelease) this.#toRelease(rec, what);
      else this.#stuck(rec, what);
      return;
    }
    if (
      !unread &&
      job.template !== null &&
      kindHash(job.template).toLowerCase() !== rec.kindHash.toLowerCase() &&
      canRelease
    ) {
      // A record's kind is the job's template. Under another template the record will be of
      // another kind, and the desk pays only for the order's. Giving the order back costs a tenth
      // of the bond. (Past the point where that is possible the job is registered all the same:
      // once its receipt lands, a record of another kind returns the whole bond.)
      const what = `the swarm opened the job under the template "${job.template}", whose records are not of the kind the order pins; it could never settle the order`;
      if (rec.outcome !== what) {
        this.#breaker(true, what);
        log.error(what, { order: rec.id, jobId: rec.jobId });
      }
      this.#toRelease(rec, what);
      return;
    }
    if (!unread) this.#breaker(false);

    if (held.order.state === ORDER_STATE.Claimed && !config.registerAtOnce && !unread) {
      if (job.state === "blocked") {
        const receipt = (await desk.receiptOf(rec.jobId)).toLowerCase();
        if (receipt === ZERO_HASH && canRelease) {
          this.#toRelease(
            rec,
            `the job ended blocked before it was registered (${job.blockedReason ?? "no reason given"}); given back for a tenth of the bond`,
          );
          return;
        }
        // With its receipt on chain the whole bond comes back through reportFailed, so register.
      } else if (job.state !== "completed" && !mustRegisterNow) {
        log.debug("job running; not registered yet", { order: rec.id, jobId: rec.jobId, state: job.state });
        return;
      }
    }

    const sent = await desk.register(id, rec.jobId);
    if (sent.kind !== "sent") return;
    const after = await desk.snapshot(id);
    this.#setStatus(rec, "registered");
    rec.registeredAt = after.claim.registeredAt !== 0 ? after.claim.registeredAt : now();
    rec.lastBlock = (sent.blockNumber > after.block ? sent.blockNumber : after.block).toString();
    log.info("job registered", { order: rec.id, jobId: rec.jobId, tx: sent.hash });
    this.#touch(rec);
  }

  /**
   * Reads a record as the desk will, so the runner never pays gas for a `settle` that would revert
   * and never stakes its bond on a record that cannot be proven. Everything is compared as the
   * hashes the desk compares, never as decoded text.
   */
  #classify(rec: OrderRecord, bytes: Uint8Array): RecordVerdict {
    if (rec.jobId === undefined || rec.claim === undefined) return { kind: "unreadable", why: "no claim" };
    return judgeRecord(
      {
        jobId: rec.jobId,
        ticket: rec.claim.ticket as Hex,
        specHash: rec.specHash as Hex,
        kindHash: rec.kindHash as Hex,
      },
      bytes,
    );
  }

  /**
   * Sends `settle`, unless the record is more than one transaction carries or more than this
   * runner's gas limit allows. True when it settled.
   *
   * The gas limit is never set by hand: the desk refuses (`GasShort`) unless it can hand each of
   * its two Payroll calls a million gas, so the limit comes from an estimate, which is far above
   * what the call then uses. The estimate is refused above `maxSettleGas`. A settlement whose
   * delay could cost the bond (the delivery deadline is near, or the claim is challenged) may pay
   * the higher fee limits.
   */
  async #trySettle(rec: OrderRecord, held: DeskSnapshot, bytes: Uint8Array): Promise<boolean> {
    const { desk, config, now } = this.#d;
    if (bytes.length > config.maxSettleRecordBytes) {
      this.#say(rec, "info", "the record is too large to settle in one transaction", {
        bytes: bytes.length,
        limit: config.maxSettleRecordBytes,
      });
      return false;
    }
    const deadline = held.claim.registeredAt + held.order.deliverySecs;
    const urgent = held.order.state === ORDER_STATE.Disputed || now() > deadline - SETTLE_URGENT_SECONDS;
    try {
      const sent = await desk.settle(BigInt(rec.id), bytes, { urgent, gasCap: config.maxSettleGas });
      if (sent.kind !== "sent") return false;
      this.#finish(rec, "delivered", `settled against the receipt in ${sent.hash}`);
      return true;
    } catch (error) {
      // With no wallet, the kill switch on, or a transaction still waiting, nothing else can be
      // sent either. Anything else (too costly, above the gas limit, would revert) leaves the
      // cheaper path to try.
      if (isChainWriteError(error) && ["killed", "no_wallet", "pending"].includes(error.code)) throw error;
      this.#say(rec, "warn", "the order could not be settled with its receipt on this pass", {
        error: messageOf(error).slice(0, 200),
        bytes: bytes.length,
        gasByTheDesksFigures: settleGasNeeded(bytes.length).toString(),
      });
      return false;
    }
  }

  /** An order paid out on a claim: from now on it is only looked at for its receipt. */
  #toUnproven(rec: OrderRecord, outcome: string): void {
    this.#setStatus(rec, "unproven");
    rec.outcome = outcome;
    rec.finalizedAt = this.#d.now();
    rec.nextLookAt = this.#d.now() + UNPROVEN_LOOK_SECONDS;
    delete rec.lastError;
    delete rec.suspect;
    this.#d.log.info("order paid out; not yet proven", { order: rec.id, outcome });
    this.#touch(rec);
  }

  /**
   * After an unproven finalize: when the job's receipt lands, `stamp` marks the order proven. No
   * money moves, and anyone may send it; the runner does because a proven delivery is what its
   * work is worth to the next employer who reads the desk. It stops looking after
   * `stampWatchSeconds`.
   */
  async #stampWhenProven(rec: OrderRecord): Promise<void> {
    const { desk, api, config, now } = this.#d;
    const paid = rec.outcome ?? "paid out on the delivery claim";
    if (rec.jobId === undefined || rec.claim === undefined || !config.stampAfterFinalize) {
      this.#finish(rec, "delivered", paid);
      return;
    }
    rec.nextLookAt = now() + UNPROVEN_LOOK_SECONDS;
    const id = BigInt(rec.id);
    const snap = await desk.snapshot(id);
    if (rec.lastBlock !== undefined && snap.block < BigInt(rec.lastBlock)) return;
    if (snap.order.state !== ORDER_STATE.Delivered) return;
    if (snap.order.proven) {
      this.#finish(rec, "delivered", `${paid}; since matched to its receipt on chain`);
      return;
    }
    if (now() - (rec.finalizedAt ?? rec.updatedAt) > config.stampWatchSeconds) {
      this.#finish(
        rec,
        "delivered",
        `${paid}; no receipt landed in ${Math.round(config.stampWatchSeconds / 86_400)} days, so it stays unproven (anyone can stamp it later)`,
      );
      return;
    }
    if (config.mode === "dry-run") return;
    const receipt = (await desk.receiptOf(rec.jobId)).toLowerCase() as Hex;
    if (receipt === ZERO_HASH) return;
    let bytes: Uint8Array;
    try {
      bytes = (await api.workRecord(receipt)).bytes;
    } catch (error) {
      this.#say(rec, "warn", "the registry holds a receipt whose record is not served yet", {
        receipt,
        error: messageOf(error).slice(0, 200),
      });
      return;
    }
    const verdict = this.#classify(rec, bytes);
    if (verdict.kind !== "settles") {
      // The money was paid on the claim and stays paid; the order simply cannot be marked proven
      // with this record. A later record of the job may still do it.
      this.#say(rec, "warn", "the receipt that landed does not prove this order; it stays unproven", {
        receipt,
        verdict: verdict.kind,
      });
      return;
    }
    if (bytes.length > config.maxSettleRecordBytes) {
      this.#say(rec, "info", "the receipt has landed; its record is too large for this runner to stamp", {
        bytes: bytes.length,
      });
      return;
    }
    try {
      const sent = await desk.stamp(id, bytes, { gasCap: config.maxSettleGas });
      if (sent.kind === "sent") this.#finish(rec, "delivered", `${paid}; stamped proven in ${sent.hash}`);
    } catch (error) {
      if (isChainWriteError(error) && ["killed", "no_wallet", "pending"].includes(error.code)) throw error;
      this.#say(rec, "warn", "the order could not be stamped on this pass", {
        error: messageOf(error).slice(0, 200),
      });
    }
  }

  async #watch(rec: OrderRecord): Promise<void> {
    const { desk, api, log, config } = this.#d;
    if (rec.jobId === undefined || rec.claim === undefined) throw new Error("registered without a job id");
    const held = await this.#stillOurs(rec, [ORDER_STATE.Registered]);
    if (held === null) return;
    const id = BigInt(rec.id);
    const deadline = held.claim.registeredAt + held.order.deliverySecs;
    if (this.#d.now() >= deadline) {
      // Timeouts are lazy: until somebody calls `timeout`, a receipt that lands still settles.
      this.#say(
        rec,
        "error",
        "the delivery deadline has passed: anyone can now end the claim, and the bond goes to the employer. A receipt that lands before that still settles the order",
        { deadline },
      );
    }

    // A second job being bought to replace a blocked one comes first: its payment must be seen through.
    if (rec.retry !== undefined) return this.#retry(rec);

    const job = await api.job(rec.jobId);
    if (!sameAddress(job.paidBy ?? null, config.runner)) {
      rec.lastError = `job ${rec.jobId} was paid by ${String(job.paidBy)}, not by this runner`;
      this.#say(rec, "error", "the registered job is not this runner's", {
        jobId: rec.jobId,
        paidBy: job.paidBy,
      });
      return;
    }
    if (!this.#objectiveIsOurs(rec, job.objective)) {
      this.#say(rec, "error", "the job's objective is not the header and the spec", { jobId: rec.jobId });
    }
    if (job.template !== null && kindHash(job.template).toLowerCase() !== rec.kindHash.toLowerCase()) {
      this.#say(rec, "error", "the job's template is not the kind the order pins", {
        template: job.template,
      });
    }

    // The registry is asked first, and what it holds is what counts. A job can be given a second
    // record after its first; the registry then answers with the newer one, and only that one can
    // be proven. So the record is fetched by the registry's hash, never by a hash remembered.
    const receipt = (await desk.receiptOf(rec.jobId)).toLowerCase() as Hex;
    if (receipt !== ZERO_HASH) {
      let record: { bytes: Uint8Array };
      try {
        record = await api.workRecord(receipt);
      } catch (error) {
        this.#say(rec, "warn", "the registry holds a receipt whose record is not served yet", {
          receipt,
          error: messageOf(error).slice(0, 200),
        });
        return;
      }
      const verdict = this.#classify(rec, record.bytes);
      if (verdict.kind === "settles") {
        if (await this.#trySettle(rec, held, record.bytes)) return;
        // It settles and cannot be sent: the bonded claim needs 32 bytes, not the record.
        return this.#claimDelivery(rec, held, receipt, true);
      }
      if (verdict.kind === "not_completed" || verdict.kind === "wrong_kind") {
        if (record.bytes.length > config.maxSettleRecordBytes) {
          // `reportFailed` carries the record as `settle` does, and this one does not fit.
          this.#say(
            rec,
            "error",
            "the receipt that would return the bond has a record too large for one transaction; it takes a chunked proof (WorkProof.proveChunks), sent by hand",
            {
              receipt,
              bytes: record.bytes.length,
              verdict: verdict.kind,
            },
          );
          return;
        }
      }
      if (verdict.kind === "not_completed") {
        if (this.#mayRetry(rec, held)) return this.#retry(rec);
        // The swarm failed a job that was opened correctly. Only the runner may report it, and it
        // gets its whole bond back.
        const sent = await desk.reportFailed(id, record.bytes, { gasCap: config.maxSettleGas });
        if (sent.kind === "sent") {
          this.#finish(
            rec,
            "released",
            `the swarm's job ended ${verdict.state} (${job.blockedReason ?? "no reason given"}); reported with its receipt, bond returned`,
          );
        }
        return;
      }
      if (verdict.kind === "wrong_kind") {
        // Completed, but under another kind than the order's: it can never settle. The desk gives
        // the bond back for this. It means the template table is wrong for this kind.
        log.error(
          "the job's record is of another kind than the order pins; reporting it to get the bond back",
          {
            order: rec.id,
            recordKind: verdict.recordKind,
          },
        );
        this.#breaker(true, `a ${verdict.recordKind} record for an order of another kind`);
        const sent = await desk.reportFailed(id, record.bytes, { gasCap: config.maxSettleGas });
        if (sent.kind === "sent") {
          this.#finish(
            rec,
            "released",
            `the job's record is of kind "${verdict.recordKind}", not the order's; reported, bond returned`,
          );
        }
        return;
      }
      if (verdict.kind === "other_objective") {
        // Reporting this would hand the bond to the employer, so it is not reported. It should be
        // impossible: the job's objective was checked before it was registered.
        rec.lastError = "the registry's receipt for the registered job shows another objective";
        this.#say(
          rec,
          "error",
          "the receipt of the registered job shows another objective than this claim's; the order cannot be settled",
          { receipt },
        );
        return;
      }
      if (verdict.kind !== "unreadable") return;
      rec.lastError = `the registry's receipt cannot be read: ${verdict.why}`;
      this.#say(rec, "error", "the receipt of the registered job cannot be read as a work record", {
        receipt,
        why: verdict.why,
      });
      return;
    }

    if (job.state !== "completed" && job.state !== "blocked") {
      log.debug("job still running", { order: rec.id, jobId: rec.jobId, state: job.state });
      return;
    }
    if (job.state === "blocked") {
      if (this.#mayRetry(rec, held)) return this.#retry(rec);
      // With the receipt, the runner gets its bond back. Without one there is nothing to send:
      // at the deadline the bond goes to the employer.
      this.#say(rec, "warn", "job blocked; waiting for its receipt to recover the bond", {
        reason: job.blockedReason,
        deadline: held.claim.registeredAt + held.order.deliverySecs,
      });
      return;
    }

    // Completed, and no receipt on chain yet. The API lists the job's records, newest first.
    const listed = (await api.jobRecords(rec.jobId)).records[0];
    if (listed === undefined) {
      // Some completed jobs never get a record. Without one nothing can be claimed or settled.
      this.#say(rec, "warn", "job completed; it has no work record yet", { jobId: rec.jobId });
      return;
    }
    const hash = `0x${listed.hash}`.toLowerCase() as Hex;
    let record: { bytes: Uint8Array };
    try {
      record = await api.workRecord(hash);
    } catch (error) {
      log.debug("work record not served yet", { order: rec.id, error });
      return;
    }
    const verdict = this.#classify(rec, record.bytes);
    if (verdict.kind !== "settles") {
      const problem =
        verdict.kind === "not_completed"
          ? `the record's state is "${verdict.state}"`
          : verdict.kind === "wrong_kind"
            ? `the record's kind is "${verdict.recordKind}"`
            : verdict.kind === "other_objective"
              ? "the record's objective is not this claim's header followed by the order's spec"
              : verdict.why;
      rec.lastError = `the job's record cannot settle this order: ${problem}`;
      this.#say(rec, "error", "record does not settle the order", { problem });
      return;
    }
    return this.#claimDelivery(rec, held, hash, false);
  }

  /**
   * The bonded claim: states that the job was delivered as the record with this hash. Only on an
   * order that allows it, only on a record that passed every check locally, and only while the
   * challenge window and the day after it still fit before the delivery deadline.
   *
   * `onChain` says the hash is the one the registry holds. Otherwise it is the newest record the
   * API lists, and the runner first lets it stand for a while: a job's first record is sometimes
   * followed by a second, and the hash named should be the one a watcher will find.
   */
  async #claimDelivery(rec: OrderRecord, held: DeskSnapshot, hash: Hex, onChain: boolean): Promise<void> {
    const { desk, now, log, config } = this.#d;
    const id = BigInt(rec.id);
    if ((held.order.flags & ORDER_FLAG.ALLOW_CLAIMED) === 0) {
      this.#say(
        rec,
        onChain ? "error" : "info",
        onChain
          ? "the receipt is on chain but its record is too large for this runner to settle, and the order allows no bonded claim"
          : "job completed; waiting for its receipt (this order allows no claim)",
      );
      return;
    }
    if (!onChain) {
      if (rec.recordSeen?.hash !== hash) rec.recordSeen = { hash, at: now() };
      const stoodFor = now() - rec.recordSeen.at;
      if (stoodFor < config.claimSettleSeconds) {
        log.debug("letting the job's newest record stand before claiming delivery on it", {
          order: rec.id,
          hash,
          stoodFor,
        });
        return;
      }
    }
    // The whole challenge window, and the day the desk keeps after it for a dispute to be decided,
    // must fit before the delivery deadline, or the desk refuses.
    const deadline = held.claim.registeredAt + held.order.deliverySecs;
    if (now() + DESK.CHALLENGE_WINDOW + DESK.DISPUTE_WINDOW + CLAIM_DEADLINE_MARGIN_SECONDS > deadline) {
      this.#say(rec, "warn", "too late to claim delivery; only the receipt can settle this order now", {
        deadline,
      });
      return;
    }
    const sent = await desk.claimDelivered(id, hash);
    if (sent.kind !== "sent") return;
    const after = await desk.snapshot(id);
    this.#setStatus(rec, "asserted");
    rec.recordHash = hash;
    rec.assertedAt = after.claim.assertedAt !== 0 ? after.claim.assertedAt : now();
    rec.lastBlock = (sent.blockNumber > after.block ? sent.blockNumber : after.block).toString();
    log.info("delivery claimed", { order: rec.id, recordHash: hash, tx: sent.hash });
    this.#touch(rec);
  }

  async #afterAssert(rec: OrderRecord): Promise<void> {
    const { desk, api, now } = this.#d;
    if (rec.jobId === undefined || rec.recordHash === undefined)
      throw new Error("asserted without a record hash");
    const held = await this.#stillOurs(rec, [ORDER_STATE.Asserted, ORDER_STATE.Disputed]);
    if (held === null) return;
    const id = BigInt(rec.id);
    const disputed = held.order.state === ORDER_STATE.Disputed;

    // The receipt always wins: when one has landed that settles the order, settle with it,
    // challenged or not, and whether or not it is the record that was named. The registry's hash
    // is the one to fetch.
    const receipt = (await desk.receiptOf(rec.jobId)).toLowerCase() as Hex;
    let unsendable = false;
    if (receipt !== ZERO_HASH) {
      let bytes: Uint8Array | null = null;
      try {
        bytes = (await api.workRecord(receipt)).bytes;
      } catch (error) {
        this.#say(rec, "warn", "the registry holds a receipt whose record is not served yet", {
          receipt,
          error: messageOf(error).slice(0, 200),
        });
      }
      if (bytes !== null) {
        const verdict = this.#classify(rec, bytes);
        if (verdict.kind === "settles") {
          if (await this.#trySettle(rec, held, bytes)) return;
          unsendable = true;
        } else {
          // Anyone may now end the claim with this receipt, and the bond goes with it. A delivery
          // claim cannot be withdrawn, so there is nothing to send; an operator should know.
          this.#say(
            rec,
            "error",
            "the registry holds a receipt that does not settle this order; the delivery claim can be refuted with it",
            {
              receipt,
              verdict: verdict.kind,
            },
          );
        }
      }
      if (receipt !== rec.recordHash.toLowerCase() && !unsendable) {
        this.#say(rec, "warn", "the registry holds another record than the one named in the delivery claim", {
          claimed: rec.recordHash,
          receipt,
        });
      }
    }

    if (disputed) {
      // Only a receipt, the order's arbiter or the delivery deadline ends a challenged claim. Past
      // the deadline anyone may end it: the employer is refunded, the challenger gets its bond
      // back and the runner nine tenths of its own. A receipt or the arbiter can still decide for
      // the runner until that call is made, so the runner waits a while before it makes the call
      // itself; after that the bond is better back than locked.
      const deadline = held.claim.registeredAt + held.order.deliverySecs;
      if (!unsendable && now() >= deadline + this.#d.config.disputeTimeoutAfter) {
        const sent = await desk.timeout(id);
        if (sent.kind === "sent") {
          this.#finish(
            rec,
            "released",
            `the challenged delivery claim was undecided ${this.#d.config.disputeTimeoutAfter} seconds after the delivery deadline; ended in ${sent.hash}: the employer is refunded, nine tenths of the bond come back, the swarm's fee is spent`,
          );
        }
        return;
      }
      this.#say(
        rec,
        unsendable ? "error" : "warn",
        unsendable
          ? "the delivery claim is challenged and the receipt that would win it is too large for this runner to settle; it takes a chunked proof (WorkProof.proveChunks), sent by hand, before the delivery deadline"
          : "the delivery claim is challenged; a receipt or the arbiter decides it, or the deadline refunds the employer",
        { challenger: held.claim.challenger, deadline: held.claim.registeredAt + held.order.deliverySecs },
      );
      return;
    }
    // Unchallenged: once the window is over the claim is paid, whether or not a settle was possible.
    if (now() < held.claim.assertedAt + DESK.CHALLENGE_WINDOW) return;
    const sent = await desk.finalize(id);
    if (sent.kind !== "sent") return;
    rec.lastBlock = sent.blockNumber.toString();
    const outcome = `finalized unchallenged in ${sent.hash}`;
    if (this.#d.config.stampAfterFinalize) this.#toUnproven(rec, outcome);
    else this.#finish(rec, "delivered", `${outcome}; not yet proven`);
  }

  // -----------------------------------------------------------------------------------------------
  // A second job for a claim whose first ended blocked
  // -----------------------------------------------------------------------------------------------

  /**
   * Whether a second job may be bought for this claim. Off unless the operator raised
   * `MAX_JOBS_PER_ORDER` and the per-order cap covers a second fee: a blocked job often blocks
   * again, and each one costs the fee.
   */
  #mayRetry(rec: OrderRecord, held: DeskSnapshot): boolean {
    const { config, store, now, payFlow, killed } = this.#d;
    if (payFlow === null || config.mode === "dry-run" || killed() || rec.spec === "") return false;
    const bought = 1 + (rec.pastJobs?.length ?? 0) + (rec.retriesFailed ?? 0);
    if (bought >= config.maxJobsPerOrder) return false;
    if (BigInt(rec.spent) + this.#fee > config.orderCap) return false;
    if (spentToday(store, now()) + this.#fee > config.dailyCap) return false;
    const deadline = held.claim.registeredAt + held.order.deliverySecs;
    const closing =
      (held.order.flags & ORDER_FLAG.ALLOW_CLAIMED) !== 0 ? DESK.CHALLENGE_WINDOW + DESK.DISPUTE_WINDOW : 0;
    return now() + RETRY_MIN_SECONDS + closing < deadline;
  }

  /** Buys a second job with the same objective and registers it in place of the blocked one. */
  async #retry(rec: OrderRecord): Promise<void> {
    const { payFlow, desk, log, store } = this.#d;
    if (payFlow === null || rec.jobId === undefined) return;
    const job = this.#payJob(rec);
    if (job === null) {
      delete rec.retry;
      return;
    }
    // A later job's request keys carry its number, so none repeats a key of an earlier job.
    if (rec.retry === undefined) {
      const series = 2 + (rec.pastJobs?.length ?? 0) + (rec.retriesFailed ?? 0);
      rec.retry = newPayState(job, 1, series);
      log.warn("the job ended blocked; buying another for the same claim", {
        order: rec.id,
        blocked: rec.jobId,
      });
      this.#touch(rec);
    }
    const flow = payFlow(this.#hooks(rec));
    const outcome = await flow.advance(rec.retry, job);
    store.save();
    if (outcome.kind === "pending") {
      log.debug("payment for the second job pending", { order: rec.id, why: outcome.why });
      return;
    }
    if (outcome.kind === "failed") {
      log.warn("the second job could not be bought", {
        order: rec.id,
        code: outcome.code,
        charged: outcome.charged,
      });
      rec.retriesFailed = (rec.retriesFailed ?? 0) + 1;
      delete rec.retry;
      this.#touch(rec);
      return;
    }
    const sent = await desk.register(BigInt(rec.id), outcome.jobId);
    if (sent.kind !== "sent") return;
    rec.pastJobs = [...(rec.pastJobs ?? []), rec.jobId];
    rec.jobId = outcome.jobId;
    rec.pay = rec.retry;
    delete rec.retry;
    delete rec.recordSeen;
    delete rec.said;
    rec.lastBlock = sent.blockNumber.toString();
    log.info("second job registered in place of the blocked one", {
      order: rec.id,
      jobId: outcome.jobId,
      tx: sent.hash,
    });
    this.#touch(rec);
  }

  // -----------------------------------------------------------------------------------------------
  // Caps
  // -----------------------------------------------------------------------------------------------

  #hooks(rec: OrderRecord): PayHooks {
    const { store, desk } = this.#d;
    return {
      ...this.capsFor(rec),
      persist: () => store.save(),
      // A job that is paid for must be registered within the claim window. If the runner could not
      // send that transaction now, it does not sign the payment now.
      mayPay: () => desk.cannotSend(true),
    };
  }

  /**
   * The cap hooks for one order's payment. `reserve` refuses when the amount would take the order
   * over its cap or the day over the daily cap; a refusal means the payment is not signed.
   * `release` takes a reservation off the day it was booked on, which may not be today.
   */
  capsFor(rec: OrderRecord): {
    reserve: (amount: bigint) => boolean;
    release: (amount: bigint, day?: string) => void;
  } {
    const { store, config, now, log } = this.#d;
    return {
      reserve: (amount) => {
        const day = spentToday(store, now());
        if (BigInt(rec.spent) + amount > config.orderCap || day + amount > config.dailyCap) {
          log.warn("spending cap reached", {
            order: rec.id,
            amount: amount.toString(),
            spentOnOrder: rec.spent,
            spentToday: day.toString(),
          });
          return false;
        }
        rec.spent = (BigInt(rec.spent) + amount).toString();
        addSpend(store, now(), amount);
        store.save();
        return true;
      },
      release: (amount, day) => {
        const next = BigInt(rec.spent) - amount;
        rec.spent = (next < 0n ? 0n : next).toString();
        if (day === undefined) addSpend(store, now(), -amount);
        else addSpendOn(store, day, -amount);
        store.save();
      },
    };
  }

  /** A short account of where every order stands, for the status command. */
  summary(): { status: OrderStatus; count: number }[] {
    const counts = new Map<OrderStatus, number>();
    for (const rec of this.#records()) counts.set(rec.status, (counts.get(rec.status) ?? 0) + 1);
    return [...counts].map(([status, count]) => ({ status, count }));
  }

  /** The orders this runner has a bond on, for the status command. */
  held(): { order: string; status: OrderStatus; bond: string; jobId?: string; lastError?: string }[] {
    return this.#holding().map((r) => ({
      order: r.id,
      status: r.status,
      bond: r.claim?.bond ?? "0",
      ...(r.jobId === undefined ? {} : { jobId: r.jobId }),
      ...(r.lastError === undefined ? {} : { lastError: r.lastError }),
    }));
  }
}
