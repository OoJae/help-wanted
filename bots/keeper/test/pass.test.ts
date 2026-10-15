import type { Abi, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { unlaunchedBook } from "@help-wanted/shared";
import { callKey, dedupe, type Action } from "../src/actions.js";
import { ChainWriteError, type ChainCall, type WriteOutcome } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
import { memoryLogger } from "../src/log.js";
import { newCache } from "../src/observe/common.js";
import { execute, nextWait, type Runtime } from "../src/pass.js";
import { nextDueOf } from "../src/status.js";
import { memoryStore } from "../src/store.js";
import {
  BLOCK,
  NOW,
  PAYROLL,
  QUESTIONS,
  REQUESTED_AT,
  dueFeed,
  feed,
  pendingFeed,
  questions,
} from "./factories.js";

const ABI: Abi = [];
const action = (kind: string, subject = "payroll", over: Partial<Action> = {}): Action => ({
  module: "payroll",
  kind,
  subject,
  label: `${kind} ${subject}`,
  reason: "a rule fired",
  call: { address: PAYROLL, abi: ABI, functionName: kind, args: [] },
  ...over,
});

/** A runtime whose writer answers from a script. Nothing in it can reach a node. */
function runtime(
  script: (call: ChainCall, n: number) => WriteOutcome | Error,
  mode: "live" | "dry-run" = "live",
) {
  const calls: ChainCall[] = [];
  const store = memoryStore();
  const rt: Runtime = {
    config: loadConfig({ QUESTIONS, MODULES: "questions" }, unlaunchedBook()),
    reader: {} as Runtime["reader"],
    api: {} as Runtime["api"],
    store,
    writer: {
      mode,
      send: async (call) => {
        calls.push(call);
        const outcome = script(call, calls.length);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
    log: memoryLogger(),
    cache: newCache(),
    killed: () => false,
    now: () => 1_791_900_000,
  };
  return { rt, calls, store };
}

const mined = (call: ChainCall, n: number): WriteOutcome => ({
  kind: "sent",
  label: call.label,
  hash: `0x${n.toString(16).padStart(64, "0")}` as Hex,
  blockNumber: 100n + BigInt(n),
  gasUsed: 70_000n,
  cost: 70_000n * 10n ** 9n,
  logs: [],
});

describe("sending the actions of a pass", () => {
  it("sends them in order, one at a time, and records each with its reason", async () => {
    const { rt, calls } = runtime(mined);
    const result = await execute(rt, [
      action("book"),
      action("fundFeeds", "payroll", { gasFloor: 1_000_000n }),
      action("drip"),
    ]);
    expect(calls.map((c) => c.functionName)).toEqual(["book", "fundFeeds", "drip"]);
    expect(calls[1]?.gasFloor).toBe(1_000_000n);
    expect(calls[0]?.gasFloor).toBeUndefined();
    expect(result.sent).toBe(3);
    expect(result.stop).toBe(false);
    expect(result.records.map((r) => [r.kind, r.outcome, r.reason, r.block])).toEqual([
      ["book", "sent", "a rule fired", "101"],
      ["fundFeeds", "sent", "a rule fired", "102"],
      ["drip", "sent", "a rule fired", "103"],
    ]);
    expect(result.records[0]?.costWei).toBe((70_000n * 10n ** 9n).toString());
  });

  it("goes on after a call that would revert: the others do not depend on it", async () => {
    const { rt } = runtime((call, n) =>
      n === 1 ? new ChainWriteError("simulation_reverted", '"book" would revert: nothing') : mined(call, n),
    );
    const result = await execute(rt, [action("book"), action("drip")]);
    expect(result.records.map((r) => [r.kind, r.outcome, r.code])).toEqual([
      ["book", "failed", "simulation_reverted"],
      ["drip", "sent", undefined],
    ]);
    expect(result.sent).toBe(1);
    expect(result.stop).toBe(false);
  });

  it.each(["killed", "fee_too_high", "daily_cap", "pending", "no_wallet"] as const)(
    "stops the pass at %s: what was not reached is listed as left",
    async (code) => {
      const { rt, calls } = runtime((call, n) =>
        n === 2 ? new ChainWriteError(code, "no") : mined(call, n),
      );
      const result = await execute(rt, [action("book"), action("fundFeeds"), action("drip")]);
      expect(calls).toHaveLength(2);
      expect(result.stop).toBe(true);
      expect(result.sent).toBe(1);
      expect(result.records.map((r) => r.outcome)).toEqual(["sent", "failed", "left"]);
      expect(result.records[1]?.code).toBe(code);
    },
  );

  it("counts a transaction that reverted on chain as sent: the chain has moved and gas was paid", async () => {
    const { rt } = runtime(() => new ChainWriteError("tx_reverted", "reverted"));
    const result = await execute(rt, [action("drip")]);
    expect(result.records[0]).toMatchObject({ outcome: "failed", code: "tx_reverted" });
    expect(result.sent).toBe(1);
  });

  it("in a dry run nothing counts as sent, and what each call would do is recorded", async () => {
    const { rt } = runtime(
      (call, n) => ({
        kind: "dry-run",
        label: call.label,
        wouldSucceed: n === 1,
        ...(n === 1 ? {} : { reason: "DripTooSoon" }),
      }),
      "dry-run",
    );
    const result = await execute(rt, [action("book"), action("drip")]);
    expect(result.sent).toBe(0);
    expect(result.records.map((r) => [r.outcome, r.wouldSucceed, r.error])).toEqual([
      ["dry-run", true, undefined],
      ["dry-run", false, "DripTooSoon"],
    ]);
  });

  it("records a failure that is not the writer's own, without stopping", async () => {
    const { rt } = runtime((call, n) => (n === 1 ? new Error("socket hang up") : mined(call, n)));
    const result = await execute(rt, [action("book"), action("drip")]);
    expect(result.records[0]).toMatchObject({ outcome: "failed", code: "error", error: "socket hang up" });
    expect(result.records[1]?.outcome).toBe("sent");
  });
});

describe("the same call asked for twice", () => {
  it("is sent once, with the first rule's reason", () => {
    const fromQuestions = action("fundFeeds", "payrolls", {
      module: "questions",
      reason: "the meter of payrolls is too low",
    });
    const fromPayroll = action("fundFeeds", "payroll", { reason: "a meter is below its runway" });
    const out = dedupe([fromQuestions, action("book"), fromPayroll]);
    expect(out.map((a) => `${a.module}:${a.kind}`)).toEqual(["questions:fundFeeds", "payroll:book"]);
    expect(out[0]?.reason).toBe("the meter of payrolls is too low");
  });

  it("tells calls apart by contract, function and arguments", () => {
    const request = (id: string) =>
      action("request", id, { call: { address: QUESTIONS, abi: ABI, functionName: "request", args: [id] } });
    expect(dedupe([request("0x01"), request("0x02"), request("0x01")])).toHaveLength(2);
    expect(callKey(request("0x01").call)).not.toBe(callKey({ ...request("0x01").call, address: PAYROLL }));
    // Amounts are bigint: the key spells them out.
    const fund = { address: QUESTIONS, abi: ABI, functionName: "fund", args: ["0x01", 5n] };
    expect(callKey(fund)).toContain('"5"');
  });
});

describe("when to look again", () => {
  it("sleeps the poll period when nothing is expected sooner", () => {
    expect(nextWait(300, null, 1000)).toBe(300);
    expect(nextWait(300, 5000, null)).toBe(300);
    expect(nextWait(300, 1000 + 288, 1000)).toBe(300);
    expect(nextWait(300, 9000, 1000)).toBe(300);
  });

  it("wakes a block after something it waits for is due, and never spins", () => {
    // Submit opens in 100 seconds of chain time: look in 112.
    expect(nextWait(300, 1100, 1000)).toBe(112);
    expect(nextWait(300, 1000 + 287, 1000)).toBe(299);
    // Already due, or about to be: ten seconds at the least.
    expect(nextWait(300, 1000, 1000)).toBe(12);
    expect(nextWait(300, 990, 1000)).toBe(10);
    expect(nextWait(300, 0, 1000)).toBe(10);
  });
});

describe("when each feed is next due", () => {
  it("gives the block and a rough time, twelve seconds a block", () => {
    const due = nextDueOf(questions(), null);
    expect(due).toEqual([
      {
        feed: "hires",
        block: (BLOCK + 6_950n).toString(),
        at: Number(NOW + 6_950n * 12n),
        note: "due in about 6950 blocks",
      },
    ]);
  });

  it("says due now, pending, blocked or missing", () => {
    const now = nextDueOf(questions({ feeds: [dueFeed()] }), null)[0];
    expect(now).toMatchObject({ at: Number(NOW), note: "due now, as far as the cadence goes" });
    const pending = nextDueOf(questions({ feeds: [pendingFeed()] }), null)[0];
    expect(pending).toMatchObject({ block: null, at: null });
    expect(pending?.note).toContain("round 3 is pending");
    const low = feed({
      nextRequestBlock: BLOCK - 5n,
      canRequest: { ok: false, why: 9, price: 0n, fromBlock: 0n, toBlock: 0n },
    });
    expect(nextDueOf(questions({ feeds: [low] }), null)[0]?.note).toBe("blocked: MeterTooLow");
    expect(nextDueOf(questions({ feeds: [feed({ exists: false })] }), null)[0]?.note).toContain(
      "does not exist",
    );
  });

  it("with a time of day set, gives the slot the feed will be asked at", () => {
    // NOW is 14:00:00 UTC, and that is the slot. Asked ten minutes ago, at 13:50: the cadence
    // allows the next request at about 13:10 tomorrow, fifty minutes before the slot, so it is
    // held for 14:00 tomorrow.
    const at = 14 * 3600;
    const early = feed({ lastRequestedAt: REQUESTED_AT, nextRequestBlock: BLOCK + 6_950n });
    const held = nextDueOf(questions({ feeds: [early] }), at)[0];
    expect(held?.at).toBe(Number(NOW + 86_400n));
    expect(held?.note).toContain("asked at the next daily slot");
    // Asked at 16:00 instead, two hours into the slot: the cadence allows 15:20 tomorrow, which is
    // in tomorrow's slot and far from its end, so it is asked then.
    const late = feed({ lastRequestedAt: NOW + 7_200n, nextRequestBlock: BLOCK + 600n + 7_000n });
    const due = nextDueOf(questions({ now: NOW + 7_200n, block: BLOCK + 600n, feeds: [late] }), at)[0];
    expect(due?.at).toBe(Number(NOW + 7_200n + 84_000n));
    expect(due?.note).toBe("due in about 7000 blocks");
    // With no time of day, the cadence alone decides.
    expect(nextDueOf(questions({ feeds: [early] }), null)[0]?.at).toBe(Number(NOW + 6_950n * 12n));
  });
});
