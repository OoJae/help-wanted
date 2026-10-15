/**
 * The arithmetic of the Robot Jobs Report's unofficial tally.
 *
 * Input: IMD transfers to the fee payee. Output: per UTC day, or per block window, how much IMD
 * was paid (the "payrolls" number), in how many payments (the "hires" number) and by how many
 * distinct payers (the "employers" number), each also split into HOUSE (wallets and contracts the
 * team controls) and OUTSIDE (everyone else).
 *
 * Counting rule. A payment is a Transfer log to the fee payee, whatever its value, and a payer is
 * the sender of one. That is how the official hires feed counts: its recipe counts logs and has
 * no way to leave out a transfer of zero. So this tally counts them too, and the two numbers can
 * be put side by side. The cost is that anyone can add a "payment" for the price of gas; how many
 * of the logs carried no IMD is published beside every count (`zeroValueLogs`) for that reason.
 *
 * Everything here is a pure function over rows, in bigint wei: no database, no clock, no floats.
 * The official numbers are bought from the oracle by the JobsReport contract; these are the same
 * sums counted by us from the same logs, shown beside them and for the day not yet printed.
 */

export interface TransferRow {
  /** Lowercase address of the payer. */
  from: string;
  /** IMD in wei. */
  value: bigint;
  blockNumber: number;
  /** Seconds. */
  blockTime: number;
}

export interface Split {
  /** IMD in wei. */
  amount: bigint;
  payments: number;
  payers: number;
}

export interface Tally extends Split {
  house: Split;
  outside: Split;
  /**
   * How many of the `payments` above moved no IMD. They are counted as payments, and their
   * senders as payers, because the official hires feed counts every log; this number lets a
   * reader take them out again.
   */
  zeroValueLogs: number;
}

export interface DayTally extends Tally {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  /** The first and last block of the day that hold a transfer to the payee; null on a day with none. */
  firstBlock: number | null;
  lastBlock: number | null;
  /**
   * False when the indexed range does not span the whole day, so the numbers are a lower bound:
   * the day the look-back starts in, and today.
   */
  complete: boolean;
}

export interface PayerTally {
  payer: string;
  amount: bigint;
  payments: number;
  house: boolean;
}

/** What part of history the rows were taken from, to tell whole days from partial ones. */
export interface Coverage {
  /** Timestamp of the first block indexed; null when unknown. */
  fromTime: number | null;
  /** Timestamp of the last block indexed; null when unknown. */
  toTime: number | null;
}

export const SECONDS_PER_DAY = 86_400;

/** The most days `tallyByDay` lists for a coverage: a hundred years. */
const MAX_LISTED_DAYS = 36_525;

/** The first second of the year 10000: past it a day no longer has a `YYYY-MM-DD` name. */
const END_OF_CALENDAR = 253_402_300_800;

/** Whether a coverage bound is a time whose days can be listed by name. */
function listable(time: number | null): time is number {
  return time !== null && Number.isFinite(time) && time >= 0 && time < END_OF_CALENDAR;
}

/** The UTC calendar day a block timestamp falls in, as `YYYY-MM-DD`. */
export function utcDay(blockTime: number): string {
  return new Date(blockTime * 1000).toISOString().slice(0, 10);
}

/** The first second of a `YYYY-MM-DD` UTC day. */
export function dayStart(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new TypeError(`not a day: ${day}`);
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(ms) || utcDay(ms / 1000) !== day) throw new TypeError(`not a day: ${day}`);
  return ms / 1000;
}

class Bucket {
  amount = 0n;
  payments = 0;
  readonly payers = new Set<string>();

  add(row: TransferRow): void {
    this.amount += row.value;
    this.payments += 1;
    this.payers.add(row.from);
  }

  split(): Split {
    return { amount: this.amount, payments: this.payments, payers: this.payers.size };
  }
}

class Buckets {
  readonly all = new Bucket();
  readonly house = new Bucket();
  readonly outside = new Bucket();
  zeroValueLogs = 0;

  add(row: TransferRow, house: ReadonlySet<string>): void {
    if (row.value <= 0n) this.zeroValueLogs += 1;
    this.all.add(row);
    (house.has(row.from) ? this.house : this.outside).add(row);
  }

  tally(): Tally {
    return {
      ...this.all.split(),
      house: this.house.split(),
      outside: this.outside.split(),
      zeroValueLogs: this.zeroValueLogs,
    };
  }
}

/** One tally over all the rows given: for a block window, pass the rows of that window. */
export function tallyAll(rows: Iterable<TransferRow>, house: ReadonlySet<string>): Tally {
  const buckets = new Buckets();
  for (const row of rows) buckets.add(row, house);
  return buckets.tally();
}

/**
 * One tally per UTC day, oldest first. A payer who pays on two days is one payer on each;
 * `house.payers + outside.payers` always equals `payers`, because an address is either on the
 * house list or it is not.
 *
 * When the coverage is known, every day it touches is listed, a day without a single payment
 * included: zeros, with its `complete` flag. So a reader can tell "nobody paid that day" (a row of
 * zeros marked complete) from "that day was not indexed" (no row, or a row marked incomplete).
 * When it is not known, only the days that hold a row are listed and none is called complete.
 */
export function tallyByDay(
  rows: Iterable<TransferRow>,
  house: ReadonlySet<string>,
  coverage: Coverage = { fromTime: null, toTime: null },
): DayTally[] {
  const days = new Map<string, { buckets: Buckets; firstBlock: number | null; lastBlock: number | null }>();
  for (const row of rows) {
    const day = utcDay(row.blockTime);
    let entry = days.get(day);
    if (!entry) {
      entry = { buckets: new Buckets(), firstBlock: row.blockNumber, lastBlock: row.blockNumber };
      days.set(day, entry);
    }
    entry.buckets.add(row, house);
    entry.firstBlock = Math.min(entry.firstBlock ?? row.blockNumber, row.blockNumber);
    entry.lastBlock = Math.max(entry.lastBlock ?? row.blockNumber, row.blockNumber);
  }

  if (listable(coverage.fromTime) && listable(coverage.toTime)) {
    const first = Math.floor(coverage.fromTime / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const last = Math.floor(coverage.toTime / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    // A coverage longer than this is not one this chain can have; listing its days would be a
    // loop of no use to anyone.
    if ((last - first) / SECONDS_PER_DAY <= MAX_LISTED_DAYS) {
      for (let start = first; start <= last; start += SECONDS_PER_DAY) {
        const day = utcDay(start);
        if (!days.has(day)) days.set(day, { buckets: new Buckets(), firstBlock: null, lastBlock: null });
      }
    }
  }

  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, entry]) => {
      const start = dayStart(day);
      const complete =
        coverage.fromTime !== null &&
        coverage.toTime !== null &&
        coverage.fromTime <= start &&
        coverage.toTime >= start + SECONDS_PER_DAY;
      return {
        day,
        ...entry.buckets.tally(),
        firstBlock: entry.firstBlock,
        lastBlock: entry.lastBlock,
        complete,
      };
    });
}

/**
 * Payers ranked by IMD paid, largest first; ties go to the lower address so the order never
 * depends on the order of the input. A sender of zero-value transfers only is a payer like any
 * other (see the counting rule above) and ranks last, with an amount of zero.
 */
export function rankPayers(
  rows: Iterable<TransferRow>,
  house: ReadonlySet<string>,
  limit = 10,
): PayerTally[] {
  const byPayer = new Map<string, { amount: bigint; payments: number }>();
  for (const row of rows) {
    const entry = byPayer.get(row.from) ?? { amount: 0n, payments: 0 };
    entry.amount += row.value;
    entry.payments += 1;
    byPayer.set(row.from, entry);
  }
  return [...byPayer.entries()]
    .map(([payer, entry]) => ({ payer, ...entry, house: house.has(payer) }))
    .sort((a, b) => (a.amount === b.amount ? (a.payer < b.payer ? -1 : 1) : a.amount > b.amount ? -1 : 1))
    .slice(0, Math.max(0, limit));
}

/** Wei as an exact decimal IMD figure: `118500000000000000000n` → `"118.5"`. Never a float. */
export function formatImd(wei: bigint): string {
  const negative = wei < 0n;
  const digits = (negative ? -wei : wei).toString(10).padStart(19, "0");
  const whole = digits.slice(0, -18);
  const fraction = digits.slice(-18).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
