/**
 * Column helpers, so every table spells the same thing the same way.
 *
 * - Addresses and hashes are lowercase `0x…` text, the spelling the IdentityMD API uses.
 * - Token amounts are `numeric(78, 0)` (room for any uint256) and come back as `bigint`.
 * - Block numbers, log indexes, ids that count up from 1 and times in seconds fit a JavaScript
 *   number and are stored as `bigint`.
 * - Our own clock is stored as epoch milliseconds, never as a database timestamp, so Postgres and
 *   the embedded PGlite agree on every byte a snapshot writes.
 */
import { sql, type SQL } from "drizzle-orm";
import { bigint, numeric as numericColumn, text } from "drizzle-orm/pg-core";

/** An amount in a token's smallest unit, or any other full uint256. */
export const wei = (name: string) => numericColumn(name, { precision: 78, scale: 0, mode: "bigint" });

/**
 * A bigint as a `numeric` parameter of a hand-written expression (`total = total + …`). It travels
 * as its decimal text with a cast, so no driver has to know what to do with a JavaScript bigint.
 */
export const numeric = (value: bigint): SQL => sql`${value.toString(10)}::numeric`;

/** A block number, a counter or a time in seconds: anything that stays far below 2^53. */
export const int53 = (name: string) => bigint(name, { mode: "number" });

/**
 * Where a row came from. A table with one row per log carries these four columns and uses
 * `(tx_hash, log_index)` as its key, which is what makes writing it twice harmless.
 */
export const logOrigin = () => ({
  txHash: text("tx_hash").notNull(),
  logIndex: int53("log_index").notNull(),
  blockNumber: int53("block_number").notNull(),
  blockTime: int53("block_time").notNull(),
});
