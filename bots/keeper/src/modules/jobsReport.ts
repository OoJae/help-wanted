/**
 * The jobsReport module: print the Robot Jobs Report, and crown the Employers of the Week.
 *
 * `decideJobsReport` is a pure function of a snapshot.
 *
 * print   `JobsReport.print()` copies answered rounds of the payrolls and hires feeds into the
 *         report, at most eight a call, and pairs counts with prints. It is called when either
 *         feed has an answered round the report has not read, or when prints and counts are both
 *         waiting to be paired. A call with nothing to do would change nothing, so none is sent.
 * crown   `JobsReport.crown(round, answer)` publishes the top three of an answered round of the
 *         employers feed. Questions stores only the hash of the list, so the list itself comes
 *         from the attestation IdentityMD's API serves; it is sent only when its hash is the word
 *         Questions stored. The report is complete without a crown: one that cannot be made is
 *         noted and nothing else waits for it.
 */
import { keccak256, type Abi, type Address, type Hex } from "viem";
import { ROUND_STATUS, jobsReportAbi } from "@help-wanted/shared";
import type { Action, Decision, Waiting } from "../actions.js";

const JOBS_REPORT_ABI = jobsReportAbi as unknown as Abi;

export interface CrownCandidate {
  round: bigint;
  /** `IQuestions.RoundStatus` of the employers round. */
  status: number;
  /** The word Questions stored: `uint256(keccak256(answer))`. */
  value: bigint;
  crowned: boolean;
  /** The attested list, as IdentityMD's API serves it. */
  answer: { kind: "known"; bytes: Hex; oracleRequestId: string } | { kind: "unknown"; detail: string };
}

export interface JobsReportSnapshot {
  jobsReport: Address;
  summary: {
    prints: bigint;
    counts: bigint;
    payrollsRead: bigint;
    hiresRead: bigint;
    pairedPrints: bigint;
    pairedCounts: bigint;
    crowns: bigint;
    latestCrownedRound: bigint;
    total: bigint;
    totalCount: bigint;
    streak: bigint;
  };
  /** The newest answered round of each feed the report prints from, as Questions reports it. */
  payrolls: { rounds: bigint; latestRound: bigint };
  hires: { rounds: bigint; latestRound: bigint };
  /** Rounds of the employers feed worth a look; empty when that feed is not kept. */
  crownCandidates: CrownCandidate[];
}

/** True when the bytes are the list Questions stored the hash of. */
export function isTheStoredList(bytes: Hex, value: bigint): boolean {
  return BigInt(keccak256(bytes)) === value;
}

/** State in, actions with reasons out. Pure. */
export function decideJobsReport(snapshot: JobsReportSnapshot): Decision {
  const actions: Action[] = [];
  const waiting: Waiting[] = [];
  const s = snapshot.summary;

  const unreadPayrolls = snapshot.payrolls.latestRound > s.payrollsRead;
  const unreadHires = snapshot.hires.latestRound > s.hiresRead;
  const unpaired = s.pairedPrints < s.prints && s.pairedCounts < s.counts;
  if (unreadPayrolls || unreadHires || unpaired) {
    const reasons: string[] = [];
    if (unreadPayrolls) {
      reasons.push(
        `payrolls round ${snapshot.payrolls.latestRound} is answered and the report has read ${s.payrollsRead}`,
      );
    }
    if (unreadHires) {
      reasons.push(
        `hires round ${snapshot.hires.latestRound} is answered and the report has read ${s.hiresRead}`,
      );
    }
    if (unpaired) reasons.push("prints and counts are waiting to be paired");
    actions.push({
      module: "jobsReport",
      kind: "print",
      subject: "report",
      label: "print the Jobs Report",
      reason: reasons.join("; "),
      call: { address: snapshot.jobsReport, abi: JOBS_REPORT_ABI, functionName: "print", args: [] },
    });
  }

  for (const candidate of snapshot.crownCandidates) {
    if (candidate.crowned || candidate.status !== ROUND_STATUS.Answered) continue;
    const subject = `employers round ${candidate.round}`;
    if (candidate.answer.kind === "unknown") {
      waiting.push({
        module: "jobsReport",
        subject,
        reason: `the round is answered and not crowned, and its list could not be fetched: ${candidate.answer.detail}. The report is complete without it`,
      });
      continue;
    }
    if (!isTheStoredList(candidate.answer.bytes, candidate.value)) {
      waiting.push({
        module: "jobsReport",
        subject,
        reason: `the list served for oracle request ${candidate.answer.oracleRequestId} does not hash to the word Questions stored; it is not sent`,
        attention: true,
      });
      continue;
    }
    actions.push({
      module: "jobsReport",
      kind: "crown",
      subject: "employers",
      label: `crown employers round ${candidate.round}`,
      reason: `employers round ${candidate.round} is answered and not crowned, and the list of oracle request ${candidate.answer.oracleRequestId} hashes to the stored word`,
      call: {
        address: snapshot.jobsReport,
        abi: JOBS_REPORT_ABI,
        functionName: "crown",
        args: [candidate.round, candidate.answer.bytes],
      },
    });
  }
  return { actions, waiting };
}
