/**
 * The payroll module: book plain transfers, drip the staker stream, top up the house meters.
 *
 * `decidePayroll` is a pure function of a snapshot and the operator's settings.
 *
 * book       `Payroll.book()` when IMD that arrived by plain transfer is waiting to be split and
 *            there is at least the operator's minimum of it (a caller sending dust could otherwise
 *            make the keeper spend gas at will).
 * fundFeeds  `Payroll.fundFeeds()` is the only call that places feed budget on the meters and the
 *            only one that releases budget whose wait is over. It is called when Payroll has
 *            budget and a meter is at least the operator's minimum below its runway; when budget
 *            is releasable; and when a fortnight boundary has passed since the budget was last
 *            aged, so that it is called at least once a fortnight while there is budget.
 * drip       `Payroll.drip()` when `stream().dueNow` is not zero (the contract's own word that the
 *            call would send something: it is zero inside the ten-minute gap and while sIMD has no
 *            stakers), the keeper's own interval since the last drip has passed, and what is due
 *            is a whole drip or the last of the stream. A whole drip is one hour of the stream; an
 *            hourly call keeps pace with vesting. Without the last condition the first call after
 *            a booking would send a few seconds' worth and start the gaps for nothing.
 *
 * Order: book first (it adds to the budget and re-levels the stream), then fundFeeds, then drip.
 */
import type { Abi, Address } from "viem";
import { payrollAbi } from "@help-wanted/shared";
import type { Action, Decision, Waiting } from "../actions.js";
import { FUND_FEEDS_GAS_FLOOR } from "./questions.js";

const PAYROLL_ABI = payrollAbi as unknown as Abi;

export interface PayrollPolicy {
  /** Book once this much IMD is waiting. Above zero. */
  bookMin: bigint;
  /** The least time between two drips, in seconds. */
  dripEverySeconds: number;
  /** Top the meters up once one is at least this far below its runway. */
  fundFeedsMin: bigint;
}

export interface PayrollSnapshot {
  /** The time of the block everything was read at. */
  now: bigint;
  payroll: Address;
  /** `unbooked()`: IMD that arrived by plain transfer and has not been split. */
  unbooked: bigint;
  /** `stream()`. */
  stream: {
    outstanding: bigint;
    unvested: bigint;
    endsAt: bigint;
    perDrip: bigint;
    nextDripAt: bigint;
    dueNow: bigint;
  };
  /** `clock()`: when `drip` last sent, and the fortnight the feed budget was last aged in. */
  lastDripAt: bigint;
  feedPeriod: bigint;
  /** `FEED_BUDGET_PERIOD`: fourteen days, in seconds. */
  feedBudgetPeriod: bigint;
  /** `feedBudget()`. */
  feedBudget: { total: bigint; old: bigint; releasableNow: bigint; nextReleaseAt: bigint };
  /** `feedShortfalls()`, in feed order A, B, C. */
  shortfalls: readonly [bigint, bigint, bigint];
}

/**
 * Whether what is due is worth a transaction: a whole drip (within a twentieth: the contract
 * rounds the cap up and the vesting down, so an hour's vesting is a wei short of the cap), or the
 * last of a stream that has finished vesting.
 */
export function isWorthDripping(
  stream: Pick<PayrollSnapshot["stream"], "dueNow" | "perDrip" | "unvested">,
): boolean {
  if (stream.dueNow === 0n) return false;
  return stream.unvested === 0n || stream.dueNow >= stream.perDrip - stream.perDrip / 20n;
}

/** State in, actions with reasons out. Pure. */
export function decidePayroll(snapshot: PayrollSnapshot, policy: PayrollPolicy): Decision {
  const actions: Action[] = [];
  const waiting: Waiting[] = [];
  const { now } = snapshot;
  const act = (kind: string, label: string, reason: string, gasFloor?: bigint) =>
    actions.push({
      module: "payroll",
      kind,
      subject: "payroll",
      label,
      reason,
      call: { address: snapshot.payroll, abi: PAYROLL_ABI, functionName: kind, args: [] },
      ...(gasFloor === undefined ? {} : { gasFloor }),
    });

  if (snapshot.unbooked >= policy.bookMin && snapshot.unbooked > 0n) {
    act(
      "book",
      "book plain transfers",
      `${snapshot.unbooked} IMD arrived by plain transfer and is not split yet`,
    );
  } else if (snapshot.unbooked > 0n) {
    waiting.push({
      module: "payroll",
      subject: "book",
      reason: `${snapshot.unbooked} IMD arrived by plain transfer; it is booked once at least ${policy.bookMin} is waiting`,
    });
  }

  const budget = snapshot.feedBudget;
  const largest = snapshot.shortfalls.reduce((a, b) => (b > a ? b : a), 0n);
  const boundaryPassed = now / snapshot.feedBudgetPeriod > snapshot.feedPeriod;
  const reasons: string[] = [];
  if (budget.total > 0n && largest > 0n && largest >= policy.fundFeedsMin) {
    reasons.push(
      `a meter is ${largest} below its runway (shortfalls ${snapshot.shortfalls.join(", ")}) and the budget holds ${budget.total}`,
    );
  }
  if (budget.releasableNow > 0n) {
    reasons.push(
      `${budget.releasableNow} of feed budget has waited out its time and is released after the meters are served`,
    );
  }
  if (budget.total > 0n && boundaryPassed) {
    reasons.push("a fortnight boundary has passed since the feed budget was last aged");
  }
  if (reasons.length > 0) {
    act(
      "fundFeeds",
      "top up the meters from Payroll's feed budget",
      reasons.join("; "),
      FUND_FEEDS_GAS_FLOOR,
    );
  } else if (largest > 0n && budget.total === 0n) {
    waiting.push({
      module: "payroll",
      subject: "fundFeeds",
      reason: `a meter is ${largest} below Payroll's runway and Payroll has no feed budget: the meters live on what others funded until fees arrive`,
    });
  }

  const dripOpensAt = snapshot.lastDripAt + BigInt(policy.dripEverySeconds);
  const { dueNow, perDrip, unvested, outstanding } = snapshot.stream;
  const worth = isWorthDripping(snapshot.stream);
  if (dueNow > 0n && now >= dripOpensAt && worth) {
    act(
      "drip",
      "drip the staker stream",
      `${dueNow} IMD of the staker stream is due and the last drip was at ${snapshot.lastDripAt}`,
    );
  } else if (outstanding > 0n) {
    const next = dripOpensAt > snapshot.stream.nextDripAt ? dripOpensAt : snapshot.stream.nextDripAt;
    waiting.push({
      module: "payroll",
      subject: "drip",
      reason:
        dueNow === 0n
          ? `${outstanding} IMD is still to go to stakers and nothing is due now (inside the ten-minute gap, nothing vested yet, or sIMD has no stakers)`
          : now < dripOpensAt
            ? `${dueNow} IMD is due; the next drip is sent at ${dripOpensAt}`
            : `${dueNow} IMD is due, less than a whole drip (${perDrip}) with ${unvested} still vesting; it is sent once a whole drip is due`,
      ...(next > now ? { until: Number(next) } : {}),
    });
  }
  return { actions, waiting };
}
