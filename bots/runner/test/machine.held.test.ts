/**
 * Orders the runner holds: what it believes when the chain and its file disagree, and how it takes
 * an order up again from the chain alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESK as DESK_CONST, ORDER_STATE, orderTicket, uuidToBytes16 } from "@help-wanted/shared";
import type { DeskSnapshot } from "../src/desk.js";
import { memoryStore } from "../src/store.js";
import { objectiveFor } from "./fakes.js";
import { NOW, finishJob, raw, ticks, upToRegistered, world, type World } from "./harness.js";
import { DESK, EMPLOYER, JOB_ID, ORDER_ID, RUNNER } from "./world.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => {
  vi.useRealTimers();
});

const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

/** Makes the desk answer its next `count` snapshots with a changed view of the order. */
function serveStale(w: World, count: number, change: (snap: DeskSnapshot) => DeskSnapshot): void {
  const real = w.desk.snapshot.bind(w.desk);
  let left = count;
  w.desk.snapshot = async (id: bigint) => {
    const now = await real(id);
    if (left <= 0) return now;
    left--;
    return change(now);
  };
}

/** A second process: the same chain and API, and a store that knows nothing. */
function restartedWithEmptyStore(first: World, overrides: Parameters<typeof world>[0] = {}): World {
  return world(overrides, { desk: first.desk, api: first.api, store: memoryStore(DESK, RUNNER) });
}

describe("when the chain says the order is no longer held", () => {
  it("gives the order up only after several passes, some minutes apart, say the same", async () => {
    const w = world();
    const entry = w.desk.open(ORDER_ID);
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
    entry.order.state = ORDER_STATE.Open; // evicted
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
    expect(w.record()?.suspect?.count).toBe(1);
    expect(w.loud().some((l) => l.includes("looking again before believing it"))).toBe(true);
    await w.machine.tick();
    await w.machine.tick(); // three readings, but all in the same minute
    expect(w.record()?.status).toBe("claimed");
    w.wait(130);
    await w.machine.tick();
    expect(w.record()?.status).toBe("lost");
    expect(w.record()?.lostAt).toBe(NOW + 130);
    expect(w.paying()).toEqual([]);
    // An order that was held and is not any more cost a bond: the employer is remembered for it.
    expect(w.store.data.employerLosses).toEqual({ [EMPLOYER.toLowerCase()]: 1 });
  });

  it("gives it up likewise when another runner holds it under a later claim", async () => {
    const w = await upToRegistered();
    const entry = w.desk.orders.get(ORDER_ID)!;
    entry.order.seq = 2;
    entry.claim.runner = OTHER;
    await ticks(w, 2);
    expect(w.record()?.status).toBe("registered");
    w.wait(130);
    await w.machine.tick();
    expect(w.record()?.status).toBe("lost");
  });

  it("then leaves that employer's orders alone", async () => {
    const w = world();
    const entry = w.desk.open(ORDER_ID);
    await w.machine.tick();
    entry.order.state = ORDER_STATE.Open;
    await ticks(w, 2);
    w.wait(130);
    await w.machine.tick();
    expect(w.record()?.status).toBe("lost");
    w.desk.open(8n, {}, { spec: "Another report, on another subject." });
    w.desk.head += 10n;
    w.desk.orders.get(8n)!.block = w.desk.head - 3n;
    await ticks(w, 2);
    expect(w.record(8n)?.status).toBe("skipped");
    expect(w.record(8n)?.skip?.reason).toContain("have cost this runner a bond");
  });

  it("notices a settlement somebody else submitted", async () => {
    const w = await upToRegistered();
    const entry = w.desk.orders.get(ORDER_ID)!;
    entry.order.state = ORDER_STATE.Delivered;
    entry.order.proven = true;
    await w.machine.tick();
    expect(w.record()?.status).toBe("delivered");
  });

  it("notices a claim somebody else finalized, and goes on to watch for its receipt", async () => {
    const w = await upToRegistered();
    finishJob(w);
    await w.machine.tick();
    expect(w.record()?.status).toBe("asserted");
    // A keeper finalized the unchallenged claim: paid, and not proven.
    w.desk.orders.get(ORDER_ID)!.order.state = ORDER_STATE.Delivered;
    await w.machine.tick();
    expect(w.record()?.status).toBe("unproven");
    expect(w.record()?.outcome).toContain("paid out on chain on the delivery claim");
    expect(w.desk.writes().some((c) => c.startsWith("finalize"))).toBe(false);
  });
});

describe("one reading of the chain never ends an order", () => {
  it("carries on after a single answer from before its own claim", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
    // A node behind a load balancer answers once with the state before the claim, but reports
    // the current block, so the answer cannot be told from a true one.
    serveStale(w, 1, (snap) => ({ ...snap, order: { ...snap.order, state: ORDER_STATE.Open, seq: 0 } }));
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
    expect(w.record()?.suspect?.count).toBe(1);
    await w.machine.tick(); // the node has caught up
    expect(w.record()?.status).toBe("paid");
    expect(w.record()?.suspect).toBeUndefined();
    expect(w.paying()).toHaveLength(1);
    expect(w.store.data.employerLosses).toBeUndefined();
  });

  it("does not believe a reading from a block behind the one it already acted on", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    await w.machine.tick();
    const acted = BigInt(w.record()?.lastBlock ?? "0");
    expect(acted).toBeGreaterThan(1_000n); // the block the claim was mined in
    serveStale(w, 2, (snap) => ({
      block: acted - 1n,
      order: { ...snap.order, state: ORDER_STATE.Open, seq: 0 },
      claim: snap.claim,
    }));
    await ticks(w, 2);
    expect(w.record()?.status).toBe("claimed");
    expect(w.record()?.suspect).toBeUndefined(); // not even counted against the order
    expect(w.record()?.lastError).toContain("behind block");
    const said = w.log.lines.filter((l) => l.includes("step did not complete"));
    expect(said.every((l) => l.includes('"level":"warn"'))).toBe(true);
    await w.machine.tick();
    expect(w.record()?.status).toBe("paid");
  });

  it("takes an order it gave up as lost up again when the chain shows it held after all", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    await w.machine.tick();
    // A node that stays wrong for long enough to be believed.
    serveStale(w, 3, (snap) => ({ ...snap, order: { ...snap.order, state: ORDER_STATE.Open, seq: 0 } }));
    await ticks(w, 2);
    w.wait(130);
    await w.machine.tick();
    expect(w.record()?.status).toBe("lost");
    expect(w.store.data.employerLosses).toEqual({ [EMPLOYER.toLowerCase()]: 1 });

    await w.machine.tick(); // a true reading: the runner holds the order
    expect(w.record()?.status).toBe("claimed");
    expect(w.record()?.lostAt).toBeUndefined();
    expect(w.store.data.employerLosses).toEqual({ [EMPLOYER.toLowerCase()]: 0 });
    expect(w.loud().some((l) => l.includes("it had been given up as lost"))).toBe(true);
    await w.machine.tick();
    expect(w.record()?.status).toBe("paid"); // and the job is bought after all
  });

  it("stops asking about a lost order after a week", async () => {
    const w = world();
    const entry = w.desk.open(ORDER_ID);
    await w.machine.tick();
    entry.order.state = ORDER_STATE.Open;
    await ticks(w, 2);
    w.wait(130);
    await w.machine.tick();
    expect(w.record()?.status).toBe("lost");
    w.wait(8 * 86_400);
    const before = w.desk.reads;
    await w.machine.tick();
    expect(w.desk.reads).toBe(before);
  });
});

describe("resuming from the store", () => {
  it("carries on after a restart, at every stage, without paying twice", async () => {
    const first = world();
    first.desk.open(ORDER_ID);
    await first.machine.tick();
    expect(first.record()?.status).toBe("claimed");

    // A new process over the same file and the same chain.
    const again = () => world({}, { store: first.store, desk: first.desk, api: first.api });
    const second = again();
    await second.machine.tick();
    expect(second.record()?.status).toBe("paid");

    const third = again();
    await third.machine.tick();
    expect(third.record()?.status).toBe("registered");
    finishJob(third);
    const fourth = again();
    await fourth.machine.tick();
    expect(fourth.record()?.status).toBe("asserted");

    const paid = [first, second, third, fourth].flatMap((w) => w.paying());
    expect(paid).toHaveLength(1);
    expect(first.desk.writes().filter((c) => c.startsWith("claim "))).toHaveLength(1);
    expect(first.desk.writes().filter((c) => c.startsWith("register "))).toHaveLength(1);
  });

  it("does not register twice when the transaction was mined but the file was not saved", async () => {
    const w = world();
    const entry = w.desk.open(ORDER_ID);
    await ticks(w, 2);
    expect(w.record()?.status).toBe("paid");
    // The register transaction landed, then the process died before saving.
    entry.order.state = ORDER_STATE.Registered;
    entry.claim.jobId = uuidToBytes16(JOB_ID);
    entry.claim.registeredAt = NOW;
    await w.machine.tick();
    expect(w.record()?.status).toBe("registered");
    expect(w.desk.writes().some((c) => c.startsWith("register"))).toBe(false);
  });

  it("takes up a claim that was mined before the store could record it", async () => {
    const w = world();
    const entry = w.desk.open(ORDER_ID);
    // The claim transaction landed; the process died before saving.
    entry.order.state = ORDER_STATE.Claimed;
    entry.order.seq = 1;
    entry.claim = { ...entry.claim, runner: RUNNER, claimedAt: NOW, price: entry.price };
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
    expect(w.record()?.claim?.seq).toBe(1);
    expect(w.record()?.claim?.ticket).toBe(
      orderTicket({ chainId: 1, workOrders: DESK, orderId: ORDER_ID, claimSeq: 1, runner: RUNNER }),
    );
    expect(w.desk.writes()).toEqual([]);
    await w.machine.tick();
    expect(w.record()?.status).toBe("paid");
    expect(w.api.paidByCalls).toBe(1); // it asked first whether a job was already bought
  });

  it("leaves alone a claim that another runner holds", async () => {
    const w = world();
    const entry = w.desk.open(ORDER_ID);
    entry.order.state = ORDER_STATE.Claimed;
    entry.order.seq = 1;
    entry.claim = { ...entry.claim, runner: OTHER, claimedAt: NOW };
    await w.machine.tick();
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.skip).toEqual({ reason: "the order is Claimed", permanent: false });
    expect(w.requests).toEqual([]);
  });

  it("takes up a delivery claim that was mined before the store could record it", async () => {
    const w = await upToRegistered();
    const entry = w.desk.orders.get(ORDER_ID)!;
    const { hash } = finishJob(w);
    entry.order.state = ORDER_STATE.Asserted;
    entry.claim.assertedAt = NOW;
    entry.claim.recordHash = hash;
    await w.machine.tick();
    expect(w.record()?.status).toBe("asserted");
    expect(w.record()?.recordHash).toBe(hash);
    expect(w.desk.writes().some((c) => c.startsWith("claimDelivered"))).toBe(false);
    w.setTime(NOW + DESK_CONST.CHALLENGE_WINDOW + 1);
    await w.machine.tick();
    expect(w.record()?.status).toBe("unproven");
    expect(w.desk.writes().at(-1)).toBe(`finalize ${ORDER_ID}`);
  });

  it("notices a release that was mined before the store could record it", async () => {
    const w = world();
    const entry = w.desk.open(ORDER_ID);
    await w.machine.tick();
    const rec = w.record();
    if (!rec) throw new Error("no record");
    rec.status = "releasing";
    entry.order.state = ORDER_STATE.Open;
    w.desk.barredFor.add(ORDER_ID);
    await w.machine.tick();
    expect(w.record()?.status).toBe("released");
    expect(w.desk.writes().some((c) => c.startsWith("release"))).toBe(false);
  });
});

describe("a store that was lost or replaced", () => {
  // The chain holds what is needed to finish an order: `claimOf` has the job id, the hash named
  // and the times. A runner that starts with an empty store (a new volume, a redeploy without
  // one) takes every order it holds up again, whatever state it is in.

  it("finishes an order it had registered", async () => {
    const first = await upToRegistered();
    const { hash } = finishJob(first);
    const second = restartedWithEmptyStore(first);
    await second.machine.tick(); // found, and taken up from the chain
    expect(second.record()?.status).toBe("registered");
    expect(second.record()?.jobId).toBe(JOB_ID);
    expect(second.record()?.claim?.tx).toBe("recovered from chain");
    await second.machine.tick();
    expect(second.record()?.status).toBe("asserted");
    expect(second.desk.writes().at(-1)).toBe(`claimDelivered ${ORDER_ID} ${hash}`);
    expect(second.paying()).toEqual([]);
    expect(second.quotes()).toEqual([]);
  });

  it("finishes an order whose delivery it had claimed", async () => {
    const first = await upToRegistered();
    const { hash } = finishJob(first);
    await first.machine.tick();
    expect(first.record()?.status).toBe("asserted");
    const second = restartedWithEmptyStore(first);
    await second.machine.tick();
    expect(second.record()?.status).toBe("asserted");
    expect(second.record()?.recordHash).toBe(hash);
    second.setTime(NOW + DESK_CONST.CHALLENGE_WINDOW + 1);
    await second.machine.tick();
    expect(second.record()?.status).toBe("unproven");
    expect(second.desk.writes().at(-1)).toBe(`finalize ${ORDER_ID}`);
  });

  it("takes up a challenged claim, and settles it when the receipt lands", async () => {
    const first = await upToRegistered();
    const { hash } = finishJob(first);
    await first.machine.tick();
    const entry = first.desk.orders.get(ORDER_ID)!;
    entry.order.state = ORDER_STATE.Disputed;
    entry.claim.challenger = OTHER;
    const second = restartedWithEmptyStore(first);
    await ticks(second, 2);
    expect(second.record()?.status).toBe("asserted");
    expect(second.loud().some((l) => l.includes("the delivery claim is challenged"))).toBe(true);
    second.desk.receipts.set(JOB_ID, hash);
    await second.machine.tick();
    expect(second.record()?.status).toBe("delivered");
    expect(second.desk.writes().at(-1)).toBe(`settle ${ORDER_ID} ${hash}`);
  });

  it("finds the job it already paid for through the public route, and does not pay again", async () => {
    const first = world();
    first.desk.open(ORDER_ID);
    await ticks(first, 2);
    expect(first.record()?.status).toBe("paid"); // paid, not yet registered
    expect(first.paying()).toHaveLength(1);
    // The store is lost, and with it the request token and the saved payment. The protocol lists
    // what the wallet paid for to anyone who asks.
    first.api.paidOrders = [
      { action: "oracle.request", createdAt: new Date(NOW * 1000).toISOString(), result: { kind: "oracle" } },
      {
        action: "job.open",
        createdAt: new Date(NOW * 1000).toISOString(),
        result: { kind: "job", jobId: JOB_ID },
      },
    ];
    const second = restartedWithEmptyStore(first);
    await ticks(second, 2);
    expect(second.record()?.status).toBe("paid");
    expect(second.record()?.jobId).toBe(JOB_ID);
    expect(second.loud().some((l) => l.includes("not buying another"))).toBe(true);
    await second.machine.tick();
    expect(second.record()?.status).toBe("registered");
    expect(second.paying()).toEqual([]); // no second fee
    expect(second.quotes()).toEqual([]);
  });

  it("does not pay while it cannot ask whether it already did", async () => {
    const first = world();
    first.desk.open(ORDER_ID);
    await ticks(first, 2);
    expect(first.paying()).toHaveLength(1);
    first.api.paidOrders = [
      {
        action: "job.open",
        createdAt: new Date(NOW * 1000).toISOString(),
        result: { kind: "job", jobId: JOB_ID },
      },
    ];
    const second = restartedWithEmptyStore(first);
    const paidBy = second.api.paidBy.bind(second.api);
    second.api.paidBy = async () => {
      throw new Error("api.imd.fun answered 503");
    };
    await ticks(second, 3);
    // No answer is not "no": paying now could buy the job a second time.
    expect(second.record()?.status).toBe("claimed");
    expect(second.paying()).toEqual([]);
    expect(second.quotes()).toEqual([]);
    expect(second.record()?.lastError).toContain("503");
    second.api.paidBy = paidBy;
    await second.machine.tick();
    expect(second.record()?.status).toBe("paid");
    expect(second.record()?.jobId).toBe(JOB_ID);
    expect(second.paying()).toEqual([]);
  });

  it("does not take another claim's job, or another wallet's, for its own", async () => {
    const first = world();
    first.desk.open(ORDER_ID);
    await first.machine.tick();
    expect(first.record()?.status).toBe("claimed"); // claimed; nothing paid yet
    const stray = "11111111-2222-4333-8444-555555555555";
    const foreign = "66666666-7777-4888-9999-aaaaaaaaaaaa";
    first.api.jobs.set(stray, {
      state: "completed",
      template: "skill:research-report",
      objective: objectiveFor(ORDER_ID, 2), // an earlier or later claim of the same order
      paidBy: RUNNER.toLowerCase(),
    });
    first.api.jobs.set(foreign, {
      state: "completed",
      template: "skill:research-report",
      objective: objectiveFor(ORDER_ID, 1), // the right text, paid by somebody else
      paidBy: OTHER.toLowerCase(),
    });
    first.api.paidOrders = [stray, foreign].map((jobId) => ({
      action: "job.open",
      createdAt: new Date(NOW * 1000).toISOString(),
      result: { kind: "job", jobId },
    }));
    const second = restartedWithEmptyStore(first);
    await ticks(second, 2);
    expect(second.record()?.jobId).toBe(JOB_ID); // the one it then bought itself
    expect(second.paying()).toHaveLength(1);
  });

  it("finds an order it holds through its own claim, even when the order was opened before the logs it reads", async () => {
    const first = await upToRegistered();
    const { hash } = finishJob(first);
    // A new store that starts reading after the order was opened, but not after it was claimed.
    const entry = first.desk.orders.get(ORDER_ID)!;
    const store = memoryStore(DESK, RUNNER);
    store.data.cursor = entry.block.toString();
    const second = world({}, { desk: first.desk, api: first.api, store });
    second.desk.head += 5n;
    await second.machine.tick();
    // Known from the `Claimed` log alone: the chain says enough to finish it, only its text is missing.
    expect(second.record()?.spec).toBe("");
    expect(second.record()?.status).toBe("registered");
    await second.machine.tick();
    expect(second.record()?.status).toBe("asserted");
    expect(second.desk.writes().at(-1)).toBe(`claimDelivered ${ORDER_ID} ${hash}`);
  });

  it("looks at the orders its own claims name before any other", async () => {
    const first = await upToRegistered();
    finishJob(first);
    for (let id = 100n; id < 160n; id++) first.desk.open(id, {}, { kind: "skill:build-website" });
    const second = restartedWithEmptyStore(first);
    second.desk.head += 5n;
    await second.machine.tick();
    // Sixty other orders were found in the same pass; the one this runner holds was not kept waiting.
    expect(second.record()?.status).toBe("registered");
  });
});

describe("a payment whose status cannot be read", () => {
  // The claim cannot be given back while a payment is signed, so this must not pass in silence,
  // and the job must be looked for another way before the claim window runs out.
  const notFound = () => ({ status: 404, headers: {}, text: '{"error":"order_not_found"}' });

  it("says so on every pass, louder as it goes on", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    w.protocol.status = notFound;
    await ticks(w, 2);
    expect(w.record()?.pay?.stage).toBe("submitted");
    const said = () => w.visible().filter((l) => l.includes("the paid order's status cannot be read"));
    expect(said()).toHaveLength(1);
    expect(said()[0]).toContain('"level":"warn"');
    expect(said()[0]).toContain("IMD_PAID_TOKEN");
    for (let i = 0; i < 5; i++) {
      w.wait(60);
      await w.machine.tick();
    }
    expect(said()).toHaveLength(6);
    expect(said().at(-1)).toContain('"level":"error"');
    expect(w.record()?.pay?.statusFailures).toBe(6);
  });

  it("finds the job through the public route and registers it", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    w.protocol.status = notFound;
    await ticks(w, 2);
    // The payment went through all the same, and the protocol lists it.
    w.api.jobs.set(JOB_ID, {
      state: "executing",
      template: "skill:research-report",
      objective: objectiveFor(ORDER_ID, 1),
      paidBy: RUNNER.toLowerCase(),
    });
    w.api.paidOrders = [
      {
        action: "job.open",
        createdAt: new Date(NOW * 1000).toISOString(),
        result: { kind: "job", jobId: JOB_ID },
      },
    ];
    await ticks(w, 2);
    expect(w.record()?.status).toBe("paid");
    expect(w.record()?.jobId).toBe(JOB_ID);
    await w.machine.tick();
    expect(w.record()?.status).toBe("registered");
    expect(w.paying()).toHaveLength(1);
  });

  it("gives the claim back five minutes before the window ends if no job id was ever learned", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    w.protocol.status = notFound;
    await ticks(w, 2);
    for (let minute = 2; minute <= 54; minute++) {
      w.setTime(NOW + minute * 60);
      await w.machine.tick();
    }
    expect(w.record()?.status).toBe("claimed");
    w.setTime(NOW + 56 * 60);
    await w.machine.tick();
    expect(w.record()?.status).toBe("releasing");
    await w.machine.tick();
    expect(w.record()?.status).toBe("released");
    expect(w.desk.writes().at(-1)).toBe(`release ${ORDER_ID}`);
    expect(w.record()?.outcome).toContain("no job id was learned");
  });

  it("is quiet again once the status can be read", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    w.protocol.status = notFound;
    await ticks(w, 2);
    w.protocol.status = () => ({ status: 200, headers: {}, text: raw("status-admitted.json") });
    await w.machine.tick();
    expect(w.record()?.status).toBe("paid");
    expect(w.record()?.pay?.statusFailures).toBeUndefined();
  });
});
