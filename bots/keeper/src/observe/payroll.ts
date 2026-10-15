/** Reads everything `decidePayroll` needs, at one block. Sends nothing. */
import type { Abi, Address } from "viem";
import { payrollAbi } from "@help-wanted/shared";
import type { PayrollSnapshot } from "../modules/payroll.js";
import { readAt, readOnce, type ObserveContext } from "./common.js";
import { big } from "./questions.js";

const PAYROLL_ABI = payrollAbi as unknown as Abi;

export async function observePayroll(
  ctx: ObserveContext,
  targets: { payroll: Address },
): Promise<PayrollSnapshot> {
  const { payroll } = targets;
  const [unbooked, stream, clock, feedBudget, shortfalls, period] = (await Promise.all([
    readAt(ctx, payroll, PAYROLL_ABI, "unbooked"),
    readAt(ctx, payroll, PAYROLL_ABI, "stream"),
    readAt(ctx, payroll, PAYROLL_ABI, "clock"),
    readAt(ctx, payroll, PAYROLL_ABI, "feedBudget"),
    readAt(ctx, payroll, PAYROLL_ABI, "feedShortfalls"),
    readOnce<unknown>(ctx, payroll, PAYROLL_ABI, "FEED_BUDGET_PERIOD"),
  ])) as [unknown, readonly unknown[], readonly unknown[], readonly unknown[], readonly unknown[], unknown];
  return {
    now: ctx.block.timestamp,
    payroll,
    unbooked: big(unbooked),
    stream: {
      outstanding: big(stream[0]),
      unvested: big(stream[1]),
      endsAt: big(stream[2]),
      perDrip: big(stream[3]),
      nextDripAt: big(stream[4]),
      dueNow: big(stream[5]),
    },
    // `clock()` is (streamEnd, streamCursor, lastDripAt, feedPeriod).
    lastDripAt: big(clock[2]),
    feedPeriod: big(clock[3]),
    feedBudgetPeriod: big(period),
    feedBudget: {
      total: big(feedBudget[0]),
      old: big(feedBudget[1]),
      releasableNow: big(feedBudget[2]),
      nextReleaseAt: big(feedBudget[3]),
    },
    shortfalls: [big(shortfalls[0]), big(shortfalls[1]), big(shortfalls[2])],
  };
}
