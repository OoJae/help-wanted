/**
 * The event store: decoding a log under a module's ABI, writing it once, and rebuilding a module's
 * tables from what is stored.
 */
import { and, asc, eq, gt, gte, lte, or } from "drizzle-orm";
import type { Hex } from "viem";
import { decodeLogUnder } from "@help-wanted/shared";
import type { ChainLog } from "../chain/logs.js";
import type { Db } from "../db/client.js";
import { cursors, events, type EventRow } from "../db/core.js";
import { sameJson, storableJson, type JsonValue } from "../json.js";
import { errorMessage } from "../log.js";
import type { ContractModule, IndexedEvent } from "./module.js";

/**
 * Names a log under the module's ABI. A log the ABI does not know (another event of the same
 * contract, or any event while the module has no ABI yet) is not an error: it is stored with
 * topic0 as its name and no arguments, and decoded later by a replay.
 *
 * The decoding itself is `decodeLogUnder` of the shared package, which the evidence builder at the
 * repository root uses too; here its arguments are turned into JSON a `jsonb` column will take.
 */
export function decodeUnder(
  module: ContractModule,
  topics: readonly string[],
  data: string,
): { event: string; args: JsonValue } {
  const fallback = { event: topics[0] ?? "anonymous", args: null };
  const named = decodeLogUnder(module.abi, topics, data);
  if (named === null) return fallback;
  try {
    return { event: named.event, args: storableJson(named.args) };
  } catch {
    return fallback;
  }
}

export function toIndexedEvent(module: ContractModule, log: ChainLog, blockTime: number): IndexedEvent {
  const { event, args } = decodeUnder(module, log.topics, log.data);
  return {
    module: module.name,
    txHash: log.txHash,
    logIndex: log.logIndex,
    txIndex: log.txIndex,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    blockTime,
    address: log.address,
    event,
    args,
    topics: log.topics,
    data: log.data,
  };
}

function fromRow(row: EventRow): IndexedEvent {
  return {
    module: row.module,
    txHash: row.txHash as Hex,
    logIndex: row.logIndex,
    txIndex: row.txIndex,
    blockNumber: row.blockNumber,
    blockHash: row.blockHash as Hex,
    blockTime: row.blockTime,
    address: row.address as Hex,
    event: row.event,
    args: row.args ?? null,
    topics: row.topics as Hex[],
    data: row.data as Hex,
  };
}

/** A stored log turned up again in a block with another hash, below the blocks that are re-read. */
export class StoredBlockChangedError extends Error {
  /** Hashes and block numbers only, each checked for its shape when the log was read. */
  readonly publicMessage: string;

  constructor(event: IndexedEvent, storedBlock: number) {
    super(
      `log ${event.txHash}:${event.logIndex} is stored in block ${storedBlock} with another block hash than the ` +
        `node now reports for block ${event.blockNumber}. That is a reorganisation deeper than REORG_DEPTH, or a ` +
        `node on another chain. Check RPC_URL, then run "rewind --to <a block below both>".`,
    );
    this.name = "StoredBlockChangedError";
    this.publicMessage = this.message;
  }
}

/**
 * Stores one event unless it is already stored. The key is the log itself, so reading a range
 * twice writes nothing the second time.
 *
 * @returns true when the event is new. The caller folds only new events into the module's
 * tables, which is what lets a handler add to a running total without counting anything twice.
 */
export async function insertEvent(db: Db, event: IndexedEvent): Promise<boolean> {
  const inserted = await db
    .insert(events)
    .values(event)
    .onConflictDoNothing({ target: [events.module, events.txHash, events.logIndex] })
    .returning({ logIndex: events.logIndex });
  if (inserted.length > 0) return true;

  const [stored] = await db
    .select({ blockNumber: events.blockNumber, blockHash: events.blockHash })
    .from(events)
    .where(
      and(
        eq(events.module, event.module),
        eq(events.txHash, event.txHash),
        eq(events.logIndex, event.logIndex),
      ),
    );
  if (stored && (stored.blockHash !== event.blockHash || stored.blockNumber !== event.blockNumber)) {
    throw new StoredBlockChangedError(event, stored.blockNumber);
  }
  return false;
}

/** What identifies a stored log and the block it was in, for comparing with the chain again. */
export interface LogIdentity {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
}

export async function storedIdentities(
  db: Db,
  module: string,
  fromBlock: number,
  toBlock: number,
): Promise<LogIdentity[]> {
  return db
    .select({
      txHash: events.txHash,
      logIndex: events.logIndex,
      blockNumber: events.blockNumber,
      blockHash: events.blockHash,
    })
    .from(events)
    .where(
      and(eq(events.module, module), gte(events.blockNumber, fromBlock), lte(events.blockNumber, toBlock)),
    );
}

/**
 * Compares what is stored for a block range with what the chain says now. Returns the lowest
 * block at which they differ, or null when they agree.
 *
 * They differ when a stored log is gone, sits in a block with another hash, or when the chain has
 * a log in the range that was never stored. Each of those means the blocks from that point up are
 * no longer the ones that were indexed.
 */
export function firstMismatch(stored: LogIdentity[], fresh: LogIdentity[]): number | null {
  const key = (log: LogIdentity) => `${log.txHash}:${log.logIndex}`;
  const freshByKey = new Map(fresh.map((log) => [key(log), log]));
  const storedKeys = new Set(stored.map(key));
  let lowest: number | null = null;
  const note = (block: number) => {
    if (lowest === null || block < lowest) lowest = block;
  };
  for (const log of stored) {
    const now = freshByKey.get(key(log));
    if (!now) note(log.blockNumber);
    else if (now.blockHash !== log.blockHash || now.blockNumber !== log.blockNumber) {
      note(Math.min(log.blockNumber, now.blockNumber));
    }
  }
  for (const log of fresh) {
    if (!storedKeys.has(key(log))) note(log.blockNumber);
  }
  return lowest;
}

function keyOf(event: { module: string; txHash: string; logIndex: number }) {
  return and(
    eq(events.module, event.module),
    eq(events.txHash, event.txHash),
    eq(events.logIndex, event.logIndex),
  );
}

/**
 * Folds one stored event into the module's tables, inside a savepoint.
 *
 * A handler that throws (arguments it does not expect, a value the database refuses, anything)
 * must not stop the module: every later log would go unread for as long as that one log exists.
 * So the savepoint is rolled back, which leaves the tables exactly as they were before this
 * event, and the reason is written on the event instead. If the database itself has gone away,
 * writing the reason fails too and the whole range is tried again on the next pass.
 *
 * @param hadError Whether the event carries a reason from an earlier try, to be cleared on success.
 * @returns null when the event was folded, otherwise the reason it was not.
 */
export async function foldEvent(
  db: Db,
  module: ContractModule,
  event: IndexedEvent,
  hadError = false,
): Promise<string | null> {
  try {
    await db.transaction((inner) => module.apply(inner, event));
  } catch (error) {
    const reason = errorMessage(error);
    await db.update(events).set({ foldError: reason }).where(keyOf(event));
    return reason;
  }
  if (hadError) await db.update(events).set({ foldError: null }).where(keyOf(event));
  return null;
}

const REPLAY_PAGE = 500;

export interface ReplayResult {
  /** Events folded into the tables. */
  folded: number;
  /** Events inside the coverage that the handler could not fold. */
  unfolded: number;
}

/**
 * Empties a module's tables and folds the module's stored events through its handler again, in
 * chain order. Only events inside the module's coverage are folded: `[start_block, next_block)`
 * of its cursor, and no further than `through` when that is given. Logs stored outside it (by a
 * backfill that has not finished, or left behind by `skip`) are kept and count for nothing, so
 * what a table holds never depends on when it was last rebuilt.
 *
 * Every stored event is decoded afresh first, so a module whose ABI or handler changed catches up
 * on everything it stored before. Call inside a transaction.
 */
export async function replayModule(
  db: Db,
  module: ContractModule,
  options: { through?: number } = {},
): Promise<ReplayResult> {
  const [cursor] = await db.select().from(cursors).where(eq(cursors.module, module.name));
  const covered = (block: number) =>
    cursor !== undefined &&
    block >= cursor.startBlock &&
    block < cursor.nextBlock &&
    (options.through === undefined || block <= options.through);

  for (const table of module.tables) await db.delete(table);

  const result: ReplayResult = { folded: 0, unfolded: 0 };
  let after: { blockNumber: number; logIndex: number } | null = null;
  for (;;) {
    const page: EventRow[] = await db
      .select()
      .from(events)
      .where(
        after === null
          ? eq(events.module, module.name)
          : and(
              eq(events.module, module.name),
              or(
                gt(events.blockNumber, after.blockNumber),
                and(eq(events.blockNumber, after.blockNumber), gt(events.logIndex, after.logIndex)),
              ),
            ),
      )
      .orderBy(asc(events.blockNumber), asc(events.logIndex))
      .limit(REPLAY_PAGE);
    if (page.length === 0) break;

    for (const row of page) {
      const decoded = decodeUnder(module, row.topics, row.data);
      // Postgres stores jsonb keys in its own order, so the comparison must not depend on it.
      const changed = decoded.event !== row.event || !sameJson(decoded.args, row.args ?? null);
      if (changed) {
        await db.update(events).set({ event: decoded.event, args: decoded.args }).where(keyOf(row));
      }
      if (!covered(row.blockNumber)) continue;
      const reason = await foldEvent(
        db,
        module,
        { ...fromRow(row), event: decoded.event, args: decoded.args },
        row.foldError !== null,
      );
      if (reason === null) result.folded++;
      else result.unfolded++;
    }
    const last = page[page.length - 1] as EventRow;
    after = { blockNumber: last.blockNumber, logIndex: last.logIndex };
  }
  return result;
}
