/**
 * Payroll (launch A): every movement of money through the contract that splits HELP WANTED's fees.
 *
 * Launched on mainnet on 13 October 2026, so its events are final; the module decodes them with the
 * generated ABI. Payroll is a ledger, so its table is one too: one row per log, keyed by
 * `(tx_hash, log_index)`, with a `kind` and the few fields every kind shares. Sums by kind give the
 * public P&L: IMD to stakers, to seats (accrued and claimed), to the feeds.
 *
 *   Paid               → kind `paid`           (account = payer, memo)
 *   Booked             → kind `booked`         (detail: the three-way split)
 *   Dripped            → kind `dripped`        (account = caller; IMD sent to sIMD)
 *   SeatClaimed        → kind `seat_claimed`   (account = seat owner, token_id)
 *   Tipped             → kind `tipped`         (account = payer, detail: agent ids, per-agent share)
 *   TipClaimed         → kind `tip_claimed`    (account = seat owner, agent_id, token_id)
 *   TipSwept           → kind `tip_swept`      (agent_id)
 *   FeedFunded         → kind `feed_funded`    (feed_id)
 *   FeedBudgetReleased → kind `feed_budget_released`
 *
 * Kept in `events` and folded into no row (`KEPT`), because no IMD moves in them: `StreamLevelled`
 * (the staker stream was re-levelled), `FeedFundingFailed` (a meter top-up that did not go through)
 * and `FeedBudgetAged` (budget held over into the next period).
 *
 * A claim is paid to the seat's owner. As launched, a seat held by a contract must be claimed by
 * that contract itself (`ContractOwnerMustClaim`), so `account` on a claim of such a seat is also
 * the sender of the transaction.
 */
import { index, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { z } from "zod";
import { payrollAbi } from "@help-wanted/shared";
import { int53, logOrigin, wei } from "../../db/columns.js";
import { address, bytes32, parseArgs, smallUint, uint } from "../../engine/args.js";
import type { IndexedEvent } from "../../engine/module.js";
import type { JsonValue } from "../../json.js";
import { launchedModule } from "./stub.js";

export const PAYROLL_KINDS = [
  "paid",
  "booked",
  "dripped",
  "seat_claimed",
  "tipped",
  "tip_claimed",
  "tip_swept",
  "feed_funded",
  "feed_budget_released",
] as const;
export type PayrollKind = (typeof PAYROLL_KINDS)[number];

export const payrollMovements = pgTable(
  "payroll_movements",
  {
    ...logOrigin(),
    kind: text("kind").$type<PayrollKind>().notNull(),
    /** Who paid in or who was paid, depending on `kind`; null when the movement names nobody. */
    account: text("account"),
    /** IMD in wei. */
    amount: wei("amount").notNull(),
    /** The free label a payer gave `pay` (an order id, `bytes32("grant")`, …). */
    memo: text("memo"),
    /** The seat a claim paid, for `seat_claimed` and `tip_claimed`. */
    tokenId: int53("token_id"),
    /** The ERC-8004 agent id, for the tip kinds. */
    agentId: wei("agent_id"),
    feedId: text("feed_id"),
    /** Whatever else the event carried. */
    detail: jsonb("detail").$type<JsonValue>(),
  },
  (t) => [
    primaryKey({ columns: [t.txHash, t.logIndex] }),
    index("payroll_movements_block_idx").on(t.blockNumber, t.logIndex),
    index("payroll_movements_kind_idx").on(t.kind),
    index("payroll_movements_account_idx").on(t.account),
  ],
);

const amount = { amount: uint };
const Paid = z.object({ from: address, memo: bytes32, ...amount });
const Booked = z.object({ ...amount, toStakers: uint, toSeats: uint, toFeeds: uint });
const Dripped = z.object({ caller: address, ...amount, outstanding: uint });
const SeatClaimed = z.object({ tokenId: smallUint, owner: address, ...amount });
const Tipped = z.object({
  from: address,
  ...amount,
  perAgent: uint,
  toSeatPool: uint,
  agentIds: z.array(uint),
});
const TipClaimed = z.object({ agentId: uint, tokenId: smallUint, owner: address, ...amount });
const TipSwept = z.object({ agentId: uint, ...amount });
const FeedFunded = z.object({ feedId: bytes32, ...amount });
const FeedBudgetReleased = z.object(amount);

/** The events the handler writes into `payroll_movements`, each as the kind beside it. */
export const PAYROLL_FOLDED = [
  "Paid",
  "Booked",
  "Dripped",
  "SeatClaimed",
  "Tipped",
  "TipClaimed",
  "TipSwept",
  "FeedFunded",
  "FeedBudgetReleased",
] as const;

/** The events that are stored in `events` and go no further; the header says why for each. */
export const PAYROLL_KEPT = ["StreamLevelled", "FeedFundingFailed", "FeedBudgetAged"] as const;

type Movement = Omit<
  typeof payrollMovements.$inferInsert,
  "txHash" | "logIndex" | "blockNumber" | "blockTime"
>;

/** One event as a ledger row, or null for an event that moves no IMD. */
function movementOf(event: IndexedEvent): Movement | null {
  switch (event.event) {
    case "Paid": {
      const args = parseArgs(Paid, event);
      return { kind: "paid", account: args.from, amount: args.amount, memo: args.memo };
    }
    case "Booked": {
      const args = parseArgs(Booked, event);
      return {
        kind: "booked",
        amount: args.amount,
        detail: {
          toStakers: args.toStakers.toString(10),
          toSeats: args.toSeats.toString(10),
          toFeeds: args.toFeeds.toString(10),
        },
      };
    }
    case "Dripped": {
      const args = parseArgs(Dripped, event);
      return {
        kind: "dripped",
        account: args.caller,
        amount: args.amount,
        detail: { outstanding: args.outstanding.toString(10) },
      };
    }
    case "SeatClaimed": {
      const args = parseArgs(SeatClaimed, event);
      return { kind: "seat_claimed", account: args.owner, amount: args.amount, tokenId: args.tokenId };
    }
    case "Tipped": {
      const args = parseArgs(Tipped, event);
      return {
        kind: "tipped",
        account: args.from,
        amount: args.amount,
        detail: {
          perAgent: args.perAgent.toString(10),
          toSeatPool: args.toSeatPool.toString(10),
          agentIds: args.agentIds.map((id) => id.toString(10)),
        },
      };
    }
    case "TipClaimed": {
      const args = parseArgs(TipClaimed, event);
      return {
        kind: "tip_claimed",
        account: args.owner,
        amount: args.amount,
        agentId: args.agentId,
        tokenId: args.tokenId,
      };
    }
    case "TipSwept": {
      const args = parseArgs(TipSwept, event);
      return { kind: "tip_swept", amount: args.amount, agentId: args.agentId };
    }
    case "FeedFunded": {
      const args = parseArgs(FeedFunded, event);
      return { kind: "feed_funded", amount: args.amount, feedId: args.feedId };
    }
    case "FeedBudgetReleased": {
      const args = parseArgs(FeedBudgetReleased, event);
      return { kind: "feed_budget_released", amount: args.amount };
    }
    default:
      // One of `PAYROLL_KEPT`, or a log the ABI does not know: it is in `events`.
      return null;
  }
}

export const payrollModule = launchedModule({
  name: "payroll",
  title: "Payroll: fee split, staker stream, seat pool and tips",
  contract: "payroll",
  abi: payrollAbi,
  tables: [payrollMovements],
  folded: PAYROLL_FOLDED,
  kept: PAYROLL_KEPT,
  async apply(db, event) {
    const movement = movementOf(event);
    if (!movement) return;
    const row = {
      txHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      blockTime: event.blockTime,
      // Every column is written, so a row folded twice is the same row.
      account: null,
      memo: null,
      tokenId: null,
      agentId: null,
      feedId: null,
      detail: null,
      ...movement,
    };
    await db
      .insert(payrollMovements)
      .values(row)
      .onConflictDoUpdate({ target: [payrollMovements.txHash, payrollMovements.logIndex], set: row });
  },
});
