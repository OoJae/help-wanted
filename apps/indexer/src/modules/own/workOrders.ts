/**
 * WorkOrders, the hire desk (launch B): orders and the claims runners make on them.
 *
 * STUB. The tables below are final enough to query and to build pages against; the handler that
 * fills them is not written yet. The desk has been on mainnet since 13 October 2026 (IdentityMD
 * launch 1573), so its events are final and the handler can be written from the generated ABI
 * (`workOrdersAbi` of `@help-wanted/shared`). Until it is, every log of the desk is stored in
 * `events` from the launch block on, undecoded, and nothing is folded. See `stub.ts` for how to
 * finish it.
 *
 * Columns follow `IWorkOrders.OrderParams`, `IWorkOrders.State` and the brief's two settlement
 * paths. The fold, with the sixteen events the launched desk's ABI declares (the names below were
 * checked against the generated ABI on 13 October 2026; the arguments were not):
 *
 *   OrderOpened      → insert `orders` (params, spec, state Open)
 *   Triggered        → `orders.triggered_value`
 *   Claimed          → insert `claims` (seq, runner, price, bond, ticket); order state Claimed
 *   Registered       → `claims.job_id`, `orders.job_id`; state Registered (emitted again for a retry job)
 *   DeliveryClaimed  → `claims.record_hash`, `claims.challenge_until`; state Asserted
 *   Challenged       → `claims.challenger`, `claims.challenger_bond`; state Disputed
 *   Resolved         → the arbiter's decision on a disputed claim (needs a column: who and which way)
 *   Failed           → a receipt was submitted that does not settle the order (needs a column or a
 *                      history table: the job id and record hash that were refused)
 *   ClaimEnded       → `claims.outcome` and the three bond amounts; order state from the event's `next`
 *   Delivered        → `orders` settlement columns, `proven`, `agent_ids`; state Delivered (the event
 *                      also carries `bonds`, what the runner got on top, which has no column yet)
 *   Proven           → `orders.proven = true` (a claimed delivery later matched to its receipt)
 *   Cancelled / Refunded → state and `to_employer`
 *   CallbackFailed / Redelivered → whether the employer's callback went through (no column yet)
 *   PayrollFallback  → the fee and tip reached Payroll by plain transfer (no column yet)
 *
 * When the handler is written, write it from the compiled ABI and add a test that fails when the
 * ABI has an event without a branch here: an event that is silently ignored leaves an order in
 * the wrong state.
 */
import { boolean, index, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { int53, wei } from "../../db/columns.js";
import { ownModule } from "./stub.js";

/** `IWorkOrders.State`, in the contract's order. `orders.state` holds one of these names. */
export const ORDER_STATES = [
  "None",
  "Open",
  "Claimed",
  "Registered",
  "Asserted",
  "Disputed",
  "Delivered",
  "Cancelled",
  "Refunded",
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const orders = pgTable(
  "orders",
  {
    /** The desk counts orders from 1. */
    id: int53("id").primaryKey(),
    employer: text("employer").notNull(),
    /** keccak256 of the work record's `kind` the employer wants. */
    kindHash: text("kind_hash").notNull(),
    specHash: text("spec_hash").notNull(),
    /** The job text. The desk allows printable ASCII only, so it is always storable. */
    spec: text("spec").notNull(),
    state: text("state").$type<OrderState>().notNull(),

    // `OrderParams`, as created.
    minPay: wei("min_pay").notNull(),
    maxPay: wei("max_pay").notNull(),
    rampSecs: int53("ramp_secs").notNull(),
    deliverySecs: int53("delivery_secs").notNull(),
    expiresAt: int53("expires_at").notNull(),
    bond: wei("bond").notNull(),
    flags: int53("flags").notNull(),
    runnerOnly: text("runner_only"),
    arbiter: text("arbiter"),
    condTarget: text("cond_target"),
    condSelector: text("cond_selector"),
    condArg: text("cond_arg"),
    condCmp: int53("cond_cmp"),
    condThreshold: wei("cond_threshold"),
    /** The word the condition returned when it was first seen true; null until then. */
    triggeredValue: wei("triggered_value"),

    // The claim that holds the order now, or the one that was paid.
    claimSeq: int53("claim_seq"),
    runner: text("runner"),
    /** The price fixed when the runner took the order. */
    price: wei("price"),
    /** `bytes16`; the swarm job the runner registered. */
    jobId: text("job_id"),
    recordHash: text("record_hash"),

    // Settlement. `proven` is true when a receipt matched, false when the order was paid on an
    // unchallenged or arbitrated claim, null before any payout.
    proven: boolean("proven"),
    runnerPay: wei("runner_pay"),
    fee: wei("fee"),
    tip: wei("tip"),
    toEmployer: wei("to_employer"),
    /** ERC-8004 agent ids of the seats that worked, as decimal strings. */
    agentIds: jsonb("agent_ids").$type<string[]>(),

    openedBlock: int53("opened_block").notNull(),
    openedTime: int53("opened_time").notNull(),
    openedTx: text("opened_tx").notNull(),
    updatedBlock: int53("updated_block").notNull(),
    updatedTime: int53("updated_time").notNull(),
    updatedTx: text("updated_tx").notNull(),
  },
  (t) => [
    index("orders_employer_idx").on(t.employer),
    index("orders_state_idx").on(t.state),
    index("orders_job_idx").on(t.jobId),
  ],
);

export const claims = pgTable(
  "claims",
  {
    orderId: int53("order_id").notNull(),
    /** Counts the claims of one order from 1; it is part of the order ticket. */
    seq: int53("seq").notNull(),
    runner: text("runner").notNull(),
    price: wei("price").notNull(),
    bond: wei("bond").notNull(),
    /** `keccak256(abi.encode(chainid, workOrders, orderId, seq, runner))`: the header's 64 hex. */
    ticket: text("ticket").notNull(),
    jobId: text("job_id"),
    /** The record hash the runner claimed delivery with (claimed path only). */
    recordHash: text("record_hash"),
    challengeUntil: int53("challenge_until"),
    challenger: text("challenger"),
    challengerBond: wei("challenger_bond"),
    /** Null while the claim is live; `delivered`, or the contract's reason for ending it. */
    outcome: text("outcome"),
    toRunner: wei("to_runner"),
    toEmployer: wei("to_employer"),
    toChallenger: wei("to_challenger"),

    claimedBlock: int53("claimed_block").notNull(),
    claimedTime: int53("claimed_time").notNull(),
    claimedTx: text("claimed_tx").notNull(),
    endedBlock: int53("ended_block"),
    endedTime: int53("ended_time"),
    endedTx: text("ended_tx"),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.seq] }),
    index("claims_runner_idx").on(t.runner),
    index("claims_job_idx").on(t.jobId),
  ],
);

export const workOrdersModule = ownModule({
  name: "work_orders",
  title: "WorkOrders: orders and claims (handler is a stub)",
  contract: "workOrders",
  tables: [orders, claims],
});
