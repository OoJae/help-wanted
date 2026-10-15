/**
 * "/verify" and "/verify/:jobId": the product's central claim, checked in front of the reader.
 *
 * The server runs the whole check (so the page is complete without JavaScript and in both twins);
 * the page then lets the browser run it again on its own: its own call to a public RPC, its own
 * hashing of the record bytes. The verdict does not depend on trusting this server either way,
 * because bytes that were altered would not hash to the receipt on chain.
 */
import type { Hex } from "viem";
import { IMD_API_BASE, MAINNET } from "@help-wanted/shared";
import { REFERENCE_JOB, etherscanAddress, etherscanTx, explorerJob } from "~/config/chain";
import type { AgentBinding } from "~/data/chain";
import { UpstreamBusyError } from "~/lib/cache";
import { excerpt, formatInt, formatUtc } from "~/lib/format";
import { isZeroHash, jobIdToBytes16, parseJobId } from "~/lib/ids";
import { bullets, doc, fence, inline, link, numbered, table, untrusted } from "~/lib/md";
import { notRunResult, provenDelivery, verifyCommands, verifyJob, type VerifyResult } from "~/lib/verify";
import { PUBLIC_RPC } from "./common";
import { loadReceiptFlow, receiptFlowMeaning, type ReceiptFlow } from "./receipts";
import type { LoadContext, PageDef } from "./types";

export interface VerifyCommand {
  comment: string;
  command: string;
}

export interface VerifyIndexModel {
  generatedAt: string;
  /** What was typed into the form, when it was not a job id. */
  rejectedInput: string | null;
  workRegistry: string;
  workRegistryUrl: string;
  reference: typeof REFERENCE_JOB;
  commands: VerifyCommand[];
  rpcUrl: string;
  /** Whether receipts are reaching the registry, from figures read for this page. */
  receipts: ReceiptFlow;
}

/** When each thing a check rests on was actually read. A cached read keeps the time it was made. */
export interface VerifyReads {
  /** When the WorkRegistry was read for the receipt shown. Null when that read failed. */
  receiptReadAt: string | null;
  /** When the record's bytes were fetched from IdentityMD. Null when none were, or a stored copy was hashed. */
  recordFetchedAt: string | null;
  /** Where the hashed bytes came from. `stored` is this site's own copy, used while IdentityMD cannot be reached. */
  recordOrigin: "identitymd" | "stored" | null;
  /** When the IdentityMD API's record list for the job was read. Null when it could not be. */
  listReadAt: string | null;
}

export interface VerifyJobModel {
  generatedAt: string;
  jobId: string;
  result: VerifyResult;
  reads: VerifyReads;
  /**
   * Set when the check was not started because this visitor has started many checks of new jobs in
   * the last minute. The page then answers 429 and says when to try again.
   */
  limited: { retryAfterSeconds: number } | null;
  /**
   * True when the record is proven and says the job was completed; false when it is proven and says
   * anything else (a blocked job gets a receipt too); null when nothing is proven.
   */
  delivered: boolean | null;
  /** One headline sentence for the verdict. */
  headline: string;
  /** Set when the check could not run because this server's upstream budget was spent. */
  busy: string | null;
  commands: VerifyCommand[];
  /** The seats behind the agents the record names, read from the Adapter and the seat contract. */
  seats: AgentBinding[];
  workRegistry: string;
  workRegistryUrl: string;
  recordUrl: string | null;
  /** The record through this site, for a browser that cannot fetch api.imd.fun across origins. */
  recordProxyPath: string | null;
  receiptTxUrl: string | null;
  explorerUrl: string;
  rpcUrl: string;
  apiBase: string;
  /** When this page was made. The reads behind it are dated in `reads`. */
  checkedAt: string;
}

function commandsBlock(commands: readonly VerifyCommand[]): string {
  return fence(commands.map((c) => `# ${c.comment}\n${c.command}`).join("\n\n"), "sh");
}

const HOW = [
  "Read `WorkRegistry.latest(bytes16 jobId)` on Ethereum mainnet. It returns the keccak256 of the job's work record, or zero when no receipt has been written.",
  "Fetch the work record, the JSON document IdentityMD wrote when the job ended, by that hash.",
  "Hash the bytes exactly as served with keccak256.",
  "Compare. Equal means the record is the one the chain committed to: PROVEN ON CHAIN. Zero in step 1 means NO RECEIPT YET.",
];

export const verifyIndexPage: PageDef<VerifyIndexModel> = {
  id: "verify",
  pattern: "/verify",
  async load({ now, url, sources }) {
    const typed = url.searchParams.get("job");
    return {
      generatedAt: now.toISOString(),
      receipts: await loadReceiptFlow(sources),
      rejectedInput: typed && !parseJobId(typed) ? typed.slice(0, 120) : null,
      workRegistry: MAINNET.WORK_REGISTRY,
      workRegistryUrl: etherscanAddress(MAINNET.WORK_REGISTRY),
      reference: REFERENCE_JOB,
      commands: verifyCommands({
        jobId: REFERENCE_JOB.jobId,
        rpcUrl: PUBLIC_RPC,
        workRegistry: MAINNET.WORK_REGISTRY,
        apiBase: IMD_API_BASE,
        recordHash: REFERENCE_JOB.receipt,
      }),
      rpcUrl: PUBLIC_RPC,
    };
  },
  meta: () => ({
    title: "Verify a job",
    description:
      "Paste a swarm job id. The page fetches the job's work record, hashes it, reads the receipt from IdentityMD's WorkRegistry on Ethereum and says whether they match.",
  }),
  markdown(m) {
    return doc(
      "Paste a swarm job id and this page checks it against the chain. To check a job from a script, request `/verify/<jobId>.json` or `/verify/<jobId>.md`.",
      "## The check",
      numbered(HOW),
      `The WorkRegistry is at ${link(m.workRegistry, m.workRegistryUrl)}. Its source is not published; the function was recovered by selector (\`0xebe9712c\`) and confirmed by reproducing a real receipt.`,
      `NO RECEIPT YET is the other answer. Read for this page: ${m.receipts.observed} ${receiptFlowMeaning(m.receipts)}`,
      "## A job that verifies today",
      `Job ${inline(m.reference.jobId)}: ${link(`/verify/${m.reference.jobId}`, `/verify/${m.reference.jobId}`)}. Its receipt is ${inline(m.reference.receipt)}, written in ${link("this transaction", etherscanTx(m.reference.receiptTx))}; its record is ${formatInt(m.reference.recordBytes)} bytes.`,
      "## The same check by hand",
      "With Foundry's `cast` and `curl`, no key and no account:",
      commandsBlock(m.commands),
    );
  },
};

/** When the receipt and the record behind a result were read, as one sentence. Empty when neither was. */
export function readsSentence(reads: VerifyReads): string {
  const parts: string[] = [];
  if (reads.receiptReadAt)
    parts.push(`Receipt read from the WorkRegistry ${formatUtc(reads.receiptReadAt)}.`);
  if (reads.recordOrigin === "identitymd" && reads.recordFetchedAt) {
    parts.push(`Record fetched from IdentityMD ${formatUtc(reads.recordFetchedAt)}.`);
  } else if (reads.recordOrigin === "stored") {
    parts.push("Record: this site's stored copy (IdentityMD's record server could not be reached just now).");
  }
  return parts.join(" ");
}

/** The verdict as a headline. A proven record of a job that did not complete says so. */
export function verdictHeadline(result: VerifyResult, delivered: boolean | null): string {
  switch (result.verdict) {
    case "proven":
      return delivered === false
        ? `The record is the one the chain committed to. It says the job ended ${result.facts?.state ?? "without completing"}.`
        : "The record is the one the chain committed to.";
    case "no_receipt":
      return "No receipt has been written for this job.";
    case "mismatch":
      return "The record does not match the receipt.";
    default:
      return "This job could not be checked just now.";
  }
}

export interface VerifyRun {
  result: VerifyResult;
  busy: string | null;
  reads: VerifyReads;
  limited: { retryAfterSeconds: number } | null;
}

const iso = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

export async function runVerify(ctx: LoadContext, jobId: string): Promise<VerifyRun> {
  const { api, chain, freshChecks } = ctx.sources;
  const reads: VerifyReads = {
    receiptReadAt: null,
    recordFetchedAt: null,
    recordOrigin: null,
    listReadAt: null,
  };

  // A job nobody has looked at lately costs the shared upstream budgets a few requests. One visitor
  // may start only so many of those a minute; a job already looked at is answered from memory and
  // is never refused, and neither is the reference job, which the server checks on its own account.
  const own = jobId === REFERENCE_JOB.jobId;
  const remembered = chain.hasRecentReceipt(jobIdToBytes16(jobId)) && api.hasRecentRecords(jobId);
  if (!own && ctx.visitor && !remembered) {
    const slot = freshChecks.take(ctx.visitor);
    if (!slot.ok) {
      const retryAfterSeconds = Math.ceil(slot.retryAfterMs / 1000);
      return {
        result: notRunResult(
          jobId,
          `Not checked: you have started several checks of new jobs in the last minute. Try again in ${retryAfterSeconds} s, or run the commands below.`,
        ),
        busy: null,
        reads,
        limited: { retryAfterSeconds },
      };
    }
  }

  let busy: string | null = null;
  const noteBusy = (error: unknown) => {
    if (error instanceof UpstreamBusyError) busy = error.message;
    throw error;
  };
  const result = await verifyJob(jobId, {
    readReceipt: async (id) => {
      const read = await chain.receiptRead(id).catch(noteBusy);
      reads.receiptReadAt = iso(read.fetchedAt);
      return read.value;
    },
    fetchRecord: async (hash) => {
      const record = await api.workRecord(hash).catch(noteBusy);
      if (!record) return null;
      reads.recordOrigin = record.origin;
      reads.recordFetchedAt = iso(record.fetchedAt);
      return record.bytes;
    },
    listRecords: async (id) => {
      const list = await api.jobRecords(id).catch(noteBusy);
      reads.listReadAt = iso(list.fetchedAt);
      return list.value;
    },
  });
  if (reads.recordOrigin === "stored") {
    // Say where the bytes came from. The check itself is unchanged: they hash to the receipt or not.
    const step = result.steps.find((s) => s.key === "record");
    if (step) {
      step.detail =
        "IdentityMD's record server could not be reached just now, so the bytes hashed here are this site's stored copy of the record. They are checked the same way: they hash to the receipt, or they do not.";
    }
  }
  return { result, busy, reads, limited: null };
}

export const verifyJobPage: PageDef<VerifyJobModel> = {
  id: "verify-job",
  pattern: "/verify/:jobId",
  async load(ctx, params) {
    const jobId = parseJobId(params.jobId);
    if (!jobId) return null;
    const { result, busy, reads, limited } = await runVerify(ctx, jobId);
    const recordHash: Hex | null =
      result.record?.hash ?? (result.receipt && !isZeroHash(result.receipt) ? result.receipt : null);
    const seats =
      result.verdict === "proven" && result.facts && result.facts.agentIds.length > 0
        ? await ctx.sources.chain.bindings(result.facts.agentIds).catch(() => [])
        : [];
    const delivered = provenDelivery(result);
    return {
      generatedAt: ctx.now.toISOString(),
      jobId,
      result,
      reads,
      limited,
      delivered,
      headline: limited ? "This check was not started." : verdictHeadline(result, delivered),
      busy,
      commands: verifyCommands({
        jobId,
        rpcUrl: PUBLIC_RPC,
        workRegistry: MAINNET.WORK_REGISTRY,
        apiBase: IMD_API_BASE,
        recordHash,
      }),
      seats,
      workRegistry: MAINNET.WORK_REGISTRY,
      workRegistryUrl: etherscanAddress(MAINNET.WORK_REGISTRY),
      recordUrl: recordHash ? `${IMD_API_BASE}/work-records/${recordHash.slice(2)}.json` : null,
      recordProxyPath: recordHash ? `/api/v1/work-records/${recordHash.slice(2)}.json` : null,
      receiptTxUrl: result.listed?.txHash ? etherscanTx(result.listed.txHash) : null,
      explorerUrl: explorerJob(jobId),
      rpcUrl: PUBLIC_RPC,
      apiBase: IMD_API_BASE,
      checkedAt: ctx.now.toISOString(),
    };
  },
  // A check that was refused for the visitor's own rate is "try again later", not a page about the job.
  status: (m) => (m.limited ? 429 : 200),
  // "Try again in N seconds" is said in the headers too, and nothing that was not checked is cached.
  headers: (m): Record<string, string> =>
    m.limited
      ? { "retry-after": String(m.limited.retryAfterSeconds), "cache-control": "no-store" }
      : m.result.verdict === "unchecked"
        ? { "cache-control": "no-store" }
        : {},
  meta: (m) => ({
    title: `${m.result.stamp}: job ${m.jobId.slice(0, 8)}`,
    description: `${m.result.summary} ${readsSentence(m.reads)}`.trim(),
  }),
  markdown(m) {
    const r = m.result;
    const facts = r.facts;
    return doc(
      `**${r.stamp}.** ${m.headline} ${r.summary}`,
      bullets([
        `Job: ${inline(m.jobId)} (${inline(r.jobIdBytes16)} as bytes16) · ${link("on the IdentityMD explorer", m.explorerUrl)}`,
        `Read: ${readsSentence(m.reads) || "nothing could be read."} Page made ${formatUtc(m.checkedAt)}.`,
        `WorkRegistry: ${link(m.workRegistry, m.workRegistryUrl)}`,
      ]),
      "## The four steps",
      table(
        ["Step", "Result", "Value", "What happened"],
        r.steps.map((s, i) => [
          `${i + 1}. ${s.title}`,
          s.ok === true ? "pass" : s.ok === false ? "fail" : "not reached",
          s.value ?? "",
          s.detail,
        ]),
      ),
      "## The numbers",
      table(
        ["Item", "Value"],
        [
          ["WorkRegistry.latest(jobId)", r.receipt ?? "could not be read"],
          ["keccak256(record bytes)", r.record?.keccak ?? "no record hashed"],
          ["Record size", r.record ? `${formatInt(r.record.bytes)} bytes` : ""],
          ["Record hash listed by the IdentityMD API", r.listed?.hash ?? ""],
          ["Record URL", m.recordUrl ?? ""],
          ["Receipt transaction", r.listed?.txHash ?? ""],
          ["Receipt status in the API", r.listed?.status ?? ""],
        ],
      ),
      facts
        ? doc(
            "## What the record says",
            "Read from the bytes that were hashed above.",
            table(
              ["Field", "Value"],
              [
                ["schema", facts.schema],
                ["jobId", facts.jobId],
                ["kind", facts.kind],
                ["state", facts.state],
                ["agents the record names (ERC-8004 ids)", facts.agentIds.join(", ")],
                ...(facts.previousHash
                  ? [["previousHash (the receipt this one replaced)", facts.previousHash]]
                  : []),
                ...(facts.parentJobId ? [["parentJobId", facts.parentJobId]] : []),
              ],
            ),
            facts.objective
              ? `The objective, as written by whoever ordered the job (first 400 characters):\n\n${untrusted(excerpt(facts.objective, 400), "the job's objective, written by whoever ordered it")}`
              : null,
          ).trimEnd()
        : null,
      m.seats.length > 0
        ? doc(
            "## The seats of the agents the record names",
            "Each agent id in the record is looked up in IdentityMD's seat Adapter, then the seat's owner in the seat contract. This is the path HELP WANTED's per-job tips follow.",
            table(
              ["Agent", "Seat", "Owner now"],
              m.seats.map((s) => [
                s.agentId,
                s.isSeat ? `#${s.tokenId}` : s.bound ? "bound to another token" : "not bound",
                s.owner ?? "",
              ]),
            ),
          ).trimEnd()
        : null,
      r.problems.length > 0 ? doc("## Reads that failed", bullets(r.problems)).trimEnd() : null,
      "## The same check by hand",
      commandsBlock(m.commands),
    );
  },
};

export { HOW as VERIFY_HOW };
