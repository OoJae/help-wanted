/**
 * "/questions": Standing Questions and its three house feeds, and every oracle request bought on
 * chain through the IdentityMD Intake that this server can list.
 *
 * The house feeds are defined once, in the shared package (`HOUSE_FEEDS`, generated from launch A's
 * own fixture files): what each asks, its exact body, its cadence. This page prints that definition
 * whether or not launch A exists, then, once the Questions contract has an address, what the chain
 * says: the meter, every round with its window, state and answer, and who earned each round's tip.
 *
 * The request list is chain data: the `Requested` and `Completed` logs of both Intake contracts.
 * The question text in each row was written by whoever paid for the request. The page prints it as
 * a quotation and the twins mark it as third-party text, because some of it is written to look like
 * instructions.
 */
import { keccak256, stringToHex, type Hex } from "viem";
import {
  feedBody,
  feedQuestionHash,
  HOUSE_FEED_NAMES,
  HOUSE_FEEDS,
  MAINNET,
  QUESTIONS_WAITS,
  questionsAbi,
  silenceSeconds,
  zapAbi,
  type HouseFeed,
  type HouseFeedName,
} from "@help-wanted/shared";
import { etherscanAddress, etherscanTx, IMD_LINK, SECONDS_PER_BLOCK, TOPIC } from "~/config/chain";
import { NOT_LAUNCHED } from "~/config/deployments";
import { houseSet } from "~/config/house";
import { FEED_PROOFS, type FeedProof } from "~/config/proofs";
import type { IntakeBook } from "~/data/chain";
import { addressList, type Feed, type FeedRound } from "~/data/house";
import type { KeeperRead } from "~/data/keeper";
import { excerpt, formatDuration, formatImd, formatInt, formatUtc, shortAddress } from "~/lib/format";
import { completionWords, type IntakeRequest } from "~/lib/intake";
import { bullets, doc, fence, inline, link, quote, table } from "~/lib/md";
import {
  castCall,
  castView,
  castWrite,
  contractStatus,
  liveNote,
  notLiveNotes,
  PUBLIC_RPC,
  type ContractStatus,
} from "./common";
import { flowMarkdown, previewFlow, type FlowPreview } from "./flowPreview";
import { sourceNote, type PageDef, type SourceNote } from "./types";

export interface RequestRow {
  requestId: string;
  /** Which Intake logged it: 2 is the current contract, 1 the legacy one. */
  version: 1 | 2;
  when: string | null;
  block: number;
  payer: string;
  payerUrl: string;
  /** True when the payer has code; null when that could not be read. */
  payerIsContract: boolean | null;
  /** True when the payer is one of our wallets or contracts. */
  house: boolean;
  /** Set when the answer was to be delivered to a contract. */
  callbackTarget: string | null;
  /** The question, shortened. Third-party text. */
  question: string | null;
  answerType: string | null;
  panel: string | null;
  window: string | null;
  priceWei: bigint;
  status: string;
  statusKey: "answered" | "delivered" | "no_answer" | "refused" | "open" | "unknown";
  requestTxUrl: string;
  completionTxUrl: string | null;
  resultUrl: string | null;
  /** What IdentityMD's service says about the request: its state, and the oracle request behind it. */
  intakeReadUrl: string;
}

export interface RoundRow {
  round: number;
  status: string;
  window: string;
  /** The answer in the feed's own unit, or why there is none. */
  answer: string;
  requestedAt: string | null;
  settledAt: string | null;
  /** Who earned the tip, in words. */
  tip: string;
  /** How an answered round's answer arrived: the Intake's own callback, or `submit` and by whom. Null when unread or not answered. */
  delivered: string | null;
  tipEarner: string | null;
  openedTxUrl: string | null;
  settledTxUrl: string | null;
  oracleRequestUrl: string | null;
}

export interface ProofView {
  oracleRequestId: string;
  /** IdentityMD's public record of the request: every member's answer, the attestation, the signature. */
  url: string;
  requestTxUrl: string;
  window: string;
  /** The attested answer in the feed's own unit. */
  answer: string;
  agreed: string;
  attestedAt: string;
  /** The exact body that was bought: this feed's body for that window, as the contract assembles it. */
  body: string;
  bodyHash: Hex;
  /** True when that body hashes to the hash IdentityMD's Intake service recorded for the purchase. */
  bodyMatches: boolean;
  questionHash: Hex;
  /** True when the question hash built from this feed's text is the one the oracle attested. */
  questionHashMatches: boolean;
}

export interface HouseFeedView {
  name: HouseFeedName;
  title: string;
  id: Hex;
  /** What it asks, in plain words. */
  asks: string;
  /** How its answer is settled, in plain words. */
  settled: string;
  /** True when IdentityMD's oracle recomputes the figure itself from chain data before it signs. */
  recomputed: boolean;
  /** Whether anyone may hand a signed answer in with `submit` once the wait is over. */
  submitOpen: boolean;
  answerType: string;
  cadence: string;
  window: string;
  panel: string;
  tipImd: string;
  maxPriceImd: string;
  /** How many requests Payroll keeps its own position on the meter at. */
  payrollRunway: number;
  /** The stored question text: everything before the block numbers, and everything after them. */
  bodyPrefix: string;
  bodyTail: string;
  proof: ProofView;
  /**
   * Null until Questions is launched. `read` is false when the launched contract could not be read
   * for this page: then nothing here says whether the feed exists. `exists` is false, with `read`
   * true, until somebody has created the feed.
   */
  live: {
    read: boolean;
    exists: boolean;
    meterImd: string | null;
    costImd: string | null;
    /** How many requests the meter pays for at today's cost. Null when no request can be bought. */
    requestsFunded: number | null;
    payrollPositionImd: string | null;
    rounds: number;
    pending: boolean;
    /** When the next request may be made, and what stands in its way. */
    next: string;
    latest: string;
    canSubmit: boolean | null;
    roundRows: RoundRow[];
  } | null;
}

export interface QuestionsModel {
  generatedAt: string;
  questions: ContractStatus;
  launched: boolean;
  /** `feedCount()`; null before launch or when unread. */
  feedCount: number | null;
  houseFeeds: HouseFeedView[];
  /** Feeds other people created, when there are any. */
  otherFeeds: { id: Hex; rounds: number; meterImd: string; costImd: string; latest: string }[];
  feedsError: string | null;
  /** The block range the tip earners were read from, in words. */
  eventsCoverage: string | null;
  /** The waits fixed in the contract, in words. */
  waits: string[];
  tipRule: string[];
  keeper: {
    connected: boolean;
    words: string;
    attention: string[];
    nextDue: { feed: string; when: string; note: string }[];
  };
  intake: {
    current: IntakeBookView;
    legacy: IntakeBookView;
    rows: RequestRow[];
    counts: {
      listed: number;
      answered: number;
      failed: number;
      open: number;
      toContracts: number;
      ours: number;
    };
    coverage: string;
    scannedToBlock: number | null;
    error: string | null;
  };
  explanation: string[];
  /** One sentence for each launch this page leans on that is not live. Empty once all are. */
  notLive: string[];
  flows: FlowPreview[];
  commands: { comment: string; command: string }[];
  sources: SourceNote[];
}

export interface IntakeBookView {
  version: 1 | 2;
  label: string;
  address: string;
  url: string;
  nonce: number | null;
  priceWei: bigint | null;
  callbackGas: number | null;
  listed: number;
  complete: boolean | null;
  /** The completeness of this contract's list, as one sentence. */
  words: string;
}

const ASKS: Record<HouseFeedName, string> = {
  payrolls:
    "How much IMD was paid to the swarm's fee address in the window: the sum of the value of every IMD Transfer log whose recipient is the fee address.",
  hires:
    "How many payments reached the swarm's fee address in the window: the number of IMD Transfer logs whose recipient is the fee address. A transfer of zero counts, because the oracle's counting recipe can filter on indexed arguments only.",
  employers:
    "Which three addresses paid the swarm most in the window: senders ranked by the IMD they sent to the fee address, largest first, ties by ascending address.",
};

const SETTLED = {
  chain:
    "Recomputed by IdentityMD from chain data. It is chain evidence with the recipe pinned in the question: every panel member answers with the recipe, and IdentityMD's oracle reruns that recipe itself at the pinned blocks before it signs. Anyone can recompute the figure from the same logs.",
  panel:
    "Settled by panel agreement. IdentityMD's oracle has no recipe that ranks senders among the transfers to one recipient, so the method is written out in the question itself and the oracle signs what at least five of the seven panel members agree on. IdentityMD does not recompute this answer, and nothing of value should depend on it.",
} as const;

const EXPLANATION = [
  "A Standing Question is a question a contract keeps buying. It is written once, as a feed, in the Questions contract: the exact question, the answer type, the panel size and quorum, and how often to ask.",
  "When the time comes (EVERY so many blocks) or a line is crossed (WHEN a view call compares true), anyone may call request(feedId). The contract builds the question body itself from the stored text and the exact block window, and pays the Intake's price in IMD from the feed's meter. No owner decides anything, because there is no owner.",
  "The oracle is a panel of swarm agents. When the panel agrees, IdentityMD signs the answer and the Intake calls back. Questions accepts the answer only if the signature is the oracle's, the question hash is the one it built, the window is the one it asked about, the panel and quorum are what the feed demands, and the answer has not expired. Then it stores it, and any contract can read latest(feedId).",
  "A request that is refused or never answered still costs the price: the Intake never refunds. Questions closes such a round by the clock, returns its keeper tip to the meter, and waits longer before the next try. A feed's unspent meter is always redeemable by the people who funded it.",
];

const TIP_RULE = [
  "A request costs the meter the Intake's price plus the feed's keeper tip (0.5 IMD and 0.05 IMD on the house feeds today).",
  "The tip is set aside when the request is made, for the keeper that made it. It is earned only by an answered round, and always by that keeper: whether the Intake's own callback delivers the answer or somebody hands it in with submit, the tip is credited to the keeper that opened the round. Handing an answer in earns nothing of its own.",
  "That includes a round whose own request was never served and that was answered with an answer somebody else bought to the same question: the contract cannot tell the two apart, so the opener is credited there too.",
  "When a round fails, its tip goes back onto the meter. Asking earns nothing by itself.",
  "A keeper is paid by calling collectTips(); tipsOf(address) shows what it has earned and what is still set aside for its pending rounds.",
];

function statusKey(r: IntakeRequest): RequestRow["statusKey"] {
  const c = r.completion;
  if (!c) return "open";
  if (c.status === "answered") return c.delivered ? "delivered" : "answered";
  if (c.status === "no_answer") return "no_answer";
  if (c.status === "refused") return "refused";
  return "unknown";
}

function safeResultUrl(uri: string | undefined): string | null {
  if (!uri) return null;
  try {
    const url = new URL(uri);
    return url.protocol === "https:" && url.hostname === "api.imd.fun" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A length of time to the second, in words: `36 hours, 5 minutes and 1 second`. */
export function exactDuration(seconds: number): string {
  const parts = [
    [Math.floor(seconds / 3600), "hour"],
    [Math.floor((seconds % 3600) / 60), "minute"],
    [seconds % 60, "second"],
  ] as const;
  const said = parts.filter(([n]) => n > 0).map(([n, unit]) => `${n} ${unit}${n === 1 ? "" : "s"}`);
  if (said.length === 0) return "0 seconds";
  return said.length === 1 ? (said[0] as string) : `${said.slice(0, -1).join(", ")} and ${said.at(-1)}`;
}

function blocksAsTime(blocks: number): string {
  return formatDuration(blocks * SECONDS_PER_BLOCK * 1000);
}

/** An answer in the feed's own unit. `value` is the stored word; for the list feed it is a hash. */
function answerWords(name: HouseFeedName, value: bigint, revealed: string[] | null): string {
  if (name === "payrolls") return `${formatImd(value)} IMD`;
  if (name === "hires") return `${formatInt(value)} transfers`;
  if (revealed && revealed.length > 0) return revealed.join(", ");
  return `a list of three addresses, stored as its hash 0x${value.toString(16).padStart(64, "0").slice(0, 16)}… (the list itself is published by reveal or by the Jobs Report's crown)`;
}

function proofAnswer(proof: FeedProof): string {
  if (proof.feed === "employers") return (addressList(proof.answer) ?? []).join(", ");
  return answerWords(proof.feed, BigInt(proof.answer), null);
}

/** One house feed's live answer, with the two hashes recomputed here from the feed's own text. */
export function proofView(feed: HouseFeed): ProofView {
  const proof = FEED_PROOFS[feed.name];
  const window = { fromBlock: proof.fromBlock, toBlock: proof.toBlock };
  const body = feedBody(feed, window);
  return {
    oracleRequestId: proof.oracleRequestId,
    url: IMD_LINK.oracleRequest(proof.oracleRequestId),
    requestTxUrl: etherscanTx(proof.transaction),
    window: `blocks ${formatInt(proof.fromBlock)} to ${formatInt(proof.toBlock)}`,
    answer: proofAnswer(proof),
    agreed: `${proof.agreed} of ${feed.params.panelSize} panel members agreed (the quorum is ${feed.params.quorum})`,
    attestedAt: proof.attestedAt,
    body,
    bodyHash: proof.bodyHash,
    bodyMatches: keccak256(stringToHex(body)) === proof.bodyHash,
    questionHash: proof.questionHash,
    questionHashMatches: feedQuestionHash(feed, window) === proof.questionHash,
  };
}

/**
 * Who a round's tip went to, in words. `ours` is the house list: a keeper on it is one of our own
 * wallets, and the sentence says so, because our own activity is never passed off as outside use.
 */
function tipWords(r: FeedRound, ours: ReadonlySet<string>): string {
  const amount = r.tipWei !== null ? `${formatImd(r.tipWei)} IMD` : "The tip";
  const house = (address: string | null) =>
    address !== null && ours.has(address) ? " (HOUSE: one of ours)" : "";
  switch (r.tipOutcome) {
    case "earned": {
      const earner = `${r.tipEarner}${house(r.tipEarner)}`;
      if (r.byCallback === true)
        return `${amount} earned by ${earner}, the keeper that opened the round (the Intake's callback delivered the answer).`;
      if (r.byCallback === false) {
        return r.deliveredBy !== null && r.deliveredBy === r.tipEarner
          ? `${amount} earned by ${earner}, the keeper that opened the round. The same account handed the answer in with submit; handing in earns nothing of its own.`
          : `${amount} earned by ${earner}, the keeper that opened the round (the answer was handed in with submit by ${r.deliveredBy ?? "another account"}${house(r.deliveredBy)}, which earns nothing).`;
      }
      return `${amount} earned by ${earner}, the keeper that opened the round.`;
    }
    case "returned":
      return `${amount} went back onto the meter: the round failed.`;
    case "pending":
      return `${amount} is set aside for ${r.keeper ? `${r.keeper}${house(r.keeper)}, the keeper that opened the round` : "the keeper that opened the round"}. It is credited if the round is answered, whoever delivers the answer, and goes back onto the meter if the round is closed without one.`;
    default:
      return "Earned by the keeper that opened the round; which keeper is not shown, because the round's opening log is older than this server can read.";
  }
}

function roundRow(name: HouseFeedName, r: FeedRound, ours: ReadonlySet<string>): RoundRow {
  const iso = (seconds: number | null) => (seconds ? new Date(seconds * 1000).toISOString() : null);
  return {
    round: r.round,
    status:
      r.status === "Answered"
        ? "answered"
        : r.status === "Failed"
          ? "failed: no usable answer arrived"
          : r.status === "Pending"
            ? "pending: waiting for its answer"
            : "unknown",
    window: `blocks ${formatInt(r.fromBlock)} to ${formatInt(r.toBlock)}`,
    answer:
      r.status === "Answered"
        ? answerWords(name, r.value, r.revealed)
        : r.status === "Pending"
          ? "none yet"
          : "none",
    requestedAt: iso(r.requestedAt),
    settledAt: iso(r.updatedAt),
    tip: tipWords(r, ours),
    delivered:
      r.status !== "Answered" || r.byCallback === null
        ? null
        : r.byCallback
          ? "the Intake's callback"
          : `submit, by ${r.deliveredBy ?? "an account this server could not read"}`,
    tipEarner: r.tipEarner,
    openedTxUrl: r.openedTx ? etherscanTx(r.openedTx) : null,
    settledTxUrl: r.settledTx ? etherscanTx(r.settledTx) : null,
    oracleRequestUrl: r.oracleRequestId ? IMD_LINK.oracleRequest(r.oracleRequestId) : null,
  };
}

function nextWords(feed: Feed, headBlock: number | null): string {
  if (feed.pending) {
    const closable = feed.abandon?.closableAt
      ? ` It can be closed from ${formatUtc(feed.abandon.closableAt * 1000)} if no answer comes.`
      : "";
    return `A round is pending: no new request can be made until it is answered or closed.${closable}`;
  }
  const blocker =
    feed.blocker === null || feed.blocker === "None"
      ? null
      : feed.blocker === "TooSoon"
        ? null
        : feed.blocker === "MeterTooLow"
          ? "the meter holds less than one request costs"
          : feed.blocker === "PriceAboveCap"
            ? "the Intake's price is above the feed's cap"
            : feed.blocker === "NotSold"
              ? "the Intake is not selling the feed's action for IMD"
              : feed.blocker === "GateClosed"
                ? "the feed's gate is closed"
                : feed.blocker === "NoBlocks"
                  ? "there are no new blocks to ask about yet"
                  : `blocked (${feed.blocker})`;
  if (headBlock !== null && feed.nextRequestBlock > headBlock) {
    const blocks = feed.nextRequestBlock - headBlock;
    // The contract reports "too soon" first; a meter that cannot pay is said here all the same.
    const unfunded =
      !blocker && feed.costWei > 0n && feed.meterWei < feed.costWei
        ? ` The meter holds less than one request costs (${formatImd(feed.costWei)} IMD), so it has to be funded before the feed can ask again.`
        : "";
    return `Due at block ${formatInt(feed.nextRequestBlock)}, in about ${blocksAsTime(blocks)}${blocker ? `; and ${blocker}` : ""}.${unfunded}`;
  }
  return blocker ? `Due by the cadence, but ${blocker}.` : "Due now: anyone may call request.";
}

function houseFeedView(
  feed: HouseFeed,
  live: Feed | null,
  launched: boolean,
  headBlock: number | null,
  /** False when Questions is launched and could not be read: nothing is then said of the feed on chain. */
  read: boolean,
  ours: ReadonlySet<string>,
): HouseFeedView {
  const p = feed.params;
  return {
    name: feed.name,
    title: feed.title,
    id: feed.id,
    asks: ASKS[feed.name],
    settled: SETTLED[feed.evidence],
    recomputed: feed.evidence === "chain",
    submitOpen: feed.submit,
    answerType: feed.answerType,
    cadence: `every ${formatInt(p.cadenceBlocks)} blocks, about ${blocksAsTime(p.cadenceBlocks)}`,
    window: p.contiguous
      ? `the blocks since the last answered window, at most ${formatInt(p.maxWindowBlocks)} (about ${blocksAsTime(p.maxWindowBlocks)}), ending ${p.lagBlocks} blocks behind the request`
      : `the newest ${formatInt(p.maxWindowBlocks)} blocks (about ${blocksAsTime(p.maxWindowBlocks)}), ending ${p.lagBlocks} blocks behind the request`,
    panel: `a panel of ${p.panelSize}, of whom ${p.quorum} must agree`,
    tipImd: formatImd(p.tip),
    maxPriceImd: formatImd(p.maxPrice),
    payrollRunway: feed.runwayRequests,
    bodyPrefix: feed.qPrefixText,
    bodyTail: feed.tailText,
    proof: proofView(feed),
    live: !launched
      ? null
      : live
        ? {
            read: true,
            exists: true,
            meterImd: formatImd(live.meterWei),
            costImd: live.costWei > 0n ? formatImd(live.costWei) : null,
            requestsFunded: live.costWei > 0n ? Number(live.meterWei / live.costWei) : null,
            payrollPositionImd: live.payrollPositionWei !== null ? formatImd(live.payrollPositionWei) : null,
            rounds: live.rounds,
            pending: live.pending,
            next: nextWords(live, headBlock),
            latest:
              live.latest.round > 0
                ? `${answerWords(feed.name, live.latest.value, live.roundList.find((r) => r.round === live.latest.round)?.revealed ?? null)} for blocks ${formatInt(live.latest.fromBlock)} to ${formatInt(live.latest.toBlock)} (round ${live.latest.round}, stored ${formatUtc(live.latest.updatedAt * 1000)})`
                : "no answer yet",
            canSubmit: live.canSubmit,
            roundRows: live.roundList.map((r) => roundRow(feed.name, r, ours)),
          }
        : {
            read,
            exists: false,
            meterImd: null,
            costImd: null,
            requestsFunded: null,
            payrollPositionImd: null,
            rounds: 0,
            pending: false,
            next: read
              ? "The feed has not been created yet: createFeed is a call anyone may make, with the calldata printed in launch A's launch document."
              : "Questions could not be read just now, so nothing is said here about this feed's meter or rounds.",
            latest: "no answer yet",
            canSubmit: null,
            roundRows: [],
          },
  };
}

function bookView(book: IntakeBook): IntakeBookView {
  const label = book.version === 2 ? "Intake, version 2 (current)" : "Intake, version 1 (legacy)";
  const words =
    book.complete === true
      ? `All ${book.listed} of its requests are listed: the count equals its own counter.`
      : book.complete === false
        ? `Its counter reads ${book.nonce} and ${book.listed} of those requests are listed here. The others are in blocks this server cannot reach without an archive RPC.`
        : `Its counter could not be read just now; ${book.listed} of its requests are listed.`;
  return {
    version: book.version,
    label,
    address: book.address,
    url: etherscanAddress(book.address),
    nonce: book.nonce,
    priceWei: book.priceWei,
    callbackGas: book.callbackGas,
    listed: book.listed,
    complete: book.complete,
    words,
  };
}

function keeperView(read: KeeperRead): QuestionsModel["keeper"] {
  if (!read.configured) {
    return {
      connected: false,
      words:
        "No keeper status is connected to this server. The keeper is a separate program (bots/keeper in the repository) that anyone can run; it needs no privilege, and several can run at once.",
      attention: [],
      nextDue: [],
    };
  }
  if (!read.status) {
    return {
      connected: true,
      words: `A keeper status is configured (${read.from}) but could not be read just now${read.error ? `: ${read.error}` : ""}.`,
      attention: [],
      nextDue: [],
    };
  }
  const s = read.status;
  return {
    connected: true,
    words: `The keeper last wrote its status ${formatUtc(s.at)}${s.block !== null ? `, at block ${formatInt(s.block)}` : ""}, in ${s.mode === "live" ? "live" : "dry-run"} mode${s.keeper ? `, as ${s.keeper}` : ""}${s.killed ? ". Its kill switch is on" : ""}. ${s.attention.length === 0 ? "It reports nothing that needs attention." : "It asks for attention:"}`,
    attention: s.attention,
    nextDue: s.nextDue.map((d) => ({
      feed: d.feed,
      when: d.at !== null ? formatUtc(d.at * 1000) : "not set",
      note: d.note,
    })),
  };
}

export const questionsPage: PageDef<QuestionsModel> = {
  id: "questions",
  pattern: "/questions",
  async load({ sources, now }) {
    const { chain, house, deployments, keeper } = sources;
    const [history, feeds, head, keeperRead] = await Promise.all([
      chain.intake(),
      house.feeds(),
      chain.head().then(
        (read) => read.value.block,
        () => null,
      ),
      keeper.status(),
    ]);
    const ours = houseSet(deployments);
    const contractFlags = await Promise.all(
      history.requests.map((r) => chain.isContract(r.payer).catch(() => null)),
    );
    const rows: RequestRow[] = history.requests.map((r, index) => ({
      requestId: r.requestId,
      version: r.version,
      when: r.timestamp === null ? null : new Date(r.timestamp * 1000).toISOString(),
      block: r.block,
      payer: r.payer,
      payerUrl: etherscanAddress(r.payer),
      payerIsContract: contractFlags[index] ?? null,
      house: ours.has(r.payer),
      callbackTarget: r.callbackTarget,
      question: r.question ? excerpt(r.question.text, 280) : null,
      answerType: r.question?.answerType ?? null,
      panel:
        r.question?.panelSize != null && r.question.quorum != null
          ? `${r.question.quorum} of ${r.question.panelSize}`
          : null,
      window: r.question?.window ?? null,
      priceWei: r.amountWei,
      status: completionWords(r),
      statusKey: statusKey(r),
      requestTxUrl: etherscanTx(r.txHash),
      completionTxUrl: r.completion ? etherscanTx(r.completion.txHash) : null,
      resultUrl: safeResultUrl(r.completion?.uri),
      intakeReadUrl: IMD_LINK.intakeRead(r.txHash),
    }));
    const questions = contractStatus(deployments, "questions");
    const zap = contractStatus(deployments, "zap");
    const book = feeds.live ? feeds.data : null;
    const liveByName = new Map<HouseFeedName, Feed>();
    for (const feed of book?.feeds ?? []) if (feed.house) liveByName.set(feed.house, feed);
    const recorded = [...history.legacy.recorded, ...history.current.recorded]
      .map((range) => `${formatInt(range.fromBlock)} to ${formatInt(range.toBlock)}`)
      .filter((text, index, all) => all.indexOf(text) === index);
    const example = { feed: "payrolls", amount: "5" };
    return {
      generatedAt: now.toISOString(),
      questions,
      launched: feeds.live,
      feedCount: book ? book.count : null,
      houseFeeds: HOUSE_FEED_NAMES.map((name) =>
        houseFeedView(HOUSE_FEEDS[name], liveByName.get(name) ?? null, feeds.live, head, book !== null, ours),
      ),
      otherFeeds: (book?.feeds ?? [])
        .filter((feed) => feed.house === null)
        .map((feed) => ({
          id: feed.id,
          rounds: feed.rounds,
          meterImd: formatImd(feed.meterWei),
          costImd: formatImd(feed.costWei),
          latest: feed.latest.round > 0 ? feed.latest.value.toString() : "no answer yet",
        })),
      feedsError: feeds.live ? (feeds.error ?? book?.eventsError ?? null) : null,
      eventsCoverage:
        book && book.eventsFrom !== null && book.eventsTo !== null
          ? `Who opened and who answered each round is read from the contract's logs in blocks ${formatInt(book.eventsFrom)} to ${formatInt(book.eventsTo)}, the range this server's RPC serves, and kept while the server runs. A round older than that shows its window, state and answer, which are read from the contract itself, without the name of who earned its tip.`
          : null,
      waits: [
        `Anyone may hand a signed answer in with submit from ${formatDuration(QUESTIONS_WAITS.SUBMIT_AFTER_SILENCE * 1000)} after a request the Intake has not completed (payrolls and hires only; never for a feed a panel judges). The round's tip still goes to the keeper that opened it.`,
        `Anyone may close a pending round, in one call, once ${formatDuration(QUESTIONS_WAITS.ABANDON_AFTER_SILENCE * 1000)}, the time the feed's answers stay valid, ${formatDuration(QUESTIONS_WAITS.ISSUED_AT_TOLERANCE * 1000)} of clock tolerance and one second have all passed since its request, whatever the Intake says. For the three house feeds, whose answers are valid for ${formatDuration(HOUSE_FEEDS.payrolls.params.validFor * 1000)}, that is ${exactDuration(Number(silenceSeconds(HOUSE_FEEDS.payrolls.params.validFor)))} after the request.`,
        `A round whose request the Intake has completed with nothing stored can be closed sooner, in two calls: the first records that the completion was seen and changes nothing else, and the second closes the round ${formatDuration(QUESTIONS_WAITS.ABANDON_AFTER_COMPLETED * 1000)} later.`,
        "These waits are constants of the contract's code. Nobody can change them after launch.",
      ],
      tipRule: TIP_RULE,
      keeper: keeperView(keeperRead),
      intake: {
        current: bookView(history.current),
        legacy: bookView(history.legacy),
        rows: [...rows].reverse(),
        counts: {
          listed: rows.length,
          answered: rows.filter((r) => r.statusKey === "answered" || r.statusKey === "delivered").length,
          failed: rows.filter((r) => r.statusKey === "no_answer" || r.statusKey === "refused").length,
          open: rows.filter((r) => r.statusKey === "open").length,
          toContracts: rows.filter((r) => r.callbackTarget !== null).length,
          ours: rows.filter((r) => r.house).length,
        },
        coverage: `Recorded copies of the Intakes' logs ship with the site for blocks ${recorded.join(" and ")}; newer blocks are scanned live${history.scannedToBlock ? ` (to block ${formatInt(history.scannedToBlock)})` : ""}. Blocks between the recorded ranges need an archive RPC.`,
        scannedToBlock: history.scannedToBlock,
        error: history.error,
      },
      explanation: EXPLANATION,
      notLive: notLiveNotes(deployments, {
        B: "Payroll's feed budget is a share of the desk's fees, so no fee has topped up a house meter: a meter holds only what somebody put on it directly.",
        C: "A meter cannot be funded with ETH through Zap or from an endowment's yield until then; fund() with IMD is the way in.",
      }),
      flows: [
        previewFlow("fund-feed", deployments, now, {}, example),
        previewFlow(
          "zap-fund-meter",
          deployments,
          now,
          {},
          { feed: "payrolls", eth: "0.01", minImdOut: "8" },
        ),
        previewFlow("request-feed", deployments, now, {}, { feed: "payrolls" }),
        previewFlow("collect-tips", deployments, now),
        previewFlow("defund-feed", deployments, now, {}, { feed: "payrolls" }),
        previewFlow("abandon-feed", deployments, now, {}, { feed: "payrolls" }),
      ],
      commands: [
        {
          comment: "The newest answer of a feed: value, window, round, time stored. Here, the payrolls feed.",
          command: castView(questions.address, "QUESTIONS", questionsAbi, "latest", [
            HOUSE_FEEDS.payrolls.id,
          ]),
        },
        {
          comment: "One round of a feed: status (1 pending, 2 answered, 3 failed), value, window, time.",
          command: castView(questions.address, "QUESTIONS", questionsAbi, "roundOf", [
            HOUSE_FEEDS.payrolls.id,
            "<round>",
          ]),
        },
        {
          comment: "The exact body the next request would send, with its question hash and window.",
          command: castView(questions.address, "QUESTIONS", questionsAbi, "nextBody", [
            HOUSE_FEEDS.payrolls.id,
          ]),
        },
        {
          comment: "A keeper's tips: earned (what collectTips would pay) and pending.",
          command: castView(questions.address, "QUESTIONS", questionsAbi, "tipsOf", ["<keeper-address>"]),
        },
        {
          comment:
            "Fund a feed's meter with ETH through Zap (launch C): a minimum and a deadline are yours to set.",
          command: castWrite(
            zap.address,
            "ZAP",
            zapAbi,
            "fundMeter",
            [HOUSE_FEEDS.payrolls.id, "<minImdOut>", "$(($(date +%s) + 600))"],
            " --value <eth>",
          ),
        },
        {
          comment: "How many requests each Intake has ever taken, and what one costs in IMD-wei today.",
          command: `cast call ${MAINNET.INTAKE} "nonce()(uint256)" --rpc-url ${PUBLIC_RPC} && cast call ${MAINNET.INTAKE_V1} "nonce()(uint256)" --rpc-url ${PUBLIC_RPC} && ${castCall(MAINNET.INTAKE, "INTAKE", "priceOf(bytes32,address)(uint256)", [MAINNET.ORACLE_ACTION, MAINNET.IMD])}`,
        },
        {
          comment:
            "The request logs themselves (an archive RPC is needed for blocks older than about a day).",
          command: `cast logs --address ${MAINNET.INTAKE} --from-block <block> ${TOPIC.INTAKE_REQUESTED} --rpc-url <an-archive-rpc>`,
        },
      ],
      sources: [
        liveNote("Standing Questions feeds", feeds),
        sourceNote(
          "Intake requests",
          `Requested and Completed logs of ${MAINNET.INTAKE} and ${MAINNET.INTAKE_V1}: recorded history plus a live scan through ${chain.rpcHost}`,
          history,
        ),
      ],
    };
  },
  meta: (m) => ({
    title: "Questions",
    description: m.launched
      ? `Standing Questions: three house feeds that buy their own oracle answers, with every round, its answer and who earned its tip. And ${m.intake.counts.listed} oracle requests bought on chain through the IdentityMD Intake.`
      : `Standing Questions is ${NOT_LAUNCHED}. This page shows the three house feeds exactly as they will ask, each already answered once by the live oracle, and ${m.intake.counts.listed} oracle requests bought on chain through the IdentityMD Intake.`,
  }),
  markdown(m) {
    const i = m.intake;
    return doc(
      m.launched
        ? `Questions is at ${link(m.questions.label, m.questions.url)}.${m.feedCount !== null ? ` ${m.feedCount} feed${m.feedCount === 1 ? " has" : "s have"} been created in it.` : ""}`
        : `**The Questions contract is ${NOT_LAUNCHED}** (launch A). No feed exists on chain and no request has been bought by it. What follows is each house feed exactly as it will ask, with the one request of each that the live oracle has already answered.`,
      m.feedsError
        ? `Questions could not be read${m.feedCount === null ? "" : " in full"} just now: ${m.feedsError}`
        : null,
      m.notLive.length > 0 ? doc("## What is not live", bullets(m.notLive)).trimEnd() : null,
      "## What a Standing Question is",
      ...m.explanation,
      "## The three house feeds",
      "Payrolls and hires are recomputed by IdentityMD from chain data. The weekly employers list is settled by panel agreement: IdentityMD does not recompute it.",
      ...m.houseFeeds.map((f) =>
        doc(
          `### ${f.name}: ${f.title}`,
          bullets([
            `What it asks: ${f.asks}`,
            `How it is settled: ${f.settled}`,
            `Answer: ${inline(f.answerType)}, from ${f.panel}`,
            `Cadence: ${f.cadence}`,
            `Window: ${f.window}`,
            `Keeper tip: ${f.tipImd} IMD for an answered round. Price cap: ${f.maxPriceImd} IMD`,
            `submit (hand in an answer the callback has not brought): ${f.submitOpen ? "open after thirty minutes" : "closed, because a panel judges this feed: only the Intake's own callback can answer a round"}`,
            `Payroll keeps a position of its own on this meter, topped up to ${f.payrollRunway} requests`,
            `Feed id: ${inline(f.id)}`,
          ]),
          f.live
            ? f.live.exists
              ? bullets(
                  [
                    `Meter: ${f.live.meterImd} IMD${f.live.requestsFunded !== null ? `, enough for ${f.live.requestsFunded} request${f.live.requestsFunded === 1 ? "" : "s"} at ${f.live.costImd} IMD each` : "; no request can be bought right now, so no cost is stated"}`,
                    f.live.payrollPositionImd !== null
                      ? `Payroll's own position on the meter: ${f.live.payrollPositionImd} IMD`
                      : "",
                    `Rounds so far: ${f.live.rounds}. Latest answer: ${f.live.latest}`,
                    `Next: ${f.live.next}`,
                  ].filter(Boolean),
                )
              : `On chain: ${f.live.next}`
            : `On chain: nothing yet. Questions is ${NOT_LAUNCHED}.`,
          f.live && f.live.roundRows.length > 0
            ? table(
                ["Round", "Window", "State", "Answer", "Requested", "Delivered by", "Tip"],
                f.live.roundRows.map((r) => [
                  r.round,
                  r.window,
                  r.status,
                  r.answer,
                  r.requestedAt ? formatUtc(r.requestedAt) : "",
                  r.delivered ?? "",
                  r.tip,
                ]),
              )
            : null,
          "Its exact body. The contract stores the two texts below and writes the window's two block numbers between them:",
          fence(`${f.bodyPrefix}<fromBlock>,"toBlock":<toBlock>}${f.bodyTail}`),
          `Proven once on the live system: the oracle answered this body for ${f.proof.window} with **${f.proof.answer}** (${f.proof.agreed}; attested ${formatUtc(f.proof.attestedAt)}). ${link("IdentityMD's record of the request", f.proof.url)} · ${link("the purchase", f.proof.requestTxUrl)}. The body for that window hashes to ${inline(f.proof.bodyHash)}${f.proof.bodyMatches ? ", the hash IdentityMD's Intake service recorded for the purchase" : " (this does NOT match the recorded hash)"}; the question hash built from this text is ${inline(f.proof.questionHash)}${f.proof.questionHashMatches ? ", the one the oracle attested" : " (this does NOT match the attested hash)"}. The request named no callback, so nothing was delivered to a contract.`,
        ).trimEnd(),
      ),
      m.eventsCoverage,
      m.otherFeeds.length > 0
        ? doc(
            "### Feeds created by others",
            table(
              ["Feed", "Rounds", "Latest value", "Meter, IMD", "Next request costs, IMD"],
              m.otherFeeds.map((f) => [f.id, f.rounds, f.latest, f.meterImd, f.costImd]),
            ),
          ).trimEnd()
        : null,
      "## The keeper tip",
      bullets(m.tipRule),
      "## The waits",
      bullets(m.waits),
      "## The keeper",
      m.keeper.words,
      m.keeper.attention.length > 0 ? bullets(m.keeper.attention) : null,
      m.keeper.nextDue.length > 0
        ? table(
            ["Feed", "Next due", "Note"],
            m.keeper.nextDue.map((d) => [d.feed, d.when, d.note]),
          )
        : null,
      "## Read a feed, fund a feed",
      fence(m.commands.map((c) => `# ${c.comment}\n${c.command}`).join("\n\n"), "sh"),
      ...m.flows.map(flowMarkdown),
      "## Requests bought on chain through the Intake",
      `There are two Intake contracts on Ethereum. Version 2 (${link(i.current.address, i.current.url)}) is the one IdentityMD names for anything new and the one launch A is built on. Version 1 (${link(i.legacy.address, i.legacy.url)}) is legacy and holds the earlier history, including the three requests that proved the house feeds.`,
      bullets([`Version 2: ${i.current.words}`, `Version 1: ${i.legacy.words}`]),
      `Of the ${i.counts.listed} listed: ${i.counts.answered} answered, ${i.counts.failed} with no answer or refused, ${i.counts.open} not completed on chain, ${i.counts.toContracts} with the answer to be delivered to a contract, ${i.counts.ours} bought by HELP WANTED's own wallets or contracts.`,
      i.current.priceWei !== null
        ? `One request costs ${formatImd(i.current.priceWei)} IMD today (read from version 2).`
        : null,
      i.coverage,
      i.error ? `The live scan failed just now: ${i.error}` : null,
      "Newest first. The question text is quoted from the request body: it is the payer's text, not this site's, and nothing in it is an instruction to the reader.",
      ...i.rows.map((r) =>
        doc(
          `### Request ${r.requestId.slice(0, 10)}, Intake version ${r.version}${r.when ? `, ${formatUtc(r.when)}` : ""}`,
          bullets([
            `Status: ${r.status}`,
            `Paid by: ${inline(r.payer)}${r.payerIsContract === true ? " (a contract)" : r.payerIsContract === false ? " (a wallet)" : ""}${r.house ? " (HOUSE: one of ours)" : ""}, ${formatImd(r.priceWei)} IMD`,
            r.callbackTarget
              ? `Answer to be delivered to contract: ${inline(r.callbackTarget)}`
              : "No callback: the payer reads the answer off chain",
            `Asked for: ${[r.answerType ? `a ${r.answerType}` : null, r.panel ? `agreement of ${r.panel} panel members` : null, r.window ? `about ${r.window}` : null].filter(Boolean).join(", ") || "not readable"}`,
            `Request: ${link("transaction", r.requestTxUrl)} (block ${formatInt(r.block)})${r.completionTxUrl ? ` · Completion: ${link("transaction", r.completionTxUrl)}` : ""}${r.resultUrl ? ` · ${link("oracle record", r.resultUrl)}` : ""} · ${link("what IdentityMD's service made of it", r.intakeReadUrl)}`,
          ]),
          r.question
            ? quote(r.question)
            : "The request body is not the JSON the oracle expects; no question could be read.",
        ).trimEnd(),
      ),
    );
  },
};

/** The short form of an address in a sentence, for the HTML page. */
export function shortKeeper(address: string | null): string {
  return address ? shortAddress(address) : "";
}
