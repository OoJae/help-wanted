/**
 * What a module is: one contract's events, as an ABI, a handler and the tables the handler writes.
 *
 * To index a new contract, add one file under `src/modules` that exports a `ContractModule`, list
 * it in `src/modules/index.ts`, export its tables from `src/db/schema.ts` and run
 * `pnpm db:generate`. The engine does the rest: it reads the logs with a cursor, stores each one
 * once in `events`, calls the handler, and after a reorganisation or a backfill rebuilds the
 * module's tables by running the handler over the stored events again.
 *
 * That last point is the one rule a handler must obey: its tables are a pure function of the
 * module's events inside its coverage (`cursors.start_block` up to `next_block`), taken in chain
 * order. No network, no clock, nothing read from another module's tables. Then "delete the tables
 * and replay" always gives the right answer.
 */
import type { PgTable } from "drizzle-orm/pg-core";
import type { Abi, Address, Hex } from "viem";
import type { Db } from "../db/client.js";
import type { Deployments } from "../deployments.js";
import type { JsonValue } from "../json.js";

/** One position of an `eth_getLogs` topic filter: a value, any of several values, or anything. */
export type LogTopic = Hex | Hex[] | null;

export interface LogFilter {
  /**
   * The contract whose logs are read, or several contracts that emit the same events (the two
   * versions of the Intake). Each stored event keeps the address that logged it.
   */
  address: Address | readonly Address[];
  /** Left out, every log of the address is taken, including ones the ABI does not know. */
  topics?: LogTopic[];
}

/** The addresses a filter names, lowercased. */
export function filterAddresses(filter: LogFilter): Address[] {
  const list = typeof filter.address === "string" ? [filter.address] : [...filter.address];
  return list.map((address) => address.toLowerCase() as Address);
}

/** A stored log as a handler sees it. */
export interface IndexedEvent {
  module: string;
  txHash: Hex;
  logIndex: number;
  txIndex: number;
  blockNumber: number;
  blockHash: Hex;
  /** The block's timestamp, in seconds. */
  blockTime: number;
  /** Lowercase. */
  address: Address;
  /** The event's name under the module's ABI, or topic0 when the ABI does not know the log. */
  event: string;
  /**
   * Named arguments as JSON, or null when the log was not decoded. Integers wider than 48 bits
   * are decimal strings (JSON cannot hold a uint256); narrower ones are plain numbers.
   */
  args: JsonValue;
  topics: Hex[];
  data: Hex;
}

export interface ContractModule {
  /** Lowercase snake case. It is the cursor's key and the `START_BLOCK_<NAME>` suffix. */
  name: string;
  /** One line for logs and the status page. */
  title: string;
  /** The events to decode. Functions and errors may be present; they are ignored. */
  abi: Abi;
  /**
   * What to ask the node for, or null while the contract has no address yet (our own contracts
   * before their launch). A module without a filter is skipped and costs nothing.
   */
  filter(deployments: Deployments): LogFilter | null;
  /**
   * True while the handler is a placeholder: logs are stored but the tables stay empty. Shown on
   * the status page, on every route and in every snapshot file that reads such a table, so an
   * empty table is never mistaken for "nothing happened".
   */
  stub?: boolean;
  /**
   * True for a contract whose tables are folded from its first event on (an order exists only
   * because `OrderOpened` was seen). Such a module must begin at the block the contract was
   * deployed in, so the engine refuses to start it from the default look-back: it wants an
   * explicit start block (`START_BLOCK_<NAME>`, or the block given with the address).
   */
  needsStartBlock?: boolean;
  /** Every table the handler writes. They are emptied before a replay. */
  tables: PgTable[];
  /**
   * Folds one event into the module's tables. The engine calls it exactly once per stored event
   * between two rebuilds, in chain order, inside the transaction that stores the event. It must
   * not look outside the event and the module's own tables. Rows that map one-to-one onto a log
   * are still written by upsert on `(tx_hash, log_index)`, so they are safe on their own too.
   *
   * It runs inside a savepoint. If it throws, whatever it wrote for this event is undone, the
   * reason is written on the event (`events.fold_error`) and the module carries on with the next
   * log: one log that cannot be folded must not stop a module for ever. Such events are counted
   * as `unfolded` wherever coverage is reported, and a rebuild tries them again.
   */
  apply(db: Db, event: IndexedEvent): Promise<void>;
}
