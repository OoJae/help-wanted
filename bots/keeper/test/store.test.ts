import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  StoreError,
  emptyState,
  memoryStore,
  noteRound,
  openFileStore,
  prune,
  roundNote,
  spendLimit,
  spentOn,
  utcDay,
} from "../src/store.js";

const FEED = `0x${"f1".repeat(32)}` as const;
const TX = `0x${"d1".repeat(32)}` as const;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "hw-keeper-store-"));
}

describe("the day's spending", () => {
  it("names a UTC day: the last second of one and the first of the next", () => {
    expect(utcDay(1_791_936_000 - 1)).toBe("2026-10-13");
    expect(utcDay(1_791_936_000)).toBe("2026-10-14");
    expect(utcDay(0)).toBe("1970-01-01");
  });

  it("adds up within a day and starts from nothing on the next", () => {
    const store = memoryStore();
    let now = 1_791_900_000;
    const limit = spendLimit(store, 1_000n, () => now);
    expect(limit.spentToday()).toBe(0n);
    limit.add(300n);
    limit.add(200n);
    expect(limit.spentToday()).toBe(500n);
    expect(limit.cap).toBe(1_000n);
    expect(store.saves).toBe(2);
    now = 1_791_936_000;
    expect(limit.spentToday()).toBe(0n);
    limit.add(40n);
    expect(spentOn(store.data, "2026-10-13")).toBe(500n);
    expect(spentOn(store.data, "2026-10-14")).toBe(40n);
  });

  it("never goes below zero when a reservation made before midnight is given back after it", () => {
    const store = memoryStore();
    let now = 1_791_936_000 - 1;
    const limit = spendLimit(store, 1_000n, () => now);
    limit.add(260n);
    now += 1;
    limit.add(-156n);
    expect(limit.spentToday()).toBe(0n);
    // Yesterday keeps the reservation: over-counted, never under.
    expect(spentOn(store.data, "2026-10-13")).toBe(260n);
  });

  it("keeps a fortnight of days and the newest round notes", () => {
    const state = emptyState();
    for (let day = 1; day <= 20; day++) state.spend[`2026-10-${String(day).padStart(2, "0")}`] = "1";
    for (let round = 1; round <= 230; round++)
      noteRound(state, FEED, BigInt(round), { requestTx: TX }, round);
    prune(state);
    expect(Object.keys(state.spend)).toHaveLength(14);
    expect(state.spend["2026-10-06"]).toBeUndefined();
    expect(state.spend["2026-10-07"]).toBe("1");
    expect(Object.keys(state.rounds)).toHaveLength(200);
    expect(roundNote(state, FEED, 30n)).toBeUndefined();
    expect(roundNote(state, FEED, 31n)?.requestTx).toBe(TX);
  });
});

describe("round notes", () => {
  it("adds what is learned and says whether anything changed", () => {
    const state = emptyState();
    expect(noteRound(state, FEED, 3n, { requestTx: TX }, 100)).toBe(true);
    expect(noteRound(state, FEED, 3n, { requestTx: TX }, 200)).toBe(false);
    expect(roundNote(state, FEED, 3n)).toEqual({ requestTx: TX, at: 100 });
    expect(noteRound(state, FEED, 3n, { oracleRequestId: "3744d864-8cbf-4fcf-8a8c-3529fb1736cb" }, 300)).toBe(
      true,
    );
    expect(noteRound(state, FEED, 3n, { failure: "refused: body_refused" }, 400)).toBe(true);
    expect(roundNote(state, FEED, 3n)).toEqual({
      requestTx: TX,
      oracleRequestId: "3744d864-8cbf-4fcf-8a8c-3529fb1736cb",
      failure: "refused: body_refused",
      at: 400,
    });
    // Notes are by feed and round, in any letter case of the feed id.
    expect(roundNote(state, FEED.toUpperCase().replace("0X", "0x") as typeof FEED, 3n)?.requestTx).toBe(TX);
    expect(roundNote(state, FEED, 4n)).toBeUndefined();
  });
});

describe("the state file", () => {
  it("starts empty, is written whole with mode 600, and is read back", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "nested", "keeper.json");
      const store = openFileStore(path);
      expect(store.data).toEqual(emptyState());
      noteRound(store.data, FEED, 1n, { requestTx: TX }, 5);
      store.data.spend["2026-10-13"] = "123";
      store.save();
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const again = openFileStore(path);
      expect(again.data.spend["2026-10-13"]).toBe("123");
      expect(roundNote(again.data, FEED, 1n)?.requestTx).toBe(TX);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(again.data);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a damaged file instead of starting over on top of it", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "keeper.json");
      writeFileSync(path, "{ not json");
      expect(() => openFileStore(path)).toThrow(StoreError);
      writeFileSync(path, JSON.stringify({ v: 2 }));
      expect(() => openFileStore(path)).toThrow(/not a keeper state file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says so when it cannot be written", () => {
    const dir = tempDir();
    try {
      const store = openFileStore(join(dir, "sub", "keeper.json"));
      // A file appears where the directory should be.
      writeFileSync(join(dir, "sub"), "");
      expect(() => store.save()).toThrow(StoreError);
      // And a path that cannot even be looked at is refused at once.
      expect(() => openFileStore(join(dir, "sub", "keeper.json"))).toThrow(/cannot be read/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
