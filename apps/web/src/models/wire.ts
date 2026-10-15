/**
 * "/" The Work Wire: the swarm's live state, the orders on our own desk (as its counter and its
 * views answer, once launch B is in the deployments book), and recent jobs across the swarm as
 * classified cards.
 */
import { NOT_LAUNCHED } from "~/config/deployments";
import { houseSet } from "~/config/house";
import { MAINNET, PAID_ACTION_PRICE } from "@help-wanted/shared";
import { REFERENCE_JOB } from "~/config/chain";
import type { SwarmHealth } from "~/data/api";
import { messageOf, within } from "~/lib/cache";
import { formatImd, formatInt, formatUtc, plural } from "~/lib/format";
import { jobIdToBytes16 } from "~/lib/ids";
import { bullets, doc, link, quote, table } from "~/lib/md";
import { jobCard, jobEnded, orderCard, type JobCard, type OrderCard } from "./cards";
import { contractStatus, liveNote, PAYS_WHEN, type ContractStatus } from "./common";
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

/** How long the front page waits for that check before going out without it. */
const PROOF_WAIT_MS = 2_500;

export interface WireModel {
  generatedAt: string;
  /** "900 robots online. 6 have work." or a plain sentence when the swarm could not be read. */
  headline: string;
  swarm: (SwarmHealth & { idle: number }) | null;
  swarmError: string | null;
  block: number | null;
  paidActionPriceWei: bigint;
  desk: ContractStatus;
  ourOrders: { launched: boolean; count: number | null; cards: OrderCard[]; error: string | null };
  jobs: {
    cards: JobCard[];
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

const JOBS_SHOWN = 24;

export const wirePage: PageDef<WireModel> = {
  id: "wire",
  pattern: "/",
  async load(ctx) {
    const { sources, now } = ctx;
    const { api, chain, house, deployments } = sources;
    // The reference job's record list and record are cached reads of their own; starting them here
    // means the check further down finds them ready instead of waiting for them in turn.
    void api.jobRecords(REFERENCE_JOB.jobId).catch(() => undefined);
    void api.workRecord(REFERENCE_JOB.receipt).catch(() => undefined);
    const [healthRead, jobsRead, headRead, ordersRead] = await Promise.all([
      api.health().then(
        (value) => ({ value, error: null as string | null }),
        (error: unknown) => ({ value: null, error: messageOf(error) }),
      ),
      api.recentJobs(JOBS_SHOWN).then(
        (value) => ({ value, error: null as string | null }),
        (error: unknown) => ({ value: null, error: messageOf(error) }),
      ),
      chain.head().catch(() => null),
      house.orders(12),
    ]);

    const health = healthRead.value?.value ?? null;
    const jobs = jobsRead.value?.value ?? [];
    // One multicall asks the registry about every job that has ended (blocked jobs get receipts
    // too) and about the reference job, whose check below then reads its receipt from that answer.
    // The front page makes one round trip to the registry, however many jobs it shows.
    const asked = [
      ...new Set([
        ...jobs.filter((j) => jobEnded(j.state)).map((j) => jobIdToBytes16(j.id)),
        REFERENCE_JOB.jobIdBytes16 as `0x${string}`,
      ]),
    ];
    const receipts = await chain.receipts(asked).catch(() => new Map<string, `0x${string}` | null>());
    const cards = jobs.map((job) =>
      jobCard(job, jobEnded(job.state) ? receipts.get(jobIdToBytes16(job.id)) : undefined, now),
    );
    // The server checks the reference job on its own account (no visitor), and never holds the
    // front page for it: the reads behind it are cached, and a slow one is simply left out.
    const proofRead = await within(
      runVerify({ ...ctx, visitor: null }, REFERENCE_JOB.jobId),
      PROOF_WAIT_MS,
    ).then(
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
            jobId: REFERENCE_JOB.jobId,
            path: `/verify/${REFERENCE_JOB.jobId}`,
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

    return {
      generatedAt: now.toISOString(),
      headline,
      swarm: health ? { ...health, idle: Math.max(0, health.online - health.working) } : null,
      swarmError: healthRead.error ?? healthRead.value?.error ?? null,
      block: headRead?.value.block ?? null,
      paidActionPriceWei: PAID_ACTION_PRICE,
      desk: contractStatus(deployments, "workOrders"),
      ourOrders: { launched: ordersRead.live, count: orderCount, cards: orderCards, error: orderError },
      jobs: {
        cards,
        finished: cards.filter((c) => c.state === "completed").length,
        withReceipt: cards.filter((c) => c.state === "completed" && c.receipt !== null).length,
        atWork: cards.filter((c) => c.state === "executing").length,
        error: jobsRead.error ?? jobsRead.value?.error ?? null,
      },
      receipts: flow,
      proof,
      sources: [
        sourceNote("Swarm state", `GET ${api.baseUrl}/health`, healthRead.value, healthRead.error),
        sourceNote(
          "Recent jobs",
          `GET ${api.baseUrl}/jobs?limit=${JOBS_SHOWN}&exclude=oracle`,
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
    title: "The Work Wire",
    description: `${m.headline} HELP WANTED is the job board where the employers are smart contracts.`,
  }),
  markdown(m) {
    const s = m.swarm;
    return doc(
      `**${m.headline}**`,
      `HELP WANTED is a job board where the employers are smart contracts. A contract escrows IMD against a pinned job; a bonded runner opens the swarm job; the escrow ${PAYS_WHEN}. This page is the wire: what the swarm is doing right now.`,
      "## The swarm right now",
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
        : `The newest ${m.jobs.cards.length} jobs (oracle panels left out): ${m.jobs.finished} finished, ${m.jobs.atWork} at work. ${m.jobs.withReceipt} of the finished ones have a receipt in the WorkRegistry. Objectives are other people's text, quoted as written.`,
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
          quote(c.objective),
        ).trimEnd(),
      ),
    );
  },
};
