/**
 * "/" The Work Wire: the swarm's live state, the orders on our own desk (as its counter and its
 * views answer, once launch B is in the deployments book), and recent jobs across the swarm as
 * classified cards.
 */
import type { Hex } from "viem";
import { NOT_LAUNCHED } from "~/config/deployments";
import { pinnedOrder } from "~/config/history";
import { houseSet } from "~/config/house";
import { kindHash, MAINNET, PAID_ACTION_PRICE } from "@help-wanted/shared";
import { etherscanTx, explorerJob, REFERENCE_JOB } from "~/config/chain";
import type { SwarmHealth } from "~/data/api";
import { messageOf, within } from "~/lib/cache";
import { formatImd, formatInt, formatUtc, plural } from "~/lib/format";
import { jobIdToBytes16 } from "~/lib/ids";
import { bullets, doc, link, numbered, table, untrusted } from "~/lib/md";
import { jobCard, jobEnded, orderCard, type JobCard, type OrderCard } from "./cards";
import { contractStatus, liveNote, PAYS_WHEN, type ContractStatus } from "./common";
import { doorbellNeeds, ringsByOrigin } from "./money";
import { countReceipts, receiptFlow, receiptFlowMeaning, type ReceiptFlow } from "./receipts";
import { sourceNote, type PageDef, type SourceNote } from "./types";
import { runVerify } from "./verify";

/**
 * The reference job's receipt check, as run for this rendering of the front page. It is the
 * product's central claim made in one line: a job whose record hashes to its receipt on chain.
 */
export interface WireProof {
  jobId: string;
  /** `/verify/<jobId>`: the whole check, step by step. */
  path: string;
  verdict: string;
  /** PROVEN ON CHAIN, or whatever the check found. */
  stamp: string;
  summary: string;
  receipt: string | null;
  recordBytes: number | null;
  /** When the WorkRegistry was read for this check. */
  receiptReadAt: string | null;
}

/** The kind a picture job's work record carries, hashed as the desk pins it. */
const PICTURE_KIND_HASH = kindHash("skill:create-image").toLowerCase();

/** How long the front page waits for that check before going out without it. */
const PROOF_WAIT_MS = 2_500;

/** The front page's lead: the first order paid on proof, from `config/history.ts` and live reads. */
export interface WireLead {
  headline: string;
  deck: string;
  orderPath: string;
  verifyPath: string;
  /** The settlement, the x402 payment and the tip, each with its transaction. */
  links: { label: string; url: string }[];
  /** What the desk answers about the order now, in one sentence. */
  now: string;
  /** IdentityMD's page of the job, which shows the picture. Null for a job that made no picture. */
  picture: { label: string; url: string } | null;
}

/** One of the three things a visitor can do from the front page. */
export interface WireAction {
  label: string;
  path: string;
  words: string;
}

/** The Doorbell as the front page counts it: rings toward its next hire, and whether it can hire. */
export interface WireDoorbell {
  /** Rings since its last hire, of `every`. Null when unread. */
  rung: number | null;
  every: number;
  funded: boolean | null;
  balanceImd: string | null;
  priceImd: string | null;
  words: string;
}

/** What is new here, in four lines. */
export const WHAT_IS_NEW = [
  "IdentityMD bills up front. Its Intake lets a wallet or a contract open a swarm job in one call and takes the 0.5 IMD in that same call, and its x402 route needs an ordinary wallet's signature. Either way IdentityMD is paid before the work is done.",
  "HELP WANTED makes the pay wait. The desk holds the employer's IMD in escrow until the job is proven, or until a bonded claim stands on an order that opts in (line 4 says how), and refunds it otherwise. The team's runner, under bond, pays the swarm's 0.5 IMD by x402 and opens the job with the 85-byte order header at the start of its text. The Intake's job.open is not used here.",
  "WorkProof checks the job's work record against IdentityMD's WorkRegistry: its keccak256 must equal latest(jobId). The desk then checks that the record carries the order's 85-byte order header, kind and job text. A proof shows what IdentityMD recorded, not that the work is good.",
  "The escrow pays on that receipt, or, on an order that opts in, on a bonded delivery claim nobody challenges for 24 hours. Otherwise the employer is refunded.",
] as const;

/** One order, end to end, in five steps: the strip on the front page. */
export const HOW_AN_ORDER_FLOWS: readonly { step: string; words: string }[] = [
  {
    step: "The employer escrows",
    words: "The employer, a contract or a wallet, escrows IMD on the desk against a pinned job text.",
  },
  {
    step: "A runner buys the job",
    words:
      "A bonded runner takes the order and pays the swarm's 0.5 IMD from its own wallet. The team's runner pays by x402.",
  },
  {
    step: "The swarm works",
    words: "IdentityMD's swarm does the job. Its text begins with the order's 85-byte order header.",
  },
  {
    step: "A WorkRegistry receipt",
    words: "IdentityMD writes the hash of the job's work record to its WorkRegistry on Ethereum.",
  },
  {
    step: "The desk pays or refunds",
    words:
      "WorkProof holds the record against that receipt and the desk pays the runner. An order that opted in may also pay on a bonded claim nobody challenges for 24 hours. Otherwise the employer is refunded.",
  },
];

export interface WireModel {
  generatedAt: string;
  /** "900 robots online. 6 have work." or a plain sentence when the swarm could not be read. */
  headline: string;
  /** Order 1, paid on proof. Null where the deployments book's desk is not the one it happened on. */
  lead: WireLead | null;
  whatIsNew: readonly string[];
  /** The five steps of an order, in order. */
  strip: readonly { step: string; words: string }[];
  actions: { hire: WireAction; ring: WireAction & { doorbell: WireDoorbell | null }; verify: WireAction };
  /** One line: whose use of our contracts this page found, HOUSE or OUTSIDE. Null when nothing was read. */
  houseStatus: string | null;
  swarm: (SwarmHealth & { idle: number }) | null;
  swarmError: string | null;
  block: number | null;
  paidActionPriceWei: bigint;
  desk: ContractStatus;
  ourOrders: { launched: boolean; count: number | null; cards: OrderCard[]; error: string | null };
  jobs: {
    /** At most five: the newest. */
    cards: JobCard[];
    /** How many jobs were read; the counts below are over all of them. */
    read: number;
    finished: number;
    withReceipt: number;
    atWork: number;
    error: string | null;
  };
  /** Whether receipts are reaching the registry, from the figures read for this page. */
  receipts: ReceiptFlow;
  /** The reference job's check; null when it did not finish in time or could not run. */
  proof: WireProof | null;
  sources: SourceNote[];
}

/** How many recent jobs are read for the receipt figures, and how many of them are shown as cards. */
const JOBS_READ = 24;
const JOBS_SHOWN = 5;

export const wirePage: PageDef<WireModel> = {
  id: "wire",
  pattern: "/",
  async load(ctx) {
    const { sources, now } = ctx;
    const { api, chain, house, deployments } = sources;
    // The order the lead is about, when the book's desk is the one it was settled on.
    const first = pinnedOrder(deployments.contracts.workOrders.address, 1);
    // The job the proof card checks: the first order's, or else the reference job.
    const checked = first
      ? { jobId: first.jobId, receipt: first.prove.recordHash }
      : { jobId: REFERENCE_JOB.jobId, receipt: REFERENCE_JOB.receipt };
    // The checked job's record list and record are cached reads of their own; starting them here
    // means the check further down finds them ready instead of waiting for them in turn.
    void api.jobRecords(checked.jobId).catch(() => undefined);
    void api.workRecord(checked.receipt as Hex).catch(() => undefined);
    const [healthRead, jobsRead, headRead, ordersRead, bellRead] = await Promise.all([
      api.health().then(
        (value) => ({ value, error: null as string | null }),
        (error: unknown) => ({ value: null, error: messageOf(error) }),
      ),
      api.recentJobs(JOBS_READ).then(
        (value) => ({ value, error: null as string | null }),
        (error: unknown) => ({ value: null, error: messageOf(error) }),
      ),
      chain.head().catch(() => null),
      house.orders(12),
      house.doorbell(),
    ]);
    const firstRead = first ? await house.order(first.id) : null;

    const health = healthRead.value?.value ?? null;
    const jobs = jobsRead.value?.value ?? [];
    // One multicall asks the registry about every job that has ended (blocked jobs get receipts
    // too) and about the checked job, whose check below then reads its receipt from that answer.
    // The front page makes one round trip to the registry, however many jobs it reads.
    const asked = [
      ...new Set([
        ...jobs.filter((j) => jobEnded(j.state)).map((j) => jobIdToBytes16(j.id)),
        jobIdToBytes16(checked.jobId),
      ]),
    ];
    const receipts = await chain.receipts(asked).catch(() => new Map<string, `0x${string}` | null>());
    const allCards = jobs.map((job) =>
      jobCard(job, jobEnded(job.state) ? receipts.get(jobIdToBytes16(job.id)) : undefined, now),
    );
    const cards = allCards.slice(0, JOBS_SHOWN);
    // The server checks that job on its own account (no visitor), and never holds the front page
    // for it: the reads behind it are cached, and a slow one is simply left out.
    const proofRead = await within(runVerify({ ...ctx, visitor: null }, checked.jobId), PROOF_WAIT_MS).then(
      (read) => (read.done ? read.value : null),
      () => null,
    );

    const houseAddresses = houseSet(deployments);
    let orderCards: OrderCard[] = [];
    let orderCount: number | null = null;
    let orderError: string | null = null;
    if (ordersRead.live) {
      if (ordersRead.data) {
        orderCount = ordersRead.data.count;
        orderCards = await Promise.all(
          ordersRead.data.orders.map(async (order) =>
            orderCard(
              order,
              order.sample ? true : await chain.isContract(order.employer).catch(() => null),
              houseAddresses,
            ),
          ),
        );
      }
      orderError = ordersRead.error;
    }

    const endedJobs = jobs.filter((j) => jobEnded(j.state));
    const flow = receiptFlow({
      queued: health?.receiptsQueued ?? null,
      ...countReceipts(endedJobs.map((j) => receipts.get(jobIdToBytes16(j.id)))),
      readAt: healthRead.value ? new Date(healthRead.value.fetchedAt).toISOString() : null,
      error: healthRead.error ?? jobsRead.error,
    });

    const proof: WireProof | null =
      proofRead && proofRead.result.verdict !== "unchecked"
        ? {
            jobId: checked.jobId,
            path: `/verify/${checked.jobId}`,
            verdict: proofRead.result.verdict,
            stamp: proofRead.result.stamp,
            summary: proofRead.result.summary,
            receipt: proofRead.result.receipt,
            recordBytes: proofRead.result.record?.bytes ?? null,
            receiptReadAt: proofRead.reads.receiptReadAt,
          }
        : null;

    const headline = health
      ? `${plural(health.online, "robot")} online. ${formatInt(health.working)} ${health.working === 1 ? "has" : "have"} work.`
      : "The swarm's state could not be read just now.";

    // ---- The lead: the first order paid on proof. The history is kept; its state now is read. ----
    let lead: WireLead | null = null;
    if (first) {
      const step = (key: string) => first.trail.find((s) => s.key === key) ?? null;
      const settled = step("settled");
      const paid = step("paid");
      const claim = first.tipClaims[0] ?? null;
      const readNow = firstRead?.live ? firstRead.data : null;
      const links: WireLead["links"] = [];
      if (settled) links.push({ label: "the settlement", url: etherscanTx(settled.tx.hash) });
      if (paid) links.push({ label: "the x402 payment", url: etherscanTx(paid.tx.hash) });
      const agent = first.prove.agentIds[0] ?? null;
      links.push(
        claim
          ? {
              label: `the tip for agent ${claim.agentId}, claimed for seat #${claim.tokenId}'s owner`,
              url: etherscanTx(claim.tx.hash),
            }
          : {
              label: agent ? `the tip credited for agent ${agent}` : "the tip",
              url: `/orders/${first.id}#tip`,
            },
      );
      lead = {
        headline: "A contract hired, and the desk paid the runner on proof.",
        deck: `On 13 October 2026 the Doorbell, a contract with no owner, opened order ${first.id} on its 25th ring and escrowed 1 IMD. A bonded runner bought the swarm job by x402 for 0.5 IMD. On 14 October, a minute after IdentityMD wrote the job's receipt, the desk checked the job's work record against that receipt through WorkProof, then paid the runner, sent Payroll its fee and credited a tip for ${agent ? `agent ${agent}, ` : ""}the agent IdentityMD's record names. The ringer, the runner and the IMD were all the team's own.`,
        orderPath: `/orders/${first.id}`,
        verifyPath: `/verify/${first.jobId}`,
        links,
        now: !firstRead?.live
          ? "The desk is not in this server's deployments book."
          : readNow
            ? `Read for this page: order ${first.id} is ${readNow.state}${readNow.state === "Delivered" ? (readNow.terms?.proven ? " and marked proven" : ", not marked proven") : ""}.`
            : `The desk could not be read just now, so its state now is not given here.`,
        // The record names the kind; a picture job's page at IdentityMD shows the picture.
        picture:
          first.prove.kindHash.toLowerCase() === PICTURE_KIND_HASH
            ? { label: "See the picture the Doorbell paid for", url: explorerJob(first.jobId) }
            : null,
      };
    }

    // ---- The three actions. ----
    const bell = bellRead.live ? bellRead.data : null;
    const every = 25;
    let doorbell: WireDoorbell | null = null;
    if (bell) {
      const needs = doorbellNeeds(bell);
      const split =
        bell.ringers && bell.ringers.read > 0 ? ringsByOrigin(bell.ringers, houseSet(deployments)) : null;
      const counted =
        bell.rings === null || bell.rings === 0
          ? "Every ring is counted on chain, and each ring's log names who rang."
          : `Every ring is counted on chain, and each ring's log names who rang: ${
              split
                ? `of the ${plural(split.read, "ring")} read, ${formatInt(split.house)} ${split.house === 1 ? "was" : "were"} the team's own (HOUSE) and ${formatInt(split.outside)} ${split.outside === 1 ? "was" : "were"} anyone else's (OUTSIDE).`
                : "who rang could not be read just now."
            }`;
      doorbell = {
        rung: bell.rings === null ? null : bell.rings % every,
        every,
        funded: bell.funded,
        balanceImd: bell.balanceWei === null ? null : formatImd(bell.balanceWei),
        priceImd: bell.maxPayWei === null ? null : formatImd(bell.maxPayWei),
        words: [
          `${bell.rings === null ? "Its ring count could not be read" : `${formatInt(bell.rings % every)} of ${every} rings toward its next hire`}. ${
            bell.funded === null
              ? "Whether it is funded could not be read."
              : bell.funded
                ? `Funded: it holds ${bell.balanceWei === null ? "enough" : `${formatImd(bell.balanceWei)} IMD`}, so the next 25th ring opens an order.`
                : `Not funded: it holds ${bell.balanceWei === null ? "too little" : `${formatImd(bell.balanceWei)} IMD`}${bell.maxPayWei === null ? "" : ` and a hire needs ${formatImd(bell.maxPayWei)} IMD`}, so a 25th ring now would hire nothing.`
          }`,
          needs,
          counted,
          bell.allowClaimed === true
            ? "Its orders also pay on a bonded delivery claim nobody challenges for 24 hours. No watcher is running: the team runs nothing that would challenge an untrue one."
            : null,
        ]
          .filter((line): line is string => line !== null)
          .join(" "),
      };
    }
    const actions: WireModel["actions"] = {
      hire: {
        label: "Hire",
        path: "/hire",
        words:
          "Escrow IMD against a job text you pin. It pays on a receipt, or, if you opt in, on a bonded claim nobody challenges for 24 hours; otherwise it comes back.",
      },
      ring: {
        label: "Ring the Doorbell",
        path: "/rules/new#doorbell",
        words: bellRead.live
          ? (doorbell?.words ?? "The Doorbell could not be read just now.")
          : `The Doorbell (launch B) is ${NOT_LAUNCHED}.`,
        doorbell,
      },
      verify: {
        label: "Verify any job",
        path: "/verify",
        words: "Hash a swarm job's work record and hold it against its receipt on chain, in your browser.",
      },
    };

    // ---- HOUSE and OUTSIDE, from the orders read for this page. ----
    let houseStatus: string | null = null;
    if (ordersRead.live && ordersRead.data && !("sample" in ordersRead && ordersRead.sample)) {
      const read = ordersRead.data.orders;
      const house = read.filter((o) => houseAddresses.has(o.employer.toLowerCase())).length;
      houseStatus =
        ordersRead.data.count === 0
          ? "HOUSE and OUTSIDE: no order has been opened on the desk yet."
          : `HOUSE and OUTSIDE: of the ${plural(read.length, "order")} read for this page, ${formatInt(house)} ${house === 1 ? "was" : "were"} opened by our own wallets and contracts (HOUSE) and ${formatInt(read.length - house)} by anyone else (OUTSIDE). Our own use is never counted as outside use.`;
    }

    return {
      generatedAt: now.toISOString(),
      headline,
      lead,
      whatIsNew: WHAT_IS_NEW,
      strip: HOW_AN_ORDER_FLOWS,
      actions,
      houseStatus,
      swarm: health ? { ...health, idle: Math.max(0, health.online - health.working) } : null,
      swarmError: healthRead.error ?? healthRead.value?.error ?? null,
      block: headRead?.value.block ?? null,
      paidActionPriceWei: PAID_ACTION_PRICE,
      desk: contractStatus(deployments, "workOrders"),
      ourOrders: { launched: ordersRead.live, count: orderCount, cards: orderCards, error: orderError },
      jobs: {
        cards,
        read: allCards.length,
        finished: allCards.filter((c) => c.state === "completed").length,
        withReceipt: allCards.filter((c) => c.state === "completed" && c.receipt !== null).length,
        atWork: allCards.filter((c) => c.state === "executing").length,
        error: jobsRead.error ?? jobsRead.value?.error ?? null,
      },
      receipts: flow,
      proof,
      sources: [
        sourceNote("Swarm state", `GET ${api.baseUrl}/health`, healthRead.value, healthRead.error),
        sourceNote(
          "Recent jobs",
          `GET ${api.baseUrl}/jobs?limit=${JOBS_READ}&exclude=oracle`,
          jobsRead.value,
          jobsRead.error,
        ),
        sourceNote(
          "Receipts",
          `WorkRegistry.latest(jobId) at ${MAINNET.WORK_REGISTRY}, read through ${chain.rpcHost}`,
          headRead,
        ),
        liveNote("Our orders", ordersRead),
      ],
    };
  },
  meta: (m) => ({
    // The front page's twin is headed with the site's own name: `/index.md` opens "# HELP WANTED".
    title: "HELP WANTED",
    description: `${m.lead ? `${m.lead.headline} ` : ""}${m.headline} HELP WANTED is the job board where the employers are smart contracts.`,
  }),
  markdown(m) {
    const s = m.swarm;
    const a = m.actions;
    return doc(
      m.lead
        ? doc(
            `**${m.lead.headline}**`,
            m.lead.deck,
            bullets([
              `The order: ${link(m.lead.orderPath, m.lead.orderPath)}`,
              `The proof, checked in your browser: ${link(m.lead.verifyPath, m.lead.verifyPath)}`,
              ...(m.lead.picture
                ? [`${m.lead.picture.label}: ${link(m.lead.picture.url, m.lead.picture.url)}`]
                : []),
              ...m.lead.links.map(
                (l) => `${l.label[0]?.toUpperCase()}${l.label.slice(1)}: ${link(l.url, l.url)}`,
              ),
            ]),
            m.lead.now,
          ).trimEnd()
        : `**${m.headline}**`,
      "## What is new",
      numbered([...m.whatIsNew]),
      "## One order, in five steps",
      numbered(m.strip.map((x) => `${x.step}. ${x.words}`)),
      "## Three things to do",
      bullets([
        `${link(a.hire.label, a.hire.path)}: ${a.hire.words}`,
        `${link(a.ring.label, a.ring.path)}: ${a.ring.words}`,
        `${link(a.verify.label, a.verify.path)}: ${a.verify.words}`,
      ]),
      m.houseStatus,
      `HELP WANTED is a job board where the employers are smart contracts. An employer escrows IMD against a pinned job; a bonded runner opens the swarm job; the escrow ${PAYS_WHEN}.`,
      "## The swarm right now",
      m.lead ? `**${m.headline}**` : null,
      s
        ? table(
            ["Measure", "Value"],
            [
              ["Robots online", formatInt(s.online)],
              ["Robots with work", formatInt(s.working)],
              ["Robots idle", formatInt(s.idle)],
              [
                "Work accepted in the last 24 hours",
                s.acceptedLastDay === null ? "" : formatInt(s.acceptedLastDay),
              ],
              ["Paid orders, all time", s.paidOrders === null ? "" : formatInt(s.paidOrders)],
              [
                "Receipts waiting to be written on chain",
                s.receiptsQueued === null ? "" : formatInt(s.receiptsQueued),
              ],
              ["Price of one job", `${formatImd(m.paidActionPriceWei)} IMD`],
              ["As computed by the API at", s.computedAt ? formatUtc(s.computedAt) : ""],
            ],
          )
        : `The swarm's state could not be read: ${m.swarmError ?? "unknown error"}.`,
      `Receipts: ${m.receipts.observed} ${receiptFlowMeaning(m.receipts)}`,
      m.proof
        ? `One job checked for this page: ${link(m.proof.jobId, m.proof.path)} is ${m.proof.stamp}. ${m.proof.summary}`
        : `One job to check yourself: ${link(REFERENCE_JOB.jobId, `/verify/${REFERENCE_JOB.jobId}`)}.`,
      "## Our own orders",
      m.ourOrders.launched
        ? m.ourOrders.cards.length > 0
          ? table(
              ["Order", "Card", "Employer", "Origin", "Status"],
              m.ourOrders.cards.map((c) => [
                link(`#${c.id}`, c.path),
                `${c.headline} ${c.pay}${c.sample ? " (SAMPLE)" : ""}`,
                c.employer,
                c.origin,
                c.stamp?.text ?? "OPEN",
              ]),
            )
          : m.ourOrders.count === null
            ? `The hire desk is at ${m.desk.label}. Its orders could not be read just now${m.ourOrders.error ? ` (${m.ourOrders.error})` : ""}, so nothing is said here about them.`
            : m.ourOrders.count === 0
              ? `The hire desk is live at ${m.desk.label}. No order has been posted on it yet: its own counter, orderCount(), read 0 for this page.`
              : `${plural(m.ourOrders.count, "order has", "orders have")} been opened on the hire desk at ${m.desk.label}; none of the newest could be read as an order just now.`
        : `None yet. The hire desk (WorkOrders, launch B) is ${NOT_LAUNCHED}. When it is, every order posted through it appears here first, each labelled HOUSE (ours) or OUTSIDE (anyone else's).`,
      "## Elsewhere in the swarm",
      m.jobs.error && m.jobs.cards.length === 0
        ? `The job list could not be read: ${m.jobs.error}.`
        : `The newest ${m.jobs.read} jobs (oracle panels left out): ${m.jobs.finished} finished, ${m.jobs.atWork} at work. ${m.jobs.withReceipt} of the finished ones have a receipt in the WorkRegistry. The newest ${m.jobs.cards.length} are below. Objectives are other people's text, quoted as written.`,
      ...m.jobs.cards.map((c) =>
        doc(
          `### ${c.kicker}, job ${c.shortId}`,
          bullets([
            `State: ${c.stateWords}${c.stamp ? ` (${c.stamp.text})` : ""}`,
            `Posted: ${c.postedWords}${c.took ? `; took ${c.took}` : ""}`,
            c.receipt
              ? `Receipt in the WorkRegistry: ${c.receipt}`
              : c.ended
                ? c.receiptRead
                  ? "Receipt in the WorkRegistry: none yet"
                  : "Receipt in the WorkRegistry: could not be read"
                : "Receipt: not finished",
            `Check it: ${link(c.verifyPath, c.verifyPath)} · ${link("explorer", c.explorerUrl)}`,
          ]),
          untrusted(c.objective, "the job's objective, written by whoever ordered it"),
        ).trimEnd(),
      ),
    );
  },
};
