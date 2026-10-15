/**
 * The mirror of the public IdentityMD API: the handful of documents the pages need, copied here so
 * that no visitor's request is ever passed on to `api.imd.fun`.
 *
 * These rows come from somebody else's server, not from the chain. They are never rewound, they
 * carry the time we fetched them, and each keeps the document as it was served (`raw`) beside the
 * few fields lifted out for listing.
 */
import { boolean, index, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { int53 } from "../db/columns.js";
import type { JsonValue } from "../json.js";

/**
 * `GET /health`, one row per UTC hour (the newest poll of the hour wins). The latest row is the
 * Work Wire's headline; the older ones are a cheap history of the swarm's size.
 */
export const apiHealth = pgTable("api_health", {
  /** `YYYY-MM-DDTHH`, UTC. */
  hour: text("hour").primaryKey(),
  fetchedAtMs: int53("fetched_at_ms").notNull(),
  status: text("status"),
  /** Daemons connected: "robots online". */
  connectedDaemons: int53("connected_daemons"),
  /** Jobs being worked right now. */
  workingNow: int53("working_now"),
  acceptedLastDay: int53("accepted_last_day"),
  /** Work-record receipts waiting to be written on chain. Large when the writer is stalled. */
  pendingFeedback: int53("pending_feedback"),
  paymentsEnabled: boolean("payments_enabled"),
  /** Paid orders ever. */
  paidOrders: int53("paid_orders"),
  /** The server's own clock for the document. */
  computedAt: text("computed_at"),
  raw: jsonb("raw").$type<JsonValue>().notNull(),
});

/** Jobs: the newest from `GET /jobs`, and in full (`detail`) the ones we watch. */
export const apiJobs = pgTable(
  "api_jobs",
  {
    /** The job's UUID. */
    id: text("id").primaryKey(),
    state: text("state"),
    template: text("template"),
    /** Shortened by the server in the list; whole once `detail` has been fetched. */
    objective: text("objective"),
    /** Lowercase address; only `GET /jobs/:id` says who paid. */
    paidBy: text("paid_by"),
    launchKind: text("launch_kind"),
    blockedReason: text("blocked_reason"),
    createdAt: text("created_at"),
    updatedAt: text("updated_at"),
    /** True for a job on the watch list. */
    watched: boolean("watched").notNull().default(false),
    /** The list entry as served. */
    listed: jsonb("listed").$type<JsonValue>(),
    /** `GET /jobs/:id` as served; null for a job only ever seen in the list. */
    detail: jsonb("detail").$type<JsonValue>(),
    fetchedAtMs: int53("fetched_at_ms").notNull(),
    detailFetchedAtMs: int53("detail_fetched_at_ms"),
  },
  (t) => [index("api_jobs_created_idx").on(t.createdAt), index("api_jobs_watched_idx").on(t.watched)],
);

/** `GET /jobs/:id/records`: a watched job's work-record hash and whether its receipt was written. */
export const apiJobRecords = pgTable(
  "api_job_records",
  {
    jobId: text("job_id").notNull(),
    recordId: text("record_id").notNull(),
    /** keccak256 of the record, `0x`-prefixed here although the API serves it bare. */
    hash: text("hash").notNull(),
    chainId: int53("chain_id"),
    registry: text("registry"),
    /** `queued`, `sent` or `failed`, as the API says. */
    status: text("status"),
    txHash: text("tx_hash"),
    failure: jsonb("failure").$type<JsonValue>(),
    fetchedAtMs: int53("fetched_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.recordId] }), index("api_job_records_hash_idx").on(t.hash)],
);

/** `GET /oracle/requests`: the swarm's oracle requests, newest first. */
export const apiOracleRequests = pgTable(
  "api_oracle_requests",
  {
    /** The oracle request's UUID. `intake_requests.oracle_request_id` points here. */
    id: text("id").primaryKey(),
    status: text("status"),
    question: text("question"),
    chainId: int53("chain_id"),
    answerType: text("answer_type"),
    /** The panel job that answered, a UUID. */
    jobId: text("job_id"),
    signer: text("signer"),
    fromBlock: int53("from_block"),
    toBlock: int53("to_block"),
    attestedAt: text("attested_at"),
    createdAt: text("created_at"),
    updatedAt: text("updated_at"),
    raw: jsonb("raw").$type<JsonValue>().notNull(),
    fetchedAtMs: int53("fetched_at_ms").notNull(),
  },
  (t) => [
    index("api_oracle_requests_created_idx").on(t.createdAt),
    index("api_oracle_requests_status_idx").on(t.status),
  ],
);

export const MIRROR_TABLES = [apiHealth, apiJobs, apiJobRecords, apiOracleRequests];
