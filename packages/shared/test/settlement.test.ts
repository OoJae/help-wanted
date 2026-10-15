import { readFileSync } from "node:fs";
import { keccak256, stringToBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  DESK,
  JOB_TEMPLATES,
  SETTLE_GAS,
  canonicalize,
  challengeEndsAt,
  claimWindowEndsAt,
  deliveryDeadline,
  judgeRecord,
  kindHash,
  largestSettleableRecord,
  lastDeliveryClaimAt,
  orderHeader,
  orderTicket,
  proofGasNeeded,
  refutes,
  settleGasNeeded,
  silenceSeconds,
  specHash,
  uuidToBytes16,
  type ClaimTerms,
} from "../src/index.js";
import { repoFile } from "./paths.js";

const JOB = "8d2f6c1e-4b3a-4f5d-9c7e-1a2b3c4d5e6f";
const SPEC = "Write a sourced report on who paid the swarm this week. Inputs: week=41";
const TICKET = orderTicket({
  chainId: 1,
  workOrders: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  orderId: 7n,
  claimSeq: 1,
  runner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
});
const CLAIM: ClaimTerms = {
  jobId: JOB,
  ticket: TICKET,
  specHash: specHash(SPEC),
  kindHash: kindHash("skill:research-report"),
};

function record(
  over: { jobId?: string; objective?: string; kind?: string; state?: string; agents?: unknown[] } = {},
) {
  return stringToBytes(
    canonicalize({
      assessments: [],
      jobId: over.jobId ?? JOB,
      kind: over.kind ?? "skill:research-report",
      nodes: [],
      objective: over.objective ?? orderHeader(TICKET) + SPEC,
      schema: "identitymd-work-v1",
      signals: over.agents ?? [{ agentId: "52211", value: 1 }],
      state: over.state ?? "completed",
      submissions: [],
    }),
  );
}

describe("judgeRecord: what a record means for a claim, by the desk's own tests", () => {
  it("settles: this job, completed, the order's kind, this claim's header, the order's spec", () => {
    const bytes = record();
    const verdict = judgeRecord(CLAIM, bytes);
    expect(verdict).toEqual({ kind: "settles", recordHash: keccak256(bytes), agentIds: [52211n] });
    expect(refutes(verdict)).toBe(false);
    // The job may be named as the desk stores it.
    expect(judgeRecord({ ...CLAIM, jobId: uuidToBytes16(JOB) }, bytes).kind).toBe("settles");
    // Hashes are compared without regard to the case of their hex digits.
    expect(
      judgeRecord({ ...CLAIM, specHash: CLAIM.specHash.toUpperCase().replace("0X", "0x") as Hex }, bytes)
        .kind,
    ).toBe("settles");
  });

  it("not completed: the swarm failed a job that was opened correctly", () => {
    const verdict = judgeRecord(CLAIM, record({ state: "blocked" }));
    expect(verdict).toMatchObject({ kind: "not_completed", state: "blocked" });
    expect(refutes(verdict)).toBe(true);
  });

  it("wrong kind: completed under another template than the order pins", () => {
    const verdict = judgeRecord(CLAIM, record({ kind: "research" }));
    expect(verdict).toMatchObject({ kind: "wrong_kind", recordKind: "research" });
    expect(refutes(verdict)).toBe(true);
  });

  it("a state other than completed is reported before a wrong kind, as the desk classes it", () => {
    // `reportFailed` lets only the runner report a not-completed receipt with the right
    // objective, whatever its kind: the state is looked at first.
    expect(judgeRecord(CLAIM, record({ kind: "research", state: "blocked" })).kind).toBe("not_completed");
  });

  it("other objective: another claim's header, another spec, or no room for a header", () => {
    const otherTicket = orderTicket({
      chainId: 1,
      workOrders: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      orderId: 7n,
      claimSeq: 2,
      runner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    });
    for (const objective of [
      orderHeader(otherTicket) + SPEC,
      `${orderHeader(TICKET)}${SPEC} and something more`,
      `${orderHeader(TICKET)}${SPEC.slice(1)}`,
      SPEC,
    ]) {
      const verdict = judgeRecord(CLAIM, record({ objective }));
      expect(verdict.kind, objective.slice(0, 40)).toBe("other_objective");
      expect(refutes(verdict)).toBe(true);
    }
    // Shorter than a header: WorkProof answers HeadTooLong and the desk proves it with no header.
    expect(judgeRecord(CLAIM, record({ objective: "short" }))).toEqual({
      kind: "other_objective",
      recordHash: null,
    });
  });

  it("unreadable: another job's record, or bytes WorkProof would not read, decide nothing", () => {
    const other = judgeRecord(CLAIM, record({ jobId: "00000000-0000-4000-8000-000000000001" }));
    expect(other.kind).toBe("unreadable");
    expect(refutes(other)).toBe(false);
    const withNewline = new Uint8Array([...record(), 0x0a]);
    expect(judgeRecord(CLAIM, withNewline).kind).toBe("unreadable");
    expect(judgeRecord(CLAIM, stringToBytes("not json")).kind).toBe("unreadable");
  });

  it("a superseding record that names no agents still settles, with an empty list", () => {
    expect(judgeRecord(CLAIM, record({ agents: [] }))).toMatchObject({ kind: "settles", agentIds: [] });
  });
});

describe("the deadlines of a claim", () => {
  const claimedAt = 1_791_662_400;
  const registeredAt = claimedAt + 1_200;
  const deliverySecs = 7 * 86_400;

  it("the claim window is one hour from the claim", () => {
    expect(claimWindowEndsAt(claimedAt)).toBe(BigInt(claimedAt + 3_600));
    expect(claimWindowEndsAt(BigInt(claimedAt))).toBe(BigInt(claimedAt + DESK.CLAIM_WINDOW));
  });

  it("the delivery deadline runs from the first registration, and is zero before it", () => {
    expect(deliveryDeadline({ registeredAt, deliverySecs })).toBe(BigInt(registeredAt + deliverySecs));
    expect(deliveryDeadline({ registeredAt: 0, deliverySecs })).toBe(0n);
  });

  it("a delivery claim must be made 48 hours before the delivery deadline", () => {
    expect(lastDeliveryClaimAt({ registeredAt, deliverySecs })).toBe(
      BigInt(registeredAt + deliverySecs - 172_800),
    );
    // With the three-day minimum a job has one day to complete on the claimed path.
    expect(lastDeliveryClaimAt({ registeredAt, deliverySecs: DESK.MIN_DELIVERY })).toBe(
      BigInt(registeredAt + 86_400),
    );
    expect(lastDeliveryClaimAt({ registeredAt: 0, deliverySecs })).toBe(0n);
  });

  it("the challenge window is 24 hours from the delivery claim", () => {
    expect(challengeEndsAt(registeredAt + 500)).toBe(BigInt(registeredAt + 500 + 86_400));
    expect(challengeEndsAt(0)).toBe(0n);
  });
});

describe("the gas a settlement must be offered", () => {
  it("grows with the record: calldata and the proof per byte, on top of the desk's offer", () => {
    expect(settleGasNeeded(0)).toBe(SETTLE_GAS.TX_BASE + SETTLE_GAS.DESK_OFFER);
    expect(settleGasNeeded(7_339)).toBe(21_000n + 7_339n * 35n + 1_800_000n);
    expect(settleGasNeeded(7_339)).toBeLessThan(3_000_000n);
    expect(settleGasNeeded(100_000)).toBeGreaterThan(5_000_000n);
    expect(settleGasNeeded(1_000n)).toBe(settleGasNeeded(1_000));
    expect(() => settleGasNeeded(-1)).toThrow(RangeError);
  });

  it("is never under the calldata floor a transaction is charged whatever it executes", () => {
    for (const bytes of [0, 1, 3_500, 60_000, 128_000, 600_000]) {
      expect(settleGasNeeded(bytes) >= 21_000n + BigInt(bytes) * 40n, String(bytes)).toBe(true);
      expect(proofGasNeeded(bytes) >= 21_000n + BigInt(bytes) * 40n, String(bytes)).toBe(true);
    }
    // For a very large record the floor is what counts.
    expect(settleGasNeeded(600_000)).toBe(21_000n + 600_000n * 40n);
  });

  it("stamp and reportFailed read the record and pay nobody through Payroll", () => {
    expect(proofGasNeeded(7_339)).toBe(21_000n + 7_339n * 35n + 250_000n);
    expect(proofGasNeeded(7_339)).toBeLessThan(settleGasNeeded(7_339));
    expect(() => proofGasNeeded(-1)).toThrow(RangeError);
  });

  it("gives the largest record that fits a gas limit, and the two agree at the boundary", () => {
    const limit = 3_000_000n;
    const largest = largestSettleableRecord(limit);
    expect(largest).toBe(33_685);
    expect(settleGasNeeded(largest) <= limit).toBe(true);
    expect(settleGasNeeded(largest + 1) > limit).toBe(true);
    expect(largestSettleableRecord(1_000_000n)).toBe(0);
    expect(largestSettleableRecord(SETTLE_GAS.TX_BASE + SETTLE_GAS.DESK_OFFER)).toBe(0);
  });

  it("every kind a runner opens by default has only been seen with records that settle in 3M gas", () => {
    for (const kind of ["skill:research-report", "skill:create-image", "skill:create-video"]) {
      const template = JOB_TEMPLATES[kind];
      expect(template, kind).toBeDefined();
      expect(settleGasNeeded(template?.largestRecordSeen ?? 0) <= 3_000_000n, kind).toBe(true);
    }
    // An audit's record does not: such an order needs the claimed path or the chunked proof.
    expect(settleGasNeeded(JOB_TEMPLATES.audit?.largestRecordSeen ?? 0) > 3_000_000n).toBe(true);
    expect(JOB_TEMPLATES.audit?.largeRecords).toBe(true);
  });
});

describe("the silence deadline of a Standing Questions round", () => {
  it("is twelve hours to sign, the answer's validity, the clock tolerance and one second", () => {
    expect(silenceSeconds(86_400)).toBe(129_901n);
    expect(silenceSeconds(86_400n)).toBe(36n * 3600n + 5n * 60n + 1n);
    expect(silenceSeconds(60)).toBe(43_200n + 60n + 300n + 1n);
  });

  it("is the sum the contract itself computes", (ctx) => {
    const questions = repoFile("launches", "a-payroll", "src", "questions", "Questions.sol");
    if (!questions) return ctx.skip("launches/a-payroll/src is absent");
    const source = readFileSync(questions, "utf8");
    expect(source).toContain(
      "closableAt = uint256(r.requestedAt) + ABANDON_AFTER_SILENCE + validFor + ISSUED_AT_TOLERANCE + 1;",
    );
  });
});

describe("the desk's figures these helpers mirror", () => {
  it("are the ones WorkOrders.sol fixes", (ctx) => {
    const desk = repoFile("launches", "b-desk", "src", "desk", "WorkOrders.sol");
    if (!desk) return ctx.skip("launches/b-desk/src is absent");
    const source = readFileSync(desk, "utf8");
    // The deadlines: one hour to register, 24 hours to challenge, 24 more to decide.
    expect(source).toContain("uint256 public constant CLAIM_WINDOW = 1 hours;");
    expect(source).toContain("uint256 public constant CHALLENGE_WINDOW = 24 hours;");
    expect(source).toContain("uint256 public constant DISPUTE_WINDOW = 24 hours;");
    expect(source).toContain("if (block.timestamp >= c.claimedAt + CLAIM_WINDOW) revert TooLate();");
    expect(source).toContain(
      "if (until + DISPUTE_WINDOW > uint256(c.registeredAt) + o.deliverySecs) revert TooLate();",
    );
    expect(source).toContain("if (block.timestamp < c.assertedAt + CHALLENGE_WINDOW) revert TooEarly();");
    expect(source).toContain(
      "if (block.timestamp < uint256(c.registeredAt) + o.deliverySecs) revert TooEarly();",
    );
    // The gas rule: each Payroll call is offered a million gas or the settlement is refused.
    expect(source).toContain("uint256 public constant PAYROLL_GAS = 1_000_000;");
    expect(source).toContain("if (gasleft() < PAYROLL_GAS * 64 / 63 + GAS_SLACK) revert GasShort();");
    // What judgeRecord mirrors: the four checks of `_requireSettles`, and reportFailed's order.
    expect(source).toContain("if (proof.stateHash != COMPLETED) revert NotCompleted();");
    expect(source).toContain("if (proof.kindHash != o.kindHash) revert WrongKind();");
    expect(source).toContain("if (proof.headHash != _headHash(id, o, c)) revert WrongHeader();");
    expect(source).toContain("if (proof.specHash != o.specHash) revert WrongSpec();");
    expect(source).toContain("if (!completed && msg.sender != c.runner) revert NotRunner();");
  });
});
