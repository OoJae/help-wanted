/**
 * The unofficial Robot Jobs Report: arithmetic over IMD `Transfer` logs whose recipient is the
 * swarm's fee address. Pure functions; the logs come from `data/chain.ts`.
 *
 * What the numbers are, exactly: every paid action on IdentityMD (a job, an oracle request, a
 * launch, a schedule top-up) moves IMD to one address. The total moved in a window is "payrolls",
 * the number of transfers is "payments", the distinct senders are "employers". It is a count of
 * money paid for swarm work, prepayments of schedules included; it is not a count of finished jobs.
 */
import type { Hex } from "viem";
import { MAINNET } from "@help-wanted/shared";
import { TOPIC } from "~/config/chain";
import type { RawLog } from "./jsonrpc";
import { utcDay } from "./format";

export interface Payment {
  txHash: Hex;
  logIndex: number;
  block: number;
  /** Block time in seconds. Null when the node gave none and none could be worked out. */
  timestamp: number | null;
  /** The sender, lowercase. */
  from: `0x${string}`;
  amountWei: bigint;
}

const IMD_ADDRESS = MAINNET.IMD.toLowerCase();
const PAYEE_TOPIC = `0x${"0".repeat(24)}${MAINNET.FEE_PAYEE.slice(2).toLowerCase()}`;

function quantity(value: unknown): number | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(value)) return null;
  const n = Number(BigInt(value));
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Decodes one payment: an IMD `Transfer(from, to, value)` log whose recipient is the swarm's fee
 * address. Returns null for anything else, including a log of another token, another event or
 * another recipient, and a log with a field missing. The node is asked for exactly these logs, but
 * a node's answer is checked, not trusted: a figure on the Jobs Report is money someone paid.
 */
export function decodePayment(log: RawLog): Payment | null {
  if (typeof log !== "object" || log === null || log.removed) return null;
  if (typeof log.address !== "string" || log.address.toLowerCase() !== IMD_ADDRESS) return null;
  if (!Array.isArray(log.topics) || log.topics.length !== 3) return null;
  const [signature, from, to] = log.topics as [unknown, unknown, unknown];
  if (typeof signature !== "string" || signature.toLowerCase() !== TOPIC.TRANSFER) return null;
  if (typeof to !== "string" || to.toLowerCase() !== PAYEE_TOPIC) return null;
  if (typeof from !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(from)) return null;
  if (typeof log.data !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(log.data)) return null;
  if (typeof log.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)) {
    return null;
  }
  const logIndex = quantity(log.logIndex);
  const block = quantity(log.blockNumber);
  if (logIndex === null || block === null) return null;
  return {
    txHash: log.transactionHash.toLowerCase() as Hex,
    logIndex,
    block,
    timestamp: log.blockTimestamp === undefined ? null : quantity(log.blockTimestamp),
    from: `0x${from.slice(26).toLowerCase()}`,
    amountWei: BigInt(log.data),
  };
}

export interface TallyWindow {
  fromBlock: number;
  toBlock: number;
  /** Seconds. Null when unknown. */
  fromTime: number | null;
  toTime: number | null;
}

export interface PayerRow {
  rank: number;
  address: `0x${string}`;
  totalWei: bigint;
  payments: number;
  /** Share of the window's total in basis points. */
  shareBps: number;
  house: boolean;
}

export interface DayRow {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  totalWei: bigint;
  payments: number;
  payers: number;
  /** True when the window covers only part of this UTC day. */
  partial: boolean;
}

export interface HourRow {
  /** Start of the hour, seconds. */
  start: number;
  totalWei: bigint;
  payments: number;
}

export interface SizeRow {
  amountWei: bigint;
  payments: number;
  totalWei: bigint;
}

export interface Tally {
  window: TallyWindow;
  totalWei: bigint;
  payments: number;
  payers: number;
  houseWei: bigint;
  housePayments: number;
  outsideWei: bigint;
  outsidePayments: number;
  largestWei: bigint;
  topPayers: PayerRow[];
  /** Newest day first. */
  days: DayRow[];
  /** The newest clock hours of the window (at most `HOURS_SHOWN`), oldest first. Empty when times are unknown. */
  hours: HourRow[];
  /** Payments grouped by exact amount, most frequent first. */
  sizes: SizeRow[];
  /** How many payments had no usable timestamp and so appear in no day or hour row. */
  untimed: number;
}

export interface TallyOptions {
  window: TallyWindow;
  /** Lowercase addresses the team controls. Their payments are counted, and counted separately. */
  house?: ReadonlySet<string>;
  topPayers?: number;
}

/** How many clock hours the hourly table holds: one more than a day's 24 plus the part hour at each end. */
export const HOURS_SHOWN = 26;

/** Drops duplicates (same transaction and log index) and sorts by block, then log index. */
export function uniquePayments(payments: Iterable<Payment>): Payment[] {
  const seen = new Map<string, Payment>();
  for (const p of payments) seen.set(`${p.txHash}:${p.logIndex}`, p);
  return [...seen.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

export function computeTally(input: Iterable<Payment>, options: TallyOptions): Tally {
  const { window } = options;
  const house = options.house ?? new Set<string>();
  const payments = uniquePayments(input).filter(
    (p) => p.block >= window.fromBlock && p.block <= window.toBlock,
  );

  let totalWei = 0n;
  let houseWei = 0n;
  let housePayments = 0;
  let largestWei = 0n;
  let untimed = 0;
  const byPayer = new Map<`0x${string}`, { totalWei: bigint; payments: number }>();
  const byDay = new Map<string, { totalWei: bigint; payments: number; payers: Set<string> }>();
  const byHour = new Map<number, { totalWei: bigint; payments: number }>();
  const bySize = new Map<bigint, number>();

  for (const p of payments) {
    totalWei += p.amountWei;
    if (p.amountWei > largestWei) largestWei = p.amountWei;
    if (house.has(p.from)) {
      houseWei += p.amountWei;
      housePayments++;
    }
    const payer = byPayer.get(p.from) ?? { totalWei: 0n, payments: 0 };
    payer.totalWei += p.amountWei;
    payer.payments++;
    byPayer.set(p.from, payer);
    bySize.set(p.amountWei, (bySize.get(p.amountWei) ?? 0) + 1);

    if (p.timestamp === null) {
      untimed++;
      continue;
    }
    const day = utcDay(p.timestamp * 1000);
    const dayRow = byDay.get(day) ?? { totalWei: 0n, payments: 0, payers: new Set<string>() };
    dayRow.totalWei += p.amountWei;
    dayRow.payments++;
    dayRow.payers.add(p.from);
    byDay.set(day, dayRow);
    const hour = Math.floor(p.timestamp / 3600) * 3600;
    const hourRow = byHour.get(hour) ?? { totalWei: 0n, payments: 0 };
    hourRow.totalWei += p.amountWei;
    hourRow.payments++;
    byHour.set(hour, hourRow);
  }

  const topPayers: PayerRow[] = [...byPayer.entries()]
    .sort((a, b) =>
      a[1].totalWei === b[1].totalWei ? a[0].localeCompare(b[0]) : a[1].totalWei > b[1].totalWei ? -1 : 1,
    )
    .slice(0, options.topPayers ?? 10)
    .map(([address, row], index) => ({
      rank: index + 1,
      address,
      totalWei: row.totalWei,
      payments: row.payments,
      shareBps: totalWei === 0n ? 0 : Number((row.totalWei * 10_000n) / totalWei),
      house: house.has(address),
    }));

  // A day is whole only when the window starts at or before its first second and ends at or after
  // its last one. Days are also listed when nothing was paid in them, so a quiet day reads as zero.
  const days: DayRow[] = [];
  if (window.fromTime !== null && window.toTime !== null && window.toTime >= window.fromTime) {
    const firstDayStart = Math.floor(window.fromTime / 86_400) * 86_400;
    for (let start = Math.floor(window.toTime / 86_400) * 86_400; start >= firstDayStart; start -= 86_400) {
      const day = utcDay(start * 1000);
      const row = byDay.get(day);
      days.push({
        day,
        totalWei: row?.totalWei ?? 0n,
        payments: row?.payments ?? 0,
        payers: row?.payers.size ?? 0,
        partial: window.fromTime > start || window.toTime < start + 86_399,
      });
    }
  } else {
    for (const [day, row] of [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
      days.push({
        day,
        totalWei: row.totalWei,
        payments: row.payments,
        payers: row.payers.size,
        partial: true,
      });
    }
  }

  const hours: HourRow[] = [];
  if (window.toTime !== null) {
    // A window of just over a day touches 25 clock hours, and the oldest of them may hold the most.
    const lastHour = Math.floor(window.toTime / 3600) * 3600;
    const oldestShown = lastHour - (HOURS_SHOWN - 1) * 3600;
    const earliest = window.fromTime === null ? oldestShown : Math.floor(window.fromTime / 3600) * 3600;
    for (let start = Math.max(earliest, oldestShown); start <= lastHour; start += 3600) {
      const row = byHour.get(start);
      hours.push({ start, totalWei: row?.totalWei ?? 0n, payments: row?.payments ?? 0 });
    }
  }

  const sizes: SizeRow[] = [...bySize.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([amountWei, count]) => ({ amountWei, payments: count, totalWei: amountWei * BigInt(count) }));

  return {
    window,
    totalWei,
    payments: payments.length,
    payers: byPayer.size,
    houseWei,
    housePayments,
    outsideWei: totalWei - houseWei,
    outsidePayments: payments.length - housePayments,
    largestWei,
    topPayers,
    days,
    hours,
    sizes,
    untimed,
  };
}
