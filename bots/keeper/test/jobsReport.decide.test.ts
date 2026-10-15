import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { decideJobsReport, isTheStoredList, type CrownCandidate } from "../src/modules/jobsReport.js";
import { JOBS_REPORT, jobsReport } from "./factories.js";

const LIST = encodeAbiParameters(
  [{ type: "address[]" }],
  [
    [
      "0x21919137E69eD667AC404c7fCB71b8179B645f46",
      "0x9FADAB91f6Fa03dBD7f4f8a08A338704baACF63f",
      "0x7B8c742f2e1eeB3fB2c10D72967Fa6D4A22F0479",
    ].map((a) => a.toLowerCase() as Hex),
  ],
);
const STORED = BigInt(keccak256(LIST));

const candidate = (over: Partial<CrownCandidate> = {}): CrownCandidate => ({
  round: 4n,
  status: 2,
  value: STORED,
  crowned: false,
  answer: { kind: "known", bytes: LIST, oracleRequestId: "2cbe6bb3-13f9-4617-98b9-5d83754f9e1a" },
  ...over,
});

const kinds = (snapshot = jobsReport()) => decideJobsReport(snapshot).actions.map((a) => a.kind);

describe("printing", () => {
  it("sends nothing when the report has read every answered round", () => {
    const decision = decideJobsReport(jobsReport());
    expect(decision).toEqual({ actions: [], waiting: [] });
  });

  it("prints when a payrolls round is answered and not read", () => {
    const decision = decideJobsReport(jobsReport({ payrolls: { rounds: 4n, latestRound: 4n } }));
    expect(decision.actions).toHaveLength(1);
    expect(decision.actions[0]?.call).toMatchObject({
      address: JOBS_REPORT,
      functionName: "print",
      args: [],
    });
    expect(decision.actions[0]?.reason).toContain("payrolls round 4 is answered and the report has read 3");
  });

  it("prints when a hires round is answered and not read: neither feed waits for the other", () => {
    const decision = decideJobsReport(jobsReport({ hires: { rounds: 4n, latestRound: 4n } }));
    expect(decision.actions.map((a) => a.kind)).toEqual(["print"]);
    expect(decision.actions[0]?.reason).toContain("hires round 4");
  });

  it("prints once for both, with both reasons", () => {
    const decision = decideJobsReport(
      jobsReport({ payrolls: { rounds: 5n, latestRound: 5n }, hires: { rounds: 4n, latestRound: 4n } }),
    );
    expect(decision.actions).toHaveLength(1);
    expect(decision.actions[0]?.reason).toContain("payrolls round 5");
    expect(decision.actions[0]?.reason).toContain("hires round 4");
  });

  it("does not print for a round that is only pending, or only failed", () => {
    // A fourth round was opened and has no answer: the newest answered round is still the third.
    expect(
      kinds(
        jobsReport({ payrolls: { rounds: 4n, latestRound: 3n }, hires: { rounds: 4n, latestRound: 3n } }),
      ),
    ).toEqual([]);
  });

  it("prints to work off a backlog of pairing, and not when one series has nothing left to pair", () => {
    const base = jobsReport().summary;
    expect(
      kinds(jobsReport({ summary: { ...base, prints: 5n, counts: 5n, pairedPrints: 3n, pairedCounts: 4n } })),
    ).toEqual(["print"]);
    // Prints are waiting and every count is settled: a call would pair nothing.
    expect(
      kinds(jobsReport({ summary: { ...base, prints: 5n, counts: 3n, pairedPrints: 3n, pairedCounts: 3n } })),
    ).toEqual([]);
    expect(
      kinds(jobsReport({ summary: { ...base, prints: 3n, counts: 5n, pairedPrints: 3n, pairedCounts: 3n } })),
    ).toEqual([]);
  });

  it("prints the first day: nothing read, one round answered", () => {
    const empty = {
      ...jobsReport().summary,
      prints: 0n,
      counts: 0n,
      payrollsRead: 0n,
      hiresRead: 0n,
      pairedPrints: 0n,
      pairedCounts: 0n,
    };
    expect(
      kinds(
        jobsReport({
          summary: empty,
          payrolls: { rounds: 1n, latestRound: 1n },
          hires: { rounds: 1n, latestRound: 0n },
        }),
      ),
    ).toEqual(["print"]);
    expect(
      kinds(
        jobsReport({
          summary: empty,
          payrolls: { rounds: 1n, latestRound: 0n },
          hires: { rounds: 1n, latestRound: 0n },
        }),
      ),
    ).toEqual([]);
  });
});

describe("crowning", () => {
  it("crowns an answered round with the attested list, once its hash is the stored word", () => {
    const decision = decideJobsReport(jobsReport({ crownCandidates: [candidate()] }));
    expect(decision.actions).toHaveLength(1);
    expect(decision.actions[0]?.kind).toBe("crown");
    expect(decision.actions[0]?.call).toMatchObject({
      address: JOBS_REPORT,
      functionName: "crown",
      args: [4n, LIST],
    });
    expect(isTheStoredList(LIST, STORED)).toBe(true);
  });

  it("never sends a list that does not hash to what Questions stored", () => {
    const other = encodeAbiParameters([{ type: "address[]" }], [[JOBS_REPORT]]);
    expect(isTheStoredList(other, STORED)).toBe(false);
    const decision = decideJobsReport(
      jobsReport({
        crownCandidates: [candidate({ answer: { kind: "known", bytes: other, oracleRequestId: "x" } })],
      }),
    );
    expect(decision.actions).toEqual([]);
    expect(decision.waiting[0]).toMatchObject({ attention: true });
    expect(decision.waiting[0]?.reason).toContain("does not hash to the word Questions stored");
    // One wei off in the stored word is another list.
    expect(
      decideJobsReport(jobsReport({ crownCandidates: [candidate({ value: STORED + 1n })] })).actions,
    ).toEqual([]);
  });

  it("leaves a round that is already crowned, pending or failed alone", () => {
    expect(kinds(jobsReport({ crownCandidates: [candidate({ crowned: true })] }))).toEqual([]);
    expect(kinds(jobsReport({ crownCandidates: [candidate({ status: 1 })] }))).toEqual([]);
    expect(kinds(jobsReport({ crownCandidates: [candidate({ status: 3 })] }))).toEqual([]);
    expect(decideJobsReport(jobsReport({ crownCandidates: [candidate({ crowned: true })] })).waiting).toEqual(
      [],
    );
  });

  it("notes a list it could not fetch, without asking for attention: the report is complete without it", () => {
    const decision = decideJobsReport(
      jobsReport({
        crownCandidates: [
          candidate({ answer: { kind: "unknown", detail: "the attestation could not be read" } }),
        ],
      }),
    );
    expect(decision.actions).toEqual([]);
    expect(decision.waiting).toHaveLength(1);
    expect(decision.waiting[0]?.attention).toBeUndefined();
    expect(decision.waiting[0]?.reason).toContain("complete without it");
  });

  it("prints and crowns in the same decision, the print first", () => {
    expect(
      kinds(jobsReport({ payrolls: { rounds: 4n, latestRound: 4n }, crownCandidates: [candidate()] })),
    ).toEqual(["print", "crown"]);
  });
});
