/**
 * JobsReport (launch A): the prints of the daily Robot Jobs Report.
 *
 * Launched on mainnet on 13 October 2026, so its events are final; the module decodes them with the
 * generated ABI. A print is one period's official number, bought from the oracle through a
 * Questions feed. The unofficial number for the same block window is
 * `queries.jobsReportWindow(fromBlock, toBlock)`, counted from `fee_transfers`; putting the two
 * side by side is the report's technical note.
 *
 *   Printed → insert `prints` (index, payrolls round, amount, window, running total and streak)
 *   Counted → `prints.count`, `prints.count_round` (the number of payments, from the hires feed)
 *   BestDay → `prints.best_day = true` for that print (it was the best day when it was printed)
 *
 * Kept in `events` and folded into no table (`KEPT`): `CountRecorded` (an answer of the hires feed
 * with its own window and running total: a count exists before it is attached to a print),
 * `RoundSkipped` (a round consumed without adding an entry, and why) and `EmployersOfTheWeek` (the
 * top three payers of an employers round: decoration, and nothing may depend on it).
 */
import { eq } from "drizzle-orm";
import { boolean, index, pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod";
import { jobsReportAbi } from "@help-wanted/shared";
import { int53, wei } from "../../db/columns.js";
import { parseArgs, smallUint, uint } from "../../engine/args.js";
import { launchedModule } from "./stub.js";

export const prints = pgTable(
  "prints",
  {
    /** Position in the report's history, as the contract numbers it. */
    index: int53("index").primaryKey(),
    /** The round of the payrolls feed this print took its amount from. */
    round: int53("round").notNull(),
    /** IMD paid to the swarm in the window, in wei. */
    amount: wei("amount").notNull(),
    fromBlock: int53("from_block").notNull(),
    toBlock: int53("to_block").notNull(),
    /** Running figures after this print. */
    total: wei("total").notNull(),
    streak: int53("streak").notNull(),
    /** The number of payments in the window, once the hires feed's round arrived. */
    count: wei("count"),
    countRound: int53("count_round"),
    bestDay: boolean("best_day").notNull().default(false),

    printedBlock: int53("printed_block").notNull(),
    printedTime: int53("printed_time").notNull(),
    printedTx: text("printed_tx").notNull(),
  },
  (t) => [index("prints_window_idx").on(t.fromBlock, t.toBlock)],
);

const Printed = z.object({
  index: smallUint,
  round: smallUint,
  amount: uint,
  fromBlock: smallUint,
  toBlock: smallUint,
  total: uint,
  streak: smallUint,
});
const Counted = z.object({ index: smallUint, round: smallUint, count: uint });
const BestDay = z.object({ index: smallUint });

/** The events the handler writes into `prints`. */
export const JOBS_REPORT_FOLDED = ["Printed", "Counted", "BestDay"] as const;

/** The events that are stored in `events` and go no further; the header says why for each. */
export const JOBS_REPORT_KEPT = ["CountRecorded", "RoundSkipped", "EmployersOfTheWeek"] as const;

export const jobsReportModule = launchedModule({
  name: "jobs_report",
  title: "JobsReport: prints",
  contract: "jobsReport",
  abi: jobsReportAbi,
  tables: [prints],
  folded: JOBS_REPORT_FOLDED,
  kept: JOBS_REPORT_KEPT,
  async apply(db, event) {
    switch (event.event) {
      case "Printed": {
        const args = parseArgs(Printed, event);
        const row = {
          round: args.round,
          amount: args.amount,
          fromBlock: args.fromBlock,
          toBlock: args.toBlock,
          total: args.total,
          streak: args.streak,
          printedBlock: event.blockNumber,
          printedTime: event.blockTime,
          printedTx: event.txHash,
        };
        await db
          .insert(prints)
          .values({ index: args.index, ...row })
          .onConflictDoUpdate({ target: prints.index, set: row });
        return;
      }
      case "Counted": {
        const args = parseArgs(Counted, event);
        await db
          .update(prints)
          .set({ count: args.count, countRound: args.round })
          .where(eq(prints.index, args.index));
        return;
      }
      case "BestDay": {
        const args = parseArgs(BestDay, event);
        await db.update(prints).set({ bestDay: true }).where(eq(prints.index, args.index));
        return;
      }
      default:
        // One of `JOBS_REPORT_KEPT`, or a log the ABI does not know: it is in `events`.
        return;
    }
  },
});
