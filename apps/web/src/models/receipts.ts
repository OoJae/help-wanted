/**
 * Whether IdentityMD's work receipts are reaching the WorkRegistry, said from what was read and
 * from nothing else.
 *
 * In October 2026 the registry's writer stopped for days, and several pages need to tell a reader
 * what that means for them. The condition is IdentityMD's and can end at any minute, so no page
 * states it as a fixed fact: each one prints the figures read when it was made, and words them as
 * "late" only while the figures say so. The length of a stall is measured, never estimated: it is
 * the time since the newest `WorkRecorded` event the registry's own log shows, or, when the log was
 * searched and holds none, the length of the blocks searched.
 */
import { MAINNET } from "@help-wanted/shared";
import { SECONDS_PER_BLOCK, TOPIC } from "~/config/chain";
import type { Sources } from "~/data";
import type { ReceiptWriterRead } from "~/data/chain";
import { messageOf, within } from "~/lib/cache";
import { formatInt, formatUtc } from "~/lib/format";
import { jobIdToBytes16 } from "~/lib/ids";
import { jobEnded } from "./cards";

// ---------------------------------------------------------------------------------------------
// The registry's own log: when it last wrote a receipt
// ---------------------------------------------------------------------------------------------

/** Whole hours from one moment to another (milliseconds), rounded down. */
function hoursBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / 3_600_000));
}

/** Whole hours a number of blocks spans, at twelve seconds a block, rounded to the nearest hour. */
function hoursOfBlocks(blocks: number): number {
  return Math.round((blocks * SECONDS_PER_BLOCK) / 3600);
}

/**
 * The stall in a phrase, as every page says it: "no receipt since 19 Oct 2026, 06:39 UTC (29 hours)",
 * or, when the log searched holds none, "no receipt in the last 24 hours of blocks". Null unless
 * the six-hour test found the registry stalled.
 */
export function stallPhrase(read: ReceiptWriterRead): string | null {
  if (read.stalled !== true) return null;
  if (read.newestBlock !== null && read.newestAt !== null) {
    const hours = hoursBetween(read.newestAt * 1000, read.fetchedAt);
    return `no receipt since ${formatUtc(read.newestAt * 1000)} (${formatInt(hours)} hours)`;
  }
  if (read.newestBlock !== null && read.toBlock !== null) {
    return `no receipt since block ${formatInt(read.newestBlock)} (about ${formatInt(hoursOfBlocks(read.toBlock - read.newestBlock))} hours of blocks)`;
  }
  if (read.searchedFrom !== null && read.toBlock !== null) {
    return `no receipt in the last ${formatInt(hoursOfBlocks(read.toBlock - read.searchedFrom + 1))} hours of blocks`;
  }
  return "no receipt in the last six hours of blocks";
}

/**
 * What the registry's own log showed, in one sentence. A stall is given its exact length, and a
 * search that found nothing says how far back it reached and that it reached no further.
 */
export function writerWords(read: ReceiptWriterRead, subject = "IdentityMD's WorkRegistry"): string {
  if (read.stalled === null) {
    return `The WorkRegistry's own log could not be read just now${read.error ? ` (${read.error})` : ""}.`;
  }
  if (read.stalled === false) {
    const events = read.events ?? 0;
    return `${subject} is writing receipts: it recorded ${formatInt(events)} in the last six hours of blocks${
      read.newestAt !== null
        ? `, the newest at ${formatUtc(read.newestAt * 1000)}${read.newestBlock !== null ? ` (block ${formatInt(read.newestBlock)})` : ""}`
        : read.newestBlock !== null
          ? `, the newest in block ${formatInt(read.newestBlock)}`
          : ""
    }.`;
  }
  const phrase = stallPhrase(read) as string;
  if (read.newestBlock !== null) {
    return `${subject} has written ${phrase}, when it recorded one in block ${formatInt(read.newestBlock)}.`;
  }
  return `${subject} has written ${phrase}${
    read.searchedFrom !== null && read.toBlock !== null
      ? ` (blocks ${formatInt(read.searchedFrom)} to ${formatInt(read.toBlock)}, as far back as this server's RPC serves its log; nothing is said here of older blocks)`
      : ""
  }.`;
}

// ---------------------------------------------------------------------------------------------
// The figures together: the log, the newest jobs, the API's queue
// ---------------------------------------------------------------------------------------------

export interface ReceiptFlow {
  /**
   * `late`: the figures show receipts waiting or missing. `flowing`: they show receipts landing.
   * `unknown`: no figure could be read.
   */
  state: "late" | "flowing" | "unknown";
  /** Receipts waiting to be written, by the API's own count. Null when unread. */
  queued: number | null;
  /** How many of the newest ended jobs the registry was successfully asked about. */
  asked: number;
  /** How many of those have a receipt. */
  withReceipt: number;
  /** What the registry's own log showed, in one sentence (`writerWords`); null when it was not read for this. */
  writer: string | null;
  /** The stall as a phrase ("no receipt since … (29 hours)"); null unless the registry is stalled. */
  stall: string | null;
  /** The jobs and the queue, as one sentence: "0 of the newest 18 ended jobs …; IdentityMD's API counted …". */
  figures: string | null;
  /** Everything read, in sentences: the writer's sentence first, then the figures. */
  observed: string;
  /** When the swarm's state was read (ISO). Null when it was not. */
  readAt: string | null;
  error: string | null;
  /** The registry's log as read, kept so a page that reads it again can say the same thing. */
  writerRead: ReceiptWriterRead | null;
}

/** The API's queue is never quite empty while work is being done; above this it is a backlog. */
const QUEUE_BACKLOG = 25;
/** With fewer ended jobs than this, their receipts say too little to call it either way. */
const MIN_SAMPLE = 4;

/**
 * The API's queue in the one wording every page and `/api/v1/swarm` use, with the moment it was
 * read: the count moves from minute to minute, so it is never given without its time.
 */
export function queueWords(queued: number, readAt: string | null): string {
  return `IdentityMD's API counted ${formatInt(queued)} receipt${queued === 1 ? "" : "s"} waiting to go on chain${
    readAt ? ` (read ${formatUtc(readAt)})` : ""
  }`;
}

export function receiptFlow(input: {
  queued: number | null;
  asked: number;
  withReceipt: number;
  readAt?: string | null;
  error?: string | null;
  writer?: ReceiptWriterRead | null;
}): ReceiptFlow {
  const { queued, asked, withReceipt } = input;
  const writerRead = input.writer ?? null;
  const readAt = input.readAt ?? null;
  const parts: string[] = [];
  if (asked > 0) {
    parts.push(
      `${formatInt(withReceipt)} of the newest ${formatInt(asked)} ended jobs ${withReceipt === 1 ? "has" : "have"} a receipt in the WorkRegistry`,
    );
  }
  if (queued !== null) parts.push(queueWords(queued, readAt));
  const figures = parts.length > 0 ? `${parts.join("; ")}.` : null;
  const writer = writerRead && writerRead.stalled !== null ? writerWords(writerRead) : null;
  const sampled = asked >= MIN_SAMPLE;
  const mostMissing = sampled && withReceipt * 2 < asked;
  const backlog = queued !== null && queued >= QUEUE_BACKLOG;
  const stalled = writerRead?.stalled === true;
  let state: ReceiptFlow["state"];
  if (queued === null && !sampled && writer === null) state = "unknown";
  else if (stalled || mostMissing || (backlog && !(sampled && withReceipt === asked))) state = "late";
  else state = "flowing";
  const said = [writer, figures].filter((s): s is string => s !== null);
  return {
    state,
    queued,
    asked,
    withReceipt,
    writer,
    stall: writerRead ? stallPhrase(writerRead) : null,
    figures,
    observed:
      said.length > 0
        ? said.join(" ")
        : "Neither the registry nor IdentityMD's API could be read just now, so nothing is known about receipts at this moment.",
    readAt,
    error: input.error ?? null,
    writerRead,
  };
}

/** The same figures with the registry's log as a page read it itself, so both say one thing. */
export function withWriter(flow: ReceiptFlow, writer: ReceiptWriterRead): ReceiptFlow {
  return receiptFlow({
    queued: flow.queued,
    asked: flow.asked,
    withReceipt: flow.withReceipt,
    readAt: flow.readAt,
    error: flow.error,
    writer,
  });
}

/** One sentence on what the figures mean for someone about to rely on a receipt. */
export function receiptFlowMeaning(flow: ReceiptFlow): string {
  switch (flow.state) {
    case "late":
      return "Until receipts are written again, an order that pays only on a receipt waits for one, and is refunded at its deadline if none comes: the escrow is safe either way.";
    case "flowing":
      return "Receipts appear to be reaching the registry at the moment.";
    default:
      return "Whether receipts are being written at the moment could not be read.";
  }
}

const JOBS_SAMPLED = 24;

/**
 * Reads the figures: the registry's own log, the API's queue count, and the registry's answer for
 * the newest ended jobs. These are the same cached reads the Work Wire makes, so a page that calls
 * this costs the upstreams nothing extra. Never throws.
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
  const [health, jobs, writer] = await Promise.all([
    api.health().then(
      (value) => ({ value, error: null as string | null }),
      (error: unknown) => ({ value: null, error: messageOf(error) }),
    ),
    api.recentJobs(JOBS_SAMPLED).then(
      (value) => ({ value, error: null as string | null }),
      (error: unknown) => ({ value: null, error: messageOf(error) }),
    ),
    chain.receiptWriter(),
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
    writer,
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

/**
 * The receipt figures as `/api/v1/swarm` serves them beside the API's own: the same reads and the
 * same sentences the pages print, so the front page, /hire and the API agree word for word.
 */
export function receiptsForApi(flow: ReceiptFlow) {
  const w = flow.writerRead;
  return {
    state: flow.state,
    lastReceipt:
      w && w.newestBlock !== null
        ? {
            block: w.newestBlock,
            at: w.newestAt === null ? null : new Date(w.newestAt * 1000).toISOString(),
            hoursBefore: w.newestAt === null ? null : hoursBetween(w.newestAt * 1000, w.fetchedAt),
          }
        : null,
    searched:
      w && w.searchedFrom !== null && w.toBlock !== null
        ? { fromBlock: w.searchedFrom, toBlock: w.toBlock, readAt: new Date(w.fetchedAt).toISOString() }
        : null,
    stall: flow.stall,
    writer: flow.writer,
    queued: flow.queued,
    queuedReadAt: flow.readAt,
    observed: flow.observed,
    meaning: receiptFlowMeaning(flow),
  };
}

// ---------------------------------------------------------------------------------------------
// The hire form's bonded-claim box
// ---------------------------------------------------------------------------------------------

/**
 * How the hire form's claim box starts, and why. It starts unticked on every order: an employer
 * who wants to be paid out on a bonded claim must choose it. While IdentityMD's receipts are
 * stalled the form says so beside the box, with the stall's length, and says exactly what ticking
 * it means. The registry's log is still read, for the reason and for the test a reader can run.
 */
export interface ClaimDefault {
  /** What the registry's log showed: true stalled, false writing, null unread. */
  stalled: boolean | null;
  /** The reading, as the page prints it once, under the form. */
  why: string;
  /** What the form says beside the box: that it starts unticked, the reason, and what ticking it means. */
  box: string;
  /** The same six-hour test, for a reader to run. */
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

/** The rule for the box, as the hire pages state it. */
export const CLAIM_BOX_STARTS =
  "The box that also accepts a bonded delivery claim starts unticked on every order.";

/** What ticking the box means, said beside it. */
export const CLAIM_BOX_MEANS =
  "Ticked, the runner is paid 24 hours after a bonded delivery claim unless someone challenges it, and the team hosts no watcher that would.";

export function claimDefault(read: ReceiptWriterRead, rpcUrl: string): ClaimDefault {
  const command = receiptWriterCommand(read, rpcUrl);
  const range =
    read.fromBlock !== null && read.toBlock !== null
      ? `the test below counts blocks ${formatInt(read.fromBlock)} to ${formatInt(read.toBlock)}, read ${formatUtc(read.fetchedAt)}`
      : `read ${formatUtc(read.fetchedAt)}`;
  if (read.stalled === true) {
    return {
      stalled: true,
      box: `Starts unticked. Receipts are late: IdentityMD has written ${stallPhrase(read)}. ${CLAIM_BOX_MEANS}`,
      why: `${writerWords(read).replace(/\.$/, "")} (${range}). Until it writes again, an order that pays only on a receipt waits for one, and is refunded at its deadline if none comes. The box starts unticked all the same: the choice to be paid out without a receipt is yours.`,
      command,
    };
  }
  if (read.stalled === false) {
    return {
      stalled: false,
      box: `Starts unticked. Receipts are arriving, so an order can wait for its receipt. ${CLAIM_BOX_MEANS}`,
      why: `${writerWords(read).replace(/\.$/, "")} (${range}). An order can wait for its receipt, so only a receipt pays unless you tick the box.`,
      command,
    };
  }
  return {
    stalled: null,
    box: `Starts unticked. Whether IdentityMD's receipts are arriving could not be read just now. ${CLAIM_BOX_MEANS}`,
    why: `Whether IdentityMD's receipts are arriving could not be read just now${read.error ? ` (${read.error})` : ""}. Run the command to see for yourself before you decide.`,
    command,
  };
}
