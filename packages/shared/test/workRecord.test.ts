import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  bytesToString,
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  sha256,
  stringToBytes,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_IDS,
  WORK_RECORD_COMPLETED_HASH,
  WORK_RECORD_KEYS,
  WORK_RECORD_SCHEMA,
  WorkRecordError,
  canonicalize,
  checkRecordBytes,
  fetchWorkRecord,
  kindHash,
  recordHashHex,
  recordToHex,
  scanWorkRecord,
  scanWorkRecordFor,
  toRecordBytes,
  workRecordUrl,
} from "../src/index.js";
import { PKG, fixture, readBytes, readJson, repoFile, vector } from "./paths.js";

const RECEIPT = "0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5";
const JOB = "e9efec16-56f3-40d3-9243-52c453effc7d";
const real = () => readBytes(fixture("work-records", `${RECEIPT.slice(2)}.json`));

interface RecordVector {
  file: string;
  bytes: number;
  recordHash: Hex;
  jobId: string;
  jobIdBytes16: Hex;
  kind: string;
  kindHash: Hex;
  state: string;
  stateHash: Hex;
  schema: string;
  objectiveStart: number;
  objectiveRawBytes: number;
  objectiveHash: Hex;
  headLen: number;
  headHash: Hex;
  specHash: Hex;
  agentIds: string[];
}

function errorOf(fn: () => unknown): WorkRecordError {
  try {
    fn();
  } catch (error) {
    if (error instanceof WorkRecordError) return error;
    throw error;
  }
  throw new Error("expected a WorkRecordError");
}

/** A canonical record with the six scanned members and whatever else is asked for. */
function record(overrides: Record<string, unknown> = {}, drop: string[] = []): Uint8Array {
  const doc: Record<string, unknown> = {
    assessments: [],
    jobId: JOB,
    kind: "audit",
    nodes: [{ key: "a", note: 'decoy ","state":"completed","objective":"x' }],
    objective: "Audit the vault.",
    parentJobId: null,
    schema: WORK_RECORD_SCHEMA,
    signals: [{ agentId: "7", value: 1 }],
    state: "completed",
    submissions: [],
    ...overrides,
  };
  for (const key of drop) delete doc[key];
  return stringToBytes(canonicalize(doc));
}

describe("work record: the real receipt of job e9efec16", () => {
  it("hashes to the on-chain receipt as served, with no trailing newline", () => {
    const bytes = real();
    expect(bytes.length).toBe(7339);
    expect(keccak256(bytes)).toBe(RECEIPT);
    expect(bytes[bytes.length - 1]).toBe(0x7d);
  });

  it("is canonical: re-serialising it gives the same bytes", () => {
    const bytes = real();
    const doc: unknown = JSON.parse(bytesToString(bytes));
    expect(canonicalize(doc)).toBe(bytesToString(bytes));
    expect(Object.keys(doc as object)).toEqual([...WORK_RECORD_KEYS]);
  });

  it("scans to what the document says", () => {
    const bytes = real();
    const doc = JSON.parse(bytesToString(bytes)) as { objective: string; kind: string; state: string };
    const scan = scanWorkRecord(bytes, 0);
    expect(scan.recordHash).toBe(RECEIPT);
    expect(scan.jobId).toBe(JOB);
    expect(scan.jobIdBytes16).toBe("0xe9efec1656f340d3924352c453effc7d");
    expect(scan.kind).toBe("skill:research-report");
    expect(scan.kind).toBe(doc.kind);
    expect(scan.objective).toBe(doc.objective);
    expect(scan.state).toBe("completed");
    expect(scan.schema).toBe("identitymd-work-v1");
    expect(scan.agentIds).toEqual([52211n]);
    expect(scan.kindHash).toBe(kindHash("skill:research-report"));
    expect(scan.stateHash).toBe(kindHash("completed"));
    // With no head, the "spec" is the whole raw objective and the head is empty.
    expect(scan.headHash).toBe(keccak256(new Uint8Array(0)));
    expect(scan.specHash).toBe(keccak256(scan.objectiveRaw));
  });

  it("keeps the objective's raw bytes: the newlines are still the two characters \\n", () => {
    const scan = scanWorkRecord(real());
    const raw = bytesToString(scan.objectiveRaw);
    expect(raw).toContain("Keep it simple.\\n\\nFeedback 1)");
    expect(scan.objective).toContain("Keep it simple.\n\nFeedback 1)");
    expect(scan.objectiveRaw.length).toBeGreaterThan(stringToBytes(scan.objective).length);
  });
});

describe("work record: golden vectors from real records", () => {
  const vectors = vector<{ vectors: RecordVector[] }>("work-record-vectors.json").vectors;

  it("covers several kinds", () => {
    expect(new Set(vectors.map((v) => v.kind)).size).toBeGreaterThanOrEqual(5);
  });

  it.each(vectors)("$kind ($file)", (v) => {
    const bytes = readBytes(fixture("work-records", v.file));
    expect(bytes.length).toBe(v.bytes);
    const scan = scanWorkRecord(bytes, v.headLen);
    expect(scan.recordHash).toBe(v.recordHash);
    expect(`${v.recordHash.slice(2)}.json`).toBe(v.file);
    expect(scan.jobId).toBe(v.jobId);
    expect(scan.jobIdBytes16).toBe(v.jobIdBytes16);
    expect(scan.kind).toBe(v.kind);
    expect(scan.kindHash).toBe(v.kindHash);
    expect(scan.state).toBe(v.state);
    expect(scan.stateHash).toBe(v.stateHash);
    expect(scan.schema).toBe(v.schema);
    expect(scan.objectiveRaw.length).toBe(v.objectiveRawBytes);
    expect(scan.objectiveRaw.byteOffset - bytes.byteOffset).toBe(v.objectiveStart);
    expect(keccak256(scan.objectiveRaw)).toBe(v.objectiveHash);
    expect(scan.headHash).toBe(v.headHash);
    expect(scan.specHash).toBe(v.specHash);
    expect(scan.agentIds.map(String)).toEqual(v.agentIds);
    expect(scanWorkRecordFor(v.jobId, bytes, v.headLen).recordHash).toBe(v.recordHash);
    expect(scanWorkRecordFor(v.jobIdBytes16, bytes, v.headLen).recordHash).toBe(v.recordHash);
  });
});

describe("work record: a job with two records", () => {
  // Job 97804d2b was given a second record after its first. The registry then answers with the
  // newer hash, so whatever follows a job must ask the registry, not remember a hash.
  const FIRST = "0xb57f89128f5fb7b4f78c710f617d46001a588d2810255a28c2271c8b7b599d86";
  const SECOND = "0x56cfc4e2e4c6a1395d96349c2a39c5ba16351881916539b32a188f13936eb4dc";
  const load = (hash: string) => readBytes(fixture("work-records", `${hash.slice(2)}.json`));

  it("the second names the first as its previousHash, and lists no agents", () => {
    const first = scanWorkRecord(load(FIRST), 0);
    const second = scanWorkRecord(load(SECOND), 0);
    expect(first.recordHash).toBe(FIRST);
    expect(second.recordHash).toBe(SECOND);
    expect(second.jobId).toBe(first.jobId);
    const doc = JSON.parse(bytesToString(load(SECOND))) as { previousHash: string; signals: unknown[] };
    expect(doc.previousHash).toBe(FIRST.slice(2));
    expect(doc.signals).toEqual([]);
    expect(first.agentIds).toEqual([51017n]);
    expect(second.agentIds).toEqual([]);
    // Both say the same about the work: same kind, same objective, completed.
    expect(second.kindHash).toBe(first.kindHash);
    expect(second.specHash).toBe(first.specHash);
    expect(first.completed && second.completed).toBe(true);
  });
});

describe("work record: the contract's own answers", () => {
  // Expected values produced by WorkProof.scan in a Foundry test (see the file's "about").
  const file = vector<{
    counts: { accepted: number; refused: number };
    vectors: { hex: Hex; headLen: number; result: string }[];
  }>("work-record-scan-vectors.json");
  const selectors = vector<{ errors: { workProof: Record<string, string> } }>("abi-selectors.json").errors
    .workProof;

  function answer(hex: Hex, headLen: number): string {
    try {
      const s = scanWorkRecord(hexToBytes(hex), headLen);
      const encoded = encodeAbiParameters(
        [
          { type: "bytes16" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint256[]" },
        ],
        [s.jobIdBytes16, s.recordHash, s.kindHash, s.headHash, s.specHash, s.stateHash, s.agentIds],
      );
      return `ok:${keccak256(encoded)}`;
    } catch (error) {
      if (!(error instanceof WorkRecordError)) throw error;
      if (error.code === "Malformed") {
        return `err:${selectors["Malformed(uint256)"]}${BigInt(error.pos ?? -1)
          .toString(16)
          .padStart(64, "0")}`;
      }
      return `err:${selectors[`${error.code}()`]}`;
    }
  }

  // The vectors are what `WorkProof.scan` answered on the day they were made, and this package's
  // scanner was compared with the contract over all 6,084 cases of that run, not only this sample.
  // Both sides are pinned: if either has changed since, they have to be compared again with
  // scripts/scan-differential/run.sh (`pnpm --filter @help-wanted/shared vectors:scan`).
  const compared = vector<{
    compared: {
      scannerSha256: string;
      casesCompared: number;
      contractCode: Record<string, string>[];
    };
  }>("work-record-scan-vectors.json").compared;

  it("is the scanner that was compared with the contract", () => {
    const source = readFileSync(join(PKG, "src", "workRecord.ts"));
    expect(
      sha256(new Uint8Array(source)).slice(2),
      "src/workRecord.ts changed since it was compared with the contract: run packages/shared/scripts/scan-differential/run.sh",
    ).toBe(compared.scannerSha256);
    expect(compared.casesCompared).toBeGreaterThanOrEqual(6000);
  });

  it("was compared with the contract code that is in the repository now", (ctx) => {
    const names = ["JsonScan.sol", "WorkProof.sol"];
    const paths = names.map((name) => repoFile("launches", "b-desk", "src", "proof", name));
    if (paths.some((p) => p === null)) return ctx.skip();
    const now: Record<string, string> = {};
    names.forEach((name, i) => {
      // Comments and layout do not change what a contract answers; any change to its code may.
      const code = readFileSync(paths[i] as string, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\s+/g, "");
      now[name] = sha256(stringToBytes(code)).slice(2);
    });
    expect(compared.contractCode.length).toBeGreaterThan(0);
    expect(
      compared.contractCode.some((known) => names.every((name) => known[name] === now[name])),
      "JsonScan.sol or WorkProof.sol changed in code since the scanner was compared with them: run packages/shared/scripts/scan-differential/run.sh",
    ).toBe(true);
  });

  it("has hundreds of cases, accepted and refused", () => {
    expect(file.vectors.length).toBeGreaterThanOrEqual(500);
    expect(file.counts.accepted).toBeGreaterThanOrEqual(50);
    expect(file.counts.refused).toBeGreaterThanOrEqual(300);
  });

  it("gives the answer the contract gives for every one of them, error and byte offset included", () => {
    const wrong: string[] = [];
    file.vectors.forEach((v, i) => {
      const got = answer(v.hex, v.headLen);
      if (got !== v.result) wrong.push(`#${i}: contract ${v.result}, here ${got}`);
    });
    expect(wrong).toEqual([]);
  });
});

describe("work record: bytes, not text", () => {
  const BOM = "\u{feff}";
  const plain = (members: Partial<Record<"jobId" | "schema" | "state", string>> = {}): Uint8Array =>
    stringToBytes(
      `{"jobId":"${members.jobId ?? JOB}","kind":"audit","objective":"o",` +
        `"schema":"${members.schema ?? WORK_RECORD_SCHEMA}","state":"${members.state ?? "completed"}"}`,
    );

  it("refuses a jobId with a byte order mark in front, at the offset the contract reports", () => {
    // A text decoder drops a leading EF BB BF; the contract counts 39 bytes where a UUID has 36.
    const error = errorOf(() => scanWorkRecord(plain({ jobId: `${BOM}${JOB}` }), 0));
    expect(error.code).toBe("Malformed");
    expect(error.pos).toBe(9);
  });

  it("refuses a schema with a byte order mark in front", () => {
    expect(errorOf(() => scanWorkRecord(plain({ schema: `${BOM}${WORK_RECORD_SCHEMA}` }), 0)).code).toBe(
      "WrongSchema",
    );
  });

  it("refuses a jobId or schema spelled with an escape that only decodes to the right text", () => {
    expect(errorOf(() => scanWorkRecord(plain({ jobId: `\\u0065${JOB.slice(1)}` }), 0)).code).toBe(
      "Malformed",
    );
    expect(
      errorOf(() => scanWorkRecord(plain({ schema: `\\u0069${WORK_RECORD_SCHEMA.slice(1)}` }), 0)).code,
    ).toBe("WrongSchema");
  });

  it("says completed only for the bytes the desk hashes, whatever the text decodes to", () => {
    const good = scanWorkRecord(plain(), 0);
    expect(good.completed).toBe(true);
    expect(good.stateHash).toBe(WORK_RECORD_COMPLETED_HASH);
    expect(WORK_RECORD_COMPLETED_HASH).toBe(kindHash("completed"));
    for (const spelling of [`${BOM}completed`, "\\u0063ompleted"]) {
      const odd = scanWorkRecord(plain({ state: spelling }), 0);
      // The text is for reading, and reads the same or nearly; the hash and the flag do not.
      expect(odd.state.replace(BOM, "")).toBe("completed");
      expect(odd.stateHash).not.toBe(WORK_RECORD_COMPLETED_HASH);
      expect(odd.completed).toBe(false);
    }
    expect(scanWorkRecord(plain({ state: "blocked" }), 0).completed).toBe(false);
  });
});

describe("work record: the proof area's fixtures", () => {
  // That area keeps its records either as the served bytes (`.json`) or as hexadecimal text of
  // them (`.hex`, a `0x` prefix and no newline). Either way these are the bytes that were served.
  const servedBytes = (path: string): Uint8Array =>
    path.endsWith(".hex") ? hexToBytes(readFileSync(path, "utf8").trim() as Hex) : readBytes(path);
  // A signal whose last member is "value": 0 records a rejected submission and names nobody.
  const namesAnAgent = (signal: Record<string, unknown>): boolean => {
    const keys = Object.keys(signal);
    return !(keys.length > 1 && keys.at(-1) === "value" && signal.value === 0);
  };

  interface ProofFixture {
    file: string;
    jobId: string;
    jobIdBytes16: Hex;
    recordHash: Hex;
    size: number;
    kind: string;
    kindHash: Hex;
    state: string;
    stateHash: Hex;
    objectiveStart: number;
    objectiveRawLen: number;
    objectiveHash: Hex;
    agentIds: number[];
  }

  it("scan every record there to the values its index expects", (ctx) => {
    const indexPath = repoFile("launches", "b-desk", "test", "fixtures", "proof", "index.json");
    if (!indexPath) return ctx.skip();
    const index = readJson<{ fixtures: ProofFixture[] }>(indexPath);
    let checked = 0;
    for (const f of index.fixtures) {
      const path = repoFile("launches", "b-desk", "test", "fixtures", "proof", f.file);
      if (!path) continue;
      const bytes = servedBytes(path);
      const scan = scanWorkRecord(bytes, 0);
      expect(bytes.length, f.file).toBe(f.size);
      expect(scan.recordHash, f.file).toBe(f.recordHash);
      expect(scan.jobId, f.file).toBe(f.jobId);
      expect(scan.jobIdBytes16, f.file).toBe(f.jobIdBytes16);
      expect(scan.kind, f.file).toBe(f.kind);
      expect(scan.kindHash, f.file).toBe(f.kindHash);
      expect(scan.state, f.file).toBe(f.state);
      expect(scan.stateHash, f.file).toBe(f.stateHash);
      expect(scan.objectiveRaw.byteOffset - bytes.byteOffset, f.file).toBe(f.objectiveStart);
      expect(scan.objectiveRaw.length, f.file).toBe(f.objectiveRawLen);
      expect(scan.specHash, f.file).toBe(f.objectiveHash);
      expect(scan.agentIds.map(Number), f.file).toEqual(f.agentIds);
      // And against a full JSON parse of the same bytes.
      const doc = JSON.parse(bytesToString(bytes)) as { objective: string; kind: string; state: string };
      expect(scan.objective, f.file).toBe(doc.objective);
      checked++;
    }
    // Every record that is there must agree, and that was checked above. That area's files are its
    // own to move and to rebuild: when some that the index lists are missing (a rebuild in progress,
    // a partial checkout), the comparison is incomplete, and is reported as skipped, not as passed.
    if (checked < index.fixtures.length) return ctx.skip();
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  it("agree with a JSON parse on every record file present", (ctx) => {
    const dir = repoFile("launches", "b-desk", "test", "fixtures", "proof", "records");
    if (!dir) return ctx.skip();
    const names = readdirSync(dir).filter((n) => n.endsWith(".json") || n.endsWith(".hex"));
    if (names.length === 0) return ctx.skip();
    for (const name of names) {
      const bytes = servedBytes(join(dir, name));
      const doc = JSON.parse(bytesToString(bytes)) as {
        jobId: string;
        kind: string;
        objective: string;
        state: string;
        signals: ({ agentId: string } & Record<string, unknown>)[];
      };
      const scan = scanWorkRecord(bytes);
      expect(scan.jobId, name).toBe(doc.jobId);
      expect(scan.kind, name).toBe(doc.kind);
      expect(scan.objective, name).toBe(doc.objective);
      expect(scan.state, name).toBe(doc.state);
      const ids = [...new Set(doc.signals.filter(namesAnAgent).map((s) => s.agentId))].slice(
        0,
        MAX_AGENT_IDS,
      );
      expect(scan.agentIds.map(String), name).toEqual(ids);
    }
  });
});

describe("work record: checking served bytes", () => {
  it("accepts the bytes as served", () => {
    const checked = checkRecordBytes(real(), RECEIPT);
    expect(checked.strippedNewline).toBe(false);
    expect(checked.recordHash).toBe(RECEIPT);
    expect(checked.bytes.length).toBe(7339);
  });

  it("removes exactly one trailing newline when that is what makes the hash match", () => {
    const withNewline = new Uint8Array([...real(), 0x0a]);
    const checked = checkRecordBytes(withNewline, RECEIPT.slice(2));
    expect(checked.strippedNewline).toBe(true);
    expect(checked.bytes.length).toBe(7339);
    expect(keccak256(checked.bytes)).toBe(RECEIPT);
  });

  it("refuses two newlines, a carriage return, a changed byte or an empty body", () => {
    const bytes = real();
    expect(errorOf(() => checkRecordBytes(new Uint8Array([...bytes, 0x0a, 0x0a]), RECEIPT)).code).toBe(
      "HashMismatch",
    );
    expect(errorOf(() => checkRecordBytes(new Uint8Array([...bytes, 0x0d, 0x0a]), RECEIPT)).code).toBe(
      "HashMismatch",
    );
    const flipped = bytes.slice();
    flipped[100] = (flipped[100] as number) ^ 1;
    expect(errorOf(() => checkRecordBytes(flipped, RECEIPT)).code).toBe("HashMismatch");
    expect(errorOf(() => checkRecordBytes(new Uint8Array(0), RECEIPT)).code).toBe("HashMismatch");
  });

  it("builds the URL from 64 hex characters without 0x", () => {
    const want = `https://api.imd.fun/work-records/${RECEIPT.slice(2)}.json`;
    expect(workRecordUrl(RECEIPT)).toBe(want);
    expect(workRecordUrl(RECEIPT.slice(2))).toBe(want);
    expect(workRecordUrl(RECEIPT.toUpperCase().replace("0X", "0x"))).toBe(want);
    expect(workRecordUrl(RECEIPT, "https://example.test/")).toBe(
      `https://example.test/work-records/${RECEIPT.slice(2)}.json`,
    );
    expect(recordHashHex(RECEIPT)).toBe(RECEIPT.slice(2));
    for (const bad of ["0x1234", RECEIPT + "00", "zz".repeat(32), "../../etc/passwd", ""]) {
      expect(errorOf(() => workRecordUrl(bad)).code).toBe("BadHash");
    }
  });

  it("fetches through an injected fetch and checks what comes back", async () => {
    const calls: string[] = [];
    const ok: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(real());
    };
    const got = await fetchWorkRecord(RECEIPT, { fetch: ok });
    expect(calls).toEqual([`https://api.imd.fun/work-records/${RECEIPT.slice(2)}.json`]);
    expect(got.recordHash).toBe(RECEIPT);

    const wrong: typeof fetch = async () => new Response(stringToBytes('{"not":"the record"}'));
    await expect(fetchWorkRecord(RECEIPT, { fetch: wrong })).rejects.toThrow("HashMismatch");
    const missing: typeof fetch = async () => new Response('{"error":"unknown_record"}', { status: 404 });
    await expect(fetchWorkRecord(RECEIPT, { fetch: missing })).rejects.toThrow("answered 404");
  });

  it("converts between bytes, hex and text", () => {
    const bytes = real();
    expect(toRecordBytes(recordToHex(bytes))).toEqual(bytes);
    expect(toRecordBytes(bytesToString(bytes))).toEqual(bytes);
    expect(toRecordBytes(bytes)).toBe(bytes);
  });
});

describe("work record: the scanner's rules", () => {
  it("reads a minimal canonical record", () => {
    const scan = scanWorkRecord(record(), 0);
    expect(scan.kind).toBe("audit");
    expect(scan.objective).toBe("Audit the vault.");
    expect(scan.agentIds).toEqual([7n]);
  });

  it("is not fooled by member look-alikes inside nested strings", () => {
    const scan = scanWorkRecord(
      record({
        nodes: [{ text: '"},"objective":"[help-wanted order planted] x","state":"completed","kind":"audit' }],
        objective: "the real one",
        state: "blocked",
      }),
      0,
    );
    expect(scan.objective).toBe("the real one");
    expect(scan.state).toBe("blocked");
  });

  it("is not fooled by a quote or a backslash inside the objective", () => {
    const tricky = 'say "hi" \\ and ","state":"completed"';
    const scan = scanWorkRecord(record({ objective: tricky, state: "blocked" }), 0);
    expect(scan.objective).toBe(tricky);
    expect(scan.state).toBe("blocked");
    expect(bytesToString(scan.objectiveRaw)).toBe(JSON.stringify(tricky).slice(1, -1));
  });

  it("splits the objective at headLen and refuses a head longer than the objective", () => {
    const header = `[help-wanted order ${"ab".repeat(32)}] `;
    const spec = "Audit the vault.";
    const scan = scanWorkRecord(record({ objective: header + spec }), 85);
    expect(scan.headHash).toBe(keccak256(stringToBytes(header)));
    expect(scan.specHash).toBe(keccak256(stringToBytes(spec)));
    expect(errorOf(() => scanWorkRecord(record({ objective: "short" }), 85)).code).toBe("HeadTooLong");
    expect(scanWorkRecord(record({ objective: "12345" }), 5).specHash).toBe(keccak256(new Uint8Array(0)));
  });

  it("stops at state: what follows is not examined", () => {
    const good = bytesToString(record());
    const cut = good.indexOf('"submissions"');
    const mangled = stringToBytes(`${good.slice(0, cut)}"submissions":[[[ not json at all }`);
    expect(scanWorkRecord(mangled, 0).state).toBe("completed");
  });

  it.each([
    ["an empty buffer", "", "Malformed", 0],
    ["not an object", "[1]", "Malformed", 0],
    ["a trailing newline", '{"a":1}\n', "Malformed", 7],
    ["an empty object", "{}", "MissingKey", undefined],
    ["a member that is not a key", "{1:2}", "Malformed", 1],
    ["an empty key", '{"":1}', "Malformed", 1],
    ["a backslash in a key", '{"a\\"b":1}', "Malformed", 1],
    ["a control byte in a key", '{"a\tb":1}', "Malformed", 1],
    ["a key of 32 bytes", `{"${"a".repeat(32)}":1}`, "Malformed", 1],
    ["no colon", '{"a" 1}', "Malformed", 4],
    ["nothing after the colon", '{"a":', "Malformed", 4],
    ["an unterminated string", '{"a":"x}', "Malformed", 8],
    ["an unterminated array", '{"a":[1,2}', "Malformed", 10],
    ["whitespace before a value", '{"a": 1}', "Malformed", 5],
    ["a missing comma", '{"a":1 "b":2}', "Malformed", 6],
    ["keys out of order", '{"b":1,"a":2}', "Malformed", 7],
    ["a repeated key", '{"a":1,"a":2}', "Malformed", 7],
    ["a top level that ends before state", '{"a":1}', "MissingKey", undefined],
    ["a key that sorts after state", '{"a":1,"zzz":2}', "MissingKey", undefined],
  ])("refuses %s", (_note, text, code, pos) => {
    const error = errorOf(() => scanWorkRecord(stringToBytes(text), 0));
    expect(error.code).toBe(code);
    expect(error.pos).toBe(pos);
  });

  it("refuses a record missing a required member, or with one of the wrong type", () => {
    for (const key of ["jobId", "kind", "objective", "schema", "state"]) {
      expect(errorOf(() => scanWorkRecord(record({}, [key]), 0)).code, key).toBe("MissingKey");
      expect(errorOf(() => scanWorkRecord(record({ [key]: 5 }), 0)).code, key).toBe("Malformed");
      expect(errorOf(() => scanWorkRecord(record({ [key]: null }), 0)).code, key).toBe("Malformed");
    }
  });

  it("refuses another schema, and a job id that is not a lowercase UUID", () => {
    expect(errorOf(() => scanWorkRecord(record({ schema: "identitymd-work-v2" }), 0)).code).toBe(
      "WrongSchema",
    );
    expect(errorOf(() => scanWorkRecord(record({ schema: "" }), 0)).code).toBe("WrongSchema");
    expect(errorOf(() => scanWorkRecord(record({ jobId: JOB.toUpperCase() }), 0)).code).toBe("Malformed");
    expect(errorOf(() => scanWorkRecord(record({ jobId: JOB.replaceAll("-", "") }), 0)).code).toBe(
      "Malformed",
    );
    expect(errorOf(() => scanWorkRecord(record({ jobId: `${JOB}0` }), 0)).code).toBe("Malformed");
  });

  it("reports a record written for another job", () => {
    const other = "00000000-0000-4000-8000-000000000001";
    expect(errorOf(() => scanWorkRecordFor(other, record(), 0)).code).toBe("JobIdMismatch");
    expect(scanWorkRecordFor(JOB, record(), 0).jobId).toBe(JOB);
  });
});

describe("work record: agent ids", () => {
  const ids = (signals: unknown): bigint[] => scanWorkRecord(record({ signals }), 0).agentIds;
  const raw = (signalsJson: string): bigint[] => {
    const text = bytesToString(record({ signals: [] })).replace('"signals":[]', `"signals":${signalsJson}`);
    return scanWorkRecord(stringToBytes(text), 0).agentIds;
  };

  it("lists each id once, in order of first appearance", () => {
    expect(ids([{ agentId: "3" }, { agentId: "1" }, { agentId: "3" }, { agentId: "2" }])).toEqual([
      3n,
      1n,
      2n,
    ]);
  });

  it("is empty for no signals, an empty list, or something that is not a list", () => {
    expect(scanWorkRecord(record({}, ["signals"]), 0).agentIds).toEqual([]);
    expect(ids([])).toEqual([]);
    expect(ids(null)).toEqual([]);
    expect(ids({ agentId: "1" })).toEqual([]);
    expect(ids("52211")).toEqual([]);
  });

  it("keeps the first sixteen distinct ids and reads no further", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ agentId: String(100 + i) }));
    expect(ids(many)).toEqual(Array.from({ length: 16 }, (_, i) => BigInt(100 + i)));
    // The seventeenth element is never read, so its shape no longer matters.
    const sixteen = many
      .slice(0, 16)
      .map((s) => JSON.stringify(s))
      .join(",");
    expect(raw(`[${sixteen},{"other":true}]`)).toHaveLength(16);
  });

  it("gives an empty list, never a partial one, when an element that is read has another shape", () => {
    expect(raw('[{"agentId":"1"},{"agentId":2}]')).toEqual([]);
    expect(raw('[{"agentId":"1"},{"value":1}]')).toEqual([]);
    expect(raw('[{"agentId":""}]')).toEqual([]);
    expect(raw('[{"agentId":"12x"}]')).toEqual([]);
    expect(raw('[{"agentId":"-1"}]')).toEqual([]);
    expect(raw('[5,{"agentId":"1"}]')).toEqual([]);
    expect(raw('[{"agentId":"1"}{"agentId":"2"}]')).toEqual([]);
  });

  it("reads ids of up to 77 digits and refuses a 78th", () => {
    const d77 = "9".repeat(77);
    expect(raw(`[{"agentId":"${d77}"}]`)).toEqual([BigInt(d77)]);
    expect(raw(`[{"agentId":"${d77}9"}]`)).toEqual([]);
    expect(raw('[{"agentId":"007"}]')).toEqual([7n]);
  });

  it("skips the rest of each element by structure", () => {
    expect(raw('[{"agentId":"5","tag1":"a]}\\"","nested":{"x":[1,{"y":"}"}]}},{"agentId":"6"}]')).toEqual([
      5n,
      6n,
    ]);
  });
});
