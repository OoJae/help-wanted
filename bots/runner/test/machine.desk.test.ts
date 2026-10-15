/**
 * The runner against the hire desk as it is today: the checks that keep it from taking an order it
 * cannot finish, and what it does at each of the desk's deadlines.
 *
 * Every test here is about money: a bond that would be forfeited, a fee that would be spent for a
 * job that cannot settle, or gas spent on a call the desk would refuse.
 */
import { keccak256 } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESK as DESK_CONST,
  ORDER_FLAG,
  ORDER_STATE,
  kindHash,
  releaseCut,
  settleGasNeeded,
} from "@help-wanted/shared";
import { ChainWriteError } from "../src/chain.js";
import { objectiveFor, workRecord } from "./fakes.js";
import { NOW, finishJob, ticks, upToRegistered, world, type World } from "./harness.js";
import { EMPLOYER, JOB_ID, ORDER_ID, RUNNER } from "./world.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => {
  vi.useRealTimers();
});

const wrote = (w: World, what: string) => w.desk.writes().filter((c) => c.startsWith(what));
const IMD = (tenths: number) => BigInt(tenths) * 10n ** 17n;
const DAY = 86_400;

describe("an order that only a receipt can pay", () => {
  const receiptOnly = { flags: 0 };

  it("is not taken while the registry has written no receipt lately, and is looked at again", async () => {
    const w = world({ receiptOnlyOrders: "when-receipts-flow" });
    w.desk.open(ORDER_ID, receiptOnly);
    w.desk.lastReceipt = null;
    await ticks(w, 2);
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.skip?.permanent).toBe(false);
    expect(w.record()?.skip?.reason).toContain("can only be settled by a receipt");
    expect(w.record()?.skip?.reason).toContain("has written no receipt in the last 1800 blocks");
    expect(w.record()?.skip?.reason).toContain("RECEIPT_ONLY_ORDERS=always");
    expect(w.desk.writes()).toEqual([]);
    expect(w.requests).toEqual([]);
  });

  it("is taken once receipts are being written again", async () => {
    const w = world({ receiptOnlyOrders: "when-receipts-flow" });
    w.desk.open(ORDER_ID, receiptOnly);
    await w.machine.tick();
    expect(w.record()?.status).toBe("seen");
    // The registry writes a receipt. The reading is trusted for ten minutes, then taken again.
    w.desk.lastReceipt = w.desk.head - 3n;
    w.wait(601);
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
    expect(w.visible().some((l) => l.includes("receipts are being written"))).toBe(true);
  });

  it("counts a registry that cannot be read as stalled: no answer is not a yes", async () => {
    const w = world({ receiptOnlyOrders: "when-receipts-flow" });
    w.desk.open(ORDER_ID, receiptOnly);
    w.desk.lastReceipt = w.desk.head;
    w.desk.receiptsUnreadable = true;
    await w.machine.tick();
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.skip?.reason).toContain("could not be read");
    expect(w.desk.writes()).toEqual([]);
  });

  it("is taken whatever the registry does when the operator chose to wait for receipts", async () => {
    const w = world({ receiptOnlyOrders: "always" });
    w.desk.open(ORDER_ID, receiptOnly);
    w.desk.lastReceipt = null;
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
    // The registry is not even asked.
    expect(w.desk.receiptReads).toBe(0);
  });

  it("is never taken by a runner set to take only orders that allow a claim", async () => {
    const w = world({ receiptOnlyOrders: "never" });
    w.desk.open(ORDER_ID, receiptOnly);
    w.desk.lastReceipt = w.desk.head;
    await w.machine.tick();
    expect(w.record()?.status).toBe("skipped");
    expect(w.record()?.skip?.reason).toContain("takes only orders that allow a bonded claim");
    expect(w.desk.receiptReads).toBe(0);
  });

  it("does not ask the registry about an order that allows the bonded claim", async () => {
    const w = world({ receiptOnlyOrders: "when-receipts-flow" });
    w.desk.open(ORDER_ID); // FLAG_ALLOW_CLAIMED
    w.desk.lastReceipt = null;
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
    expect(w.desk.receiptReads).toBe(0);
  });

  it("reads the registry once for many orders, not once for each", async () => {
    const w = world({ receiptOnlyOrders: "when-receipts-flow" });
    for (const id of [1n, 2n, 3n, 4n]) w.desk.open(id, receiptOnly);
    await ticks(w, 2);
    expect(w.desk.receiptReads).toBe(1);
  });

  it("is refused when a record of its kind would not fit this runner's gas limit", async () => {
    // A research report's record has been seen at 7,339 bytes, which takes about 2.08M gas to settle.
    expect(settleGasNeeded(7_339)).toBeGreaterThan(2_000_000n);
    const w = world({ receiptOnlyOrders: "always", maxSettleGas: 2_000_000n });
    w.desk.open(ORDER_ID, receiptOnly);
    await w.machine.tick();
    expect(w.record()?.status).toBe("skipped");
    expect(w.record()?.skip?.reason).toContain("against this runner's limit of 2000000");
    expect(w.record()?.skip?.reason).toContain("allows no bonded claim");
    // The same order with the claimed path is taken: delivery can be claimed with 32 bytes.
    const claimed = world({ receiptOnlyOrders: "always", maxSettleGas: 2_000_000n });
    claimed.desk.open(ORDER_ID);
    await claimed.machine.tick();
    expect(claimed.record()?.status).toBe("claimed");
  });
});

describe("a conditional order", () => {
  /** An order whose price ramps from 0.4 to 3 IMD once its condition has been latched. */
  function conditional(w: World, holds: boolean, price: bigint, maxPay = IMD(30)) {
    const entry = w.desk.open(
      ORDER_ID,
      { condTarget: EMPLOYER, condMet: false, minPay: IMD(4), maxPay },
      { price },
    );
    entry.conditionHolds = holds;
    return entry;
  }

  it("is left alone while its condition does not hold, and nothing is sent", async () => {
    const w = world();
    conditional(w, false, IMD(30));
    await ticks(w, 2);
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.skip?.reason).toBe("its condition does not hold yet");
    expect(w.desk.writes()).toEqual([]);
  });

  it("is claimed directly when the condition holds and the price already covers the cost", async () => {
    const w = world();
    const entry = conditional(w, true, IMD(30));
    await w.machine.tick();
    // The claim latches the condition itself: no separate transaction.
    expect(wrote(w, "trigger")).toEqual([]);
    expect(wrote(w, "claim")).toEqual([`claim ${ORDER_ID}`]);
    expect(entry.order.condMet).toBe(true);
    expect(w.record()?.status).toBe("claimed");
  });

  it("latches a condition that holds when only the risen price would cover the cost", async () => {
    const w = world();
    const entry = conditional(w, true, IMD(4)); // 0.36 IMD to the runner, under the 0.5 IMD fee
    await w.machine.tick();
    expect(wrote(w, "trigger")).toEqual([`trigger ${ORDER_ID}`]);
    expect(wrote(w, "claim")).toEqual([]);
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.skip?.reason).toContain("until the condition is latched and the price has risen");
    // Latched once: the next looks only wait for the price.
    await ticks(w, 3);
    expect(wrote(w, "trigger")).toHaveLength(1);
    // The ramp reaches a price that pays.
    entry.price = IMD(10);
    w.wait(3600);
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
  });

  it("does not spend gas latching an order whose top price would not pay either", async () => {
    const w = world();
    conditional(w, true, IMD(4), IMD(5)); // at most 0.45 IMD to the runner
    await ticks(w, 2);
    expect(w.desk.writes()).toEqual([]);
    expect(w.record()?.skip?.reason).toContain("its top price would pay");
  });

  it("does not latch when told not to, in a dry run, or with the kill switch on", async () => {
    const off = world({ latchConditions: false });
    conditional(off, true, IMD(4));
    await off.machine.tick();
    expect(off.desk.writes()).toEqual([]);

    const dry = world({ mode: "dry-run" });
    conditional(dry, true, IMD(4));
    await dry.machine.tick();
    expect(dry.desk.writes()).toEqual([]);

    const killed = world();
    killed.kill(true);
    conditional(killed, true, IMD(4));
    await killed.machine.tick();
    expect(killed.desk.writes()).toEqual([]);
  });

  it("carries on when the latch cannot be sent: somebody else may have sent it", async () => {
    const w = world();
    conditional(w, true, IMD(4));
    w.desk.failNext = new ChainWriteError("simulation_reverted", '"latch" would revert: BadState');
    await w.machine.tick();
    expect(w.record()?.status).toBe("seen");
    expect(w.loud().some((l) => l.includes("could not be latched"))).toBe(true);
  });
});

describe("the header of a claim", () => {
  it("is read from the desk and compared before any payment is signed", async () => {
    const w = world({ registerAtOnce: false });
    w.desk.open(ORDER_ID);
    await ticks(w, 2);
    expect(w.record()?.headerChecked).toBe(true);
    expect(w.paying()).toHaveLength(1);
  });

  it("stops the payment and gives the order back when the desk expects another header", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    // The header of claim 2, where this runner holds claim 1.
    w.desk.headerOverride = objectiveFor(ORDER_ID, 2).slice(0, 85);
    await ticks(w, 3);
    expect(w.paying()).toEqual([]);
    expect(wrote(w, "release")).toEqual([`release ${ORDER_ID}`]);
    expect(w.record()?.status).toBe("released");
    expect(w.record()?.outcome).toContain("could never settle the order");
    expect(w.loud().some((l) => l.includes("the header the desk reports for this claim"))).toBe(true);
    // A cause like this repeats on every order, so it counts toward stopping.
    expect(w.store.data.breaker?.failures).toBe(1);
  });

  it("signs nothing while the desk's header cannot be read, and reads it again on the next pass", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
    const real = w.desk.headerOf.bind(w.desk);
    w.desk.headerOf = async () => {
      throw new Error("the node did not answer");
    };
    await w.machine.tick();
    expect(w.paying()).toEqual([]);
    expect(w.record()?.status).toBe("claimed");
    expect(w.record()?.lastError).toContain("did not answer");
    w.desk.headerOf = real;
    await w.machine.tick();
    expect(w.paying()).toHaveLength(1);
  });
});

describe("the price a claim fixed", () => {
  it("gives the order back when the chain shows a price below the swarm's fee", async () => {
    const w = world();
    const entry = w.desk.open(ORDER_ID, {}, { price: IMD(30) });
    // The claim is mined at a far lower price than was read before it (a reading from another
    // fork of the chain, say). 0.3 IMD pays the runner 0.27, and giving back costs 0.025.
    const claim = w.desk.claim.bind(w.desk);
    w.desk.claim = async (id) => {
      entry.price = IMD(3);
      return claim(id);
    };
    await w.machine.tick();
    expect(w.record()?.status).toBe("releasing");
    expect(w.record()?.outcome).toContain("less than the swarm's fee");
    expect(w.paying()).toEqual([]);
    await w.machine.tick();
    expect(wrote(w, "release")).toEqual([`release ${ORDER_ID}`]);
    expect(releaseCut(DESK_CONST.MIN_BOND)).toBe(25n * 10n ** 15n);
  });

  it("goes on when the price still covers the fee after what a release would cost", async () => {
    const w = world();
    w.desk.open(ORDER_ID, {}, { price: IMD(30) });
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
  });
});

describe("a job the swarm opened under another template", () => {
  it("is given back for a tenth of the bond instead of registered", async () => {
    const w = world({ registerAtOnce: false });
    w.desk.open(ORDER_ID);
    await ticks(w, 2);
    expect(w.record()?.status).toBe("paid");
    // The job exists, with the right objective, under a template whose records are another kind.
    w.api.jobs.get(JOB_ID)!.template = "research";
    await w.machine.tick();
    expect(w.record()?.status).toBe("releasing");
    expect(w.record()?.outcome).toContain('under the template "research"');
    expect(wrote(w, "register")).toEqual([]);
    await w.machine.tick();
    expect(wrote(w, "release")).toEqual([`release ${ORDER_ID}`]);
    expect(w.store.data.breaker?.failures).toBe(1);
  });

  it("is registered all the same once the order can no longer be given back", async () => {
    const w = world({ registerAtOnce: false });
    w.desk.open(ORDER_ID);
    await ticks(w, 2);
    w.api.jobs.get(JOB_ID)!.template = "research";
    // Two minutes before the claim window ends a release is no longer tried.
    w.wait(DESK_CONST.CLAIM_WINDOW - 60);
    await w.machine.tick();
    // Registered: when its receipt lands, a record of another kind returns the whole bond.
    expect(wrote(w, "register")).toEqual([`register ${ORDER_ID} ${JOB_ID}`]);
    expect(w.record()?.status).toBe("registered");
  });
});

describe("the gas a settlement is sent with", () => {
  it("is capped at the runner's limit, and is not marked urgent far from the deadline", async () => {
    const w = await upToRegistered();
    const { hash } = finishJob(w);
    w.desk.receipts.set(JOB_ID, hash);
    await w.machine.tick();
    expect(w.record()?.status).toBe("delivered");
    expect(w.desk.gasCaps.get(`settle ${ORDER_ID}`)).toBe(3_000_000n);
    expect(w.desk.urgentSettles).toEqual([false]);
  });

  it("may pay the higher fee limits when the delivery deadline is near", async () => {
    const w = await upToRegistered();
    const { hash } = finishJob(w);
    w.desk.receipts.set(JOB_ID, hash);
    // Five hours before the deadline: a settlement that waits for cheaper gas could cost the bond.
    w.wait(7 * DAY - 5 * 3600);
    await w.machine.tick();
    expect(w.desk.urgentSettles).toEqual([true]);
    expect(w.record()?.status).toBe("delivered");
  });

  it("may pay the higher fee limits when the delivery claim is challenged", async () => {
    const w = await upToRegistered();
    const { hash } = finishJob(w);
    await w.machine.tick();
    expect(w.record()?.status).toBe("asserted");
    w.desk.orders.get(ORDER_ID)!.order.state = ORDER_STATE.Disputed;
    w.desk.receipts.set(JOB_ID, hash);
    await w.machine.tick();
    expect(w.desk.urgentSettles).toEqual([true]);
    expect(w.record()?.status).toBe("delivered");
  });

  it("claims delivery instead when the settlement would need more gas than the limit", async () => {
    const w = await upToRegistered();
    const big = workRecord({
      jobId: JOB_ID,
      objective: objectiveFor(ORDER_ID, 1),
      agentIds: Array.from({ length: 200 }, (_, i) => String(50_000 + i)),
    });
    finishJob(w);
    w.api.records.set(JOB_ID, big);
    w.desk.receipts.set(JOB_ID, keccak256(big));
    w.desk.settleGasLimitBytes = 2_000; // the writer refuses it as over its gas limit
    await w.machine.tick();
    expect(wrote(w, "settle")).toHaveLength(1);
    expect(w.desk.writes().at(-1)).toBe(`claimDelivered ${ORDER_ID} ${keccak256(big)}`);
    expect(w.record()?.status).toBe("asserted");
    expect(w.loud().some((l) => l.includes("could not be settled with its receipt"))).toBe(true);
  });

  it("says so, at error, when such a record is on an order that allows no claim", async () => {
    const w = world({ receiptOnlyOrders: "always" });
    w.desk.open(ORDER_ID, { flags: ORDER_FLAG.CALLBACK });
    await ticks(w, 3);
    expect(w.record()?.status).toBe("registered");
    const { hash } = finishJob(w);
    w.desk.receipts.set(JOB_ID, hash);
    w.desk.settleGasLimitBytes = 10;
    await ticks(w, 2);
    expect(w.record()?.status).toBe("registered");
    expect(wrote(w, "claimDelivered")).toEqual([]);
    expect(
      w.log.lines.filter((l) => l.includes("too large for this runner to settle") && l.includes('"error"')),
    ).toHaveLength(1);
  });

  it("caps the gas of a failure report the same way", async () => {
    const w = await upToRegistered();
    const { hash } = finishJob(w, { state: "blocked" });
    w.desk.receipts.set(JOB_ID, hash);
    await w.machine.tick();
    expect(wrote(w, "reportFailed")).toHaveLength(1);
    expect(w.desk.gasCaps.get(`reportFailed ${ORDER_ID}`)).toBe(3_000_000n);
    expect(w.record()?.status).toBe("released");
    expect(w.record()?.outcome).toContain("bond returned");
  });
});

describe("after a delivery claim nobody challenged", () => {
  /** An order finalized on its claim, with the record the claim named. */
  async function finalized(overrides: Parameters<typeof upToRegistered>[0] = {}) {
    const w = await upToRegistered(overrides);
    const { hash, bytes } = finishJob(w);
    await w.machine.tick();
    expect(w.record()?.status).toBe("asserted");
    w.setTime(NOW + DESK_CONST.CHALLENGE_WINDOW + 1);
    await w.machine.tick();
    expect(w.desk.writes().at(-1)).toBe(`finalize ${ORDER_ID}`);
    return { w, hash, bytes };
  }

  it("stamps the order proven when its receipt lands", async () => {
    const { w, hash } = await finalized();
    expect(w.record()?.status).toBe("unproven");
    // No receipt yet: looked at every ten minutes, nothing sent.
    w.wait(601);
    await w.machine.tick();
    expect(wrote(w, "stamp")).toEqual([]);
    // The receipt lands, days later.
    w.desk.receipts.set(JOB_ID, hash);
    w.wait(3 * DAY);
    await w.machine.tick();
    expect(wrote(w, "stamp")).toEqual([`stamp ${ORDER_ID} ${hash}`]);
    expect(w.desk.gasCaps.get(`stamp ${ORDER_ID}`)).toBe(3_000_000n);
    expect(w.desk.orders.get(ORDER_ID)?.order.proven).toBe(true);
    expect(w.record()?.status).toBe("delivered");
    expect(w.record()?.outcome).toContain("finalized unchallenged");
    expect(w.record()?.outcome).toContain("stamped proven");
    // A finished order is left alone.
    w.wait(DAY);
    await ticks(w, 2);
    expect(wrote(w, "stamp")).toHaveLength(1);
  });

  it("looks for the receipt every ten minutes, not on every pass", async () => {
    const { w } = await finalized();
    const reads = w.desk.reads;
    await ticks(w, 5);
    expect(w.desk.reads).toBe(reads);
    w.wait(601);
    await w.machine.tick();
    expect(w.desk.reads).toBe(reads + 1);
  });

  it("stamps with whatever record the registry holds, not the one the claim named", async () => {
    const { w, hash } = await finalized();
    // The swarm wrote a second record for the job; the registry holds that one.
    const second = workRecord({ jobId: JOB_ID, objective: objectiveFor(ORDER_ID, 1), agentIds: [] });
    w.api.olderRecords.set(JOB_ID, [w.api.records.get(JOB_ID)!]);
    w.api.records.set(JOB_ID, second);
    w.desk.receipts.set(JOB_ID, keccak256(second));
    w.wait(601);
    await w.machine.tick();
    expect(keccak256(second)).not.toBe(hash);
    expect(wrote(w, "stamp")).toEqual([`stamp ${ORDER_ID} ${keccak256(second)}`]);
  });

  it("does not stamp with a receipt that would not prove the order, and keeps looking", async () => {
    const { w } = await finalized();
    const blocked = workRecord({ jobId: JOB_ID, objective: objectiveFor(ORDER_ID, 1), state: "blocked" });
    w.api.records.set(JOB_ID, blocked);
    w.desk.receipts.set(JOB_ID, keccak256(blocked));
    w.wait(601);
    await w.machine.tick();
    expect(wrote(w, "stamp")).toEqual([]);
    expect(w.record()?.status).toBe("unproven");
    expect(w.loud().some((l) => l.includes("does not prove this order"))).toBe(true);
  });

  it("notices that somebody else stamped it", async () => {
    const { w } = await finalized();
    w.desk.orders.get(ORDER_ID)!.order.proven = true;
    w.wait(601);
    await w.machine.tick();
    expect(w.record()?.status).toBe("delivered");
    expect(w.record()?.outcome).toContain("matched to its receipt on chain");
    expect(wrote(w, "stamp")).toEqual([]);
  });

  it("stops looking when the watch is over, and says the order stays unproven", async () => {
    const { w, hash } = await finalized({ stampWatchSeconds: 2 * DAY });
    w.wait(2 * DAY + 601);
    await w.machine.tick();
    expect(w.record()?.status).toBe("delivered");
    expect(w.record()?.outcome).toContain("stays unproven");
    w.desk.receipts.set(JOB_ID, hash);
    w.wait(DAY);
    await ticks(w, 2);
    expect(wrote(w, "stamp")).toEqual([]);
  });

  it("does not stamp when the operator switched it off", async () => {
    const { w, hash } = await finalized({ stampAfterFinalize: false });
    expect(w.record()?.status).toBe("delivered");
    expect(w.record()?.outcome).toContain("not yet proven");
    w.desk.receipts.set(JOB_ID, hash);
    w.wait(DAY);
    await ticks(w, 2);
    expect(wrote(w, "stamp")).toEqual([]);
  });

  it("leaves the stamp for a later pass when it cannot be sent now", async () => {
    const { w, hash } = await finalized();
    w.desk.receipts.set(JOB_ID, hash);
    w.desk.failNext = new ChainWriteError("fee_too_high", "the network asks more than the cap");
    w.wait(601);
    await w.machine.tick();
    expect(w.record()?.status).toBe("unproven");
    w.wait(601);
    await w.machine.tick();
    expect(w.record()?.status).toBe("delivered");
  });
});

describe("a challenged delivery claim at the delivery deadline", () => {
  /** A claim that was challenged and that no receipt has decided. */
  async function disputed(overrides: Parameters<typeof upToRegistered>[0] = {}) {
    const w = await upToRegistered(overrides);
    const { hash } = finishJob(w);
    await w.machine.tick();
    expect(w.record()?.status).toBe("asserted");
    const entry = w.desk.orders.get(ORDER_ID)!;
    entry.order.state = ORDER_STATE.Disputed;
    entry.claim.challenger = EMPLOYER;
    return { w, hash, deadline: entry.claim.registeredAt + entry.order.deliverySecs };
  }

  it("is not ended by the runner at the deadline: a receipt may still decide it", async () => {
    const { w, deadline } = await disputed();
    w.setTime(deadline + 1);
    await w.machine.tick();
    expect(wrote(w, "timeout")).toEqual([]);
    expect(w.record()?.status).toBe("asserted");
    // One second before the day it waits is over.
    w.setTime(deadline + DAY - 1);
    await w.machine.tick();
    expect(wrote(w, "timeout")).toEqual([]);
  });

  it("is ended by the runner a day later, to take back nine tenths of its bond", async () => {
    const { w, deadline } = await disputed();
    w.setTime(deadline + DAY);
    await w.machine.tick();
    expect(wrote(w, "timeout")).toEqual([`timeout ${ORDER_ID}`]);
    expect(w.record()?.status).toBe("released");
    expect(w.record()?.outcome).toContain("nine tenths of the bond come back");
    expect(w.record()?.outcome).toContain("the swarm's fee is spent");
    expect(w.desk.orders.get(ORDER_ID)?.order.state).toBe(ORDER_STATE.Refunded);
    // What it kept by doing so, with the minimum bond.
    expect(DESK_CONST.MIN_BOND - releaseCut(DESK_CONST.MIN_BOND)).toBe(225n * 10n ** 15n);
  });

  it("settles instead when a receipt has landed, however late", async () => {
    const { w, hash, deadline } = await disputed();
    w.desk.receipts.set(JOB_ID, hash);
    w.setTime(deadline + 3 * DAY);
    await w.machine.tick();
    expect(wrote(w, "timeout")).toEqual([]);
    expect(w.desk.writes().at(-1)).toBe(`settle ${ORDER_ID} ${hash}`);
    expect(w.record()?.status).toBe("delivered");
  });

  it("waits as long as the operator set", async () => {
    const { w, deadline } = await disputed({ disputeTimeoutAfter: 0 });
    w.setTime(deadline - 1);
    await w.machine.tick();
    expect(wrote(w, "timeout")).toEqual([]);
    w.setTime(deadline);
    await w.machine.tick();
    expect(wrote(w, "timeout")).toEqual([`timeout ${ORDER_ID}`]);
  });
});

describe("a registered job at the delivery deadline", () => {
  it("is said once, at error: the bond is anyone's to forfeit, and a receipt still settles", async () => {
    const w = world({ receiptOnlyOrders: "always" });
    w.desk.open(ORDER_ID, { flags: 0 });
    await ticks(w, 3);
    const { hash } = finishJob(w);
    const entry = w.desk.orders.get(ORDER_ID)!;
    const deadline = entry.claim.registeredAt + entry.order.deliverySecs;
    w.setTime(deadline - 1);
    await w.machine.tick();
    expect(w.log.lines.some((l) => l.includes("the delivery deadline has passed"))).toBe(false);
    w.setTime(deadline);
    await ticks(w, 3);
    const said = w.log.lines.filter((l) => l.includes("the delivery deadline has passed"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('"level":"error"');
    // Timeouts are lazy: the receipt lands before anybody called `timeout`, and still settles.
    w.desk.receipts.set(JOB_ID, hash);
    await w.machine.tick();
    expect(w.record()?.status).toBe("delivered");
    expect(w.desk.urgentSettles).toEqual([true]);
  });
});

describe("the kinds a runner opens", () => {
  it("come from the shared table, each seen in a real work record", async () => {
    const w = world({
      templates: new Map([
        [kindHash("skill:research-report"), "skill:research-report"],
        [kindHash("skill:create-image"), "skill:create-image"],
      ]),
    });
    w.desk.open(1n, {}, { kind: "skill:create-image" });
    w.desk.open(2n, {}, { kind: "skill:create-video" });
    w.desk.open(3n, {}, { kind: "research" });
    await w.machine.tick();
    expect(w.record(1n)?.status).toBe("claimed");
    expect(w.record(2n)?.skip?.reason).toContain("is not on this runner's allow-list");
    // `research` is a kind the swarm writes, but no job body for it is in the table.
    expect(w.record(3n)?.skip?.reason).toContain("not in the shared table");
    expect(w.record(1n)?.claim?.ticket).toBeDefined();
    expect(RUNNER).toBeDefined();
  });
});
