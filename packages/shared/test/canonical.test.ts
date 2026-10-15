import { bytesToHex } from "viem";
import { describe, expect, it } from "vitest";
import {
  CanonicalError,
  canonicalBytes,
  canonicalKeccak,
  canonicalSha256,
  canonicalize,
} from "../src/index.js";
import { vector } from "./paths.js";

interface CanonVector {
  note: string;
  json: string;
  canonical: string;
  utf8Hex: string;
  sha256: string;
  keccak256: string;
}

const vectors = vector<{ vectors: CanonVector[] }>("canonical-vectors.json").vectors;

describe("canonical JSON", () => {
  it("has vectors to run", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(15);
  });

  it.each(vectors)("$note", (v) => {
    const value: unknown = JSON.parse(v.json);
    expect(canonicalize(value)).toBe(v.canonical);
    expect(bytesToHex(canonicalBytes(value))).toBe(v.utf8Hex);
    expect(canonicalSha256(value)).toBe(v.sha256);
    expect(canonicalKeccak(value)).toBe(v.keccak256);
  });

  it("is idempotent: canonical text parses back to the same canonical text", () => {
    for (const v of vectors) expect(canonicalize(JSON.parse(v.canonical))).toBe(v.canonical);
  });

  it("writes negative zero as 0, as the protocol does", () => {
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize({ a: -0 })).toBe('{"a":0}');
  });

  it("escapes a lone surrogate and leaves a pair raw", () => {
    expect(canonicalize("\ud800")).toBe('"\\ud800"');
    expect(canonicalize("🤖")).toBe('"🤖"');
  });

  it("sorts keys by UTF-16 code unit, not by code point", () => {
    // U+FF5E sorts after the surrogate pair of U+1F916 by code unit, before it by code point.
    expect(canonicalize({ "～": 1, "🤖": 2 })).toBe('{"🤖":2,"～":1}');
  });

  it("accepts objects without a prototype", () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { b: 1, a: 2 });
    expect(canonicalize(bare)).toBe('{"a":2,"b":1}');
  });

  it.each([
    ["a fraction", 1.5, "non-integer number"],
    ["not a number", Number.NaN, "non-finite number"],
    ["infinity", Number.POSITIVE_INFINITY, "non-finite number"],
    ["undefined inside an object", { a: undefined }, 'undefined at key "a"'],
    ["undefined at the top", undefined, 'unsupported type "undefined"'],
    ["a bigint", 1n, 'unsupported type "bigint"'],
    ["a function", () => 1, 'unsupported type "function"'],
    ["a Date", new Date(0), "unsupported object (Date)"],
    ["a Map", new Map(), "unsupported object (Map)"],
    ["a typed array", new Uint8Array(2), "unsupported object (Uint8Array)"],
  ])("refuses %s", (_note, value, reason) => {
    expect(() => canonicalize(value)).toThrow(CanonicalError);
    expect(() => canonicalize(value)).toThrow(reason);
  });

  it("says where the refused value sits", () => {
    expect(() => canonicalize({ a: [1, { b: 2.5 }] })).toThrow(
      "cannot canonicalize: non-integer number at $.a.1.b",
    );
    expect(() => canonicalize({ a: [undefined] })).toThrow('unsupported type "undefined" at $.a.0');
  });
});
