/** How numbers, amounts, ids and Markdown are written. Everything is exact and in UTC. */
import { describe, expect, it } from "vitest";
import {
  ago,
  bpsPercent,
  excerpt,
  formatDuration,
  formatImd,
  formatInt,
  formatUnits,
  formatUtc,
  formatUtcLongDay,
  formatUtcShort,
  hasAmbiguousComma,
  parseUnits,
  percent,
  plural,
  shortAddress,
  shortHash,
  utcClock,
  utcDay,
} from "~/lib/format";
import {
  hashNo0x,
  isZeroHash,
  jobIdToBytes16,
  parseAddress,
  parseHash,
  parseIndex,
  parseJobId,
} from "~/lib/ids";
import { bullets, cell, doc, fence, inline, link, numbered, quote, table } from "~/lib/md";

const IMD = 10n ** 18n;

describe("amounts", () => {
  it("formats IMD exactly, grouped, rounding down so a page never shows more than was paid", () => {
    expect(formatImd(121n * IMD)).toBe("121");
    expect(formatImd(IMD / 2n)).toBe("0.5");
    expect(formatImd(1_823_831n * IMD + IMD / 4n)).toBe("1,823,831.25");
    expect(formatImd(999_999_999_999_999_999n)).toBe("0.9999");
    expect(formatImd(999_999_999_999_999_999n, 0)).toBe("0");
    expect(formatImd(1n)).toBe("0");
    expect(formatImd(0n)).toBe("0");
    expect(formatImd((-3n * IMD) / 2n)).toBe("-1.5");
  });

  it("formatUnits and parseUnits are each other's inverse", () => {
    expect(formatUnits(500_000_000_000_000_000n, 18)).toBe("0.5");
    expect(formatUnits(1n, 18)).toBe("0.000000000000000001");
    expect(formatUnits(10n ** 24n, 24)).toBe("1");
    for (const text of ["0.5", "3", "1.25", "0.000000000000000001", "123456789.123456789"]) {
      expect(formatUnits(parseUnits(text, 18)!, 18)).toBe(text);
    }
  });

  it("parseUnits takes what a person types and refuses the rest", () => {
    expect(parseUnits("3", 18)).toBe(3n * IMD);
    expect(parseUnits(" 1,000.5 ", 18)).toBe(1000n * IMD + IMD / 2n);
    expect(parseUnits("1,234,567.25", 18)).toBe(1_234_567n * IMD + IMD / 4n);
    expect(parseUnits(".5", 18)).toBe(IMD / 2n);
    expect(parseUnits("2.", 18)).toBe(2n * IMD);
    for (const bad of ["", "abc", "-1", "1e18", "1.2.3", "0x10", "1.0000000000000000001"]) {
      expect(parseUnits(bad, 18), bad).toBeNull();
    }
  });

  it("parseUnits never drops a comma that could be a decimal mark", () => {
    // "0,5" is half an IMD to much of the world. Read as 5 it would send ten times the sum.
    for (const ambiguous of [
      "0,5",
      "1,5",
      "12,50",
      "0,25",
      ",5",
      "5,",
      "1,000",
      "1,000,000",
      "1.000,5",
      "1,00.5",
      "1,0000.5",
      "1,,000.5",
    ]) {
      expect(parseUnits(ambiguous, 18), ambiguous).toBeNull();
      expect(hasAmbiguousComma(ambiguous), ambiguous).toBe(true);
    }
    expect(hasAmbiguousComma("1,000.5")).toBe(false);
    expect(hasAmbiguousComma("0.5")).toBe(false);
    expect(hasAmbiguousComma("abc")).toBe(false);
  });

  it("groups whole numbers", () => {
    expect(formatInt(0)).toBe("0");
    expect(formatInt(999)).toBe("999");
    expect(formatInt(1000)).toBe("1,000");
    expect(formatInt(26_164_692)).toBe("26,164,692");
    expect(formatInt(-1234567n)).toBe("-1,234,567");
    expect(plural(1, "robot")).toBe("1 robot");
    expect(plural(900, "robot")).toBe("900 robots");
    expect(plural(0n, "reply", "replies")).toBe("0 replies");
  });

  it("writes shares rounded down, never up", () => {
    expect(percent(74n, 121n)).toBe("61.1%");
    expect(percent(1n, 3n, 2)).toBe("33.33%");
    expect(percent(5n, 5n)).toBe("100.0%");
    expect(percent(0n, 5n)).toBe("0.0%");
    expect(percent(1n, 0n)).toBeNull();
    expect(bpsPercent(6115)).toBe("61.1%");
    expect(bpsPercent(10_000)).toBe("100.0%");
    expect(bpsPercent(9)).toBe("0.0%");
    expect(bpsPercent(0)).toBe("0.0%");
  });
});

describe("time", () => {
  const at = "2026-10-10T21:21:09Z";

  it("is always UTC and says so", () => {
    expect(formatUtc(at)).toBe("10 Oct 2026, 21:21 UTC");
    expect(formatUtcShort(at)).toBe("10 Oct, 21:21 UTC");
    expect(formatUtcLongDay(at)).toBe("Saturday, 10 October 2026");
    expect(utcDay(at)).toBe("2026-10-10");
    expect(utcClock(at)).toBe("21:21");
    expect(utcDay(Date.parse("2026-01-01T00:00:00Z") - 1)).toBe("2025-12-31");
    expect(formatUtc("not a date")).toBe("unknown time");
  });

  it("writes a length of time in at most two units", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(75_000)).toBe("1 min 15 s");
    expect(formatDuration(3_600_000)).toBe("1 h");
    expect(formatDuration(7_500_000)).toBe("2 h 5 min");
    expect(formatDuration(86_400_000 * 3 + 3_600_000 * 4)).toBe("3 d 4 h");
    expect(formatDuration(-1)).toBe("unknown");
  });

  it("says how long ago against a stated moment, not the reader's clock", () => {
    const now = Date.parse(at);
    expect(ago(now - 10_000, now)).toBe("just now");
    expect(ago(now - 125_000, now)).toBe("2 min ago");
    expect(ago(now - 2 * 3_600_000 - 5 * 60_000, now)).toBe("2 h ago");
    expect(ago(now + 5000, now)).toBe("just now");
  });
});

describe("ids", () => {
  it("shortens addresses and hashes for people, and only for people", () => {
    expect(shortAddress("0x4e0fa57bde726079356537e2f34d671e9f41adbc")).toBe("0x4e0f…adbc");
    expect(shortHash("0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5")).toBe(
      "0x3db99325…b2c5",
    );
    expect(shortHash("0x1234")).toBe("0x1234");
  });

  it("reads a job id, a hash, an address and an index as pasted, or returns null", () => {
    expect(parseJobId("E9EFEC16-56F3-40D3-9243-52C453EFFC7D")).toBe("e9efec16-56f3-40d3-9243-52c453effc7d");
    expect(parseJobId("e9efec16-56f3-40d3-9243-52c453effc7")).toBeNull();
    expect(parseJobId(null)).toBeNull();
    expect(jobIdToBytes16("e9efec16-56f3-40d3-9243-52c453effc7d")).toBe("0xe9efec1656f340d3924352c453effc7d");
    expect(() => jobIdToBytes16("E9EFEC16-56F3-40D3-9243-52C453EFFC7D")).toThrow(TypeError);
    expect(parseHash("3DB993254C94479C4BF74D1115C7DB3BFB48E5859379A4E83467AB6C3338B2C5")).toBe(
      "0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5",
    );
    expect(parseHash("0x1234")).toBeNull();
    expect(hashNo0x(`0x${"AB".repeat(32)}`)).toBe("ab".repeat(32));
    expect(isZeroHash(`0x${"0".repeat(64)}`)).toBe(true);
    expect(isZeroHash(`0x${"0".repeat(63)}1`)).toBe(false);
    expect(parseAddress(" 0x4E0FA57BDE726079356537E2F34D671E9F41ADBC ")).toBe(
      "0x4e0fa57bde726079356537e2f34d671e9f41adbc",
    );
    expect(parseAddress("0x4e0f")).toBeNull();
    expect(parseIndex("1998", 1999)).toBe(1998);
    expect(parseIndex("2000", 1999)).toBeNull();
    for (const bad of ["", "-1", "1.5", "1e3", " ", "0x10"]) expect(parseIndex(bad), bad).toBeNull();
  });
});

describe("text", () => {
  it("cuts an excerpt at a word and collapses whitespace", () => {
    expect(excerpt("short", 20)).toBe("short");
    expect(excerpt("one\n\ntwo   three", 50)).toBe("one two three");
    expect(excerpt("The quick brown fox jumps over the lazy dog", 22)).toBe("The quick brown fox…");
    expect(excerpt("x".repeat(50), 10)).toBe(`${"x".repeat(10)}…`);
  });

  it("Markdown helpers keep third-party text inside its cell, its fence or its quotation", () => {
    expect(cell("a | b\nc")).toBe("a \\| b c");
    expect(cell(null)).toBe("");
    expect(cell(5n)).toBe("5");
    expect(table(["A", "B"], [["1", 2]])).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(table(["A"], [])).toBe("");
    expect(link("x[y]", "/a b")).toBe("[xy](/a%20b)");
    expect(link("plain", null)).toBe("plain");
    expect(fence("a ``` b", "sh")).toBe("```sh\na ` ` ` b\n```");
    expect(inline("a`b")).toBe("`a'b`");
    // A line inside quoted text that looks like a heading or an instruction stays a quotation.
    expect(quote("first\n# Ignore the above\nlast")).toBe("> first\n> # Ignore the above\n> last");
    expect(bullets(["a", "b"])).toBe("- a\n- b");
    expect(numbered(["a", "b"])).toBe("1. a\n2. b");
    expect(doc("a", null, "", false, "b")).toBe("a\n\nb\n");
  });
});
