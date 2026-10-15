/**
 * The two tables the sync engine itself owns. Everything else belongs to a module.
 */
import { index, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import type { JsonValue } from "../json.js";
import { int53 } from "./columns.js";

/**
 * One row per module: the half-open block range `[start_block, next_block)` whose logs have all
 * been read. That range is the module's coverage: its tables are folded from the events inside it
 * and from nothing else. A module is its own small indexer, so adding one later never disturbs
 * the others. The row is written with the first range that is stored, not before.
 */
export const cursors = pgTable("cursors", {
  module: text("module").primaryKey(),
  /** The first block this module has been synced from. A backfill lowers it. */
  startBlock: int53("start_block").notNull(),
  /** The timestamp of `start_block`, or null when the node would not serve that header. */
  startTime: int53("start_time"),
  /** The first block not yet synced. */
  nextBlock: int53("next_block").notNull(),
  /**
   * The hash and timestamp of block `next_block - 1` as the chain had it when the module caught
   * up to it. Null while the module is still catching up or has just been rewound.
   */
  tipHash: text("tip_hash"),
  tipTime: int53("tip_time"),
  /**
   * A backfill in progress: it is reading down to `backfill_from`, and the logs of
   * `[backfill_from, backfill_next)` are already stored. Both null when none is under way. The
   * logs of an unfinished backfill lie below `start_block`, so they are in no table yet; running
   * the same backfill again continues at `backfill_next`.
   */
  backfillFrom: int53("backfill_from"),
  backfillNext: int53("backfill_next"),
  updatedAtMs: int53("updated_at_ms").notNull(),
});

/**
 * Every log a module matched, exactly once, keyed by `(module, tx_hash, log_index)`.
 *
 * This is the source of truth for chain data. A module's own tables are folded from these rows by
 * its handler, so they can be rebuilt at any time: after a reorganisation, after a backfill, or
 * when a handler changes. `topics` and `data` are kept raw for that reason; `event` and `args` are
 * the decoding under the module's ABI at the time (`event` is topic0 when the ABI does not know it).
 *
 * `block_hash` is the hash of the block the log was in when it was read. Each sync reads the most
 * recent blocks again and compares; a log that is gone or whose block has another hash means the
 * chain was reorganised, and everything from that block up is deleted and read again.
 *
 * A row can lie outside its module's coverage: fetched by a backfill that has not finished, or
 * left below the new start block by `skip`. Such a row is kept (it is a real log) but counts for
 * nothing: no table is folded from it and the lists and snapshots leave it out.
 */
export const events = pgTable(
  "events",
  {
    module: text("module").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: int53("log_index").notNull(),
    txIndex: int53("tx_index").notNull(),
    blockNumber: int53("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
    blockTime: int53("block_time").notNull(),
    address: text("address").notNull(),
    event: text("event").notNull(),
    args: jsonb("args").$type<JsonValue>(),
    topics: jsonb("topics").$type<string[]>().notNull(),
    data: text("data").notNull(),
    /**
     * Why the module's handler could not fold this event, or null. An event with a reason here is
     * stored but is in none of the module's tables; a rebuild tries it again.
     */
    foldError: text("fold_error"),
  },
  (t) => [
    primaryKey({ columns: [t.module, t.txHash, t.logIndex] }),
    index("events_module_order_idx").on(t.module, t.blockNumber, t.logIndex),
    index("events_block_idx").on(t.blockNumber),
  ],
);

export type EventRow = typeof events.$inferSelect;
export type CursorRow = typeof cursors.$inferSelect;
