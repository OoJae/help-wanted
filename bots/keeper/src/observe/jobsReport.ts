/**
 * Reads everything `decideJobsReport` needs: the report's own progress, the newest answered round
 * of each feed it prints from, and, when the newest employers round is answered and not crowned,
 * the attested list behind it.
 */
import type { Abi, Address, Hex } from "viem";
import { ROUND_STATUS, jobsReportAbi, questionsAbi } from "@help-wanted/shared";
import type { CrownCandidate, JobsReportSnapshot } from "../modules/jobsReport.js";
import { noteRound, roundNote } from "../store.js";
import { messageOf, readAt, readOnce, type ObserveContext } from "./common.js";
import { big, findRequestTx, num } from "./questions.js";

const JOBS_REPORT_ABI = jobsReportAbi as unknown as Abi;
const QUESTIONS_ABI = questionsAbi as unknown as Abi;

interface FeedProgress {
  rounds: unknown;
  latestRound: unknown;
  lastRequestBlock: unknown;
}

/** The list behind an answered employers round: the `answer` bytes of its attestation. */
async function readCrownAnswer(
  ctx: ObserveContext,
  questions: Address,
  feedId: Hex,
  round: bigint,
  newest: { rounds: bigint; lastRequestBlock: bigint },
): Promise<CrownCandidate["answer"]> {
  let oracleRequestId = roundNote(ctx.store.data, feedId, round)?.oracleRequestId;
  if (oracleRequestId === undefined) {
    // Not noted while the round was pending (another keeper opened it, or the state file is new).
    // The block of the request is known only for the feed's newest round.
    if (round !== newest.rounds) {
      return {
        kind: "unknown",
        detail: "the oracle request behind this older round is not in the keeper's notes",
      };
    }
    const requestTx = await findRequestTx(ctx, questions, feedId, round, newest.lastRequestBlock);
    if (requestTx === null) {
      return { kind: "unknown", detail: "the transaction that opened the round could not be found" };
    }
    try {
      const read = await ctx.api.intakeRead(ctx.chainId, requestTx);
      const roundRequest = (await readAt(ctx, questions, QUESTIONS_ABI, "roundRequest", [
        feedId,
        round,
      ])) as readonly [Hex, ...unknown[]];
      const entry = read.entries.find((e) => e.requestId?.toLowerCase() === roundRequest[0].toLowerCase());
      oracleRequestId = entry?.admission?.result?.requestId;
    } catch (error) {
      return { kind: "unknown", detail: `IdentityMD's service could not be read (${messageOf(error)})` };
    }
    if (oracleRequestId === undefined) {
      return { kind: "unknown", detail: "IdentityMD's service names no oracle request for the round" };
    }
    noteRound(ctx.store.data, feedId, round, { oracleRequestId }, Number(ctx.block.timestamp));
  }
  try {
    const document = await ctx.api.oracleAttestation(oracleRequestId);
    return { kind: "known", bytes: document.message.answer as Hex, oracleRequestId };
  } catch (error) {
    return { kind: "unknown", detail: `the attestation could not be read (${messageOf(error)})` };
  }
}

/** Reads the snapshot `decideJobsReport` takes. Sends nothing. */
export async function observeJobsReport(
  ctx: ObserveContext,
  targets: { jobsReport: Address; crown: boolean },
): Promise<JobsReportSnapshot> {
  const { jobsReport } = targets;
  const [questions, payrollsFeed, hiresFeed, employersFeed] = (await Promise.all(
    ["QUESTIONS", "PAYROLLS_FEED", "HIRES_FEED", "EMPLOYERS_FEED"].map((name) =>
      readOnce<Hex>(ctx, jobsReport, JOBS_REPORT_ABI, name),
    ),
  )) as [Address, Hex, Hex, Hex];
  const [summary, payrolls, hires, employers] = (await Promise.all([
    readAt(ctx, jobsReport, JOBS_REPORT_ABI, "summary"),
    readAt(ctx, questions, QUESTIONS_ABI, "feedState", [payrollsFeed]),
    readAt(ctx, questions, QUESTIONS_ABI, "feedState", [hiresFeed]),
    readAt(ctx, questions, QUESTIONS_ABI, "feedState", [employersFeed]),
  ])) as [Record<string, unknown>, FeedProgress, FeedProgress, FeedProgress];

  const crownCandidates: CrownCandidate[] = [];
  const round = big(employers.latestRound);
  if (targets.crown && round > 0n) {
    const [roundOf, crown] = (await Promise.all([
      readAt(ctx, questions, QUESTIONS_ABI, "roundOf", [employersFeed, round]),
      readAt(ctx, jobsReport, JOBS_REPORT_ABI, "crownOf", [round]),
    ])) as [readonly unknown[], { crownedAt: unknown }];
    const status = num(roundOf[0]);
    const crowned = big(crown.crownedAt) !== 0n;
    crownCandidates.push({
      round,
      status,
      value: big(roundOf[1]),
      crowned,
      answer:
        crowned || status !== ROUND_STATUS.Answered
          ? { kind: "unknown", detail: "not needed" }
          : await readCrownAnswer(ctx, questions, employersFeed, round, {
              rounds: big(employers.rounds),
              lastRequestBlock: big(employers.lastRequestBlock),
            }),
    });
  }

  return {
    jobsReport,
    summary: {
      prints: big(summary.prints),
      counts: big(summary.counts),
      payrollsRead: big(summary.payrollsRead),
      hiresRead: big(summary.hiresRead),
      pairedPrints: big(summary.pairedPrints),
      pairedCounts: big(summary.pairedCounts),
      crowns: big(summary.crowns),
      latestCrownedRound: big(summary.latestCrownedRound),
      total: big(summary.total),
      totalCount: big(summary.totalCount),
      streak: big(summary.streak),
    },
    payrolls: { rounds: big(payrolls.rounds), latestRound: big(payrolls.latestRound) },
    hires: { rounds: big(hires.rounds), latestRound: big(hires.latestRound) },
    crownCandidates,
  };
}
