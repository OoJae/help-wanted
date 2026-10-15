import type { Abi, Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  ChainWriteError,
  ChainWriter,
  STOPS_THE_PASS,
  type ChainCall,
  type ChainWriterOptions,
  type MinedReceipt,
  type PendingTx,
  type PublicLike,
  type WalletLike,
} from "../src/chain.js";
import { memoryLogger } from "../src/log.js";
import { memoryStore, spendLimit, spentOn } from "../src/store.js";

const ACCOUNT: Address = "0x0000000000000000000000000000000000000FED";
const TARGET: Address = "0x00000000000000000000000000000000000A11cE";
const ABI: Abi = [{ type: "function", name: "drip", inputs: [], outputs: [], stateMutability: "nonpayable" }];
const GWEI = 1_000_000_000n;
const hashOf = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

const call = (over: Partial<ChainCall> = {}): ChainCall => ({
  address: TARGET,
  abi: ABI,
  functionName: "drip",
  args: [],
  label: "drip the staker stream",
  ...over,
});

/** A node and a wallet that do what they are told and record what they were asked. */
function world(
  over: { fee?: bigint; estimate?: bigint; revert?: string; mined?: boolean; reverted?: boolean } = {},
) {
  const state = {
    fee: over.fee ?? GWEI,
    estimate: over.estimate ?? 100_000n,
    revert: over.revert as string | undefined,
    mined: over.mined ?? true,
    reverted: over.reverted ?? false,
    nonce: 7,
    queued: 7,
    effectiveGasPrice: GWEI as bigint | null,
    sent: [] as {
      gas: bigint;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
      nonce: number;
      hash: Hex;
    }[],
    simulations: 0,
    receipts: new Map<Hex, MinedReceipt>(),
  };
  const receiptOf = (gas: bigint): MinedReceipt => ({
    status: state.reverted ? "reverted" : "success",
    blockNumber: 100n,
    gasUsed: (gas * 8n) / 10n,
    effectiveGasPrice: state.effectiveGasPrice,
    logs: [],
  });
  const publicClient: PublicLike = {
    simulateContract: async () => {
      state.simulations += 1;
      if (state.revert !== undefined) throw new Error(state.revert);
      return {};
    },
    estimateContractGas: async () => state.estimate,
    estimateFeesPerGas: async () => ({ maxFeePerGas: state.fee, maxPriorityFeePerGas: GWEI / 100n }),
    waitForTransactionReceipt: async ({ hash }) => {
      if (!state.mined) throw new Error("timed out");
      const sent = state.sent.find((s) => s.hash === hash);
      const receipt = receiptOf(sent?.gas ?? 0n);
      state.receipts.set(hash, receipt);
      state.nonce += 1;
      state.queued = state.nonce;
      return receipt;
    },
    getTransactionReceipt: async ({ hash }) => state.receipts.get(hash) ?? null,
    getTransactionCount: async ({ blockTag }) => (blockTag === "latest" ? state.nonce : state.queued),
  };
  const wallet: WalletLike = {
    writeContract: async (args) => {
      const hash = hashOf(state.sent.length + 1);
      state.sent.push({ ...args, hash });
      return hash;
    },
  };
  return { state, publicClient, wallet };
}

function writer(w: ReturnType<typeof world>, over: Partial<ChainWriterOptions> = {}) {
  const store = memoryStore();
  let killed = false;
  let now = 1_791_900_000;
  let kept: PendingTx | null = null;
  const log = memoryLogger();
  const options: ChainWriterOptions = {
    mode: "live",
    public: w.publicClient,
    wallet: w.wallet,
    account: ACCOUNT,
    maxFeePerGas: 5n * GWEI,
    maxPriorityFeePerGas: GWEI / 10n,
    maxTxCost: 10_000_000n * GWEI,
    spend: spendLimit(store, 50_000_000n * GWEI, () => now),
    killed: () => killed,
    log,
    memory: { get: () => kept, set: (p) => (kept = p) },
    ...over,
  };
  return {
    chain: new ChainWriter(options),
    store,
    log,
    kill: () => (killed = true),
    setNow: (t: number) => (now = t),
    pending: () => kept,
    spent: () => spentOn(store.data, "2026-10-13"),
  };
}

const failure = async (promise: Promise<unknown>): Promise<ChainWriteError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ChainWriteError) return error;
    throw error;
  }
  throw new Error("expected a ChainWriteError");
};

describe("dry run", () => {
  it("simulates, says what it would send, and never touches the wallet", async () => {
    const w = world();
    const k = writer(w, { mode: "dry-run", wallet: null });
    const outcome = await k.chain.send(call());
    expect(outcome).toEqual({ kind: "dry-run", label: "drip the staker stream", wouldSucceed: true });
    expect(w.state.simulations).toBe(1);
    expect(w.state.sent).toEqual([]);
    expect(k.spent()).toBe(0n);
    expect(k.log.lines.join("\n")).toContain("dry run: would send a transaction");
  });

  it("reports a call that would revert, with the reason", async () => {
    const outcome = await writer(world({ revert: "DripTooSoon(1791900600)" }), {
      mode: "dry-run",
      wallet: null,
    }).chain.send(call());
    expect(outcome).toMatchObject({
      kind: "dry-run",
      wouldSucceed: false,
      reason: "DripTooSoon(1791900600)",
    });
  });

  it("with no address configured it cannot even simulate, and still sends nothing", async () => {
    const w = world();
    const outcome = await writer(w, { mode: "dry-run", wallet: null, account: null }).chain.send(call());
    expect(outcome).toEqual({ kind: "dry-run", label: "drip the staker stream", wouldSucceed: null });
    expect(w.state.simulations).toBe(0);
    expect(w.state.sent).toEqual([]);
  });

  it("has a wallet in the process only when live: a dry-run writer given one still does not use it", async () => {
    const w = world();
    await writer(w, { mode: "dry-run" }).chain.send(call());
    expect(w.state.sent).toEqual([]);
    expect(
      () => new ChainWriter({ ...({} as ChainWriterOptions), mode: "live", wallet: null, account: ACCOUNT }),
    ).toThrow(/live mode needs a wallet/);
  });
});

describe("live", () => {
  it("simulates first, then sends with a fee ceiling of twice the market, and books what it cost", async () => {
    const w = world();
    const k = writer(w);
    const outcome = await k.chain.send(call());
    expect(outcome.kind).toBe("sent");
    expect(w.state.simulations).toBe(1);
    expect(w.state.sent).toHaveLength(1);
    const tx = w.state.sent[0];
    // 100,000 estimated: a fifth more, and ten thousand.
    expect(tx?.gas).toBe(130_000n);
    expect(tx?.maxFeePerGas).toBe(2n * GWEI);
    expect(tx?.maxPriorityFeePerGas).toBe(GWEI / 100n);
    expect(tx?.nonce).toBe(7);
    // Four fifths of the gas was used, at one gwei.
    if (outcome.kind !== "sent") throw new Error("unreachable");
    expect(outcome.gasUsed).toBe(104_000n);
    expect(outcome.cost).toBe(104_000n * GWEI);
    expect(k.spent()).toBe(104_000n * GWEI);
    expect(k.pending()).toBeNull();
  });

  it("does not send a call that would revert", async () => {
    const w = world({ revert: "RequestBlocked(4)" });
    const error = await failure(writer(w).chain.send(call()));
    expect(error.code).toBe("simulation_reverted");
    expect(error.message).toContain("RequestBlocked(4)");
    expect(w.state.sent).toEqual([]);
    expect(STOPS_THE_PASS).not.toContain("simulation_reverted");
  });

  it("does not send above the fee cap: at the cap it does, one wei over it does not", async () => {
    const at = world({ fee: 5n * GWEI });
    expect((await writer(at).chain.send(call())).kind).toBe("sent");
    // At the cap the ceiling cannot be twice the market: it is the cap.
    expect(at.state.sent[0]?.maxFeePerGas).toBe(5n * GWEI);
    const over = world({ fee: 5n * GWEI + 1n });
    const error = await failure(writer(over).chain.send(call()));
    expect(error.code).toBe("fee_too_high");
    expect(over.state.sent).toEqual([]);
    expect(STOPS_THE_PASS).toContain("fee_too_high");
  });

  it("does not send a transaction that would cost more than the limit for one", async () => {
    // 130,000 gas at 1 gwei is 130,000 gwei.
    const w = world();
    expect((await writer(w, { maxTxCost: 130_000n * GWEI }).chain.send(call())).kind).toBe("sent");
    // The ceiling is what the cost limit allows, here the market fee itself.
    expect(w.state.sent[0]?.maxFeePerGas).toBe(GWEI);
    const tight = world();
    const error = await failure(writer(tight, { maxTxCost: 130_000n * GWEI - 1n }).chain.send(call()));
    expect(error.code).toBe("cost_too_high");
    expect(tight.state.sent).toEqual([]);
  });

  it("sends with at least the gas floor a call asks for", async () => {
    const w = world();
    await writer(w).chain.send(call({ gasFloor: 1_000_000n }));
    expect(w.state.sent[0]?.gas).toBe(1_000_000n);
    const above = world({ estimate: 2_000_000n });
    await writer(above).chain.send(call({ gasFloor: 1_000_000n }));
    expect(above.state.sent[0]?.gas).toBe(2_410_000n);
  });

  it("fails loudly when the transaction reverts on chain, and still books its gas", async () => {
    const w = world({ reverted: true });
    const k = writer(w);
    const error = await failure(k.chain.send(call()));
    expect(error.code).toBe("tx_reverted");
    expect(k.spent()).toBe(104_000n * GWEI);
    expect(k.pending()).toBeNull();
  });

  it("stops at the kill switch before anything is simulated or sent", async () => {
    const w = world();
    const k = writer(w);
    k.kill();
    const error = await failure(k.chain.send(call()));
    expect(error.code).toBe("killed");
    expect(w.state.simulations).toBe(0);
    expect(w.state.sent).toEqual([]);
    expect(STOPS_THE_PASS).toContain("killed");
  });
});

describe("the daily cap", () => {
  // One send reserves 130,000 gas at a 2 gwei ceiling: 260,000 gwei.
  const WORST = 260_000n * GWEI;

  it("sends when the worst case just fits, and not when it is one wei over", async () => {
    const fits = world();
    const store = memoryStore();
    const now = 1_791_900_000;
    const exact = new ChainWriter({
      mode: "live",
      public: fits.publicClient,
      wallet: fits.wallet,
      account: ACCOUNT,
      maxFeePerGas: 5n * GWEI,
      maxPriorityFeePerGas: GWEI / 10n,
      maxTxCost: 10_000_000n * GWEI,
      spend: spendLimit(store, WORST, () => now),
      killed: () => false,
      log: memoryLogger(),
    });
    expect((await exact.send(call())).kind).toBe("sent");

    const tight = world();
    const short = new ChainWriter({
      mode: "live",
      public: tight.publicClient,
      wallet: tight.wallet,
      account: ACCOUNT,
      maxFeePerGas: 5n * GWEI,
      maxPriorityFeePerGas: GWEI / 10n,
      maxTxCost: 10_000_000n * GWEI,
      spend: spendLimit(memoryStore(), WORST - 1n, () => now),
      killed: () => false,
      log: memoryLogger(),
    });
    const error = await failure(short.send(call()));
    expect(error.code).toBe("daily_cap");
    expect(tight.state.sent).toEqual([]);
    expect(STOPS_THE_PASS).toContain("daily_cap");
  });

  it("counts what was really spent, not the reservation, towards the next send", async () => {
    const w = world();
    // Room for the first worst case and then for exactly one more after the first's real cost.
    const cap = 104_000n * GWEI + WORST;
    const store = memoryStore();
    const chain = new ChainWriter({
      mode: "live",
      public: w.publicClient,
      wallet: w.wallet,
      account: ACCOUNT,
      maxFeePerGas: 5n * GWEI,
      maxPriorityFeePerGas: GWEI / 10n,
      maxTxCost: 10_000_000n * GWEI,
      spend: spendLimit(store, cap, () => 1_791_900_000),
      killed: () => false,
      log: memoryLogger(),
    });
    expect((await chain.send(call())).kind).toBe("sent");
    expect((await chain.send(call())).kind).toBe("sent");
    expect(spentOn(store.data, "2026-10-13")).toBe(208_000n * GWEI);
    expect((await failure(chain.send(call()))).code).toBe("daily_cap");
    expect(w.state.sent).toHaveLength(2);
  });

  it("starts again at midnight UTC: the last second of a day is that day's, the next is a new day's", async () => {
    const w = world();
    const store = memoryStore();
    // 2026-10-13 23:59:59 UTC.
    let now = 1_791_936_000 - 1;
    const chain = new ChainWriter({
      mode: "live",
      public: w.publicClient,
      wallet: w.wallet,
      account: ACCOUNT,
      maxFeePerGas: 5n * GWEI,
      maxPriorityFeePerGas: GWEI / 10n,
      maxTxCost: 10_000_000n * GWEI,
      spend: spendLimit(store, WORST, () => now),
      killed: () => false,
      log: memoryLogger(),
    });
    expect((await chain.send(call())).kind).toBe("sent");
    expect((await failure(chain.send(call()))).code).toBe("daily_cap");
    now += 1;
    expect((await chain.send(call())).kind).toBe("sent");
    expect(Object.keys(store.data.spend).sort()).toEqual(["2026-10-13", "2026-10-14"]);
  });

  it("books the fee ceiling when the node does not report what was charged", async () => {
    const w = world();
    w.state.effectiveGasPrice = null;
    const k = writer(w);
    await k.chain.send(call());
    expect(k.spent()).toBe(104_000n * 2n * GWEI);
  });
});

describe("one transaction at a time", () => {
  it("remembers a transaction that is not mined in time, with its reservation", async () => {
    const w = world({ mined: false });
    const k = writer(w);
    const error = await failure(k.chain.send(call()));
    expect(error.code).toBe("pending");
    expect(k.pending()).toMatchObject({
      nonce: 7,
      label: "drip the staker stream",
      reserved: (260_000n * GWEI).toString(),
    });
    expect(k.spent()).toBe(260_000n * GWEI);
    expect(STOPS_THE_PASS).toContain("pending");
  });

  it("does not send another call behind it", async () => {
    const w = world({ mined: false });
    const k = writer(w);
    await failure(k.chain.send(call()));
    const error = await failure(k.chain.send(call({ functionName: "book", label: "book plain transfers" })));
    expect(error.code).toBe("pending");
    expect(error.message).toContain("not sending");
    expect(w.state.sent).toHaveLength(1);
  });

  it("answers with the first transaction when the same call is asked again after it was mined", async () => {
    const w = world({ mined: false });
    const k = writer(w);
    await failure(k.chain.send(call()));
    // It is mined while nobody waits.
    const first = w.state.sent[0];
    if (!first) throw new Error("unreachable");
    w.state.receipts.set(first.hash, {
      status: "success",
      blockNumber: 101n,
      gasUsed: 100_000n,
      effectiveGasPrice: GWEI,
      logs: [],
    });
    w.state.nonce = 8;
    w.state.queued = 8;
    const outcome = await k.chain.send(call());
    expect(outcome).toMatchObject({ kind: "sent", hash: first.hash, blockNumber: 101n });
    // Not sent twice, and the reservation gave way to what it cost.
    expect(w.state.sent).toHaveLength(1);
    expect(k.spent()).toBe(100_000n * GWEI);
    expect(k.pending()).toBeNull();
    expect(await k.chain.waiting()).toBeNull();
  });

  it("replaces the same call under the same nonce at a fee raised by an eighth", async () => {
    const w = world({ mined: false });
    const k = writer(w);
    await failure(k.chain.send(call()));
    w.state.queued = 8;
    w.state.mined = true;
    const outcome = await k.chain.send(call());
    expect(outcome.kind).toBe("sent");
    expect(w.state.sent).toHaveLength(2);
    expect(w.state.sent[1]?.nonce).toBe(7);
    expect(w.state.sent[1]?.maxFeePerGas).toBe((2n * GWEI * 1125n + 999n) / 1000n);
    expect(k.pending()).toBeNull();
  });

  it("forgets a transaction whose nonce something else used, and gives its reservation back", async () => {
    const w = world({ mined: false });
    const k = writer(w);
    await failure(k.chain.send(call()));
    w.state.nonce = 8;
    w.state.queued = 8;
    expect(await k.chain.waiting()).toBeNull();
    expect(k.pending()).toBeNull();
    expect(k.spent()).toBe(0n);
  });

  it("does not send behind a transaction of this wallet that it did not send itself", async () => {
    const w = world();
    w.state.queued = 8;
    const error = await failure(writer(w).chain.send(call()));
    expect(error.code).toBe("pending");
    expect(error.message).toContain("the keeper did not send");
    expect(w.state.sent).toEqual([]);
  });

  it("runs two sends one after the other, never at once", async () => {
    const w = world();
    const k = writer(w);
    const [a, b] = await Promise.all([
      k.chain.send(call()),
      k.chain.send(call({ functionName: "book", label: "book" })),
    ]);
    expect(a.kind).toBe("sent");
    expect(b.kind).toBe("sent");
    expect(w.state.sent.map((s) => s.nonce)).toEqual([7, 8]);
  });
});
