/**
 * What happens to a call between the button and the block, with a fake wallet. The rule under
 * test: once a transaction hash exists, nothing may offer to send that step again.
 */
import { describe, expect, it } from "vitest";
import {
  canSend,
  confirmStep,
  sendStep,
  shortError,
  type MinedReceipt,
  type Replacement,
  type StepDeps,
  type StepState,
} from "~/lib/sendStep";

const HASH = `0x${"a1".repeat(32)}` as const;
const OTHER = `0x${"b2".repeat(32)}` as const;

function wallet(overrides: Partial<StepDeps> = {}) {
  const log: string[] = [];
  const deps: StepDeps = {
    write: async () => {
      log.push("write");
      return HASH;
    },
    wait: async (hash) => {
      log.push(`wait ${hash}`);
      return { status: "success", transactionHash: hash };
    },
    ...overrides,
  };
  return { deps, log };
}

async function run(deps: StepDeps): Promise<StepState[]> {
  const states: StepState[] = [];
  await sendStep(deps, (state) => states.push(state));
  return states;
}

describe("sending one step", () => {
  it("a guard that refuses stops the step before the wallet is asked: nothing is sent", async () => {
    const { deps, log } = wallet({
      guard: async () => "pot or series 4 needs nothing now: CrowdPots.remaining(4) reads 0.",
    });
    const states = await run(deps);
    expect(states).toEqual([
      {
        status: "failed",
        message: "Not sent: pot or series 4 needs nothing now: CrowdPots.remaining(4) reads 0.",
        hash: null,
      },
    ]);
    expect(log).toEqual([]);
    // A guard that lets it through changes nothing else.
    const passed = wallet({ guard: async () => null });
    expect((await run(passed.deps)).map((s) => s.status)).toEqual(["signing", "mining", "done"]);
  });

  it("signs, waits and finishes: signing, mining, done", async () => {
    const { deps, log } = wallet();
    const states = await run(deps);
    expect(states.map((s) => s.status)).toEqual(["signing", "mining", "done"]);
    expect(states.at(-1)).toEqual({ status: "done", hash: HASH, note: null });
    expect(log).toEqual(["write", `wait ${HASH}`]);
  });

  it("a refused signature is a failure nothing was sent for, and may be tried again", async () => {
    const { deps } = wallet({
      write: async () => {
        throw new Error("User rejected the request.\nDetails: ...");
      },
    });
    const states = await run(deps);
    expect(states.at(-1)).toEqual({ status: "failed", message: "User rejected the request.", hash: null });
    expect(canSend(states.at(-1)!)).toBe(true);
  });

  it("when the receipt cannot be read after the transaction was sent, it is NOT a failure and cannot be sent again", async () => {
    const { deps, log } = wallet({
      wait: async () => {
        throw new Error("HTTP request failed. Status: 429");
      },
    });
    const states = await run(deps);
    const last = states.at(-1)!;
    // The transaction left the wallet. It may be pending or mined, whatever this page could read.
    expect(last.status).toBe("unconfirmed");
    expect(last).toMatchObject({ hash: HASH });
    expect((last as { message: string }).message).toContain("do not send it again");
    expect((last as { message: string }).message).toContain("Status: 429");
    // No state after the hash existed offers a re-send, and the wallet was asked to sign once.
    const afterHash = states.slice(states.findIndex((s) => s.status === "mining"));
    expect(afterHash.some(canSend)).toBe(false);
    expect(log.filter((entry) => entry === "write")).toHaveLength(1);
  });

  it("'check again' looks for the same transaction and never signs anything", async () => {
    let attempts = 0;
    const { deps, log } = wallet({
      wait: async (hash) => {
        attempts++;
        if (attempts === 1) throw new Error("fetch failed");
        return { status: "success", transactionHash: hash };
      },
    });
    const first = await run(deps);
    expect(first.at(-1)?.status).toBe("unconfirmed");
    const second: StepState[] = [];
    await confirmStep(HASH, deps, (state) => second.push(state));
    expect(second).toEqual([
      { status: "mining", hash: HASH },
      { status: "done", hash: HASH, note: null },
    ]);
    expect(log.filter((entry) => entry === "write")).toHaveLength(1);
  });

  it("a transaction that was mined and reverted is a failure, with its hash to look at", async () => {
    const { deps } = wallet({
      wait: async (hash) => ({ status: "reverted", transactionHash: hash }),
    });
    const last = (await run(deps)).at(-1)!;
    expect(last).toMatchObject({ status: "failed", hash: HASH });
    expect((last as { message: string }).message).toContain("reverted");
    // A reverted transaction is final and changed nothing, so trying again cannot double anything.
    expect(canSend(last)).toBe(true);
  });

  it.each<[Replacement, StepState["status"], string]>([
    ["cancelled", "failed", "You cancelled this transaction in your wallet"],
    ["replaced", "failed", "replaced this transaction with a different one"],
  ])("a transaction the wallet %s is not reported as mined", async (reason, status, words) => {
    const { deps } = wallet({
      wait: async (_hash, onReplaced) => {
        onReplaced(reason);
        return { status: "success", transactionHash: OTHER } satisfies MinedReceipt;
      },
    });
    const last = (await run(deps)).at(-1)!;
    expect(last.status).toBe(status);
    expect((last as { message: string }).message).toContain(words);
    expect(last).toMatchObject({ hash: OTHER });
  });

  it("a transaction whose fee was raised is done, under the hash it was mined with", async () => {
    const { deps } = wallet({
      wait: async (_hash, onReplaced) => {
        onReplaced("repriced");
        return { status: "success", transactionHash: OTHER };
      },
    });
    expect((await run(deps)).at(-1)).toEqual({
      status: "done",
      hash: OTHER,
      note: "Mined after its fee was raised in the wallet.",
    });
  });

  it("a receipt for another hash with no word of why is not taken for this step's success", async () => {
    const { deps } = wallet({ wait: async () => ({ status: "success", transactionHash: OTHER }) });
    expect((await run(deps)).at(-1)).toMatchObject({ status: "failed", hash: OTHER });
  });

  it("skips an approval the wallet has already given, and asks before one it has not", async () => {
    const enough = wallet({ allowance: { needed: 5n, read: async () => 5n } });
    expect(await run(enough.deps)).toEqual([
      { status: "skipped", note: "Already allowed; nothing to send." },
    ]);
    expect(enough.log).toEqual([]);
    const short = wallet({ allowance: { needed: 5n, read: async () => 4n } });
    expect((await run(short.deps)).map((s) => s.status)).toEqual(["signing", "mining", "done"]);
  });

  it("sends nothing to an address where no contract answers", async () => {
    const { deps, log } = wallet({ hasCode: async () => false });
    const states = await run(deps);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ status: "failed", hash: null });
    expect((states[0] as { message: string }).message).toContain("No contract answers");
    expect(log).toEqual([]);
  });

  it("a failed read before signing is a failure with nothing sent", async () => {
    const { deps, log } = wallet({
      hasCode: async () => {
        throw new Error("fetch failed");
      },
    });
    expect((await run(deps)).at(-1)).toEqual({ status: "failed", message: "fetch failed", hash: null });
    expect(log).toEqual([]);
  });
});

describe("which states may send", () => {
  it("only a step with nothing pending: idle, or failed", () => {
    const states: StepState[] = [
      { status: "idle" },
      { status: "failed", message: "x", hash: null },
      { status: "skipped", note: "x" },
      { status: "signing" },
      { status: "mining", hash: HASH },
      { status: "unconfirmed", hash: HASH, message: "x" },
      { status: "done", hash: HASH, note: null },
    ];
    expect(states.map(canSend)).toEqual([true, true, false, false, false, false, false]);
  });

  it("keeps an error to its first line, at a length a page can show", () => {
    expect(shortError(new Error("first\nsecond"))).toBe("first");
    expect(shortError("x".repeat(500))).toHaveLength(221);
    expect(shortError(42)).toBe("42");
  });
});
