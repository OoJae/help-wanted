import { describe, expect, it } from "vitest";
import { decidePayroll, isWorthDripping, type PayrollSnapshot } from "../src/modules/payroll.js";
import { FUND_FEEDS_GAS_FLOOR } from "../src/modules/questions.js";
import { IMD, NOW, PAYROLL, payroll, payrollPolicy } from "./factories.js";

const kinds = (snapshot: PayrollSnapshot, policy = payrollPolicy()) =>
  decidePayroll(snapshot, policy).actions.map((a) => a.kind);

const FORTNIGHT = 1_209_600n;
/** An hour of a stream of 50 IMD over seven days, as the contract caps one drip (rounded up). */
const CAP = (IMD(50) * 3600n + 604_799n) / 604_800n;

const stream = (over: Partial<PayrollSnapshot["stream"]> = {}): PayrollSnapshot["stream"] => ({
  outstanding: IMD(50),
  unvested: IMD(49),
  endsAt: NOW + 600_000n,
  perDrip: CAP,
  nextDripAt: 0n,
  dueNow: CAP,
  ...over,
});

describe("booking", () => {
  it("sends nothing when nothing arrived", () => {
    expect(decidePayroll(payroll(), payrollPolicy())).toEqual({ actions: [], waiting: [] });
  });

  it("books at the minimum and not one wei below it", () => {
    const below = decidePayroll(payroll({ unbooked: IMD(1) - 1n }), payrollPolicy());
    expect(below.actions).toEqual([]);
    expect(below.waiting[0]?.reason).toContain("it is booked once at least");
    const at = decidePayroll(payroll({ unbooked: IMD(1) }), payrollPolicy());
    expect(at.actions.map((a) => a.kind)).toEqual(["book"]);
    expect(at.actions[0]?.call).toMatchObject({ address: PAYROLL, functionName: "book", args: [] });
  });

  it("uses the operator's minimum", () => {
    expect(kinds(payroll({ unbooked: 5n }), payrollPolicy({ bookMin: 5n }))).toEqual(["book"]);
    expect(kinds(payroll({ unbooked: IMD(9) }), payrollPolicy({ bookMin: IMD(10) }))).toEqual([]);
  });
});

describe("dripping", () => {
  const dripping = (over: Partial<PayrollSnapshot> = {}) =>
    payroll({ stream: stream(), lastDripAt: NOW - 3_600n, ...over });

  it("drips when a whole drip is due and the hour has passed", () => {
    const decision = decidePayroll(dripping(), payrollPolicy());
    expect(decision.actions.map((a) => a.kind)).toEqual(["drip"]);
    expect(decision.actions[0]?.call).toMatchObject({ address: PAYROLL, functionName: "drip", args: [] });
  });

  it("does not drip one second before the hour is up, and does at it", () => {
    const before = decidePayroll(dripping({ lastDripAt: NOW - 3_599n }), payrollPolicy());
    expect(before.actions).toEqual([]);
    expect(before.waiting[0]?.until).toBe(Number(NOW + 1n));
    expect(kinds(dripping({ lastDripAt: NOW - 3_600n }))).toEqual(["drip"]);
  });

  it("uses the operator's interval", () => {
    expect(kinds(dripping({ lastDripAt: NOW - 1_800n }), payrollPolicy({ dripEverySeconds: 1_800 }))).toEqual(
      ["drip"],
    );
    expect(kinds(dripping({ lastDripAt: NOW - 1_799n }), payrollPolicy({ dripEverySeconds: 1_800 }))).toEqual(
      [],
    );
  });

  it("never drips when the contract says nothing is due", () => {
    // Zero inside the contract's own ten-minute gap, and while sIMD has no stakers.
    const decision = decidePayroll(
      dripping({ stream: stream({ dueNow: 0n, nextDripAt: NOW + 300n }) }),
      payrollPolicy(),
    );
    expect(decision.actions).toEqual([]);
    expect(decision.waiting[0]?.reason).toContain("nothing is due now");
    expect(decision.waiting[0]?.until).toBe(Number(NOW + 300n));
  });

  it("does not send a few seconds' worth: what is due must be a whole drip", () => {
    // Twelve seconds after a booking.
    const dust = stream({ dueNow: (IMD(50) * 12n) / 604_800n });
    const decision = decidePayroll(payroll({ stream: dust, lastDripAt: 0n }), payrollPolicy());
    expect(decision.actions).toEqual([]);
    expect(decision.waiting[0]?.reason).toContain("less than a whole drip");
  });

  it("counts an hour's vesting as a whole drip although it is a wei short of the cap", () => {
    // The contract rounds the cap up and the vesting down.
    const vested = (IMD(50) * 3600n) / 604_800n;
    expect(vested).toBe(CAP - 1n);
    expect(isWorthDripping(stream({ dueNow: vested }))).toBe(true);
    expect(kinds(dripping({ stream: stream({ dueNow: vested }) }))).toEqual(["drip"]);
    // Within a twentieth of the cap, and not below that.
    const edge = CAP - CAP / 20n;
    expect(isWorthDripping(stream({ dueNow: edge }))).toBe(true);
    expect(isWorthDripping(stream({ dueNow: edge - 1n }))).toBe(false);
    expect(isWorthDripping(stream({ dueNow: 0n }))).toBe(false);
  });

  it("sends the last of a stream that has finished vesting, however small", () => {
    const tail = stream({ outstanding: 7n, unvested: 0n, dueNow: 7n });
    expect(isWorthDripping(tail)).toBe(true);
    expect(kinds(dripping({ stream: tail }))).toEqual(["drip"]);
  });

  it("says nothing about a stream that is empty", () => {
    expect(decidePayroll(payroll(), payrollPolicy()).waiting).toEqual([]);
  });
});

describe("topping the meters up", () => {
  const budget = (over: Partial<PayrollSnapshot["feedBudget"]> = {}): PayrollSnapshot["feedBudget"] => ({
    total: IMD(20),
    old: 0n,
    releasableNow: 0n,
    nextReleaseAt: (NOW / FORTNIGHT + 1n) * FORTNIGHT,
    ...over,
  });

  it("calls fundFeeds when a meter is at least the minimum below its runway, with gas to spare", () => {
    const decision = decidePayroll(
      payroll({ feedBudget: budget(), shortfalls: [IMD(1.1), 0n, 0n] }),
      payrollPolicy(),
    );
    expect(decision.actions.map((a) => a.kind)).toEqual(["fundFeeds"]);
    expect(decision.actions[0]?.call).toMatchObject({
      address: PAYROLL,
      functionName: "fundFeeds",
      args: [],
    });
    expect(decision.actions[0]?.gasFloor).toBe(FUND_FEEDS_GAS_FLOOR);
    // One wei under the minimum, on every meter: not yet.
    const under = IMD(1.1) - 1n;
    expect(kinds(payroll({ feedBudget: budget(), shortfalls: [under, under, under] }))).toEqual([]);
    // The largest shortfall decides, whichever meter it is.
    expect(kinds(payroll({ feedBudget: budget(), shortfalls: [0n, 0n, IMD(2.2)] }))).toEqual(["fundFeeds"]);
  });

  it("does not call for a shortfall when there is no budget to place", () => {
    const decision = decidePayroll(payroll({ shortfalls: [IMD(7.7), IMD(7.7), IMD(2.2)] }), payrollPolicy());
    expect(decision.actions).toEqual([]);
    expect(decision.waiting[0]?.reason).toContain("Payroll has no feed budget");
  });

  it("calls when budget has waited out its time: nothing else releases it", () => {
    const decision = decidePayroll(
      payroll({ feedBudget: budget({ releasableNow: IMD(3) }) }),
      payrollPolicy(),
    );
    expect(decision.actions.map((a) => a.kind)).toEqual(["fundFeeds"]);
    expect(decision.actions[0]?.reason).toContain("has waited out its time");
    // Even one wei of it.
    expect(kinds(payroll({ feedBudget: budget({ total: 1n, releasableNow: 1n }) }))).toEqual(["fundFeeds"]);
  });

  it("calls once a fortnight boundary has passed: one second before it does not, at it it does", () => {
    const period = NOW / FORTNIGHT;
    const boundary = (period + 1n) * FORTNIGHT;
    const aged = { feedPeriod: period, feedBudget: budget() };
    expect(kinds(payroll({ ...aged, now: boundary - 1n }))).toEqual([]);
    const at = decidePayroll(payroll({ ...aged, now: boundary }), payrollPolicy());
    expect(at.actions.map((a) => a.kind)).toEqual(["fundFeeds"]);
    expect(at.actions[0]?.reason).toContain("a fortnight boundary has passed");
    // With no budget there is nothing to age or release, boundary or not.
    expect(kinds(payroll({ feedPeriod: period, now: boundary + 5n }))).toEqual([]);
  });

  it("gives every reason that applies, in one call", () => {
    const period = NOW / FORTNIGHT;
    const decision = decidePayroll(
      payroll({
        now: (period + 1n) * FORTNIGHT,
        feedPeriod: period,
        feedBudget: budget({ releasableNow: IMD(1) }),
        shortfalls: [IMD(5), 0n, 0n],
      }),
      payrollPolicy(),
    );
    expect(decision.actions).toHaveLength(1);
    const reason = decision.actions[0]?.reason ?? "";
    expect(reason).toContain("below its runway");
    expect(reason).toContain("waited out its time");
    expect(reason).toContain("fortnight boundary");
  });
});

describe("the order of what is sent", () => {
  it("books first, then tops up, then drips", () => {
    const snapshot = payroll({
      unbooked: IMD(100),
      stream: stream(),
      lastDripAt: NOW - 7_200n,
      feedBudget: { total: IMD(20), old: 0n, releasableNow: 0n, nextReleaseAt: 0n },
      shortfalls: [IMD(7.7), 0n, 0n],
    });
    expect(kinds(snapshot)).toEqual(["book", "fundFeeds", "drip"]);
  });

  it("is a pure function", () => {
    const snapshot = payroll({ unbooked: IMD(100) });
    const copy = structuredClone(snapshot);
    expect(decidePayroll(snapshot, payrollPolicy())).toEqual(decidePayroll(snapshot, payrollPolicy()));
    expect(snapshot).toEqual(copy);
  });
});
