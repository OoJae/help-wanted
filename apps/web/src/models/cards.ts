/**
 * The classified card: what one job or one order looks like as data, before any page draws it.
 *
 * A card's stamp is the product's vocabulary. For an order on our desk: FILLED (paid on a claim,
 * receipt not matched yet), PROVEN ON CHAIN (a WorkRegistry receipt was matched), REFUNDED. For a
 * swarm job that did not come through our desk the card says only what can be read: whether the
 * job finished and whether the WorkRegistry holds a receipt for it. The full hash check is one
 * click away on /verify.
 */
import type { Hex } from "viem";
import { kindHash } from "@help-wanted/shared";
import { explorerJob } from "~/config/chain";
import { kindLabel, TEMPLATES } from "~/config/templates";
import type { SwarmJob } from "~/data/api";
import type { Order, Pot } from "~/data/house";
import { ago, excerpt, formatDuration, formatImd, formatUtcShort, shortAddress } from "~/lib/format";
import { isZeroHash } from "~/lib/ids";

export type StampTone = "proof" | "filled" | "void" | "live";

export interface Stamp {
  text: string;
  tone: StampTone;
}

export interface JobCard {
  id: string;
  shortId: string;
  /** The line above the headline: what kind of work it is. */
  kicker: string;
  state: string;
  stateWords: string;
  stamp: Stamp | null;
  /** The start of the job's objective. Third-party text. */
  objective: string;
  postedAt: string | null;
  postedWords: string;
  /** How long the job took, when it has finished. */
  took: string | null;
  /** True when the job has ended (completed, blocked or failed), so a receipt may exist for it. */
  ended: boolean;
  /** The WorkRegistry receipt; null when there is none or it could not be read. */
  receipt: Hex | null;
  /** False when the registry could not be asked about this job. */
  receiptRead: boolean;
  verifyPath: string;
  explorerUrl: string;
}

const STATE_WORDS: Record<string, string> = {
  completed: "finished",
  executing: "at work",
  blocked: "blocked",
  planning: "being planned",
  queued: "queued",
  failed: "failed",
};

export function jobKicker(job: Pick<SwarmJob, "template" | "launchKind">): string {
  if (job.launchKind) {
    const launch: Record<string, string> = {
      evm_contracts: "Contract launch",
      custom_token: "Token launch",
      standard_token: "Token launch",
      v4_hook: "Hook launch",
    };
    return launch[job.launchKind] ?? `Launch: ${job.launchKind.replace(/_/g, " ")}`;
  }
  return kindLabel(job.template);
}

/** States after which IdentityMD writes a work record. A blocked job gets a receipt like a finished one. */
export function jobEnded(state: string): boolean {
  return state === "completed" || state === "blocked" || state === "failed";
}

export function jobCard(job: SwarmJob, receipt: Hex | null | undefined, now: Date): JobCard {
  const hasReceipt = !!receipt && !isZeroHash(receipt);
  let stamp: Stamp | null = null;
  if (job.state === "completed") {
    stamp = hasReceipt ? { text: "RECEIPT ON CHAIN", tone: "proof" } : { text: "FILLED", tone: "filled" };
  } else if (job.state === "blocked" || job.state === "failed") {
    stamp = { text: job.state.toUpperCase(), tone: "void" };
  }
  const end = job.deliveredAt ?? (job.state === "completed" ? job.updatedAt : null);
  const took =
    job.createdAt && end && Date.parse(end) >= Date.parse(job.createdAt)
      ? formatDuration(Date.parse(end) - Date.parse(job.createdAt))
      : null;
  return {
    id: job.id,
    shortId: job.id.slice(0, 8),
    kicker: jobKicker(job),
    state: job.state,
    stateWords: STATE_WORDS[job.state] ?? job.state,
    stamp,
    objective: excerpt(job.objective.replace(/…$/, ""), 230),
    postedAt: job.createdAt,
    postedWords: job.createdAt
      ? `${formatUtcShort(job.createdAt)} (${ago(job.createdAt, now)})`
      : "time unknown",
    took,
    ended: jobEnded(job.state),
    receipt: hasReceipt ? (receipt as Hex) : null,
    receiptRead: receipt !== null && receipt !== undefined,
    verifyPath: `/verify/${job.id}`,
    explorerUrl: explorerJob(job.id),
  };
}

export interface OrderCard {
  id: number;
  path: string;
  state: Order["state"];
  /** `HELP WANTED: 4 robot auditors.` */
  headline: string;
  /** `Pay up to 3 IMD.` */
  pay: string;
  /** `Employer: a contract.` */
  employerWords: string;
  employer: string;
  employerShort: string;
  /** HOUSE when the employer is one of ours, else OUTSIDE. */
  origin: "HOUSE" | "OUTSIDE";
  stamp: Stamp | null;
  statusWords: string;
  /** The start of the job text, when it is known. */
  spec: string | null;
  jobId: string | null;
  conditional: boolean;
  sample: boolean;
}

const KIND_BY_HASH = new Map<string, (typeof TEMPLATES)[number]>(TEMPLATES.map((t) => [kindHash(t.kind), t]));

export function templateForKindHash(hash: string | null | undefined) {
  return hash ? (KIND_BY_HASH.get(hash.toLowerCase()) ?? null) : null;
}

export function orderStamp(order: Pick<Order, "state" | "terms">): Stamp | null {
  switch (order.state) {
    case "Delivered":
      return order.terms?.proven
        ? { text: "PROVEN ON CHAIN", tone: "proof" }
        : { text: "FILLED", tone: "filled" };
    case "Refunded":
      return { text: "REFUNDED", tone: "void" };
    case "Cancelled":
      return { text: "WITHDRAWN", tone: "void" };
    case "Claimed":
      return { text: "TAKEN", tone: "live" };
    case "Registered":
      return { text: "AT WORK", tone: "live" };
    case "Asserted":
      return { text: "DELIVERY CLAIMED", tone: "live" };
    case "Disputed":
      return { text: "DISPUTED", tone: "void" };
    default:
      return null;
  }
}

const ORDER_STATUS_WORDS: Record<Order["state"], string> = {
  None: "Unknown order.",
  Open: "Open: waiting for a runner to take it.",
  Claimed: "Taken: a runner posted a bond and has one hour to open the swarm job.",
  Registered: "At work: the swarm job is open and its id is registered.",
  Asserted: "Delivery claimed without a receipt; anyone may challenge the claim for 24 hours.",
  Disputed: "Disputed: only a receipt, or the order's arbiter, decides it now.",
  Delivered: "Delivered and paid.",
  Cancelled: "Withdrawn by the employer before any runner took it.",
  Refunded: "Expired or timed out; the escrow went back to the employer.",
};

export function orderStatusWords(order: Pick<Order, "state" | "terms">): string {
  if (order.state === "Delivered") {
    return order.terms?.proven
      ? "Delivered and paid; the work record was matched to its WorkRegistry receipt."
      : "Delivered and paid on an unchallenged claim; its receipt has not been matched yet.";
  }
  if (order.state === "Open" && order.terms?.condTarget && !order.terms.condMet) {
    return "Waiting: the order can be taken only after its condition has been seen true.";
  }
  return ORDER_STATUS_WORDS[order.state];
}

export function orderCard(
  order: Order,
  employerIsContract: boolean | null,
  house: ReadonlySet<string>,
): OrderCard {
  const template = templateForKindHash(order.terms?.kindHash);
  const staff = template?.staff ?? "robots";
  const maxPay = order.terms?.maxPayWei ?? order.escrowWei + order.spentWei + order.returnedWei;
  const employerWords =
    employerIsContract === null
      ? "Employer: an address."
      : employerIsContract
        ? "Employer: a contract."
        : "Employer: a wallet.";
  return {
    id: order.id,
    path: `/orders/${order.id}`,
    state: order.state,
    headline: `HELP WANTED: ${staff}.`,
    pay: `Pay up to ${formatImd(maxPay)} IMD.`,
    employerWords,
    employer: order.employer,
    employerShort: shortAddress(order.employer),
    origin: house.has(order.employer.toLowerCase()) ? "HOUSE" : "OUTSIDE",
    stamp: orderStamp(order),
    statusWords: orderStatusWords(order),
    spec: order.spec ? excerpt(order.spec, 200) : null,
    jobId: order.claim?.jobId ?? null,
    conditional: !!order.terms?.condTarget,
    sample: order.sample === true,
  };
}

export interface PotCard {
  id: number;
  path: string;
  stage: Pot["stage"];
  headline: string;
  progress: string;
  /** 0 to 100, or null when the target is not known. */
  percent: number | null;
  stamp: Stamp | null;
  /** The pot's stage in a word, for the corner of the card: COLLECTING, HIRING, FILLED, … */
  stageWords: string;
  deadlineWords: string | null;
  /** How the pot's order pays, fixed when the pot opened. Null when it could not be read. */
  paysOn: string | null;
  sample: boolean;
}

export function potCard(pot: Pot, now: Date): PotCard {
  const template = templateForKindHash(pot.kindHash);
  // A pot names its kind in text. A kind this site has a template for gets the template's words;
  // any other is printed as the opener wrote it, inside quotation marks.
  const wanted = template?.staff ?? (pot.kind ? `a job of kind "${pot.kind}"` : "robots");
  const target = pot.targetWei;
  const raised = pot.raisedWei ?? (target !== null ? target - pot.remainingWei : null);
  const percent = target && target > 0n && raised !== null ? Number((raised * 100n) / target) : null;
  let stamp: Stamp | null = null;
  if (pot.stage === "Delivered") stamp = { text: "FILLED", tone: "filled" };
  else if (pot.stage === "Refundable") stamp = { text: "REFUNDABLE", tone: "void" };
  else if (pot.stage === "Hiring") stamp = { text: "HIRING", tone: "live" };
  const deadlineWords =
    pot.deadline && pot.stage === "Funding"
      ? pot.deadline * 1000 > now.getTime()
        ? `Collecting for another ${formatDuration(pot.deadline * 1000 - now.getTime())}.`
        : "Collection time is over."
      : pot.stage === "Refundable"
        ? pot.orderId === null
          ? "Time ran out before it filled: every chip can be claimed back."
          : "Its order ended undelivered: every chip can be claimed back."
        : null;
  return {
    id: pot.id,
    path: `/pots/${pot.id}`,
    stage: pot.stage,
    headline: `CHIP IN: ${wanted} wanted.`,
    progress:
      target !== null && raised !== null
        ? `${formatImd(raised)} of ${formatImd(target)} IMD raised.`
        : `${formatImd(pot.remainingWei)} IMD still needed.`,
    percent,
    stamp,
    // A pot whose stage view did not answer is not called "collecting" on a guess.
    stageWords:
      stamp?.text ??
      (pot.stage === "Funding" ? "COLLECTING" : pot.stage === "Series" ? "SERIES" : "STAGE UNREAD"),
    deadlineWords,
    paysOn:
      pot.allowClaimed === null
        ? null
        : pot.allowClaimed
          ? "Pays on a receipt, or on an unchallenged bonded claim."
          : "Pays on an on-chain receipt only.",
    sample: pot.sample === true,
  };
}
