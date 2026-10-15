/**
 * Rules (launch C): "WHEN a condition holds, THEN hire or pay", and how often each rule has fired.
 *
 * STUB. Table now, handler later; see `stub.ts`. Launch C has no frozen interface of its own, so
 * the table keeps what the brief fixes (two verbs, HIRE and PAY; two condition kinds, VIEW and
 * FEED; an escrow; a fire count) as columns and the rest of a rule's parameters as the JSON its
 * creation event carried. Each fire is an `events` row of this module, which is the fire history
 * a page lists.
 *
 * The fold, with the event names of the source in `launches/c-company` as it stood on 11 October
 * 2026 (seven events; none is frozen, so check the list against the compiled ABI):
 *
 *   RuleCreated   → insert `rules` (creator, action, params, spec, deposit; escrow = deposit)
 *   Fired         → `fires += 1`, `last_fired_time`, `last_order_id`, `escrow -= spent + tip`
 *   ToppedUp      → `escrow += amount`
 *   Reconciled    → `escrow += amount` unless it went straight to the creator
 *   Recalled      → the rule took back an order nobody had delivered (no column yet)
 *   WorkDelivered → the desk reported the rule's order as delivered (no column yet)
 *   RuleCancelled → `cancelled = true`, `refund`, `escrow = 0`
 *
 * Write the handler from the compiled ABI, with a test that fails when an ABI event has no branch.
 */
import { boolean, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { int53, wei } from "../../db/columns.js";
import type { JsonValue } from "../../json.js";
import { ownModule } from "./stub.js";

export const RULE_ACTIONS = ["HIRE", "PAY"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export const rules = pgTable(
  "rules",
  {
    /** Rules count from 1. */
    id: int53("id").primaryKey(),
    creator: text("creator").notNull(),
    action: text("action").$type<RuleAction>().notNull(),
    /** The rule's parameters exactly as its creation event carried them. */
    params: jsonb("params").$type<JsonValue>(),
    /** HIRE only: the job text every order of the rule carries. */
    spec: text("spec"),
    deposit: wei("deposit").notNull(),
    /** IMD the rule can still spend. */
    escrow: wei("escrow").notNull(),
    fires: int53("fires").notNull(),
    lastFiredTime: int53("last_fired_time"),
    /** HIRE only: the order the latest fire opened on the hire desk. */
    lastOrderId: int53("last_order_id"),
    cancelled: boolean("cancelled").notNull().default(false),
    /** What a cancellation returned to the creator. */
    refund: wei("refund"),

    createdBlock: int53("created_block").notNull(),
    createdTime: int53("created_time").notNull(),
    createdTx: text("created_tx").notNull(),
    updatedBlock: int53("updated_block").notNull(),
    updatedTime: int53("updated_time").notNull(),
  },
  (t) => [index("rules_creator_idx").on(t.creator)],
);

export const rulesModule = ownModule({
  name: "rules",
  title: "Rules: WHEN/THEN rules (handler is a stub)",
  contract: "rules",
  tables: [rules],
});
