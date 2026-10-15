/**
 * An in-memory hire desk and an in-memory IdentityMD API for the machine tests. The desk follows
 * the state changes of `WorkOrders` for the calls the runner makes, and nothing more.
 */
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import {
  DESK as DESK_CONST,
  MAINNET,
  ORDER_FLAG,
  ORDER_STATE,
  canonicalize,
  kindHash,
  orderHeader,
  orderTicket,
  specHash,
  uuidToBytes16,
} from "@help-wanted/shared";
import { ChainWriteError, type WriteOutcome } from "../src/chain.js";
import type { DeskChain, DeskClaim, DeskOrder, DeskSnapshot, OpenedOrder } from "../src/desk.js";
import type { JobApi } from "../src/machine.js";
import { DESK, EMPLOYER, NOW, RUNNER, SPEC } from "./world.js";

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
const ZERO_JOB = `0x${"0".repeat(32)}` as Hex;

export interface FakeOrder {
  order: DeskOrder;
  claim: DeskClaim;
  spec: string;
  price: bigint;
  block: bigint;
  conditionHolds: boolean;
}

export class FakeDesk implements DeskChain {
  readonly runner: Address | null = RUNNER;
  /** The newest block. Every write is mined in a block of its own. */
  head = 1_000n;
  now = NOW;
  readonly orders = new Map<bigint, FakeOrder>();
  readonly calls: string[] = [];
  /** `Claimed` logs: which order this runner claimed in which block. */
  readonly claimLog: { id: bigint; block: bigint }[] = [];
  /** What `cannotSend` answers: a reason no bond-protecting transaction could go out now, or null. */
  blocked: string | null = null;
  /** How many chain reads were made, for the tests that count them. */
  reads = 0;
  readonly receipts = new Map<string, Hex>();
  readonly barredFor = new Set<bigint>();
  balance = 10n ** 19n;
  /** IMD allowance to the desk. */
  allowance = 0n;
  /** IMD allowance to Permit2. */
  permit2Allowance = 10n ** 19n;
  eth = 10n ** 17n;
  /** Set to make the next write fail the way the chain writer would. */
  failNext: ChainWriteError | null = null;
  /** The block of the registry's newest receipt, or null when it has written none lately. */
  lastReceipt: bigint | null = null;
  /** Set to make the read of the registry's receipts fail. */
  receiptsUnreadable = false;
  /** How often the registry's receipts were read. */
  receiptReads = 0;
  /** What `headerOf` answers instead of the true header, when a test sets it. */
  headerOverride: string | null = null;
  /** The gas cap each capped write was sent with, by label. */
  readonly gasCaps = new Map<string, bigint | undefined>();
  /** Which settlements asked for the higher fee limits. */
  readonly urgentSettles: boolean[] = [];
  /** A record above this many bytes makes `settle` fail as over its gas limit. Null: never. */
  settleGasLimitBytes: number | null = null;
  /** In dry-run the writer sends nothing and says so. */
  dryRun = false;
  #tx = 0;

  /** Opens an order the way `createOrder` would, with sensible defaults. */
  open(
    id: bigint,
    overrides: Partial<DeskOrder> = {},
    extra: { spec?: string; price?: bigint; kind?: string } = {},
  ): FakeOrder {
    const spec = extra.spec ?? SPEC;
    const entry: FakeOrder = {
      order: {
        state: ORDER_STATE.Open,
        employer: EMPLOYER,
        expiresAt: NOW + 30 * 86400,
        flags: ORDER_FLAG.ALLOW_CLAIMED,
        kindHash: kindHash(extra.kind ?? "skill:research-report"),
        specHash: specHash(spec),
        deliverySecs: 7 * 86400,
        runnerOnly: ZERO,
        bond: DESK_CONST.MIN_BOND,
        arbiter: ZERO,
        condTarget: ZERO,
        condMet: true,
        seq: 0,
        minPay: extra.price ?? 3n * 10n ** 18n,
        maxPay: extra.price ?? 3n * 10n ** 18n,
        proven: false,
        ...overrides,
      },
      claim: {
        runner: ZERO,
        claimedAt: 0,
        registeredAt: 0,
        price: 0n,
        jobId: ZERO_JOB,
        challenger: ZERO,
        assertedAt: 0,
        recordHash: ZERO_HASH,
      },
      spec,
      price: extra.price ?? 3n * 10n ** 18n,
      block: this.head - 10n,
      conditionHolds: true,
    };
    this.orders.set(id, entry);
    return entry;
  }

  #get(id: bigint): FakeOrder {
    const entry = this.orders.get(id);
    if (!entry) throw new Error(`no order ${id}`);
    return entry;
  }

  #write(label: string, effect: () => void): WriteOutcome {
    this.calls.push(label);
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    if (this.dryRun) return { kind: "dry-run", label, wouldSucceed: true };
    effect();
    this.#tx++;
    this.head += 1n;
    return {
      kind: "sent",
      label,
      hash: `0x${this.#tx.toString(16).padStart(64, "0")}`,
      blockNumber: this.head,
      gasUsed: 100_000n,
      logs: [],
    };
  }

  #revert(name: string): never {
    throw new ChainWriteError("simulation_reverted", `would revert: ${name}`);
  }

  async blockNumber() {
    return this.head;
  }

  async ordersOpened(fromBlock: bigint, toBlock: bigint): Promise<OpenedOrder[]> {
    this.calls.push(`logs ${fromBlock}-${toBlock}`);
    return [...this.orders]
      .filter(([, e]) => e.block >= fromBlock && e.block <= toBlock)
      .map(([id, e]) => ({
        id,
        employer: e.order.employer,
        kindHash: e.order.kindHash,
        specHash: e.order.specHash,
        spec: e.spec,
        expiresAt: e.order.expiresAt,
        block: e.block,
      }));
  }

  async claimedBy(_runner: Address, fromBlock: bigint, toBlock: bigint): Promise<bigint[]> {
    return [
      ...new Set(this.claimLog.filter((c) => c.block >= fromBlock && c.block <= toBlock).map((c) => c.id)),
    ];
  }

  /** The order and its claim as the newest block shows them. Tests replace it to serve a stale one. */
  async snapshot(id: bigint): Promise<DeskSnapshot> {
    this.reads++;
    const e = this.#get(id);
    return { order: { ...e.order }, claim: { ...e.claim }, block: this.head };
  }

  async cannotSend(_urgent: boolean): Promise<string | null> {
    return this.blocked;
  }
  async priceNow(id: bigint) {
    return this.#get(id).price;
  }
  async condition(id: bigint) {
    const e = this.#get(id);
    return { met: e.order.condMet, holdsNow: e.conditionHolds };
  }
  async barred(id: bigint) {
    return this.barredFor.has(id);
  }
  async headerOf(id: bigint) {
    if (this.headerOverride !== null) return this.headerOverride;
    const e = this.#get(id);
    if (e.order.state < ORDER_STATE.Claimed || e.order.state > ORDER_STATE.Delivered)
      this.#revert("BadState");
    return orderHeader(
      orderTicket({
        chainId: 1,
        workOrders: DESK,
        orderId: id,
        claimSeq: e.order.seq,
        runner: e.claim.runner,
      }),
    );
  }
  async lastReceiptBlock(_lookbackBlocks: bigint) {
    this.receiptReads++;
    if (this.receiptsUnreadable) throw new Error("the node refused the log query");
    return this.lastReceipt;
  }
  async receiptOf(jobId: string) {
    return this.receipts.get(jobId) ?? ZERO_HASH;
  }
  async imdBalance() {
    return this.balance;
  }
  async imdAllowance(_owner: Address, spender: Address) {
    return spender.toLowerCase() === MAINNET.PERMIT2.toLowerCase() ? this.permit2Allowance : this.allowance;
  }
  async ethBalance() {
    return this.eth;
  }

  async approveImd(_spender: Address, amount: bigint) {
    return this.#write(`approve ${amount}`, () => {
      this.allowance = amount;
    });
  }

  async trigger(id: bigint) {
    return this.#write(`trigger ${id}`, () => {
      const e = this.#get(id);
      if (e.order.state !== ORDER_STATE.Open || e.order.condMet) this.#revert("BadState");
      if (!e.conditionHolds) this.#revert("ConditionNotMet");
      e.order.condMet = true;
    });
  }

  async claim(id: bigint) {
    return this.#write(`claim ${id}`, () => {
      const e = this.#get(id);
      if (e.order.state !== ORDER_STATE.Open) this.#revert("BadState");
      if (!e.order.condMet) {
        if (!e.conditionHolds) this.#revert("ConditionNotMet");
        e.order.condMet = true;
      }
      if (this.allowance < e.order.bond) this.#revert("allowance");
      this.allowance -= e.order.bond;
      this.balance -= e.order.bond;
      e.order.state = ORDER_STATE.Claimed;
      e.order.seq += 1;
      e.claim = {
        runner: RUNNER,
        claimedAt: this.now,
        registeredAt: 0,
        price: e.price,
        jobId: ZERO_JOB,
        challenger: ZERO,
        assertedAt: 0,
        recordHash: ZERO_HASH,
      };
      // The block the write is mined in, which `#write` moves to right after.
      this.claimLog.push({ id, block: this.head + 1n });
    });
  }

  async register(id: bigint, jobId: string) {
    return this.#write(`register ${id} ${jobId}`, () => {
      const e = this.#get(id);
      if (e.order.state !== ORDER_STATE.Claimed && e.order.state !== ORDER_STATE.Registered)
        this.#revert("BadState");
      if (e.order.state === ORDER_STATE.Claimed) e.claim.registeredAt = this.now;
      e.order.state = ORDER_STATE.Registered;
      e.claim.jobId = uuidToBytes16(jobId);
    });
  }

  async settle(id: bigint, record: Uint8Array, options?: { urgent?: boolean; gasCap?: bigint }) {
    this.gasCaps.set(`settle ${id}`, options?.gasCap);
    this.urgentSettles.push(options?.urgent === true);
    return this.#write(`settle ${id} ${keccak256(record)}`, () => {
      const e = this.#get(id);
      if (e.order.state < ORDER_STATE.Registered || e.order.state > ORDER_STATE.Disputed)
        this.#revert("BadState");
      if (this.settleGasLimitBytes !== null && record.length > this.settleGasLimitBytes) {
        throw new ChainWriteError("gas_over_limit", "the settlement needs more gas than its limit");
      }
      e.order.state = ORDER_STATE.Delivered;
      e.order.proven = true;
      e.claim.recordHash = keccak256(record);
    });
  }

  async stamp(id: bigint, record: Uint8Array, options?: { gasCap?: bigint }) {
    this.gasCaps.set(`stamp ${id}`, options?.gasCap);
    return this.#write(`stamp ${id} ${keccak256(record)}`, () => {
      const e = this.#get(id);
      if (e.order.state !== ORDER_STATE.Delivered || e.order.proven) this.#revert("BadState");
      e.order.proven = true;
      e.claim.recordHash = keccak256(record);
    });
  }

  async timeout(id: bigint) {
    return this.#write(`timeout ${id}`, () => {
      const e = this.#get(id);
      if (e.order.state !== ORDER_STATE.Registered && e.order.state !== ORDER_STATE.Disputed)
        this.#revert("BadState");
      if (this.now < e.claim.registeredAt + e.order.deliverySecs) this.#revert("TooEarly");
      // A registered job goes back on offer; an undecided dispute refunds the employer for good.
      e.order.state = e.order.state === ORDER_STATE.Disputed ? ORDER_STATE.Refunded : ORDER_STATE.Open;
    });
  }

  async claimDelivered(id: bigint, recordHash: Hex) {
    return this.#write(`claimDelivered ${id} ${recordHash}`, () => {
      const e = this.#get(id);
      if (e.order.state !== ORDER_STATE.Registered) this.#revert("BadState");
      if ((e.order.flags & ORDER_FLAG.ALLOW_CLAIMED) === 0) this.#revert("ClaimedPathOff");
      // The challenge window and the day kept after it must both end by the delivery deadline.
      if (
        this.now + DESK_CONST.CHALLENGE_WINDOW + DESK_CONST.DISPUTE_WINDOW >
        e.claim.registeredAt + e.order.deliverySecs
      )
        this.#revert("TooLate");
      e.order.state = ORDER_STATE.Asserted;
      e.claim.assertedAt = this.now;
      e.claim.recordHash = recordHash;
    });
  }

  async finalize(id: bigint) {
    return this.#write(`finalize ${id}`, () => {
      const e = this.#get(id);
      if (e.order.state !== ORDER_STATE.Asserted) this.#revert("BadState");
      if (this.now < e.claim.assertedAt + DESK_CONST.CHALLENGE_WINDOW) this.#revert("TooEarly");
      e.order.state = ORDER_STATE.Delivered;
    });
  }

  async release(id: bigint) {
    return this.#write(`release ${id}`, () => {
      const e = this.#get(id);
      if (e.order.state !== ORDER_STATE.Claimed) this.#revert("BadState");
      if (this.now >= e.claim.claimedAt + DESK_CONST.CLAIM_WINDOW) this.#revert("TooLate");
      e.order.state = ORDER_STATE.Open;
      this.barredFor.add(id);
    });
  }

  async reportFailed(id: bigint, record: Uint8Array, options?: { gasCap?: bigint }) {
    this.gasCaps.set(`reportFailed ${id}`, options?.gasCap);
    return this.#write(`reportFailed ${id} ${keccak256(record)}`, () => {
      const e = this.#get(id);
      if (e.order.state < ORDER_STATE.Registered) this.#revert("BadState");
      e.order.state = ORDER_STATE.Open;
    });
  }

  /** The writes only, without the log reads. */
  writes(): string[] {
    return this.calls.filter((c) => !c.startsWith("logs "));
  }
}

/** A canonical work record for a job, as IdentityMD would write it. */
export function workRecord(fields: {
  jobId: string;
  objective: string;
  kind?: string;
  state?: string;
  agentIds?: string[];
}): Uint8Array {
  return stringToBytes(
    canonicalize({
      assessments: [],
      jobId: fields.jobId,
      kind: fields.kind ?? "skill:research-report",
      nodes: [],
      objective: fields.objective,
      parentJobId: null,
      schema: "identitymd-work-v1",
      signals: (fields.agentIds ?? ["52211"]).map((agentId) => ({ agentId, value: 1 })),
      state: fields.state ?? "completed",
      submissions: [],
    }),
  );
}

export function objectiveFor(orderId: bigint, seq: number, spec: string = SPEC): string {
  return (
    orderHeader(orderTicket({ chainId: 1, workOrders: DESK, orderId, claimSeq: seq, runner: RUNNER })) + spec
  );
}

export class FakeApi implements JobApi {
  readonly checks: unknown[] = [];
  blockers: unknown[] = [];
  checkKind: string | undefined = undefined;
  readonly jobs = new Map<
    string,
    {
      state: string;
      template: string | null;
      objective: string;
      paidBy: string | null;
      blockedReason?: string | null;
    }
  >();
  /** The newest record of each job. */
  readonly records = new Map<string, Uint8Array>();
  /** Earlier records of a job, newest first, listed after the newest as the API lists them. */
  readonly olderRecords = new Map<string, Uint8Array[]>();
  /** Record status per job, as `GET /jobs/:id/records` reports it. */
  readonly recordStatus = new Map<string, string>();
  /** What `GET /requests/paid-by/:address` lists, newest first. */
  paidOrders: { action: string; createdAt: string; result?: { kind?: string; jobId?: string } | null }[] = [];
  paidByCalls = 0;

  /** What `GET /requests/capabilities` says about job.open. Tests change it. */
  terms = {
    network: "eip155:1",
    asset: MAINNET.IMD.toLowerCase(),
    amount: "500000000000000000",
    payTo: MAINNET.FEE_PAYEE.toLowerCase(),
  };
  capabilitiesCalls = 0;

  async capabilities() {
    this.capabilitiesCalls++;
    return {
      actions: [
        { action: "oracle.request", payment: this.terms },
        { action: "job.open", payment: this.terms },
      ],
    };
  }

  async check(_action: "job.open", input: unknown) {
    this.checks.push(input);
    return this.checkKind === undefined
      ? { blockers: this.blockers }
      : { blockers: this.blockers, kind: this.checkKind };
  }

  async job(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`no job ${id}`);
    return { id, ...job };
  }

  async jobRecords(id: string) {
    const newest = this.records.get(id);
    if (!newest) return { records: [] };
    const status = this.recordStatus.get(id) ?? "queued";
    return {
      records: [newest, ...(this.olderRecords.get(id) ?? [])].map((bytes) => ({
        hash: keccak256(bytes).slice(2),
        status,
      })),
    };
  }

  async workRecord(hash: string) {
    const want = (hash.startsWith("0x") ? hash : `0x${hash}`).toLowerCase();
    for (const bytes of [...this.records.values(), ...[...this.olderRecords.values()].flat()]) {
      if (keccak256(bytes) === want) return { bytes, recordHash: want as Hex };
    }
    throw new Error("404 unknown_record");
  }

  async paidBy(_payer: string) {
    this.paidByCalls++;
    return { orders: this.paidOrders };
  }
}
