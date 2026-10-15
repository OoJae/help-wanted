/**
 * Whether IdentityMD's work receipts are reaching the WorkRegistry, said from what was read and
 * from nothing else.
 *
 * In October 2026 the registry's writer stopped for days, and several pages need to tell a reader
 * what that means for them. The condition is IdentityMD's and can end at any minute, so no page
 * states it as a fixed fact: each one prints the figures read when it was made, and words them as
 * "late" only while the figures say so.
 */
import { MAINNET } from "@help-wanted/shared";
import { TOPIC } from "~/config/chain";
import type { Sources } from "~/data";
import type { ReceiptWriterRead } from "~/data/chain";
import { messageOf, within } from "~/lib/cache";
import { formatInt, formatUtc } from "~/lib/format";
import { jobIdToBytes16 } from "~/lib/ids";
import { jobEnded } from "./cards";

export interface ReceiptFlow {
  /**
   * `late`: the figures show receipts waiting or missing. `flowing`: they show receipts landing.
   * `unknown`: neither figure could be read.
   */
  state: "late" | "flowing" | "unknown";
  /** Receipts waiting to be written, by the API's own count. Null when unread. */
  queued: number | null;
  /** How many of the newest ended jobs the registry was successfully asked about. */
  asked: number;
  /** How many of those have a receipt. */
  withReceipt: number;
  /** The figures as one sentence, e.g. "0 of the newest 18 ended jobs have a receipt in the WorkRegistry; …". */
  observed: string;
  /** When the swarm's state was read (ISO). Null when it was not. */
  readAt: string | null;
  error: string | null;
}

/** The API's queue is never quite empty while work is being done; above this it is a backlog. */
const QUEUE_BACKLOG = 25;
/** With fewer ended jobs than this, their receipts say too little to call it either way. */
const MIN_SAMPLE = 4;

export function receiptFlow(input: {
  queued: number | null;
  asked: number;
  withReceipt: number;
  readAt?: string | null;
  error?: string | null;
}): ReceiptFlow {
  const { queued, asked, withReceipt } = input;
  const parts: string[] = [];
  if (asked > 0) {
    parts.push(
      `${formatInt(withReceipt)} of the newest ${formatInt(asked)} ended jobs ${withReceipt === 1 ? "has" : "have"} a receipt in the WorkRegistry`,
    );
  }
  if (queued !== null) {
    parts.push(
      `IdentityMD's API counts ${formatInt(queued)} receipt${queued === 1 ? "" : "s"} waiting to be written`,
    );
  }
  const sampled = asked >= MIN_SAMPLE;
  const mostMissing = sampled && withReceipt * 2 < asked;
  const backlog = queued !== null && queued >= QUEUE_BACKLOG;
  let state: ReceiptFlow["state"];
  if (queued === null && !sampled) state = "unknown";
  else if (mostMissing || (backlog && !(sampled && withReceipt === asked))) state = "late";
  else state = "flowing";
  const when = input.readAt ? ` (read ${formatUtc(input.readAt)})` : "";
  return {
    state,
    queued,
    asked,
    withReceipt,
    observed:
      parts.length > 0
        ? `${parts.join("; ")}${when}.`
        : "Neither the registry nor IdentityMD's API could be read just now, so nothing is known about receipts at this moment.",
    readAt: input.readAt ?? null,
    error: input.error ?? null,
  };
}

/** One sentence on what the figures mean for someone about to rely on a receipt. */
export function receiptFlowMeaning(flow: ReceiptFlow): string {
  switch (flow.state) {
    case "late":
      return "Receipts are arriving late or not at all at the moment, so a job that finishes now may have no receipt for some time.";
    case "flowing":
      return "Receipts appear to be reaching the registry at the moment.";
    default:
      return "Whether receipts are being written at the moment could not be read.";
  }
}

const JOBS_SAMPLED = 24;

/**
 * Reads the figures: the API's queue count, and the registry's answer for the newest ended jobs.
 * These are the same cached reads the Work Wire makes, so a page that calls this costs the
 * upstreams nothing extra. Never throws.
 *
 * On the pages that call this the figures are a courtesy, and no page is held up for them: if they
 * have not arrived within a moment and a half, the page says they could not be read and goes out,
 * while the reads carry on for the next reader.
 */
export async function loadReceiptFlow(sources: Pick<Sources, "api" | "chain">): Promise<ReceiptFlow> {
  const pending = gatherReceiptFlow(sources);
  const read = await within(pending, 1500).catch(() => null);
  if (read?.done) return read.value;
  void pending.catch(() => undefined);
  return receiptFlow({ queued: null, asked: 0, withReceipt: 0, error: "the figures were still being read" });
}

async function gatherReceiptFlow(sources: Pick<Sources, "api" | "chain">): Promise<ReceiptFlow> {
  const { api, chain } = sources;
  const [health, jobs] = await Promise.all([
    api.health().then(
      (value) => ({ value, error: null as string | null }),
      (error: unknown) => ({ value: null, error: messageOf(error) }),
    ),
    api.recentJobs(JOBS_SAMPLED).then(
      (value) => ({ value, error: null as string | null }),
      (error: unknown) => ({ value: null, error: messageOf(error) }),
    ),
  ]);
  const ended = (jobs.value?.value ?? []).filter((job) => jobEnded(job.state));
  const receipts = await chain
    .receipts(ended.map((job) => jobIdToBytes16(job.id)))
    .catch(() => new Map<string, `0x${string}` | null>());
  return receiptFlow({
    queued: health.value?.value.receiptsQueued ?? null,
    ...countReceipts(ended.map((job) => receipts.get(jobIdToBytes16(job.id)))),
    readAt: health.value ? new Date(health.value.fetchedAt).toISOString() : null,
    error: health.error ?? jobs.error,
  });
}

/** Counts registry answers: `undefined` or `null` is a job the registry could not be asked about. */
export function countReceipts(answers: readonly (string | null | undefined)[]): {
  asked: number;
  withReceipt: number;
} {
  let asked = 0;
  let withReceipt = 0;
  for (const answer of answers) {
    if (answer === null || answer === undefined) continue;
    asked++;
    if (!/^0x0*$/.test(answer)) withReceipt++;
  }
  return { asked, withReceipt };
}

// ---------------------------------------------------------------------------------------------
// The hire form's default for the bonded-claim path
// ---------------------------------------------------------------------------------------------

/**
 * How the hire form's claim box starts, and why. The rule is the one the launch documents use for
 * the Doorbell (brief, section 12, decision 9): the bonded-claim path is preselected only while
 * IdentityMD's receipts are stalled, which means the WorkRegistry's newest `WorkRecorded` event is
 * more than six hours old. Otherwise the form starts receipt-only. Either way the reason is said.
 */
export interface ClaimDefault {
  /** True when the form starts with the claim box ticked. */
  preselected: boolean;
  /** What the registry's log showed: true stalled, false writing, null unread. */
  stalled: boolean | null;
  /** The reason, as the form and the page print it. */
  why: string;
  /** The same test, for a reader to run. */
  command: string;
}

/** The count the test rests on: `WorkRecorded` events in a block range, against the public RPC. */
export function receiptWriterCommand(
  read: Pick<ReceiptWriterRead, "fromBlock" | "toBlock">,
  rpcUrl: string,
): string {
  const from = read.fromBlock ?? "$(($(cast block-number --rpc-url " + rpcUrl + ") - 1800))";
  const to = read.toBlock !== null ? ` --to-block ${read.toBlock}` : "";
  return `cast logs --address ${MAINNET.WORK_REGISTRY} --from-block ${from}${to} ${TOPIC.WORK_RECORDED} --rpc-url ${rpcUrl} | grep -c transactionHash`;
}

export function claimDefault(read: ReceiptWriterRead, rpcUrl: string): ClaimDefault {
  const command = receiptWriterCommand(read, rpcUrl);
  const range =
    read.fromBlock !== null && read.toBlock !== null
      ? `blocks ${formatInt(read.fromBlock)} to ${formatInt(read.toBlock)}, read ${formatUtc(read.fetchedAt)}`
      : `read ${formatUtc(read.fetchedAt)}`;
  if (read.stalled === true) {
    return {
      preselected: true,
      stalled: true,
      why: `Ticked for you, because IdentityMD's receipts are stalled: its WorkRegistry recorded no receipt in the last six hours (no WorkRecorded event in ${range}). While that lasts, an order that pays only on a receipt cannot be paid and is refunded at its deadline. Untick the box to wait for receipts all the same.`,
      command,
    };
  }
  if (read.stalled === false) {
    const events = read.events ?? 0;
    return {
      preselected: false,
      stalled: false,
      why: `Left unticked, because IdentityMD's receipts are arriving: its WorkRegistry recorded ${formatInt(events)} receipt${events === 1 ? "" : "s"} in the last six hours (${range}${read.newestBlock !== null ? `, the newest in block ${formatInt(read.newestBlock)}` : ""}). An order can wait for its receipt, so only a receipt pays unless you tick the box.`,
      command,
    };
  }
  return {
    preselected: false,
    stalled: null,
    why: `Left unticked: whether IdentityMD's receipts are arriving could not be read just now${read.error ? ` (${read.error})` : ""}, so the form starts with the stricter choice. Run the command to see for yourself before you decide.`,
    command,
  };
}
