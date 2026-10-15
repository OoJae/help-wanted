import { encodeEventTopics, type Abi, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { erc20Abi, workOrdersAbi, workProofAbi } from "@help-wanted/shared";
import {
  ChainWriteError,
  ChainWriter,
  type ChainCall,
  type MinedReceipt,
  type PendingTx,
  type PublicLike,
  type WalletLike,
} from "../src/chain.js";
import { viemDesk, type ReaderLike } from "../src/desk.js";
import { memoryLogger } from "../src/log.js";
import { DESK, RUNNER } from "./world.js";

const GWEI = 10n ** 9n;
const CALL: ChainCall = {
  address: DESK,
  abi: workOrdersAbi as unknown as Abi,
  functionName: "claim",
  args: [7n],
  label: "claim order 7",
};
const hashOf = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

interface Sent {
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonce: number;
  functionName: string;
}

/** A chain as the writer sees it. `mines` decides whether a sent transaction is mined at once. */
function chain(
  options: {
    reverts?: string;
    fee?: bigint;
    tip?: bigint;
    gas?: bigint;
    status?: "success" | "reverted";
  } = {},
) {
  const events: string[] = [];
  const sent: Sent[] = [];
  const state = {
    fee: options.fee ?? GWEI,
    tip: options.tip ?? GWEI / 100n,
    /** Whether a transaction is mined while `send` waits for it. */
    mines: true,
    /** Transactions mined so far, by hash. */
    receipts: new Map<Hex, MinedReceipt>(),
    /** The wallet's nonce as the newest block has it, and as the pool has it. */
    minedNonce: 5,
    poolNonce: 5,
    waitFails: null as string | null,
  };
  const mine = (hash: Hex, status: "success" | "reverted" = options.status ?? "success") => {
    state.receipts.set(hash, { status, blockNumber: 123n, gasUsed: 90_000n, logs: [] });
    state.minedNonce += 1;
    state.poolNonce = Math.max(state.poolNonce, state.minedNonce);
  };
  const pub: PublicLike = {
    async simulateContract(args) {
      events.push(`simulate ${args.functionName} from ${args.account}`);
      if (options.reverts) throw Object.assign(new Error("long text"), { shortMessage: options.reverts });
      return {};
    },
    async estimateContractGas() {
      events.push("estimateGas");
      return options.gas ?? 100_000n;
    },
    async estimateFeesPerGas() {
      events.push("fees");
      return { maxFeePerGas: state.fee, maxPriorityFeePerGas: state.tip };
    },
    async waitForTransactionReceipt({ hash }) {
      events.push(`wait ${hash}`);
      if (state.waitFails !== null) throw new Error(state.waitFails);
      if (!state.mines) throw new Error("Timed out while waiting for transaction");
      mine(hash);
      return state.receipts.get(hash) as MinedReceipt;
    },
    async getTransactionReceipt({ hash }) {
      const receipt = state.receipts.get(hash);
      if (!receipt) throw new Error("TransactionReceiptNotFoundError");
      return receipt;
    },
    async getTransactionCount({ blockTag }) {
      return blockTag === "latest" ? state.minedNonce : state.poolNonce;
    },
  };
  const wallet: WalletLike = {
    async writeContract(args) {
      events.push(`write ${args.functionName}`);
      sent.push(args);
      state.poolNonce = Math.max(state.poolNonce, args.nonce + 1);
      return hashOf(sent.length);
    },
  };
  return { pub, wallet, events, sent, state, mine };
}

function writer(
  c: ReturnType<typeof chain>,
  overrides: Partial<ConstructorParameters<typeof ChainWriter>[0]> = {},
) {
  const log = memoryLogger();
  const w = new ChainWriter({
    mode: "live",
    public: c.pub,
    wallet: c.wallet,
    account: RUNNER,
    maxFeePerGas: 3n * GWEI,
    maxPriorityFeePerGas: GWEI / 10n,
    maxTxCost: 5n * 10n ** 15n,
    urgent: { maxFeePerGas: 30n * GWEI, maxTxCost: 2n * 10n ** 16n },
    killed: () => false,
    log,
    ...overrides,
  });
  return { w, log };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ChainWriteError) return error.code;
    throw error;
  }
  return "no error";
}

describe("the chain writer", () => {
  it("refuses a call that needs more gas than the limit set for it, whatever the fee", async () => {
    // A settlement's limit comes from an estimate (here 2.6M, sent as 3.13M with its margin).
    const c = chain({ gas: 2_600_000n, fee: GWEI / 10n });
    const { w } = writer(c);
    expect(await codeOf(w.send({ ...CALL, gasCap: 3_000_000n }))).toBe("gas_over_limit");
    expect(c.sent).toEqual([]);
    // Within the cap it goes out with the estimate and its margin, never a figure set by hand.
    const ok = chain({ gas: 1_500_000n, fee: GWEI / 10n });
    const sent = writer(ok);
    expect((await sent.w.send({ ...CALL, gasCap: 3_000_000n })).kind).toBe("sent");
    expect(ok.sent[0]?.gas).toBe(1_810_000n);
    // A call with no cap is bounded by the cost limit alone.
    const free = chain({ gas: 2_600_000n, fee: GWEI / 10n });
    expect((await writer(free).w.send(CALL)).kind).toBe("sent");
  });

  it("simulates, checks the fee and the cost, sends, and waits for the receipt, in that order", async () => {
    const c = chain();
    const { w } = writer(c);
    const outcome = await w.send(CALL);
    expect(outcome.kind).toBe("sent");
    expect(c.events).toEqual([
      `simulate claim from ${RUNNER}`,
      "fees",
      "estimateGas",
      "write claim",
      `wait ${hashOf(1)}`,
    ]);
    expect(c.sent[0]).toMatchObject({ gas: 130_000n, maxPriorityFeePerGas: GWEI / 100n, nonce: 5 });
  });

  it("does not send a call that would revert", async () => {
    const c = chain({ reverts: 'The contract function "claim" reverted: BadState()' });
    const { w } = writer(c);
    await expect(w.send(CALL)).rejects.toThrow("BadState()");
    expect(await codeOf(w.send(CALL))).toBe("simulation_reverted");
    expect(c.sent).toEqual([]);
  });

  it("does not send above the fee cap", async () => {
    const c = chain({ fee: 4n * GWEI });
    const { w } = writer(c);
    expect(await codeOf(w.send(CALL))).toBe("fee_too_high");
    expect(c.sent).toEqual([]);
    // At the cap exactly it goes, with the cap as its ceiling.
    const at = chain({ fee: 3n * GWEI });
    expect((await writer(at).w.send(CALL)).kind).toBe("sent");
    expect(at.sent[0]?.maxFeePerGas).toBe(3n * GWEI);
  });

  it("gives the transaction room for the base fee to rise: twice the current fee, within the cap", async () => {
    // A ceiling equal to the estimate is left behind as soon as the base fee moves by a fifth.
    const calm = chain({ fee: GWEI });
    await writer(calm).w.send(CALL);
    expect(calm.sent[0]?.maxFeePerGas).toBe(2n * GWEI);
    const busy = chain({ fee: 2n * GWEI });
    await writer(busy).w.send(CALL);
    expect(busy.sent[0]?.maxFeePerGas).toBe(3n * GWEI); // the cap
  });

  it("never lets the ceiling take the transaction over the cost limit", async () => {
    // 1,000,000 gas (1,210,000 with the margin) at 1 gwei is 0.00121 ETH: allowed. Twice the fee
    // would be 0.00242, still allowed; the limit of 0.005 ETH caps the ceiling at about 4.13 gwei,
    // and the fee cap of 3 gwei is lower still.
    const c = chain({ gas: 1_000_000n, fee: GWEI });
    await writer(c).w.send(CALL);
    expect(c.sent[0]?.gas).toBe(1_210_000n);
    expect(c.sent[0]?.maxFeePerGas).toBe(2n * GWEI);
    // 2,000,000 gas: the limit allows 2.066 gwei per gas, less than twice the fee.
    const heavy = chain({ gas: 2_000_000n, fee: 15n * (GWEI / 10n) });
    await writer(heavy).w.send(CALL);
    const sentFee = heavy.sent[0]?.maxFeePerGas ?? 0n;
    expect(sentFee * 2_410_000n).toBeLessThanOrEqual(5n * 10n ** 15n);
    expect(sentFee).toBeGreaterThanOrEqual(15n * (GWEI / 10n));
    expect(sentFee).toBeLessThan(3n * GWEI);
  });

  it("never pays a priority fee above its cap", async () => {
    const c = chain({ tip: 2n * GWEI });
    const { w } = writer(c);
    await w.send(CALL);
    expect(c.sent[0]?.maxPriorityFeePerGas).toBe(GWEI / 10n);
  });

  it("does not send a transaction that would cost more than the limit at the current fee", async () => {
    // 3,000,000 gas at 3 gwei is 0.0108 ETH with the margin, above the 0.005 limit.
    const c = chain({ gas: 3_000_000n, fee: 3n * GWEI });
    const { w } = writer(c);
    expect(await codeOf(w.send(CALL))).toBe("cost_too_high");
    expect(c.sent).toEqual([]);
  });

  it("refuses when the node gives no fee", async () => {
    const c = chain({ fee: 0n });
    expect(await codeOf(writer(c).w.send(CALL))).toBe("fee_too_high");
  });

  it("fails loudly when the transaction reverts on chain", async () => {
    const c = chain({ status: "reverted" });
    expect(await codeOf(writer(c).w.send(CALL))).toBe("tx_reverted");
  });

  it("sends nothing while the kill switch is on, not even a simulation", async () => {
    const c = chain();
    let killed = true;
    const { w } = writer(c, { killed: () => killed });
    expect(await codeOf(w.send(CALL))).toBe("killed");
    expect(c.events).toEqual([]);
    killed = false;
    expect((await w.send(CALL)).kind).toBe("sent");
  });

  it("checks the kill switch again just before sending", async () => {
    const c = chain();
    let calls = 0;
    const { w } = writer(c, { killed: () => ++calls > 1 });
    expect(await codeOf(w.send(CALL))).toBe("killed");
    expect(c.sent).toEqual([]);
  });

  it("in dry-run it simulates, says what it would send, and sends nothing", async () => {
    const c = chain();
    const { w, log } = writer(c, { mode: "dry-run", wallet: null });
    const outcome = await w.send(CALL);
    expect(outcome).toEqual({ kind: "dry-run", label: "claim order 7", wouldSucceed: true });
    expect(c.events).toEqual([`simulate claim from ${RUNNER}`]);
    expect(log.lines.join("\n")).toContain("dry run: would send a transaction");

    const failing = chain({ reverts: "BadState()" });
    const dry = await writer(failing, { mode: "dry-run", wallet: null }).w.send(CALL);
    expect(dry).toEqual({
      kind: "dry-run",
      label: "claim order 7",
      wouldSucceed: false,
      reason: "BadState()",
    });
    expect(failing.sent).toEqual([]);
  });

  it("in dry-run with no address it does not even simulate", async () => {
    const c = chain();
    const { w } = writer(c, { mode: "dry-run", wallet: null, account: null });
    expect(await w.send(CALL)).toEqual({ kind: "dry-run", label: "claim order 7", wouldSucceed: null });
    expect(c.events).toEqual([]);
  });

  it("cannot be built live without a wallet", () => {
    const c = chain();
    expect(() => writer(c, { wallet: null })).toThrow(ChainWriteError);
    expect(() => writer(c, { account: null })).toThrow(ChainWriteError);
  });

  it("runs one transaction at a time, in the order asked, each under its own nonce", async () => {
    const c = chain();
    const { w } = writer(c);
    await Promise.all([
      w.send({ ...CALL, label: "a" }),
      w.send({ ...CALL, functionName: "release", label: "b" }),
    ]);
    const writes = c.events.filter((e) => e.startsWith("write") || e.startsWith("wait"));
    expect(writes).toEqual(["write claim", `wait ${hashOf(1)}`, "write release", `wait ${hashOf(2)}`]);
    expect(c.sent.map((s) => s.nonce)).toEqual([5, 6]);
  });

  it("a failed transaction does not jam the queue", async () => {
    const c = chain({ fee: 9n * GWEI });
    const { w } = writer(c);
    expect(await codeOf(w.send(CALL))).toBe("fee_too_high");
    expect(await codeOf(w.send(CALL))).toBe("fee_too_high");
  });
});

describe("calls that protect a bond", () => {
  const URGENT: ChainCall = { ...CALL, functionName: "register", label: "register job", urgent: true };

  it("go out at fees an ordinary call is refused at", async () => {
    const c = chain({ fee: 10n * GWEI });
    const { w } = writer(c);
    expect(await codeOf(w.send(CALL))).toBe("fee_too_high");
    expect((await w.send(URGENT)).kind).toBe("sent");
    expect(c.sent[0]?.maxFeePerGas).toBe(20n * GWEI);
  });

  it("are still refused above their own cap and their own cost limit", async () => {
    const c = chain({ fee: 31n * GWEI });
    expect(await codeOf(writer(c).w.send(URGENT))).toBe("fee_too_high");
    const heavy = chain({ fee: 20n * GWEI, gas: 1_000_000n }); // 0.0242 ETH at the current fee
    expect(await codeOf(writer(heavy).w.send(URGENT))).toBe("cost_too_high");
  });

  it("fall back on the ordinary limits when no others are given", async () => {
    const c = chain({ fee: 10n * GWEI });
    const { w } = writer(c, { urgent: undefined });
    expect(await codeOf(w.send(URGENT))).toBe("fee_too_high");
  });

  it("can be asked about before a payment is signed", async () => {
    const calm = writer(chain({ fee: 10n * GWEI })).w;
    expect(await calm.cannotSend(true)).toBeNull();
    expect(await calm.cannotSend(false)).toContain("the cap is");
    const high = writer(chain({ fee: 40n * GWEI })).w;
    expect(await high.cannotSend(true)).toContain("the cap is");
    const killed = writer(chain(), { killed: () => true }).w;
    expect(await killed.cannotSend(true)).toContain("kill switch");
    const dry = writer(chain({ fee: 99n * GWEI }), { mode: "dry-run", wallet: null }).w;
    expect(await dry.cannotSend(true)).toBeNull();
  });
});

describe("a transaction that is not mined in time", () => {
  it("is reported as pending, remembered, and nothing else is sent behind it", async () => {
    const c = chain();
    c.state.mines = false;
    const { w } = writer(c);
    expect(await codeOf(w.send(CALL))).toBe("pending");
    expect(c.sent).toHaveLength(1);
    // Another step's transaction would queue under the next nonce and wait behind the stuck one.
    const other: ChainCall = { ...CALL, functionName: "release", label: "release order 9", args: [9n] };
    expect(await codeOf(w.send(other))).toBe("pending");
    expect(c.sent).toHaveLength(1);
    expect(await w.cannotSend(true)).toContain("still waiting to be mined");
  });

  it("is replaced under the same nonce at a higher fee when its step comes round again", async () => {
    const c = chain();
    c.state.mines = false;
    const { w, log } = writer(c);
    expect(await codeOf(w.send(CALL))).toBe("pending");
    expect(await codeOf(w.send(CALL))).toBe("pending");
    expect(c.sent).toHaveLength(2);
    const [first, second] = c.sent as [Sent, Sent];
    expect(second.nonce).toBe(first.nonce);
    // A node replaces a waiting transaction only if both fees rise by a tenth or more.
    expect(second.maxFeePerGas * 10n).toBeGreaterThanOrEqual(first.maxFeePerGas * 11n);
    expect(second.maxPriorityFeePerGas * 10n).toBeGreaterThanOrEqual(first.maxPriorityFeePerGas * 11n);
    expect(log.lines.some((l) => l.includes("transaction replaced at a higher fee"))).toBe(true);
    // The step never went out twice: only the one nonce was ever used.
    expect(new Set(c.sent.map((s) => s.nonce)).size).toBe(1);
  });

  it("is answered with, not sent again, when it was mined in the meantime", async () => {
    const c = chain();
    c.state.mines = false;
    const { w } = writer(c);
    expect(await codeOf(w.send(CALL))).toBe("pending");
    c.mine(hashOf(1)); // mined after `send` stopped waiting
    const outcome = await w.send(CALL);
    expect(outcome).toMatchObject({ kind: "sent", hash: hashOf(1), blockNumber: 123n });
    expect(c.sent).toHaveLength(1);
    // And the way is clear for the next step.
    c.state.mines = true;
    expect((await w.send({ ...CALL, functionName: "release", label: "release" })).kind).toBe("sent");
    expect(c.sent.map((s) => s.nonce)).toEqual([5, 6]);
  });

  it("is found whichever version of it was mined", async () => {
    const c = chain();
    c.state.mines = false;
    const { w } = writer(c);
    await codeOf(w.send(CALL));
    await codeOf(w.send(CALL)); // replaced: two hashes under one nonce
    c.mine(hashOf(1)); // the older one is the one that was mined
    expect(await w.send(CALL)).toMatchObject({ kind: "sent", hash: hashOf(1) });
    expect(c.sent).toHaveLength(2);
  });

  it("lets another step through once it has been mined", async () => {
    const c = chain();
    c.state.mines = false;
    const { w } = writer(c);
    await codeOf(w.send(CALL));
    c.mine(hashOf(1));
    c.state.mines = true;
    const other: ChainCall = { ...CALL, functionName: "release", label: "release order 9", args: [9n] };
    expect((await w.send(other)).kind).toBe("sent");
    expect(c.sent.map((s) => `${s.functionName}@${s.nonce}`)).toEqual(["claim@5", "release@6"]);
  });

  it("is noticed as mined when the runner only asks whether it could send", async () => {
    // After a claim that timed out and was then mined, the next thing due is a payment, not a
    // transaction. If only `send` looked at the waiting transaction, the payment would wait on it
    // for ever.
    const c = chain();
    c.state.mines = false;
    const { w } = writer(c);
    await codeOf(w.send(CALL));
    expect(await w.cannotSend(true)).toContain("still waiting to be mined");
    c.mine(hashOf(1));
    expect(await w.cannotSend(true)).toBeNull();
    // And it is forgotten: the next step goes out under the next nonce.
    c.state.mines = true;
    expect((await w.send({ ...CALL, functionName: "release", label: "release" })).kind).toBe("sent");
    expect(c.sent.map((s) => s.nonce)).toEqual([5, 6]);
  });

  it("is not raised past the limits: the runner waits and says why", async () => {
    const c = chain({ fee: 3n * GWEI }); // already at the cap
    c.state.mines = false;
    const { w } = writer(c);
    expect(await codeOf(w.send(CALL))).toBe("pending");
    await expect(w.send(CALL)).rejects.toThrow("cannot be raised within the limits");
    expect(c.sent).toHaveLength(1);
  });

  it("is forgotten when something else used its nonce", async () => {
    const c = chain();
    c.state.mines = false;
    const { w, log } = writer(c);
    await codeOf(w.send(CALL));
    c.state.minedNonce = 6; // the nonce was consumed, and by none of ours
    c.state.poolNonce = 6;
    c.state.mines = true;
    expect((await w.send(CALL)).kind).toBe("sent");
    expect(c.sent.map((s) => s.nonce)).toEqual([5, 6]);
    expect(log.lines.some((l) => l.includes("was used by another one"))).toBe(true);
  });

  it("is remembered across a restart when the writer is given somewhere to keep it", async () => {
    const c = chain();
    c.state.mines = false;
    let kept: PendingTx | null = null;
    const memory = { get: () => kept, set: (p: PendingTx | null) => void (kept = p) };
    expect(await codeOf(writer(c, { memory }).w.send(CALL))).toBe("pending");
    expect(kept).toMatchObject({ label: "claim order 7", nonce: 5, hashes: [hashOf(1)] });

    // A new process. Without the memory it would send the step again under the next nonce.
    const again = writer(c, { memory }).w;
    expect(await codeOf(again.send({ ...CALL, functionName: "release", label: "release" }))).toBe("pending");
    c.mine(hashOf(1));
    expect(await again.send(CALL)).toMatchObject({ kind: "sent", hash: hashOf(1) });
    expect(kept).toBeNull();
    expect(c.sent).toHaveLength(1);
  });

  it("is also what a lost connection during the wait leaves behind", async () => {
    const c = chain();
    c.state.waitFails = "fetch failed";
    const { w } = writer(c);
    await expect(w.send(CALL)).rejects.toThrow("is not mined yet (fetch failed)");
    c.mine(hashOf(1)); // it was mined all the same
    c.state.waitFails = null;
    expect(await w.send(CALL)).toMatchObject({ kind: "sent", hash: hashOf(1) });
    expect(c.sent).toHaveLength(1);
  });
});

describe("a transaction of this wallet that the runner did not send", () => {
  it("is waited for and never replaced", async () => {
    const c = chain();
    c.state.poolNonce = 6; // something sits in the pool under nonce 5
    const { w } = writer(c);
    await expect(w.send(CALL)).rejects.toThrow("that the runner did not send");
    expect(await codeOf(w.send(CALL))).toBe("pending");
    expect(c.sent).toEqual([]);
    c.state.minedNonce = 6; // it was mined
    expect((await w.send(CALL)).kind).toBe("sent");
    expect(c.sent[0]?.nonce).toBe(6);
  });
});

describe("the desk over a chain client", () => {
  it("encodes each write as the contract declares it, and sends it through the writer", async () => {
    const c = chain();
    const { w } = writer(c);
    const seen: {
      functionName: string;
      args: readonly unknown[];
      address: string;
      urgent: boolean;
      gasCap?: bigint;
    }[] = [];
    const spy = new Proxy(w, {
      get(target, prop) {
        if (prop !== "send") {
          // The writer keeps its state in private fields: its own methods must run on the writer.
          const value: unknown = Reflect.get(target, prop);
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        }
        return (call: ChainCall) => {
          seen.push({
            functionName: call.functionName,
            args: call.args,
            address: call.address,
            urgent: call.urgent === true,
            ...(call.gasCap === undefined ? {} : { gasCap: call.gasCap }),
          });
          return target.send(call);
        };
      },
    });
    const reader: ReaderLike = {
      getBlockNumber: async () => 1n,
      getBalance: async () => 0n,
      readContract: async () => 0n,
      getContractEvents: async () => [],
    };
    const imd = "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7";
    const desk = viemDesk(
      reader,
      spy,
      { workOrders: DESK, imd, workRegistry: "0xb6d0a187b050FA5Bb0B87033a203f37BECF4a775" },
      RUNNER,
    );
    const job = "e9efec16-56f3-40d3-9243-52c453effc7d";
    const record = new Uint8Array([0x7b, 0x7d]);
    await desk.approveImd(DESK, 5n);
    await desk.claim(7n);
    await desk.register(7n, job);
    await desk.settle(7n, record);
    await desk.claimDelivered(7n, `0x${"11".repeat(32)}`);
    await desk.finalize(7n);
    await desk.release(7n);
    await desk.reportFailed(7n, record);
    await desk.trigger(7n);
    await desk.settle(7n, record, { urgent: true, gasCap: 3_000_000n });
    await desk.reportFailed(7n, record, { gasCap: 3_000_000n });
    await desk.stamp(7n, record, { gasCap: 3_000_000n });
    await desk.timeout(7n);
    expect(seen).toEqual([
      { functionName: "approve", args: [DESK, 5n], address: imd, urgent: false },
      { functionName: "claim", args: [7n], address: DESK, urgent: false },
      // The four that protect a bond may pay more for gas.
      {
        functionName: "register",
        args: [7n, "0xe9efec1656f340d3924352c453effc7d"],
        address: DESK,
        urgent: true,
      },
      { functionName: "settle", args: [7n, "0x7b7d", []], address: DESK, urgent: false },
      { functionName: "claimDelivered", args: [7n, `0x${"11".repeat(32)}`], address: DESK, urgent: true },
      { functionName: "finalize", args: [7n], address: DESK, urgent: false },
      { functionName: "release", args: [7n], address: DESK, urgent: true },
      { functionName: "reportFailed", args: [7n, "0x7b7d", []], address: DESK, urgent: true },
      { functionName: "trigger", args: [7n], address: DESK, urgent: false },
      // A settlement whose delay could cost the bond, with the most gas it may be sent with.
      { functionName: "settle", args: [7n, "0x7b7d", []], address: DESK, urgent: true, gasCap: 3_000_000n },
      {
        functionName: "reportFailed",
        args: [7n, "0x7b7d", []],
        address: DESK,
        urgent: true,
        gasCap: 3_000_000n,
      },
      // A stamp moves no money: the ordinary limits.
      { functionName: "stamp", args: [7n, "0x7b7d", []], address: DESK, urgent: false, gasCap: 3_000_000n },
      // Ending a challenged claim at its deadline returns nine tenths of the bond.
      { functionName: "timeout", args: [7n], address: DESK, urgent: true },
    ]);
    // Every function the desk adapter calls exists in the ABI it is given.
    const names = new Set((workOrdersAbi as unknown as Abi).map((i) => ("name" in i ? i.name : "")));
    for (const call of seen.slice(1)) expect(names.has(call.functionName), call.functionName).toBe(true);
    for (const read of ["orderOf", "claimOf", "priceNow", "conditionOf", "barred", "headerOf"])
      expect(names.has(read), read).toBe(true);
    expect((erc20Abi as unknown as Abi).some((i) => "name" in i && i.name === "approve")).toBe(true);
    expect(await desk.cannotSend(true)).toBeNull();
  });

  it("reads an order and its claim at one and the same block", async () => {
    const asked: { functionName: string; blockNumber: bigint | undefined }[] = [];
    let head = 99n;
    const reader: ReaderLike = {
      getBlockNumber: async () => head++,
      getBalance: async () => 7n,
      async readContract({ functionName, blockNumber }) {
        asked.push({ functionName, blockNumber });
        if (functionName === "orderOf") {
          return {
            state: 1,
            employer: RUNNER,
            expiresAt: 100n,
            flags: 1,
            kindHash: "0xaa",
            specHash: "0xbb",
            deliverySecs: 259200,
            runnerOnly: RUNNER,
            bond: 5n,
            arbiter: RUNNER,
            condTarget: RUNNER,
            condMet: true,
            seq: 2,
            minPay: 7n,
            maxPay: 9n,
            proven: true,
          };
        }
        if (functionName === "claimOf") {
          return {
            runner: RUNNER,
            claimedAt: 10n,
            registeredAt: 20n,
            price: 30n,
            jobId: "0x00",
            challenger: DESK,
            assertedAt: 0n,
            recordHash: "0x00",
          };
        }
        if (functionName === "conditionOf") return [true, false, 5n];
        if (functionName === "latest") return `0x${"22".repeat(32)}`;
        // "[help-wanted order " as the desk returns bytes.
        if (functionName === "headerOf") return "0x5b68656c702d77616e746564206f7264657220";
        return 42n;
      },
      getContractEvents: async () => [],
    };
    const desk = viemDesk(
      reader,
      writer(chain()).w,
      { workOrders: DESK, imd: DESK, workRegistry: DESK },
      RUNNER,
    );
    const snap = await desk.snapshot(1n);
    expect(snap.block).toBe(99n);
    expect(snap.order).toMatchObject({ state: 1, expiresAt: 100, bond: 5n, seq: 2, condMet: true });
    expect(snap.order).toMatchObject({ minPay: 7n, maxPay: 9n, proven: true });
    expect(snap.claim).toMatchObject({ claimedAt: 10, registeredAt: 20, price: 30n, challenger: DESK });
    // Both reads name the block that was read first: a pair can never straddle a transaction.
    expect(asked).toEqual([
      { functionName: "orderOf", blockNumber: 99n },
      { functionName: "claimOf", blockNumber: 99n },
    ]);
    expect(await desk.condition(1n)).toEqual({ met: true, holdsNow: false });
    // The header comes back as bytes and is read as text, with nothing dropped.
    expect(await desk.headerOf(1n)).toBe("[help-wanted order ");
    expect(await desk.priceNow(1n)).toBe(42n);
    expect(await desk.receiptOf("e9efec16-56f3-40d3-9243-52c453effc7d")).toBe(`0x${"22".repeat(32)}`);
  });

  it("reads the desk's logs into plain values", async () => {
    const calls: string[] = [];
    const reader: ReaderLike = {
      getBlockNumber: async () => 99n,
      getBalance: async () => 7n,
      readContract: async () => 0n,
      async getContractEvents({ eventName, fromBlock, toBlock, args }) {
        calls.push(`${eventName} ${fromBlock}-${toBlock} ${JSON.stringify(args ?? null)}`);
        if (eventName === "Claimed") {
          return [
            { args: { id: 3n, runner: RUNNER }, blockNumber: 51n },
            { args: { id: 3n, runner: RUNNER }, blockNumber: 55n },
            { args: { id: 9n, runner: RUNNER }, blockNumber: 58n },
          ];
        }
        return [
          {
            args: {
              id: 3n,
              employer: RUNNER,
              kindHash: "0xaa",
              specHash: "0xbb",
              // A byte order mark in front: a text decoder that drops it would change the bytes.
              spec: "0xefbbbf4869",
              params: { expiresAt: 1_800_000_000n },
            },
            blockNumber: 50n,
          },
        ];
      },
    };
    const desk = viemDesk(
      reader,
      writer(chain()).w,
      { workOrders: DESK, imd: DESK, workRegistry: DESK },
      RUNNER,
    );
    expect(await desk.blockNumber()).toBe(99n);
    expect(await desk.ordersOpened(1n, 60n)).toEqual([
      {
        id: 3n,
        employer: RUNNER,
        kindHash: "0xaa",
        specHash: "0xbb",
        spec: "\u{feff}Hi",
        expiresAt: 1_800_000_000,
        block: 50n,
      },
    ]);
    // The runner's own claims, each order once, asked for by the indexed runner address.
    expect(await desk.claimedBy(RUNNER, 1n, 60n)).toEqual([3n, 9n]);
    expect(calls).toEqual(["OrderOpened 1-60 null", `Claimed 1-60 ${JSON.stringify({ runner: RUNNER })}`]);
  });

  it("finds the registry's newest receipt within the blocks it is asked to look back over", async () => {
    const asked: string[] = [];
    let logs: { args: unknown; blockNumber: bigint | null }[] = [];
    const reader: ReaderLike = {
      getBlockNumber: async () => 5_000n,
      getBalance: async () => 0n,
      readContract: async () => 0n,
      async getContractEvents({ address, eventName, fromBlock, toBlock }) {
        asked.push(`${address} ${eventName} ${fromBlock}-${toBlock}`);
        return logs;
      },
    };
    const registry = "0xb6d0a187b050FA5Bb0B87033a203f37BECF4a775";
    const desk = viemDesk(
      reader,
      writer(chain()).w,
      { workOrders: DESK, imd: DESK, workRegistry: registry },
      RUNNER,
    );
    // No WorkRecorded event in the last 1,800 blocks: receipts are stalled.
    expect(await desk.lastReceiptBlock(1_800n)).toBeNull();
    expect(asked).toEqual([`${registry} WorkRecorded 3200-5000`]);
    logs = [
      { args: {}, blockNumber: 4_100n },
      { args: {}, blockNumber: 4_990n },
      { args: {}, blockNumber: 4_500n },
    ];
    expect(await desk.lastReceiptBlock(1_800n)).toBe(4_990n);
    // A lookback longer than the chain starts at block zero.
    await desk.lastReceiptBlock(9_000n);
    expect(asked.at(-1)).toBe(`${registry} WorkRecorded 0-5000`);
  });

  it("can name the reverts WorkProof passes through the desk, and filter claims by runner", () => {
    // `settle` and `reportFailed` hand a WorkProof revert on unchanged. The desk adapter's ABI
    // carries those errors so that a failed simulation names them.
    const proofErrors = (workProofAbi as unknown as Abi).filter((i) => i.type === "error").map((i) => i.name);
    expect(proofErrors).toEqual(
      expect.arrayContaining(["NoReceipt", "HashMismatch", "Malformed", "WrongSchema", "JobIdMismatch"]),
    );
    // `Claimed` has the runner as an indexed argument, so a node can filter on it.
    const topics = encodeEventTopics({
      abi: workOrdersAbi,
      eventName: "Claimed",
      args: { runner: RUNNER },
    });
    expect(topics).toHaveLength(3);
    expect(String(topics[2]).toLowerCase()).toContain(RUNNER.slice(2).toLowerCase());
  });
});
