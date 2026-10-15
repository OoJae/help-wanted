/**
 * The hire desk's pages: "/hire", "/hire/:template", "/orders", "/orders/:id", "/runners".
 *
 * They follow the deployments book. While the desk (WorkOrders, launch B) has no address there,
 * each page says "not launched yet", explains the order and plans the exact transactions with the
 * ABI the compiler wrote for the desk. Once it has one, each page reads the desk and says what it
 * answered: a desk that has opened no order is "live, no order yet", in those words, and a desk
 * that did not answer is "could not be read", never an empty list.
 */
import { keccak256, stringToHex, toHex, type Hex } from "viem";
import { NOT_LAUNCHED } from "~/config/deployments";
import { HISTORY_READ_ON, ORDER_HISTORY, pinnedOrder, type TrailKey } from "~/config/history";
import { HOUSE_WALLETS, houseSet } from "~/config/house";
import {
  CHAIN_ID,
  DESK,
  HEADER_LENGTH,
  MAINNET,
  orderHeadHash,
  orderHeader,
  orderTicket,
  PAID_ACTION_PRICE,
  priceAt,
  sameAddress,
  splitPrice,
  workOrdersAbi,
  workProofAbi,
} from "@help-wanted/shared";
import { etherscanAddress, etherscanTx, explorerJob, IMD_LINK } from "~/config/chain";
import { NOT_OFFERED, TEMPLATES, templateBySlug, type JobTemplate } from "~/config/templates";
import type { Live, Order, OrderBook } from "~/data/house";
import { GAS_LIMIT } from "~/lib/contracts";
import { formatDuration, formatImd, formatUtc, parseUnits, plural } from "~/lib/format";
import { ethFor, zapPreset, type ZapQuote } from "~/lib/zapQuote";
import { hashNo0x, jobIdToBytes16, parseIndex } from "~/lib/ids";
import { hashServedRecord } from "~/lib/verify";
import { bullets, doc, fence, inline, link, numbered, quote, table, untrusted } from "~/lib/md";
import { orderCard, orderStatusWords, templateForKindHash, type OrderCard } from "./cards";
import {
  castCall,
  castView,
  castWrite,
  CLAIM_TIP_RULE,
  contractStatus,
  ethNote,
  launchWords,
  liveNote,
  loadZapQuote,
  PAYS_WHEN,
  PUBLIC_RPC,
  type ContractStatus,
} from "./common";
import { flowMarkdown, previewFlow, type FlowPreview } from "./flowPreview";
import {
  claimDefault,
  loadReceiptFlow,
  receiptFlowMeaning,
  type ClaimDefault,
  type ReceiptFlow,
} from "./receipts";
import type { PageDef, SourceNote } from "./types";

/**
 * How many orders a launched desk has opened, in one sentence, from its own counter. Null while the
 * desk is not launched. A counter that did not answer is said to be unread; it is never a zero.
 */
export function ordersOpenedWords(read: Live<OrderBook>): string | null {
  if (!read.live) return null;
  if ("sample" in read && read.sample)
    return "SAMPLE DATA mode is on: the orders shown are made up and no figure is read from the desk.";
  if (!read.data)
    return `How many orders have been opened on it could not be read just now${read.error ? ` (${read.error})` : ""}.`;
  return read.data.count === 0
    ? "No order has been opened on it yet: its own counter, orderCount(), read 0 for this page."
    : `${plural(read.data.count, "order has", "orders have")} been opened on it so far.`;
}

/**
 * Who takes orders today, in a few sentences: the runners of the orders read from the desk, HOUSE
 * or OUTSIDE, and what the team says of its own runner. Never more than what was read.
 */
export function whoTakesOrders(read: Live<OrderBook>, house: ReadonlySet<string>): string {
  if (!read.live) return `Nobody yet: the hire desk is ${NOT_LAUNCHED}.`;
  if ("sample" in read && read.sample)
    return "SAMPLE DATA mode is on, so nothing is said here about real runners.";
  if (!read.data) return "Who has taken orders could not be read just now.";
  const taken = read.data.orders.filter((o) => o.claim !== null);
  if (taken.length === 0)
    return "No runner has taken an order yet. Anyone may run one: the runner is open source (bots/runner), and none has any privilege.";
  const runners = [...new Set(taken.map((o) => (o.claim as NonNullable<Order["claim"]>).runner))];
  const outside = runners.filter((r) => !house.has(r));
  const ours = runners.filter((r) => house.has(r)).map((r) => houseLabelOf(r) ?? r);
  const scope =
    read.data.orders.length === read.data.count
      ? read.data.count === 1
        ? "the one order opened on the desk"
        : `${taken.length} of the ${read.data.count} orders opened on the desk`
      : `${taken.length} of the newest ${read.data.orders.length} orders on the desk`;
  if (outside.length === 0) {
    return `Only the team's own runner (house wallet ${ours.join(" and ")}) has taken orders so far: ${scope}, read for this page. No runner is bound to take an order, so an order can wait for one. Anyone may run another: the runner is open source (bots/runner), and none has any privilege.`;
  }
  return `${runners.length === 1 ? "One runner has" : `${runners.length} runners have`} taken ${scope}, read for this page: ${outside.length} from outside the team (OUTSIDE)${ours.length > 0 ? ` and the team's own (${ours.join(" and ")}, HOUSE)` : ""}.`;
}

/**
 * What the team says of its own runner, as the team's dated statement. It is not read from anywhere:
 * the page prints it beside what the chain shows (`whoTakesOrders`), and never in its place.
 */
export const RUNNER_STATEMENT = {
  asOf: "15 October 2026",
  lines: [
    "HELP WANTED's runner bot runs on a hosted server (Railway), around the clock. It has been live since 15 October 2026, 14:18 UTC, and it signs as house wallet H1.",
    "It takes orders from any employer, one order at a time, for research reports and pictures (the kinds skill:research-report and skill:create-image).",
    "It pays at most one 0.5 IMD swarm fee a day, and posts bonds of at most 0.25 IMD.",
    "On 15 October 2026 it was set to ask for no margin: an order need only pay it the swarm's 0.5 IMD fee, and the gas is its own cost. The team did this so that it can serve the first order that a rule of the team's, in launch C, opens on the desk.",
  ],
  /** The other bot, said where runners are: it is not hosted. */
  keeper: "The keeper (bots/keeper) is not hosted: it is run by hand.",
  /** The same in one sentence, for a page that names it in passing. */
  short:
    "The team says its runner runs on a hosted server around the clock, signing as house wallet H1, since 15 October 2026, 14:18 UTC; the keeper is run by hand.",
} as const;

/** The swarm kinds the team says its runner takes, as the job templates name them. */
const RUNNER_TAKES: readonly string[] = ["skill:research-report", "skill:create-image"];

/** The team's statement as a page shows it: dated, and said to be the team's. */
export interface RunnerStatementView {
  asOf: string;
  /** "What the team says, 15 October 2026". */
  heading: string;
  lines: string[];
}

/**
 * The team's statement about its runner, for a book whose desk is mainnet's: the statement is about
 * that desk and that wallet. Null on any other book (a fork, a rehearsal, a test).
 */
export function runnerStatement(deskAddress: string | null, withKeeper = false): RunnerStatementView | null {
  if (!deskAddress || deskAddress.toLowerCase() !== ORDER_HISTORY.workOrders.toLowerCase()) return null;
  return {
    asOf: RUNNER_STATEMENT.asOf,
    heading: `What the team says, ${RUNNER_STATEMENT.asOf}`,
    lines: [...RUNNER_STATEMENT.lines, ...(withKeeper ? [RUNNER_STATEMENT.keeper] : [])],
  };
}

/** "Who takes orders today" in a twin: what the chain shows, then the team's dated statement. */
function whoTakesMarkdown(whoTakes: string, statement: RunnerStatementView | null): string[] {
  if (!statement) return [whoTakes];
  return [
    `What the chain shows: ${whoTakes}`,
    doc(`${statement.heading}. A statement, not a reading:`, bullets(statement.lines)).trimEnd(),
  ];
}

/**
 * Whether the team says its runner takes a template's kind, in one sentence, or null on a book whose
 * desk is not mainnet's.
 */
export function runnerTakesWords(deskAddress: string | null, kind: string): string | null {
  if (!runnerStatement(deskAddress)) return null;
  return RUNNER_TAKES.includes(kind)
    ? `The team says its runner takes this kind of order when the order's bond is at most 0.25 IMD, one order at a time, and that it pays at most one 0.5 IMD swarm fee a day (${RUNNER_STATEMENT.asOf}). Any other runner may take it too.`
    : `The team says its runner does not take this kind of order: it takes research reports and pictures (${RUNNER_STATEMENT.asOf}). An order of this kind waits for another runner.`;
}

/** Who the hire desk is for, and who it is not for. */
export const HIRE_IS_FOR = [
  "A contract, a DAO or a wallet that wants swarm work paid from escrow: the IMD is paid out on the job's receipt on chain or, only if the employer opted in when posting, on a bonded delivery claim nobody challenges for 24 hours. Otherwise it comes back.",
  "An employer that should not have to be there when the moment comes: a conditional order starts closed to runners. It does not open by itself: once its condition holds, anyone, a runner for instance, may open it with trigger(id) (Say When).",
  "Not for work only a person can judge: a proof shows what IdentityMD recorded for the job, not that the work is good.",
] as const;

/** Who running is for. */
export const RUNNING_IS_FOR = [
  "Anyone with a wallet and some IMD who wants a margin for carrying orders to the swarm: 90% of an order's price, for the swarm's 0.5 IMD and the gas.",
  "Someone willing to post a bond and pay the swarm up front, and, on an order that pays only on a receipt, to bear a receipt that comes late.",
  "A wallet, as the runner in this repository is built: it buys each job by x402, which needs an ordinary wallet's signature. IdentityMD's Intake would also sell a contract the job, billed up front; nothing here uses the Intake's job.open.",
] as const;

/**
 * Why runners exist, in one paragraph: IdentityMD is paid before the work, by either of its two
 * doors, and the desk pays only later, on the receipt or on a bonded claim that stands. Checked against IdentityMD's docs ("Pay onchain", "How
 * paying works") and the Intake's own `priceOf` on 15 October 2026.
 */
export const WHY_RUNNERS =
  "IdentityMD bills up front. Its Intake takes the 0.5 IMD in the call that opens a job, from a wallet or a contract alike, and its x402 route needs an ordinary wallet's signature. HELP WANTED makes the employer's pay wait: the desk escrows it and pays on the job's receipt, or, on an order whose employer opted in, on a bonded claim nobody challenges for 24 hours, and refunds it otherwise. So somebody fronts the swarm's fee. A runner is the wallet that does it, under bond, for a margin. The team's runner pays by x402. The Intake's job.open is not used here.";

// ---------------------------------------------------------------------------------------------
// /hire
// ---------------------------------------------------------------------------------------------

export interface TemplateCard {
  slug: string;
  path: string;
  title: string;
  staff: string;
  kind: string;
  delivers: string;
  turnaround: string;
  recordSize: string | null;
  /** What the record's size means for an employer, when it means something. */
  recordNote: string | null;
  suggestedPay: string;
  /** The suggested pay in ETH, at the quote read for the page; null without one. */
  suggestedPayEth: string | null;
}

export interface HireIndexModel {
  generatedAt: string;
  desk: ContractStatus;
  /** "IdentityMD launch 1573", or null while the desk is not launched or the book records no number. */
  deskLaunch: string | null;
  /** How many orders the launched desk has opened, in words; null while it is not launched. */
  ordersOpened: string | null;
  templates: TemplateCard[];
  notOffered: { slug: string; title: string; why: string }[];
  how: string[];
  terms: string[];
  claimLimits: string[];
  /** Whether receipts are reaching the registry, from figures read for this page. */
  receipts: ReceiptFlow;
  /** How the order form's claim box starts today, and why. */
  claim: ClaimDefault;
  /** Who takes orders today, from the orders read. */
  whoTakes: string;
  /** What the team says of its own runner, dated; null where the book's desk is not mainnet's. */
  runnerStatement: RunnerStatementView | null;
  whoFor: readonly string[];
  /** Buying IMD with ETH through Zap, for a wallet that holds only ETH. */
  zapFlow: FlowPreview;
  /** How the ETH beside IMD amounts on this page was worked out. Null without a quote. */
  ethNote: string | null;
}

function templateCard(t: JobTemplate, quote: ZapQuote | null = null): TemplateCard {
  const low = ethFor(parseUnits(t.suggestedMinPay, 18) ?? 0n, quote);
  const high = ethFor(parseUnits(t.suggestedMaxPay, 18) ?? 0n, quote);
  return {
    slug: t.slug,
    path: `/hire/${t.slug}`,
    title: t.title,
    staff: t.staff,
    kind: t.kind,
    delivers: t.delivers,
    turnaround: t.turnaround,
    recordSize: t.recordSize,
    recordNote: t.recordNote ?? null,
    suggestedPay: `${t.suggestedMinPay} to ${t.suggestedMaxPay} IMD`,
    suggestedPayEth: low && high ? `about ${low} to ${high} ETH` : null,
  };
}

const HOW_AN_ORDER_WORKS = [
  "You post an order: the desk escrows your IMD and pins the job text. That is the most the order can cost you.",
  "A runner takes it. The runner posts a bond, pays the swarm's fee from its own pocket, and opens the job with the 85-byte order header, made from the order's ticket, as the first bytes of the job text.",
  "The swarm does the work and IdentityMD writes the work record's hash to its WorkRegistry on Ethereum.",
  "Anyone submits the record. The desk checks that it hashes to the registry's receipt, that it is the job you ordered and that it finished, and pays the runner. You get back what the price left.",
  "If none of that happens in time, the escrow goes back to you.",
  "Only if you allowed it when you posted: with no receipt available, the runner may claim delivery under its bond, and is paid if nobody challenges the claim within 24 hours. The order form ticks that box for you only while IdentityMD's receipts are stalled, and says so. The limits of that choice are below.",
];

/** The two limits of the bonded-claim path, as an employer must hear them before choosing it. */
export const CLAIM_PATH_LIMITS = [
  "A claim that is untrue and that nobody challenges within 24 hours is paid. Nothing on chain watches your order for you: you, or someone you ask, must, and a challenge means posting a bond equal to the runner's, which is lost if the claim turns out to be true.",
  "A challenge that nothing decides refunds you, even when the claim was true: with no receipt by the delivery deadline the runner goes unpaid. While receipts are late, anyone can cause that at no cost to themselves.",
  "An arbiter helps with both: an address you name on the order that can decide a challenged claim either way, so a dispute need not wait for a receipt. It does not challenge for you. The other answer is to leave the claim path off and accept that an order whose receipt is late is refunded.",
];

const ORDER_TERMS = [
  `Fee: 5% of the fixed price, sent to Payroll and split by code (half to sIMD stakers, 30% to seat owners, 20% to the feeds).`,
  "Tip: another 5% of the fixed price, to the seats of the agents the job's work record names.",
  `Runner's bond: at least ${formatImd(DESK.MIN_BOND)} IMD. A runner has one hour after taking an order to register a swarm job.`,
  "Delivery: three days from the moment the job is registered on an order from this form; the desk allows up to ninety.",
  "The job text is one line of plain ASCII, without double quotes or backslashes, at most 7,900 bytes. That rule is what lets a contract compare your text with the work record byte for byte.",
  `The swarm's own price is ${formatImd(PAID_ACTION_PRICE)} IMD a job, paid by the runner and never refunded, so an order needs to pay more than that to be worth taking.`,
];

export const hireIndexPage: PageDef<HireIndexModel> = {
  id: "hire",
  pattern: "/hire",
  async load({ sources, now }) {
    const [receipts, writer, orders, quote] = await Promise.all([
      loadReceiptFlow(sources),
      sources.chain.receiptWriter(),
      sources.house.orders(40),
      loadZapQuote(sources),
    ]);
    return {
      generatedAt: now.toISOString(),
      desk: contractStatus(sources.deployments, "workOrders"),
      deskLaunch: launchWords(sources.deployments, "workOrders"),
      ordersOpened: ordersOpenedWords(orders),
      templates: TEMPLATES.map((t) => templateCard(t, quote)),
      notOffered: [...NOT_OFFERED],
      how: HOW_AN_ORDER_WORKS,
      terms: ORDER_TERMS,
      claimLimits: CLAIM_PATH_LIMITS,
      receipts,
      claim: claimDefault(writer, PUBLIC_RPC),
      whoTakes: whoTakesOrders(orders, houseSet(sources.deployments)),
      runnerStatement: runnerStatement(sources.deployments.contracts.workOrders.address),
      whoFor: HIRE_IS_FOR,
      zapFlow: previewFlow("zap-buy", sources.deployments, now, zapPreset(quote), zapPreset(quote)),
      ethNote: ethNote(quote),
    };
  },
  meta: () => ({
    title: "Hire the swarm",
    description:
      "Post an order to the hire desk: escrow IMD against a pinned job, and pay when the work is proven on chain, or on a bonded claim only if you allow one. Four kinds of job are offered.",
  }),
  markdown(m) {
    return doc(
      m.desk.address
        ? `The hire desk is live at ${link(m.desk.address, etherscanAddress(m.desk.address))} (WorkOrders${m.deskLaunch ? `, ${m.deskLaunch}` : ""}). ${m.ordersOpened ?? ""}`.trim()
        : `**The hire desk is ${NOT_LAUNCHED}** (WorkOrders, launch B). Nothing can be ordered today. This page shows what an order is and each job page shows the exact transactions.`,
      "## Who takes orders today",
      ...whoTakesMarkdown(m.whoTakes, m.runnerStatement),
      "## Who this is for",
      bullets([...m.whoFor]),
      "## Jobs on offer",
      table(
        ["Job", "Who turns up", "What comes back", "Measured turnaround", "Suggested pay", "Page"],
        m.templates.map((t) => [
          t.title,
          t.staff,
          t.delivers,
          t.turnaround,
          `${t.suggestedPay}${t.suggestedPayEth ? ` (${t.suggestedPayEth})` : ""}`,
          link(t.path, t.path),
        ]),
      ),
      m.ethNote,
      "Turnaround was measured on real swarm jobs on 10 Oct 2026. It is an observation, not a promise.",
      "## Not offered yet",
      bullets(m.notOffered.map((n) => `${n.title}: ${n.why}`)),
      "## How an order works",
      numbered(m.how),
      "## The terms, all fixed in code",
      bullets(m.terms),
      "## Paying without a receipt: your choice, and its limits",
      `The desk ${PAYS_WHEN}. Read for this page: ${m.receipts.observed} ${receiptFlowMeaning(m.receipts)}`,
      `How the order form's claim box starts today: ${m.claim.why}`,
      fence(
        `# The test the form applies: receipts recorded by the WorkRegistry in the last six hours of blocks.\n${m.claim.command}`,
        "sh",
      ),
      bullets(m.claimLimits),
      "## Only ETH? Buy IMD first",
      ZAP_BUY_WORDS,
      flowMarkdown(m.zapFlow),
    );
  },
};

/** Why /hire offers the swap, and what it does not do. */
export const ZAP_BUY_WORDS =
  'The desk escrows IMD, and makes whoever calls it the employer. A wallet that holds only ETH buys the IMD first through Zap (launch C), which swaps on the Uniswap v4 ETH/IMD pool and sends the IMD to the wallet; then it posts the order in its own name. The form fills in the least IMD you accept with 99% of a quote for the ETH you type, and refuses a minimum below 95% of it unless you tick "Accept any price".';

export interface HireTemplateModel {
  generatedAt: string;
  desk: ContractStatus;
  template: TemplateCard;
  flow: FlowPreview;
  exampleSpec: string;
  /** The first words a card for this order would carry. */
  cardLine: string;
  claimLimits: string[];
  /** Whether receipts are reaching the registry, from figures read for this page. */
  receipts: ReceiptFlow;
  /** How the form's claim box starts today, and why. */
  claim: ClaimDefault;
  /** Whether the team says its runner takes this kind, dated; null where the book's desk is not mainnet's. */
  runnerTakes: string | null;
}

const EXAMPLES: Record<string, Record<string, string>> = {
  audit: {
    repoUrl: "https://github.com/owner/repo",
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    focus: "the withdrawal path and its rounding",
  },
  research: {
    question:
      "Compare the fee models of the three largest on-chain job escrows and say which suits a small DAO.",
  },
  image: { brief: "A square picture of a brass doorbell beside a blue front door, morning light, no text." },
  video: { brief: "A 30-second explainer of how a contract hires a robot, in the style of a newsreel." },
};

export const hireTemplatePage: PageDef<HireTemplateModel> = {
  id: "hire-template",
  pattern: "/hire/:template",
  async load({ sources, now }, params) {
    const template = templateBySlug(params.template ?? "");
    if (!template) return null;
    const example = EXAMPLES[template.slug] ?? {};
    const [receipts, writer] = await Promise.all([loadReceiptFlow(sources), sources.chain.receiptWriter()]);
    const claim = claimDefault(writer, PUBLIC_RPC);
    // The form starts as the rule says, and carries the reason to the box itself.
    const preset = {
      template: template.slug,
      allowClaimed: claim.preselected ? "true" : "false",
      claimNote: claim.why,
    };
    return {
      generatedAt: now.toISOString(),
      desk: contractStatus(sources.deployments, "workOrders"),
      template: templateCard(template),
      flow: previewFlow("hire", sources.deployments, now, preset, example),
      exampleSpec: template.spec(example),
      cardLine: `HELP WANTED: ${template.staff}. Pay up to ${template.suggestedMaxPay} IMD.`,
      claimLimits: CLAIM_PATH_LIMITS,
      receipts,
      claim,
      runnerTakes: runnerTakesWords(sources.deployments.contracts.workOrders.address, template.kind),
    };
  },
  meta: (m) => ({
    title: `Hire: ${m.template.title.toLowerCase()}`,
    description: `${m.template.delivers} Measured turnaround: ${m.template.turnaround}.`,
  }),
  markdown(m) {
    return doc(
      `**${m.cardLine}**`,
      m.template.delivers,
      bullets(
        [
          `Who turns up: ${m.template.staff}`,
          `Work-record kind the order pins: ${inline(m.template.kind)}`,
          `Measured turnaround (10 Oct 2026): ${m.template.turnaround}`,
          m.template.recordSize ? `Measured work-record size: ${m.template.recordSize}` : "",
        ].filter(Boolean),
      ),
      m.template.recordNote,
      m.runnerTakes,
      "## Before you choose how it pays",
      `An order pays on an on-chain receipt. It may also accept a bonded delivery claim, and the form decides how that box starts by one rule: it is ticked only while IdentityMD's receipts are stalled. Today: ${m.claim.why}`,
      fence(
        `# The test the form applies: receipts recorded by the WorkRegistry in the last six hours of blocks.\n${m.claim.command}`,
        "sh",
      ),
      `Read for this page as well: ${m.receipts.observed} ${receiptFlowMeaning(m.receipts)} If the order accepts a bonded delivery claim, these are its limits:`,
      bullets(m.claimLimits),
      "## The job text an order would carry (example)",
      quote(m.exampleSpec),
      "## The transactions",
      flowMarkdown(m.flow),
    );
  },
};

// ---------------------------------------------------------------------------------------------
// /orders and /orders/:id
// ---------------------------------------------------------------------------------------------

export interface OrdersModel {
  generatedAt: string;
  desk: ContractStatus;
  launched: boolean;
  count: number | null;
  cards: OrderCard[];
  error: string | null;
  sources: SourceNote[];
}

export const ordersPage: PageDef<OrdersModel> = {
  id: "orders",
  pattern: "/orders",
  async load({ sources, now }) {
    const { house, chain, deployments } = sources;
    const read = await house.orders(40);
    const houseAddresses = houseSet(deployments);
    const cards =
      read.live && read.data
        ? await Promise.all(
            read.data.orders.map(async (o) =>
              orderCard(
                o,
                o.sample ? true : await chain.isContract(o.employer).catch(() => null),
                houseAddresses,
              ),
            ),
          )
        : [];
    return {
      generatedAt: now.toISOString(),
      desk: contractStatus(deployments, "workOrders"),
      launched: read.live,
      count: read.live && read.data ? read.data.count : null,
      cards,
      error: read.live ? read.error : null,
      sources: [liveNote("Orders", read)],
    };
  },
  meta: (m) => ({
    title: "Orders",
    description: m.launched
      ? m.count === null
        ? "How many orders have been opened on the hire desk could not be read just now."
        : m.count === 0
          ? "The hire desk is live and no order has been opened on it yet."
          : `${plural(m.count, "order has", "orders have")} been opened on the hire desk.`
      : `The hire desk is ${NOT_LAUNCHED}; there are no orders.`,
  }),
  markdown(m) {
    return doc(
      m.launched
        ? m.count === null
          ? `The hire desk is at ${m.desk.label}. How many orders have been opened on it could not be read just now.`
          : m.count === 0
            ? `The hire desk is live at ${m.desk.label}. No order has been opened on it yet: its own counter, orderCount(), read 0 for this page.`
            : `${plural(m.count, "order has", "orders have")} been opened on the hire desk at ${m.desk.label}.`
        : `**No orders.** The hire desk (WorkOrders, launch B) is ${NOT_LAUNCHED}.`,
      m.error ? `The desk could not be read just now: ${m.error}` : null,
      m.cards.length > 0
        ? table(
            ["Order", "Card", "Employer", "Origin", "Status"],
            m.cards.map((c) => [
              link(`#${c.id}`, c.path),
              `${c.headline} ${c.pay}${c.sample ? " (SAMPLE)" : ""}`,
              c.employer,
              c.origin,
              c.stamp?.text ?? "OPEN",
            ]),
          )
        : null,
      `Post one at ${link("/hire", "/hire")}; take one at ${link("/runners", "/runners")}.`,
    );
  },
};

export interface TimelineStep {
  label: string;
  /** done, current or waiting. */
  at: "done" | "current" | "waiting" | "skipped";
  detail: string;
}

/** One transaction of an order's history, oldest first. */
export interface TrailRow {
  key: TrailKey;
  label: string;
  what: string;
  at: string;
  block: number;
  tx: string;
  txUrl: string;
}

/** What `WorkProof.prove(jobId, record, 85)` answers for a delivered order's job. */
export interface OrderProof {
  /** The two commands: fetch the record as IdentityMD serves it, then ask the launched WorkProof. */
  commands: { comment: string; command: string }[];
  answer: {
    recordHash: string;
    kindHash: string;
    headHash: string;
    specHash: string;
    stateHash: string;
    agentIds: string[];
  } | null;
  /** `live`: called for this page. `pinned`: the answer read on the day `config/history.ts` names. */
  source: "live" | "pinned" | null;
  /** The answer as cast prints it. */
  printed: string | null;
  /** What the answer shows, held against the order's own terms, in sentences. */
  words: string;
}

/** A tip the settlement credited in Payroll, and where it stands now. */
export interface OrderTip {
  agentId: string;
  /** The seat the Adapter binds the agent to, and that seat's owner now. Null when unread or unbound. */
  seat: string | null;
  owner: string | null;
  /** `Payroll.tipOwed(agentId)`, read for this page. Null when unread. */
  owedImd: string | null;
  claimed: { at: string; amountImd: string; paidTo: string; from: string; txUrl: string } | null;
  words: string;
}

export interface OrderModel {
  generatedAt: string;
  id: number;
  desk: ContractStatus;
  launched: boolean;
  /** Null when the desk is not launched, could not be read, or has no such order. */
  order: Order | null;
  card: OrderCard | null;
  error: string | null;
  kind: string | null;
  statusWords: string;
  timeline: TimelineStep[];
  money: { label: string; imd: string }[];
  /**
   * The 85 bytes the claim's swarm job must begin with, worked out here from the order's ticket
   * (chain id, desk, order id, claim number, runner). Null when no runner has taken the order or
   * the desk has no address.
   */
  header: string | null;
  ticket: string | null;
  jobUrl: string | null;
  verifyPath: string | null;
  /**
   * True once the order is Delivered. Its expiry and the actions anyone could take on it are then
   * left out of every form of the page: nothing can be done to a delivered order.
   */
  delivered: boolean;
  /** The order's transactions, from `config/history.ts`. Empty for an order no history is kept for. */
  trail: TrailRow[];
  /** Where the trail comes from, in one sentence. Null with no trail. */
  trailNote: string | null;
  /** For a delivered order with a job and a record: the proof through the launched WorkProof. */
  proof: OrderProof | null;
  tips: OrderTip[];
  /** The IPFS CID IdentityMD's API gives for the job's media, as text. Null when it gives none. */
  mediaCid: string | null;
  /**
   * IdentityMD's own page of a delivered picture job, which shows the picture. This site serves no
   * copy of it. Null for an order whose job made no picture or is not delivered.
   */
  picture: { label: string; url: string } | null;
  commands: { comment: string; command: string }[];
  flows: FlowPreview[];
  sources: SourceNote[];
}

/** The prove answer as cast prints it, each hash in full. */
function printProof(a: NonNullable<OrderProof["answer"]>): string {
  return `(${[a.recordHash, a.kindHash, a.headHash, a.specHash, a.stateHash].join(", ")}, [${a.agentIds.join(", ")}])`;
}

function timeline(order: Order): TimelineStep[] {
  const s = order.state;
  const c = order.claim;
  const ended = s === "Cancelled" || s === "Refunded";
  // The index of the last step that has happened: 0 POSTED, 1 TAKEN, 2 JOB OPENED, 3 DELIVERED, 4 PROVEN.
  const last: Record<Order["state"], number> = {
    None: 0,
    Open: 0,
    Claimed: 1,
    Registered: 2,
    Asserted: 2,
    Disputed: 2,
    Delivered: order.terms?.proven ? 4 : 3,
    Cancelled: 0,
    Refunded: 0,
  };
  const at = (index: number): TimelineStep["at"] =>
    index <= last[s] ? "done" : ended ? "skipped" : index === last[s] + 1 ? "current" : "waiting";
  const when = (t: number | undefined) => (t ? formatUtc(t * 1000) : "");
  const steps: TimelineStep[] = [
    { label: "POSTED", at: at(0), detail: "Escrow pulled, job text pinned." },
    {
      label: "TAKEN",
      at: at(1),
      detail: c?.claimedAt
        ? `By ${c.runner}, ${when(c.claimedAt)}.`
        : "A runner posts a bond and fixes the price.",
    },
    {
      label: "JOB OPENED",
      at: at(2),
      detail: c?.jobId
        ? `Swarm job ${c.jobId}, registered ${when(c.registeredAt)}.`
        : "The runner registers the swarm job's id.",
    },
    {
      label: "DELIVERED",
      at: at(3),
      detail:
        s === "Asserted"
          ? `Delivery claimed without a receipt ${when(c?.assertedAt)}; open to challenge for 24 hours.`
          : s === "Disputed"
            ? `Challenged by ${c?.challenger ?? "someone"}; a receipt or the arbiter decides.`
            : s === "Delivered"
              ? "Paid out."
              : "The work record is submitted, or a bonded claim goes unchallenged.",
    },
    {
      label: "PROVEN",
      at: at(4),
      detail: order.terms?.proven
        ? "The record was matched to its WorkRegistry receipt."
        : "Waits for the record to be matched to its WorkRegistry receipt.",
    },
  ];
  if (s === "Cancelled")
    steps.push({ label: "WITHDRAWN", at: "done", detail: "The employer took the order back." });
  if (s === "Refunded")
    steps.push({ label: "REFUNDED", at: "done", detail: "The escrow went back to the employer." });
  return steps;
}

export const orderPage: PageDef<OrderModel> = {
  id: "order",
  pattern: "/orders/:id",
  async load({ sources, now }, params) {
    const id = parseIndex(params.id);
    if (id === null || id < 1) return null;
    const { house, chain, deployments, api } = sources;
    const read = await house.order(id);
    const desk = contractStatus(deployments, "workOrders");
    const pinned = pinnedOrder(desk.address, id);
    const readOrder = read.live ? read.data : null;
    // The job text is published once, in the order's opening log. Once the RPC no longer serves that
    // log, the copy kept in config/history.ts is shown instead, and only when it hashes to the
    // specHash the desk holds for the order.
    const order: Order | null =
      readOrder &&
      !readOrder.spec &&
      pinned &&
      readOrder.terms?.specHash === keccak256(stringToHex(pinned.spec))
        ? { ...readOrder, spec: pinned.spec }
        : readOrder;
    if (read.live && read.data === null && !read.error) return null;
    const delivered = order?.state === "Delivered";
    const card = order
      ? orderCard(
          order,
          order.sample ? true : await chain.isContract(order.employer).catch(() => null),
          houseSet(deployments),
        )
      : null;
    const template = templateForKindHash(order?.terms?.kindHash);
    const t = order?.terms ?? null;
    const c = order?.claim ?? null;
    const money: OrderModel["money"] = [];
    if (order) {
      money.push({ label: "Still in escrow", imd: formatImd(order.escrowWei) });
      money.push({ label: "Paid out for delivered work", imd: formatImd(order.spentWei) });
      money.push({ label: "Sent back to the employer", imd: formatImd(order.returnedWei) });
      if (t) {
        money.push({ label: "Opening price", imd: formatImd(t.minPayWei) });
        money.push({ label: "Most it can cost", imd: formatImd(t.maxPayWei) });
        if (order.state === "Open") {
          // The same straight line the desk draws; `priceNow(id)` on chain is the authority.
          const price = priceAt({
            minPay: t.minPayWei,
            maxPay: t.maxPayWei,
            rampSecs: t.rampSecs,
            rampFrom: t.rampFrom,
            now: Math.floor(now.getTime() / 1000),
          });
          money.push({ label: "Price if a runner took it now", imd: formatImd(price) });
        }
        money.push({ label: "Runner's bond", imd: formatImd(t.bondWei) });
      }
      if (c) {
        const split = splitPrice(c.priceWei);
        money.push({ label: "Price fixed by the runner's claim", imd: formatImd(c.priceWei) });
        money.push({ label: "of which fee (to Payroll)", imd: formatImd(split.fee) });
        money.push({
          label: "of which tip (to the seats of the agents the record names)",
          imd: formatImd(split.tip),
        });
        money.push({ label: "of which to the runner", imd: formatImd(split.runnerPay) });
      }
    }
    // The ticket binds the swarm job to this order, this claim and this runner. It is recomputed
    // here rather than read from the desk, so the page shows how anyone can derive it.
    let ticket: string | null = null;
    if (order && c && t && t.claims > 0 && desk.address) {
      try {
        ticket = orderTicket({
          chainId: CHAIN_ID,
          workOrders: desk.address as `0x${string}`,
          orderId: id,
          claimSeq: t.claims,
          runner: c.runner as `0x${string}`,
        });
      } catch {
        ticket = null;
      }
    }
    // ---- A delivered order: the proof through the launched WorkProof, the tips, the picture. ----
    const workProof = deployments.contracts.workProof.address;
    let proof: OrderProof | null = null;
    let tips: OrderTip[] = [];
    let mediaCid: string | null = null;
    const proofSources: SourceNote[] = [];
    if (order && delivered && c?.jobId && c.recordHash) {
      const jobHex = jobIdToBytes16(c.jobId);
      const recordHash = c.recordHash;
      // The job itself is read only for an order whose history this site keeps: the server reads in
      // full only the jobs it names itself.
      const readJob = async (jobId: string) => {
        try {
          return (await api.job(jobId)).value;
        } catch {
          return null;
        }
      };
      const [served, job] = await Promise.all([
        api.workRecord(recordHash).catch(() => null),
        pinned?.jobId === c.jobId ? readJob(c.jobId) : Promise.resolve(null),
      ]);
      mediaCid = job?.mediaCid ?? null;
      // The bytes whose hash is the record hash, exactly: the call is made with nothing else.
      let bytes: Uint8Array | null = null;
      if (served) {
        const hashed = hashServedRecord(served.bytes, recordHash);
        if (hashed.matches)
          bytes = hashed.strippedNewline ? served.bytes.subarray(0, served.bytes.length - 1) : served.bytes;
      }
      let answer: OrderProof["answer"] = null;
      let source: OrderProof["source"] = null;
      if (bytes && workProof) {
        try {
          const called = await chain.views(
            `prove:${jobHex}:${recordHash}`,
            [
              {
                to: workProof,
                abi: workProofAbi,
                functionName: "prove",
                args: [jobHex, toHex(bytes), BigInt(HEADER_LENGTH)],
              },
            ],
            10 * 60_000,
          );
          const r = called.value[0];
          const p = r?.ok ? (r.value as Record<string, unknown>) : null;
          if (p) {
            answer = {
              recordHash: String(p.recordHash).toLowerCase(),
              kindHash: String(p.kindHash).toLowerCase(),
              headHash: String(p.headHash).toLowerCase(),
              specHash: String(p.specHash).toLowerCase(),
              stateHash: String(p.stateHash).toLowerCase(),
              agentIds: (p.agentIds as readonly bigint[]).map((a) => a.toString()),
            };
            source = "live";
            proofSources.push({
              name: "WorkProof.prove",
              detail: `eth_call to ${workProof} with the job's record as IdentityMD serves it`,
              fetchedAt: new Date(called.fetchedAt).toISOString(),
              stale: called.stale,
              error: called.error,
            });
          }
        } catch {
          answer = null;
        }
      }
      if (!answer && pinned && pinned.prove.recordHash === recordHash) {
        const p = pinned.prove;
        answer = {
          recordHash: p.recordHash,
          kindHash: p.kindHash,
          headHash: p.headHash,
          specHash: p.specHash,
          stateHash: p.stateHash,
          agentIds: [...p.agentIds],
        };
        source = "pinned";
      }
      const checks: string[] = [];
      if (answer) {
        const same = (a: string, b: string | null | undefined) => !!b && a.toLowerCase() === b.toLowerCase();
        checks.push(
          same(answer.recordHash, recordHash)
            ? "The first hash is the record's, which is the receipt WorkRegistry.latest holds for the job: prove reads the registry itself and reverts for any other bytes."
            : "The first hash is not the record hash the desk holds for the order.",
        );
        if (t) {
          checks.push(
            same(answer.kindHash, t.kindHash) ? "The kind is the order's." : "The kind is NOT the order's.",
            same(answer.specHash, t.specHash)
              ? "The job text after the 85-byte order header hashes to the order's job text."
              : "The job text after the 85-byte order header is NOT the order's.",
          );
        }
        if (ticket) {
          checks.push(
            same(answer.headHash, orderHeadHash(ticket as Hex))
              ? "The objective begins with this claim's 85-byte order header."
              : "The objective does NOT begin with this claim's 85-byte order header.",
          );
        }
        checks.push(
          answer.agentIds.length === 0
            ? "The record names no agent, so the tip went to the seat pool."
            : `${answer.agentIds.length === 1 ? "The agent the record names" : "The agents the record names"}: ${answer.agentIds.join(", ")}.`,
        );
      }
      proof = {
        commands: [
          {
            comment: "The work record, exactly as IdentityMD serves it.",
            command: `curl -s ${IMD_LINK.workRecord(hashNo0x(recordHash))} -o record.json`,
          },
          {
            comment:
              "Ask the launched WorkProof. It reads WorkRegistry.latest itself, walks the record and answers (recordHash, kindHash, headHash, specHash, stateHash, agentIds); change one byte and it reverts.",
            command: castView(workProof, "WORK_PROOF", workProofAbi, "prove", [
              jobHex,
              `"0x$(xxd -p record.json | tr -d '\\n')"`,
              String(HEADER_LENGTH),
            ]),
          },
        ],
        answer,
        source,
        printed: answer ? printProof(answer) : null,
        words: answer
          ? `${source === "live" ? "Called for this page." : `As called on ${pinned?.prove.read ?? "the day it was pinned"}; the call could not be made for this page.`} ${checks.join(" ")} A proof shows what IdentityMD recorded, not that the work is good.`
          : "The call could not be made for this page; the commands make it.",
      };

      // The tips: each agent, its seat and that seat's owner now, and what Payroll still owes for it.
      const agents = (answer?.agentIds ?? []).slice(0, 16);
      if (agents.length > 0) {
        const [bindings, owed] = await Promise.all([
          chain.bindings(agents).catch(() => [] as Awaited<ReturnType<typeof chain.bindings>>),
          Promise.all(agents.map((agent) => house.tipOwed(agent))),
        ]);
        tips = agents.map((agentId, index) => {
          const binding = bindings.find((b) => b.agentId === agentId) ?? null;
          const owedRead = owed[index];
          const owedWei = owedRead?.live && owedRead.data !== null ? owedRead.data : null;
          const claim = pinned?.tipClaims.find((tc) => tc.agentId === agentId) ?? null;
          const seat = binding?.bound ? binding.tokenId : null;
          const seatWords = seat !== null ? `seat #${seat}` : "its seat";
          const claimed = claim
            ? {
                at: claim.tx.at,
                amountImd: formatImd(claim.amountWei),
                paidTo: claim.paidTo,
                from: claim.tx.from,
                txUrl: etherscanTx(claim.tx.hash),
              }
            : null;
          const caller = claim ? (houseLabelOf(claim.tx.from) ?? claim.tx.from) : null;
          const words =
            owedWei === null
              ? `What Payroll owes for agent ${agentId} could not be read just now.`
              : owedWei > 0n
                ? `Unclaimed: ${formatImd(owedWei)} IMD waits in Payroll for ${seatWords}'s owner (Payroll.tipOwed, read for this page). ${CLAIM_TIP_RULE.replace("claimTip", `claimTip(${agentId})`)} The call also fails, and the tip stays owed, while the agent is bound to no seat or to a seat that is not one of Payroll's.`
                : claim
                  ? `Claimed: on ${formatUtc(claim.tx.at)} ${caller === "W1" || caller === "H1" ? `house wallet ${caller}` : caller} called claimTip(${agentId}), and Payroll paid the ${formatImd(claim.amountWei)} IMD tip credited for agent ${agentId}, the agent IdentityMD's work record names, to the owner of seat #${claim.tokenId}, ${claim.paidTo}. ${claim.paidToHasCode ? `That owner's address had code when read on ${HISTORY_READ_ON}, so only the owner could send the call.` : `That owner's address had no code when read on ${HISTORY_READ_ON}, so anyone could send the call.`} Payroll.tipOwed reads 0 for this page.`
                  : `Payroll.tipOwed reads 0 for agent ${agentId} for this page: nothing is waiting for it.`;
          return {
            agentId,
            seat,
            owner: binding?.owner ?? null,
            owedImd: owedWei === null ? null : formatImd(owedWei),
            claimed,
            words,
          };
        });
      }
    }

    const trail: TrailRow[] = (pinned?.trail ?? []).map((step) => ({
      key: step.key,
      label: step.label,
      what: step.what,
      at: step.tx.at,
      block: step.tx.block,
      tx: step.tx.hash,
      txUrl: etherscanTx(step.tx.hash),
    }));

    return {
      generatedAt: now.toISOString(),
      id,
      desk,
      launched: read.live,
      order,
      card,
      error: read.live ? read.error : null,
      kind: template?.kind ?? null,
      statusWords: order
        ? orderStatusWords(order)
        : read.live
          ? `The hire desk could not be read just now, so nothing is said here about order ${id}.`
          : `The hire desk is ${NOT_LAUNCHED}, so order ${id} does not exist.`,
      timeline: order ? timeline(order) : [],
      money,
      header: ticket ? orderHeader(ticket as `0x${string}`) : null,
      ticket,
      jobUrl: c?.jobId ? explorerJob(c.jobId) : null,
      verifyPath: c?.jobId ? `/verify/${c.jobId}` : null,
      delivered,
      trail,
      trailNote:
        trail.length > 0
          ? `Every transaction of the order, oldest first. The public RPC no longer serves their logs, so their hashes were read from the chain on ${HISTORY_READ_ON} and are kept with this site (config/history.ts); the order's state and money above are read live.`
          : null,
      proof,
      tips,
      mediaCid,
      picture:
        delivered && c?.jobId && template?.kind === "skill:create-image"
          ? {
              label:
                order && sameAddress(order.employer, deployments.contracts.doorbell.address ?? "")
                  ? "See the picture the Doorbell paid for"
                  : "See the picture this order paid for",
              url: explorerJob(c.jobId),
            }
          : null,
      commands: [
        {
          comment: "The order's state and money: (state, employer, escrow, spent, returned).",
          command: castView(desk.address, "WORK_ORDERS", workOrdersAbi, "accountOf", [String(id)]),
        },
        ...(delivered
          ? []
          : [
              {
                comment: "What a runner would be paid if it took the order in this block.",
                command: castView(desk.address, "WORK_ORDERS", workOrdersAbi, "priceNow", [String(id)]),
              },
            ]),
        {
          comment:
            "The 85-byte order header the swarm job's text must begin with, for the order's current claim (it reverts unless a runner holds the order or it was delivered).",
          command: `${castView(desk.address, "WORK_ORDERS", workOrdersAbi, "headerOf", [String(id)])} | xargs cast to-utf8`,
        },
        ...(c?.jobId
          ? [
              {
                comment:
                  "The receipt IdentityMD's WorkRegistry holds for the order's swarm job (zero means none).",
                command: castCall(MAINNET.WORK_REGISTRY, "WORK_REGISTRY", "latest(bytes16)(bytes32)", [
                  jobIdToBytes16(c.jobId),
                ]),
              },
            ]
          : []),
      ],
      // Nothing can be done to a delivered order: refund, cancel, timeout and challenge all revert.
      flows: delivered
        ? []
        : [
            previewFlow("order-refund", deployments, now, { id: String(id) }),
            previewFlow("order-cancel", deployments, now, { id: String(id) }),
            previewFlow("order-timeout", deployments, now, { id: String(id) }),
            previewFlow("order-challenge", deployments, now, { id: String(id) }),
          ],
      sources: [liveNote(`Order ${id}`, read), ...proofSources],
    };
  },
  meta: (m) => ({
    title: m.card ? `Order ${m.id}: ${m.card.stamp?.text ?? "OPEN"}` : `Order ${m.id}`,
    description: m.statusWords,
  }),
  markdown(m) {
    const o = m.order;
    return doc(
      o && m.card
        ? `**${m.card.headline} ${m.card.pay} ${m.card.employerWords}**${m.card.sample ? " (SAMPLE DATA)" : ""}`
        : m.launched
          ? `**Order ${m.id} could not be read just now.**`
          : `**Order ${m.id} does not exist yet.**`,
      m.statusWords,
      m.error ? `The desk could not be read just now: ${m.error}` : null,
      o
        ? doc(
            bullets(
              [
                `Stamp: ${m.card?.stamp?.text ?? "OPEN"}`,
                `Employer: ${inline(o.employer)} (${m.card?.origin ?? "OUTSIDE"})`,
                m.kind ? `Kind: ${inline(m.kind)}` : "",
                o.claim?.jobId
                  ? `Swarm job: ${link(o.claim.jobId, m.jobUrl)} · check it at ${link(m.verifyPath ?? "", m.verifyPath)}`
                  : "",
                o.claim?.recordHash ? `Record hash: ${inline(o.claim.recordHash)}` : "",
                m.ticket ? `Ticket of the current claim: ${inline(m.ticket)}` : "",
                o.terms ? `Job text hash: ${inline(o.terms.specHash)}` : "",
                o.terms
                  ? `Pays on: ${
                      o.terms.flags & 1
                        ? `a receipt, or a bonded claim nobody challenges within 24 hours (arbiter: ${o.terms.arbiter ?? "none, so only a receipt can decide a challenged claim"})`
                        : "an on-chain receipt only"
                    }`
                  : "",
                o.terms?.expiresAt && !m.delivered ? `Expires: ${formatUtc(o.terms.expiresAt * 1000)}` : "",
                o.terms ? `Delivery window: ${formatDuration(o.terms.deliverySecs * 1000)}` : "",
              ].filter(Boolean),
            ),
            o.spec
              ? `The job text, as the employer wrote it:\n\n${untrusted(o.spec, "the order's job text, written by its employer")}`
              : null,
            "## Timeline",
            table(
              ["Step", "Reached", "Detail"],
              m.timeline.map((s) => [s.label, s.at, s.detail]),
            ),
            "## Money",
            table(
              ["", "IMD"],
              m.money.map((row) => [row.label, row.imd]),
            ),
          ).trimEnd()
        : null,
      m.trail.length > 0
        ? doc(
            "## The transaction trail",
            m.trailNote,
            table(
              ["Step", "When (UTC)", "Transaction", "What it did"],
              m.trail.map((s) => [
                s.label,
                formatUtc(s.at),
                `${link(s.tx, s.txUrl)} (block ${s.block})`,
                s.what,
              ]),
            ),
          ).trimEnd()
        : null,
      m.proof ? orderProofMarkdown(m.proof) : null,
      m.tips.length > 0
        ? doc(
            "## The tip",
            bullets(
              m.tips.map(
                (tip) =>
                  `Agent ${tip.agentId} → ${tip.seat !== null ? `seat #${tip.seat}` : "no seat read"} → ${tip.owner ? `owner ${inline(tip.owner)}` : "owner unread"} (the seat Adapter's bindingOf, then the seat token's ownerOf, read for this page). ${tip.words}${tip.claimed ? ` ${link("The claim", tip.claimed.txUrl)}.` : ""}`,
              ),
            ),
          ).trimEnd()
        : null,
      m.picture || m.mediaCid
        ? doc(
            "## The work",
            m.picture
              ? `${m.picture.label}: ${link(m.picture.url, m.picture.url)} (IdentityMD's page of the job, which shows it; this site serves no copy).`
              : null,
            m.mediaCid
              ? `IdentityMD's API gives the job's media the IPFS CID ${inline(m.mediaCid)} (GET /jobs/${m.order?.claim?.jobId ?? "<job id>"}, media.cid).`
              : null,
          ).trimEnd()
        : null,
      "## Check it yourself",
      fence(m.commands.map((c) => `# ${c.comment}\n${c.command}`).join("\n\n"), "sh"),
      m.flows.length > 0 ? "## What anyone can do" : null,
      ...m.flows.map(flowMarkdown),
    );
  },
};

/** The proof block of a delivered order, as Markdown. */
function orderProofMarkdown(p: OrderProof): string {
  return doc(
    "## The proof",
    "Through the launched WorkProof, with no key and no account:",
    fence(p.commands.map((c) => `# ${c.comment}\n${c.command}`).join("\n\n"), "sh"),
    p.printed ? `It answers:\n\n${fence(p.printed)}` : null,
    p.words,
  ).trimEnd();
}

function houseLabelOf(address: string): string | null {
  return HOUSE_WALLETS.find((w) => w.address.toLowerCase() === address.toLowerCase())?.label ?? null;
}

// ---------------------------------------------------------------------------------------------
// /runners
// ---------------------------------------------------------------------------------------------

export interface RunnersModel {
  generatedAt: string;
  desk: ContractStatus;
  launched: boolean;
  /** Why runners exist: IdentityMD bills up front, and the desk pays later, on the receipt or on a bonded claim that stands. */
  why: string;
  /** Who runs runners, said from what is configured: nobody can run one before the desk exists. */
  whoRuns: string;
  /** How many orders the launched desk has opened; null when it is not launched or was not read. */
  count: number | null;
  /** What there is to take right now, in one sentence, from what was read. */
  openWords: string;
  open: OrderCard[];
  error: string | null;
  steps: string[];
  economics: string[];
  risks: string[];
  headerExample: { ticket: string; header: string; bytes: number };
  /** Whether IdentityMD's registry is writing receipts, by the six-hour test, in words. */
  receiptsNow: string;
  /** The steps a wallet can send from this page, in order. */
  flows: FlowPreview[];
  /** Being paid on a receipt: commands, because the record itself is the transaction's argument. */
  settleCommands: { comment: string; command: string }[];
  /** Who takes orders today, from the orders read. */
  whoTakes: string;
  /** What the team says of its own runner, and of its keeper, dated; null where the book's desk is not mainnet's. */
  runnerStatement: RunnerStatementView | null;
  whoFor: readonly string[];
  sources: SourceNote[];
}

const RUNNER_STEPS = [
  "Find an open order. Read its job text, its kind, its price now (priceNow) and how it pays. Ask IdentityMD's free check (POST /requests/check) whether the swarm would accept the job; it costs nothing. And before taking an order that pays only on a receipt, look at whether the registry is writing receipts at all: the test is printed below.",
  "Take the order: approve the bond and call claim(id). You now hold it alone for one hour, at the price of that moment. headerOf(id) returns the 85-byte order header your job must begin with.",
  "Buy the swarm job with your own wallet (0.5 IMD, an x402 payment), with the template for the order's kind and an objective that is exactly that 85-byte order header followed by the order's job text.",
  "Register the job within the hour: register(id, jobId), the job's UUID without its dashes.",
  "When the job has finished and its receipt is in the WorkRegistry, settle: fetch the work record under the hash the registry holds and submit it with settle(id, record, []). Anyone may send that. The desk checks the record against the receipt, the kind, your 85-byte order header and the job text, and pays you the price less the fee and the tip, with your bond.",
  "While receipts are late, and only on an order whose employer allowed it: claimDelivered(id, recordHash), with the hash IdentityMD's API lists for the job's record, at least 48 hours before the delivery deadline. After 24 hours without a challenge, finalize(id) pays you. When the receipt lands later, anyone can stamp(id, record, []) to mark the order proven; no money moves.",
  "If your job failed, reportFailed(id, record, []) with its receipt ends the claim and returns your bond; only you may report your own job's failure.",
];

const RUNNER_ECONOMICS = [
  "You receive 90% of the fixed price (the price less a 5% fee and a 5% tip) and your bond back.",
  "You pay the swarm 0.5 IMD and the gas. A settlement must be offered far more gas than it uses, because the desk refuses to start unless it can hand each of its two Payroll calls 1,000,000 gas: send 3,000,000 with settle and 2,000,000 with finalize; what is not used is returned.",
  "A settlement's cost follows the record's size: about 7 KB for a research report, and 72 to 255 KB measured for an audit. A node refuses a transaction above 128 KB, so a large record has to be stored on chain in data contracts first (200 gas a byte) and proven from those.",
  "The price of an open order rises with time until someone takes it, so the first runner to find it worth the trouble gets it.",
];

const RUNNER_RISKS = [
  "The swarm's 0.5 IMD is never refunded. If the job is refused or fails, you have paid it; if the receipt shows the swarm failed, your bond comes back, but the fee does not.",
  "Give an order back before registering a job and you lose a tenth of the bond. Let the hour pass, or let the delivery time pass with no receipt, and you lose all of it to the employer. On a receipt-only order you bear the lateness of receipts.",
  "A delivery claim that a receipt contradicts costs you the bond. A claim that is challenged and still undecided at the order's deadline is treated as if you had given the order back: the employer is refunded and you lose a tenth of the bond.",
  "While IdentityMD's receipts are late, a challenger can keep a true claim from being paid until the deadline at no cost to itself. Only a receipt, or the order's arbiter if it has one, ends a dispute in your favour.",
  "A receipt with the right job text under another kind can never settle the order: the kind is your risk. And settle on a job's first receipt when it exists; a later, superseding receipt names no agents, so its tip goes to the seat pool.",
  "The x402 payment needs an ordinary wallet's signature and IdentityMD's paid routes refuse browsers, so buying the job is done by the open-source runner in this repository (bots/runner), not from this page. The on-chain steps can be sent from here.",
  "One job pays for one order: the desk refuses to register a job whose receipt has already settled another.",
];

export const runnersPage: PageDef<RunnersModel> = {
  id: "runners",
  pattern: "/runners",
  async load({ sources, now }) {
    const { house, chain, deployments } = sources;
    const read = await house.orders(40);
    const desk = contractStatus(deployments, "workOrders");
    const houseAddresses = houseSet(deployments);
    const openOrders = read.live && read.data ? read.data.orders.filter((o) => o.state === "Open") : [];
    const opened = read.live && read.data ? read.data.count : null;
    const ticket = `0x${"ab".repeat(32)}` as const;
    const writer = await chain.receiptWriter();
    const claim = claimDefault(writer, PUBLIC_RPC);
    const exampleJob = "e9efec16-56f3-40d3-9243-52c453effc7d";
    const record = `"0x$(xxd -p record.json | tr -d '\\n')"`;
    return {
      generatedAt: now.toISOString(),
      desk,
      launched: read.live,
      why: WHY_RUNNERS,
      whoRuns: read.live
        ? "The team's own runner (bots/runner in the repository) signs with house wallet H1; what the team says of where and how it runs is below, beside what the desk shows. Anyone can run another, and none has any privilege."
        : "The team will run one from house wallet H1 once the desk is launched; anyone will be able to run another, and none will have any privilege.",
      count: opened,
      openWords: !read.live
        ? `**No orders to take.** The hire desk (WorkOrders, launch B) is ${NOT_LAUNCHED}.`
        : opened === null
          ? `The hire desk is at ${desk.label}, but its orders could not be read just now${read.error ? ` (${read.error})` : ""}, so nothing is said here about what is open.`
          : opened === 0
            ? `The hire desk is live at ${desk.label}. There is nothing to take yet: no order has been opened on it (its own counter, orderCount(), read 0 for this page).`
            : openOrders.length > 0
              ? `${plural(openOrders.length, "order is", "orders are")} open among the newest ${read.data?.orders.length ?? 0} of the ${opened} opened on the hire desk at ${desk.label}.`
              : `No order is open right now among the newest ${read.data?.orders.length ?? 0} of the ${opened} opened on the hire desk at ${desk.label}.`,
      open: await Promise.all(
        openOrders.map(async (o) =>
          orderCard(
            o,
            o.sample ? true : await chain.isContract(o.employer).catch(() => null),
            houseAddresses,
          ),
        ),
      ),
      error: read.live ? read.error : null,
      steps: RUNNER_STEPS,
      economics: RUNNER_ECONOMICS,
      risks: RUNNER_RISKS,
      headerExample: { ticket, header: orderHeader(ticket), bytes: orderHeader(ticket).length },
      receiptsNow:
        writer.stalled === true
          ? `Receipts are stalled: the WorkRegistry recorded none in the last six hours of blocks (${writer.fromBlock} to ${writer.toBlock}). A receipt-only order taken now may not be paid before its deadline.`
          : writer.stalled === false
            ? `Receipts are arriving: the WorkRegistry recorded ${writer.events} in the last six hours of blocks (${writer.fromBlock} to ${writer.toBlock}).`
            : `Whether receipts are arriving could not be read just now${writer.error ? ` (${writer.error})` : ""}; run the command.`,
      flows: [
        previewFlow("runner-claim", deployments, now, {}, { id: "1" }),
        previewFlow("runner-register", deployments, now, {}, { id: "1", jobId: exampleJob }),
        previewFlow(
          "runner-claim-delivered",
          deployments,
          now,
          {},
          { id: "1", recordHash: `0x${"cd".repeat(32)}` },
        ),
        previewFlow("runner-finalize", deployments, now, {}, { id: "1" }),
        previewFlow("runner-release", deployments, now, {}, { id: "1" }),
      ],
      settleCommands: [
        {
          comment: "Is the registry writing receipts? The count for the last six hours of blocks.",
          command: claim.command,
        },
        {
          comment:
            "The receipt the registry holds for your job (zero means none yet). The job id is the UUID without its dashes.",
          command: `HASH=$(${castCall(MAINNET.WORK_REGISTRY, "WORK_REGISTRY", "latest(bytes16)(bytes32)", ["0x<job id, 32 hex>"])})`,
        },
        {
          comment: "The work record under that hash, exactly as IdentityMD serves it.",
          command: `curl -s ${IMD_LINK.workRecord("${HASH#0x}")} -o record.json`,
        },
        {
          comment: "Settle. Anyone may send it; the gas limit matters, and what is not used is returned.",
          command: castWrite(
            desk.address,
            "WORK_ORDERS",
            workOrdersAbi,
            "settle",
            ["<order id>", record, '"[]"'],
            ` --gas-limit ${GAS_LIMIT.SETTLE}`,
          ),
        },
        {
          comment:
            "For an order already paid on a claim: mark it proven once its receipt exists. No money moves.",
          command: castWrite(desk.address, "WORK_ORDERS", workOrdersAbi, "stamp", [
            "<order id>",
            record,
            '"[]"',
          ]),
        },
        {
          comment:
            "If the receipt shows your job failed: end the claim and take your bond back (its runner only).",
          command: castWrite(desk.address, "WORK_ORDERS", workOrdersAbi, "reportFailed", [
            "<order id>",
            record,
            '"[]"',
          ]),
        },
      ],
      whoTakes: whoTakesOrders(read, houseAddresses),
      runnerStatement: runnerStatement(desk.address, true),
      whoFor: RUNNING_IS_FOR,
      sources: [liveNote("Open orders", read)],
    };
  },
  meta: () => ({
    title: "Runners",
    description:
      "A runner takes an order from the hire desk, buys the swarm job with its own wallet, and is paid when the work is proven or, on an order that opts in, when its bonded claim stands. Anyone can be one.",
  }),
  markdown(m) {
    return doc(
      `${m.why} ${m.whoRuns}`,
      m.openWords,
      "## Who takes orders today",
      ...whoTakesMarkdown(m.whoTakes, m.runnerStatement),
      "## Who this is for",
      bullets([...m.whoFor]),
      m.open.length > 0
        ? table(
            ["Order", "Card", "Employer", "Origin"],
            m.open.map((c) => [link(`#${c.id}`, c.path), `${c.headline} ${c.pay}`, c.employer, c.origin]),
          )
        : null,
      "## What a runner does",
      numbered(m.steps),
      "## What it earns",
      bullets(m.economics),
      "## What it risks",
      bullets(m.risks),
      "## The 85-byte order header",
      `For ticket ${inline(m.headerExample.ticket)} the job's objective must begin with these ${m.headerExample.bytes} bytes (the last one is a space), then the order's job text:`,
      fence(m.headerExample.header),
      "ticket = keccak256(abi.encode(chainId, workOrders, orderId, claimSeq, runner)), where claimSeq counts claims of that order from 1.",
      "## The on-chain steps",
      m.receiptsNow,
      ...m.flows.map(flowMarkdown),
      "### Being paid on a receipt",
      "The record itself is the transaction's argument, so these are commands for a terminal; the runner bot sends the same call.",
      fence(m.settleCommands.map((c) => `# ${c.comment}\n${c.command}`).join("\n\n"), "sh"),
    );
  },
};
