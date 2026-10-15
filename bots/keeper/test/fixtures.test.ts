import { readFileSync } from "node:fs";
import { keccak256, stringToBytes } from "viem";
import { describe, expect, it } from "vitest";
import { canonicalize, scanWorkRecord } from "@help-wanted/shared";

/**
 * The integration tests build every work record from one real one: the record of the job that
 * carried our order header through IdentityMD on 13 October 2026.
 */
describe("the work record the integration tests are built from", () => {
  const bytes = new Uint8Array(readFileSync(new URL("./fixtures/header-job-record.json", import.meta.url)));

  it("is the real record of job e70c56ce, byte for byte: its hash is the one IdentityMD lists", () => {
    expect(keccak256(bytes)).toBe("0x990ae775288252e4b1b12c4a85bbe66db0140ca733e30002a6525814bfdaa17d");
    // As served: no trailing newline.
    expect(bytes[bytes.length - 1]).toBe(0x7d);
  });

  it("is canonical JSON: written again from its parsed form it is the same bytes", () => {
    const text = new TextDecoder().decode(bytes);
    expect(canonicalize(JSON.parse(text))).toBe(text);
    expect(keccak256(stringToBytes(canonicalize(JSON.parse(text))))).toBe(keccak256(bytes));
  });

  it("carries the header at byte 0 of its objective, the kind of its template, and its agent", () => {
    const scan = scanWorkRecord(bytes, 85);
    expect(scan.jobId).toBe("e70c56ce-60f0-4c2c-b413-67e5ae37ddce");
    expect(scan.kind).toBe("skill:research-report");
    expect(scan.completed).toBe(true);
    expect(scan.objective.startsWith("[help-wanted order ")).toBe(true);
    expect(scan.objective.slice(83, 85)).toBe("] ");
    expect(scan.agentIds).toEqual([52715n]);
  });
});
