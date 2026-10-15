/**
 * "/judges": the page IdentityMD's judging agents are sent to.
 *
 * Everything on it is either read live when the page is made (and printed with what was read), or
 * linked to a public record, or paired with a command that checks it. Nothing is asserted that a
 * reader cannot repeat. What is not live is listed as plainly as what is, and where something has
 * been shown only in part (the header job's receipt is still queued) the page says which part.
 */
import {
  HOUSE_FEEDS,
  HOUSE_FEED_NAMES,
  IMD_API_BASE,
  MAINNET,
  orderHeadHash,
  orderHeader,
  sameAddress,
  scanWorkRecord,
  workProofAbi,
  type HouseFeedName,
} from "@help-wanted/shared";
import { IMD_LINK, REFERENCE_JOB, etherscanAddress, etherscanTx } from "~/config/chain";
import {
  DEPLOYMENT_BOOK_PATH,
  LAUNCH_KEYS,
  NOT_LAUNCHED,
  type ContractKey,
  type Deployments,
  type LaunchKey,
} from "~/config/deployments";
import { HOUSE_WALLETS, houseSet } from "~/config/house";
import { DISCLOSED_LIMITS, THREATS_DOCUMENT, limitText, type DisclosedLimit } from "~/config/limits";
import {
  AUDITED_COMMIT,
  AUDITS,
  CHANGED_AFTER_AUDITS,
  DESK_ADAPTATION,
  EMPLOYERS_FIRST_ATTEMPT,
  LAUNCH_ADAPTATION,
  PUBLIC_SOURCE,
  sourceWords,
  type AdaptationFinding,
  type DeskAdaptationFinding,
  type FindingOutcome,
} from "~/config/proofs";
import { HEADER_JOB, LAUNCH_A_JOB, LAUNCH_B_JOB } from "~/data";
import type { JobDetail } from "~/data/api";
import { messageOf } from "~/lib/cache";
import { formatImd, formatInt, formatUtc, plural } from "~/lib/format";
import { hashNo0x, isZeroHash } from "~/lib/ids";
import { bullets, doc, fence, inline, link, table } from "~/lib/md";
import { hashServedRecord, verifyCommands } from "~/lib/verify";
import {
  allContracts,
  castView,
  launchIsLive,
  launchRecorded,
  PUBLIC_RPC,
  type ContractStatus,
} from "./common";
import { paymentsCommand, releaseTally } from "./jobsReport";
import { ringsByOrigin } from "./money";
import { proofView } from "./questions";
import {
  claimDefault,
  loadReceiptFlow,
  receiptFlowMeaning,
  type ClaimDefault,
  type ReceiptFlow,
} from "./receipts";
import { sourceNote, type PageDef, type SourceNote } from "./types";
import { runVerify } from "./verify";

export interface Evidence {
  label: string;
  url: string;
}

export interface Claim {
  claim: string;
  /** What was read when this page was made, in words. Null when the read failed. */
  readNow: string | null;
  evidence: Evidence[];
  command: string | null;
}

export interface IntegrationRow {
  primitive: string;
  /** An address or an endpoint. */
  where: string;
  whereUrl: string | null;
  /** What we do with it. */
  use: string;
  /** `live` means this site uses the primitive today; `built` means only our contracts do. */
  status: "live" | "built";
  /** Our contracts that use the primitive, with their addresses (null until launched). */
  contracts: { key: ContractKey; name: string; address: string | null }[];
  /**
   * Whether those contracts are launched: all of them, some, or none. Follows the deployments book.
   * `none` is a row no contract of ours is part of: something a house wallet did.
   */
  launch: "launched" | "partly" | "not_launched" | "none";
  /** `launch` in words: "Launched", "Partly launched", "Built, not launched", "Done from a wallet". */
  launchLabel: string;
  statusWords: string;
  /**
   * How much our contracts have used the primitive, read when the page was made. `count` is null,
   * with the reason, while the thing counted cannot exist yet or could not be read: never a zero
   * that could be taken for a measurement.
   */
  usage: { count: string | null; what: string; reason: string | null };
  /** Where the proof is: public records a reader can open. Empty when there is none yet. */
  proofs: Evidence[];
  /** What those records show, or why there is none yet. */
  proofNote: string;
  command: string | null;
}

export interface LaunchView {
  key: LaunchKey;
  name: string;
  purpose: string;
  contracts: string[];
  launched: boolean;
  /** Where the launch stands, in one or two sentences. */
  status: string;
  txUrl: string | null;
  launchNumber: number | null;
}

/** A job that asked IdentityMD's launch pipeline for one of our launches, as its API described it for this page. */
export interface PipelineView {
  jobId: string;
  jobUrl: string;
  /** Null when the API could not be read. */
  read: {
    state: string;
    template: string | null;
    paidBy: string | null;
    paidByHouse: string | null;
    createdAt: string | null;
    baseCommit: string | null;
    launchKind: string | null;
    launchStatus: string | null;
    launchId: string | null;
    steps: { key: string; role: string | null; state: string }[];
    stepsAccepted: number;
  } | null;
  /** One sentence: what was read, or that it could not be. */
  words: string;
  command: string;
  error: string | null;
}

export interface FeedProofRow {
  feed: HouseFeedName;
  title: string;
  oracleRequestId: string;
  /** IdentityMD's public record of the request. */
  url: string;
  requestTxUrl: string;
  window: string;
  answer: string;
  agreed: string;
  attestedAt: string;
  /** True when this feed's body for that window hashes to the hash IdentityMD recorded for the purchase. */
  bodyMatches: boolean;
  /** True when the question hash built from this feed's text is the one the oracle attested. */
  questionHashMatches: boolean;
  settled: "recomputed by IdentityMD from chain data" | "settled by panel agreement";
  command: string;
}

export interface AuditFindingView {
  id: string;
  severity: string;
  finding: string;
  outcome: FindingOutcome;
  done: string;
}

export interface AuditView {
  jobId: string;
  jobUrl: string;
  reportUrl: string;
  judged: string;
  asked: string;
  findings: AuditFindingView[];
}

/** The real job that carried our order header, as read for this page. */
export interface HeaderJobView {
  jobId: string;
  jobUrl: string;
  recordsUrl: string;
  recordUrl: string;
  recordHash: string;
  /** The 85 bytes the job's objective had to begin with. */
  header: string;
  ticket: string;
  /** The record this server holds under the hash, and what it says. Null when it holds none. */
  record: {
    origin: "identitymd" | "stored";
    bytes: number;
    /** keccak256 of the bytes equals the hash they are kept under. */
    hashes: boolean;
    /** The first 85 raw bytes of the record's objective are the header, byte for byte. Null when the record could not be walked. */
    headerUnchanged: boolean | null;
    jobIdMatches: boolean | null;
    kind: string | null;
    state: string | null;
  } | null;
  /** What IdentityMD's API says about the job. Null when unread. */
  job: {
    state: string;
    template: string | null;
    paidBy: string | null;
    paidByHouse: string | null;
    createdAt: string | null;
    objectiveHasHeader: boolean;
  } | null;
  /** The API's entry for the record. Null when unread or not listed. */
  listed: { status: string; txHash: string | null } | null;
  /**
   * `WorkRegistry.latest(jobId)` as read for this page. `onChain` is true only when the registry
   * holds exactly this record's hash; null when the registry could not be read.
   */
  receipt: { value: string | null; onChain: boolean | null; readAt: string | null };
  /** What has been shown. */
  shown: string;
  /** What has not: the receipt, while it is not on chain. Null once it is. */
  notShown: string | null;
  commands: { comment: string; command: string }[];
}

export interface LimitRow {
  launch: DisclosedLimit["launch"];
  id: string;
  section: string;
  /** The document's heading and how its text goes on, as one run of text. */
  text: string;
  /** What has happened since the document was written, where something has. */
  since: string | null;
}

export interface JudgesModel {
  generatedAt: string;
  summary: string;
  summaryWords: number;
  launchedCount: number;
  /** Which launches are live and which are not, in one sentence that follows the deployments book. */
  launchSummary: string;
  contracts: ContractStatus[];
  launches: LaunchView[];
  /** Launch A's job in IdentityMD's launch pipeline. */
  pipeline: PipelineView;
  /** Launch B's job in the same pipeline. Null while the deployments book records no launch B. */
  deskPipeline: PipelineView | null;
  /** How every page switches on after a launch. */
  switchOn: string;
  /** Whether IdentityMD's receipts are reaching the registry, from the figures read for this page. */
  receipts: ReceiptFlow;
  /** The six-hour test of the registry's own log, which the hire form's default follows. */
  writer: ClaimDefault;
  feedProofs: {
    intro: string;
    rows: FeedProofRow[];
    firstAttempt: { url: string; txUrl: string; outcome: string };
    /** What these three answers do not show. */
    limit: string;
    testCommand: string;
  };
  audits: {
    commit: string;
    intro: string;
    reports: AuditView[];
    counts: Record<FindingOutcome, number>;
    after: string;
    document: string;
    /** What IdentityMD's launch pipeline changed before it created the contracts. */
    adaptation: { intro: string; document: string; findings: AdaptationFinding[] };
    /**
     * What the pipeline's audits found in launch B before it was deployed, and what was done: no
     * contract code was changed, and the one medium finding was answered in words. From
     * `launches/b-desk/ADAPTATION.md`; `documentUrl` is that file in the public repository. Null
     * while the deployments book records no launch B: the pipeline has then deployed nothing.
     */
    desk: {
      intro: string;
      document: string;
      documentUrl: string | null;
      corrected: string;
      counts: { medium: number; info: number; contractCodeChanged: 0 };
      findings: DeskAdaptationFinding[];
    } | null;
  };
  headerJob: HeaderJobView;
  claims: Claim[];
  integration: IntegrationRow[];
  reproduce: { title: string; note: string | null; commands: string }[];
  limits: {
    total: number;
    documents: { launch: DisclosedLimit["launch"]; path: string; count: number }[];
    rows: LimitRow[];
    note: string;
  };
  /**
   * Launch B, described as its own documents describe it. `head` says in a few words whether its
   * source is public and whether it has addresses; both follow the site's own records.
   */
  desk: { head: string; intro: string; points: string[]; status: string[]; statusAsOf: string };
  notLive: string[];
  neverClaimed: string[];
  houseWallets: { label: string; address: string; role: string }[];
  machineReadable: Evidence[];
  sources: SourceNote[];
}

const SUMMARY_BODY =
  "HELP WANTED is a job board where the employers are smart contracts. An employer (a wallet, a contract or a crowd pot) escrows IMD against a pinned job. A bonded runner pays the swarm's 0.5 IMD fee, opens the job with the order's header leading its objective, and registers the job id. The escrow pays when the job's work record is proven on chain against IdentityMD's WorkRegistry (keccak256(record) equals WorkRegistry.latest(jobId)) or, only if the employer allowed it, when a bonded delivery claim goes unchallenged for 24 hours. No delivery, refund. Standing Questions, a second contract, buys its own oracle answers from the IdentityMD Intake and publishes them as feeds; the first is the daily Robot Jobs Report. Fees are split by fixed code between sIMD stakers, seat owners and the feeds. Nothing has an owner. There is no token.";

function launchedLaunches(deployments: Deployments): LaunchKey[] {
  return LAUNCH_KEYS.filter((key) => launchIsLive(deployments, key));
}

/** How many of our contracts are launched, as the last sentence of the summary. */
export function launchSentence(deployments: Deployments): string {
  const total = Object.keys(deployments.contracts).length;
  const count = deployments.launchedCount;
  if (count === 0) return "No contract of ours is launched yet.";
  if (count === total) return `All ${total} of our contracts are launched.`;
  const whole = launchedLaunches(deployments);
  const which =
    whole.length === 0 ? "" : ` (${whole.length === 1 ? "launch" : "launches"} ${whole.join(" and ")})`;
  return `${count} of our ${total} contracts are launched${which}.`;
}

/**
 * Which launches are live and which are not, as the head of "Where the launches stand". Follows the
 * deployments book: a launch counts as live only when every one of its contracts has an address.
 */
export function launchSummaryFor(deployments: Deployments): string {
  const total = Object.keys(deployments.contracts).length;
  const count = deployments.launchedCount;
  if (count === 0) return `Nothing is launched yet. Each of our ten contracts is ${NOT_LAUNCHED}.`;
  if (count === total) return `All ${total} contracts are launched.`;
  // "The hire desk" reads "the hire desk" inside a sentence; a contract's name keeps its capital.
  const name = (key: LaunchKey) =>
    `launch ${key} (${deployments.launches[key].name.replace(/^The /, "the ")})`;
  const live = LAUNCH_KEYS.filter((key) => launchIsLive(deployments, key));
  const rest = LAUNCH_KEYS.filter((key) => !launchIsLive(deployments, key));
  const list = (keys: LaunchKey[]) => keys.map(name).join(" and ");
  return `${count} of ${total} contracts are launched${live.length > 0 ? `: ${list(live)}` : ""}. Not launched yet: ${list(rest)}.`;
}

/** What this is, in at most 150 words. The last sentence follows the deployments book. */
export function summaryFor(deployments: Deployments): string {
  return `${SUMMARY_BODY} ${launchSentence(deployments)}`;
}

/** The summary as it reads before any launch. */
export const SUMMARY = `${SUMMARY_BODY} No contract of ours is launched yet.`;

const NEVER_CLAIMED = [
  "That trading or oracle fees burn IMD.",
  "That a transfer to sIMD on Ethereum reaches every staker on every chain.",
  "That no other product pays seat owners.",
  "That our own activity is outside usage: every count is split HOUSE and OUTSIDE.",
  "That the header job is proven on chain: its receipt is read for this page every time, and the page says what the registry answered.",
];

/**
 * Launch B in the words of `launches/b-desk/README.md`, as that file stood on the date given. A test
 * holds these against the file. `status` is the README's own "read this first" list: dated
 * statements of its authors, shown as such, each sentence the README's word for word (the address
 * list of its first entry is left out: addresses on this site come from the deployments book).
 */
export const DESK_FROM_ITS_DOCUMENTS = {
  asOf: "13 October 2026",
  what: "Launch B is four contracts for Ethereum mainnet with no owner and no token: WorkProof, WorkOrders, CrowdPots and the Doorbell.",
  points: [
    "WorkOrders is a job board on which the employer can be a contract: an employer escrows IMD against a pinned job text, a bonded runner opens the job with IdentityMD's swarm, and the escrow pays when the job's work record is proven on chain against IdentityMD's WorkRegistry.",
    "WorkProof is that proof. It rests on one fact about IdentityMD's protocol: keccak256 of a job's work record, as served, equals WorkRegistry.latest(jobId) on Ethereum mainnet. The check on this site's verify page is the same one.",
    "A runner must put 85 bytes, the order's header, at the start of the job's objective, so that the record of the finished job names the order it was done for.",
    "CrowdPots lets many wallets commission one job together, and the Doorbell is a contract anyone can ring until it hires.",
    "It pays its fees into Payroll (the first launch, launch A on this site) and needs nothing else from the other two launches.",
  ],
  status: [
    "Live on Ethereum mainnet since 13 October 2026. IdentityMD's pipeline changed no contract code before deploying; ADAPTATION.md says what it checked and which comments and documents it corrected.",
    "The central claim holds through the launched WorkProof. Called on mainnet with the served record of the real job e9efec16-56f3-40d3-9243-52c453effc7d, prove answers with the record's hash and the agent that did the work.",
    "Payroll, the one contract this launch pays and does not create, is live. The tests that need no network use a stand-in for it.",
    "The desk's first order was settled by a real job, on proof. The order is Delivered and marked proven. The ringer, the runner and the Doorbell's IMD were all the team's own.",
    "The earlier header job is proven too.",
    "IdentityMD's receipts stalled from about 8 to 14 October 2026. While receipts are late, only orders that allow the bonded-claim path can be paid, which is why the Doorbell was launched with that path on.",
    "Audited by IdentityMD's launch pipeline, and by nobody else. Before deploying, its audit agents and an independent reviewer read this code and reported one medium and several info findings. None changed a contract; each is answered in ADAPTATION.md, and the medium one (a receipt-only pot can be ended in a refund with no bond forfeited) is now stated as a limit in docs/THREATS.md, C2.",
  ],
} as const;

/**
 * The entries of that status list that speak of the launch itself. The page prints them only while
 * the deployments book holds launch B, so that what it quotes never contradicts what it reads.
 */
const SAID_OF_THE_LAUNCHED_DESK = [
  "Live on Ethereum mainnet",
  "The central claim holds through the launched",
  "The desk's first order was settled",
  "Audited by IdentityMD's launch pipeline",
] as const;

/** What each project's own README says its test commands run. A test holds these against the files. */
export const SUITES = {
  A: { project: "launches/a-payroll", tests: 515, suites: 50, forkTests: 23 },
  B: { project: "launches/b-desk", tests: 673, suites: 32, forkTests: 38 },
  C: { project: "launches/c-company", tests: 415, suites: 19, forkTests: 34 },
} as const;

/** Our contracts that take IMD, in the order the page names them. */
const IMD_HOLDERS: readonly ContractKey[] = [
  "questions",
  "payroll",
  "workOrders",
  "crowdPots",
  "doorbell",
  "rules",
  "endowments",
];

const settle = <T>(p: Promise<T>) =>
  p.then(
    (value) => ({ value, error: null as string | null }),
    (error: unknown) => ({ value: null as T | null, error: messageOf(error) }),
  );

function houseLabel(address: string | null): string | null {
  if (!address) return null;
  return HOUSE_WALLETS.find((w) => sameAddress(w.address, address))?.label ?? null;
}

function pipelineView(
  jobId: string,
  job: { value: JobDetail | null; error: string | null } | null,
  missing: boolean,
): PipelineView {
  const jobUrl = IMD_LINK.job(jobId);
  const command = `curl -s ${jobUrl} | jq '{state, launch, steps: [.nodes[] | {key, state}]}'`;
  const j = job?.value ?? null;
  if (!j) {
    return {
      jobId,
      jobUrl,
      read: null,
      words: missing
        ? "IdentityMD's API answered that it does not know this job just now."
        : `The job's state could not be read from IdentityMD's API just now${job?.error ? ` (${job.error})` : ""}; the link and the command show it.`,
      command,
      error: job?.error ?? null,
    };
  }
  const accepted = j.steps.filter((s) => s.state === "accepted").length;
  const launchWords = j.launch?.status
    ? ` The pipeline reports the launch as "${j.launch.status}"${j.launch.id ? ` (launch ${j.launch.id})` : ""}.`
    : j.launch?.requested
      ? " The pipeline has not reported a launch for it yet."
      : "";
  const stepWords =
    j.steps.length > 0
      ? ` ${formatInt(accepted)} of its ${formatInt(j.steps.length)} steps are accepted.`
      : "";
  return {
    jobId,
    jobUrl,
    read: {
      state: j.state,
      template: j.template,
      paidBy: j.paidBy,
      paidByHouse: houseLabel(j.paidBy),
      createdAt: j.createdAt,
      baseCommit: j.baseCommit,
      launchKind: j.launch?.kind ?? null,
      launchStatus: j.launch?.status ?? null,
      launchId: j.launch?.id ?? null,
      steps: j.steps,
      stepsAccepted: accepted,
    },
    words: `IdentityMD's API gives the job's state as "${j.state}".${stepWords}${launchWords}`,
    command,
    error: null,
  };
}

function limitRows(): LimitRow[] {
  return DISCLOSED_LIMITS.map((row) => ({
    launch: row.launch,
    id: row.id,
    section: row.section,
    text: limitText(row),
    since: row.since ?? null,
  }));
}

export const judgesPage: PageDef<JudgesModel> = {
  id: "judges",
  pattern: "/judges",
  async load(ctx) {
    const { sources, now } = ctx;
    const { api, chain, house, deployments, env } = sources;
    // This page is the server's own account of itself: its reads carry no visitor.
    const own = { ...ctx, visitor: null };
    const [
      verify,
      health,
      intake,
      payments,
      staking,
      seats,
      simdBalance,
      flow,
      writerRead,
      ledger,
      orders,
      pots,
      doorbell,
      feeds,
      report,
      heldImd,
      pipelineJob,
      deskPipelineJob,
      headerJob,
      headerRecords,
      headerRecord,
      headerReceipt,
    ] = await Promise.all([
      settle(runVerify(own, REFERENCE_JOB.jobId)),
      settle(api.health()),
      settle(chain.intake()),
      settle(chain.payments()),
      settle(chain.staking()),
      settle(chain.bindings(["52211"])),
      settle(chain.imdBalance(MAINNET.SIMD)),
      loadReceiptFlow(sources),
      chain.receiptWriter(),
      house.ledger(),
      house.orders(40),
      house.pots(40),
      house.doorbell(),
      house.feeds(),
      house.report(1),
      // What each launched contract of ours that takes IMD holds now.
      Promise.all(
        IMD_HOLDERS.filter((key) => deployments.contracts[key].address !== null).map(async (key) => ({
          key,
          read: await settle(chain.imdBalance(deployments.contracts[key].address as string)),
        })),
      ),
      settle(api.job(LAUNCH_A_JOB.jobId)),
      // Launch B's job is read only once the book records that launch: before, nothing was deployed.
      launchRecorded(deployments, "B") ? settle(api.job(LAUNCH_B_JOB.jobId)) : null,
      settle(api.job(HEADER_JOB.jobId)),
      settle(api.jobRecords(HEADER_JOB.jobId)),
      settle(api.workRecord(HEADER_JOB.recordHash)),
      settle(chain.receiptRead(HEADER_JOB.jobIdBytes16)),
    ]);

    const v = verify.value?.result ?? null;
    const h = health.value?.value ?? null;
    const ours = houseSet(deployments);
    const tally = payments.value ? releaseTally(payments.value, ours) : null;
    const binding = seats.value?.[0] ?? null;
    const stake = staking.value?.value ?? null;
    const balance = simdBalance.value?.value ?? null;
    const referencePath = `/verify/${REFERENCE_JOB.jobId}`;
    const verifyCmds = verifyCommands({
      jobId: REFERENCE_JOB.jobId,
      rpcUrl: PUBLIC_RPC,
      workRegistry: MAINNET.WORK_REGISTRY,
      apiBase: IMD_API_BASE,
      recordHash: REFERENCE_JOB.receipt,
    });
    const oneGo = verifyCmds[2]?.command ?? "";
    const writer = claimDefault(writerRead, PUBLIC_RPC);

    // ---- What the launch pipeline's audits found in launch B (launches/b-desk/ADAPTATION.md). ----
    const deskMedium = DESK_ADAPTATION.findings.filter((f) => f.severity === "medium").length;
    const deskInfo = DESK_ADAPTATION.findings.filter((f) => f.severity === "info").length;
    const deskAuditWords = `Before it deployed them, IdentityMD's launch pipeline audited the four contracts: ${plural(deskMedium, "medium finding")} and ${deskInfo} at level info. No contract code was changed for any of them; the medium finding was answered in words, not in code, and the limit it describes is disclosed below as launch B's C2 (${DESK_ADAPTATION.document}).`;

    // ---- Where the launches stand. ----
    const pipeline = pipelineView(
      LAUNCH_A_JOB.jobId,
      pipelineJob.value
        ? { value: pipelineJob.value.value, error: null }
        : { value: null, error: pipelineJob.error },
      pipelineJob.value !== null && pipelineJob.value.value === null,
    );
    const deskPipeline = deskPipelineJob
      ? pipelineView(
          LAUNCH_B_JOB.jobId,
          deskPipelineJob.value
            ? { value: deskPipelineJob.value.value, error: null }
            : { value: null, error: deskPipelineJob.error },
          deskPipelineJob.value !== null && deskPipelineJob.value.value === null,
        )
      : null;
    const launchStatus = (key: LaunchKey): string => {
      const launch = deployments.launches[key];
      const some = launch.contracts.some((c) => deployments.contracts[c].address !== null);
      if (launchIsLive(deployments, key)) {
        const launched = launch.txHash
          ? `Launched${launch.launchNumber !== null ? ` as IdentityMD launch ${launch.launchNumber}` : ""}${launch.block !== null ? `${launch.launchNumber !== null ? "," : ""} in block ${formatInt(launch.block)}` : ""}.`
          : "Addresses are filled in, but no launch transaction is recorded with them.";
        // Launch B: what the pipeline's audits found before it deployed, said in one plain sentence.
        return key === "B" && launch.txHash ? `${launched} ${deskAuditWords}` : launched;
      }
      if (some) return "Some of its contracts have an address and some do not; treat it as not launched.";
      const none = "Not launched: the deployments book holds no address for it.";
      if (key === "A") {
        return `${none} Its job in IdentityMD's launch pipeline is ${LAUNCH_A_JOB.jobId}; the pipeline audits the code and then creates the contracts in one transaction. ${pipeline.words}`;
      }
      if (key === "B") return `${none} ${sourceWords("B")}`;
      // Launch C takes addresses the two earlier launches create.
      const waitingFor = (["A", "B"] as const).filter((earlier) => !launchIsLive(deployments, earlier));
      return `${none}${waitingFor.length > 0 ? ` It takes addresses that launches A and B create, and ${waitingFor.map((k) => `launch ${k}`).join(" and ")} ${waitingFor.length === 1 ? "has" : "have"} none yet.` : ""} ${sourceWords("C")}`;
    };
    const launches: LaunchView[] = LAUNCH_KEYS.map((key) => {
      const launch = deployments.launches[key];
      return {
        key,
        name: launch.name,
        purpose: launch.purpose,
        contracts: launch.contracts.map((c) => deployments.contracts[c].name),
        launched: launchIsLive(deployments, key),
        status: launchStatus(key),
        txUrl: launch.txHash ? etherscanTx(launch.txHash) : null,
        launchNumber: launch.launchNumber,
      };
    });

    // ---- Proven on the live system: the three house feed questions. ----
    const feedRows: FeedProofRow[] = HOUSE_FEED_NAMES.map((name) => {
      const feed = HOUSE_FEEDS[name];
      const view = proofView(feed);
      return {
        feed: name,
        title: feed.title,
        oracleRequestId: view.oracleRequestId,
        url: view.url,
        requestTxUrl: view.requestTxUrl,
        window: view.window,
        answer: view.answer,
        agreed: view.agreed,
        attestedAt: view.attestedAt,
        bodyMatches: view.bodyMatches,
        questionHashMatches: view.questionHashMatches,
        settled:
          feed.evidence === "panel"
            ? "settled by panel agreement"
            : "recomputed by IdentityMD from chain data",
        command: `curl -s ${view.url} | jq '{status, questionHash, answer: .attestation.answer, agreed: .attestation.agreed, signer, attestedAt}'`,
      };
    });

    // ---- Proven on the live system: the job that carried our header. ----
    const served = headerRecord.value ?? null;
    let recordFacts: HeaderJobView["record"] = null;
    if (served) {
      const hashed = hashServedRecord(served.bytes, HEADER_JOB.recordHash);
      let scan: ReturnType<typeof scanWorkRecord> | null = null;
      try {
        scan = scanWorkRecord(
          hashed.strippedNewline ? served.bytes.subarray(0, served.bytes.length - 1) : served.bytes,
        );
      } catch {
        scan = null;
      }
      recordFacts = {
        origin: served.origin,
        bytes: hashed.bytes,
        hashes: hashed.matches,
        headerUnchanged: scan ? scan.headHash === orderHeadHash(HEADER_JOB.ticket) : null,
        jobIdMatches: scan ? scan.jobId === HEADER_JOB.jobId : null,
        kind: scan?.kind ?? null,
        state: scan?.state ?? null,
      };
    }
    const header = orderHeader(HEADER_JOB.ticket);
    // The job was bought on 13 October 2026, before launch B was deployed that day.
    const headerNamedNoOrder =
      deployments.contracts.workOrders.address !== null
        ? "The header named no order either: the job was bought before the hire desk was launched, so its header is the header of no order on the desk, and no contract paid for anything."
        : "The header named no order either: the hire desk is not launched, so no contract paid for anything.";
    const hj = headerJob.value?.value ?? null;
    const listedRecord =
      headerRecords.value?.value?.find((r) => r.hash.toLowerCase() === HEADER_JOB.recordHash) ?? null;
    const receiptValue = headerReceipt.value?.value ?? null;
    const receiptOnChain =
      receiptValue === null
        ? null
        : !isZeroHash(receiptValue) && receiptValue.toLowerCase() === HEADER_JOB.recordHash;
    const recordShown =
      recordFacts?.hashes && recordFacts.headerUnchanged
        ? `The record this server holds under ${HEADER_JOB.recordHash} (${formatInt(recordFacts.bytes)} bytes, ${recordFacts.origin === "identitymd" ? "fetched from IdentityMD" : "a copy stored with this site, used because the record was not fetched from IdentityMD for this page"}) hashes to that hash, and the first 85 bytes of its objective are the header, byte for byte. The record gives the job's kind as ${recordFacts.kind ?? "unread"} and its state as ${recordFacts.state ?? "unread"}.`
        : recordFacts
          ? `The record this server holds under ${HEADER_JOB.recordHash} did not pass the check for this page (hashes to its hash: ${recordFacts.hashes ? "yes" : "no"}; header unchanged: ${recordFacts.headerUnchanged === null ? "could not be read" : recordFacts.headerUnchanged ? "yes" : "no"}). Run the commands.`
          : `The record could not be fetched for this page${headerRecord.error ? ` (${headerRecord.error})` : ""}; the commands fetch and check it.`;
    const listedWords = listedRecord
      ? ` IdentityMD's API lists the record as "${listedRecord.status}"${listedRecord.txHash ? ` with transaction ${listedRecord.txHash}` : ", with no transaction"}.`
      : "";
    const headerJobView: HeaderJobView = {
      jobId: HEADER_JOB.jobId,
      jobUrl: IMD_LINK.job(HEADER_JOB.jobId),
      recordsUrl: IMD_LINK.jobRecords(HEADER_JOB.jobId),
      recordUrl: IMD_LINK.workRecord(hashNo0x(HEADER_JOB.recordHash)),
      recordHash: HEADER_JOB.recordHash,
      header,
      ticket: HEADER_JOB.ticket,
      record: recordFacts,
      job: hj
        ? {
            state: hj.state,
            template: hj.template,
            paidBy: hj.paidBy,
            paidByHouse: houseLabel(hj.paidBy),
            createdAt: hj.createdAt,
            objectiveHasHeader: hj.objective.startsWith(header),
          }
        : null,
      listed: listedRecord ? { status: listedRecord.status, txHash: listedRecord.txHash } : null,
      receipt: {
        value: receiptValue,
        onChain: receiptOnChain,
        readAt: headerReceipt.value ? new Date(headerReceipt.value.fetchedAt).toISOString() : null,
      },
      shown: `A real swarm job, paid for on 13 October 2026, was given an objective that began with a HELP WANTED order header. IdentityMD kept those 85 bytes unchanged and wrote them into the job's work record. ${recordShown}${
        hj
          ? ` IdentityMD's API gives the job's state as "${hj.state}"${hj.paidBy ? ` and its payer as ${hj.paidBy}${houseLabel(hj.paidBy) ? ` (house wallet ${houseLabel(hj.paidBy)})` : ""}` : ""}.`
          : ""
      }`,
      notShown:
        receiptOnChain === true
          ? null
          : receiptOnChain === false
            ? `Not shown: a receipt on chain. WorkRegistry.latest for this job ${isZeroHash(receiptValue ?? "0x") ? "read zero" : `read ${receiptValue}, which is not this record's hash`} when this page was made (${formatUtc(headerReceipt.value?.fetchedAt ?? now)}).${listedWords} The receipt is still queued at IdentityMD, so this is a record that hashes to the hash the API lists, not a proof on chain. ${headerNamedNoOrder}`
            : `Not shown: a receipt on chain. The WorkRegistry could not be read for this page${headerReceipt.error ? ` (${headerReceipt.error})` : ""}, so nothing is said here about the receipt; the last time it was read by hand (13 October 2026) it was zero and the API listed the record as queued. Run the third command.${listedWords}`,
      commands: [
        {
          comment: `The record, hashed. Prints ${HEADER_JOB.recordHash}`,
          command: `curl -s ${IMD_LINK.workRecord(hashNo0x(HEADER_JOB.recordHash))} -o record.json && cast keccak "0x$(xxd -p record.json | tr -d '\\n')"`,
        },
        {
          comment: "The first 85 bytes of its objective: the header",
          command: "jq -j .objective record.json | head -c 85",
        },
        {
          comment: "The receipt on chain. Zeros until IdentityMD writes it",
          command: `cast call ${MAINNET.WORK_REGISTRY} "latest(bytes16)(bytes32)" ${HEADER_JOB.jobIdBytes16} --rpc-url ${PUBLIC_RPC}`,
        },
        {
          comment: "What IdentityMD's API says about the receipt",
          command: `curl -s ${IMD_LINK.jobRecords(HEADER_JOB.jobId)} | jq '.records[] | {hash, status, txHash}'`,
        },
      ],
    };

    // ---- What anyone can check on the live protocol today. ----
    const intakeRead = intake.value;
    const claims: Claim[] = [
      {
        claim:
          "IdentityMD's WorkRegistry holds, for each finished job, the keccak256 of its work record, so anyone can prove a delivery with one read and one hash.",
        readNow: v
          ? `Job ${REFERENCE_JOB.jobId.slice(0, 8)} checked for this page: ${v.stamp}. ${v.summary}`
          : null,
        evidence: [
          { label: "the check, live", url: referencePath },
          { label: "the receipt transaction", url: etherscanTx(REFERENCE_JOB.receiptTx) },
        ],
        command: oneGo,
      },
      {
        claim:
          "A receipt can lag far behind its job, so a product that pays on receipts must say what happens while one is missing. Ours refunds on timeout, and offers a bonded claim only if the employer chose it.",
        readNow:
          writer.stalled === null && flow.state === "unknown"
            ? null
            : `${writer.stalled === true ? "The WorkRegistry recorded no receipt in the last six hours of blocks." : writer.stalled === false ? "The WorkRegistry recorded a receipt within the last six hours of blocks." : "The registry's log could not be read."} ${flow.state === "unknown" ? "" : `${flow.observed} ${receiptFlowMeaning(flow)}`}`.trim(),
        evidence: [
          { label: "recent jobs and their receipts", url: "/" },
          { label: "the hire form's default, and why", url: "/hire" },
        ],
        command: writer.command,
      },
      {
        claim:
          "IdentityMD's API reports how many machines are online and how many have work, so the swarm's spare capacity is a public number. A hiring side is for the machines without work.",
        readNow: h ? `${formatInt(h.online)} online, ${formatInt(h.working)} working.` : null,
        evidence: [{ label: "the Work Wire", url: "/" }],
        command: `curl -s ${IMD_API_BASE}/health | jq '{connectedDaemons, workingNow}'`,
      },
      {
        claim:
          "Every paid action sends IMD to one fee address, so what the swarm is paid can be counted from Transfer logs.",
        readNow: tally
          ? `${formatImd(tally.totalWei)} IMD in ${formatInt(tally.payments)} payments from ${formatInt(tally.payers)} payers, blocks ${formatInt(tally.window.fromBlock)} to ${formatInt(tally.window.toBlock)}.`
          : null,
        evidence: [
          { label: "the Jobs Report tally", url: "/jobs-report" },
          { label: "the fee address", url: etherscanAddress(MAINNET.FEE_PAYEE) },
        ],
        // The same block range as the figure above, and one the public RPC serves.
        command: `${paymentsCommand(tally?.window ?? null)} | jq length`,
      },
      {
        claim:
          "The mainnet Intake counts every oracle request ever bought on chain and logs each one, so on-chain demand for oracle answers is a public number too.",
        readNow: intakeRead
          ? `Intake version 2: nonce() is ${intakeRead.current.nonce ?? "unread"}. Version 1 (legacy): nonce() is ${intakeRead.legacy.nonce ?? "unread"}. ${formatInt(intakeRead.requests.length)} requests are listed here, ${formatInt(intakeRead.requests.filter((r) => r.callbackTarget).length)} with a contract callback.`
          : null,
        evidence: [{ label: "the requests this site lists", url: "/questions" }],
        command: `cast call ${MAINNET.INTAKE} "nonce()(uint256)" --rpc-url ${PUBLIC_RPC} && cast call ${MAINNET.INTAKE_V1} "nonce()(uint256)" --rpc-url ${PUBLIC_RPC}`,
      },
      {
        claim:
          "The agents named in a work record can be traced to seats and their owners on chain, which is how per-job tips find the people behind the work.",
        readNow: binding?.bound
          ? `Agent 52211 (the one in the reference job's record) is bound to seat #${binding.tokenId}${binding.owner ? `, owned by ${binding.owner}` : ""}.`
          : null,
        evidence: [{ label: "the seat Adapter", url: etherscanAddress(MAINNET.SEAT_ADAPTER) }],
        command: `cast call ${MAINNET.SEAT_ADAPTER} "bindingOf(uint256)((uint8,address,uint256))" 52211 --rpc-url ${PUBLIC_RPC}`,
      },
      {
        claim:
          "sIMD counts its assets as its IMD balance, so a plain IMD transfer to it pays every staker on Ethereum with no call into the vault.",
        readNow:
          stake && balance !== null
            ? `totalAssets() is ${formatImd(stake.totalAssetsWei)} IMD; IMD.balanceOf(sIMD) is ${formatImd(balance)} IMD${stake.totalAssetsWei === balance ? ": equal" : ": read a moment apart"}.`
            : null,
        evidence: [{ label: "sIMD", url: etherscanAddress(MAINNET.SIMD) }],
        command: `cast call ${MAINNET.SIMD} "totalAssets()(uint256)" --rpc-url ${PUBLIC_RPC} && cast call ${MAINNET.IMD} "balanceOf(address)(uint256)" ${MAINNET.SIMD} --rpc-url ${PUBLIC_RPC}`,
      },
    ];

    // ---- The integration table. Each row follows the deployments book and the live reads. ----
    const book = orders.live && !env.sampleData ? orders.data : null;
    const l = ledger.live ? ledger.data : null;
    const feedBook = feeds.live ? feeds.data : null;
    const contractAddresses = new Set(
      Object.values(deployments.contracts)
        .map((c) => c.address?.toLowerCase())
        .filter((a): a is string => typeof a === "string"),
    );
    const notYet = (key: ContractKey) => `${deployments.contracts[key].name} is ${NOT_LAUNCHED}`;
    const unread = (what: string, error: string | null) =>
      `${what} could not be read just now${error ? `: ${error}` : ""}`;

    type RowInput = Omit<IntegrationRow, "contracts" | "launch" | "launchLabel" | "statusWords"> & {
      uses: ContractKey[];
      /** What this site does with the primitive today, when it does something. */
      onSite: string | null;
    };
    const row = ({ uses, onSite, ...rest }: RowInput): IntegrationRow => {
      const contracts = uses.map((key) => ({
        key,
        name: deployments.contracts[key].name,
        address: deployments.contracts[key].address,
      }));
      const launchedHere = contracts.filter((c) => c.address !== null);
      const launch: IntegrationRow["launch"] =
        contracts.length === 0
          ? "none"
          : launchedHere.length === 0
            ? "not_launched"
            : launchedHere.length === contracts.length
              ? "launched"
              : "partly";
      const names = (list: typeof contracts) => list.map((c) => c.name).join(", ");
      const contractWords =
        contracts.length === 0
          ? ""
          : launch === "launched"
            ? `Launched: ${launchedHere.map((c) => `${c.name} at ${c.address}`).join(", ")}.`
            : launch === "partly"
              ? `Launched: ${launchedHere.map((c) => `${c.name} at ${c.address}`).join(", ")}. Not launched yet: ${names(contracts.filter((c) => c.address === null))}.`
              : `In our contracts (${names(contracts)}); ${NOT_LAUNCHED}.`;
      return {
        ...rest,
        contracts,
        launch,
        launchLabel:
          launch === "launched"
            ? "Launched"
            : launch === "partly"
              ? "Partly launched"
              : launch === "none"
                ? "Done from a wallet"
                : "Built, not launched",
        statusWords: [onSite, contractWords].filter(Boolean).join(" "),
      };
    };

    const provenOrders = book
      ? book.orders.filter((o) => o.state === "Delivered" && o.terms?.proven).length
      : null;
    const ordersReason = orders.live ? (orders.error ?? "sample data is not counted") : notYet("workOrders");
    const ledgerReason = ledger.live ? unread("Payroll", ledger.error) : notYet("payroll");
    const boughtByOurs = intakeRead
      ? intakeRead.requests.filter((r) => r.version === 2 && contractAddresses.has(r.payer)).length
      : null;
    const launchesRecorded = LAUNCH_KEYS.filter((key) => deployments.launches[key].txHash !== null);
    const answeredFeeds = feedBook ? feedBook.feeds.filter((f) => f.latest.updatedAt > 0).length : null;
    const questionsLaunched = deployments.contracts.questions.address !== null;
    // What has happened on the three house feeds, from the contract's own views and round logs.
    const houseLive = feedBook ? feedBook.feeds.filter((f) => f.house !== null) : null;
    const roundsOpened = houseLive ? houseLive.reduce((sum, f) => sum + f.rounds, 0) : null;
    const roundsPending = houseLive ? houseLive.filter((f) => f.pending).length : null;
    const openers = (houseLive ?? []).flatMap((f) => f.roundList).filter((r) => r.keeper !== null);
    const openedByHouse = openers.filter((r) => ours.has(r.keeper as string)).length;
    const openersWords =
      openers.length === 0
        ? ""
        : ` Of the ${formatInt(openers.length)} round${openers.length === 1 ? "" : "s"} whose opening this server could read, ${formatInt(openedByHouse)} ${openedByHouse === 1 ? "was" : "were"} opened by our own wallets (HOUSE) and ${formatInt(openers.length - openedByHouse)} by others (OUTSIDE).`;
    // How the answers that exist arrived: by the Intake's own callback, or handed in with submit.
    const delivered = (houseLive ?? [])
      .flatMap((f) => f.roundList)
      .filter((r) => r.status === "Answered" && r.byCallback !== null);
    const byCallback = delivered.filter((r) => r.byCallback === true).length;
    const bySubmit = delivered.length - byCallback;
    const submitByHouse = delivered.filter(
      (r) => r.byCallback === false && r.deliveredBy !== null && ours.has(r.deliveredBy),
    ).length;
    const deliveredWords =
      delivered.length === 0
        ? ""
        : ` Of the ${formatInt(delivered.length)} answered round${delivered.length === 1 ? "" : "s"} whose delivery this server could read, ${formatInt(byCallback)} ${byCallback === 1 ? "was" : "were"} delivered by the Intake's own callback and ${formatInt(bySubmit)} handed in with submit${bySubmit > 0 ? ` (${formatInt(submitByHouse)} of ${bySubmit === 1 ? "that" : "those"} by our own wallets, HOUSE)` : ""}.`;
    const reportRead = report.live ? report.data : null;
    const printsSoFar = reportRead ? (reportRead.summary?.prints ?? reportRead.prints.length) : null;
    const heldWords =
      heldImd.length === 0
        ? null
        : heldImd
            .map(
              ({ key, read }) =>
                `${deployments.contracts[key].name} holds ${read.value ? `${formatImd(read.value.value)} IMD` : "an amount that could not be read just now"}`,
            )
            .join(", ");
    const feedProofLinks: Evidence[] = feedRows.map((r) => ({
      label: `${r.feed}: oracle request ${r.oracleRequestId.slice(0, 8)}`,
      url: r.url,
    }));
    const auditLinks: Evidence[] = AUDITS.map((a, index) => ({
      label: `audit report ${index + 1} (job ${a.jobId.slice(0, 8)})`,
      url: IMD_LINK.jobReport(a.jobId),
    }));

    const integration: IntegrationRow[] = [
      row({
        primitive: "WorkRegistry (work receipts)",
        where: MAINNET.WORK_REGISTRY,
        whereUrl: etherscanAddress(MAINNET.WORK_REGISTRY),
        use: "The settlement rule. WorkProof reads latest(jobId) and compares it with keccak256 of the submitted record; WorkOrders pays on a match, and without a match pays only an unchallenged bonded claim that the employer chose to allow.",
        status: "live",
        uses: ["workProof", "workOrders"],
        onSite: "The same check runs on this site today, for any job.",
        usage: {
          count: provenOrders === null ? null : formatInt(provenOrders),
          what: "orders settled against a registry receipt, among the newest 40",
          reason: provenOrders === null ? ordersReason : null,
        },
        proofs: [
          { label: "the reference job, checked live", url: referencePath },
          { label: "its receipt transaction", url: etherscanTx(REFERENCE_JOB.receiptTx) },
        ],
        proofNote: v
          ? `Read for this page: ${v.stamp}.`
          : "The check could not be run for this page; the link runs it again.",
        command: verifyCmds[0]?.command ?? null,
      }),
      row({
        primitive: "Work records",
        where: `${IMD_API_BASE}/work-records/<hash>.json`,
        whereUrl: IMD_LINK.workRecord(hashNo0x(REFERENCE_JOB.receipt)),
        use: "The bytes a settlement submits. WorkProof walks them on chain for the job id, the kind, the objective (which must begin with the order's header), the final state and the agents that worked.",
        status: "live",
        uses: ["workProof"],
        onSite: "Fetched, hashed and read on this site today.",
        usage: {
          count: book ? formatInt(book.orders.filter((o) => o.state === "Delivered").length) : null,
          what: "orders delivered, among the newest 40",
          reason: book ? null : ordersReason,
        },
        proofs: [
          { label: "the reference record", url: IMD_LINK.workRecord(hashNo0x(REFERENCE_JOB.receipt)) },
          { label: "the header job's record", url: headerJobView.recordUrl },
        ],
        proofNote: "Each hashes to the hash it is served under; the second carries our header.",
        command: verifyCmds[1]?.command ?? null,
      }),
      row({
        primitive: "Paid swarm jobs (x402)",
        where: `POST ${IMD_API_BASE}/jobs, paid to ${MAINNET.FEE_PAYEE}`,
        whereUrl: etherscanAddress(MAINNET.FEE_PAYEE),
        use: "A runner buys the job for each order with an x402 payment and puts the order's 85-byte header at the start of the objective. The Robot Jobs Report counts the payments that reach the fee address.",
        status: "live",
        uses: ["workOrders", "jobsReport"],
        onSite: "The tally of payments runs on this site today.",
        usage: {
          count: tally ? formatInt(tally.housePayments) : null,
          what: "payments to the fee address from house wallets and contracts, in the newest day of blocks",
          reason: tally ? null : unread("The payment logs", payments.error),
        },
        proofs: [
          { label: `the header job ${HEADER_JOB.jobId.slice(0, 8)}`, url: headerJobView.jobUrl },
          { label: "the tally", url: "/jobs-report" },
        ],
        proofNote:
          receiptOnChain === true
            ? "One real job carried the header into its work record, and its receipt is on chain."
            : "One real job carried the header into its work record. Its on-chain receipt is still queued at IdentityMD, so this is not yet a proof on chain.",
        command: headerJobView.commands[1]?.command ?? null,
      }),
      row({
        primitive: "Audit jobs bought from the swarm",
        where: `${IMD_API_BASE}/jobs/<id>/report.md`,
        whereUrl: IMD_LINK.jobReport(AUDITS[0]?.jobId ?? ""),
        use: "Launch A was read twice by IdentityMD's audit agents before its launch was requested. Each finding and what was done about it is listed on this page.",
        status: "built",
        uses: [],
        onSite: "Two audit jobs were bought, from house wallet W1.",
        usage: {
          count: formatInt(AUDITS.reduce((sum, a) => sum + a.findings.length, 0)),
          what: "findings reported across the two jobs",
          reason: null,
        },
        proofs: auditLinks,
        proofNote: `Both read commit ${AUDITED_COMMIT.slice(0, 7)}. We bought no audit of the fixes made afterwards; the launch pipeline's own steps read the code it launched, and what it changed is listed on this page.`,
        command: `curl -s ${IMD_LINK.jobReport(AUDITS[0]?.jobId ?? "")} | head -40`,
      }),
      row({
        primitive: "Intake, version 2 (oracle requests bought on chain)",
        where: MAINNET.INTAKE,
        whereUrl: etherscanAddress(MAINNET.INTAKE),
        use: "Questions.request pays the Intake from a feed's meter and names itself as the callback, so an ownerless contract buys swarm work on a schedule or when a line is crossed.",
        status: "live",
        uses: ["questions"],
        onSite: "This site lists the requests it has taken.",
        usage: {
          count: !questionsLaunched || boughtByOurs === null ? null : formatInt(boughtByOurs),
          what: "Intake requests bought by our contracts, among those listed",
          reason: !questionsLaunched
            ? notYet("questions")
            : boughtByOurs === null
              ? unread("The Intake's logs", intake.error)
              : null,
        },
        proofs: [{ label: "the requests this site lists", url: "/questions" }],
        proofNote: questionsLaunched
          ? "Requests our Questions contract bought are marked on that page."
          : "No request of ours exists on it yet: Questions is not launched. On a fork of mainnet the launch rehearsal buys a first request from the live contract.",
        command: `cast call ${MAINNET.INTAKE} "nonce()(uint256)" --rpc-url ${PUBLIC_RPC}`,
      }),
      row({
        primitive: "Intake, version 1 (legacy)",
        where: MAINNET.INTAKE_V1,
        whereUrl: etherscanAddress(MAINNET.INTAKE_V1),
        use: "Nothing of ours is launched against it. The three house feed questions were bought through it once each, from house wallet W1, to find out whether the live oracle answers them; it also holds the earlier history the questions page lists.",
        status: "live",
        uses: [],
        onSite: "Its requests are listed on this site beside version 2's.",
        usage: {
          count: formatInt(HOUSE_FEED_NAMES.length + 1),
          what: "requests bought through it by house wallet W1 for the house feeds (three attested, one first attempt not attested)",
          reason: null,
        },
        proofs: [
          ...feedRows.map((r) => ({ label: `${r.feed}: the purchase`, url: r.requestTxUrl })),
          { label: "employers, first attempt", url: etherscanTx(EMPLOYERS_FIRST_ATTEMPT.transaction) },
        ],
        proofNote: "Four transactions from W1; none names a callback.",
        command: `cast call ${MAINNET.INTAKE_V1} "nonce()(uint256)" --rpc-url ${PUBLIC_RPC}`,
      }),
      row({
        primitive: "Oracle attestations",
        where: `${IMD_API_BASE}/oracle/requests/<id>, signed by ${MAINNET.ORACLE_SIGNER}`,
        whereUrl: etherscanAddress(MAINNET.ORACLE_SIGNER),
        use: "Questions checks each answer's EIP-712 signature in its own domain, then the question hash, block window, panel size, quorum and expiry, before storing it. The verifier is IdentityMD's reference code.",
        status: "built",
        uses: ["questions"],
        onSite: null,
        usage: {
          count: answeredFeeds === null ? null : formatInt(answeredFeeds),
          what: "feeds holding an answer whose attestation our contract checked",
          reason:
            answeredFeeds !== null
              ? null
              : feeds.live
                ? unread("Questions", feeds.error)
                : notYet("questions"),
        },
        proofs: feedProofLinks,
        proofNote: !questionsLaunched
          ? "The live oracle attested all three house feed questions, for a wallet. No contract of ours has stored an answer: Questions is not launched. In the tests the real callback stores these three with their real signatures."
          : answeredFeeds === null
            ? "The live oracle attested all three house feed questions, for a wallet. Whether our Questions contract has stored an answer could not be read for this page."
            : answeredFeeds === 0
              ? "The live oracle attested all three house feed questions, for a wallet. Our Questions contract has stored no answer yet (read for this page); in the tests the real callback stores those three with their real signatures."
              : `Read for this page: ${formatInt(answeredFeeds)} feed${answeredFeeds === 1 ? "" : "s"} of our Questions contract hold${answeredFeeds === 1 ? "s" : ""} an answer whose attestation the contract checked on chain.${deliveredWords} The three links are the earlier answers bought for a wallet.`,
        command: feedRows[0]?.command ?? null,
      }),
      row({
        primitive: "IMD",
        where: MAINNET.IMD,
        whereUrl: etherscanAddress(MAINNET.IMD),
        use: "The only currency: escrows, runner bonds, fees, tips, meters and endowments are all IMD. There is no token of ours.",
        status: "built",
        uses: ["workOrders", "payroll", "questions", "crowdPots", "endowments", "rules"],
        onSite: "Transfers of it to the fee address are counted on this site today.",
        usage: {
          count: book ? formatInt(book.count) : null,
          what: "orders opened with IMD in escrow",
          reason: book ? null : ordersReason,
        },
        proofs: [{ label: "IMD on Etherscan", url: etherscanAddress(MAINNET.IMD) }],
        proofNote: heldWords
          ? `Read for this page: ${heldWords}.`
          : "None of ours yet: no contract of ours exists to hold IMD.",
        command: null,
      }),
      row({
        primitive: "sIMD (staked IMD)",
        where: MAINNET.SIMD,
        whereUrl: etherscanAddress(MAINNET.SIMD),
        use: "Payroll streams half of every fee to stakers by plain transfer over seven days. Endowments stake deposits here and spend only the yield.",
        status: "live",
        uses: ["payroll", "endowments"],
        onSite: "sIMD's holdings are read on this site today.",
        usage: {
          count: l ? `${formatImd(l.drippedWei)} IMD` : null,
          what: "sent to sIMD stakers by Payroll",
          reason: l ? null : ledgerReason,
        },
        proofs: [{ label: "the company page", url: "/company" }],
        proofNote: l
          ? l.drippedWei === 0n
            ? "Payroll's ledger, read live: it has sent nothing to sIMD yet."
            : "Payroll's ledger, read live."
          : ledger.live
            ? "Payroll is launched, but its ledger could not be read for this page."
            : "None yet: Payroll has sent nothing, because it does not exist.",
        command: `cast call ${MAINNET.SIMD} "totalAssets()(uint256)" --rpc-url ${PUBLIC_RPC}`,
      }),
      row({
        primitive: "Seats (ERC-721, ids 0 to 1999)",
        where: MAINNET.SEATS,
        whereUrl: etherscanAddress(MAINNET.SEATS),
        use: "Payroll sets aside 30% of every fee for seat owners; claimSeat pays whoever owns the seat at that moment.",
        status: "live",
        uses: ["payroll"],
        onSite: "Seat owners are read on this site today.",
        usage: {
          count: l ? `${formatImd(l.seatClaimedWei)} IMD` : null,
          what: "claimed by seat owners from Payroll",
          reason: l ? null : ledgerReason,
        },
        proofs: [{ label: "look up a seat", url: "/seats/1998" }],
        proofNote: l
          ? "The seat's owner and its claimable share, read live."
          : ledger.live
            ? "The owner is read live. Payroll is launched, but its ledger could not be read for this page."
            : "The owner is read live; nothing can be claimed until Payroll exists.",
        command: `cast call ${MAINNET.SEATS} "ownerOf(uint256)(address)" 1998 --rpc-url ${PUBLIC_RPC}`,
      }),
      row({
        primitive: "Seat Adapter and ERC-8004 agent ids",
        where: MAINNET.SEAT_ADAPTER,
        whereUrl: etherscanAddress(MAINNET.SEAT_ADAPTER),
        use: "A settled order tips the agents named in its work record; Payroll.claimTip resolves each agent id to its seat through bindingOf and pays the seat's owner.",
        status: "live",
        uses: ["payroll", "workOrders"],
        onSite: "Bindings are read on this site today.",
        usage: {
          count: l ? `${formatImd(l.tipsClaimedWei)} IMD` : null,
          what: "in tips claimed through agent bindings",
          reason: l ? null : ledgerReason,
        },
        proofs: [{ label: "the seats behind the reference job", url: referencePath }],
        proofNote: binding?.bound
          ? `Read for this page: agent 52211 is bound to seat #${binding.tokenId}.`
          : "The binding could not be read for this page; the command reads it.",
        command: `cast call ${MAINNET.SEAT_ADAPTER} "bindingOf(uint256)((uint8,address,uint256))" 52211 --rpc-url ${PUBLIC_RPC}`,
      }),
      {
        primitive: "The launch pipeline",
        where: `ProjectFactory ${MAINNET.PROJECT_FACTORY}`,
        whereUrl: etherscanAddress(MAINNET.PROJECT_FACTORY),
        use: "Each of our three launches is one evm_contracts launch through IdentityMD's pipeline: read by its audit agents, then created by the ProjectFactory in one transaction.",
        status: "built",
        contracts: [],
        launch:
          launchesRecorded.length === 0
            ? "not_launched"
            : launchesRecorded.length === LAUNCH_KEYS.length
              ? "launched"
              : "partly",
        launchLabel:
          launchesRecorded.length === 0
            ? deployments.launchedCount === 0
              ? "Requested, not launched"
              : "No transaction recorded"
            : launchesRecorded.length === LAUNCH_KEYS.length
              ? "Launched"
              : "Partly launched",
        statusWords:
          launchesRecorded.length === 0
            ? deployments.launchedCount === 0
              ? "Launch A has been requested and paid for. No launch transaction exists yet."
              : "Addresses are filled in, but no launch transaction is recorded with them in the deployments book."
            : `Recorded: launch ${launchesRecorded.join(", ")}.`,
        usage: {
          count: `${launchesRecorded.length} of ${LAUNCH_KEYS.length}`,
          what: "launches with a transaction recorded in the deployments book",
          reason: null,
        },
        proofs: [
          { label: `launch A's job ${LAUNCH_A_JOB.jobId.slice(0, 8)}`, url: pipeline.jobUrl },
          ...(deskPipeline
            ? [{ label: `launch B's job ${LAUNCH_B_JOB.jobId.slice(0, 8)}`, url: deskPipeline.jobUrl }]
            : []),
          ...launchesRecorded.map((key) => ({
            label: `launch ${key}'s transaction`,
            url: etherscanTx(deployments.launches[key].txHash as string),
          })),
        ],
        proofNote: `Launch A's job: ${pipeline.words}${deskPipeline ? ` Launch B's job: ${deskPipeline.words}` : ""}${launchRecorded(deployments, "B") ? ` What the pipeline's audits found in launch B, and that no contract code was changed for it, is in ${DESK_ADAPTATION.document}.` : ""}`,
        command: pipeline.command,
      },
      row({
        primitive: "The ETH/IMD pool (Uniswap v4)",
        where: `PoolManager ${MAINNET.POOL_MANAGER}`,
        whereUrl: etherscanAddress(MAINNET.POOL_MANAGER),
        use: "Zap swaps a visitor's ETH to IMD, with the visitor's own minimum and deadline, and chips into a pot or funds a feed's meter in one transaction, so a first-time visitor needs no IMD.",
        status: "built",
        uses: ["zap"],
        onSite: null,
        usage: {
          count: null,
          what: "swaps made through Zap",
          reason:
            deployments.contracts.zap.address === null
              ? notYet("zap")
              : "Zap keeps no counter; its swaps appear as its events, which this site does not count",
        },
        proofs: [],
        proofNote:
          "None yet. Zap is exercised against the live pool only on a fork of mainnet, in launch C's tests.",
        command: null,
      }),
    ];

    // ---- What is not live. Each line is there only while it is true. ----
    const site = env.siteOrigin ?? "$SITE";
    const anyUnlaunched = deployments.launchedCount < Object.keys(deployments.contracts).length;
    const notLive: string[] = [];
    for (const launch of launches) {
      if (!launch.launched) {
        notLive.push(`Launch ${launch.key} (${launch.contracts.join(", ")}): ${launch.status}`);
      }
    }
    if (!questionsLaunched) {
      notLive.push(
        "No feed exists, no oracle request has been bought by a contract of ours, and there is no on-chain Jobs Report print. The three questions were answered for a wallet, not for a contract.",
      );
    } else {
      // Launch A is live. What has and has not happened on it is said from what was read.
      if (!houseLive) {
        notLive.push(
          `Whether any house feed holds an answer could not be read just now: ${(feeds.live ? feeds.error : null) ?? "Questions did not answer"}.`,
        );
      } else if (houseLive.length === 0) {
        notLive.push(
          "Questions is launched and none of the three house feeds has been created in it yet: createFeed is a call anyone may make.",
        );
      } else if (houseLive.every((f) => f.latest.updatedAt === 0)) {
        notLive.push(
          `No round of a house feed has been answered yet, so no feed holds an answer and nothing has been delivered to a contract of ours: ${formatInt(houseLive.length)} of the three house feeds exist, with ${formatInt(roundsOpened ?? 0)} round${roundsOpened === 1 ? "" : "s"} opened and ${formatInt(roundsPending ?? 0)} still pending.${openersWords}`,
        );
      }
      if (houseLive && delivered.length > 0 && byCallback === 0) {
        notLive.push(
          `No answer has reached our Questions contract through the Intake's own callback yet: the ${formatInt(delivered.length)} answered round${delivered.length === 1 ? "" : "s"} this server could read ${delivered.length === 1 ? "was" : "were"} handed in with submit, ${formatInt(submitByHouse)} of them by our own wallets (HOUSE). The oracle signed those answers and the contract checked each signature; what has not been seen is the live Intake delivering one.`,
        );
      }
      if (deployments.contracts.jobsReport.address !== null) {
        if (printsSoFar === null) {
          notLive.push(
            `Whether the Jobs Report has printed could not be read just now: ${report.live ? (report.error ?? "JobsReport did not answer") : "JobsReport has no address"}.`,
          );
        } else if (printsSoFar === 0) {
          notLive.push(
            "The JobsReport contract has printed nothing: a print needs an answered round of the payrolls feed. The figures on the Jobs Report page are this site's unofficial tally.",
          );
        }
      }
    }
    if (!ledger.live) {
      notLive.push(
        "No fee has been split, no IMD has been sent to sIMD stakers or seat owners by us, and no seat has anything to claim: Payroll is not launched.",
      );
    } else if (l && l.receivedWei === 0n) {
      notLive.push(
        "Payroll is launched and has received no fee yet, so nothing has been split, nothing has been sent to sIMD stakers and no seat has anything to claim.",
      );
    } else if (!l) {
      notLive.push(
        `Whether any fee has been split could not be read just now: ${ledger.error ?? "Payroll did not answer"}.`,
      );
    }
    const deskLaunched = deployments.contracts.workOrders.address !== null;
    const potBook = pots.live && !env.sampleData ? pots.data : null;
    const bell = doorbell.live ? doorbell.data : null;
    if (!deskLaunched) {
      notLive.push(
        "No order, pot, rule or endowment exists on chain: the hire desk is not launched, so no order has been opened and none has been settled by a real job.",
      );
    } else if (env.sampleData) {
      notLive.push(
        "SAMPLE DATA mode is on: this server shows made-up orders and pots and counts none of them, so nothing is said here about the hire desk's real orders.",
      );
    } else {
      // Launch B is live. What has and has not happened on it is said from what was read.
      if (!book) {
        notLive.push(
          `Whether any order has been opened on the hire desk could not be read just now: ${orders.live ? (orders.error ?? "WorkOrders did not answer") : "WorkOrders has no address"}.`,
        );
      } else if (book.count === 0) {
        notLive.push(
          "The hire desk is launched and no order has been opened on it: its own counter, orderCount(), read 0 for this page. So no order has been taken by a runner, none has been delivered, and none has been settled by a real job.",
        );
      } else if (provenOrders === 0) {
        const read = book.orders.length;
        const paid = book.orders.filter((o) => o.state === "Delivered").length;
        const houseOrders = book.orders.filter((o) => ours.has(o.employer)).length;
        notLive.push(
          `${read === book.count ? "No order has been settled against a registry receipt, so none has been settled by a real job proven on chain." : `None of the newest ${formatInt(read)} orders has been settled against a registry receipt.`} ${book.count === 1 ? "One order has" : `${formatInt(book.count)} orders have`} been opened on the hire desk; ${read === book.count ? (read === 1 ? "it was" : `all ${formatInt(read)} were`) : `the newest ${formatInt(read)} were`} read for this page: ${formatInt(houseOrders)} from our own wallets and contracts (HOUSE) and ${formatInt(read - houseOrders)} from others (OUTSIDE). ${paid === 0 ? "None has been paid as delivered." : `${formatInt(paid)} ${paid === 1 ? "has" : "have"} been paid as delivered without a registry receipt.`}`,
        );
      }
      if (deployments.contracts.crowdPots.address !== null) {
        if (!potBook) {
          notLive.push(
            `Whether any crowd pot has been opened could not be read just now: ${pots.live ? (pots.error ?? "CrowdPots did not answer") : "CrowdPots has no address"}.`,
          );
        } else if (potBook.count === 0) {
          notLive.push(
            "No crowd pot has been opened: CrowdPots' own counter, potCount(), read 0 for this page.",
          );
        }
      }
      if (deployments.contracts.doorbell.address !== null) {
        if (!bell) {
          notLive.push(
            `What the Doorbell has done could not be read just now: ${doorbell.live ? (doorbell.error ?? "the Doorbell did not answer") : "the Doorbell has no address"}.`,
          );
        } else if (bell.hires === null) {
          notLive.push("How often the Doorbell has hired could not be read just now.");
        } else if (bell.hires === 0) {
          const rung =
            bell.rings === null
              ? "how often it has been rung could not be read"
              : bell.rings === 0
                ? "nobody has rung it"
                : `it has been rung ${plural(bell.rings, "time")}`;
          const holds =
            bell.balanceWei === null
              ? "an amount of IMD that could not be read"
              : `${formatImd(bell.balanceWei)} IMD`;
          const money =
            bell.funded === null
              ? `whether it is funded could not be read (it holds ${holds})`
              : bell.funded
                ? `it is funded (it holds ${holds})`
                : `it is not funded (it holds ${holds}), so a 25th ring would hire nothing until somebody sends it IMD`;
          notLive.push(
            `The Doorbell has opened no order: ${rung}, ${plural(bell.ringsUntilHire, "ring")} ${bell.ringsUntilHire === 1 ? "stands" : "stand"} before its next hire, and ${money}.`,
          );
        }
      }
    }

    // What this site has and has not been run against, said while it is true.
    if (deskLaunched && !env.sampleData && book?.count === 0 && potBook?.count === 0) {
      notLive.push(
        "This site has read launch B's contracts on mainnet only in their empty state. The page of an order, the page of a pot and a Doorbell that has hired have run only against stand-ins in its tests, because no order, pot or ring exists to read yet.",
      );
    }

    // ---- Who has used our contracts, from what this page read. Our own wallets and contracts are HOUSE. ----
    const byOthers: string[] = [];
    const byUsOnly: string[] = [];
    const notHappened: string[] = [];
    const notRead: string[] = [];
    if (questionsLaunched) {
      if (!houseLive) notRead.push("the house feeds");
      else if (openers.length > 0 && openers.length > openedByHouse) {
        byOthers.push(`${formatInt(openers.length - openedByHouse)} of the house feeds' rounds`);
      } else if (openers.length > 0) {
        byUsOnly.push(
          `every round of the house feeds whose opening this server could read (${formatInt(openers.length)}) was opened by our own wallets`,
        );
      } else if ((roundsOpened ?? 0) === 0) notHappened.push("no round has been opened on a house feed");
      else
        notRead.push("who opened the house feeds' rounds (their opening logs were not read for this page)");
    }
    if (deskLaunched && !env.sampleData) {
      if (!book) notRead.push("the hire desk's orders");
      else if (book.count === 0) notHappened.push("no order has been opened on the hire desk");
      else {
        const others = book.orders.filter((o) => !ours.has(o.employer)).length;
        if (others > 0)
          byOthers.push(`${formatInt(others)} of the newest ${formatInt(book.orders.length)} orders`);
        else
          byUsOnly.push(
            book.orders.length === 1
              ? "the one order read from the hire desk was opened by one of our own wallets or contracts"
              : `the newest ${formatInt(book.orders.length)} orders on the hire desk were all opened by our own wallets and contracts`,
          );
      }
      if (deployments.contracts.crowdPots.address !== null) {
        if (!potBook) notRead.push("the crowd pots");
        else if (potBook.count === 0) notHappened.push("no crowd pot has been opened");
        else {
          const known = potBook.pots.filter((pot) => pot.opener !== null);
          const others = known.filter((pot) => !ours.has(pot.opener as string)).length;
          if (others > 0) byOthers.push(`${formatInt(others)} of the newest ${formatInt(known.length)} pots`);
          else if (known.length > 0)
            byUsOnly.push(
              known.length === 1
                ? "the one crowd pot read was opened by one of our own wallets"
                : `the newest ${formatInt(known.length)} crowd pots were all opened by our own wallets`,
            );
          else notRead.push("who opened the crowd pots");
        }
      }
      if (deployments.contracts.doorbell.address !== null) {
        if (!bell || bell.rings === null) notRead.push("the Doorbell's rings");
        else if (bell.rings === 0) notHappened.push("nobody has rung the Doorbell");
        else if (!bell.ringers || bell.ringers.read === 0) notRead.push("who rang the Doorbell");
        else {
          // The contract names no ringer: only the Rang logs this server could read tell them apart.
          const rings = ringsByOrigin(bell.ringers, ours);
          if (rings.outside > 0) {
            byOthers.push(
              `${formatInt(rings.outside)} of the ${formatInt(rings.read)} rings of the Doorbell whose log was read`,
            );
          } else {
            byUsOnly.push(
              `the ${plural(rings.read, "ring")} of the Doorbell whose log this server could read ${rings.read === 1 ? "was" : "were all"} sent by our own wallets`,
            );
          }
          if (rings.read < bell.rings) notRead.push("who sent the Doorbell's other rings");
        }
      }
    }
    // Said only while nothing read was done by anyone else, and only of what was read.
    if (byOthers.length === 0 && byUsOnly.length + notHappened.length > 0) {
      notLive.push(
        `No use of our contracts by anyone outside the team was found in what this page read: ${[...notHappened, ...byUsOnly].join("; ")}.${notRead.length > 0 ? ` Not read: ${notRead.join("; ")}.` : ""} What our own wallets and contracts do is HOUSE and is never counted as outside usage.`,
      );
    }
    // Receipts: the six-hour test the hire form applies, and the figures read beside it.
    const whilstStalled =
      "While that lasts, only an order whose employer allowed the bonded-claim path can be paid; a receipt-only order ends in a refund.";
    const observed = flow.state === "unknown" ? "" : ` ${flow.observed}`;
    if (writer.stalled === true) {
      notLive.push(
        `IdentityMD's receipts are stalled: its WorkRegistry recorded none in the last six hours of blocks.${observed} ${whilstStalled}`,
      );
    } else if (writer.stalled === null && flow.state === "late") {
      notLive.push(
        `IdentityMD's receipts are late or not arriving:${observed} The registry's own log of the last six hours could not be read just now, so the six-hour test was not run for this page. ${whilstStalled}`,
      );
    } else if (writer.stalled === null) {
      notLive.push(
        "Whether IdentityMD's receipts are arriving could not be read just now: the WorkRegistry's log did not answer.",
      );
    }
    if (receiptOnChain !== true) {
      notLive.push(
        "The header job's receipt is not on chain. Its record carries our header; the WorkRegistry does not hold its hash yet.",
      );
    }
    const notLaunchedKeys = launches.filter((launch) => !launch.launched).map((launch) => launch.key);
    if (anyUnlaunched) {
      notLive.push(
        "The pages for contracts that are not launched are complete as pages and show the exact transactions and the cast commands, but their buttons stay disabled until the contract has an address in the deployments book, and until that address answers as the contract.",
        notLaunchedKeys.length === LAUNCH_KEYS.length
          ? "This site's reads of our own contracts have run only against stand-ins in its tests, because no contract of ours exists to read."
          : `This site's reads of the contracts that are not launched (${notLaunchedKeys.map((key) => `launch ${key}`).join(", ")}) have run only against stand-ins in its tests, because those contracts do not exist to read.`,
      );
    }
    notLive.push(
      deskLaunched
        ? "The keeper, the runner and the indexer are in the repository (bots/keeper, bots/runner, apps/indexer). The indexer folds launch A's events into tables; for the hire desk, the crowd pots and the Doorbell it stores the raw logs and its handlers are still stubs, so it holds no table of orders, claims or pots. This site does not read from the indexer; it reads the chain and IdentityMD's API directly, so an order's or a pot's job text is shown only while its opening log is within about a day, and there is no history of rings."
        : questionsLaunched
          ? "The keeper, the runner and the indexer are in the repository (bots/keeper, bots/runner, apps/indexer). Since launch A the keeper has feeds to keep; the runner has no desk to take orders from. This site does not read from the indexer; it reads the chain and IdentityMD's API directly."
          : "The keeper, the runner and the indexer are in the repository (bots/keeper, bots/runner, apps/indexer). None has anything to act on yet: there is no feed to keep and no desk to take orders from. This site does not read from the indexer; it reads the chain and IdentityMD's API directly.",
      "Wallet buttons have not been exercised with a real wallet: the transactions they build are encoded with the same ABIs the contracts are built from, and each is shown as a cast command, but no transaction has been signed through this site.",
      `We bought no audit after the two of launch A: the fixes made afterwards and the two waits changed have not been audited again by a job of ours. The code on chain is what IdentityMD's launch pipeline made of it, after that pipeline's own audit, adaptation and review steps. ${
        launchRecorded(deployments, "B")
          ? `Launch B was audited by that pipeline before it was deployed, and by nobody else: we bought no audit of it (${DESK_ADAPTATION.document} has what was found). Launch C has not been audited by a third party.`
          : "Launches B and C have not been audited by a third party."
      }`,
    );

    const documents = (["A", "B", "C"] as const).map((launch) => ({
      launch,
      path: THREATS_DOCUMENT[launch],
      count: DISCLOSED_LIMITS.filter((r) => r.launch === launch).length,
    }));
    const outcomeCounts: Record<FindingOutcome, number> = {
      fixed: 0,
      "documents corrected": 0,
      "left open": 0,
      left: 0,
    };
    for (const report of AUDITS) for (const finding of report.findings) outcomeCounts[finding.outcome]++;

    return {
      generatedAt: now.toISOString(),
      summary: summaryFor(deployments),
      summaryWords: summaryFor(deployments).split(/\s+/).length,
      launchedCount: deployments.launchedCount,
      launchSummary: launchSummaryFor(deployments),
      contracts: allContracts(deployments),
      launches,
      pipeline,
      deskPipeline,
      switchOn: `Every address on this site comes from one place: the deployments book in the shared package (${DEPLOYMENT_BOOK_PATH}). When a launch is mined, its transaction, block and addresses are written there, and every page, every twin, /llms.txt and /api/v1/deployments switch on from that one edit. Until then each contract reads "${NOT_LAUNCHED}".`,
      receipts: flow,
      writer,
      feedProofs: {
        intro:
          "On 12 and 13 October 2026 each of the three house feed questions was bought once from the live oracle, with exactly the body our Questions contract assembles, and all three were attested. They were bought from house wallet W1 through the legacy Intake (version 1).",
        rows: feedRows,
        firstAttempt: {
          url: IMD_LINK.oracleRequest(EMPLOYERS_FIRST_ATTEMPT.oracleRequestId),
          txUrl: etherscanTx(EMPLOYERS_FIRST_ATTEMPT.transaction),
          outcome: EMPLOYERS_FIRST_ATTEMPT.outcome,
        },
        limit: `What this does not show: the requests named no callback, so no answer was delivered to a contract. That our Questions contract accepts these three attestations is shown by a test that feeds them, with their real signatures, to the real callback. ${
          !questionsLaunched
            ? "On chain it will be shown by the first answered round after launch A."
            : answeredFeeds === null
              ? "Whether a round has been answered on chain since launch A could not be read for this page."
              : answeredFeeds === 0
                ? "On chain it will be shown by the first answered round: none has been answered yet (read for this page)."
                : `On chain, ${formatInt(answeredFeeds)} feed${answeredFeeds === 1 ? "" : "s"} of the launched contract now hold${answeredFeeds === 1 ? "s" : ""} an answer it checked; the questions page lists every round.${deliveredWords}`
        }`,
        testCommand: "cd launches/a-payroll && forge test --match-path test/questions/HouseFeedProofs.t.sol",
      },
      audits: {
        commit: AUDITED_COMMIT,
        intro: `IdentityMD's audit agents read launch A twice, in two jobs bought from the swarm, both at commit ${AUDITED_COMMIT}. Every finding is below with what was done about it, as launches/a-payroll/docs/AUDITS.md records it.`,
        reports: AUDITS.map((a) => ({
          jobId: a.jobId,
          jobUrl: IMD_LINK.job(a.jobId),
          reportUrl: IMD_LINK.jobReport(a.jobId),
          judged: a.judged,
          asked: a.asked,
          findings: a.findings.map((f) => ({ ...f })),
        })),
        counts: outcomeCounts,
        after: CHANGED_AFTER_AUDITS,
        document: "launches/a-payroll/docs/AUDITS.md",
        adaptation: {
          intro: `IdentityMD's launch pipeline did not launch the code as we sent it. Its own audit step raised ${LAUNCH_ADAPTATION.findings.length} findings; its adaptation step reproduced each and changed the code for ${LAUNCH_ADAPTATION.findings.filter((f) => f.outcome === "changed").length} of them, as ${LAUNCH_ADAPTATION.document} records. The contracts on chain are the code after those changes. IdentityMD's record of the job, as read on ${LAUNCH_ADAPTATION.reviewedAfter.read}, makes ${LAUNCH_ADAPTATION.reviewedAfter.steps.length} further review steps depend on the adaptation step (${LAUNCH_ADAPTATION.reviewedAfter.steps.join(", ")}). ${
            pipeline.read
              ? `Read for this page: ${formatInt(pipeline.read.steps.filter((step) => LAUNCH_ADAPTATION.reviewedAfter.steps.includes(step.key) && step.state === "accepted").length)} of those ${LAUNCH_ADAPTATION.reviewedAfter.steps.length} are accepted.`
              : 'The record could not be read for this page; the command under "Where the launches stand" reads it.'
          } This site has no report of theirs to link, and says nothing of what they found.`,
          document: LAUNCH_ADAPTATION.document,
          findings: LAUNCH_ADAPTATION.findings.map((f) => ({ ...f })),
        },
        desk: !launchRecorded(deployments, "B")
          ? null
          : {
              intro: `IdentityMD's launch pipeline read launch B before it deployed it${deployments.launches.B.launchNumber !== null ? ` as launch ${deployments.launches.B.launchNumber}` : ""}, and ${DESK_ADAPTATION.document} records what it found. The audit it imported reported ${DESK_ADAPTATION.findings.filter((f) => f.raisedBy === "the audit the pipeline imported").length} entries, all at level info. An independent reviewer then reopened the accepted work with ${plural(deskMedium, "medium finding")} and ${DESK_ADAPTATION.findings.filter((f) => f.raisedBy === "the independent review" && f.severity === "info").length} info notes. Each was reproduced against the code. No contract code was changed for any of them. The medium finding was answered in words, not in code: the desk's rule was kept on purpose, and the comments and documents that claimed more than the code gives were corrected. The limit it describes stands today and is in the table of disclosed limits below, as launch B's C2 with W2, W3 and W5. We bought no audit of launch B ourselves. The pipeline's own public record of the job, with the state of each of its audit steps, is read for this page under "Where the launches stand"; what those steps found is in that document.`,
              document: DESK_ADAPTATION.document,
              documentUrl: PUBLIC_SOURCE.B
                ? `${PUBLIC_SOURCE.B.repository}/blob/${PUBLIC_SOURCE.B.branch}/ADAPTATION.md`
                : null,
              corrected: DESK_ADAPTATION.corrected,
              counts: { medium: deskMedium, info: deskInfo, contractCodeChanged: 0 },
              findings: DESK_ADAPTATION.findings.map((f) => ({ ...f })),
            },
      },
      headerJob: headerJobView,
      claims,
      integration,
      reproduce: [
        {
          title: "Prove a delivery by hand",
          note: "No key, no account. Needs Foundry's cast, curl and xxd.",
          commands: verifyCmds.map((c) => `# ${c.comment}\n${c.command}`).join("\n\n"),
        },
        ...(deployments.contracts.workProof.address !== null
          ? [
              {
                title: "Ask the launched WorkProof",
                note: "The same claim through our own contract on mainnet: called with the reference job's record as served, prove answers with the record's hash first and the agent that did the work last, and reverts for any other bytes. It is a call, not a transaction: it sends nothing and costs nothing.",
                commands: [
                  `# The record, exactly as IdentityMD serves it\ncurl -s ${IMD_LINK.workRecord(hashNo0x(REFERENCE_JOB.receipt))} -o record.json`,
                  `# Prints the record's hash first, ${REFERENCE_JOB.receipt}, and the agent last, [52211]\n${castView(deployments.contracts.workProof.address, "WORK_PROOF", workProofAbi, "prove", [REFERENCE_JOB.jobIdBytes16, `"0x$(xxd -p record.json | tr -d '\\n')"`, "0"])}`,
                ].join("\n\n"),
              },
            ]
          : []),
        ...(deployments.launchedCount > 0
          ? [
              {
                title: "Compare the launched code with the source",
                note: `For a reader who has the whole repository. It builds each launch project that has a launched contract into a temporary folder, fetches the code at each address in the deployments book, and compares the two byte for byte with the immutable words (the constructor arguments) set to zero in both. It prints one line for each of the ${deployments.launchedCount} launched contracts, MATCH when they are equal, and sends no transaction. Needs Foundry and Node.`,
                commands: "pnpm repro",
              },
            ]
          : []),
        {
          title: "Check the header job",
          note: "The first two need no chain. The third is the one that still reads zero.",
          commands: headerJobView.commands.map((c) => `# ${c.comment}\n${c.command}`).join("\n\n"),
        },
        {
          title: "Read the three oracle answers and the two audit reports",
          note: "Public records at IdentityMD. No key.",
          commands: [
            ...feedRows.map((r) => `# ${r.title}\n${r.command}`),
            ...AUDITS.map(
              (a, index) => `# Audit report ${index + 1}\ncurl -s ${IMD_LINK.jobReport(a.jobId)}`,
            ),
          ].join("\n\n"),
        },
        {
          title: "Is the receipt writer stalled? The test the hire form uses",
          note: "Counts WorkRecorded events in the last six hours of blocks. Zero means stalled.",
          commands: writer.command,
        },
        {
          title: "Check this site's own claim from a script",
          note: env.siteOrigin
            ? "Every page has a JSON and a Markdown twin; append .json or .md to its path."
            : "Every page has a JSON and a Markdown twin; append .json or .md to its path. Set SITE to the address you are reading this at, for example SITE=https://example.org (this server has not been told its own public address).",
          commands: [
            `curl -s ${site}${referencePath}.json | jq '{verdict: .data.result.verdict, receipt: .data.result.receipt, keccak: .data.result.record.keccak}'`,
            `curl -s ${site}/judges.json | jq '.data.headerJob | {record, listed, receipt}'`,
            `curl -s ${site}/api/v1/integration | jq '.rows[] | {primitive, launch, proofNote}'`,
            `curl -s ${site}/api/v1/deployments`,
          ].join("\n"),
        },
        {
          title: "Build and test launch A's contracts",
          note: `Foundry is the only requirement; dependencies are vendored. Its README says forge test runs ${formatInt(SUITES.A.tests)} tests in ${SUITES.A.suites} suites with no network, and the fork profile runs ${SUITES.A.forkTests} more against Ethereum mainnet at the latest block, each skipping itself when the RPC cannot be reached.${PUBLIC_SOURCE.A ? ` In the public repository (${PUBLIC_SOURCE.A.repository}) the project is the root of branch ${PUBLIC_SOURCE.A.branch}, so the first command is not needed there.` : ""}`,
          commands: [
            `cd ${SUITES.A.project}`,
            "forge build --sizes",
            "forge test",
            "FOUNDRY_PROFILE=fork forge test",
          ].join("\n"),
        },
        {
          title: "Build and test launches B and C",
          note: `Launch B: ${sourceWords("B")} Launch C: ${sourceWords("C")} Where a source is not public the commands are for a reader who has the repository. Their READMEs say: B, ${formatInt(SUITES.B.tests)} tests in ${SUITES.B.suites} suites and ${SUITES.B.forkTests} fork tests; C, ${formatInt(SUITES.C.tests)} tests in ${SUITES.C.suites} suites and ${SUITES.C.forkTests} fork tests, with a second project that runs C against the real sources of A and B.`,
          commands: [
            `cd ${SUITES.B.project} && forge test && FOUNDRY_PROFILE=fork forge test`,
            `cd ${SUITES.C.project} && forge test && FOUNDRY_PROFILE=fork forge test`,
            `cd ${SUITES.C.project}/integration && forge test`,
          ].join("\n"),
        },
        {
          title: "Test the shared package and this site",
          note: "The shared package holds the addresses, the ABIs generated from the contracts' build output, the house feeds and the order header. Neither suite touches the network.",
          commands: [
            "pnpm install",
            "pnpm --filter @help-wanted/shared test",
            "pnpm --filter @help-wanted/web typecheck",
            "pnpm --filter @help-wanted/web test",
            "pnpm --filter @help-wanted/web build",
          ].join("\n"),
        },
      ],
      limits: {
        total: DISCLOSED_LIMITS.length,
        documents,
        rows: limitRows(),
        note: "Every entry of the three launch projects' threat documents: the trust roots, the limits of each contract, the limits of the build and its tests, what each launch inherits, and what is not verified. Each row is the document's own heading and how its text begins; the document has the whole of it. A row marked \"since\" has been overtaken by something that happened after the document was written.",
      },
      desk: {
        head: `${PUBLIC_SOURCE.B ? `source public on branch ${PUBLIC_SOURCE.B.branch}` : "not public yet"} · ${launchIsLive(deployments, "B") ? "launched" : "no address"}`,
        intro: `${DESK_FROM_ITS_DOCUMENTS.what} ${sourceWords("B")} ${launchIsLive(deployments, "B") ? "It is launched: its addresses are in the table of contracts above." : "It has no address: it is not launched."} What follows is how its own documents describe it.`,
        points: [...DESK_FROM_ITS_DOCUMENTS.points],
        // What the README says of the launch itself is printed only while the book holds launch B.
        status: DESK_FROM_ITS_DOCUMENTS.status.filter(
          (line) =>
            launchRecorded(deployments, "B") ||
            !SAID_OF_THE_LAUNCHED_DESK.some((start) => line.startsWith(start)),
        ),
        statusAsOf: DESK_FROM_ITS_DOCUMENTS.asOf,
      },
      notLive,
      neverClaimed: NEVER_CLAIMED,
      houseWallets: HOUSE_WALLETS.map((w) => ({ label: w.label, address: w.address, role: w.role })),
      machineReadable: [
        { label: "/judges.json", url: "/judges.json" },
        { label: "/judges.md", url: "/judges.md" },
        { label: "/llms.txt", url: "/llms.txt" },
        { label: "/llms-full.txt", url: "/llms-full.txt" },
        { label: "/api/v1", url: "/api/v1" },
        { label: "/api/v1/integration", url: "/api/v1/integration" },
        { label: "/api/v1/evidence", url: "/api/v1/evidence" },
        { label: "/openapi.json", url: "/openapi.json" },
        { label: "/api/v1/deployments", url: "/api/v1/deployments" },
        { label: "/api/v1/status", url: "/api/v1/status" },
        ...(env.siteOrigin ? [{ label: "/sitemap.xml", url: "/sitemap.xml" }] : []),
      ],
      sources: [
        sourceNote(
          "Reference job check",
          `WorkRegistry at ${MAINNET.WORK_REGISTRY} and ${IMD_API_BASE}/work-records`,
          verify.value?.reads.receiptReadAt
            ? { fetchedAt: Date.parse(verify.value.reads.receiptReadAt), stale: false, error: null }
            : null,
          verify.error ?? verify.value?.result.problems[0] ?? null,
        ),
        sourceNote(
          "Header job receipt",
          `WorkRegistry.latest(${HEADER_JOB.jobIdBytes16})`,
          headerReceipt.value,
          headerReceipt.error,
        ),
        sourceNote(
          "Launch A's job",
          `GET ${IMD_API_BASE}/jobs/${LAUNCH_A_JOB.jobId}`,
          pipelineJob.value,
          pipelineJob.error,
        ),
        ...(deskPipelineJob
          ? [
              sourceNote(
                "Launch B's job",
                `GET ${IMD_API_BASE}/jobs/${LAUNCH_B_JOB.jobId}`,
                deskPipelineJob.value,
                deskPipelineJob.error,
              ),
            ]
          : []),
        sourceNote("Swarm state", `GET ${IMD_API_BASE}/health`, health.value, health.error),
        sourceNote(
          "Receipt writer",
          `WorkRecorded logs of ${MAINNET.WORK_REGISTRY}, newest six hours of blocks`,
          writerRead,
          writerRead.error,
        ),
        sourceNote(
          "Intake requests",
          `logs of ${MAINNET.INTAKE} and ${MAINNET.INTAKE_V1}`,
          intake.value,
          intake.error,
        ),
        sourceNote("Payments", `IMD Transfer logs to ${MAINNET.FEE_PAYEE}`, payments.value, payments.error),
        sourceNote("sIMD and seats", `eth_call through ${chain.rpcHost}`, staking.value, staking.error),
      ],
    };
  },
  meta: () => ({
    title: "For judges",
    description:
      "What HELP WANTED is in 150 words, where its launches stand, what has been proven on the live system with a public link for each, the integration table, reproduce commands, every disclosed limit, and what is not live yet.",
  }),
  markdown(m) {
    const h = m.headerJob;
    return doc(
      "## What this is",
      m.summary,
      "## Where the launches stand",
      m.launchedCount === 0
        ? m.launchSummary.replace(/^Nothing is launched yet\./, "**Nothing is launched yet.**")
        : m.launchSummary,
      bullets(
        m.launches.map((l) => `**Launch ${l.key}, ${l.name}** (${l.contracts.join(", ")}). ${l.status}`),
      ),
      `Launch A's job: ${link(m.pipeline.jobId, m.pipeline.jobUrl)}. ${m.pipeline.words}`,
      m.deskPipeline
        ? `Launch B's job: ${link(m.deskPipeline.jobId, m.deskPipeline.jobUrl)}. ${m.deskPipeline.words}`
        : null,
      fence([m.pipeline.command, ...(m.deskPipeline ? [m.deskPipeline.command] : [])].join("\n"), "sh"),
      m.switchOn,
      table(
        ["Launch", "Contract", "Address", "What it does"],
        m.contracts.map((c) => [c.launch, c.name, c.label, c.role]),
      ),
      "## Proven on the live system",
      "### 1. The live oracle answers the three house feed questions",
      m.feedProofs.intro,
      table(
        [
          "Feed",
          "Oracle request",
          "Blocks",
          "Answer",
          "Agreement",
          "How it is settled",
          "Our text hashes to what was attested",
        ],
        m.feedProofs.rows.map((r) => [
          r.title,
          `${link(r.oracleRequestId, r.url)} · ${link("purchase", r.requestTxUrl)}`,
          r.window,
          r.answer,
          `${r.agreed}, attested ${formatUtc(r.attestedAt)}`,
          r.settled,
          r.bodyMatches && r.questionHashMatches
            ? "yes: body and question hash"
            : "NO: see the questions page",
        ]),
      ),
      `The employers feed's first body was not attested, and that is part of the record: ${link("the request", m.feedProofs.firstAttempt.url)} · ${link("its purchase", m.feedProofs.firstAttempt.txUrl)}. ${m.feedProofs.firstAttempt.outcome}`,
      m.feedProofs.limit,
      fence([...m.feedProofs.rows.map((r) => r.command), m.feedProofs.testCommand].join("\n"), "sh"),
      "### 2. IdentityMD's agents audited launch A twice",
      m.audits.intro,
      ...m.audits.reports.map((report, index) =>
        doc(
          `**Report ${index + 1}**: ${link("the report", report.reportUrl)} · ${link(`job ${report.jobId}`, report.jobUrl)} · judged ${report.judged}. Asked: ${report.asked}`,
          table(
            ["Finding", "Severity", "What was found", "Outcome", "What was done"],
            report.findings.map((f) => [f.id, f.severity, f.finding, f.outcome, f.done]),
          ),
        ).trimEnd(),
      ),
      `Outcomes: ${m.audits.counts.fixed} fixed in the code, ${m.audits.counts["documents corrected"]} answered by correcting the documents, ${m.audits.counts["left open"]} acknowledged and left open, ${m.audits.counts.left} left. ${m.audits.after}`,
      "**What the launch pipeline changed before the launch.**",
      m.audits.adaptation.intro,
      table(
        ["Finding", "Outcome", "What was reproduced and what was done"],
        m.audits.adaptation.findings.map((f) => [`${f.title} (${f.id.slice(0, 8)})`, f.outcome, f.done]),
      ),
      ...(m.audits.desk
        ? [
            "**What the launch pipeline's audits found in launch B.**",
            m.audits.desk.intro,
            table(
              [
                "Finding",
                "Severity",
                "Raised by",
                "What was found",
                "Outcome",
                "What was reproduced and what was done",
              ],
              m.audits.desk.findings.map((f) => [f.id, f.severity, f.raisedBy, f.finding, f.outcome, f.done]),
            ),
            `${m.audits.desk.corrected} The document: ${m.audits.desk.documentUrl ? link(m.audits.desk.document, m.audits.desk.documentUrl) : inline(m.audits.desk.document)}.`,
          ]
        : []),
      "### 3. A real job that carried our order header into its work record",
      `Job ${link(h.jobId, h.jobUrl)} · ${link("its record", h.recordUrl)} · ${link("the API's record list", h.recordsUrl)}`,
      h.shown,
      h.notShown
        ? `**${h.notShown}**`
        : "**The receipt is on chain:** WorkRegistry.latest for this job equals the record's hash.",
      fence(h.commands.map((c) => `# ${c.comment}\n${c.command}`).join("\n\n"), "sh"),
      "## What anyone can check on the live protocol today",
      ...m.claims.map((c, index) =>
        doc(
          `### ${index + 1}. ${c.claim}`,
          bullets([
            `Read when this page was made: ${c.readNow ?? "the read failed; use the command."}`,
            `Evidence: ${c.evidence.map((e) => link(e.label, e.url)).join(" · ")}`,
          ]),
          c.command ? fence(c.command, "sh") : null,
        ).trimEnd(),
      ),
      "## Integration: one row per IdentityMD primitive",
      "Each row gives the address or endpoint, what we do with it, and where the proof is. Where there is no proof yet, the row says so.",
      table(
        ["Primitive", "Address or endpoint", "What we do with it", "Status", "Where the proof is"],
        m.integration.map((r) => [
          r.primitive,
          r.where,
          r.use,
          `${r.launchLabel}. ${r.statusWords} ${r.usage.count !== null ? `Counted now: ${r.usage.count} ${r.usage.what}.` : `Nothing to count: ${r.usage.reason}.`}`,
          [
            r.proofs.map((e) => link(e.label, e.url)).join(" · "),
            r.proofNote,
            r.command ? inline(r.command) : null,
          ]
            .filter(Boolean)
            .join(" "),
        ]),
      ),
      "## Reproduce",
      ...m.reproduce.map((r) => doc(`### ${r.title}`, r.note, fence(r.commands, "sh")).trimEnd()),
      "## Every disclosed limit",
      `${m.limits.total} entries: ${m.limits.documents.map((d) => `launch ${d.launch}, ${d.count} (${d.path})`).join("; ")}. ${m.limits.note}`,
      table(
        ["Launch", "Entry", "Part of the document", "The limit", "Since"],
        m.limits.rows.map((r) => [r.launch, r.id, r.section, r.text, r.since ?? ""]),
      ),
      "## Launch B: the receipt check and the hire desk",
      m.desk.intro,
      bullets(m.desk.points),
      `Its status, in the words of its README as it stood on ${m.desk.statusAsOf}:`,
      bullets(m.desk.status),
      "## What is not live yet",
      bullets(m.notLive),
      "## What we do not claim",
      bullets(m.neverClaimed),
      "## House wallets",
      "Activity from these addresses is labelled HOUSE in every count.",
      table(
        ["Label", "Address", "Role"],
        m.houseWallets.map((w) => [w.label, w.address, w.role]),
      ),
      "## Machine-readable",
      bullets(m.machineReadable.map((e) => link(e.label, e.url))),
      `Generated ${formatUtc(m.generatedAt)}.`,
    );
  },
};
