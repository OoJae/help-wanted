import { bytesToHex, hexToBytes, keccak256, stringToBytes, stringToHex, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  HEADER_LENGTH,
  HEADER_PREFIX,
  HEADER_SUFFIX,
  RESEARCH_SPEC_MAX_BYTES,
  SPEC_MAX_BYTES,
  buildObjective,
  checkSpec,
  describeSpecProblem,
  isValidSpec,
  kindHash,
  objectiveHasHeader,
  objectiveMatches,
  orderHeadHash,
  orderHeader,
  orderHeaderBytes,
  orderTicket,
  parseObjective,
  specFirstBad,
  specHash,
  ticketPreimage,
} from "../src/index.js";
import { readJson, repoFile, vector } from "./paths.js";

interface HeaderVector {
  note: string;
  chainId: string;
  desk: Address;
  orderId: string;
  claimSeq: string;
  runner: Address;
  preimage: Hex;
  ticket: Hex;
  header: string;
  headerHex: Hex;
  headerHash: Hex;
}
interface HeaderFile {
  headerLength: number;
  prefix: string;
  suffix: string;
  vectors: HeaderVector[];
  objectiveExample: { vector: number; spec: string; specHash: Hex; objective: string; objectiveHex: Hex };
}

function runHeaderVectors(file: HeaderFile): void {
  expect(file.headerLength).toBe(HEADER_LENGTH);
  expect(file.prefix).toBe(HEADER_PREFIX);
  expect(file.suffix).toBe(HEADER_SUFFIX);
  expect(file.vectors.length).toBeGreaterThanOrEqual(5);
  for (const v of file.vectors) {
    const input = {
      chainId: BigInt(v.chainId),
      workOrders: v.desk,
      orderId: BigInt(v.orderId),
      claimSeq: BigInt(v.claimSeq),
      runner: v.runner,
    };
    expect(ticketPreimage(input), v.note).toBe(v.preimage);
    const ticket = orderTicket(input);
    expect(ticket, v.note).toBe(v.ticket);
    expect(orderHeader(ticket), v.note).toBe(v.header);
    expect(bytesToHex(orderHeaderBytes(ticket)), v.note).toBe(v.headerHex);
    expect(orderHeaderBytes(ticket).length).toBe(HEADER_LENGTH);
    expect(orderHeadHash(ticket), v.note).toBe(v.headerHash);
  }
  const ex = file.objectiveExample;
  const ticket = file.vectors[ex.vector]?.ticket as Hex;
  expect(specHash(ex.spec)).toBe(ex.specHash);
  expect(buildObjective(ticket, ex.spec)).toBe(ex.objective);
  expect(stringToHex(buildObjective(ticket, ex.spec))).toBe(ex.objectiveHex);
}

describe("order ticket and header", () => {
  it("matches the golden vectors in this package", () => {
    runHeaderVectors(vector<HeaderFile>("header-vectors.json"));
  });

  it("matches the hire desk's own vector file, which was made with other tools", (ctx) => {
    const path = repoFile("launches", "b-desk", "test", "fixtures", "desk", "header-vectors.json");
    if (!path) return ctx.skip();
    const theirs = readJson<HeaderFile>(path);
    runHeaderVectors(theirs);
    // The two files were produced independently (cast there, Python here). Where they describe the
    // same claim they must say the same thing about it.
    const ours = new Map(
      vector<HeaderFile>("header-vectors.json").vectors.map((v) => [
        [v.chainId, v.desk.toLowerCase(), v.orderId, v.claimSeq, v.runner.toLowerCase()].join("/"),
        v,
      ]),
    );
    let shared = 0;
    for (const v of theirs.vectors) {
      const mine = ours.get(
        [v.chainId, v.desk.toLowerCase(), v.orderId, v.claimSeq, v.runner.toLowerCase()].join("/"),
      );
      if (!mine) continue;
      expect(mine.ticket).toBe(v.ticket);
      expect(mine.headerHex).toBe(v.headerHex);
      expect(mine.headerHash).toBe(v.headerHash);
      shared++;
    }
    expect(shared).toBeGreaterThanOrEqual(5);
  });

  it("is 19 bytes of prefix, 64 of lowercase hex and 2 of suffix", () => {
    const ticket = `0x${"AB".repeat(32)}` as Hex;
    const header = orderHeader(ticket);
    expect(header).toBe(`[help-wanted order ${"ab".repeat(32)}] `);
    expect(header.length).toBe(85);
    expect(HEADER_PREFIX.length + 64 + HEADER_SUFFIX.length).toBe(HEADER_LENGTH);
  });

  it("accepts numbers and bigints alike, and refuses what is not an unsigned integer", () => {
    const desk = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
    const runner = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const a = orderTicket({ chainId: 1, workOrders: desk, orderId: 1, claimSeq: 1, runner });
    const b = orderTicket({ chainId: 1n, workOrders: desk, orderId: 1n, claimSeq: 1n, runner });
    expect(a).toBe(b);
    // Lowercase addresses give the same ticket: the address is encoded, not its spelling.
    expect(
      orderTicket({
        chainId: 1,
        workOrders: desk.toLowerCase() as Address,
        orderId: 1,
        claimSeq: 1,
        runner: runner.toLowerCase() as Address,
      }),
    ).toBe(a);
    expect(() => orderTicket({ chainId: 1, workOrders: desk, orderId: -1, claimSeq: 1, runner })).toThrow(
      RangeError,
    );
    expect(() =>
      orderTicket({ chainId: 1, workOrders: desk, orderId: 2 ** 60, claimSeq: 1, runner }),
    ).toThrow(RangeError);
    expect(() =>
      orderTicket({ chainId: 1, workOrders: "0x1234" as Address, orderId: 1, claimSeq: 1, runner }),
    ).toThrow();
  });

  it("every field of the ticket changes it", () => {
    const base = {
      chainId: 1,
      workOrders: "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address,
      orderId: 7,
      claimSeq: 1,
      runner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address,
    };
    const tickets = new Set([
      orderTicket(base),
      orderTicket({ ...base, chainId: 11155111 }),
      orderTicket({ ...base, workOrders: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" }),
      orderTicket({ ...base, orderId: 8 }),
      orderTicket({ ...base, claimSeq: 2 }),
      orderTicket({ ...base, runner: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" }),
    ]);
    expect(tickets.size).toBe(6);
  });

  it("refuses a malformed ticket", () => {
    expect(() => orderHeader("0x1234" as Hex)).toThrow(TypeError);
    expect(() => orderHeader(`0x${"zz".repeat(32)}` as Hex)).toThrow(TypeError);
  });

  it("builds and parses an objective", () => {
    const ticket = keccak256(stringToBytes("t"));
    const spec = "Audit the vault. Inputs: repoUrl=https://github.com/o/r; baseCommit=" + "ab".repeat(20);
    const objective = buildObjective(ticket, spec);
    expect(objective.length).toBe(HEADER_LENGTH + spec.length);
    expect(parseObjective(objective)).toEqual({ ticket, header: orderHeader(ticket), spec });
    expect(parseObjective(stringToBytes(objective))?.spec).toBe(spec);
    expect(objectiveHasHeader(objective, ticket)).toBe(true);
    expect(objectiveMatches(objective, ticket, spec)).toBe(true);
    expect(objectiveMatches(objective + " ", ticket, spec)).toBe(false);
    expect(objectiveHasHeader(objective, keccak256(stringToBytes("other")))).toBe(false);
    expect(() => buildObjective(ticket, 'say "hi"')).toThrow(RangeError);
  });

  it("does not take a look-alike for a header", () => {
    const hex = "ab".repeat(32);
    expect(parseObjective(`[help-wanted order ${hex}]`)).toBeNull(); // no trailing space, 84 chars
    expect(parseObjective(`[help-wanted order ${hex.toUpperCase()}] spec`)).toBeNull(); // uppercase hex
    expect(parseObjective(` [help-wanted order ${hex}] spec`)).toBeNull(); // not at byte 0
    expect(parseObjective(`[help-wanted 0rder ${hex}] spec`)).toBeNull();
    expect(parseObjective(`[help-wanted order ${hex.slice(2)}zz] spec`)).toBeNull();
    expect(parseObjective("short")).toBeNull();
    expect(parseObjective(`[help-wanted order ${hex}] `)?.spec).toBe("");
  });
});

interface SpecVector {
  note: string;
  bytes: number;
  firstBad: number | null;
  hex?: Hex;
  repeatByteHex?: Hex;
  specHash?: Hex;
}

function specBytesOf(v: SpecVector): Uint8Array {
  if (v.hex !== undefined) return hexToBytes(v.hex);
  const byte = hexToBytes(v.repeatByteHex as Hex)[0] as number;
  return new Uint8Array(v.bytes).fill(byte);
}

describe("spec character rules", () => {
  const file = vector<{ maxBytes: number; vectors: SpecVector[] }>("spec-vectors.json");

  it("has vectors to run", () => {
    expect(file.maxBytes).toBe(SPEC_MAX_BYTES);
    expect(file.vectors.length).toBeGreaterThanOrEqual(20);
  });

  it.each(file.vectors)("$note", (v) => {
    const bytes = specBytesOf(v);
    expect(bytes.length).toBe(v.bytes);
    expect(specFirstBad(bytes)).toBe(v.firstBad);
    expect(isValidSpec(bytes)).toBe(v.firstBad === null);
    if (v.specHash !== undefined) expect(specHash(bytes)).toBe(v.specHash);
  });

  it("agrees with the pots fixture of valid and invalid specs", (ctx) => {
    const path = repoFile("launches", "b-desk", "test", "fixtures", "pots", "specs.json");
    if (!path) return ctx.skip();
    const theirs = readJson<{ validText?: string[]; invalidHex?: Hex[]; invalidAt?: number[] }>(path);
    for (const text of theirs.validText ?? []) expect(specFirstBad(text), text).toBeNull();
    const invalid = theirs.invalidHex ?? [];
    invalid.forEach((hex, i) => {
      const at = specFirstBad(hexToBytes(hex));
      expect(at, hex).not.toBeNull();
      const want = theirs.invalidAt?.[i];
      if (typeof want === "number") expect(at, hex).toBe(want);
    });
  });

  it("checks every byte value at an inner position", () => {
    for (let b = 0; b < 256; b++) {
      const allowed = b >= 0x20 && b <= 0x7e && b !== 0x22 && b !== 0x5c;
      expect(specFirstBad(new Uint8Array([0x61, b, 0x61])), `byte ${b}`).toBe(allowed ? null : 1);
    }
  });

  it("treats a string as its UTF-8 bytes", () => {
    expect(checkSpec("naïve")).toEqual({ ok: false, problem: { code: "bad_byte", at: 2, byte: 0xc3 } });
    expect(checkSpec("plain")).toEqual({ ok: true, bytes: 5 });
  });

  it("explains a refusal in words", () => {
    const cases: [string | Uint8Array, string][] = [
      ["", "the spec is empty"],
      [" a", "starts with a space"],
      ["a ", "ends with a space"],
      ["a\nb", "byte 0x0a at offset 1"],
      [new Uint8Array(7901).fill(0x61), "7901 bytes; the limit is 7900"],
    ];
    for (const [spec, words] of cases) {
      const check = checkSpec(spec);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(describeSpecProblem(check.problem)).toContain(words);
    }
  });

  it("leaves room for the header under IdentityMD's objective limits", () => {
    expect(HEADER_LENGTH + SPEC_MAX_BYTES).toBeLessThanOrEqual(8000);
    expect(HEADER_LENGTH + RESEARCH_SPEC_MAX_BYTES).toBe(4000);
  });

  it("hashes kinds as the desk expects them", () => {
    const golden = vector<{ hashes: Record<string, string> }>("abi-selectors.json").hashes;
    expect(kindHash("audit")).toBe(golden['keccak256("audit")']);
    expect(kindHash("completed")).toBe(golden['keccak256("completed")']);
  });
});
