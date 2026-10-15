/**
 * The desk module's rules, each with one second before and one second at its boundary, and the
 * watch on delivery claims: what makes a claim true, untrue or unknown, and when the keeper puts
 * its own IMD behind a challenge.
 */
import { keccak256, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  DESK as DESK_CONST,
  ORDER_STATE,
  orderHeader,
  proofGasNeeded,
  settleGasNeeded,
} from "@help-wanted/shared";
import {
  CHALLENGE_MARGIN_SECONDS,
  TRIGGER_GAS_FLOOR,
  decideDesk,
  judgeClaim,
  type DeskOrderView,
  type DeskSnapshot,
} from "../src/modules/desk.js";
import {
  BOND,
  DAY,
  DESK,
  EMPLOYER,
  IMD,
  IMD_TOKEN,
  JOB,
  KEEPER,
  NOW,
  OTHER,
  RUNNER,
  SPEC,
  asserted,
  claimed,
  desk,
  deskPolicy,
  evidence,
  order,
  receipt,
  record,
  registered,
  ticketOf,
} from "./deskFactories.js";

const kinds = (snapshot: DeskSnapshot, policy = deskPolicy()) =>
  decideDesk(snapshot, policy).actions.map((a) => `${a.kind}:${a.subject}`);
const one = (view: DeskOrderView, policy = deskPolicy(), over: Partial<DeskSnapshot> = {}) =>
  decideDesk(desk([view], over), policy);
const HOUR = 3_600n;
const CHALLENGE = BigInt(DESK_CONST.CHALLENGE_WINDOW);

describe("an open order", () => {
  it("is refunded at its expiry, not one second before", () => {
    expect(kinds(desk([order(7n, { expiresAt: NOW + 1n })]))).toEqual([]);
    const at = one(order(7n, { expiresAt: NOW }));
    expect(at.actions.map((a) => a.kind)).toEqual(["refund"]);
    expect(at.actions[0]?.call).toMatchObject({ address: DESK, functionName: "refund", args: [7n] });
    expect(at.actions[0]?.reason).toContain(EMPLOYER);
  });

  it("has its condition latched when it holds now and was never latched", () => {
    const holds = order(7n, { conditional: true, condMet: false, condHoldsNow: true });
    const decision = one(holds);
    expect(decision.actions.map((a) => a.kind)).toEqual(["trigger"]);
    // The desk insists on handing the condition target its whole 100,000 gas.
    expect(decision.actions[0]?.gasFloor).toBe(TRIGGER_GAS_FLOOR);
    expect(decision.actions[0]?.reason).toContain("its price starts to rise");
  });

  it("is left alone while its condition does not hold, once latched, and when it has none", () => {
    const waits = one(order(7n, { conditional: true, condMet: false, condHoldsNow: false }));
    expect(waits.actions).toEqual([]);
    expect(waits.waiting[0]?.reason).toBe("its condition does not hold yet");
    expect(kinds(desk([order(7n, { conditional: true, condMet: true, condHoldsNow: true })]))).toEqual([]);
    expect(kinds(desk([order(7n)]))).toEqual([]);
  });

  it("is refunded rather than latched once it has expired", () => {
    const expired = order(7n, { conditional: true, condMet: false, condHoldsNow: true, expiresAt: NOW });
    expect(kinds(desk([expired]))).toEqual(["refund:order 7"]);
  });
});

describe("a runner that registered no job", () => {
  it("is evicted when the one-hour claim window is over, not one second before", () => {
    const before = one(claimed(HOUR - 1n));
    expect(before.actions).toEqual([]);
    expect(before.waiting[0]?.until).toBe(Number(NOW + 1n));
    const at = one(claimed(HOUR));
    expect(at.actions.map((a) => a.kind)).toEqual(["evict"]);
    expect(at.actions[0]?.reason).toContain("its bond goes to the employer");
  });

  it("is not evicted when it is one of the operator's own runners", () => {
    const decision = one(claimed(2n * HOUR), deskPolicy({ ownRunners: new Set([RUNNER.toLowerCase()]) }));
    expect(decision.actions).toEqual([]);
    expect(decision.waiting[0]).toMatchObject({ attention: true });
    expect(decision.waiting[0]?.reason).toContain("does not evict");
  });
});

describe("a registered job", () => {
  it("is timed out at its delivery deadline, not one second before", () => {
    expect(kinds(desk([registered(7n * DAY - 1n)]))).toEqual([]);
    const at = one(registered(7n * DAY));
    expect(at.actions.map((a) => a.kind)).toEqual(["timeout"]);
    expect(at.actions[0]?.reason).toContain("no receipt settled the order");
  });

  it("is settled, not timed out, when its receipt has landed, however late", () => {
    const late = registered(9n * DAY);
    late.receipt = receipt(late);
    const decision = one(late);
    expect(decision.actions.map((a) => a.kind)).toEqual(["settle"]);
    const settle = decision.actions[0];
    expect(settle?.call.args).toEqual([7n, toHex(record()), []]);
    // Never a low gas limit set by hand: the desk's own figure for a record of this size.
    expect(settle?.gasFloor).toBe(settleGasNeeded(record().length));
    expect(settle?.reason).toContain("its record settles the order");
  });

  it("leaves settling to the runner when told to", () => {
    const view = registered(HOUR);
    view.receipt = receipt(view);
    const decision = one(view, deskPolicy({ settleReceipts: false }));
    expect(decision.actions).toEqual([]);
    expect(decision.waiting[0]?.reason).toContain("left to its runner");
  });

  it("reports a receipt that shows another objective: the order is free again and the bond the employer's", () => {
    const view = registered(HOUR);
    view.receipt = receipt(view, record({ objective: `${orderHeader(ticketOf(7n, 2))}${SPEC}` }));
    const decision = one(view);
    expect(decision.actions.map((a) => a.kind)).toEqual(["reportFailed"]);
    expect(decision.actions[0]?.reason).toContain("the registered job is not this claim's");
    expect(decision.actions[0]?.gasFloor).toBe(proofGasNeeded((view.receipt as { bytes: number }).bytes));
  });

  it("reports a completed receipt of another kind: the order is free again and the bond the runner's", () => {
    const view = registered(HOUR);
    view.receipt = receipt(view, record({ kind: "research" }));
    const decision = one(view);
    expect(decision.actions.map((a) => a.kind)).toEqual(["reportFailed"]);
    expect(decision.actions[0]?.reason).toContain('the record\'s kind is "research"');
    expect(decision.actions[0]?.reason).toContain("the bond returns to the runner");
  });

  it("does not report a job that ended without completing: only its runner may", () => {
    const view = registered(HOUR);
    view.receipt = receipt(view, record({ state: "blocked" }));
    const decision = one(view);
    expect(decision.actions).toEqual([]);
    expect(decision.waiting[0]?.reason).toContain("only its runner may report that");
    // At the deadline the bond is the employer's all the same.
    const late = registered(7n * DAY);
    late.receipt = receipt(late, record({ state: "blocked" }));
    expect(kinds(desk([late]))).toEqual(["timeout:order 7"]);
  });

  it("says so when a receipt cannot be read, and still times the claim out at its deadline", () => {
    const view = registered(HOUR, {
      receipt: { kind: "unread", hash: `0x${"ab".repeat(32)}`, detail: "404" },
    });
    const decision = one(view);
    expect(decision.actions).toEqual([]);
    expect(decision.waiting.some((w) => w.attention && w.reason.includes("could not be read"))).toBe(true);
    const late = registered(7n * DAY, {
      receipt: { kind: "unread", hash: `0x${"ab".repeat(32)}`, detail: "404" },
    });
    expect(kinds(desk([late]))).toEqual(["timeout:order 7"]);
  });

  it("does not carry a record above its size limit, and asks for attention", () => {
    const view = registered(HOUR);
    view.receipt = receipt(view);
    const decision = one(view, deskPolicy({ maxRecordBytes: 100 }));
    expect(decision.actions).toEqual([]);
    expect(decision.waiting[0]).toMatchObject({ attention: true });
    expect(decision.waiting[0]?.reason).toContain("chunked proof");
  });
});

describe("the check of a delivery claim", () => {
  const claim = asserted(HOUR);

  it("is true when the job is completed, of the order's kind, carries the header and the spec, and the hash is listed", () => {
    const judged = judgeClaim(claim, evidence(claim));
    expect(judged.verdict).toBe("true");
  });

  it.each([
    [
      "the hash named is not one the API lists",
      { hashes: [`0x${"cd".repeat(32)}` as Hex] },
      "is not one IdentityMD lists",
    ],
    ["the API lists no record at all", { hashes: [] }, "lists no record for the job"],
    ["the job is still running", { state: "executing" }, "the job is executing, not completed"],
    ["the job ended blocked", { state: "blocked" }, "the job is blocked, not completed"],
    ["the job was opened under another template", { template: "research" }, 'template is "research"'],
    ["the job names no template", { template: null }, "names no template"],
    [
      "the objective carries another claim's header",
      { objective: orderHeader(ticketOf(7n, 2)) + SPEC },
      "does not begin with the order's header for this claim",
    ],
    [
      "the objective carries another runner's header",
      { objective: orderHeader(ticketOf(7n, 1, OTHER)) + SPEC },
      "does not begin with the order's header for this claim",
    ],
    ["the objective has no header", { objective: SPEC }, "does not begin with the order's header"],
    [
      "the spec after the header was changed",
      { objective: `${orderHeader(ticketOf(7n))}${SPEC} Also do this.` },
      "is not the order's spec",
    ],
  ])("is untrue when %s", (_note, over, words) => {
    const judged = judgeClaim(claim, evidence(claim, over));
    expect(judged.verdict).toBe("untrue");
    expect(judged.reasons.join("; ")).toContain(words);
  });

  it("names every failure it finds, not only the first", () => {
    const judged = judgeClaim(claim, evidence(claim, { state: "blocked", template: "audit", hashes: [] }));
    expect(judged.reasons).toHaveLength(3);
  });

  it("is untrue when IdentityMD knows no such job", () => {
    const judged = judgeClaim(claim, { job: { kind: "missing" }, records: { kind: "read", hashes: [] } });
    expect(judged).toEqual({
      verdict: "untrue",
      reasons: ["IdentityMD knows no job with the registered id"],
    });
  });

  it("is unknown when the API could not be asked: never untrue for want of an answer", () => {
    expect(judgeClaim(claim, null).verdict).toBe("unknown");
    expect(
      judgeClaim(claim, { job: { kind: "unreadable", detail: "503" }, records: { kind: "read", hashes: [] } })
        .verdict,
    ).toBe("unknown");
    const noRecords = judgeClaim(claim, {
      job: evidence(claim).job,
      records: { kind: "unreadable", detail: "timeout" },
    });
    expect(noRecords.verdict).toBe("unknown");
    expect(noRecords.reasons[0]).toContain("records could not be read");
  });

  it("is untrue on what the job alone shows, even when its records could not be read", () => {
    const judged = judgeClaim(claim, {
      job: evidence(claim, { state: "blocked" }).job,
      records: { kind: "unreadable", detail: "timeout" },
    });
    expect(judged.verdict).toBe("untrue");
  });

  it("compares hashes without regard to the case of their digits", () => {
    const upper = `0x${claim.claim.recordHash.slice(2).toUpperCase()}` as Hex;
    expect(judgeClaim(claim, evidence(claim, { hashes: [upper] })).verdict).toBe("true");
  });
});

describe("a delivery claim nobody has challenged", () => {
  it("is left alone inside its window when it passes the check, and recorded with why", () => {
    const decision = one(asserted(HOUR));
    expect(decision.actions).toEqual([]);
    expect(decision.claims).toHaveLength(1);
    expect(decision.claims[0]).toMatchObject({
      order: "7",
      seq: 1,
      runner: RUNNER,
      jobId: JOB,
      state: "Asserted",
      verdict: "true",
      action: "none",
    });
    expect(decision.claims[0]?.why).toContain("passed the check");
    expect(decision.claims[0]?.challengeEndsAt).toBe(Number(NOW - HOUR + CHALLENGE));
  });

  it("is finalized when the window is over, not one second before", () => {
    expect(kinds(desk([asserted(CHALLENGE - 1n)]))).toEqual([]);
    const at = one(asserted(CHALLENGE));
    expect(at.actions.map((a) => a.kind)).toEqual(["finalize"]);
    expect(at.claims[0]).toMatchObject({ verdict: "true", action: "finalize" });
    expect(at.actions[0]?.reason).toContain("stood unchallenged for 24 hours");
  });

  it("is not finalized by the keeper when it failed the check, or when the API could not be asked", () => {
    const untrue = asserted(CHALLENGE);
    untrue.evidence = evidence(untrue, { hashes: [] });
    const failed = one(untrue);
    expect(failed.actions).toEqual([]);
    expect(failed.claims[0]).toMatchObject({ verdict: "untrue", action: "none" });
    expect(failed.claims[0]?.why).toContain("this keeper does not pay it out");
    expect(failed.waiting[0]).toMatchObject({ attention: true });

    const unknown = one(asserted(CHALLENGE, { evidence: null }));
    expect(unknown.actions).toEqual([]);
    expect(unknown.claims[0]?.verdict).toBe("unknown");
  });

  it("is finalized on a verdict kept from an earlier look, without asking the API again", () => {
    const decision = one(asserted(CHALLENGE, { evidence: null, knownTrue: true }));
    expect(decision.actions.map((a) => a.kind)).toEqual(["finalize"]);
  });

  it("leaves finalizing to the runner when told to", () => {
    const decision = one(asserted(CHALLENGE), deskPolicy({ finalizeClaims: false }));
    expect(decision.actions).toEqual([]);
    expect(decision.claims[0]?.why).toContain("left to the runner");
  });

  it("is settled, not finalized, when a receipt has landed: the receipt always wins", () => {
    const view = asserted(CHALLENGE);
    view.receipt = receipt(view);
    const decision = one(view);
    expect(decision.actions.map((a) => a.kind)).toEqual(["settle"]);
    expect(decision.claims[0]).toMatchObject({ action: "settle" });
  });

  it("is settled on any receipt that settles, whatever hash the claim named", () => {
    // The claim named a hash the API does not list; the registry holds a record that settles.
    const view = asserted(HOUR, {}, { recordHash: `0x${"cd".repeat(32)}` });
    view.evidence = evidence(view, { hashes: [keccak256(record())] });
    view.receipt = receipt(view);
    const decision = one(view);
    expect(decision.actions.map((a) => a.kind)).toEqual(["settle"]);
    expect(decision.claims[0]?.why).toContain("whatever hash the claim named");
  });

  it("is refuted with a receipt that does not settle, with no bond posted by anybody", () => {
    const view = asserted(HOUR);
    view.receipt = receipt(view, record({ state: "blocked" }));
    const decision = one(view, deskPolicy({ challengeFloat: 0n, challengeDailyCap: 0n }));
    expect(decision.actions.map((a) => a.kind)).toEqual(["reportFailed"]);
    expect(decision.actions[0]?.reason).toContain("the runner's bond goes to the employer");
    expect(decision.claims[0]).toMatchObject({ action: "reportFailed" });
  });
});

describe("challenging an untrue delivery claim", () => {
  /** A claim that names a hash the API does not list, first seen failing `seen` seconds ago. */
  function untrue(age: bigint, seen: bigint | null = 3_600n, over: Partial<DeskOrderView> = {}) {
    const view = asserted(age, over);
    view.evidence = evidence(view, { hashes: [`0x${"cd".repeat(32)}`] });
    view.failingSince = seen === null ? null : NOW - seen;
    return view;
  }

  it("approves the desk for exactly the bond, then challenges, and says what it posts", () => {
    const decision = one(untrue(2n * HOUR));
    expect(decision.actions.map((a) => a.kind)).toEqual(["approve", "challenge"]);
    expect(decision.actions[0]?.call).toMatchObject({
      address: IMD_TOKEN,
      functionName: "approve",
      args: [DESK, BOND],
    });
    const challenge = decision.actions[1];
    expect(challenge?.call).toMatchObject({ address: DESK, functionName: "challenge", args: [7n] });
    expect(challenge?.postsImd).toBe(BOND);
    expect(challenge?.reason).toContain("is not one IdentityMD lists");
    expect(challenge?.reason).toContain("No receipt is on chain");
    expect(decision.claims[0]).toMatchObject({ verdict: "untrue", action: "challenge" });
  });

  it("does not approve again when the desk's allowance already covers the bond", () => {
    const decision = one(untrue(2n * HOUR), deskPolicy(), { keeperAllowance: BOND });
    expect(decision.actions.map((a) => a.kind)).toEqual(["challenge"]);
  });

  it("never challenges with the float and the daily cap at zero: it only reports", () => {
    const decision = one(untrue(2n * HOUR), deskPolicy({ challengeFloat: 0n, challengeDailyCap: 0n }));
    expect(decision.actions).toEqual([]);
    expect(decision.claims[0]).toMatchObject({ verdict: "untrue", action: "none" });
    expect(decision.claims[0]?.why).toContain("challenges are off");
    expect(decision.waiting[0]).toMatchObject({ attention: true });
  });

  it("never challenges on an order whose arbiter is not on the list", () => {
    const withArbiter = untrue(2n * HOUR, 3_600n, { arbiter: OTHER });
    const refusedIt = one(withArbiter);
    expect(refusedIt.actions).toEqual([]);
    expect(refusedIt.claims[0]?.why).toContain("is not on this keeper's list");
    // Listed, it is challenged.
    const listed = one(withArbiter, deskPolicy({ challengeArbiters: new Set([OTHER.toLowerCase()]) }));
    expect(listed.actions.map((a) => a.kind)).toEqual(["approve", "challenge"]);
    // An order with no arbiter can only be decided by a receipt or the deadline: challenged.
    expect(one(untrue(2n * HOUR)).actions.map((a) => a.kind)).toEqual(["approve", "challenge"]);
  });

  it("posts bonds only for the employers it was told to serve, when it was told any", () => {
    // An employer can be its own runner: orders opened only to be claimed untruly would tie up a
    // keeper's float until their delivery deadlines, at no cost to whoever opened them.
    const policy = deskPolicy({ challengeEmployers: new Set([OTHER.toLowerCase()]) });
    const stranger = one(untrue(2n * HOUR), policy);
    expect(stranger.actions).toEqual([]);
    expect(stranger.claims[0]).toMatchObject({ verdict: "untrue", action: "none" });
    expect(stranger.claims[0]?.why).toContain("is not one this keeper posts bonds for");
    const served = one(untrue(2n * HOUR, 3_600n, { employer: OTHER }), policy);
    expect(served.actions.map((a) => a.kind)).toEqual(["approve", "challenge"]);
    // With no list, any employer's order is defended.
    expect(one(untrue(2n * HOUR)).actions.map((a) => a.kind)).toEqual(["approve", "challenge"]);
  });

  it("waits for a second look some minutes after the first: one reading does not cost a runner its bond", () => {
    const first = one(untrue(2n * HOUR, null));
    expect(first.actions).toEqual([]);
    expect(first.claims[0]?.why).toContain("it is challenged if it still fails at");
    // One second before the confirmation time, and at it.
    expect(one(untrue(2n * HOUR, 899n)).actions).toEqual([]);
    expect(one(untrue(2n * HOUR, 900n)).actions.map((a) => a.kind)).toEqual(["approve", "challenge"]);
  });

  it("challenges on the first look when the window would end before a second one", () => {
    // Ten minutes of the window are left: a second look fifteen minutes on would come too late.
    const lastChance = untrue(CHALLENGE - 600n, null);
    expect(one(lastChance).actions.map((a) => a.kind)).toEqual(["approve", "challenge"]);
  });

  it("does not send a challenge the desk would refuse as too late", () => {
    const margin = CHALLENGE_MARGIN_SECONDS;
    const tooClose = one(untrue(CHALLENGE - margin));
    expect(tooClose.actions).toEqual([]);
    expect(tooClose.claims[0]?.why).toContain("too close to send a challenge");
    expect(one(untrue(CHALLENGE - margin - 1n)).actions.map((a) => a.kind)).toEqual(["approve", "challenge"]);
  });

  it("stays within the float: bonds already posted on disputed orders count", () => {
    const disputed = order(
      3n,
      { state: ORDER_STATE.Disputed, receipt: { kind: "none" } },
      {
        runner: OTHER,
        claimedAt: NOW - DAY,
        registeredAt: NOW - DAY,
        jobId: JOB,
        assertedAt: NOW - 2n * HOUR,
        challenger: KEEPER,
      },
    );
    const snapshot = desk([disputed, untrue(2n * HOUR)]);
    // One bond is out; a float of one and a half bonds has no room for a second.
    const tight = decideDesk(snapshot, deskPolicy({ challengeFloat: (BOND * 3n) / 2n }));
    expect(tight.actions.filter((a) => a.kind === "challenge")).toEqual([]);
    expect(tight.claims.find((c) => c.order === "7")?.why).toContain("above the float");
    // A float of exactly two bonds has.
    const exact = decideDesk(snapshot, deskPolicy({ challengeFloat: BOND * 2n }));
    expect(exact.actions.filter((a) => a.kind === "challenge")).toHaveLength(1);
    // Somebody else's challenge does not count against this keeper's float.
    disputed.claim.challenger = OTHER;
    const others = decideDesk(desk([disputed, untrue(2n * HOUR)]), deskPolicy({ challengeFloat: BOND }));
    expect(others.actions.filter((a) => a.kind === "challenge")).toHaveLength(1);
  });

  it("stays within the daily cap, at its exact figure", () => {
    const view = untrue(2n * HOUR);
    const policy = deskPolicy({ challengeDailyCap: BOND * 2n });
    expect(one(view, policy, { challengedToday: BOND }).actions.map((a) => a.kind)).toEqual([
      "approve",
      "challenge",
    ]);
    const over = one(view, policy, { challengedToday: BOND + 1n });
    expect(over.actions).toEqual([]);
    expect(over.claims[0]?.why).toContain("above the daily cap");
  });

  it("counts the challenges of one pass against the float and the cap as it decides them", () => {
    const a = untrue(2n * HOUR);
    const b = { ...untrue(2n * HOUR), id: 8n };
    b.claim = { ...b.claim };
    const decision = decideDesk(
      desk([a, b]),
      deskPolicy({ challengeFloat: BOND, challengeDailyCap: IMD(50) }),
    );
    expect(decision.actions.filter((x) => x.kind === "challenge")).toHaveLength(1);
    expect(decision.claims.map((c) => c.action)).toEqual(["challenge", "none"]);
  });

  it("does not challenge without the IMD for the bond, a keeper address, or on its own claim", () => {
    const view = untrue(2n * HOUR);
    expect(one(view, deskPolicy(), { keeperImd: BOND - 1n }).claims[0]?.why).toContain("less than the bond");
    expect(one(view, deskPolicy(), { keeperImd: null }).actions).toEqual([]);
    expect(one(view, deskPolicy({ keeper: null })).claims[0]?.why).toContain("no keeper address");
    const own = untrue(2n * HOUR);
    own.claim.runner = KEEPER;
    expect(one(own).claims[0]?.why).toContain("the claim is this keeper's own");
  });

  it("does not challenge a claim it could not check", () => {
    const blind = asserted(2n * HOUR, { evidence: null });
    const decision = one(blind);
    expect(decision.actions).toEqual([]);
    expect(decision.claims[0]).toMatchObject({ verdict: "unknown", action: "none" });
    expect(decision.claims[0]?.why).toContain("A claim is not challenged blind");
  });
});

describe("a challenged delivery claim", () => {
  const disputed = (age: bigint, over: Partial<DeskOrderView> = {}) =>
    asserted(age, { state: ORDER_STATE.Disputed, evidence: null, ...over }, { challenger: KEEPER });

  it("waits for a receipt or the arbiter until the delivery deadline", () => {
    const decision = one(disputed(DAY));
    expect(decision.actions).toEqual([]);
    expect(decision.claims[0]).toMatchObject({ state: "Disputed", action: "none" });
  });

  it("is ended at the delivery deadline, not one second before: the employer is refunded", () => {
    // Asserted an hour after registration: the deadline is seven days after registration.
    expect(kinds(desk([disputed(7n * DAY - HOUR - 1n)]))).toEqual([]);
    const at = one(disputed(7n * DAY - HOUR));
    expect(at.actions.map((a) => a.kind)).toEqual(["timeout"]);
    expect(at.actions[0]?.reason).toContain("the employer is refunded");
    expect(at.claims[0]).toMatchObject({ action: "timeout" });
  });

  it("is settled the moment a receipt settles it, even past the deadline", () => {
    const view = disputed(8n * DAY);
    view.receipt = receipt(view);
    expect(kinds(desk([view]))).toEqual(["settle:order 7"]);
  });

  it("is refuted with a receipt that does not settle it", () => {
    const view = disputed(DAY);
    view.receipt = receipt(view, record({ kind: "audit" }));
    const decision = one(view);
    expect(decision.actions.map((a) => a.kind)).toEqual(["reportFailed"]);
    expect(decision.actions[0]?.reason).toContain("the rest to the challenger with its own bond");
  });
});

describe("an order paid on a claim and not proven", () => {
  const paid = (over: Partial<DeskOrderView> = {}) =>
    asserted(3n * DAY, { state: ORDER_STATE.Delivered, evidence: null, ...over });

  it("is stamped when its receipt lands", () => {
    const view = paid();
    view.receipt = receipt(view);
    const decision = one(view);
    expect(decision.actions.map((a) => a.kind)).toEqual(["stamp"]);
    expect(decision.actions[0]?.call.args).toEqual([7n, toHex(record()), []]);
    expect(decision.actions[0]?.reason).toContain("No money moves");
    // Not a delivery claim any more: nothing is added to the claims looked at.
    expect(decision.claims).toEqual([]);
  });

  it("waits while there is no receipt, and says so when the receipt does not prove it", () => {
    expect(one(paid()).actions).toEqual([]);
    const view = paid();
    view.receipt = receipt(view, record({ state: "blocked" }));
    const decision = one(view);
    expect(decision.actions).toEqual([]);
    expect(decision.waiting[0]).toMatchObject({ attention: true });
  });
});

describe("a job whose receipt already proved another order", () => {
  it("is neither settled nor reported: the desk would refuse both", () => {
    const view = registered(HOUR, { jobUsedBy: 3n });
    view.receipt = receipt(view);
    const decision = one(view);
    expect(decision.actions).toEqual([]);
    expect(decision.waiting[0]).toMatchObject({ attention: true });
    expect(decision.waiting[0]?.reason).toContain("already matched for order 3");
    // At its deadline the claim is timed out like any other.
    const late = registered(7n * DAY, { jobUsedBy: 3n });
    late.receipt = receipt(late);
    expect(kinds(desk([late]))).toEqual(["timeout:order 7"]);
    // A job matched for this very order is its own receipt.
    const own = registered(HOUR, { jobUsedBy: 7n });
    own.receipt = receipt(own);
    expect(kinds(desk([own]))).toEqual(["settle:order 7"]);
  });

  it("cannot be stamped onto a second order paid on a claim", () => {
    const view = asserted(3n * DAY, { state: ORDER_STATE.Delivered, evidence: null, jobUsedBy: 3n });
    view.receipt = receipt(view);
    const decision = one(view);
    expect(decision.actions).toEqual([]);
    expect(decision.waiting[0]?.reason).toContain("cannot be stamped");
  });
});

describe("the desk as a whole", () => {
  it("decides every live order in one pass, in order", () => {
    const expired = order(1n, { expiresAt: NOW - 1n });
    const stale = { ...claimed(2n * HOUR), id: 2n };
    const overdue = { ...registered(8n * DAY), id: 3n };
    const done = { ...asserted(CHALLENGE + 5n), id: 4n };
    const decision = decideDesk(desk([expired, stale, overdue, done]), deskPolicy());
    expect(decision.actions.map((a) => `${a.kind}:${a.subject}`)).toEqual([
      "refund:order 1",
      "evict:order 2",
      "timeout:order 3",
      "finalize:order 4",
    ]);
    for (const action of decision.actions) expect(action.module).toBe("desk");
  });

  it("says that receipts are stalled, once", () => {
    const stalled = decideDesk(desk([], { receiptsFlowing: false }), deskPolicy());
    expect(stalled.waiting.filter((w) => w.subject === "receipts")).toHaveLength(1);
    expect(decideDesk(desk([], { receiptsFlowing: true }), deskPolicy()).waiting).toEqual([]);
    expect(decideDesk(desk([], { receiptsFlowing: null }), deskPolicy()).waiting).toEqual([]);
  });
});
