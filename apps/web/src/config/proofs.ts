/**
 * What has been proven on the live system so far, as records.
 *
 * Nothing here is a claim of this site's: each entry copies what a document in the repository
 * states, with the public address where anyone can read the original. `test/proofs.test.ts` holds
 * every entry against its source document when the launch projects are in the repository beside
 * this app, and recomputes what can be recomputed (a feed body's hash, a question hash, a record's
 * hash) with the shared package.
 *
 * - The three house feed questions, each bought once from the live oracle on 12 and 13 October 2026:
 *   `launches/a-payroll/docs/LAUNCH.md`, section 5 (the `proofs` block).
 * - IdentityMD's two audits of launch A and what was done about each finding:
 *   `launches/a-payroll/docs/AUDITS.md`.
 * - What IdentityMD's launch pipeline changed in launch A before it created the contracts:
 *   `launches/a-payroll/ADAPTATION.md`.
 * - What IdentityMD's launch pipeline found in launch B before it created the contracts, and that
 *   it changed no contract code for any of it: `launches/b-desk/ADAPTATION.md`.
 * - Where each launch project's source is public: checked by hand against the public repository.
 */
import type { Hex } from "viem";
import type { HouseFeedName } from "@help-wanted/shared";

export interface FeedProof {
  feed: HouseFeedName;
  /** The transaction that bought the request, through the legacy Intake (version 1). */
  transaction: Hex;
  block: number;
  /** IdentityMD's id for the oracle request; its public record is at /oracle/requests/<id>. */
  oracleRequestId: string;
  fromBlock: number;
  toBlock: number;
  /** The question hash the oracle attested. */
  questionHash: Hex;
  /** keccak256 of the body the Intake's service recorded for the purchase. */
  bodyHash: Hex;
  /** The attested answer, ABI-encoded. */
  answer: Hex;
  /** How many of the seven panel members agreed. */
  agreed: number;
  attestedAt: string;
}

/** One request per feed as launched, each attested. They named no callback: nothing was delivered to a contract. */
export const FEED_PROOFS: Readonly<Record<HouseFeedName, FeedProof>> = {
  payrolls: {
    feed: "payrolls",
    transaction: "0xc75123bfb4cd49e0f1c55b236443b2a6d6d93ac981cd3e62f4f931bc2abc9cee",
    block: 26179783,
    oracleRequestId: "3744d864-8cbf-4fcf-8a8c-3529fb1736cb",
    fromBlock: 26172770,
    toBlock: 26179769,
    questionHash: "0xa7eb81dbf5789fdd71e33f54c90cda86ac6cf4070c2320c6d1719e01e3a84dd3",
    bodyHash: "0xbbf7d6fdf20fe61d71b05bfe3ba358d4d0e97be43c2c43d17f9b0678b0a2873d",
    answer: "0x0000000000000000000000000000000000000000000000062e115c008a880000",
    agreed: 5,
    attestedAt: "2026-10-12T23:50:00.611Z",
  },
  hires: {
    feed: "hires",
    transaction: "0xd7ad398293c0c9138cf7895262f5861465f0ab610861b81426efe6c7e27b16ea",
    block: 26179785,
    oracleRequestId: "df50bf76-41a0-4596-ae9e-9dcfd0e1ccd5",
    fromBlock: 26172772,
    toBlock: 26179771,
    questionHash: "0xdb20f183971eca9bda183646db40164a35cd6cec00acabff45918189f15e6dc5",
    bodyHash: "0xda6f13f65b9329f31f201dc06eed234f4c73bded9a9ebf64a061f4181a2b29a9",
    answer: "0x00000000000000000000000000000000000000000000000000000000000000e4",
    agreed: 5,
    attestedAt: "2026-10-12T23:50:31.358Z",
  },
  employers: {
    feed: "employers",
    transaction: "0x14e7189cd2f65180452995c7a5ed1d12f9101dd8c42c23c63e21a1d86b48ba9d",
    block: 26179860,
    oracleRequestId: "2cbe6bb3-13f9-4617-98b9-5d83754f9e1a",
    fromBlock: 26129447,
    toBlock: 26179846,
    questionHash: "0x3d14a9f53e3eaf1272d67871cff61223fc9b295f26e177c7a193ca5f90d52fc6",
    bodyHash: "0xf0841684ac251fd3f07386cc34d41cccbaef1bd64b8c2353a8c25b641ccce54a",
    answer:
      "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000300000000000000000000000021919137e69ed667ac404c7fcb71b8179b645f460000000000000000000000009fadab91f6fa03dbd7f4f8a08a338704baacf63f0000000000000000000000007b8c742f2e1eeb3fb2c10d72967fa6d4a22f0479",
    agreed: 5,
    attestedAt: "2026-10-13T00:08:45.443Z",
  },
};

/**
 * The first body the employers feed had, which the oracle did not attest. It is part of the record:
 * it is why that feed is judged by a panel today.
 */
export const EMPLOYERS_FIRST_ATTEMPT = {
  oracleRequestId: "c1d0ba09-c732-46e7-b257-2722841215fe",
  transaction: "0x674b5e14572e1e53960802a3a664bac8403bdda0d0e39e6aad23fbaef2d38b0e",
  outcome:
    "Not attested (status mismatch): the feed then pinned a ranking recipe with a filter on the recipient, the oracle's own rerun ranked every IMD transfer without the filter, and the two lists differed.",
} as const;

export type FindingOutcome = "fixed" | "documents corrected" | "left open" | "left";

export interface AuditFinding {
  /** As `docs/AUDITS.md` numbers it: report, then finding. */
  id: string;
  severity: "medium" | "low" | "info";
  finding: string;
  outcome: FindingOutcome;
  /** What was done about it, in one or two sentences, from the same document. */
  done: string;
}

export interface AuditReport {
  /** The audit job bought from the IdentityMD network. */
  jobId: string;
  judged: string;
  asked: string;
  findings: AuditFinding[];
}

/** The commit both audits read. Fixes were made after it and have not been audited again. */
export const AUDITED_COMMIT = "5c049e0f703bde97f0255368bc124254161b637e";

export const AUDITS: readonly AuditReport[] = [
  {
    jobId: "be91e8ae-9f45-495f-a318-60fab672a92e",
    judged: "13 October 2026, 00:51 UTC",
    asked:
      "The oracle paths and meter accounting of Questions; the split, the stream and the claims of Payroll.",
    findings: [
      {
        id: "1.1",
        severity: "medium",
        finding:
          "A booking that crosses a fortnight boundary releases the old feed tranche to stakers before the meters are served.",
        outcome: "fixed",
        done: "Fixed in Payroll: a booking no longer releases anything. Budget that has fallen due waits for fundFeeds, which serves the meters first and releases only what they leave.",
      },
      {
        id: "1.2",
        severity: "low",
        finding:
          "Payroll sizes a meter's shortfall from the pooled meter balance, so IMD parked by a stranger turns the old tranche into staker stream.",
        outcome: "fixed",
        done: "Fixed in Payroll: a top-up is sized from Payroll's own position on the meter (what its own shares would fetch), not from the pooled balance.",
      },
      {
        id: "1.3",
        severity: "low",
        finding:
          "Stream re-levelling delays money already vesting, contrary to the contract notice, the drip NatSpec and the threats document.",
        outcome: "documents corrected",
        done: "The code is left as the build brief fixed it; the three statements that claimed more than the rule gives were corrected, and tests pin the auditors' figures to the wei. It is disclosed as an open limit.",
      },
      {
        id: "1.4",
        severity: "info",
        finding: "stream().dueNow reports an amount drip() refuses to send while sIMD is not ready.",
        outcome: "fixed",
        done: "Fixed in Payroll: dueNow is zero whenever drip would send nothing.",
      },
    ],
  },
  {
    jobId: "22624be0-d2da-400e-91c4-51dac0a9a7f5",
    judged: "13 October 2026, 01:30 UTC",
    asked: "Audit the contracts as they are.",
    findings: [
      {
        id: "2.1",
        severity: "medium",
        finding:
          "Deposits into sIMD just before each drip take the same share of the stream as stakers who stay.",
        outcome: "left open",
        done: "Acknowledged and left, by the project lead's decision: the plain transfer to sIMD is how the protocol itself pays stakers, and the alternative would take custody of stakers' sIMD. The false claim was removed, the real figure stated, and sIMD's one-block hold tested on a fork. It is disclosed as an open limit.",
      },
      {
        id: "2.2",
        severity: "low",
        finding:
          "Anyone can make fundFeeds place nothing by funding and defunding the house meters around it.",
        outcome: "fixed",
        done: "Fixed by the change for 1.2.",
      },
      {
        id: "2.3",
        severity: "low",
        finding:
          "Stream re-levelling delays money that was already vesting; NatSpec and the threats document claim it cannot.",
        outcome: "documents corrected",
        done: "The same as 1.3: the code left, the statements corrected.",
      },
      {
        id: "2.4",
        severity: "info",
        finding: "stream().dueNow reports an amount drip() refuses to send while sIMD is not a ready vault.",
        outcome: "fixed",
        done: "Fixed by the change for 1.4.",
      },
      {
        id: "2.5",
        severity: "info",
        finding:
          "JobsReport's BadWindow skip is unreachable from the pinned Questions and would drop a round for good if it ever fired.",
        outcome: "left",
        done: "Left: the code is unchanged, the notice of print states the exception, and a test shows it cannot fire against the Questions contract the report is bound to.",
      },
    ],
  },
];

/**
 * What changed in launch A after the two audits we bought. We bought no third one. The launch
 * pipeline then read the code itself and changed it again (`LAUNCH_ADAPTATION`).
 */
export const CHANGED_AFTER_AUDITS =
  "After both audits, on 13 October 2026, two waits in Questions were changed: submit opens thirty minutes after a request the Intake has not completed (the auditors read two hours), and the time allowed before a silent round can be closed became twelve hours (they read six). We bought no further audit: the fixes and that change have not been audited again by a job of ours. IdentityMD's launch pipeline then read the code itself and changed it once more before it created the contracts; what it changed is listed below.";

export type AdaptationOutcome = "changed" | "kept";

export interface AdaptationFinding {
  /** The finding's id as `ADAPTATION.md` heads it (a 64-character hex id), and the document's name for it. */
  id: string;
  title: string;
  outcome: AdaptationOutcome;
  /** What the pipeline reproduced and what it did, from the same document. */
  done: string;
}

/**
 * What IdentityMD's launch pipeline did to launch A before it created the three contracts. Its own
 * audit step raised four findings; its adaptation step reproduced each and changed the code for
 * three. The fourth is the fixed oracle signer, which the ownerless design asks for and which was
 * kept. The contracts on chain are the code after these changes.
 *
 * `reviewedAfter` is a dated reading of IdentityMD's public record of the launch job
 * (`GET /jobs/<LAUNCH_A_JOB>`): which steps the record makes depend on the adaptation step. The
 * page reads the state of every step live; this only says how the record ordered them that day.
 */
export const LAUNCH_ADAPTATION: {
  document: string;
  reviewedAfter: { read: string; steps: readonly string[] };
  findings: readonly AdaptationFinding[];
} = {
  document: "launches/a-payroll/ADAPTATION.md",
  reviewedAfter: {
    read: "13 October 2026",
    steps: ["audit_math", "audit_permissions", "audit_economics", "audit_flow", "audit_judge"],
  },
  findings: [
    {
      id: "2ab3a604a08ad2228fab5998880e3954c9693a2cd07625237b196ddffff1add9",
      title: "keeper tip",
      outcome: "changed",
      done: "Reproduced: a different account submitted the public signature at thirty minutes and received the opener's 0.05 IMD tip. Changed in Questions: both the callback and submit now settle the reserved tip to the keeper that opened the round. Handing an answer in earns no reward of its own.",
    },
    {
      id: "a89a358156234a1e39fb3109849d6cf4ce08ac46b592e396e86b54c462b96f8c",
      title: "premature closure",
      outcome: "changed",
      done: "Reproduced: anyone could close an unfinished panel-evidence round at exactly twelve hours, before a still-valid answer was delivered. Changed in Questions: a silent round can be closed only after its request plus twelve hours, the validity the feed asks of an answer, five minutes of clock tolerance and one second. For the three house feeds that is 36 hours, 5 minutes and 1 second.",
    },
    {
      id: "a7e63b8cd49ce710626abdf17f56d942258adc4ff83bef72afb48e1ce6d3496d",
      title: "fixed signer",
      outcome: "kept",
      done: "Reproduced as the immutable dependency the design asks for, and kept: a different key is rejected, and replacing the oracle signer needs a new launch. A setter for it would contradict having no owner and no admin.",
    },
    {
      id: "4e16393fe68cb7416e2ffc990c13676dedd8c9ddc6eb564df32006fcbf83378f",
      title: "escrow claims",
      outcome: "changed",
      done: "Reproduced with a contract that cannot release ERC-20 funds: claimSeat, claimSeats and claimTip each paid it at an observer's request. Changed in Payroll: a seat held by a contract other than Payroll must be claimed by that contract itself. A single claim sent by anyone else reverts ContractOwnerMustClaim; a batch skips that seat and pays the others.",
    },
  ],
};

export interface DeskAdaptationFinding {
  /** The finding's id as `launches/b-desk/ADAPTATION.md` heads it: eight hex characters. */
  id: string;
  severity: "medium" | "info";
  /** Which of the pipeline's two rounds raised it. */
  raisedBy: "the audit the pipeline imported" | "the independent review";
  /** The document's own heading for the finding. */
  finding: string;
  /**
   * `words corrected`: comments and documents were changed to say what the code does, and the code
   * was left. `left`: nothing was changed. No finding of this launch changed contract code.
   */
  outcome: "words corrected" | "left";
  /**
   * What was reproduced and what was done, from the same document. A limit named in brackets is
   * where the launch's `docs/THREATS.md` discloses the matter.
   */
  done: string;
}

/**
 * What IdentityMD's launch pipeline found in launch B before it created the four contracts as
 * launch 1573, as `launches/b-desk/ADAPTATION.md` records it. The audit the pipeline imported
 * reported four entries, all at level info; an independent reviewer then reopened the accepted work
 * with one medium finding and two info notes. Each was reproduced. No contract code was changed for
 * any of them: the medium finding was answered by correcting comments and documents that claimed
 * more than the code gives, and by two tests. The limit it describes stands and is disclosed
 * (launch B's THREATS.md, C2, with W2, W3 and W5).
 *
 * Those seven are not every finding on record. IdentityMD's record of the pipeline job holds eleven
 * in its accepted review submissions, the number launch B's pull request gives (`onRecord`): the
 * judge merged the four that ADAPTATION.md does not name (from the economics, flow and permissions
 * steps) into its own three. `launches/b-desk/docs/AUDITS.md` lists all eleven with the answer that
 * covers each. Read on 15 October 2026.
 *
 * `test/proofs.test.ts` holds every entry against the document when the launch project is in the
 * repository beside this app.
 */
export const DESK_ADAPTATION: {
  document: string;
  launchNumber: number;
  /** What the document says was changed for the medium finding, and what was not. */
  corrected: string;
  /**
   * Every finding in the accepted submissions on IdentityMD's record of the job (`record`), how many
   * of them the judge merged into its own, and our document that lists them all. `notAccepted`
   * counts the findings of the judge's first round, a submission that was not accepted: its last
   * round restates them, so they are not counted again.
   */
  onRecord: { count: number; merged: number; notAccepted: number; record: string; document: string };
  findings: readonly DeskAdaptationFinding[];
} = {
  document: "launches/b-desk/ADAPTATION.md",
  launchNumber: 1573,
  onRecord: {
    count: 11,
    merged: 4,
    notAccepted: 3,
    record: "https://api.imd.fun/jobs/eb0f6c65-174a-45e8-9fe5-9312c66d4880/submissions",
    document: "launches/b-desk/docs/AUDITS.md",
  },
  corrected:
    "Changed for the medium finding, all of it comments and documents: three notes in src/pots/CrowdPots.sol on what a runner's bond does and does not size, entries W2, W3, W5 and C2 of docs/THREATS.md, and one row of docs/LAUNCH.md. Two tests were added that run the reviewer's two cases on the real desk. The compiled bytecode of all four contracts is the same as before.",
  findings: [
    {
      id: "c309d5e6",
      severity: "info",
      raisedBy: "the audit the pipeline imported",
      finding: "coverage, no defect",
      outcome: "left",
      done: "Confirmed: the build and the whole test suite pass with an empty environment and no network, and the launch-forbidden features are absent. No change.",
    },
    {
      id: "46190b9b",
      severity: "info",
      raisedBy: "the audit the pipeline imported",
      finding: "with allowClaimed = 1, a Doorbell order can be paid on an unchallenged false claim",
      outcome: "left",
      done: "Reproduced with the manifest's exact Doorbell values on the real desk: an address with 0.25 IMD rings 25 times, takes the order, registers a job id it made up, claims delivery and is paid after 24 hours. Not changed: it is the launch-day setting the launch document explains for the time receipts are stalled, and it is disclosed as the Doorbell's limit (D2). What stands against it is a watcher that challenges, and small amounts in the Doorbell.",
    },
    {
      id: "be85d51c",
      severity: "info",
      raisedBy: "the audit the pipeline imported",
      finding: "CrowdPots never calls finalize, so an unchallenged claim leaves a pot Hiring",
      outcome: "left",
      done: "Reproduced: after an unchallenged delivery claim the pot reads Hiring and claimRefund reverts until any address calls WorkOrders.finalize for its order. Not changed: it is the documented design (C5), finalize is open to anyone, and contributors lose nothing to it.",
    },
    {
      id: "157f2546",
      severity: "info",
      raisedBy: "the audit the pipeline imported",
      finding: "a minimum bond holds a receipt-only pot's escrow for its whole delivery time",
      outcome: "left",
      done: "Reproduced: a pot of 1,000 IMD with the desk's minimum bond and 30 days of delivery is held for those 30 days by an address with 0.25 IMD; at the deadline the pot is refundable for the target plus the forfeited bond. Not changed: the bond and the delivery time are the opener's published choices, bounded by the contract (C3, L6).",
    },
    {
      id: "a96c4f58",
      severity: "medium",
      raisedBy: "the independent review",
      finding:
        "the SwarmFailed and wrong-kind endings of reportFailed return the whole bond and bar nobody, so a receipt-only pot can be held past its hire window and refunded with nothing forfeited",
      outcome: "words corrected",
      done: "Reproduced, both cases, on the real desk, the real WorkProof and the real CrowdPots. What was done: the words were corrected, not the desk. The desk's rule is deliberate (taking a runner's bond for the swarm's failure would make honest runners avoid the desk), so the code was left, and what CrowdPots told contributors the bond sizes was corrected. The limit stands: a receipt-only pot can be ended in a refund with no bond forfeited, which costs the runner one swarm job and gas, and the contributors the time their IMD was locked. No IMD is lost (C2).",
    },
    {
      id: "bff72b72",
      severity: "info",
      raisedBy: "the independent review",
      finding:
        "with ALLOW_CLAIMED = 1 and no arbiter, each Doorbell escrow is paid to an unchallenged bonded claim, and a correct challenger's best outcome is its own bond back",
      outcome: "left",
      done: "Reproduced by trace at the manifest's values: an untrue claim nobody challenges costs the Doorbell 1 IMD an order, and a challenger that defends it gets back exactly its own bond, held for up to seven days. The same root as 46190b9b. Not changed; added to the launch's open items: whoever funds the Doorbell sizes a watcher's float and funds it with small amounts.",
    },
    {
      id: "2094daa9",
      severity: "info",
      raisedBy: "the independent review",
      finding:
        "chipInFor accepts the desk, IMD, Payroll and WorkProof as beneficiary, and a refund claimed for such a chip is stranded",
      outcome: "left",
      done: "Reproduced: a chip made in the desk's name is accepted, and its refund is paid into the desk, which only ever sends what it booked for an order. Not changed: only the payer's own IMD is at stake, by the payer's own choice of beneficiary (C11).",
    },
  ],
};

/**
 * How many findings IdentityMD's record of launch B's job holds, after "holds", in the words every
 * page uses. The count is of the accepted submissions; the judge's first round, which was not
 * accepted, is named beside it, so that a reader who counts every entry on the record finds the
 * same total.
 */
export function deskOnRecordWords(): string {
  const r = DESK_ADAPTATION.onRecord;
  return `${r.count} findings in its accepted submissions (the judge's first round, not accepted, raised ${r.notAccepted} that its last round restates)`;
}

/**
 * Which of those findings ADAPTATION.md answers, graded as it grades them, and what became of the
 * rest. ADAPTATION.md and the judge's first round grade a96c4f58 medium; the judge's last round,
 * the accepted one, grades it info. The one medium finding among the accepted submissions is
 * audit_permissions', which the judge merged into a96c4f58.
 */
export function deskGradingWords(): string {
  const { findings, onRecord, document } = DESK_ADAPTATION;
  const medium = findings.filter((f) => f.severity === "medium").map((f) => f.id);
  const info = findings.filter((f) => f.severity === "info").length;
  return `${document} answers ${findings.length} of them. It grades ${medium.join(" and ")} medium, as the judge's first round did (its last round, the one accepted, grades it info), and the other ${info} info. The pipeline's judge merged the remaining ${onRecord.merged}, among them audit_permissions' medium finding, into three of those.`;
}

/**
 * Where a launch project's source can be read by anyone, or null while it cannot. Each entry was
 * checked against the public repository on the day it names: the branch exists there and its root
 * is the launch project. Change an entry here when a branch is published; every sentence on the
 * site that says whether a launch's source is public follows this table.
 */
export const PUBLIC_SOURCE: Readonly<
  Record<"A" | "B" | "C", { repository: string; branch: string; checked: string } | null>
> = {
  A: { repository: "https://github.com/OoJae/help-wanted", branch: "launch-a", checked: "13 October 2026" },
  B: { repository: "https://github.com/OoJae/help-wanted", branch: "launch-b", checked: "13 October 2026" },
  C: { repository: "https://github.com/OoJae/help-wanted", branch: "launch-c", checked: "15 October 2026" },
};

/** Whether a launch's source is public, as one sentence that follows `PUBLIC_SOURCE`. */
export function sourceWords(launch: "A" | "B" | "C"): string {
  const source = PUBLIC_SOURCE[launch];
  return source
    ? `Its source is public: branch ${source.branch} of ${source.repository} (checked ${source.checked}).`
    : "Its source is not public yet.";
}
