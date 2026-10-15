/**
 * The one place the keeper sends a transaction from. It is the runner's writer, with a daily
 * spending cap added and the runner's "urgent" limits left out (nothing the keeper sends protects
 * a bond).
 *
 * Every write goes through `ChainWriter.send`, which does the same things in the same order:
 *
 *   1. stop if the kill switch is on;
 *   2. simulate the call from the keeper's address, and stop if it would revert;
 *   3. in dry-run, say what would be sent and stop;
 *   4. look at the transaction sent before, if it has not been mined yet (see below);
 *   5. read the current fee and stop if it is above the cap;
 *   6. estimate the gas and stop if even the current fee would cost more than the limit for one
 *      transaction, or if the worst case would take today's spending over the daily cap;
 *   7. send, with a fee ceiling of twice the current fee (never above the limits);
 *   8. wait for the receipt, book what it really cost, and fail loudly if it reverted.
 *
 * FEES. An EIP-1559 transaction is charged the block's base fee plus its tip, never its ceiling.
 * A ceiling equal to the current estimate leaves the transaction waiting as soon as the base fee
 * moves, so the ceiling sent is twice the current fee, held within the operator's two limits
 * (`min(fee cap, cost limit / gas)`).
 *
 * THE DAILY CAP. Before a transaction is sent, its worst case (gas limit times fee ceiling) is set
 * aside against the day's cap; when its receipt comes, the reservation is replaced by what it
 * cost. A day is a UTC day. The ledger is kept through `spend`, which the command line backs with
 * the state file, so a restart does not forget what was spent.
 *
 * ONE AT A TIME. One transaction is in flight at a time, so nonces never race. When a transaction
 * has not been mined by the time `send` stops waiting, it is remembered (through `memory`, so a
 * restart remembers it too). The next `send`:
 * - if the remembered transaction has been mined meanwhile and was the same call, answers with it;
 * - if it is the same call and still waiting, replaces it under the same nonce with both fees
 *   raised by an eighth, as long as the limits allow;
 * - if it is another call, refuses (`pending`), so nothing queues behind a stuck transaction.
 * A waiting transaction of this wallet that the keeper did not send (the operator used the wallet
 * by hand) is never replaced: the keeper waits for it and says so.
 */
import type { Abi, Address, Hex, Log } from "viem";
import type { Logger } from "./log.js";

export interface ChainCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** A few words for the log: "request payrolls". */
  label: string;
  /** The least gas to send with; see `Action.gasFloor`. */
  gasFloor?: bigint;
}

export type WriteOutcome =
  | {
      kind: "sent";
      label: string;
      hash: Hex;
      blockNumber: bigint;
      gasUsed: bigint;
      /** What the transaction cost, in wei. */
      cost: bigint;
      logs: readonly Log[];
    }
  /** `wouldSucceed` is null when no address was configured to simulate from. */
  | { kind: "dry-run"; label: string; wouldSucceed: boolean | null; reason?: string };

export type ChainWriteErrorCode =
  | "killed"
  | "no_wallet"
  | "simulation_reverted"
  | "fee_too_high"
  | "cost_too_high"
  /** Sending it could take today's spending over the daily cap. */
  | "daily_cap"
  | "tx_reverted"
  /** A transaction is waiting to be mined; this call was not sent, or was sent and is not mined yet. */
  | "pending";

/** Failures after which nothing else can be sent in the same pass either. */
export const STOPS_THE_PASS: readonly ChainWriteErrorCode[] = [
  "killed",
  "no_wallet",
  "fee_too_high",
  "daily_cap",
  "pending",
];

export class ChainWriteError extends Error {
  readonly code: ChainWriteErrorCode;

  constructor(code: ChainWriteErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ChainWriteError";
    this.code = code;
  }
}

interface CallArgs {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  account: Address;
}

export interface MinedReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  /** What each unit of gas was charged. Absent on nodes that do not report it. */
  effectiveGasPrice?: bigint | null;
  logs: readonly Log[];
}

/** The part of a viem public client the writer uses. */
export interface PublicLike {
  simulateContract(args: CallArgs): Promise<unknown>;
  estimateContractGas(args: CallArgs): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint | null; maxPriorityFeePerGas?: bigint | null }>;
  waitForTransactionReceipt(args: { hash: Hex; timeout?: number }): Promise<MinedReceipt>;
  /** Throws, or answers null, while the transaction is not mined. */
  getTransactionReceipt(args: { hash: Hex }): Promise<MinedReceipt | null>;
  getTransactionCount(args: { address: Address; blockTag: "latest" | "pending" }): Promise<number>;
}

/** The part of a viem wallet client the writer uses. */
export interface WalletLike {
  writeContract(
    args: Omit<CallArgs, "account"> & {
      gas: bigint;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
      nonce: number;
    },
  ): Promise<Hex>;
}

/** Today's spending on gas, and the cap on it. */
export interface SpendLimit {
  /** The most the wallet may spend on gas in one UTC day, in wei. */
  cap: bigint;
  /** What has been spent or set aside today, in wei. */
  spentToday(): bigint;
  /** Adds to today's figure. Negative gives back part of a reservation. */
  add(wei: bigint): void;
}

export interface ChainWriterOptions {
  mode: "live" | "dry-run";
  public: PublicLike;
  /** Present in live mode only. */
  wallet: WalletLike | null;
  /** The address calls are simulated from. */
  account: Address | null;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxTxCost: bigint;
  spend: SpendLimit;
  killed: () => boolean;
  log: Logger;
  /** How long `send` waits for a receipt before it leaves the transaction to the next call. */
  receiptTimeoutMs?: number;
  /** Keeps the waiting transaction across restarts. Without it, it is kept in the process only. */
  memory?: PendingMemory;
}

/** A transaction that was sent and not yet seen mined. Plain strings, so it can be stored. */
export interface PendingTx {
  key: string;
  label: string;
  /** Every version sent under this nonce, oldest first: any of them may be the one that mines. */
  hashes: Hex[];
  nonce: number;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  /** What was set aside against the daily cap for it, in wei. */
  reserved: string;
}

/** Where the waiting transaction is kept between calls, and between runs. */
export interface PendingMemory {
  get(): PendingTx | null;
  set(pending: PendingTx | null): void;
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: string }).shortMessage;
    return (short ?? error.message).slice(0, 300);
  }
  return String(error).slice(0, 300);
}

/** What identifies a call: where it goes and what it says. Two sends of one step have one key. */
function keyOf(call: ChainCall): string {
  const args = JSON.stringify(call.args, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  return `${call.address.toLowerCase()}:${call.functionName}:${args}`;
}

/** A replacement must raise both fees by at least a tenth; an eighth leaves room for rounding. */
function bumped(fee: bigint): bigint {
  const next = (fee * 1125n + 999n) / 1000n;
  return next > fee ? next : fee + 1n;
}

export class ChainWriter {
  readonly #o: ChainWriterOptions;
  #queue: Promise<unknown> = Promise.resolve();
  #kept: PendingTx | null = null;

  constructor(options: ChainWriterOptions) {
    if (options.mode === "live" && (options.wallet === null || options.account === null)) {
      throw new ChainWriteError("no_wallet", "live mode needs a wallet");
    }
    this.#o = options;
  }

  get mode(): "live" | "dry-run" {
    return this.#o.mode;
  }

  #pending(): PendingTx | null {
    return this.#o.memory ? this.#o.memory.get() : this.#kept;
  }

  #remember(pending: PendingTx | null): void {
    if (this.#o.memory) this.#o.memory.set(pending);
    else this.#kept = pending;
  }

  /** Sends one call, after the checks above. Calls are queued and run one at a time. */
  send(call: ChainCall): Promise<WriteOutcome> {
    const run = this.#queue.then(() => this.#send(call));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** The transaction that is still waiting to be mined, if there is one, after a fresh look. */
  async waiting(): Promise<PendingTx | null> {
    if (this.#o.mode === "dry-run") return null;
    const seen = await this.#lookAtPending();
    if (seen.state === "mined") {
      this.#o.log.info("an earlier transaction has been mined", {
        label: seen.was.label,
        hash: seen.hash,
        status: seen.receipt.status,
      });
    }
    return seen.state === "waiting" ? seen.tx : null;
  }

  /** The receipt of a transaction, or null while there is none to be had. */
  async #receiptOf(hash: Hex): Promise<MinedReceipt | null> {
    try {
      return await this.#o.public.getTransactionReceipt({ hash });
    } catch {
      // "Not found" and "could not ask" both mean: not known to be mined.
      return null;
    }
  }

  /** What a mined transaction cost. Without a reported price, the ceiling it was sent with. */
  #costOf(receipt: MinedReceipt, ceiling: bigint): bigint {
    const price = receipt.effectiveGasPrice ?? ceiling;
    return receipt.gasUsed * price;
  }

  #done(label: string, hash: Hex, receipt: MinedReceipt, cost: bigint): WriteOutcome {
    if (receipt.status !== "success") {
      throw new ChainWriteError("tx_reverted", `"${label}" reverted on chain in ${hash}`);
    }
    this.#o.log.info("transaction mined", {
      label,
      hash,
      block: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      cost: cost.toString(),
    });
    return {
      kind: "sent",
      label,
      hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      cost,
      logs: receipt.logs,
    };
  }

  /**
   * What became of the transaction sent before: `mined` with its receipt, `gone` when its nonce
   * was used by something else, or `waiting`. Forgets it unless it is still waiting, and puts the
   * day's spending right: what a mined one cost, nothing for one that is gone.
   */
  async #lookAtPending(): Promise<
    | { state: "none" }
    | { state: "mined"; was: PendingTx; hash: Hex; receipt: MinedReceipt; cost: bigint }
    | { state: "gone"; was: PendingTx }
    | { state: "waiting"; tx: PendingTx }
  > {
    const o = this.#o;
    const waiting = this.#pending();
    if (waiting === null || o.account === null) return { state: "none" };
    // Any version sent under the nonce may be the one that was mined.
    for (const hash of [...waiting.hashes].reverse()) {
      const receipt = await this.#receiptOf(hash);
      if (receipt === null) continue;
      const cost = this.#costOf(receipt, BigInt(waiting.maxFeePerGas));
      o.spend.add(cost - BigInt(waiting.reserved));
      this.#remember(null);
      return { state: "mined", was: waiting, hash, receipt, cost };
    }
    const mined = await o.public.getTransactionCount({ address: o.account, blockTag: "latest" });
    if (mined > waiting.nonce) {
      // The nonce was used and no receipt of ours shows: something else took it.
      o.log.warn("the nonce of a waiting transaction was used by another one", {
        label: waiting.label,
        nonce: waiting.nonce,
      });
      o.spend.add(-BigInt(waiting.reserved));
      this.#remember(null);
      return { state: "gone", was: waiting };
    }
    return { state: "waiting", tx: waiting };
  }

  /**
   * Looks at the transaction sent before. Returns its outcome when it was this call and has been
   * mined; the waiting transaction when this call should replace it; null when the way is clear.
   * Throws `pending` when another call's transaction is still waiting.
   */
  async #settlePending(call: ChainCall, key: string): Promise<WriteOutcome | PendingTx | null> {
    const seen = await this.#lookAtPending();
    if (seen.state === "none" || seen.state === "gone") {
      // Gone: start afresh; the simulation that follows says whether the step is still needed.
      return null;
    }
    if (seen.state === "mined") {
      // If it was this very call, the step is done; simulating it again would only say so.
      if (seen.was.key === key) return this.#done(seen.was.label, seen.hash, seen.receipt, seen.cost);
      // Another call's transaction: its outcome shows on chain at the next look. Here it only
      // matters that the nonce is free again.
      this.#o.log.info("an earlier transaction has been mined", {
        label: seen.was.label,
        hash: seen.hash,
        status: seen.receipt.status,
      });
      return null;
    }
    if (seen.tx.key !== key) {
      throw new ChainWriteError(
        "pending",
        `"${seen.tx.label}" (${seen.tx.hashes.at(-1)}) is still waiting to be mined; not sending "${call.label}" behind it`,
      );
    }
    return seen.tx;
  }

  async #send(call: ChainCall): Promise<WriteOutcome> {
    const o = this.#o;
    if (o.killed()) throw new ChainWriteError("killed", `kill switch is on; not sending "${call.label}"`);
    const key = keyOf(call);

    let replace: PendingTx | null = null;
    if (o.mode === "live") {
      const before = await this.#settlePending(call, key);
      if (before !== null && "kind" in before) return before;
      replace = before;
    }

    const base = { address: call.address, abi: call.abi, functionName: call.functionName, args: call.args };
    let simulated: boolean | null = null;
    let simulationFailure: string | undefined;
    if (o.account !== null) {
      try {
        await o.public.simulateContract({ ...base, account: o.account });
        simulated = true;
      } catch (error) {
        simulated = false;
        simulationFailure = reasonOf(error);
      }
    }

    if (o.mode === "dry-run") {
      o.log.info("dry run: would send a transaction", {
        label: call.label,
        to: call.address,
        function: call.functionName,
        wouldSucceed: simulated,
        ...(simulationFailure === undefined ? {} : { reason: simulationFailure }),
      });
      return simulationFailure === undefined
        ? { kind: "dry-run", label: call.label, wouldSucceed: simulated }
        : { kind: "dry-run", label: call.label, wouldSucceed: simulated, reason: simulationFailure };
    }

    if (o.wallet === null || o.account === null)
      throw new ChainWriteError("no_wallet", "no wallet in live mode");
    if (simulated !== true) {
      throw new ChainWriteError(
        "simulation_reverted",
        `"${call.label}" would revert: ${simulationFailure ?? "unknown"}`,
      );
    }

    const fees = await o.public.estimateFeesPerGas();
    const marketFee = fees.maxFeePerGas ?? 0n;
    if (marketFee <= 0n) throw new ChainWriteError("fee_too_high", "the node gave no fee estimate");
    if (marketFee > o.maxFeePerGas) {
      throw new ChainWriteError(
        "fee_too_high",
        `the network asks ${marketFee} wei per gas; the cap is ${o.maxFeePerGas}`,
      );
    }
    const marketTip = fees.maxPriorityFeePerGas ?? 0n;

    const estimate = await o.public.estimateContractGas({ ...base, account: o.account });
    let gas = (estimate * 12n) / 10n + 10_000n;
    if (call.gasFloor !== undefined && gas < call.gasFloor) gas = call.gasFloor;
    if (gas * marketFee > o.maxTxCost) {
      throw new ChainWriteError(
        "cost_too_high",
        `"${call.label}" would cost about ${gas * marketFee} wei at the current fee; the limit is ${o.maxTxCost}`,
      );
    }
    // The highest ceiling both limits allow. It is at least the current fee: both were checked.
    const affordable = o.maxTxCost / gas;
    const ceiling = affordable < o.maxFeePerGas ? affordable : o.maxFeePerGas;
    const tipCap = o.maxPriorityFeePerGas < ceiling ? o.maxPriorityFeePerGas : ceiling;

    let maxFeePerGas = marketFee * 2n < ceiling ? marketFee * 2n : ceiling;
    let maxPriorityFeePerGas = marketTip < tipCap ? marketTip : tipCap;
    let nonce: number;
    if (replace !== null) {
      // The same step again while its transaction waits: both fees up by an eighth, same nonce.
      const fee = bumped(BigInt(replace.maxFeePerGas));
      const tip = bumped(BigInt(replace.maxPriorityFeePerGas));
      if (fee > maxFeePerGas) maxFeePerGas = fee;
      if (tip > maxPriorityFeePerGas) maxPriorityFeePerGas = tip;
      if (maxFeePerGas > ceiling || maxPriorityFeePerGas > tipCap) {
        throw new ChainWriteError(
          "pending",
          `"${replace.label}" (${replace.hashes.at(-1)}) is waiting to be mined and its fee cannot be raised within the limits`,
        );
      }
      nonce = replace.nonce;
    } else {
      const [mined, queued] = await Promise.all([
        o.public.getTransactionCount({ address: o.account, blockTag: "latest" }),
        o.public.getTransactionCount({ address: o.account, blockTag: "pending" }),
      ]);
      if (queued > mined) {
        // The operator, or another program, sent something from this wallet that is still waiting.
        // The keeper does not know what it is and does not replace it.
        throw new ChainWriteError(
          "pending",
          `this wallet has a transaction waiting under nonce ${mined} that the keeper did not send; ` +
            `not sending "${call.label}" behind it`,
        );
      }
      nonce = mined;
    }
    if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;

    // The daily cap, on the worst case: every unit of gas used and charged at the ceiling. A
    // replacement spends under the nonce its first version already set money aside for, so only
    // what it could cost beyond that is new.
    const worst = gas * maxFeePerGas;
    const already = replace === null ? 0n : BigInt(replace.reserved);
    const extra = worst > already ? worst - already : 0n;
    const spent = o.spend.spentToday();
    if (spent + extra > o.spend.cap) {
      throw new ChainWriteError(
        "daily_cap",
        `"${call.label}" could cost ${worst} wei; ${spent} of today's ${o.spend.cap} are spent or set aside`,
      );
    }

    // The kill switch may have been thrown while the estimates were in flight.
    if (o.killed()) throw new ChainWriteError("killed", `kill switch is on; not sending "${call.label}"`);

    const hash = await o.wallet.writeContract({ ...base, gas, maxFeePerGas, maxPriorityFeePerGas, nonce });
    const reserved = worst > already ? worst : already;
    o.spend.add(extra);
    this.#remember({
      key,
      label: call.label,
      hashes: [...(replace?.hashes ?? []), hash],
      nonce,
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      reserved: reserved.toString(),
    });
    o.log.info(replace === null ? "transaction sent" : "transaction replaced at a higher fee", {
      label: call.label,
      hash,
      nonce,
      gas: gas.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      ...(replace === null ? {} : { replaces: replace.hashes.at(-1) }),
    });

    let receipt: MinedReceipt;
    try {
      receipt = await o.public.waitForTransactionReceipt({ hash, timeout: o.receiptTimeoutMs ?? 120_000 });
    } catch (error) {
      // Not mined in time, or the node stopped answering. The transaction stays remembered, with
      // its reservation: the next call of this step picks it up or raises its fee, and nothing
      // else is sent behind it.
      throw new ChainWriteError(
        "pending",
        `"${call.label}" was sent as ${hash} and is not mined yet (${reasonOf(error)})`,
      );
    }
    const cost = this.#costOf(receipt, maxFeePerGas);
    o.spend.add(cost - reserved);
    this.#remember(null);
    return this.#done(call.label, hash, receipt, cost);
  }
}
