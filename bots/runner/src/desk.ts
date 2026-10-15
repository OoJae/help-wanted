/**
 * The hire desk as the runner uses it: a handful of reads, and the writes, each through
 * `ChainWriter`. The interface is what the state machine depends on, so tests can stand a desk up
 * in memory.
 */
import { hexToBytes, type Abi, type Address, type Hex } from "viem";
import { erc20Abi, uuidToBytes16, workOrdersAbi, workProofAbi, workRegistryAbi } from "@help-wanted/shared";
import type { ChainWriter, WriteOutcome } from "./chain.js";

/** One `OrderOpened` log. */
export interface OpenedOrder {
  id: bigint;
  employer: Address;
  kindHash: Hex;
  specHash: Hex;
  /** The spec bytes as text. Only valid specs (printable ASCII) survive this unchanged. */
  spec: string;
  /** When the order expires, Unix seconds, from the event's parameters. */
  expiresAt: number;
  block: bigint;
}

/** `WorkOrders.orderOf`, the fields the runner reads. */
export interface DeskOrder {
  state: number;
  employer: Address;
  expiresAt: number;
  flags: number;
  kindHash: Hex;
  specHash: Hex;
  deliverySecs: number;
  runnerOnly: Address;
  bond: bigint;
  arbiter: Address;
  condTarget: Address;
  condMet: boolean;
  seq: number;
  /** Where the price starts and where it ends: what a claim can fix lies between the two. */
  minPay: bigint;
  maxPay: bigint;
  /** Set once a registry receipt has been matched (`settle` or `stamp`). */
  proven: boolean;
}

/** `WorkOrders.claimOf`. */
export interface DeskClaim {
  runner: Address;
  claimedAt: number;
  registeredAt: number;
  price: bigint;
  /** bytes16; all zero until a job is registered. */
  jobId: Hex;
  /** Zero until a delivery claim is challenged. */
  challenger: Address;
  assertedAt: number;
  recordHash: Hex;
}

/** An order and its claim as one block shows them. */
export interface DeskSnapshot {
  order: DeskOrder;
  claim: DeskClaim;
  /** The block both were read at. */
  block: bigint;
}

export interface DeskChain {
  /** The address writes come from, when one is known. */
  readonly runner: Address | null;
  blockNumber(): Promise<bigint>;
  ordersOpened(fromBlock: bigint, toBlock: bigint): Promise<OpenedOrder[]>;
  /** Ids of the orders `runner` claimed in the range, from the desk's `Claimed` logs. */
  claimedBy(runner: Address, fromBlock: bigint, toBlock: bigint): Promise<bigint[]>;
  /**
   * `orderOf` and `claimOf` read at one and the same block, so the pair can never mix the state
   * before a transaction with the state after it.
   */
  snapshot(id: bigint): Promise<DeskSnapshot>;
  priceNow(id: bigint): Promise<bigint>;
  condition(id: bigint): Promise<{ met: boolean; holdsNow: boolean }>;
  barred(id: bigint, runner: Address): Promise<boolean>;
  /**
   * `headerOf(id)`: the 85 bytes the desk itself expects at the start of the job's objective for
   * the order's current claim, as text. Read before a job is paid for and compared with the header
   * this runner built: a job opened under any other header could never settle the order.
   */
  headerOf(id: bigint): Promise<string>;
  /** `WorkRegistry.latest(jobId)`: the receipt hash, or zero. */
  receiptOf(jobId: string): Promise<Hex>;
  /**
   * The block of the registry's newest `WorkRecorded` event within the last `lookbackBlocks`
   * blocks, or null when it wrote no receipt in that time. This is the desk's own advice to a
   * runner ("look at how receipts are flowing before you take a receipt-only order").
   */
  lastReceiptBlock(lookbackBlocks: bigint): Promise<bigint | null>;
  imdBalance(owner: Address): Promise<bigint>;
  imdAllowance(owner: Address, spender: Address): Promise<bigint>;
  ethBalance(owner: Address): Promise<bigint>;
  /**
   * Why a transaction could not be sent right now (fees above the cap, one still waiting), or null.
   * `urgent` asks about the calls that protect a bond, which have a higher cap.
   */
  cannotSend(urgent: boolean): Promise<string | null>;

  approveImd(spender: Address, amount: bigint): Promise<WriteOutcome>;
  /** `trigger(id)`: records that a conditional order's condition holds, which starts its price ramp. */
  trigger(id: bigint): Promise<WriteOutcome>;
  claim(id: bigint): Promise<WriteOutcome>;
  register(id: bigint, jobId: string): Promise<WriteOutcome>;
  /**
   * `settle(id, record, [])`. `urgent` asks for the higher fee limits: a settlement that is late
   * can cost the bond (the delivery deadline) or a dispute. `gasCap` is the most gas the runner
   * will send it with; a record that needs more is not carried.
   */
  settle(
    id: bigint,
    record: Uint8Array,
    options?: { urgent?: boolean; gasCap?: bigint },
  ): Promise<WriteOutcome>;
  claimDelivered(id: bigint, recordHash: Hex): Promise<WriteOutcome>;
  finalize(id: bigint): Promise<WriteOutcome>;
  release(id: bigint): Promise<WriteOutcome>;
  reportFailed(id: bigint, record: Uint8Array, options?: { gasCap?: bigint }): Promise<WriteOutcome>;
  /** `stamp(id, record, [])`: marks an order that was paid on a claim as proven. No money moves. */
  stamp(id: bigint, record: Uint8Array, options?: { gasCap?: bigint }): Promise<WriteOutcome>;
  /** `timeout(id)`: ends a claim whose delivery time has passed. */
  timeout(id: bigint): Promise<WriteOutcome>;
}

/** The part of a viem public client the desk reads through. */
export interface ReaderLike {
  getBlockNumber(): Promise<bigint>;
  getBalance(args: { address: Address }): Promise<bigint>;
  readContract(args: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }): Promise<unknown>;
  getContractEvents(args: {
    address: Address;
    abi: Abi;
    eventName: string;
    args?: Record<string, unknown>;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly { args: unknown; blockNumber: bigint | null }[]>;
}

export interface DeskAddresses {
  workOrders: Address;
  imd: Address;
  workRegistry: Address;
}

function toHexBytes(bytes: Uint8Array): Hex {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out as Hex;
}

/** Bytes to text with nothing dropped (a plain decoder removes a leading byte order mark). */
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * The desk's ABI, with WorkProof's errors beside it: `settle` and `reportFailed` pass a WorkProof
 * revert on unchanged, and a failed simulation should be able to name it (`NoReceipt`,
 * `HashMismatch`, …).
 */
const WORK_ORDERS = [
  ...workOrdersAbi,
  ...workProofAbi.filter((item) => item.type === "error"),
] as unknown as Abi;
const ERC20 = erc20Abi as unknown as Abi;
const REGISTRY = workRegistryAbi as unknown as Abi;

/** The desk over a real chain. */
export function viemDesk(
  reader: ReaderLike,
  writer: ChainWriter,
  addresses: DeskAddresses,
  runner: Address | null,
): DeskChain {
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    reader.readContract({
      address: addresses.workOrders,
      abi: WORK_ORDERS,
      functionName,
      args,
    }) as Promise<T>;
  const write = (
    functionName: string,
    args: readonly unknown[],
    label: string,
    urgent = false,
    gasCap?: bigint,
  ) =>
    writer.send({
      address: addresses.workOrders,
      abi: WORK_ORDERS,
      functionName,
      args,
      label,
      urgent,
      ...(gasCap === undefined ? {} : { gasCap }),
    });

  const toOrder = (o: Record<string, unknown>): DeskOrder => ({
    state: Number(o.state),
    employer: o.employer as Address,
    expiresAt: Number(o.expiresAt),
    flags: Number(o.flags),
    kindHash: o.kindHash as Hex,
    specHash: o.specHash as Hex,
    deliverySecs: Number(o.deliverySecs),
    runnerOnly: o.runnerOnly as Address,
    bond: o.bond as bigint,
    arbiter: o.arbiter as Address,
    condTarget: o.condTarget as Address,
    condMet: Boolean(o.condMet),
    seq: Number(o.seq),
    minPay: o.minPay as bigint,
    maxPay: o.maxPay as bigint,
    proven: Boolean(o.proven),
  });
  const toClaim = (c: Record<string, unknown>): DeskClaim => ({
    runner: c.runner as Address,
    claimedAt: Number(c.claimedAt),
    registeredAt: Number(c.registeredAt),
    price: c.price as bigint,
    jobId: c.jobId as Hex,
    challenger: c.challenger as Address,
    assertedAt: Number(c.assertedAt),
    recordHash: c.recordHash as Hex,
  });

  return {
    runner,
    blockNumber: () => reader.getBlockNumber(),

    async ordersOpened(fromBlock, toBlock) {
      const logs = await reader.getContractEvents({
        address: addresses.workOrders,
        abi: WORK_ORDERS,
        eventName: "OrderOpened",
        fromBlock,
        toBlock,
      });
      return logs.map((log) => {
        const a = log.args as {
          id: bigint;
          employer: Address;
          kindHash: Hex;
          specHash: Hex;
          spec: Hex;
          params: { expiresAt: number | bigint };
        };
        return {
          id: a.id,
          employer: a.employer,
          kindHash: a.kindHash,
          specHash: a.specHash,
          spec: UTF8.decode(hexToBytes(a.spec)),
          expiresAt: Number(a.params.expiresAt),
          block: log.blockNumber ?? toBlock,
        };
      });
    },

    async claimedBy(who, fromBlock, toBlock) {
      const logs = await reader.getContractEvents({
        address: addresses.workOrders,
        abi: WORK_ORDERS,
        eventName: "Claimed",
        args: { runner: who },
        fromBlock,
        toBlock,
      });
      return [...new Set(logs.map((log) => (log.args as { id: bigint }).id))];
    },

    async snapshot(id) {
      // Both reads name the block. A node that does not have it yet refuses, and the step is tried
      // again on the next pass, which is what a reading from a node that is behind deserves.
      const block = await reader.getBlockNumber();
      const at = (functionName: string) =>
        reader.readContract({
          address: addresses.workOrders,
          abi: WORK_ORDERS,
          functionName,
          args: [id],
          blockNumber: block,
        }) as Promise<Record<string, unknown>>;
      const [o, c] = await Promise.all([at("orderOf"), at("claimOf")]);
      return { order: toOrder(o), claim: toClaim(c), block };
    },

    priceNow: (id) => read<bigint>("priceNow", [id]),

    async condition(id) {
      const [met, holdsNow] = await read<readonly [boolean, boolean, bigint]>("conditionOf", [id]);
      return { met, holdsNow };
    },

    barred: (id, who) => read<boolean>("barred", [id, who]),

    async headerOf(id) {
      return UTF8.decode(hexToBytes(await read<Hex>("headerOf", [id])));
    },

    receiptOf: (jobId) =>
      reader.readContract({
        address: addresses.workRegistry,
        abi: REGISTRY,
        functionName: "latest",
        args: [uuidToBytes16(jobId)],
      }) as Promise<Hex>,

    async lastReceiptBlock(lookbackBlocks) {
      const head = await reader.getBlockNumber();
      const fromBlock = head > lookbackBlocks ? head - lookbackBlocks : 0n;
      const logs = await reader.getContractEvents({
        address: addresses.workRegistry,
        abi: REGISTRY,
        eventName: "WorkRecorded",
        fromBlock,
        toBlock: head,
      });
      let newest: bigint | null = null;
      for (const log of logs) {
        const block = log.blockNumber ?? head;
        if (newest === null || block > newest) newest = block;
      }
      return newest;
    },

    imdBalance: (owner) =>
      reader.readContract({
        address: addresses.imd,
        abi: ERC20,
        functionName: "balanceOf",
        args: [owner],
      }) as Promise<bigint>,
    imdAllowance: (owner, spender) =>
      reader.readContract({
        address: addresses.imd,
        abi: ERC20,
        functionName: "allowance",
        args: [owner, spender],
      }) as Promise<bigint>,
    ethBalance: (owner) => reader.getBalance({ address: owner }),
    cannotSend: (urgent) => writer.cannotSend(urgent),

    approveImd: (spender, amount) =>
      writer.send({
        address: addresses.imd,
        abi: ERC20,
        functionName: "approve",
        args: [spender, amount],
        label: `approve ${amount} IMD wei to ${spender}`,
      }),
    trigger: (id) => write("trigger", [id], `latch the condition of order ${id}`),
    claim: (id) => write("claim", [id], `claim order ${id}`),
    // The calls that protect a bond are marked urgent: they may pay more for gas than the rest.
    register: (id, jobId) =>
      write("register", [id, uuidToBytes16(jobId)], `register job ${jobId} for order ${id}`, true),
    // The gas limit of a settlement comes from an estimate, never from a figure set by hand: the
    // desk refuses (`GasShort`) unless it can hand each of its two Payroll calls a million gas, so
    // the estimate is far above what the call then uses, and what is not used is returned.
    settle: (id, record, options) =>
      write(
        "settle",
        [id, toHexBytes(record), []],
        `settle order ${id} with its ${record.length}-byte record`,
        options?.urgent === true,
        options?.gasCap,
      ),
    claimDelivered: (id, recordHash) =>
      write("claimDelivered", [id, recordHash], `claim delivery of order ${id}`, true),
    finalize: (id) => write("finalize", [id], `finalize order ${id}`),
    release: (id) => write("release", [id], `release order ${id}`, true),
    reportFailed: (id, record, options) =>
      write(
        "reportFailed",
        [id, toHexBytes(record), []],
        `report the failed job of order ${id}`,
        true,
        options?.gasCap,
      ),
    stamp: (id, record, options) =>
      write(
        "stamp",
        [id, toHexBytes(record), []],
        `stamp order ${id} as proven with its ${record.length}-byte record`,
        false,
        options?.gasCap,
      ),
    timeout: (id) => write("timeout", [id], `end the claim of order ${id} at its deadline`, true),
  };
}
