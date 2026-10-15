/**
 * The Jobs Report arithmetic: first on rows small enough to check by hand, then on the 94 real
 * transfers of the recorded day, against totals that were computed separately from the raw logs.
 */
import { describe, expect, it } from "vitest";
import {
  dayStart,
  formatImd,
  rankPayers,
  tallyAll,
  tallyByDay,
  utcDay,
  type TransferRow,
} from "../src/report/tally.js";
import { loadLogFixture } from "./helpers/fakeNode.js";

const IMD = 1_000_000_000_000_000_000n;
const HALF = IMD / 2n;

const ALICE = "0x00000000000000000000000000000000000a11ce";
const BOB = "0x0000000000000000000000000000000000000b0b";
const CAROL = "0x00000000000000000000000000000000000ca401";
const HOUSE_WALLET = "0x871e507b6a70f858ad4b414bddb77473630c366b";

/** 2026-10-09T00:00:00Z. */
const DAY_ONE = 1_791_504_000;
const DAY_TWO = DAY_ONE + 86_400;

function row(
  from: string,
  value: bigint,
  blockTime: number,
  blockNumber = Math.floor(blockTime / 12),
): TransferRow {
  return { from, value, blockTime, blockNumber };
}

describe("days", () => {
  it("names the UTC day of a timestamp, to the second", () => {
    expect(utcDay(DAY_ONE)).toBe("2026-10-09");
    expect(utcDay(DAY_ONE - 1)).toBe("2026-10-08");
    expect(utcDay(DAY_TWO - 1)).toBe("2026-10-09");
    expect(utcDay(DAY_TWO)).toBe("2026-10-10");
    expect(utcDay(0)).toBe("1970-01-01");
  });

  it("finds the first second of a day and refuses what is not a day", () => {
    expect(dayStart("2026-10-09")).toBe(DAY_ONE);
    expect(dayStart("2028-02-29")).toBe(Date.UTC(2028, 1, 29) / 1000);
    expect(() => dayStart("2026-02-30")).toThrow(/not a day/);
    expect(() => dayStart("2026-10-9")).toThrow(/not a day/);
    expect(() => dayStart("tomorrow")).toThrow(/not a day/);
  });
});

describe("tallyAll", () => {
  it("is all zeros for no rows", () => {
    const zero = { amount: 0n, payments: 0, payers: 0 };
    expect(tallyAll([], new Set())).toEqual({ ...zero, house: zero, outside: zero, zeroValueLogs: 0 });
  });

  it("sums wei exactly, counts payments, and counts each payer once", () => {
    const rows = [
      row(ALICE, HALF, DAY_ONE + 10),
      row(ALICE, HALF, DAY_ONE + 20),
      row(BOB, 2n * IMD, DAY_ONE + 30),
      row(CAROL, 1n, DAY_ONE + 40),
    ];
    const tally = tallyAll(rows, new Set());
    expect(tally.amount).toBe(3n * IMD + 1n);
    expect(tally.payments).toBe(4);
    expect(tally.payers).toBe(3);
    expect(tally.outside).toEqual({ amount: 3n * IMD + 1n, payments: 4, payers: 3 });
    expect(tally.house).toEqual({ amount: 0n, payments: 0, payers: 0 });
  });

  it("does not lose precision where a float would", () => {
    // 2^53 + 1 wei cannot be held by a JavaScript number; the sum of two of them must still be exact.
    const big = 9_007_199_254_740_993n;
    const tally = tallyAll([row(ALICE, big, DAY_ONE), row(BOB, big, DAY_ONE)], new Set());
    expect(tally.amount).toBe(18_014_398_509_481_986n);
    // And a sum far above any real supply stays exact too.
    const huge = 2n ** 200n;
    expect(tallyAll([row(ALICE, huge, DAY_ONE), row(ALICE, 1n, DAY_ONE)], new Set()).amount).toBe(huge + 1n);
  });

  it("splits HOUSE from OUTSIDE so that the two always add up to the whole", () => {
    const rows = [
      row(HOUSE_WALLET, 5n * IMD, DAY_ONE + 1),
      row(HOUSE_WALLET, HALF, DAY_ONE + 2),
      row(ALICE, HALF, DAY_ONE + 3),
      row(BOB, 3n * HALF, DAY_ONE + 4),
    ];
    const tally = tallyAll(rows, new Set([HOUSE_WALLET]));
    expect(tally.house).toEqual({ amount: 11n * HALF, payments: 2, payers: 1 });
    expect(tally.outside).toEqual({ amount: 4n * HALF, payments: 2, payers: 2 });
    expect(tally.house.amount + tally.outside.amount).toBe(tally.amount);
    expect(tally.house.payments + tally.outside.payments).toBe(tally.payments);
    expect(tally.house.payers + tally.outside.payers).toBe(tally.payers);
  });

  it("counts a zero-value transfer as a payment and its sender as a payer, and says how many there were", () => {
    // Brief section 11, decision 12: the official hires feed counts every Transfer log to the fee
    // payee, and its recipe cannot leave out a transfer of nothing. The unofficial tally counts
    // the same way, so the two numbers can be compared; `zeroValueLogs` lets a reader take them out.
    const rows = [row(ALICE, HALF, DAY_ONE), row(BOB, 0n, DAY_ONE + 1), row(CAROL, 0n, DAY_ONE + 2)];
    const tally = tallyAll(rows, new Set());
    expect(tally).toMatchObject({ amount: HALF, payments: 3, payers: 3, zeroValueLogs: 2 });
    expect(tally.outside).toEqual({ amount: HALF, payments: 3, payers: 3 });
  });

  it("puts a zero-value transfer in the house or outside column like any other", () => {
    const rows = [row(ALICE, HALF, DAY_ONE), row(HOUSE_WALLET, 0n, DAY_ONE + 1), row(ALICE, 0n, DAY_ONE + 2)];
    const tally = tallyAll(rows, new Set([HOUSE_WALLET]));
    expect(tally).toMatchObject({ amount: HALF, payments: 3, payers: 2, zeroValueLogs: 2 });
    expect(tally.house).toEqual({ amount: 0n, payments: 1, payers: 1 });
    expect(tally.outside).toEqual({ amount: HALF, payments: 2, payers: 1 });
    // The split still adds up to the whole.
    expect(tally.house.payments + tally.outside.payments).toBe(tally.payments);
    expect(tally.house.payers + tally.outside.payers).toBe(tally.payers);
  });
});

describe("tallyByDay", () => {
  it("puts each payment in the UTC day of its block, oldest day first", () => {
    const rows = [
      row(BOB, IMD, DAY_TWO + 5, 300),
      row(ALICE, HALF, DAY_ONE + 86_399, 200), // the last second of day one
      row(ALICE, HALF, DAY_TWO, 201), // the first second of day two
      row(CAROL, HALF, DAY_ONE + 1, 100),
    ];
    const days = tallyByDay(rows, new Set());
    expect(days.map((day) => day.day)).toEqual(["2026-10-09", "2026-10-10"]);
    expect(days[0]).toMatchObject({ amount: IMD, payments: 2, payers: 2, firstBlock: 100, lastBlock: 200 });
    expect(days[1]).toMatchObject({
      amount: 3n * HALF,
      payments: 2,
      payers: 2,
      firstBlock: 201,
      lastBlock: 300,
    });
  });

  it("counts a payer once per day, and again on the next day", () => {
    const rows = [
      row(ALICE, HALF, DAY_ONE + 1),
      row(ALICE, HALF, DAY_ONE + 2),
      row(ALICE, HALF, DAY_TWO + 1),
    ];
    const days = tallyByDay(rows, new Set());
    expect(days.map((day) => [day.payments, day.payers])).toEqual([
      [2, 1],
      [1, 1],
    ]);
  });

  it("gives the same answer whatever order the rows come in", () => {
    const rows = [
      row(ALICE, HALF, DAY_ONE + 5, 10),
      row(BOB, IMD, DAY_ONE + 9, 11),
      row(HOUSE_WALLET, 2n * IMD, DAY_TWO + 1, 20),
      row(CAROL, HALF, DAY_TWO + 7, 21),
    ];
    const house = new Set([HOUSE_WALLET]);
    const forwards = tallyByDay(rows, house);
    expect(tallyByDay([...rows].reverse(), house)).toEqual(forwards);
    expect(tallyByDay([rows[2], rows[0], rows[3], rows[1]] as TransferRow[], house)).toEqual(forwards);
  });

  it("marks a day complete only when the indexed range spans all of it", () => {
    const rows = [
      row(ALICE, HALF, DAY_ONE + 50_000),
      row(BOB, HALF, DAY_TWO + 100),
      row(BOB, HALF, DAY_TWO + 86_400 + 5),
    ];
    const complete = (fromTime: number | null, toTime: number | null) =>
      tallyByDay(rows, new Set(), { fromTime, toTime }).map((day) => day.complete);

    // Indexing began in the afternoon of day one and has reached five seconds into day three.
    expect(complete(DAY_ONE + 40_000, DAY_TWO + 86_400 + 5)).toEqual([false, true, false]);
    // Indexing began exactly at midnight: day one is whole.
    expect(complete(DAY_ONE, DAY_TWO + 86_400 + 5)).toEqual([true, true, false]);
    // The last indexed block is one second short of the end of day two.
    expect(complete(DAY_ONE, DAY_TWO + 86_399)).toEqual([true, false, false]);
    // When the range is unknown, nothing is claimed to be complete.
    expect(complete(null, null)).toEqual([false, false, false]);
    expect(complete(DAY_ONE, null)).toEqual([false, false, false]);
  });

  it("counts a day that only holds zero-value logs: one payment of nothing", () => {
    const [day] = tallyByDay([row(ALICE, 0n, DAY_ONE + 1)], new Set());
    expect(day).toMatchObject({ day: "2026-10-09", payments: 1, payers: 1, amount: 0n, zeroValueLogs: 1 });
  });

  it("lists a day of the covered range on which nobody paid, as zeros", () => {
    // A reader drawing a 14-day table must be able to tell "nobody paid" from "not indexed".
    const noon = (iso: string) => Date.parse(`${iso}T12:00:00Z`) / 1000;
    const rows = [row(ALICE, HALF, noon("2026-10-05"), 100), row(BOB, HALF, noon("2026-10-07"), 14_500)];
    const tallied = tallyByDay(rows, new Set(), { fromTime: noon("2026-10-04"), toTime: noon("2026-10-09") });
    expect(tallied.map((day) => [day.day, day.payments, day.complete])).toEqual([
      // Indexing began at noon on the 4th and has reached noon on the 9th: both are partial.
      ["2026-10-04", 0, false],
      ["2026-10-05", 1, true],
      ["2026-10-06", 0, true],
      ["2026-10-07", 1, true],
      ["2026-10-08", 0, true],
      ["2026-10-09", 0, false],
    ]);
    const zero = { amount: 0n, payments: 0, payers: 0 };
    expect(tallied[2]).toEqual({
      day: "2026-10-06",
      ...zero,
      house: zero,
      outside: zero,
      zeroValueLogs: 0,
      firstBlock: null,
      lastBlock: null,
      complete: true,
    });
  });

  it("lists only the days that hold a payment when the covered range is not known", () => {
    const rows = [row(ALICE, HALF, DAY_ONE + 1), row(BOB, HALF, DAY_ONE + 3 * 86_400)];
    expect(tallyByDay(rows, new Set()).map((day) => day.day)).toEqual(["2026-10-09", "2026-10-12"]);
    expect(tallyByDay(rows, new Set(), { fromTime: DAY_ONE, toTime: null }).map((day) => day.day)).toEqual([
      "2026-10-09",
      "2026-10-12",
    ]);
  });

  it("does not try to list the days of a range no chain can have", () => {
    const rows = [row(ALICE, HALF, DAY_ONE + 1)];
    // Past the year 9999, more than a hundred years long, or not a number: the days that hold a
    // payment are still tallied, and nothing is thrown.
    for (const coverage of [
      { fromTime: 0, toTime: 4e12 },
      { fromTime: 0, toTime: Date.UTC(2100, 0, 1) / 1000 },
      { fromTime: Number.NaN, toTime: DAY_TWO },
      { fromTime: -5, toTime: DAY_TWO },
    ]) {
      expect(tallyByDay(rows, new Set(), coverage).map((day) => day.day)).toEqual(["2026-10-09"]);
    }
  });
});

describe("rankPayers", () => {
  it("ranks by IMD paid, breaks ties by address, and labels the house", () => {
    const rows = [
      row(CAROL, IMD, DAY_ONE),
      row(ALICE, HALF, DAY_ONE),
      row(ALICE, HALF, DAY_ONE + 1),
      row(BOB, 3n * IMD, DAY_ONE),
      row(HOUSE_WALLET, 0n, DAY_ONE),
    ];
    expect(rankPayers(rows, new Set([BOB]))).toEqual([
      { payer: BOB, amount: 3n * IMD, payments: 1, house: true },
      // Alice and Carol both paid 1 IMD; the lower address comes first.
      { payer: ALICE, amount: IMD, payments: 2, house: false },
      { payer: CAROL, amount: IMD, payments: 1, house: false },
      // A sender of nothing is a payer too (the count of payers includes it) and ranks last.
      { payer: HOUSE_WALLET, amount: 0n, payments: 1, house: false },
    ]);
    // The ranking lists exactly the payers the tally counts.
    expect(rankPayers(rows, new Set(), 100)).toHaveLength(tallyAll(rows, new Set()).payers);
    expect(rankPayers(rows, new Set(), 1)).toHaveLength(1);
    expect(rankPayers(rows, new Set(), 0)).toEqual([]);
  });
});

describe("formatImd", () => {
  it("writes wei as an exact decimal figure", () => {
    expect(formatImd(0n)).toBe("0");
    expect(formatImd(1n)).toBe("0.000000000000000001");
    expect(formatImd(HALF)).toBe("0.5");
    expect(formatImd(IMD)).toBe("1");
    expect(formatImd(118_500_000_000_000_000_000n)).toBe("118.5");
    expect(formatImd(1_823_831n * IMD + 7n)).toBe("1823831.000000000000000007");
    expect(formatImd(-HALF)).toBe("-0.5");
  });
});

describe("the recorded day (94 real transfers, blocks 26,157,615 to 26,164,615)", () => {
  const fixture = loadLogFixture("fee-transfers");
  const rows: TransferRow[] = fixture.logs.map((log) => ({
    from: `0x${(log.topics[1] as string).slice(-40)}`,
    value: BigInt(log.data),
    blockNumber: Number(log.blockNumber),
    blockTime: Number(log.blockTimestamp),
  }));

  it("totals 118.5 IMD in 94 payments from 33 payers", () => {
    const tally = tallyAll(rows, new Set());
    expect(formatImd(tally.amount)).toBe("118.5");
    expect(tally).toMatchObject({ payments: 94, payers: 33, zeroValueLogs: 0 });
  });

  it("splits into the two UTC days the window touches", () => {
    const days = tallyByDay(rows, new Set());
    expect(
      days.map((day) => [
        day.day,
        formatImd(day.amount),
        day.payments,
        day.payers,
        day.firstBlock,
        day.lastBlock,
      ]),
    ).toEqual([
      ["2026-10-09", "77.5", 15, 6, 26_157_626, 26_158_174],
      ["2026-10-10", "41", 79, 32, 26_158_312, 26_164_612],
    ]);
    // The days' amounts and payments add up to the whole; payers do not, because some paid on both days.
    expect(days.reduce((sum, day) => sum + day.amount, 0n)).toBe(118_500_000_000_000_000_000n);
    expect(days.reduce((sum, day) => sum + day.payments, 0)).toBe(94);
    expect(days.reduce((sum, day) => sum + day.payers, 0)).toBeGreaterThan(33);
  });

  it("ranks the day's largest payers", () => {
    expect(
      rankPayers(rows, new Set(), 3).map((payer) => [payer.payer, formatImd(payer.amount), payer.payments]),
    ).toEqual([
      ["0x7b8c742f2e1eeb3fb2c10d72967fa6d4a22f0479", "74", 8],
      ["0x9fadab91f6fa03dbd7f4f8a08a338704baacf63f", "6.5", 13],
      ["0x53b4fb24d2f509a0643a9089c7e7a68011f93118", "4", 8],
    ]);
  });

  it("moves a payer to the house column when it is on the house list, and changes nothing else", () => {
    const top = "0x7b8c742f2e1eeb3fb2c10d72967fa6d4a22f0479";
    const tally = tallyAll(rows, new Set([top]));
    expect(formatImd(tally.house.amount)).toBe("74");
    expect(tally.house).toMatchObject({ payments: 8, payers: 1 });
    expect(formatImd(tally.outside.amount)).toBe("44.5");
    expect(tally.outside).toMatchObject({ payments: 86, payers: 32 });
    expect(tally).toMatchObject({ payments: 94, payers: 33 });
  });

  it("tallies a block window on its own", () => {
    const window = rows.filter((entry) => entry.blockNumber >= 26_160_000 && entry.blockNumber <= 26_162_000);
    expect(tallyAll(window, new Set())).toMatchObject({ amount: 9n * IMD, payments: 18, payers: 12 });
  });
});
