/**
 * The pages about where money pools and where it goes: "/pots", "/pots/:id", "/company", "/seats",
 * "/seats/:tokenId", "/endowments", "/rules/new".
 *
 * Each page follows the deployments book. What needs no contract of ours (seat owners, agent
 * bindings, sIMD's holdings) is always read live. A page whose contract has no address says "not
 * launched yet" and shows the transactions it will take; once the address is in the book, the page
 * reads its contract with the ABI the compiler wrote for it, and when that read fails it says the
 * contract could not be read, never that it is not launched.
 */
import {
  crowdPotsAbi,
  endowmentsAbi,
  HOUSE_FEED_NAMES,
  HOUSE_FEEDS,
  houseFeedById,
  MAINNET,
  payrollAbi,
  rulesAbi,
} from "@help-wanted/shared";
import { NOT_LAUNCHED } from "~/config/deployments";
import { REFERENCE_JOB, etherscanAddress } from "~/config/chain";
import type { AgentBinding, StakingFacts } from "~/data/chain";
import { houseSet } from "~/config/house";
import type {
  DoorbellRingers,
  DoorbellState,
  EndowmentRead,
  PayrollLedger,
  Pot,
  RuleRead,
} from "~/data/house";
import { messageOf } from "~/lib/cache";
import { COMPARISONS, ENDOWMENT, PAYROLL_SPLIT, RULE } from "~/lib/contracts";
import { formatDuration, formatImd, formatInt, formatUnits, formatUtc, plural } from "~/lib/format";
import { parseIndex } from "~/lib/ids";
import { bullets, doc, fence, inline, link, numbered, quote, table } from "~/lib/md";
import { potCard, templateForKindHash, type PotCard } from "./cards";
import { castView, contractStatus, liveNote, notLiveNotes, PUBLIC_RPC, type ContractStatus } from "./common";
import { flowMarkdown, previewFlow, type FlowPreview } from "./flowPreview";
import { sourceNote, type PageDef, type SourceNote } from "./types";

// ---------------------------------------------------------------------------------------------
// /pots and /pots/:id
// ---------------------------------------------------------------------------------------------

export interface PotsModel {
  generatedAt: string;
  pots: ContractStatus;
  zap: ContractStatus;
  launched: boolean;
  count: number | null;
  cards: PotCard[];
  error: string | null;
  how: string[];
  check: string[];
  /** Chipping in, and claiming a refund. */
  flows: FlowPreview[];
  /** Opening a pot, with its job kind in text. */
  openFlow: FlowPreview;
  /** Where the example in that form comes from, and why it allows a bonded claim. */
  openNote: string;
  /** Chipping in with ETH through Zap, with a minimum and a deadline. */
  zapFlow: FlowPreview;
  sources: SourceNote[];
}

const HOW_A_POT_WORKS = [
  "Someone opens a pot: a job text, the job's kind written out in text, a target in IMD, and how long it collects. The terms are fixed from that moment.",
  "Anyone chips in. A chip is cut to what the pot still needs, so a pot never holds more than its target.",
  "When the pot is full, anyone launches it: the pot becomes the employer of one order on the hire desk, with the target as the most it will pay.",
  "If the work is delivered, the pot keeps what the job cost and shares anything left back in proportion to each chip.",
  "If the pot never fills, or its order ends without a delivery, every chip is refundable in proportion, together with any runner bond the order collected.",
];

const BEFORE_YOU_CHIP = [
  "The job text itself. A pot's page prints it when it can be read from the chain and checked against the pot's hash; when it cannot, the page says so, and you should not chip in to a text you have not read.",
  "The job's kind, which the pot names in text. Nothing on chain can tell whether the swarm writes that kind for the job described: a pot whose kind no work record carries can never be paid on a receipt.",
  "Whether the pot allows a bonded delivery claim or pays only on an on-chain receipt. A pot that allows claims accepts that a claim which is untrue is paid if nobody challenges it within 24 hours, and that a challenge nothing decides refunds the pot even when the claim was true. A pot cannot name an arbiter.",
  "The size of the runner's bond next to the target, and that a chip is locked while the pot runs: there is no withdrawal until its order has ended.",
];

/**
 * The first pot launch B's launch document proposes (`launches/b-desk/docs/LAUNCH.md`, section 7,
 * step 5: the blocks marked `firstPot:terms` and `firstPot:spec`). `test/proofs.test.ts` holds
 * these values against that document. It allows the claimed path because IdentityMD's receipts
 * were stalled when the document was written; the page says so beside the form.
 */
export const OPEN_POT_EXAMPLE = {
  template: "research",
  spec: "Write a two-page plain-language report on who paid the IdentityMD swarm in the last seven days and for what, from on-chain IMD transfers to the fee payee only, with every figure sourced to a transaction.",
  target: "2",
  minPay: "1",
  rampHours: "24",
  bond: "0.5",
  fundDays: "3",
  hireDays: "7",
  deliveryDays: "7",
  allowClaimed: "true",
  firstChip: "0",
};

/** What the page says of that example, in the Markdown twin and beside the form. */
export const OPEN_POT_EXAMPLE_NOTE =
  "The example is the first pot proposed in launch B's launch document: a research report, a target of 2 IMD, an order priced from 1 IMD and rising to the target over a day, a runner's bond of 0.5 IMD. It allows a bonded delivery claim, because IdentityMD's receipts were stalled when that document was written and a receipt-only pot could not have been paid; the document says to open pots without it once receipts are arriving.";

export const potsPage: PageDef<PotsModel> = {
  id: "pots",
  pattern: "/pots",
  async load({ sources, now }) {
    const { house, deployments } = sources;
    const read = await house.pots(40);
    const pots = contractStatus(deployments, "crowdPots");
    const zap = contractStatus(deployments, "zap");
    return {
      generatedAt: now.toISOString(),
      pots,
      zap,
      launched: read.live,
      count: read.live && read.data ? read.data.count : null,
      cards: read.live && read.data ? read.data.pots.map((p) => potCard(p, now)) : [],
      error: read.live ? read.error : null,
      how: HOW_A_POT_WORKS,
      check: BEFORE_YOU_CHIP,
      flows: [
        previewFlow("chip-in", deployments, now, {}, { potId: "1", amount: "0.5" }),
        previewFlow(
          "claim-refund",
          deployments,
          now,
          {},
          { potId: "1", contributor: "0x0000000000000000000000000000000000000001" },
        ),
      ],
      openFlow: previewFlow("open-pot", deployments, now, {}, OPEN_POT_EXAMPLE),
      openNote: OPEN_POT_EXAMPLE_NOTE,
      zapFlow: previewFlow("zap-chip-in", deployments, now, {}, { potId: "1", eth: "0.01", minImdOut: "8" }),
      sources: [liveNote("Pots", read)],
    };
  },
  meta: (m) => ({
    title: "Crowd pots",
    description: m.launched
      ? `${m.count === null ? "How many pots have been opened could not be read just now." : m.count === 0 ? "CrowdPots is live and no pot has been opened yet." : `${plural(m.count, "pot has", "pots have")} been opened.`} Chip in to commission swarm work; refundable if it is not delivered.`
      : `Chip in to commission swarm work, refundable if it is not delivered. CrowdPots is ${NOT_LAUNCHED}.`,
  }),
  markdown(m) {
    return doc(
      "A crowd pot lets many wallets commission one swarm job together. Nobody runs it: the opener gets no rights over it, and the rules are the contract's.",
      m.launched
        ? m.cards.length > 0
          ? table(
              ["Pot", "Card", "Progress", "Pays on", "Status"],
              m.cards.map((c) => [
                link(`#${c.id}`, c.path),
                `${c.headline}${c.sample ? " (SAMPLE)" : ""}`,
                c.progress,
                c.paysOn ?? "could not be read",
                c.stageWords,
              ]),
            )
          : m.count === null
            ? `CrowdPots is at ${m.pots.label}. How many pots have been opened on it could not be read just now, so nothing is said here about pots.`
            : m.count === 0
              ? `CrowdPots is live at ${m.pots.label}. No pot has been opened on it yet: its own counter, potCount(), read 0 for this page.`
              : `CrowdPots is at ${m.pots.label}. ${plural(m.count, "pot has", "pots have")} been opened on it; none of the newest could be read as a pot just now.`
        : `**No pots.** CrowdPots (launch B) is ${NOT_LAUNCHED}.`,
      m.error ? `CrowdPots could not be read just now: ${m.error}` : null,
      "## How a pot works",
      numbered(m.how),
      "## What to look at before chipping in",
      "The contract cannot check these for you:",
      bullets(m.check),
      "## The transactions",
      ...m.flows.map(flowMarkdown),
      "## Open a pot",
      `A pot names its job kind in text, as the first member of its terms. ${m.openNote}`,
      flowMarkdown(m.openFlow),
      "## Chip in with ETH",
      `Zap (launch C) is ${m.zap.label}. It swaps ETH for IMD on the Uniswap v4 ETH/IMD pool and chips into the pot in your name. Its three entry points each take the least IMD you accept and a deadline; the form sets the deadline a few minutes ahead and shows it.`,
      flowMarkdown(m.zapFlow),
    );
  },
};

export interface PotModel {
  generatedAt: string;
  id: number;
  pots: ContractStatus;
  launched: boolean;
  pot: Pot | null;
  card: PotCard | null;
  /** The pot's job kind in text, as its opener wrote it. Null when it could not be read. */
  kind: string | null;
  /** Whether this site knows a job template of that kind, in words. */
  kindNote: string | null;
  error: string | null;
  facts: { label: string; value: string }[];
  /**
   * The job the pot will order, in the opener's own words, when it could be read from the chain and
   * hashes to the pot's `specHash`. Third-party text.
   */
  spec: string | null;
  /** Said beside the chip-in form when the text cannot be shown. Null when it is shown, or there is no pot. */
  specMissing: string | null;
  flows: FlowPreview[];
  commands: { comment: string; command: string }[];
  sources: SourceNote[];
}

export const potPage: PageDef<PotModel> = {
  id: "pot",
  pattern: "/pots/:id",
  async load({ sources, now }, params) {
    const id = parseIndex(params.id);
    if (id === null || id < 1) return null;
    const { house, deployments } = sources;
    const read = await house.pot(id);
    if (read.live && read.data === null && !read.error) return null;
    const pot = read.live ? read.data : null;
    const pots = contractStatus(deployments, "crowdPots");
    const known = templateForKindHash(pot?.kindHash);
    const kind = pot?.kind ?? known?.kind ?? null;
    const facts: PotModel["facts"] = [];
    if (pot) {
      facts.push({ label: "Stage", value: pot.stage });
      facts.push({
        label: "Job kind",
        value: kind ?? "could not be read; do not chip in to a kind you have not read",
      });
      if (pot.targetWei !== null) facts.push({ label: "Target", value: `${formatImd(pot.targetWei)} IMD` });
      if (pot.raisedWei !== null) facts.push({ label: "Raised", value: `${formatImd(pot.raisedWei)} IMD` });
      facts.push({ label: "Still needed", value: `${formatImd(pot.remainingWei)} IMD` });
      if (pot.deadline) facts.push({ label: "Collects until", value: formatUtc(pot.deadline * 1000) });
      if (pot.minPayWei !== null)
        facts.push({ label: "Order's opening price", value: `${formatImd(pot.minPayWei)} IMD` });
      if (pot.bondWei !== null)
        facts.push({ label: "Runner's bond", value: `${formatImd(pot.bondWei)} IMD` });
      if (pot.hireSecs !== null)
        facts.push({ label: "Waits for a runner for", value: formatDuration(pot.hireSecs * 1000) });
      if (pot.deliverySecs !== null)
        facts.push({ label: "Delivery time", value: formatDuration(pot.deliverySecs * 1000) });
      if (pot.opener) facts.push({ label: "Opened by", value: pot.opener });
      if (pot.allowClaimed !== null) {
        facts.push({
          label: "Pays on",
          value: pot.allowClaimed
            ? "a receipt, or a bonded delivery claim nobody challenges within 24 hours (an untrue claim that goes unchallenged is paid; a pot has no arbiter)"
            : "an on-chain receipt only",
        });
      } else {
        facts.push({ label: "Pays on", value: "could not be read; do not assume a receipt is required" });
      }
      if (pot.orderId !== null) facts.push({ label: "Order on the hire desk", value: `#${pot.orderId}` });
      if (pot.seriesId) facts.push({ label: "A round of series", value: `#${pot.seriesId}` });
      if (pot.specHash) facts.push({ label: "Job text hash", value: pot.specHash });
    }
    return {
      generatedAt: now.toISOString(),
      id,
      pots,
      launched: read.live,
      pot,
      card: pot ? potCard(pot, now) : null,
      kind,
      kindNote: !pot
        ? null
        : known
          ? `A kind the open-source runner knows how to open (${known.title.toLowerCase()}).`
          : kind
            ? "Not one of the kinds the open-source runner opens. Nothing on chain says the swarm writes this kind: check it against IdentityMD's job templates before you chip in."
            : null,
      error: read.live ? read.error : null,
      facts,
      spec: pot?.spec ?? null,
      specMissing:
        pot && !pot.spec
          ? "The job text of this pot could not be read from the chain just now: its SpecPinned log is older than the public RPC serves, or the RPC did not answer. Only its hash is shown. Read the text (the command below finds it on an archive RPC) before you chip in."
          : null,
      flows: [
        previewFlow("chip-in", deployments, now, { potId: String(id) }, { amount: "0.5" }),
        previewFlow("zap-chip-in", deployments, now, { potId: String(id) }, { eth: "0.01", minImdOut: "8" }),
      ],
      commands: [
        {
          comment: "What the pot still needs.",
          command: castView(pots.address, "CROWD_POTS", crowdPotsAbi, "remaining", [String(id)]),
        },
        {
          comment: "The pot's terms as stored, and the text behind its kind hash.",
          command: `${castView(pots.address, "CROWD_POTS", crowdPotsAbi, "potOf", [String(id)])}\n${castView(pots.address, "CROWD_POTS", crowdPotsAbi, "kindOf", [pot?.kindHash ?? "<kindHash>"])}`,
        },
        {
          comment:
            "The pot's job text: the SpecPinned log whose first topic after the signature is the pot's job text hash (needs an RPC that serves the block it was pinned in).",
          command: `cast logs --address ${pots.address ?? "$CROWD_POTS"} "SpecPinned(bytes32 indexed,bytes)" ${pot?.specHash ?? "<specHash>"} --from-block <block the pot opened in> --rpc-url <an archive RPC>`,
        },
      ],
      sources: [liveNote(`Pot ${id}`, read)],
    };
  },
  meta: (m) => ({
    title: `Pot ${m.id}`,
    description: m.card
      ? `${m.card.headline} ${m.card.progress}`
      : m.launched
        ? `Pot ${m.id} could not be read from CrowdPots just now.`
        : `CrowdPots is ${NOT_LAUNCHED}; pot ${m.id} does not exist.`,
  }),
  markdown(m) {
    return doc(
      m.card
        ? `**${m.card.headline}** ${m.card.progress}${m.card.sample ? " (SAMPLE DATA)" : ""}`
        : m.launched
          ? `**Pot ${m.id} could not be read just now.** CrowdPots is at ${m.pots.label}.`
          : `**Pot ${m.id} does not exist yet.** CrowdPots is ${m.pots.label}.`,
      m.error ? `CrowdPots could not be read just now: ${m.error}` : null,
      m.spec
        ? `The job this pot will order, in its opener's words (it hashes to the pot's job text hash):\n\n${quote(m.spec)}`
        : m.specMissing,
      m.kindNote,
      m.facts.length > 0
        ? table(
            ["", ""],
            m.facts.map((f) => [f.label, f.value]),
          )
        : null,
      fence(m.commands.map((c) => `# ${c.comment}\n${c.command}`).join("\n\n"), "sh"),
      ...m.flows.map(flowMarkdown),
    );
  },
};

// ---------------------------------------------------------------------------------------------
// /company
// ---------------------------------------------------------------------------------------------

export interface LedgerSection {
  title: string;
  /** One sentence on what the section shows. */
  note: string;
  rows: { label: string; imd: string; note: string }[];
}

export interface CompanyModel {
  generatedAt: string;
  payroll: ContractStatus;
  launched: boolean;
  ledger: PayrollLedger | null;
  error: string | null;
  split: { to: string; share: string; how: string }[];
  /** The split as the launched contract states it, in words. Null before launch. */
  splitRead: string | null;
  staking: StakingFacts | null;
  stakingError: string | null;
  /** The ledger, section by section: what came in, the stakers' stream, the seat pool, tips, the feed budget. */
  sections: LedgerSection[];
  limits: string[];
  /** One sentence for each launch this page leans on that is not live. Empty once all are. */
  notLive: string[];
  /** Said when Payroll is launched and has booked nothing yet. Null otherwise. */
  nothingYet: string | null;
  flows: FlowPreview[];
  commands: { comment: string; command: string }[];
  sources: SourceNote[];
}

const SPLIT = [
  {
    to: "sIMD stakers",
    share: `${PAYROLL_SPLIT.stakersBps / 100}%`,
    how: `A stream that vests over about ${PAYROLL_SPLIT.streamDays} days. Anyone calls drip(); it sends what is due by a plain IMD transfer to sIMD, at most once every ten minutes and at most one hour of stream a call. Whoever holds sIMD at that moment shares it.`,
  },
  {
    to: "Seat owners",
    share: `${PAYROLL_SPLIT.seatsBps / 100}%`,
    how: "A pool shared equally by all 2,000 seats. claimSeat(tokenId) pays the seat's share to whoever owns the seat at that moment: anyone may send it for a seat held by an ordinary wallet, and a seat held by a contract must be claimed by that contract.",
  },
  {
    to: "The house feeds",
    share: `${PAYROLL_SPLIT.feedsBps / 100}%`,
    how: "A budget that keeps a position of Payroll's own on each of the three house feeds' meters: 14 requests for each daily feed, 4 for the weekly one. Anyone calls fundFeeds(). Budget no meter needed within 14 to 28 days joins the stakers' stream instead.",
  },
];

const COMPANY_LIMITS = [
  "A visitor to sIMD takes a staker's share of every drip it attends: the stream is paid by plain transfer, and sIMD shares what it receives among whoever holds its shares at that moment. sIMD does not let a holder leave in the block it staked in, so a visit takes IMD of the visitor's own, held from one block into the next. This was a finding of IdentityMD's second audit; it is acknowledged and left open.",
  "A booking can delay money that was already vesting, by at most seven days less the time it had left: new money and what is still vesting become one stream. Stakers are paid in full; when is what a booking can move.",
  "Unclaimed seat revenue follows the seat: a claim pays whoever owns the seat when it is made, including what accrued before a transfer. Anyone may send the claim for a seat held by an ordinary wallet. A seat held by a contract must be claimed by that contract itself (anyone else's call reverts ContractOwnerMustClaim), so nobody can push IMD into an escrow that did not ask for it; an account that has delegated to code (EIP-7702) counts as a contract here.",
  "Payroll never takes IMD back from a meter. What it places on a house feed's meter is spent by that feed or stays there.",
];

/** The ledger's parts, as the page lists them before there is anything to read. */
const LEDGER_OUTLINE: readonly { title: string; note: string }[] = [
  {
    title: "What came in",
    note: "Fees paid in with pay(), and plain transfers booked with book(). Tips arrive separately and are not split.",
  },
  {
    title: "The stream to stakers",
    note: "Half of every booking, and feed budget no meter needed in time.",
  },
  {
    title: "The seat pool",
    note: "30% of every booking, shared equally by the 2,000 seats, plus tips that found no agent.",
  },
  {
    title: "Tips",
    note: "5% of each settled order's price, for the agents the job's work record names. Not split.",
  },
  {
    title: "The feed budget",
    note: "20% of every booking, for the meters of the three house feeds.",
  },
];

function companySections(l: PayrollLedger): LedgerSection[] {
  const imd = (wei: bigint) => formatImd(wei);
  const sections: LedgerSection[] = [
    {
      title: "What came in",
      note: "Fees paid in with pay(), and plain transfers booked with book(). Tips arrive separately and are not split.",
      rows: [
        {
          label: "Received and split, all time",
          imd: imd(l.receivedWei),
          note: "Every booking, by either road.",
        },
        ...(l.unbookedWei !== null
          ? [
              {
                label: "Arrived but not yet split",
                imd: imd(l.unbookedWei),
                note: "IMD that reached Payroll by plain transfer: what book() would split now.",
              },
            ]
          : []),
        ...(l.owed
          ? [
              {
                label: "Held now for everyone it is owed to",
                imd: imd(l.owed.totalWei),
                note: "Stakers, seats, tips and feeds together. The IMD balance always covers it.",
              },
            ]
          : []),
      ],
    },
    {
      title: "The stream to stakers",
      note: "Half of every booking, and feed budget no meter needed in time.",
      rows: [
        {
          label: "Booked for sIMD stakers",
          imd: imd(l.toStakersWei),
          note: "Half of everything received, with every rounding remainder, plus released feed budget.",
        },
        { label: "Sent to sIMD so far", imd: imd(l.drippedWei), note: "By drip(), as plain transfers." },
        ...(l.stream
          ? [
              {
                label: "Still to be sent",
                imd: imd(l.stream.outstandingWei),
                note: `Of which ${imd(l.stream.unvestedWei)} IMD has not vested yet${l.stream.endsAt > 0 ? `; the last of it vests ${formatUtc(l.stream.endsAt * 1000)}` : ""}.`,
              },
              {
                label: "Due to sIMD right now",
                imd: imd(l.stream.dueNowWei),
                note: `What drip() would send in this block (at most ${imd(l.stream.perDripWei)} IMD a drip). Zero inside the ten-minute gap and while sIMD has no stakers.`,
              },
            ]
          : []),
      ],
    },
    {
      title: "The seat pool",
      note: "30% of every booking, shared equally by the 2,000 seats, plus tips that found no agent.",
      rows: [
        { label: "Booked for seat owners", imd: imd(l.toSeatsWei), note: "30% of everything received." },
        {
          label: "Tips that fell to the seat pool",
          imd: imd(l.tipsToSeatsWei),
          note: "A tip with no agent named, the remainder of an equal split, or a tip swept after its wait.",
        },
        { label: "Claimed by seat owners", imd: imd(l.seatClaimedWei), note: "Through claimSeat()." },
        ...(l.owed
          ? [{ label: "Unclaimed in the pool", imd: imd(l.owed.seatsWei), note: "Waiting for claimSeat()." }]
          : []),
      ],
    },
    {
      title: "Tips",
      note: "5% of each settled order's price, for the agents the job's work record names. Not split.",
      rows: [
        {
          label: "Tips received for agents",
          imd: imd(l.tipsInWei),
          note: "Sent by the hire desk at settlement.",
        },
        {
          label: "Tips claimed",
          imd: imd(l.tipsClaimedWei),
          note: "Through claimTip(), to the owner of the seat the agent is bound to.",
        },
        ...(l.owed
          ? [{ label: "Tips waiting", imd: imd(l.owed.tipsWei), note: "Waiting for claimTip()." }]
          : []),
      ],
    },
    {
      title: "The feed budget",
      note: "20% of every booking, for the meters of the three house feeds.",
      rows: [
        { label: "Placed on feed meters so far", imd: imd(l.feedsFundedWei), note: "By fundFeeds()." },
        {
          label: "Released to the stakers' stream",
          imd: imd(l.feedsReleasedWei),
          note: "Budget no meter needed within 14 to 28 days.",
        },
        ...(l.feedBudget
          ? [
              {
                label: "Budget on hand",
                imd: imd(l.feedBudget.totalWei),
                note: `Not yet placed or released. ${imd(l.feedBudget.releasableNowWei)} IMD of it has waited out its time and would be released by the next fundFeeds() if no meter needs it; ${imd(l.feedBudget.oldWei)} IMD falls due ${formatUtc(l.feedBudget.nextReleaseAt * 1000)}.`,
              },
            ]
          : []),
        ...(l.feedShortfallsWei
          ? HOUSE_FEED_NAMES.map((name, index) => ({
              label: `How far the ${name} meter is below Payroll's runway`,
              imd: imd(l.feedShortfallsWei?.[index] ?? 0n),
              note: `Payroll's own position on the meter against its runway of ${HOUSE_FEEDS[name].runwayRequests} requests: what fundFeeds() would offer this meter with budget to spare.${
                l.feedBudget && l.feedBudget.totalWei === 0n && (l.feedShortfallsWei?.[index] ?? 0n) > 0n
                  ? " The budget on hand is 0 IMD, so nothing can be placed now."
                  : ""
              }`,
            }))
          : []),
      ],
    },
  ];
  return sections;
}

export const companyPage: PageDef<CompanyModel> = {
  id: "company",
  pattern: "/company",
  async load({ sources, now }) {
    const { house, chain, deployments } = sources;
    const [read, staking] = await Promise.all([
      house.ledger(),
      chain.staking().then(
        (value) => ({ value, error: null as string | null }),
        (error: unknown) => ({ value: null, error: messageOf(error) }),
      ),
    ]);
    const payroll = contractStatus(deployments, "payroll");
    const l = read.live ? read.data : null;
    const c = l?.constants ?? null;
    return {
      generatedAt: now.toISOString(),
      payroll,
      launched: read.live,
      ledger: l,
      error: read.live ? read.error : null,
      split: SPLIT,
      splitRead: c
        ? `As read from the contract: SEAT_BPS is ${formatInt(c.seatBps)}, FEED_BPS is ${formatInt(c.feedBps)} (of 10,000; stakers take the rest), and STREAM_DURATION is ${formatDuration(c.streamSecs * 1000)}.`
        : null,
      staking: staking.value?.value ?? null,
      stakingError: staking.error,
      sections: l ? companySections(l) : LEDGER_OUTLINE.map((s) => ({ ...s, rows: [] })),
      limits: COMPANY_LIMITS,
      notLive: notLiveNotes(deployments, {
        B: "Fees and tips reach Payroll from orders settled on the hire desk, so no fee has been earned from an order and no agent has been tipped.",
        C: "Nothing reaches Payroll or a feed's meter through a rule or an endowment.",
      }),
      nothingYet:
        l && l.receivedWei === 0n && l.tipsInWei === 0n
          ? "Payroll has booked nothing yet: no fee and no tip has reached it, so nothing has been split, streamed or claimed. Every figure below is read from the contract and is zero for that reason."
          : null,
      flows: [
        previewFlow("drip", deployments, now),
        previewFlow("book", deployments, now),
        previewFlow("fund-feeds", deployments, now),
      ],
      commands: [
        {
          comment:
            "Every running total of the ledger at once: received, toStakers, toSeats, toFeeds, dripped, seatClaimed, tipsIn, tipsClaimed, feedsFunded, tipsToSeats, feedsReleased.",
          command: castView(payroll.address, "PAYROLL", payrollAbi, "ledger"),
        },
        {
          comment: "What the contract still holds for each party: stakers, seats, tips, feeds, total.",
          command: castView(payroll.address, "PAYROLL", payrollAbi, "owed"),
        },
        {
          comment: "The stakers' stream: outstanding, unvested, endsAt, perDrip, nextDripAt, dueNow.",
          command: castView(payroll.address, "PAYROLL", payrollAbi, "stream"),
        },
        {
          comment: "What sIMD holds: its assets are its IMD balance, so a plain transfer pays every staker.",
          command: `cast call ${MAINNET.SIMD} "totalAssets()(uint256)" --rpc-url ${PUBLIC_RPC}`,
        },
      ],
      sources: [
        liveNote("Payroll ledger", read),
        sourceNote(
          "sIMD",
          `eth_call to ${MAINNET.SIMD} through ${chain.rpcHost}`,
          staking.value,
          staking.error,
        ),
      ],
    };
  },
  meta: () => ({
    title: "The company ledger",
    description:
      "A company with no staff and no owner. Every fee HELP WANTED earns is split by fixed code: 50% to sIMD stakers, 30% to seat owners, 20% to the feeds.",
  }),
  markdown(m) {
    return doc(
      "HELP WANTED has no owner, no treasury key and no token. Every fee it earns arrives at one contract, Payroll, and leaves by fixed shares. This page is its public ledger.",
      m.launched
        ? `Payroll is at ${link(m.payroll.label, m.payroll.url)}.`
        : `**The ledger is empty: Payroll (launch A) is ${NOT_LAUNCHED}.** No fee has been earned or split. The shares below are fixed in the contract's code.`,
      m.error ? `Payroll could not be read just now: ${m.error}` : null,
      m.nothingYet,
      m.notLive.length > 0 ? doc("## What is not live", bullets(m.notLive)).trimEnd() : null,
      "## The split",
      table(
        ["To", "Share", "How it gets there"],
        m.split.map((s) => [s.to, s.share, s.how]),
      ),
      m.splitRead,
      "Tips are separate and are not split: 5% of each settled order's price goes to the agents named in the job's work record, and through them to the owners of their seats.",
      ...m.sections.map((section) =>
        doc(
          `## ${section.title}`,
          section.note,
          section.rows.length > 0
            ? table(
                ["", "IMD", "Note"],
                section.rows.map((r) => [r.label, r.imd, r.note]),
              )
            : m.launched
              ? "Nothing to show: Payroll could not be read just now."
              : `Nothing to show: Payroll is ${NOT_LAUNCHED}, so no figure exists.`,
        ).trimEnd(),
      ),
      "## Where the stakers' half goes",
      m.staking
        ? `sIMD holds ${formatImd(m.staking.totalAssetsWei)} IMD today. Its assets are simply its IMD balance, so a plain transfer raises the value of every share at once. One whole sIMD share converts to ${formatUnits(m.staking.assetsPerShareWei, 18)} IMD.`
        : `sIMD could not be read just now: ${m.stakingError ?? "unknown error"}.`,
      "## What to know before relying on it",
      bullets(m.limits),
      "## Check it yourself",
      fence(m.commands.map((c) => `# ${c.comment}\n${c.command}`).join("\n\n"), "sh"),
      "## What anyone can do",
      ...m.flows.map(flowMarkdown),
    );
  },
};

// ---------------------------------------------------------------------------------------------
// /seats and /seats/:tokenId
// ---------------------------------------------------------------------------------------------

export interface SeatsModel {
  generatedAt: string;
  payroll: ContractStatus;
  seats: string;
  seatsUrl: string;
  adapter: string;
  adapterUrl: string;
  seatCount: number;
  /** True once Payroll has an address in the deployments book. */
  launched: boolean;
  /** Why the seat pool is not shown although Payroll is launched: the read failed. Null otherwise. */
  poolError: string | null;
  /** The seat pool as Payroll's ledger has it; null until Payroll is launched and read. */
  pool: {
    bookedImd: string;
    claimedImd: string;
    unclaimedImd: string | null;
    tipsWaitingImd: string | null;
  } | null;
  /** Set when `?agent=` named an agent: its binding, read live. */
  agent: (AgentBinding & { tipOwedImd: string | null }) | null;
  rejected: string | null;
  how: string[];
  /** One sentence for each launch this page leans on that is not live. Empty once all are. */
  notLive: string[];
  example: { seat: number; agent: string; job: string };
  flows: FlowPreview[];
  sources: SourceNote[];
}

const HOW_SEATS_ARE_PAID = [
  "The seat pool. 30% of every fee is shared equally by all 2,000 seats. It accrues whether or not a seat's agent worked, and it is paid on claim to whoever owns the seat then.",
  "Tips. 5% of each settled order's price is split equally between the agents named in that job's work record, the first sixteen of them. Each agent's share is paid, on claim, to the owner of the seat the agent is bound to in IdentityMD's Adapter.",
  "The IMD only ever goes to the seat's owner. For a seat held by an ordinary wallet nothing needs the owner's signature: anyone can send the claim. A seat held by a contract (an escrow, a marketplace, a contract wallet, a wallet that has delegated to code) must send its own claim; anyone else's call reverts ContractOwnerMustClaim.",
  "A tip whose agent stays unbound waits 180 to 360 days and can then be moved to the seat pool by anyone. A tip that names no agent (a job settled on a later, superseding receipt, or paid on a claim) goes to the seat pool at once.",
];

/** What the launches that are not live mean for a seat's owner. */
const SEATS_NOT_LIVE = {
  B: "The seat pool is filled from the hire desk's fees and tips come from orders settled on it. No order has been settled, so no fee has been set aside for seats by an order and no agent has been tipped.",
} as const;

/** Who may send a claim, in the one wording the seat pages use. Follows `Payroll._claimAllowed`. */
export const SEAT_CLAIM_RULE =
  "A claim pays whoever owns the seat when it is made, and what a seat has not claimed follows the seat. Anyone may send the claim for a seat held by an ordinary wallet. A seat held by a contract must be claimed by that contract itself: sent by anyone else, the call reverts ContractOwnerMustClaim.";

export const seatsPage: PageDef<SeatsModel> = {
  id: "seats",
  pattern: "/seats",
  async load({ sources, now, url }) {
    const { chain, house, deployments } = sources;
    const typedAgent = url.searchParams.get("agent");
    const typedSeat = url.searchParams.get("seat");
    let agent: SeatsModel["agent"] = null;
    let rejected: string | null = null;
    if (typedAgent !== null) {
      if (/^\d{1,30}$/.test(typedAgent.trim())) {
        const [binding] = await chain.bindings([typedAgent.trim()]).catch(() => []);
        if (binding) {
          const owed = await house.tipOwed(binding.agentId);
          agent = { ...binding, tipOwedImd: owed.live && owed.data !== null ? formatImd(owed.data) : null };
        } else {
          rejected = "The Adapter could not be read just now.";
        }
      } else {
        rejected = "An agent id is a whole number.";
      }
    } else if (typedSeat !== null && parseIndex(typedSeat, MAINNET.SEAT_COUNT - 1) === null) {
      rejected = `A seat number is a whole number from 0 to ${MAINNET.SEAT_COUNT - 1}.`;
    }
    const ledger = await house.ledger();
    const l = ledger.live ? ledger.data : null;
    return {
      generatedAt: now.toISOString(),
      payroll: contractStatus(deployments, "payroll"),
      seats: MAINNET.SEATS,
      seatsUrl: etherscanAddress(MAINNET.SEATS),
      adapter: MAINNET.SEAT_ADAPTER,
      adapterUrl: etherscanAddress(MAINNET.SEAT_ADAPTER),
      seatCount: MAINNET.SEAT_COUNT,
      launched: ledger.live,
      poolError: ledger.live && !l ? (ledger.error ?? "Payroll did not answer") : null,
      pool: l
        ? {
            bookedImd: formatImd(l.toSeatsWei + l.tipsToSeatsWei),
            claimedImd: formatImd(l.seatClaimedWei),
            unclaimedImd: l.owed ? formatImd(l.owed.seatsWei) : null,
            tipsWaitingImd: l.owed ? formatImd(l.owed.tipsWei) : null,
          }
        : null,
      agent,
      rejected,
      how: HOW_SEATS_ARE_PAID,
      notLive: notLiveNotes(deployments, SEATS_NOT_LIVE),
      example: { seat: 1998, agent: "52211", job: REFERENCE_JOB.jobId },
      flows: [
        previewFlow("claim-seat", deployments, now, {}, { tokenId: "1998" }),
        previewFlow("claim-tip", deployments, now, {}, { agentId: "52211" }),
      ],
      sources: [liveNote("Seat pool", ledger)],
    };
  },
  meta: () => ({
    title: "Seats",
    description:
      "Look up an IdentityMD seat: its owner, the agent bound to it, and what it can claim from HELP WANTED's fees. Seat owners are paid from every fee and tipped for the work their agents do.",
  }),
  markdown(m) {
    return doc(
      `There are ${formatInt(m.seatCount)} IdentityMD seats (${link(m.seats, m.seatsUrl)}). HELP WANTED pays their owners in two ways. To look one up, open \`/seats/<number>\`, for example ${link("/seats/1998", "/seats/1998")}; for an agent, \`/seats?agent=<id>\`.`,
      m.payroll.address
        ? null
        : `**Nothing can be claimed yet: Payroll (launch A) is ${NOT_LAUNCHED}.** Seat owners and agent bindings are read live today.`,
      m.launched ? `Payroll is at ${link(m.payroll.label, m.payroll.url)}.` : null,
      m.pool
        ? `The seat pool so far: ${m.pool.bookedImd} IMD booked for seats, ${m.pool.claimedImd} IMD claimed${m.pool.unclaimedImd !== null ? `, ${m.pool.unclaimedImd} IMD waiting to be claimed` : ""}${m.pool.tipsWaitingImd !== null ? `; ${m.pool.tipsWaitingImd} IMD in tips waiting for agents' seats` : ""}.`
        : m.poolError
          ? `The seat pool could not be read from Payroll just now: ${m.poolError}`
          : null,
      m.notLive.length > 0 ? doc("## What is not live", bullets(m.notLive)).trimEnd() : null,
      m.rejected,
      m.agent
        ? doc(
            `### Agent ${m.agent.agentId}`,
            bullets(
              [
                m.agent.bound
                  ? m.agent.isSeat
                    ? `Bound to seat #${m.agent.tokenId} (${link(`/seats/${m.agent.tokenId}`, `/seats/${m.agent.tokenId}`)})`
                    : "Bound to a token that is not an IdentityMD seat"
                  : "Not bound to any token in the Adapter",
                m.agent.owner ? `The seat's owner now: ${inline(m.agent.owner)}` : "",
                m.agent.tipOwedImd !== null
                  ? `Tips waiting: ${m.agent.tipOwedImd} IMD`
                  : m.launched
                    ? "Tips waiting: could not be read from Payroll just now"
                    : `Tips waiting: Payroll is ${NOT_LAUNCHED}`,
              ].filter(Boolean),
            ),
          ).trimEnd()
        : null,
      "## How seats are paid",
      numbered(m.how),
      "## A worked example",
      `Job ${inline(m.example.job)} was done by agent ${m.example.agent}. The Adapter binds that agent to seat #${m.example.seat}. Had the job been ordered through our desk, that seat's owner would have been tipped. See ${link(`/verify/${m.example.job}`, `/verify/${m.example.job}`)}.`,
      fence(
        `cast call ${m.adapter} "bindingOf(uint256)((uint8,address,uint256))" ${m.example.agent} --rpc-url ${PUBLIC_RPC}`,
        "sh",
      ),
      "## The transactions",
      ...m.flows.map(flowMarkdown),
    );
  },
};

export interface SeatModel {
  generatedAt: string;
  tokenId: number;
  owner: string | null;
  ownerUrl: string | null;
  ownerError: string | null;
  /** Agents this site has seen bound to the seat. Empty does not mean none exists. */
  agents: string[];
  payroll: ContractStatus;
  /** True once Payroll has an address in the deployments book. */
  launched: boolean;
  /** How a claim is made and who may send it, as the launched contract has it. */
  claimRule: string;
  /** Null until Payroll is launched, and when it could not be read. */
  claimableImd: string | null;
  /** What the seat has been paid so far. Null until Payroll is launched, or when unread. */
  paidImd: string | null;
  claimError: string | null;
  tips: { agentId: string; owedImd: string | null }[];
  /** One sentence for each launch this page leans on that is not live. Empty once all are. */
  notLive: string[];
  flows: FlowPreview[];
  commands: { comment: string; command: string }[];
  sources: SourceNote[];
}

export const seatPage: PageDef<SeatModel> = {
  id: "seat",
  pattern: "/seats/:tokenId",
  async load({ sources, now }, params) {
    const tokenId = parseIndex(params.tokenId, MAINNET.SEAT_COUNT - 1);
    if (tokenId === null) return null;
    const { chain, house, deployments } = sources;
    // The reference job's agent is looked up every time so that its seat always shows its agent.
    await chain.bindings(["52211"]).catch(() => []);
    const [owner, pay] = await Promise.all([
      chain.seatOwner(tokenId).then(
        (value) => ({ value, error: null as string | null }),
        (error: unknown) => ({ value: null, error: messageOf(error) }),
      ),
      house.seatPay(tokenId),
    ]);
    const agents = chain.agentsSeenForSeat(tokenId);
    const tips = await Promise.all(
      agents.map(async (agentId) => {
        const owed = await house.tipOwed(agentId);
        return { agentId, owedImd: owed.live && owed.data !== null ? formatImd(owed.data) : null };
      }),
    );
    const payroll = contractStatus(deployments, "payroll");
    return {
      generatedAt: now.toISOString(),
      tokenId,
      owner: owner.value?.value ?? null,
      ownerUrl: owner.value?.value ? etherscanAddress(owner.value.value) : null,
      ownerError: owner.error,
      agents,
      payroll,
      launched: pay.live,
      claimRule: SEAT_CLAIM_RULE,
      claimableImd: pay.live && pay.data ? formatImd(pay.data.claimableWei) : null,
      paidImd: pay.live && pay.data && pay.data.paidWei !== null ? formatImd(pay.data.paidWei) : null,
      claimError: pay.live ? pay.error : null,
      tips,
      notLive: notLiveNotes(deployments, SEATS_NOT_LIVE),
      flows: [
        previewFlow("claim-seat", deployments, now, { tokenId: String(tokenId) }),
        ...agents
          .slice(0, 2)
          .map((agentId) => previewFlow("claim-tip", deployments, now, { agentId }, { agentId })),
      ],
      commands: [
        {
          comment: "Who owns the seat.",
          command: `cast call ${MAINNET.SEATS} "ownerOf(uint256)(address)" ${tokenId} --rpc-url ${PUBLIC_RPC}`,
        },
        {
          comment: "What the seat can claim from the seat pool.",
          command: castView(payroll.address, "PAYROLL", payrollAbi, "seatClaimable", [String(tokenId)]),
        },
        {
          comment:
            "An agent's tips: unpaid, the part that can be swept to the seat pool, and when the next part can.",
          command: castView(payroll.address, "PAYROLL", payrollAbi, "tipOf", [agents[0] ?? "<agentId>"]),
        },
      ],
      sources: [
        sourceNote(
          "Owner",
          `ownerOf(${tokenId}) at ${MAINNET.SEATS} through ${chain.rpcHost}`,
          owner.value,
          owner.error,
        ),
        liveNote("Claimable", pay),
      ],
    };
  },
  meta: (m) => ({
    title: `Seat #${m.tokenId}`,
    description: m.owner ? `Seat #${m.tokenId} is owned by ${m.owner}.` : `Seat #${m.tokenId}.`,
  }),
  markdown(m) {
    return doc(
      table(
        ["", ""],
        [
          ["Owner", m.owner ?? `could not be read: ${m.ownerError ?? "unknown error"}`],
          [
            "Bound agent",
            m.agents.length > 0
              ? m.agents.map((a) => `agent ${a}`).join(", ")
              : "none seen by this site (the Adapter answers agent to seat only, so a seat's agent is known here only after it appears in a checked work record)",
          ],
          [
            "Claimable from the seat pool",
            m.claimableImd !== null
              ? `${m.claimableImd} IMD`
              : m.launched
                ? "could not be read from Payroll just now"
                : `Payroll is ${NOT_LAUNCHED}`,
          ],
          ...(m.paidImd !== null
            ? ([["Paid to this seat so far", `${m.paidImd} IMD`]] as [string, string][])
            : []),
          ...m.tips.map((t): [string, string] => [
            `Tips waiting for agent ${t.agentId}`,
            t.owedImd !== null
              ? `${t.owedImd} IMD`
              : m.launched
                ? "could not be read from Payroll just now"
                : `Payroll is ${NOT_LAUNCHED}`,
          ]),
        ],
      ),
      m.launched ? `Payroll is at ${link(m.payroll.label, m.payroll.url)}.` : null,
      m.claimError ? `Payroll could not be read just now: ${m.claimError}` : null,
      m.claimRule,
      m.notLive.length > 0 ? doc("## What is not live", bullets(m.notLive)).trimEnd() : null,
      fence(m.commands.map((c) => `# ${c.comment}\n${c.command}`).join("\n\n"), "sh"),
      ...m.flows.map(flowMarkdown),
    );
  },
};

// ---------------------------------------------------------------------------------------------
// /endowments
// ---------------------------------------------------------------------------------------------

export interface EndowmentRow {
  id: number;
  /** "the meter of the payrolls feed", "pot 3", "0x…". */
  target: string;
  kind: string;
  principalImd: string;
  waitingImd: string;
  harvestedImd: string;
  /** What a harvest would send now, in words. */
  harvestable: string;
}

export interface EndowmentsModel {
  generatedAt: string;
  endowments: ContractStatus;
  launched: boolean;
  count: number | null;
  rows: EndowmentRow[];
  /** Said when the contract is live: the next block a batch may be staked in, and what is waiting. */
  stakingNote: string | null;
  error: string | null;
  staking: StakingFacts | null;
  stakingError: string | null;
  how: string[];
  targets: { name: string; detail: string }[];
  caveats: string[];
  /** Creating an endowment for each kind of target. */
  createFlows: FlowPreview[];
  flows: FlowPreview[];
  commands: { comment: string; command: string }[];
  sources: SourceNote[];
}

const HOW_ENDOWMENTS_WORK = [
  "Someone creates an endowment and fixes its target for good: a feed's meter, a crowd pot, or a recipient. Creating one costs a seed of 0.000001 IMD.",
  "Anyone deposits IMD into it. A deposit is the depositor's principal, recorded to the wei.",
  "Deposits wait in the contract until anyone calls stake(), at most once every 50 blocks, which moves them into sIMD in one batch. sIMD's value per share rises as IMD is paid into it.",
  "Only the yield is spent: anyone may call harvest, which redeems what the endowment holds beyond its principal and sends it to the endowment's target, never to the caller.",
  "A depositor withdraws exactly its principal whenever it likes. In a block in which the contract has just staked, sIMD pays nothing out, so a withdrawal may wait one block, or leave at once as sIMD shares of the same worth.",
];

const ENDOWMENT_TARGETS = [
  {
    name: "A feed's meter",
    detail: `The yield buys a Standing Question's answers. A harvest tops the meter up to the cost of ${ENDOWMENT.METER_RUNWAY} requests and no further; yield beyond that stays staked until the meter has room. What is harvested stays on the meter.`,
  },
  {
    name: "A crowd pot",
    detail:
      "The yield chips into a pot or a recurring series for what it still needs, in the name of a fallback beneficiary fixed at creation, who is paid directly whenever the pot takes nothing.",
  },
  {
    name: "A fixed recipient",
    detail: "The yield is transferred to one address, all of it, at every harvest.",
  },
];

const ENDOWMENT_CAVEATS = [
  "Withdrawable principal is a property of our contract and of sIMD together. A defect in either could break it; that risk is yours while the deposit stands.",
  "If sIMD's value per share ever fell, an endowment could be short. A plain withdrawal is then refused, and the long form (exit) pays each depositor the same fraction of what is there, so the first out cannot take everything.",
  "A depositor earns nothing. All yield belongs to the endowment's target, and yield that has been harvested is gone for good.",
  `The runway of ${ENDOWMENT.METER_RUNWAY} requests bounds what a harvest adds to a meter, not what the meter holds: a tip returned by a failed round, or IMD somebody else put there, can leave it above that, and the endowment then waits. The runway is counted at the feed's own cost, which includes the keeper tip its creator chose.`,
  "For a pot endowment, the fallback beneficiary is a party to trust: every chip is made in its name, and it receives the whole harvest whenever the pot takes no chips.",
  "Principal is held in IMD and is exposed to IMD's price like any IMD.",
];

function endowmentRow(e: EndowmentRead, runway: number | null): EndowmentRow {
  const feed = e.kind === "Meter" ? houseFeedById(e.target) : undefined;
  const target =
    e.kind === "Meter"
      ? feed
        ? `the meter of the ${feed.name} feed`
        : `the meter of feed ${e.target.slice(0, 10)}…`
      : e.kind === "Pot"
        ? `pot ${BigInt(e.target)}${e.beneficiary ? `, in the name of ${e.beneficiary}` : ""}`
        : (e.beneficiary ?? "a recipient");
  const harvestable =
    e.harvestableWei === null
      ? e.kind === "Meter"
        ? "could not be read: Questions did not answer, so nothing can be harvested right now"
        : "could not be read just now"
      : e.harvestableWei === 0n
        ? e.kind === "Meter"
          ? `nothing now: either there is no yield worth sending, the meter already holds ${runway ?? ENDOWMENT.METER_RUNWAY} requests' worth, or the feed cannot be bought right now`
          : "nothing now"
        : e.kind === "Meter"
          ? `${formatImd(e.harvestableWei)} IMD, which is what the meter has room for`
          : `${formatImd(e.harvestableWei)} IMD`;
  return {
    id: e.id,
    target,
    kind: e.kind,
    principalImd: formatImd(e.principalWei),
    waitingImd: formatImd(e.bufferedWei),
    harvestedImd: formatImd(e.harvestedWei),
    harvestable,
  };
}

export const endowmentsPage: PageDef<EndowmentsModel> = {
  id: "endowments",
  pattern: "/endowments",
  async load({ sources, now }) {
    const { chain, house, deployments } = sources;
    const [staking, read] = await Promise.all([
      chain.staking().then(
        (value) => ({ value, error: null as string | null }),
        (error: unknown) => ({ value: null, error: messageOf(error) }),
      ),
      house.endowments(20),
    ]);
    const endowments = contractStatus(deployments, "endowments");
    const book = read.live ? read.data : null;
    return {
      generatedAt: now.toISOString(),
      endowments,
      launched: read.live,
      count: book ? book.count : null,
      rows: book ? book.endowments.map((e) => endowmentRow(e, book.meterRunway)) : [],
      stakingNote: book
        ? `${book.pendingWei !== null ? `${formatImd(book.pendingWei)} IMD is waiting to be staked` : "What is waiting to be staked could not be read"}${book.nextStakeBlock !== null ? `; the next batch may be staked from block ${formatInt(book.nextStakeBlock)}` : ""}${book.vaultHold ? ". sIMD is holding the contract in this block: withdrawals that need the vault wait one block" : ""}. METER_RUNWAY, as read from the contract: ${book.meterRunway ?? "unread"}.`
        : null,
      error: read.live ? read.error : null,
      staking: staking.value?.value ?? null,
      stakingError: staking.error,
      how: HOW_ENDOWMENTS_WORK,
      targets: ENDOWMENT_TARGETS,
      caveats: ENDOWMENT_CAVEATS,
      createFlows: [
        previewFlow("endow-create-meter", deployments, now, {}, { feed: "payrolls" }),
        previewFlow(
          "endow-create-pot",
          deployments,
          now,
          {},
          { potId: "1", beneficiary: "0x0000000000000000000000000000000000000001" },
        ),
        previewFlow(
          "endow-create-recipient",
          deployments,
          now,
          {},
          { recipient: "0x0000000000000000000000000000000000000001" },
        ),
      ],
      flows: [
        previewFlow("endow-deposit", deployments, now, {}, { id: "1", amount: "100" }),
        previewFlow("endow-stake", deployments, now),
        previewFlow("endow-harvest", deployments, now, {}, { id: "1" }),
        previewFlow("endow-withdraw", deployments, now, {}, { id: "1", amount: "100" }),
      ],
      commands: [
        {
          comment:
            "One endowment: kind (1 meter, 2 pot, 3 recipient), target, beneficiary, principal, buffered, shares, harvested.",
          command: castView(endowments.address, "ENDOWMENTS", endowmentsAbi, "endowment", ["<id>"]),
        },
        {
          comment: "What a harvest would send now. For a meter endowment: what the meter has room for.",
          command: castView(endowments.address, "ENDOWMENTS", endowmentsAbi, "harvestable", ["<id>"]),
        },
        {
          comment: "The runway a meter harvest stops at, in requests.",
          command: castView(endowments.address, "ENDOWMENTS", endowmentsAbi, "METER_RUNWAY"),
        },
      ],
      sources: [
        liveNote("Endowments", read),
        sourceNote(
          "sIMD",
          `eth_call to ${MAINNET.SIMD} through ${chain.rpcHost}`,
          staking.value,
          staking.error,
        ),
      ],
    };
  },
  meta: () => ({
    title: "Endowments",
    description:
      "Deposit IMD, keep the right to take exactly that much back, and let only the staking yield pay for swarm work: a feed's meter, a pot or a recipient.",
  }),
  markdown(m) {
    return doc(
      "An endowment pays for work with yield and leaves the principal alone. It is the way to commit a large sum to HELP WANTED without spending it.",
      m.endowments.address
        ? `Endowments is at ${link(m.endowments.label, m.endowments.url)}. ${m.count === null ? "How many endowments have been created could not be read just now." : `${m.count} endowment${m.count === 1 ? " has" : "s have"} been created.`}`
        : `**Endowments (launch C) is ${NOT_LAUNCHED}.** Nothing can be deposited today.`,
      m.error ? `Endowments could not be read just now: ${m.error}` : null,
      m.rows.length > 0
        ? table(
            [
              "Endowment",
              "Yield goes to",
              "Principal, IMD",
              "Waiting to be staked, IMD",
              "Harvested so far, IMD",
              "Harvestable now",
            ],
            m.rows.map((r) => [
              `#${r.id}`,
              r.target,
              r.principalImd,
              r.waitingImd,
              r.harvestedImd,
              r.harvestable,
            ]),
          )
        : null,
      m.stakingNote,
      "## How it works",
      numbered(m.how),
      "## What the yield can fund",
      table(
        ["Target", "What happens to the yield"],
        m.targets.map((t) => [t.name, t.detail]),
      ),
      "## sIMD today",
      m.staking
        ? `sIMD holds ${formatImd(m.staking.totalAssetsWei)} IMD. One whole sIMD share (10^24 share units) converts to ${formatUnits(m.staking.assetsPerShareWei, 18)} IMD. This site does not quote a yield rate: it has no history to measure one from yet.`
        : `sIMD could not be read just now: ${m.stakingError ?? "unknown error"}.`,
      "## What recoverable does and does not mean",
      bullets(m.caveats),
      "## Create an endowment",
      ...m.createFlows.map(flowMarkdown),
      "## Deposit, stake, harvest, withdraw",
      ...m.flows.map(flowMarkdown),
      fence(m.commands.map((c) => `# ${c.comment}\n${c.command}`).join("\n\n"), "sh"),
    );
  },
};

// ---------------------------------------------------------------------------------------------
// /rules/new
// ---------------------------------------------------------------------------------------------

export interface RulePreset {
  slug: string;
  title: string;
  sentence: string;
  values: Record<string, string>;
}

export interface RuleRow {
  id: number;
  status: string;
  /** The rule as one sentence. */
  sentence: string;
  escrowImd: string;
  tipImd: string;
  fires: string;
  /** Whether it would fire now, in words. */
  ready: string;
}

export interface RulesNewModel {
  generatedAt: string;
  desk: ContractStatus;
  rules: ContractStatus;
  doorbell: ContractStatus;
  /** What the Doorbell answered. Null while it is not launched, and when it could not be read. */
  doorbellState: DoorbellState | null;
  /** Why the Doorbell could not be read, when it is launched and was not. Null otherwise. */
  doorbellError: string | null;
  /** Where the Doorbell stands, one sentence each, from what was read for this page. */
  doorbellFacts: string[];
  presets: RulePreset[];
  activePreset: string | null;
  /** The standing rule: `Rules.createRule` (launch C). */
  ruleFlow: FlowPreview;
  /** What anyone can do to a rule that exists: fire, reconcile; and its creator: cancel. */
  ruleFlows: FlowPreview[];
  /** Rules that exist, newest first. */
  ruleRows: RuleRow[];
  ruleCount: number | null;
  rulesError: string | null;
  /** The one-shot version on the hire desk: an order with a condition (launch B). */
  flow: FlowPreview;
  ringFlow: FlowPreview;
  how: string[];
  limits: string[];
  ruleHow: string[];
  ruleLimits: string[];
  commands: { comment: string; command: string }[];
  sources: SourceNote[];
}

const PRESETS: RulePreset[] = [
  {
    slug: "milestone",
    title: "A token hits a milestone: commission its picture",
    sentence: "WHEN a token's totalSupply() is at least a number THEN hire 1 robot illustrator.",
    values: {
      condFunction: "totalSupply()",
      condArg: "",
      condCmp: "1",
      condThreshold: "1000000000000000000000000",
      template: "image",
      spec: "Make one square picture celebrating a token reaching one million in supply. No text in the picture.",
      maxPay: "2",
      minPay: "1",
    },
  },
  {
    slug: "tvl",
    title: "A vault's holdings double: order an audit",
    sentence: "WHEN a token's balanceOf(vault) is at least twice today's THEN hire 4 robot auditors.",
    values: {
      condFunction: "balanceOf(address)",
      condCmp: "1",
      template: "audit",
      spec: "Audit the smart contracts in this repository at the given commit and report every defect you find, most serious first. Inputs: repoUrl=https://github.com/owner/repo; baseCommit=0123456789abcdef0123456789abcdef01234567",
      maxPay: "3",
      minPay: "2",
    },
  },
];

/** The first rule proposed in launch C's launch document: a report when sIMD first holds two million IMD. */
const FIRST_RULE_EXAMPLE = {
  condKind: "view",
  condTarget: MAINNET.SIMD,
  condFunction: "totalAssets()",
  condArg: "",
  condCmp: "1",
  condThreshold: "2000000000000000000000000",
  action: "hire",
  template: "research",
  spec: "Write a two-page plain-language report on who staked IMD in the thirty days before the sIMD staking vault first held two million IMD, from on-chain deposit events of the vault only, with every figure sourced to a transaction.",
  maxPay: "5",
  minPay: "2",
  rampHours: "24",
  orderDays: "14",
  allowClaimed: "false",
  tip: "0.05",
  cooldownHours: "0",
  maxFires: "1",
  deposit: "5.05",
};

const HOW_SAY_WHEN_WORKS = [
  "You write one sentence: WHEN a contract's view call compares true against a number, THEN hire. It becomes an order on the hire desk with a condition attached, and your IMD is escrowed.",
  "Nobody can take the order while the condition is false. Anyone may check it with trigger(id); a runner's claim checks it too.",
  "The first time the condition is seen true, it latches: the order is open from then on, even if the value moves back.",
  "From there it is an ordinary order: a runner takes it, the swarm works, and the escrow pays on proof (or on a bonded claim, only if you allowed one). If it never comes true before the order expires, the escrow returns to you.",
];

const SAY_WHEN_LIMITS = [
  "The condition is one staticcall, capped at 100,000 gas, that must return at least 32 bytes. Its first word is compared as an unsigned number.",
  "The call takes no argument, or exactly one 32-byte argument.",
  "A condition that reverts or runs out of gas counts as false.",
  "A conditional order fires once, and latches on one true reading: a condition a caller can make true for the length of one transaction lets that caller open the order.",
];

const HOW_A_RULE_WORKS = [
  "A rule is a sentence a contract keeps for its creator: WHEN a condition holds, THEN hire or pay, from the rule's own escrow.",
  "The condition is a view call on any contract (a selector and up to four words of stored calldata), or the newest answer of a Standing Question, no older than the creator said.",
  "Anyone may fire a rule whose condition holds. The rule reads the condition itself, opens its order on the hire desk (the rule is the employer) or makes its payment, and pays the caller the tip its creator set.",
  "What the desk later hands back for an order (a refund, the change of a delivered job, a forfeited bond) returns to the rule through reconcile. A rule that asked for the desk's callback gets a delivered order's change inside the settlement.",
  "Only the creator can cancel a rule, and takes back whatever it has not spent.",
];

const RULE_LIMITS = [
  "A condition is read when the rule is fired, and only then. One true reading fires it; there is no latch and no second look, and a PAY rule's money moves in that transaction.",
  "Any view condition is accepted, including one a caller can make true for the length of one transaction (a spot balance, a pool price). What that caller can gain is bounded by the rule itself: the tip, and an action whose recipient or order terms the creator fixed.",
  "A FEED rule believes its source: the creator names the contract that is asked for the answer. It fires at most once for each newly answered round, and a failed round is not a new answer.",
  "A tip is paid for every fire, whatever becomes of the order: cooldown and the maximum number of fires are the creator's limits on that.",
  "With the claimed-path flag, the creator accepts the desk's bonded claims for every order of the rule. Rules never challenges and never arbitrates.",
  "The job text of a HIRE rule is public from the moment the rule is created, and fixed for every order the rule opens.",
];

const UNREAD = "could not be read just now";

/** How a Doorbell order pays, as `ALLOW_CLAIMED()` answered. The value is fixed when it is launched. */
export function doorbellPaysOn(allowClaimed: boolean | null): string {
  return allowClaimed === null
    ? `terms that ${UNREAD}`
    : allowClaimed
      ? "a receipt, or a bonded delivery claim nobody challenges within 24 hours"
      : "an on-chain receipt only";
}

/**
 * The rings whose log was read, split between our own wallets (HOUSE) and everybody else
 * (OUTSIDE). The contract counts rings and names no ringer, so only the logs can tell them apart.
 */
export function ringsByOrigin(
  ringers: DoorbellRingers,
  ours: ReadonlySet<string>,
): { read: number; house: number; outside: number; fromBlock: number; toBlock: number } {
  const house = ringers.byRinger.filter((r) => ours.has(r.ringer)).reduce((sum, r) => sum + r.rings, 0);
  return {
    read: ringers.read,
    house,
    outside: ringers.read - house,
    fromBlock: ringers.fromBlock,
    toBlock: ringers.toBlock,
  };
}

/** Who rang, in one sentence: of the rings whose log was read, how many were ours. */
export function ringersWords(state: DoorbellState, ours: ReadonlySet<string>): string | null {
  if (state.rings === 0) return null;
  if (!state.ringers)
    return "Who rang could not be read just now, so the rings are not split between HOUSE and OUTSIDE here.";
  const split = ringsByOrigin(state.ringers, ours);
  if (split.read === 0)
    return "No ring's log could be read just now, so the rings are not split between HOUSE and OUTSIDE here.";
  return `Of the ${plural(split.read, "ring")} whose log this server read (blocks ${formatInt(split.fromBlock)} to ${formatInt(split.toBlock)}), ${formatInt(split.house)} ${split.house === 1 ? "was" : "were"} sent by our own wallets (HOUSE) and ${formatInt(split.outside)} by others (OUTSIDE).`;
}

/**
 * Where a launched Doorbell stands, one sentence each, from its own views, its ring logs and the
 * token's balance. A figure that was not read is said to be unread: a silent view is never printed
 * as zero, as "not funded" or as "no hires". `ours` is the set of HOUSE addresses.
 */
export function doorbellFacts(state: DoorbellState, ours: ReadonlySet<string>): string[] {
  const times = (count: number) => `${formatInt(count)} time${count === 1 ? "" : "s"}`;
  const rung =
    state.rings === null
      ? `How often it has been rung ${UNREAD}`
      : state.rings === 0
        ? "It has not been rung yet"
        : `It has been rung ${times(state.rings)}`;
  const hired =
    state.hires === null
      ? `how often it has hired ${UNREAD}`
      : state.hires === 0
        ? "it has hired nothing"
        : `it has hired ${times(state.hires)}`;
  const { minPayWei: min, maxPayWei: max } = state;
  const price =
    min === null || max === null
      ? `What its orders pay ${UNREAD}.`
      : min === max
        ? `Every order it opens pays ${formatImd(max)} IMD: the bottom and the top of its price range are the same amount (MIN_PAY() and MAX_PAY(), read from the contract), so the price does not rise while an order waits and the escrow of an order is its price.`
        : `The price of an order it opens starts at ${formatImd(min)} IMD and rises to ${formatImd(max)} IMD while it waits for a runner; the escrow of an order is ${formatImd(max)} IMD (MIN_PAY() and MAX_PAY(), read from the contract).`;
  const holds =
    state.balanceWei === null ? `an amount of IMD that ${UNREAD}` : `${formatImd(state.balanceWei)} IMD`;
  const needs = max === null ? "the escrow of one order" : `${formatImd(max)} IMD`;
  const money =
    state.funded === null
      ? `Whether it is funded ${UNREAD} (funded() did not answer). It holds ${holds}.`
      : state.funded
        ? `It is funded: it holds ${holds}, and the next 25th ring opens an order for ${needs}.`
        : `It is not funded: it holds ${holds} and one order needs ${needs}, so a 25th ring that comes now is counted and hires nothing. Anyone may fund it with a plain IMD transfer; what it holds can never be withdrawn and leaves only as the escrow of its own orders.`;
  const who = ringersWords(state, ours);
  const facts = [
    `${formatInt(state.ringsUntilHire)} ring${state.ringsUntilHire === 1 ? "" : "s"} until the next hire. ${rung}, and ${hired}.${who ? ` ${who}` : ""}`,
    price,
    money,
    `Its orders pay on ${doorbellPaysOn(state.allowClaimed)} (fixed when it was launched).`,
  ];
  if (state.allowClaimed === true) {
    facts.push(
      "With the claimed path on, everything it holds is open to delivery claims that nobody challenges: that is launch B's disclosed limit D2, on the judges page. Fund it with small amounts.",
    );
  }
  if (state.lastOrderId !== null && state.lastOrderId > 0) {
    facts.push(`The order it opened last is number ${formatInt(state.lastOrderId)} on the hire desk.`);
  }
  if (state.bondWei !== null && state.deliverySecs !== null) {
    facts.push(
      `A runner that takes one of its orders posts a bond of ${formatImd(state.bondWei)} IMD, and the delivery time is ${formatDuration(state.deliverySecs * 1000)} (BOND() and DELIVERY_SECS(), read from the contract).`,
    );
  }
  return facts;
}

function ruleRow(rule: RuleRead): RuleRow {
  const cmp = COMPARISONS.find((c) => c.code === rule.cmp);
  const when =
    rule.conditionKind === RULE.COND_FEED
      ? `the newest answer of feed ${rule.feedId ? `${rule.feedId.slice(0, 10)}…` : "(unread)"} at ${rule.conditionTarget}`
      : `a view call on ${rule.conditionTarget}`;
  const then =
    rule.action === RULE.ACT_PAY
      ? `pay ${formatImd(rule.spendWei)} IMD to ${rule.payRecipient ?? "its recipient"}`
      : `open an order paying up to ${formatImd(rule.spendWei)} IMD`;
  return {
    id: rule.id,
    status: rule.status,
    sentence: `WHEN ${when} ${cmp?.words ?? "compares true against"} ${rule.threshold}, THEN ${then}.`,
    escrowImd: formatImd(rule.escrowWei),
    tipImd: formatImd(rule.tipWei),
    fires: `${rule.fires} of ${rule.maxFires}`,
    ready:
      rule.status !== "Armed"
        ? rule.status.toLowerCase()
        : rule.canFire === null
          ? "could not be read"
          : rule.canFire
            ? "would fire now"
            : "would not fire now",
  };
}

export const rulesNewPage: PageDef<RulesNewModel> = {
  id: "rules-new",
  pattern: "/rules/new",
  async load({ sources, now, url }) {
    const { house, deployments } = sources;
    const slug = url.searchParams.get("preset");
    const preset = PRESETS.find((p) => p.slug === slug) ?? null;
    const [doorbell, rulesRead] = await Promise.all([house.doorbell(), house.rules(20)]);
    const example = {
      condTarget: MAINNET.IMD,
      ...(preset?.values ?? PRESETS[0]?.values ?? {}),
      ...(preset?.slug === "tvl"
        ? { condArg: MAINNET.SIMD, condThreshold: "4000000000000000000000000" }
        : {}),
    };
    const rules = contractStatus(deployments, "rules");
    const book = rulesRead.live ? rulesRead.data : null;
    return {
      generatedAt: now.toISOString(),
      desk: contractStatus(deployments, "workOrders"),
      rules,
      doorbell: contractStatus(deployments, "doorbell"),
      doorbellState: doorbell.live ? doorbell.data : null,
      doorbellError: doorbell.live && doorbell.data === null ? doorbell.error : null,
      doorbellFacts:
        doorbell.live && doorbell.data ? doorbellFacts(doorbell.data, houseSet(deployments)) : [],
      presets: PRESETS,
      activePreset: preset?.slug ?? null,
      ruleFlow: previewFlow("create-rule", deployments, now, {}, FIRST_RULE_EXAMPLE),
      ruleFlows: [
        previewFlow("fire-rule", deployments, now, {}, { id: "1", spec: FIRST_RULE_EXAMPLE.spec }),
        previewFlow("reconcile-rule", deployments, now, {}, { id: "1", orderId: "1" }),
        previewFlow("cancel-rule", deployments, now, {}, { id: "1" }),
      ],
      ruleRows: book ? book.rules.map(ruleRow) : [],
      ruleCount: book ? book.count : null,
      rulesError: rulesRead.live ? rulesRead.error : null,
      flow: previewFlow("say-when", deployments, now, preset?.values ?? {}, example),
      ringFlow: previewFlow("ring", deployments, now),
      how: HOW_SAY_WHEN_WORKS,
      limits: SAY_WHEN_LIMITS,
      ruleHow: HOW_A_RULE_WORKS,
      ruleLimits: RULE_LIMITS,
      commands: [
        {
          comment: "Whether a rule would fire now, and the condition as read: (met, value, round).",
          command: `${castView(rules.address, "RULES", rulesAbi, "canFire", ["<ruleId>"])}\n${castView(rules.address, "RULES", rulesAbi, "check", ["<ruleId>"])}`,
        },
        {
          comment:
            "A rule in full: creator, tip, action, escrow, fires, the condition, the order terms or the payment.",
          command: castView(rules.address, "RULES", rulesAbi, "getRule", ["<ruleId>"]),
        },
      ],
      sources: [liveNote("Rules", rulesRead), liveNote("Doorbell", doorbell)],
    };
  },
  meta: () => ({
    title: "Say when",
    description:
      "Write a rule: WHEN a contract's view call or a Standing Question crosses a line, THEN hire the swarm or pay. Once, as an order with a condition, or as a standing rule that fires as often as you allow.",
  }),
  markdown(m) {
    return doc(
      "**WHEN** a line is crossed, **THEN** hire or pay. There are two ways to say it: a standing rule, which holds its own escrow and fires as often as its creator allowed, and a one-shot order on the hire desk that nobody can take until its condition has been seen true.",
      m.rules.address
        ? `Rules is at ${link(m.rules.label, m.rules.url)}. ${m.ruleCount === null ? "How many rules have been created could not be read just now." : `${m.ruleCount} rule${m.ruleCount === 1 ? " has" : "s have"} been created.`}`
        : `**Standing rules cannot be written yet: Rules (launch C) is ${NOT_LAUNCHED}.**`,
      m.desk.address
        ? null
        : `**Rules cannot be written yet: the hire desk (WorkOrders, launch B) is ${NOT_LAUNCHED}.**`,
      m.rulesError ? `Rules could not be read just now: ${m.rulesError}` : null,
      m.ruleRows.length > 0
        ? table(
            ["Rule", "Sentence", "Escrow, IMD", "Tip, IMD", "Fires", "Now"],
            m.ruleRows.map((r) => [`#${r.id}`, r.sentence, r.escrowImd, r.tipImd, r.fires, r.ready]),
          )
        : null,
      "## A standing rule",
      numbered(m.ruleHow),
      "### The limits",
      bullets(m.ruleLimits),
      "### Write one (example)",
      "The example is the first rule proposed in launch C's launch document: when the IMD staked in sIMD reaches two million, hire a report on who staked it.",
      flowMarkdown(m.ruleFlow),
      ...m.ruleFlows.map(flowMarkdown),
      fence(m.commands.map((c) => `# ${c.comment}\n${c.command}`).join("\n\n"), "sh"),
      "## Once: an order with a condition",
      "### Presets",
      bullets(m.presets.map((p) => `${link(p.title, `/rules/new?preset=${p.slug}`)}: ${p.sentence}`)),
      "### How it works",
      numbered(m.how),
      "### The limits",
      bullets(m.limits),
      "### The transactions (example)",
      "The example watches the IMD token itself, so the commands are concrete. Replace the target with the contract you mean.",
      flowMarkdown(m.flow),
      "## The Doorbell: a rule you can ring",
      `The Doorbell is a contract with no owner and one job text in its own code. Anyone calls ring(). Every 25th ring, if it holds enough IMD, it opens an order on the hire desk: a contract hiring the swarm, on demand. ${m.doorbell.address ? `It is at ${link(m.doorbell.address, m.doorbell.url)}.` : `It is ${m.doorbell.label}.`}`,
      m.doorbellState
        ? bullets(m.doorbellFacts)
        : m.doorbell.address
          ? `**The Doorbell could not be read just now${m.doorbellError ? `: ${m.doorbellError}` : ""}.** Nothing is said here about its rings, its money or how its orders pay until it answers.`
          : "Whether its orders accept a bonded delivery claim is fixed when it is launched, by whether IdentityMD's receipts are arriving that day, and will be printed here.",
      flowMarkdown(m.ringFlow),
    );
  },
};
