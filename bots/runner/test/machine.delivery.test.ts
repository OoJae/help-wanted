/**
 * From a registered job to a paid order: which record the runner believes, when it stakes its bond
 * on one, and what it does when the job did not end well.
 */
import { keccak256, stringToBytes } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESK as DESK_CONST, ORDER_STATE } from "@help-wanted/shared";
import { ChainWriteError } from "../src/chain.js";
import { spentToday } from "../src/store.js";
import { objectiveFor, workRecord } from "./fakes.js";
import { NOW, finishJob, raw, ticks, upToRegistered, world, type World } from "./harness.js";
import { JOB_ID, ORDER_ID, PRICE, RUNNER, SPEC } from "./world.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => {
  vi.useRealTimers();
});

const wrote = (w: World, what: string) => w.desk.writes().filter((c) => c.startsWith(what));

/** A second record for the job, as the swarm writes one at delivery: no signals, otherwise the same work. */
function supersede(w: World) {
  const first = w.api.records.get(JOB_ID);
  if (!first) throw new Error("no first record");
  const second = workRecord({ jobId: JOB_ID, objective: objectiveFor(ORDER_ID, 1), agentIds: [] });
  w.api.olderRecords.set(JOB_ID, [first]);
  w.api.records.set(JOB_ID, second); // listed first, as the API lists the newest
  return { bytes: second, hash: keccak256(second) };
}

describe("what the runner checks before it stakes its bond on a record", () => {
  it("does nothing with a job that another wallet paid for", async () => {
    const w = await upToRegistered();
    finishJob(w, { paidBy: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" });
    await w.machine.tick();
    expect(w.record()?.status).toBe("registered");
    expect(w.record()?.lastError).toContain("not by this runner");
    expect(wrote(w, "claimDelivered")).toEqual([]);
    expect(wrote(w, "settle")).toEqual([]);
  });

  it.each([
    ["another kind", { kind: "audit" }, "kind"],
    ["an objective without this claim's header", { objective: objectiveFor(ORDER_ID, 2) }, "header"],
    ["another spec after the right header", { objective: `${objectiveFor(ORDER_ID, 1)} extra` }, "spec"],
    ["a state other than completed", { state: "blocked" }, "blocked"],
  ])("does not claim delivery on a record with %s", async (_note, fields, words) => {
    const w = await upToRegistered();
    finishJob(w, fields);
    // The API says the job completed; the record says otherwise.
    w.api.jobs.get(JOB_ID)!.state = "completed";
    await ticks(w, 2);
    expect(w.record()?.status).toBe("registered");
    expect(w.record()?.lastError).toContain(words);
    expect(wrote(w, "claimDelivered")).toEqual([]);
    expect(wrote(w, "settle")).toEqual([]);
    // Said once, not on every pass.
    expect(w.log.lines.filter((l) => l.includes("record does not settle the order"))).toHaveLength(1);
  });

  it("reads a record's state as the bytes the desk hashes, not as text that decodes the same", async () => {
    const w = await upToRegistered();
    const good = new TextDecoder().decode(
      workRecord({ jobId: JOB_ID, objective: objectiveFor(ORDER_ID, 1) }),
    );
    // `completed` decodes to "completed" and hashes to something else: the desk would
    // refuse it with NotCompleted, so the bond is not staked on it.
    const odd = stringToBytes(good.replace('"state":"completed"', '"state":"\\u0063ompleted"'));
    expect(keccak256(odd)).not.toBe(keccak256(stringToBytes(good)));
    finishJob(w);
    w.api.records.set(JOB_ID, odd);
    await ticks(w, 2);
    expect(w.record()?.status).toBe("registered");
    expect(wrote(w, "claimDelivered")).toEqual([]);
    expect(w.record()?.lastError).toContain("the record's state is");
  });

  it("does not claim delivery when the challenge window and the day after it no longer fit", async () => {
    const w = await upToRegistered();
    finishJob(w);
    // Seven days of delivery time. The desk wants the 24 hour challenge window and the 24 hours
    // kept for a dispute to end by the deadline: just under two days before it is too late.
    w.setTime(NOW + 7 * 86400 - DESK_CONST.CHALLENGE_WINDOW - DESK_CONST.DISPUTE_WINDOW + 10);
    await ticks(w, 2);
    expect(w.record()?.status).toBe("registered");
    expect(wrote(w, "claimDelivered")).toEqual([]);
    expect(w.loud().filter((l) => l.includes("too late to claim delivery"))).toHaveLength(1);
  });

  it("claims while both windows still fit", async () => {
    const w = await upToRegistered();
    finishJob(w);
    w.setTime(NOW + 7 * 86400 - DESK_CONST.CHALLENGE_WINDOW - DESK_CONST.DISPUTE_WINDOW - 600);
    await w.machine.tick();
    expect(w.record()?.status).toBe("asserted");
  });
});

describe("the newest record is let stand before delivery is claimed on it", () => {
  it("waits the settling time, and starts over when a newer record appears", async () => {
    const w = await upToRegistered({ claimSettleSeconds: 600 });
    const first = finishJob(w);
    await w.machine.tick(); // first sight of the job's record
    expect(w.record()?.status).toBe("registered");
    expect(w.record()?.recordSeen).toEqual({ hash: first.hash, at: NOW });
    w.wait(300);
    await w.machine.tick();
    expect(wrote(w, "claimDelivered")).toEqual([]);

    // The swarm publishes the work and writes a second record, as it has done for real jobs.
    const second = supersede(w);
    w.wait(200);
    await w.machine.tick();
    expect(w.record()?.recordSeen).toEqual({ hash: second.hash, at: NOW + 500 });
    w.wait(400); // 900 seconds since the first, but only 400 since the second
    await w.machine.tick();
    expect(wrote(w, "claimDelivered")).toEqual([]);
    w.wait(250);
    await w.machine.tick();
    expect(w.record()?.status).toBe("asserted");
    expect(w.desk.writes().at(-1)).toBe(`claimDelivered ${ORDER_ID} ${second.hash}`);
  });
});

describe("the registry is the source of truth", () => {
  it("settles with the record the registry holds, not the newest one the API lists", async () => {
    const w = await upToRegistered();
    const first = finishJob(w);
    w.desk.receipts.set(JOB_ID, first.hash); // the first record's receipt is on chain
    const second = supersede(w); // a second record exists, its receipt still queued
    await w.machine.tick();
    // Claiming delivery of the second would stake the bond for nothing: the first settles now.
    expect(w.desk.writes().at(-1)).toBe(`settle ${ORDER_ID} ${first.hash}`);
    expect(wrote(w, "claimDelivered")).toEqual([]);
    expect(w.record()?.status).toBe("delivered");
    expect(second.hash).not.toBe(first.hash);
  });

  it("settles a claim it made on a first record with the second record's receipt", async () => {
    const w = await upToRegistered();
    const first = finishJob(w);
    await w.machine.tick();
    expect(w.desk.writes().at(-1)).toBe(`claimDelivered ${ORDER_ID} ${first.hash}`);
    // The swarm writes a second record; the writer lands its receipt, and the registry now
    // answers with the newer hash. The older record can no longer be proven.
    const second = supersede(w);
    w.desk.receipts.set(JOB_ID, second.hash);
    await w.machine.tick();
    // Any receipt that passes the desk's checks pays, whatever hash was named.
    expect(w.desk.writes().at(-1)).toBe(`settle ${ORDER_ID} ${second.hash}`);
    expect(w.record()?.status).toBe("delivered");
  });

  it("says so when the registry holds another record than the one it named and cannot settle with it", async () => {
    const w = await upToRegistered();
    const first = finishJob(w);
    await w.machine.tick();
    const second = supersede(w);
    w.desk.receipts.set(JOB_ID, second.hash);
    w.desk.settle = async () => {
      throw new ChainWriteError("simulation_reverted", '"settle order 7" would revert: GasShort');
    };
    await ticks(w, 3);
    expect(w.record()?.status).toBe("asserted");
    expect(w.record()?.recordHash).toBe(first.hash);
    expect(w.loud().filter((l) => l.includes("could not be settled with its receipt"))).toHaveLength(1);
  });

  it("says so when the registry holds a receipt that refutes its claim", async () => {
    const w = await upToRegistered();
    finishJob(w);
    await w.machine.tick();
    expect(w.record()?.status).toBe("asserted");
    // A later record of the same job that did not end completed.
    const blocked = workRecord({ jobId: JOB_ID, objective: objectiveFor(ORDER_ID, 1), state: "blocked" });
    w.api.olderRecords.set(JOB_ID, [w.api.records.get(JOB_ID)!]);
    w.api.records.set(JOB_ID, blocked);
    w.desk.receipts.set(JOB_ID, keccak256(blocked));
    await ticks(w, 3);
    expect(wrote(w, "settle")).toEqual([]);
    const said = w.log.lines.filter((l) => l.includes("the delivery claim can be refuted with it"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('"level":"error"');
  });
});

describe("a record that cannot be carried in one transaction", () => {
  // Real audit records run from 72 KB to 255 KB. A node refuses a transaction above 128 KB, and
  // `settle` carries the whole record. The bonded claim needs 32 bytes.

  it("claims delivery on the registry's hash instead of trying to settle", async () => {
    const w = await upToRegistered({ maxSettleRecordBytes: 2_000 });
    const big = workRecord({
      jobId: JOB_ID,
      objective: objectiveFor(ORDER_ID, 1),
      agentIds: Array.from({ length: 200 }, (_, i) => String(50_000 + i)),
    });
    expect(big.length).toBeGreaterThan(2_000);
    finishJob(w);
    w.api.records.set(JOB_ID, big);
    w.desk.receipts.set(JOB_ID, keccak256(big));
    await w.machine.tick();
    expect(wrote(w, "settle")).toEqual([]);
    expect(w.desk.writes().at(-1)).toBe(`claimDelivered ${ORDER_ID} ${keccak256(big)}`);
    expect(w.record()?.status).toBe("asserted");
    // Unchallenged, it is finalized when the window is over, receipt or no receipt.
    w.setTime(NOW + DESK_CONST.CHALLENGE_WINDOW + 1);
    await w.machine.tick();
    expect(w.desk.writes().at(-1)).toBe(`finalize ${ORDER_ID}`);
    // Paid on the claim. The record is too large for this runner to stamp either, and it says so.
    expect(w.record()?.status).toBe("unproven");
    w.wait(601);
    await w.machine.tick();
    expect(wrote(w, "stamp")).toEqual([]);
    expect(w.visible().some((l) => l.includes("too large for this runner to stamp"))).toBe(true);
  });

  it("claims delivery when settle is refused as too costly", async () => {
    const w = await upToRegistered();
    const { hash } = finishJob(w);
    w.desk.receipts.set(JOB_ID, hash);
    w.desk.settle = async () => {
      throw new ChainWriteError("cost_too_high", '"settle order 7" would cost more than the limit');
    };
    await w.machine.tick();
    expect(w.desk.writes().at(-1)).toBe(`claimDelivered ${ORDER_ID} ${hash}`);
    expect(w.record()?.status).toBe("asserted");
  });

  it("finalizes a claim whose receipt landed but could never be sent", async () => {
    const w = await upToRegistered();
    const { hash } = finishJob(w);
    await w.machine.tick();
    expect(w.record()?.status).toBe("asserted");
    w.desk.receipts.set(JOB_ID, hash); // the receipt arrives during the challenge window
    w.desk.settle = async () => {
      throw new ChainWriteError("cost_too_high", '"settle order 7" would cost more than the limit');
    };
    await w.machine.tick();
    expect(w.record()?.status).toBe("asserted");
    w.setTime(NOW + DESK_CONST.CHALLENGE_WINDOW + 3600);
    await w.machine.tick();
    expect(w.desk.writes().at(-1)).toBe(`finalize ${ORDER_ID}`);
    expect(w.record()?.status).toBe("unproven");
  });

  it("stops and says so when nothing else can be sent either", async () => {
    const w = await upToRegistered();
    const { hash } = finishJob(w);
    w.desk.receipts.set(JOB_ID, hash);
    w.desk.settle = async () => {
      throw new ChainWriteError("pending", "an earlier transaction is still waiting to be mined");
    };
    await w.machine.tick();
    // A transaction is waiting: no other may go out behind it, the delivery claim included.
    expect(wrote(w, "claimDelivered")).toEqual([]);
    expect(w.record()?.lastError).toContain("pending");
  });

  it("names the chunked proof when a challenged claim's winning receipt is too large", async () => {
    const w = await upToRegistered({ maxSettleRecordBytes: 2_000 });
    const big = workRecord({
      jobId: JOB_ID,
      objective: objectiveFor(ORDER_ID, 1),
      agentIds: Array.from({ length: 200 }, (_, i) => String(50_000 + i)),
    });
    finishJob(w);
    w.api.records.set(JOB_ID, big);
    await w.machine.tick();
    expect(w.record()?.status).toBe("asserted");
    const entry = w.desk.orders.get(ORDER_ID)!;
    entry.order.state = ORDER_STATE.Disputed;
    w.desk.receipts.set(JOB_ID, keccak256(big));
    await ticks(w, 3);
    const said = w.log.lines.filter((l) => l.includes("proveChunks"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('"level":"error"');
    expect(wrote(w, "settle")).toEqual([]);
  });
});

describe("a challenged delivery claim", () => {
  it("is said once, and settled the moment a receipt lands", async () => {
    const w = await upToRegistered();
    const { hash } = finishJob(w);
    await w.machine.tick();
    const entry = w.desk.orders.get(ORDER_ID)!;
    entry.order.state = ORDER_STATE.Disputed;
    await ticks(w, 4);
    expect(w.loud().filter((l) => l.includes("the delivery claim is challenged"))).toHaveLength(1);
    // Past the challenge window a disputed claim is not finalized: only a receipt or the arbiter ends it.
    w.setTime(NOW + DESK_CONST.CHALLENGE_WINDOW + 10);
    await w.machine.tick();
    expect(wrote(w, "finalize")).toEqual([]);
    w.desk.receipts.set(JOB_ID, hash);
    await w.machine.tick();
    expect(w.desk.writes().at(-1)).toBe(`settle ${ORDER_ID} ${hash}`);
    expect(w.record()?.status).toBe("delivered");
  });
});

describe("a job that did not end well", () => {
  it("reports a blocked job with its receipt, and waits while there is none", async () => {
    const w = await upToRegistered();
    const { hash } = finishJob(w, { state: "blocked" });
    await ticks(w, 3);
    expect(w.record()?.status).toBe("registered");
    expect(wrote(w, "reportFailed")).toEqual([]);
    expect(w.loud().filter((l) => l.includes("job blocked; waiting for its receipt"))).toHaveLength(1);
    w.desk.receipts.set(JOB_ID, hash);
    await w.machine.tick();
    expect(w.desk.writes().at(-1)).toBe(`reportFailed ${ORDER_ID} ${hash}`);
    expect(w.record()?.status).toBe("released");
    expect(w.record()?.outcome).toContain("bond returned");
  });

  it("reports a completed record of another kind once its receipt is on chain: the bond comes back", async () => {
    const w = await upToRegistered();
    const { hash } = finishJob(w, { kind: "research" });
    w.api.jobs.get(JOB_ID)!.template = "research";
    await w.machine.tick();
    expect(wrote(w, "reportFailed")).toEqual([]); // no receipt yet: nothing to report with
    w.desk.receipts.set(JOB_ID, hash);
    await w.machine.tick();
    expect(w.desk.writes().at(-1)).toBe(`reportFailed ${ORDER_ID} ${hash}`);
    expect(w.record()?.status).toBe("released");
    expect(w.record()?.outcome).toContain('of kind "research"');
    // A wrong kind means the job body does not make the kind the order pins: it counts as a failure.
    expect(w.store.data.breaker?.failures).toBe(1);
  });

  it("does not report a receipt that shows another objective: that would hand the bond over", async () => {
    const w = await upToRegistered();
    const { hash } = finishJob(w, { objective: objectiveFor(ORDER_ID, 2) });
    w.desk.receipts.set(JOB_ID, hash);
    await ticks(w, 3);
    expect(wrote(w, "reportFailed")).toEqual([]);
    expect(wrote(w, "settle")).toEqual([]);
    expect(w.record()?.status).toBe("registered");
    expect(w.log.lines.filter((l) => l.includes("shows another objective than this claim's"))).toHaveLength(
      1,
    );
  });

  it("does not try to report with a record too large for one transaction", async () => {
    const w = await upToRegistered({ maxSettleRecordBytes: 2_000 });
    const big = workRecord({
      jobId: JOB_ID,
      objective: objectiveFor(ORDER_ID, 1),
      state: "blocked",
      agentIds: Array.from({ length: 200 }, (_, i) => String(50_000 + i)),
    });
    finishJob(w, { state: "blocked" });
    w.api.records.set(JOB_ID, big);
    w.desk.receipts.set(JOB_ID, keccak256(big));
    await ticks(w, 2);
    expect(wrote(w, "reportFailed")).toEqual([]);
    expect(w.log.lines.filter((l) => l.includes("too large for one transaction"))).toHaveLength(1);
  });

  it("says once that a completed job has no record", async () => {
    const w = await upToRegistered();
    w.api.jobs.get(JOB_ID)!.state = "completed";
    await ticks(w, 3);
    expect(w.record()?.status).toBe("registered");
    expect(w.loud().filter((l) => l.includes("it has no work record yet"))).toHaveLength(1);
  });
});

describe("a job is registered only when it is time", () => {
  // A registered job cannot be given back. If it then ends blocked while no receipt is being
  // written, the whole bond goes to the employer at the deadline. Until it is registered, the
  // order can be released for a tenth of the bond.
  const held = () => {
    const w = world({ registerAtOnce: false });
    w.desk.open(ORDER_ID);
    return w;
  };

  it("holds back while the job is running, and registers when it has completed", async () => {
    const w = held();
    await ticks(w, 4);
    expect(w.record()?.status).toBe("paid");
    expect(wrote(w, "register")).toEqual([]);
    finishJob(w);
    await w.machine.tick();
    expect(w.record()?.status).toBe("registered");
    expect(w.desk.writes().at(-1)).toBe(`register ${ORDER_ID} ${JOB_ID}`);
    await w.machine.tick();
    expect(w.record()?.status).toBe("asserted");
  });

  it("registers a job that is still running fifteen minutes before the claim window ends", async () => {
    const w = held();
    await ticks(w, 3);
    w.setTime(NOW + DESK_CONST.CLAIM_WINDOW - 16 * 60);
    await w.machine.tick();
    expect(wrote(w, "register")).toEqual([]);
    w.setTime(NOW + DESK_CONST.CLAIM_WINDOW - 14 * 60);
    await w.machine.tick();
    expect(w.record()?.status).toBe("registered");
  });

  it("gives the order back when the job ends blocked first, for a tenth of the bond", async () => {
    const w = held();
    await ticks(w, 3);
    finishJob(w, { state: "blocked" });
    await w.machine.tick();
    expect(w.record()?.status).toBe("releasing");
    expect(w.record()?.outcome).toContain("ended blocked before it was registered");
    await w.machine.tick();
    expect(w.record()?.status).toBe("released");
    expect(wrote(w, "register")).toEqual([]);
    expect(w.desk.writes().at(-1)).toBe(`release ${ORDER_ID}`);
  });

  it("registers a blocked job whose receipt is on chain, and gets the whole bond back with it", async () => {
    const w = held();
    await ticks(w, 3);
    const { hash } = finishJob(w, { state: "blocked" });
    w.desk.receipts.set(JOB_ID, hash);
    await w.machine.tick();
    expect(w.record()?.status).toBe("registered");
    await w.machine.tick();
    expect(w.desk.writes().at(-1)).toBe(`reportFailed ${ORDER_ID} ${hash}`);
    expect(w.record()?.status).toBe("released");
  });

  it("registers a job it cannot read rather than let the claim window run out", async () => {
    const w = held();
    await ticks(w, 2);
    expect(w.record()?.status).toBe("paid");
    w.api.job = async () => {
      throw new Error("api.imd.fun answered 503");
    };
    await ticks(w, 2);
    // While there is time it waits for the API: the job's objective should be looked at first.
    expect(wrote(w, "register")).toEqual([]);
    expect(w.record()?.lastError).toContain("503");
    w.setTime(NOW + DESK_CONST.CLAIM_WINDOW - 14 * 60);
    await w.machine.tick();
    // Fifteen minutes from the end an unregistered claim is about to cost the whole bond.
    expect(w.record()?.status).toBe("registered");
    expect(w.loud().some((l) => l.includes("registering it unread"))).toBe(true);
  });

  it("registers at once when told to", async () => {
    const w = world({ registerAtOnce: true });
    w.desk.open(ORDER_ID);
    await ticks(w, 3);
    expect(w.record()?.status).toBe("registered");
  });
});

describe("a job that does not carry the claim's objective", () => {
  it("is not registered: the order is given back and the failure counted", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    w.protocol.opensJob = false;
    await ticks(w, 2);
    expect(w.record()?.status).toBe("paid");
    // IdentityMD admitted the job, but stored its objective without the order header.
    w.api.jobs.set(JOB_ID, {
      state: "executing",
      template: "skill:research-report",
      objective: SPEC,
      paidBy: RUNNER.toLowerCase(),
    });
    await w.machine.tick();
    expect(w.record()?.status).toBe("releasing");
    expect(wrote(w, "register")).toEqual([]);
    expect(w.store.data.breaker?.failures).toBe(1);
    expect(
      w.log.lines.some(
        (l) => l.includes('"level":"error"') && l.includes("does not carry this claim's objective"),
      ),
    ).toBe(true);
    await w.machine.tick();
    expect(w.record()?.status).toBe("released");
  });
});

describe("a second job for a claim whose first ended blocked", () => {
  const SECOND_JOB = "9e3a7d2f-5c4b-4a6e-8d1f-2b3c4d5e6f70";
  const admitting = (jobId: string) => {
    const body = JSON.parse(raw("status-admitted.json")) as {
      admission: { result: { jobId: string; statusUrl: string; resultUrl: string } };
    };
    body.admission.result = { ...body.admission.result, jobId };
    return { status: 200, headers: {}, text: JSON.stringify(body) };
  };

  it("is not bought unless the operator allowed it, even when the caps would cover it", async () => {
    const w = await upToRegistered({ orderCap: 3n * PRICE, dailyCap: 10n * PRICE });
    finishJob(w, { state: "blocked" });
    w.wait(700);
    await ticks(w, 3);
    expect(w.paying()).toHaveLength(1);
    expect(w.record()?.retry).toBeUndefined();
  });

  it("is bought once only: a second job that blocks as well is not replaced", async () => {
    const w = await upToRegistered({ maxJobsPerOrder: 2, orderCap: 3n * PRICE, dailyCap: 10n * PRICE });
    finishJob(w, { state: "blocked" });
    w.protocol.status = () => admitting(SECOND_JOB);
    w.api.jobs.set(SECOND_JOB, {
      state: "executing",
      template: "skill:research-report",
      objective: objectiveFor(ORDER_ID, 1),
      paidBy: RUNNER.toLowerCase(),
    });
    w.wait(700);
    await ticks(w, 2);
    expect(w.record()?.jobId).toBe(SECOND_JOB);
    w.api.jobs.get(SECOND_JOB)!.state = "blocked";
    w.wait(700);
    await ticks(w, 3);
    expect(w.paying()).toHaveLength(2); // the caps had room for a third; the limit on jobs did not
    expect(w.record()?.retry).toBeUndefined();
  });

  it("is bought and registered in place of the first when allowed and within the caps", async () => {
    const w = await upToRegistered({ maxJobsPerOrder: 2, orderCap: 2n * PRICE });
    finishJob(w, { state: "blocked" });
    const firstKey = w.record()?.pay?.requestKey;
    w.protocol.status = () => admitting(SECOND_JOB);
    w.api.jobs.set(SECOND_JOB, {
      state: "executing",
      template: "skill:research-report",
      objective: objectiveFor(ORDER_ID, 1),
      paidBy: RUNNER.toLowerCase(),
    });
    w.wait(700); // the first quote has run out
    await ticks(w, 2);
    expect(w.paying()).toHaveLength(2);
    expect(w.record()?.jobId).toBe(SECOND_JOB);
    expect(w.record()?.pastJobs).toEqual([JOB_ID]);
    expect(w.record()?.retry).toBeUndefined();
    expect(w.record()?.pay?.series).toBe(2);
    expect(w.record()?.pay?.requestKey).not.toBe(firstKey);
    expect(w.desk.writes().at(-1)).toBe(`register ${ORDER_ID} ${SECOND_JOB}`);
    expect(w.record()?.spent).toBe((2n * PRICE).toString());
    expect(spentToday(w.store, NOW + 700)).toBe(2n * PRICE);

    // The second job completes and is claimed like any other.
    const bytes = workRecord({ jobId: SECOND_JOB, objective: objectiveFor(ORDER_ID, 1) });
    w.api.jobs.get(SECOND_JOB)!.state = "completed";
    w.api.records.set(SECOND_JOB, bytes);
    await w.machine.tick();
    expect(w.desk.writes().at(-1)).toBe(`claimDelivered ${ORDER_ID} ${keccak256(bytes)}`);
    // And a third is never bought.
    expect(w.paying()).toHaveLength(2);
  });

  it("is not bought when the per-order cap covers one fee only", async () => {
    const w = await upToRegistered({ maxJobsPerOrder: 2 });
    finishJob(w, { state: "blocked" });
    await ticks(w, 3);
    expect(w.paying()).toHaveLength(1);
  });

  it("is not bought when too little of the delivery time is left for it", async () => {
    const w = await upToRegistered({ maxJobsPerOrder: 2, orderCap: 2n * PRICE });
    finishJob(w, { state: "blocked" });
    // Seven days of delivery; a retry needs six hours and both closing windows.
    w.setTime(NOW + 7 * 86400 - 2 * 86400 - 5 * 3600);
    await ticks(w, 2);
    expect(w.paying()).toHaveLength(1);
  });
});
