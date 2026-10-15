/**
 * The keeper's state file: a small JSON document that survives a restart.
 *
 * It holds three things, none of them secret and none of them needed for correctness of what is on
 * chain (every rule reads the chain afresh on every pass):
 *
 * - `pendingTx`: a transaction that was sent and not yet seen mined, so a restart does not send a
 *   second one behind it;
 * - `spend`: what was spent on gas per UTC day, so the daily cap holds across restarts;
 * - `rounds`: for rounds the keeper has seen, the transaction that opened them and the oracle
 *   request behind them, so they need not be looked up again.
 *
 * Losing the file loses the day's spending figure (the cap starts again from zero) and nothing
 * else. It is written whole, to a temporary file that is then renamed, with mode 600.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Hex } from "viem";
import type { PendingTx, SpendLimit } from "./chain.js";

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export interface RoundNote {
  /** The transaction that made the round's request (it holds the Intake's `Requested` event). */
  requestTx?: Hex;
  /** The oracle request the Intake opened for it: the UUID IdentityMD's API names it by. */
  oracleRequestId?: string;
  /** Why the oracle ended without an answer, once read from its record of the request. */
  failure?: string;
  /** When this note was last touched, unix seconds: old notes are dropped. */
  at: number;
}

/** What the keeper remembers of one delivery claim it looked at, by `<orderId>:<claimSeq>`. */
export interface ClaimNote {
  order: string;
  seq: number;
  runner: string;
  jobId: string | null;
  namedHash: string;
  assertedAt: number;
  /** When the claim was first and last looked at, in the chain's seconds. */
  firstSeenAt: number;
  lastSeenAt: number;
  verdict: "true" | "untrue" | "unknown";
  reasons: string[];
  /** When the claim was first seen to fail the check; cleared when it passes again. */
  failingSince?: number;
  /** What the keeper decided to do about it on its newest look, and why. */
  action: string;
  why: string;
  /** The last thing this keeper sent for it (challenge, finalize, settle, reportFailed, timeout). */
  did?: string;
  /** The transaction of that. */
  tx?: string;
}

export interface KeeperState {
  v: 1;
  pendingTx?: PendingTx;
  /** Wei spent on gas, or set aside for a transaction in flight, by UTC day (`2026-10-13`). */
  spend: Record<string, string>;
  /** Notes by `<feedId>:<round>`. */
  rounds: Record<string, RoundNote>;
  /** IMD-wei posted as challenge bonds, by UTC day. The daily cap on challenges is held against it. */
  challenges?: Record<string, string>;
  /** Every delivery claim the keeper looked at, the newest few hundred. */
  claims?: Record<string, ClaimNote>;
  /**
   * Things that can no longer change and need not be read again, by module: desk orders that are
   * cancelled, refunded or proven; pots that paid everybody; rule orders that are reconciled.
   */
  done?: Record<string, string[]>;
  /**
   * Text the contracts publish once, in an event, and keep only the hash of: a pot's spec by its
   * hash, a rule's job text by its id. Hex, as the event carried it.
   */
  texts?: Record<string, string>;
  /** Who chipped into a pot that is past collecting, by pot id. */
  chips?: Record<string, string[]>;
  /** Where each module's log reading has got to, by module, and the rule orders found so far. */
  cursors?: Record<string, string>;
  /** Desk orders opened by a rule: order id to rule id. */
  ruleOrders?: Record<string, string>;
}

export interface Store {
  readonly data: KeeperState;
  /** Writes the state. Throws `StoreError` when it cannot. */
  save(): void;
}

const KEEP_SPEND_DAYS = 14;
const KEEP_ROUNDS = 200;
const KEEP_CLAIMS = 300;
const KEEP_TEXTS = 200;

export function emptyState(): KeeperState {
  return { v: 1, spend: {}, rounds: {} };
}

/** A store that lives in the process only: tests, and a dry run whose file cannot be written. */
export function memoryStore(initial: KeeperState = emptyState()): Store & { saves: number } {
  const store = {
    data: initial,
    saves: 0,
    save() {
      store.saves += 1;
    },
  };
  return store;
}

function isState(value: unknown): value is KeeperState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<KeeperState>;
  return v.v === 1 && typeof v.spend === "object" && v.spend !== null && typeof v.rounds === "object";
}

/** Opens the state file, or starts an empty state when there is none. A damaged file is an error. */
export function openFileStore(path: string): Store {
  let data = emptyState();
  let text: string | null = null;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new StoreError(`${path} cannot be read: ${(error as Error).message}`);
    }
  }
  if (text !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StoreError(
        `${path} is not JSON. It holds today's spending and any transaction still in flight: look at it before moving it aside`,
      );
    }
    if (!isState(parsed)) throw new StoreError(`${path} is not a keeper state file`);
    data = parsed;
  }
  return {
    data,
    save() {
      prune(data);
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
        renameSync(tmp, path);
      } catch (error) {
        throw new StoreError(`${path} cannot be written: ${(error as Error).message}`);
      }
    },
  };
}

/** Drops spending figures older than two weeks and all but the newest round notes. */
export function prune(state: KeeperState): void {
  const days = Object.keys(state.spend).sort();
  for (const day of days.slice(0, Math.max(0, days.length - KEEP_SPEND_DAYS))) delete state.spend[day];
  const notes = Object.entries(state.rounds).sort((a, b) => a[1].at - b[1].at);
  for (const [key] of notes.slice(0, Math.max(0, notes.length - KEEP_ROUNDS))) delete state.rounds[key];
  if (state.challenges) {
    const challengeDays = Object.keys(state.challenges).sort();
    for (const day of challengeDays.slice(0, Math.max(0, challengeDays.length - KEEP_SPEND_DAYS))) {
      delete state.challenges[day];
    }
  }
  if (state.claims) {
    const claims = Object.entries(state.claims).sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
    for (const [key] of claims.slice(0, Math.max(0, claims.length - KEEP_CLAIMS))) delete state.claims[key];
  }
  if (state.texts) {
    // The oldest go first: a text that is needed again is read from its event again.
    const texts = Object.keys(state.texts);
    for (const key of texts.slice(0, Math.max(0, texts.length - KEEP_TEXTS))) delete state.texts[key];
  }
}

/** IMD-wei posted as challenge bonds on a UTC day. */
export function challengedOn(state: KeeperState, day: string): bigint {
  const text = state.challenges?.[day];
  return text === undefined ? 0n : BigInt(text);
}

/** Books a challenge bond against its day. */
export function noteChallenge(state: KeeperState, day: string, bond: bigint): void {
  state.challenges = { ...(state.challenges ?? {}), [day]: (challengedOn(state, day) + bond).toString() };
}

/** Whether a module has marked a thing as never needing another look. */
export function isDone(state: KeeperState, module: string, id: bigint | string): boolean {
  return state.done?.[module]?.includes(id.toString()) ?? false;
}

/** Marks a thing as never needing another look. Returns true when that is new. */
export function markDone(state: KeeperState, module: string, id: bigint | string): boolean {
  const list = state.done?.[module] ?? [];
  if (list.includes(id.toString())) return false;
  state.done = { ...(state.done ?? {}), [module]: [...list, id.toString()] };
  return true;
}

export function claimKey(order: bigint | string, seq: number): string {
  return `${order.toString()}:${seq}`;
}

/** The UTC day a unix time falls in, as `YYYY-MM-DD`. */
export function utcDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function spentOn(state: KeeperState, day: string): bigint {
  const text = state.spend[day];
  return text === undefined ? 0n : BigInt(text);
}

/**
 * The day's spending as the chain writer sees it. `now` is the wall clock: the cap is an
 * operator's budget per calendar day, not a rule of the chain.
 */
export function spendLimit(store: Store, cap: bigint, now: () => number): SpendLimit {
  return {
    cap,
    spentToday: () => spentOn(store.data, utcDay(now())),
    add(wei: bigint) {
      const day = utcDay(now());
      const next = spentOn(store.data, day) + wei;
      // A reservation made before midnight and given back after it must not leave a negative day.
      store.data.spend[day] = (next > 0n ? next : 0n).toString();
      store.save();
    },
  };
}

export function roundKey(feedId: Hex, round: bigint): string {
  return `${feedId.toLowerCase()}:${round.toString()}`;
}

export function roundNote(state: KeeperState, feedId: Hex, round: bigint): RoundNote | undefined {
  return state.rounds[roundKey(feedId, round)];
}

/** Adds what was learned about a round to its note. Returns true when the note changed. */
export function noteRound(
  state: KeeperState,
  feedId: Hex,
  round: bigint,
  learned: {
    requestTx?: Hex | undefined;
    oracleRequestId?: string | undefined;
    failure?: string | undefined;
  },
  now: number,
): boolean {
  const key = roundKey(feedId, round);
  const note = state.rounds[key] ?? { at: now };
  let changed = state.rounds[key] === undefined;
  if (learned.requestTx !== undefined && note.requestTx !== learned.requestTx) {
    note.requestTx = learned.requestTx;
    changed = true;
  }
  if (learned.oracleRequestId !== undefined && note.oracleRequestId !== learned.oracleRequestId) {
    note.oracleRequestId = learned.oracleRequestId;
    changed = true;
  }
  if (learned.failure !== undefined && note.failure !== learned.failure) {
    note.failure = learned.failure;
    changed = true;
  }
  if (changed) {
    note.at = now;
    state.rounds[key] = note;
  }
  return changed;
}
