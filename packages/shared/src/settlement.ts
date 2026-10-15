/**
 * What a work record means for one claim of an order, by the desk's own tests.
 *
 * `WorkOrders.settle`, `stamp` and `reportFailed` all ask WorkProof the same five things about a
 * record and compare them as hashes: is it this job's, did it end `completed`, is its kind the
 * order's, does its objective start with this claim's header, and does it continue with the
 * order's spec. `judgeRecord` asks them in the same way, off chain, so that a bot never pays gas
 * for a call that would revert and never stakes a bond on a record that cannot be proven.
 *
 * Nothing here consults the WorkRegistry: whether the record is the job's receipt is a separate
 * question (`WorkRegistry.latest(jobId)` must equal the record's hash).
 */
import type { Hex } from "viem";
import { HEADER_LENGTH, orderHeadHash } from "./order.js";
import { WORK_RECORD_COMPLETED_HASH, WorkRecordError, scanWorkRecordFor } from "./workRecord.js";

/** The claim a record is judged against. */
export interface ClaimTerms {
  /** The registered job: a UUID, or the desk's `bytes16`. */
  jobId: string;
  /** `ticketOf(id)`: the ticket of the claim whose header the objective must carry. */
  ticket: Hex;
  /** `orderOf(id).specHash`. */
  specHash: Hex;
  /** `orderOf(id).kindHash`. */
  kindHash: Hex;
}

export type RecordVerdict =
  /** `settle` (or `stamp`) would accept it. */
  | { kind: "settles"; recordHash: Hex; agentIds: bigint[] }
  /**
   * This claim's objective, but the job did not end `completed`. While the job is only registered
   * the runner alone may report it, and gets its whole bond back. After a delivery claim anyone
   * may, and the runner loses the bond.
   */
  | { kind: "not_completed"; recordHash: Hex; state: string }
  /**
   * This claim's objective and `completed`, under another kind than the order's. It can never
   * settle. Anyone may report it; while the job is only registered the bond returns to the runner.
   */
  | { kind: "wrong_kind"; recordHash: Hex; recordKind: string }
  /**
   * Another objective than this claim's (one too short to hold a header included): the registered
   * job is not this claim's. Anyone may report it, and the bond goes to the employer.
   */
  | { kind: "other_objective"; recordHash: Hex | null }
  /** Not a record WorkProof could read, or not this job's: it decides nothing either way. */
  | { kind: "unreadable"; why: string };

/** Whether `reportFailed` would accept the record (any verdict but the first and the last). */
export function refutes(verdict: RecordVerdict): boolean {
  return (
    verdict.kind === "not_completed" || verdict.kind === "wrong_kind" || verdict.kind === "other_objective"
  );
}

/**
 * Reads a record as the desk will. Everything is compared as the hashes the desk compares, never
 * as decoded text: two different byte strings can decode to the same text.
 */
export function judgeRecord(claim: ClaimTerms, record: Uint8Array): RecordVerdict {
  let scan;
  try {
    scan = scanWorkRecordFor(claim.jobId, record, HEADER_LENGTH);
  } catch (error) {
    // An objective shorter than a header cannot be this claim's; the desk reads it the same way
    // (WorkProof answers `HeadTooLong`, and `reportFailed` then proves the record with no header).
    if (error instanceof WorkRecordError && error.code === "HeadTooLong") {
      return { kind: "other_objective", recordHash: null };
    }
    return { kind: "unreadable", why: error instanceof Error ? error.message : String(error) };
  }
  const sameObjective =
    scan.headHash === orderHeadHash(claim.ticket) &&
    scan.specHash.toLowerCase() === claim.specHash.toLowerCase();
  if (!sameObjective) return { kind: "other_objective", recordHash: scan.recordHash };
  if (scan.stateHash !== WORK_RECORD_COMPLETED_HASH) {
    return { kind: "not_completed", recordHash: scan.recordHash, state: scan.state };
  }
  if (scan.kindHash.toLowerCase() !== claim.kindHash.toLowerCase()) {
    return { kind: "wrong_kind", recordHash: scan.recordHash, recordKind: scan.kind };
  }
  return { kind: "settles", recordHash: scan.recordHash, agentIds: scan.agentIds };
}
