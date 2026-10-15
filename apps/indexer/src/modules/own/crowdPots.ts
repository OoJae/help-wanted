/**
 * CrowdPots (launch B): pots many wallets chip into, and each contributor's stake.
 *
 * STUB. Tables now, handler later; see `stub.ts`. CrowdPots has been on mainnet since 13 October
 * 2026 (IdentityMD launch 1573), so its events are final and the handler can be written from the
 * generated ABI (`crowdPotsAbi` of `@help-wanted/shared`). Until it is, every log of the contract
 * is stored in `events` from the launch block on, undecoded, and nothing is folded. The pot's
 * terms are kept as the JSON the event carries rather than as columns.
 *
 * The fold, with the nine events the launched contract's ABI declares (the names below were
 * checked against the generated ABI on 13 October 2026; the arguments were not). There is no
 * event for a kind's text: a pot's kind is the first member of the `terms` its `PotOpened` carries.
 *
 *   SpecPinned    → remembered by spec hash, copied into `pots.spec`
 *   PotOpened     → insert `pots` (opener, series, spec hash, deadline, terms; stage Funding)
 *   SeriesOpened  → a series, whose rounds arrive as `PotOpened` with its id (no table yet: pots
 *                   and series share one counter, so a series is an id no pot row has)
 *   ChippedIn     → upsert `chips` for (pot, beneficiary): amount += chip; `pots.raised`
 *   PotFilled     → `pots.stage`
 *   PotLaunched   → `pots.order_id`, stage Hiring
 *   WorkDelivered → `pots.job_id`, `pots.record_hash`
 *   PotSettled    → `pots.stage`, `spent`, `refundable`
 *   RefundPaid    → `chips.refunded`
 *
 * Write the handler from the compiled ABI, with a test that fails when an ABI event has no branch.
 */
import { index, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { int53, wei } from "../../db/columns.js";
import type { JsonValue } from "../../json.js";
import { ownModule } from "./stub.js";

export const pots = pgTable(
  "pots",
  {
    /** Pots and series share one counter that starts at 1. */
    id: int53("id").primaryKey(),
    opener: text("opener").notNull(),
    /** The series this pot is a round of, or null. */
    seriesId: int53("series_id"),
    specHash: text("spec_hash").notNull(),
    /** The job text behind `spec_hash`, once it has been published on chain. */
    spec: text("spec"),
    /** The pot's terms exactly as its opening event carried them. */
    terms: jsonb("terms").$type<JsonValue>(),
    /** Last second at which the pot takes chips and can be launched. */
    deadline: int53("deadline").notNull(),
    /** The contract's stage name. */
    stage: text("stage").notNull(),
    raised: wei("raised").notNull(),
    /** The pot's order on the hire desk, once launched. */
    orderId: int53("order_id"),
    jobId: text("job_id"),
    recordHash: text("record_hash"),
    /** Once settled: what the desk paid for delivered work, and what contributors share. */
    spent: wei("spent"),
    refundable: wei("refundable"),

    openedBlock: int53("opened_block").notNull(),
    openedTime: int53("opened_time").notNull(),
    openedTx: text("opened_tx").notNull(),
    updatedBlock: int53("updated_block").notNull(),
    updatedTime: int53("updated_time").notNull(),
    updatedTx: text("updated_tx").notNull(),
  },
  (t) => [index("pots_order_idx").on(t.orderId), index("pots_opener_idx").on(t.opener)],
);

export const chips = pgTable(
  "chips",
  {
    potId: int53("pot_id").notNull(),
    /** Who the chips (and any refund of them) belong to; not always who paid. */
    contributor: text("contributor").notNull(),
    /** The sum of this contributor's chips into this pot. */
    amount: wei("amount").notNull(),
    /** How many separate chips make up `amount`. */
    chipCount: int53("chip_count").notNull(),
    /** What `claimRefund` paid back, or null before a claim. */
    refunded: wei("refunded"),

    firstBlock: int53("first_block").notNull(),
    firstTime: int53("first_time").notNull(),
    lastBlock: int53("last_block").notNull(),
    lastTime: int53("last_time").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.potId, t.contributor] }),
    index("chips_contributor_idx").on(t.contributor),
  ],
);

export const crowdPotsModule = ownModule({
  name: "crowd_pots",
  title: "CrowdPots: pots and chips (handler is a stub)",
  contract: "crowdPots",
  tables: [pots, chips],
});
