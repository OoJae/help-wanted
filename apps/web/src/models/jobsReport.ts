/**
 * "/jobs-report": the Robot Jobs Report.
 *
 * The official release is the `JobsReport` contract (launch A): it copies the answers the
 * `Questions` contract buys from the IdentityMD oracle into a public record, one print a day. The
 * moment a print exists this page leads with it. Beside it, always, is this site's own unofficial
 * tally over IMD Transfer logs, counted the same way the feeds count (every Transfer log to the
 * fee address, transfers of zero included), so the two can be held against each other. Until the
 * first print the tally is all there is, and the page says so in its first line.
 */
import { pinnedPrint } from "~/config/history";
import { houseSet } from "~/config/house";
import { MAINNET } from "@help-wanted/shared";
import { PUBLIC_LOG_WINDOW_BLOCKS, TOPIC, etherscanAddress, etherscanTx } from "~/config/chain";
import type { PaymentHistory } from "~/data/chain";
import type { JobsReportCrown, JobsReportPrint, JobsReportSummary } from "~/data/house";
import { messageOf } from "~/lib/cache";
import {
  bpsPercent,
  formatDuration,
  formatImd,
  formatInt,
  formatUtc,
  formatUtcLongDay,
  percent,
  utcClock,
  utcDay,
} from "~/lib/format";
import { bullets, doc, fence, link, table } from "~/lib/md";
import { computeTally, type DayRow, type Tally, type TallyWindow } from "~/lib/tally";
import { jobsReportAbi } from "@help-wanted/shared";
import { castView, contractStatus, liveNote, notLiveNotes, PUBLIC_RPC, type ContractStatus } from "./common";
import { flowMarkdown, previewFlow, type FlowPreview } from "./flowPreview";
import { sourceNote, type PageDef, type SourceNote } from "./types";

export interface JobsReportModel {
  generatedAt: string;
  /** `Saturday, 10 October 2026`. */
  releaseDay: string;
  /** A stable reference for the release, in the manner of a statistical agency. */
  releaseNumber: string;
  payee: string;
  payeeUrl: string;
  official: {
    contract: ContractStatus;
    launched: boolean;
    /** True once the contract holds at least one print: from then on this page is the official release. */
    printed: boolean;
    /**
     * True when the contract has an address but could not be read for this page. Then nothing is
     * said about whether it has printed: "has not printed" is a statement only a read can make.
     */
    unread: boolean;
    summary: JobsReportSummary | null;
    prints: PrintRow[];
    /** The newest crowned round of the employers feed: the week's three largest payers, by panel agreement. */
    crown: JobsReportCrown | null;
    error: string | null;
  };
  /** The headline of the page: the official figures once a print exists, the unofficial ones until then. */
  headline: string;
  /**
   * When the newest print was made, and what the next one waits for. Null before any print. The
   * release is dated by its print: `releaseDay` and `releaseNumber` follow `lastPrintAt`.
   */
  schedule: {
    /** When the newest print was made (its transaction's block time), or failing that when the round it copies was answered. */
    lastPrintAt: string | null;
    lastPrintTxUrl: string | null;
    lastPrintWords: string;
    /** The payrolls meter, read for this page, and what a new request costs. Null when unread. */
    meter: { holdsImd: string; costImd: string | null; shortImd: string | null } | null;
    nextWords: string;
  } | null;
  /**
   * The release's figures: payments in the newest day of blocks (at most 7,200), the range the
   * public RPC named in the commands still serves. Null when the chain could not be read at all.
   */
  tally: Tally | null;
  tallyError: string | null;
  coverage: {
    /** `24 h 0 min` */
    span: string | null;
    words: string;
    archive: string;
    approxTimes: boolean;
    rpcHost: string;
  } | null;
  /**
   * Days before the release's range, from logs this server read earlier (or from an archive RPC).
   * They are shown apart because the public RPC no longer serves them: the commands on the page
   * reproduce the release's figures, not these. Null when the server holds nothing older.
   */
  earlier: { window: TallyWindow; days: DayRow[]; note: string } | null;
  /** The summary paragraph of the release, built from the numbers. */
  summary: string;
  commands: { comment: string; command: string }[];
  officialCommands: { comment: string; command: string }[];
  flows: FlowPreview[];
  technicalNotes: string[];
  /** One sentence for each launch this page leans on that is not live. Empty once all are. */
  notLive: string[];
  sources: SourceNote[];
}

/** One official print, with this site's own recount beside it when it holds the logs. */
export interface PrintRow extends JobsReportPrint {
  /** True when a hires count is attached (`hiresRound` is not zero). */
  counted: boolean;
  /**
   * The blocks the attached count covers: the window of the hires round it came from. The two daily
   * feeds are bought by separate transactions, so this can differ from the print's own blocks by a
   * few. Null when no count is attached or that round could not be read.
   */
  countWindow: { fromBlock: number; toBlock: number } | null;
  /**
   * The attached count as the page prints it: the number alone when it covers the print's own
   * blocks, and with the blocks it covers (or the plain statement that they could not be read) when
   * it does not, so that no count is printed beside a range it was not counted over.
   */
  countWords: string;
  /**
   * This site's recount. The amount is summed over exactly the print's blocks, and the count over
   * exactly the count's own blocks: each figure is held against the window the oracle was asked
   * about. Null when the server does not hold the logs for all of the print's blocks (some are
   * older than the range it reads and no archive RPC is configured, or the logs could not be read).
   */
  check: {
    totalWei: bigint;
    /** Transfers in the print's blocks, for information: the count is compared over its own window. */
    payments: number;
    amountAgrees: boolean;
    /** Transfers in the count's own blocks; null when those are unknown or not all held. */
    countOverItsWindow: number | null;
    countAgrees: boolean | null;
  } | null;
  /** The comparison in words, as the page prints it. */
  checkWords: string;
  /** True when a figure this site could recount came out different from the print. */
  differs: boolean;
}

const TECHNICAL_NOTES = [
  'What is counted. Every paid action on IdentityMD (opening a job, an oracle request, a launch, creating or topping up a schedule) moves IMD to one address, the fee address. This tally sums the IMD `Transfer` logs whose recipient is that address. "Payrolls" is the IMD moved, "payments" the number of transfers, "employers" the distinct senders. The official feeds ask the oracle the same two questions over the same logs.',
  "What it is not. It is money paid for swarm work, not a count of finished jobs. One paid action costs 0.5 IMD; a larger transfer is a prepayment for several, such as the runs of a schedule. A payment buys admission whether or not the job succeeds.",
  "Every log counts. A transfer of zero IMD to the fee address is still one payment here, because the on-chain hires feed counts Transfer logs and cannot leave such a log out: the oracle's counting recipe filters on indexed arguments only. Counting the same way keeps this tally and the feed comparable. It also means anyone can raise a day's count for the price of gas.",
  "Coverage. Every headline figure and Tables A to E are for the newest 7,200 blocks, about one day, ending at the block printed with them. That is a range a free public RPC still serves, so anyone can reproduce the figures with the commands below, and it does not depend on how long this server has been running. Days before it appear only in the table of earlier days, from logs this server read earlier or from an archive RPC, and are marked as such. Nothing is estimated.",
  "House and outside. Payments from the wallets and contracts the HELP WANTED team controls are counted and shown separately as HOUSE. The list is published in the repository (evidence/house-wallets.json).",
  "Official figures. The Questions contract (launch A) buys the two daily figures from the IdentityMD oracle (log-sum and log-count recipes over a fixed block window, which the oracle reruns itself before it signs), and the JobsReport contract prints an answered round on chain when anyone calls print(). Whether either contract is launched, and whether anything has printed, is said at the head of this page from what was read for it. From the first print on, this page leads with the on-chain print and keeps this tally beside it as a cross-check. A print's window is the feed's own, so it need not be the newest 7,200 blocks; where this server holds the logs for a print's blocks it counts them again and says whether the two agree.",
  "The weekly list. The three largest payers of a week come from a third feed that a panel judges: IdentityMD does not recompute it, and it rests on five of seven agents agreeing. The report prints without it, no money moves on it, and it is shown here as what it is.",
];

/**
 * The tally a release prints: over `history.recent`, never over everything the process happens to
 * hold. Every page that quotes "IMD paid to the swarm" uses this, so the figure and the command
 * printed beside it always cover the same blocks, and those blocks are ones the public RPC serves.
 */
export function releaseTally(history: PaymentHistory, house?: ReadonlySet<string>, topPayers = 10): Tally {
  return computeTally(history.payments, { window: history.recent, house, topPayers });
}

const PAYEE_TOPIC = `0x${"0".repeat(24)}${MAINNET.FEE_PAYEE.slice(2).toLowerCase()}`;

/** `cast logs` for every IMD transfer to the fee address in a block range, against the public RPC. */
export function paymentsCommand(window: Pick<TallyWindow, "fromBlock" | "toBlock"> | null): string {
  const from = window?.fromBlock ?? "<from-block>";
  const to = window?.toBlock ?? "<to-block>";
  return `cast logs --address ${MAINNET.IMD} --from-block ${from} --to-block ${to} ${TOPIC.TRANSFER} "" ${PAYEE_TOPIC} --rpc-url ${PUBLIC_RPC} --json`;
}

export const jobsReportPage: PageDef<JobsReportModel> = {
  id: "jobs-report",
  pattern: "/jobs-report",
  async load({ sources, now }) {
    const { chain, house, deployments } = sources;
    const [history, prints, feeds] = await Promise.all([
      chain.payments().then(
        (value) => ({ value, error: null as string | null }),
        (error: unknown) => ({ value: null, error: messageOf(error) }),
      ),
      house.report(14),
      // For the window each attached count covers: the hires feed's own rounds.
      house.feeds(),
    ]);

    const h = history.value;
    const tally = h ? releaseTally(h, houseSet(deployments)) : null;
    const w = h?.recent ?? null;
    const spanMs = w && w.fromTime !== null && w.toTime !== null ? (w.toTime - w.fromTime) * 1000 : null;

    let coverage: JobsReportModel["coverage"] = null;
    let earlier: JobsReportModel["earlier"] = null;
    if (h && w) {
      const blocks = w.toBlock - w.fromBlock + 1;
      const archive =
        h.archive === "not_configured"
          ? "No archive RPC is configured."
          : h.archive === "running"
            ? "Older blocks are still being read from the archive RPC."
            : h.archive === "done"
              ? "Older blocks were read from the configured archive RPC."
              : `Older blocks could not be read. ${h.archiveNote ?? ""}`.trim();
      coverage = {
        span: spanMs === null ? null : formatDuration(spanMs),
        words: `${
          w.fromTime !== null && w.toTime !== null
            ? `Blocks ${formatInt(w.fromBlock)} to ${formatInt(w.toBlock)}: ${formatUtc(w.fromTime * 1000)} to ${formatUtc(w.toTime * 1000)}.`
            : `Blocks ${formatInt(w.fromBlock)} to ${formatInt(w.toBlock)}.`
        } That is the newest ${formatInt(blocks)} blocks${
          blocks === PUBLIC_LOG_WINDOW_BLOCKS ? ", one day's worth" : ""
        }: a range the public RPC serves, so the commands below reproduce every figure for it.`,
        archive,
        approxTimes: h.approxTimes,
        rpcHost: chain.rpcHost,
      };
      if (h.window.fromBlock < w.fromBlock) {
        // Only the blocks before the release's range, so no payment is counted in both places. The
        // newest of these days ends where the release begins and is marked as part of a day.
        const before: TallyWindow = {
          fromBlock: h.window.fromBlock,
          toBlock: w.fromBlock - 1,
          fromTime: h.window.fromTime,
          toTime: w.fromTime,
        };
        earlier = {
          window: before,
          days: computeTally(h.payments, { window: before }).days,
          note: `These rows come from logs this server ${
            h.archive === "done" || h.archive === "running"
              ? "read from an archive RPC"
              : "read while it was running"
          }, back to block ${formatInt(h.window.fromBlock)}. A free public RPC serves logs only for roughly the newest ${formatInt(PUBLIC_LOG_WINDOW_BLOCKS)} blocks, so reproducing these rows needs an archive RPC. No figure of the release above depends on them.`,
        };
      }
    }

    const top = tally?.topPayers[0];
    const summary = tally
      ? tally.payments === 0
        ? `No IMD reached the swarm's fee address in the ${coverage?.span ?? "window"} covered.`
        : `In the ${coverage?.span ?? "window"} to block ${formatInt(tally.window.toBlock)}, ${formatImd(tally.totalWei)} IMD reached the swarm's fee address in ${formatInt(tally.payments)} payment${tally.payments === 1 ? "" : "s"} from ${formatInt(tally.payers)} employer${tally.payers === 1 ? "" : "s"}.${
            top
              ? ` The largest employer paid ${formatImd(top.totalWei)} IMD, ${percent(top.totalWei, tally.totalWei) ?? "0%"} of the total.`
              : ""
          } Payments from HELP WANTED's own wallets: ${formatImd(tally.houseWei)} IMD in ${formatInt(tally.housePayments)}.`
      : "The chain could not be read, so there is no tally to print.";

    const report = prints.live ? prints.data : null;
    const jobsReport = contractStatus(deployments, "jobsReport");
    const hiresRounds = new Map(
      (feeds.live && feeds.data
        ? (feeds.data.feeds.find((f) => f.house === "hires")?.roundList ?? [])
        : []
      ).map((round) => [round.round, round] as const),
    );
    const holds = (window: { fromBlock: number; toBlock: number }) =>
      h !== null && h.window.fromBlock <= window.fromBlock && window.toBlock <= h.window.toBlock;
    const recount = (window: { fromBlock: number; toBlock: number }) =>
      computeTally(h?.payments ?? [], { window: { ...window, fromTime: null, toTime: null } });
    const blocksOf = (window: { fromBlock: number; toBlock: number }) =>
      `${formatInt(window.fromBlock)} to ${formatInt(window.toBlock)}`;
    const sameBlocks = (
      a: { fromBlock: number; toBlock: number },
      b: { fromBlock: number; toBlock: number },
    ) => a.fromBlock === b.fromBlock && a.toBlock === b.toBlock;
    const printRows: PrintRow[] = (report?.prints ?? []).map((print) => {
      const counted = print.hiresRound !== 0;
      const round = counted ? hiresRounds.get(print.hiresRound) : undefined;
      const countWindow = round ? { fromBlock: round.fromBlock, toBlock: round.toBlock } : null;
      let check: PrintRow["check"] = null;
      if (holds(print)) {
        const own = recount(print);
        // The count is recounted over its own blocks, never over the print's: the two can differ.
        const countOverItsWindow = countWindow && holds(countWindow) ? recount(countWindow).payments : null;
        check = {
          totalWei: own.totalWei,
          payments: own.payments,
          amountAgrees: own.totalWei === print.amountWei,
          countOverItsWindow,
          countAgrees: counted && countOverItsWindow !== null ? countOverItsWindow === print.count : null,
        };
      }
      const verdict = (agrees: boolean) => (agrees ? "agrees" : "DIFFERS");
      const countWords = !counted
        ? ""
        : check?.countAgrees != null && countWindow
          ? `; ${formatInt(check.countOverItsWindow ?? 0)} payments over the count's own blocks (${blocksOf(countWindow)}): ${verdict(check.countAgrees)}`
          : countWindow
            ? `; the count is not compared: some of its own blocks (${blocksOf(countWindow)}) are older than the range this server reads`
            : "; the count is not compared: the blocks it covers could not be read";
      const checkWords = check
        ? `${formatImd(check.totalWei)} IMD over the print's blocks: ${verdict(check.amountAgrees)}${countWords}`
        : h === null
          ? "not compared: this server could not read the payment logs just now"
          : "not held by this server: some of these blocks are older than the range it reads";
      return {
        ...print,
        counted,
        countWindow,
        countWords: !counted
          ? "no count attached yet"
          : countWindow === null
            ? `${formatInt(print.count)}, over blocks that could not be read just now`
            : sameBlocks(countWindow, print)
              ? formatInt(print.count)
              : `${formatInt(print.count)}, counted over blocks ${blocksOf(countWindow)}`,
        check,
        checkWords,
        differs: check !== null && (!check.amountAgrees || check.countAgrees === false),
      };
    });
    const newest = printRows[0] ?? null;
    const printed = newest !== null;
    // The count is said to be "in" the print's blocks only when those are the blocks it covers.
    const countInHeadline = !newest?.counted
      ? ""
      : newest.countWindow === null
        ? `, with a count of ${formatInt(newest.count)} payments attached`
        : sameBlocks(newest.countWindow, newest)
          ? `, in ${formatInt(newest.count)} payments`
          : `, and ${formatInt(newest.count)} payments were counted in blocks ${blocksOf(newest.countWindow)}`;
    const headline = newest
      ? `Official print${newest.index !== null ? ` no. ${newest.index + 1}` : ""}: ${formatImd(newest.amountWei)} IMD was paid to the swarm in blocks ${formatInt(newest.fromBlock)} to ${formatInt(newest.toBlock)}${countInHeadline}, as answered by IdentityMD's oracle and stored on chain.`
      : summary;

    // ---- When the newest print was made, and what the next one waits for. ----
    let schedule: JobsReportModel["schedule"] = null;
    if (newest) {
      const pinned = pinnedPrint(jobsReport.address, newest.index);
      const payrolls =
        feeds.live && feeds.data ? (feeds.data.feeds.find((f) => f.house === "payrolls") ?? null) : null;
      const answeredAt = payrolls?.roundList.find((r) => r.round === newest.payrollsRound)?.updatedAt ?? 0;
      const lastPrintAt = pinned
        ? pinned.tx.at
        : answeredAt > 0
          ? new Date(answeredAt * 1000).toISOString()
          : null;
      const name = `print${newest.index !== null ? `, no. ${newest.index + 1},` : ""}`;
      const lastPrintWords = pinned
        ? `The last ${name} was made on ${formatUtc(pinned.tx.at)}.`
        : lastPrintAt
          ? `The last ${name} copies the payrolls round answered on ${formatUtc(lastPrintAt)}.`
          : `When the last ${name} was made could not be read just now.`;
      const meter = payrolls
        ? {
            holdsImd: formatImd(payrolls.meterWei),
            costImd: payrolls.costWei > 0n ? formatImd(payrolls.costWei) : null,
            shortImd:
              payrolls.costWei > payrolls.meterWei ? formatImd(payrolls.costWei - payrolls.meterWei) : null,
          }
        : null;
      const nextWords = !payrolls
        ? "What the next print waits for could not be read just now: the payrolls feed did not answer."
        : payrolls.pending
          ? "A round of the payrolls feed is pending: the next print waits for its answer, which anyone may then copy in with print()."
          : payrolls.costWei === 0n
            ? `The next print waits for a new answer of the payrolls feed, and no request can be bought right now. Its meter holds ${formatImd(payrolls.meterWei)} IMD (read for this page).`
            : payrolls.meterWei < payrolls.costWei
              ? `The next print waits for a new answer of the payrolls feed, and a new request needs ${formatImd(payrolls.costWei)} IMD on its meter (the Intake's price and the keeper tip). The meter holds ${formatImd(payrolls.meterWei)} IMD, read for this page, so ${formatImd(payrolls.costWei - payrolls.meterWei)} IMD more must be put on it first. Anyone may fund it, on the questions page.`
              : `The payrolls meter holds ${formatImd(payrolls.meterWei)} IMD, enough for a request at ${formatImd(payrolls.costWei)} IMD (read for this page). The next print waits for that request${payrolls.nextRequestBlock > 0 ? `, which the cadence allows from block ${formatInt(payrolls.nextRequestBlock)}` : ""}, its answer, and anyone's call to print().`;
      schedule = {
        lastPrintAt,
        lastPrintTxUrl: pinned ? etherscanTx(pinned.tx.hash) : null,
        lastPrintWords,
        meter,
        nextWords,
      };
    }
    // A release is dated by its print; until there is one, by the day it was made.
    const releasedAt = schedule?.lastPrintAt ?? now;

    return {
      generatedAt: now.toISOString(),
      releaseDay: formatUtcLongDay(releasedAt),
      releaseNumber: `HW-RJR-${utcDay(releasedAt)}-${printed ? "O" : "U"}`,
      schedule,
      payee: MAINNET.FEE_PAYEE,
      payeeUrl: etherscanAddress(MAINNET.FEE_PAYEE),
      official: {
        contract: jobsReport,
        launched: prints.live,
        printed,
        unread: prints.live && report === null,
        summary: report?.summary ?? null,
        prints: printRows,
        crown: report?.crown ?? null,
        error: prints.live ? prints.error : null,
      },
      headline,
      tally,
      tallyError: history.error ?? h?.error ?? null,
      coverage,
      earlier,
      summary,
      commands: [
        {
          comment:
            "Every IMD transfer to the fee address in the block range of this release (one log per payment).",
          command: `${paymentsCommand(tally?.window ?? null)} > payments.json`,
        },
        {
          comment: "The number of payments, and the IMD total (each log's data field is the amount in wei).",
          command: `jq 'length' payments.json && jq -r '.[].data' payments.json | python3 -c "import sys; print(sum(int(l,16) for l in sys.stdin)/1e18)"`,
        },
      ],
      officialCommands: [
        {
          comment:
            "The newest official print: (exists, index, (amount, count, fromBlock, toBlock, payrollsRound, hiresRound)).",
          command: castView(jobsReport.address, "JOBS_REPORT", jobsReportAbi, "latestPrint"),
        },
        {
          comment: "The running figures: prints, total IMD, counts, total count, best day, streak.",
          command: castView(jobsReport.address, "JOBS_REPORT", jobsReportAbi, "summary"),
        },
        {
          comment: "Add up the same logs yourself over a print's blocks: the IMD moved to the fee address.",
          command: `${paymentsCommand(newest ? { fromBlock: newest.fromBlock, toBlock: newest.toBlock } : null)} | jq -r '.[].data' | python3 -c "import sys; print(sum(int(l,16) for l in sys.stdin)/1e18)"`,
        },
        {
          comment:
            "Count them over the blocks the count covers (the window of the hires round the print names, which can be a few blocks off the print's): the number of IMD transfers to the fee address.",
          command: `${paymentsCommand(newest?.countWindow ?? null)} | jq length`,
        },
      ],
      flows: [previewFlow("print-report", deployments, now)],
      technicalNotes: TECHNICAL_NOTES,
      notLive: notLiveNotes(deployments, {
        B: "No payment counted here was made for an order on our desk, because there is no desk. What our own wallets and contracts paid the swarm is counted apart, as HOUSE.",
      }),
      sources: [
        liveNote("Official prints", prints),
        sourceNote(
          "Payments",
          `eth_getLogs for IMD Transfer logs to ${MAINNET.FEE_PAYEE}, through ${chain.rpcHost}`,
          h,
          history.error,
        ),
      ],
    };
  },
  meta: (m) => ({
    title: m.official.printed ? "The Robot Jobs Report" : "The Robot Jobs Report (unofficial tally)",
    description: m.headline,
  }),
  markdown(m) {
    const t = m.tally;
    const o = m.official;
    return doc(
      o.printed
        ? `**OFFICIAL RELEASE.** The figures first below are the JobsReport contract's own prints at ${link(o.contract.label, o.contract.url)}: answers bought from IdentityMD's oracle and stored on chain. This site's unofficial tally follows as a cross-check.`
        : `**UNOFFICIAL TALLY.** ${
            o.unread
              ? `The JobsReport contract is at ${o.contract.label}, but it could not be read just now, so this page does not say whether it has printed.`
              : o.launched
                ? `The JobsReport contract is live at ${o.contract.label} and has not printed yet.`
                : `The on-chain feed has not printed yet: the JobsReport contract is ${o.contract.label}.`
          } ${o.unread ? "The" : "Until it prints, the"} figures below are this site's own arithmetic over public logs, reproducible with the commands at the end.`,
      `Release ${m.releaseNumber} · ${m.releaseDay} · generated ${formatUtc(m.generatedAt)}`,
      o.error ? `The JobsReport contract could not be read just now: ${o.error}` : null,
      o.printed
        ? doc(
            "## The official release",
            m.headline,
            m.schedule
              ? `${m.schedule.lastPrintWords}${m.schedule.lastPrintTxUrl ? ` ${link("The print's transaction", m.schedule.lastPrintTxUrl)}.` : ""} ${m.schedule.nextWords}`
              : null,
            o.summary
              ? bullets([
                  `Prints so far: ${formatInt(o.summary.prints)}, ${formatImd(o.summary.totalWei)} IMD in all`,
                  `Counts recorded: ${formatInt(o.summary.counts)}, ${formatInt(o.summary.totalCount)} payments in all`,
                  `Best day: ${formatImd(o.summary.bestAmountWei)} IMD (print no. ${o.summary.bestIndex + 1})`,
                  `Days printed in a row: ${formatInt(o.summary.streak)} (longest: ${formatInt(o.summary.longestStreak)})`,
                ])
              : null,
            table(
              ["Print", "Blocks", "IMD paid", "Payments", "This site's recount of the same logs"],
              o.prints.map((p) => [
                p.index !== null ? `no. ${p.index + 1}` : "",
                `${formatInt(p.fromBlock)} to ${formatInt(p.toBlock)}`,
                formatImd(p.amountWei),
                p.countWords,
                p.checkWords,
              ]),
            ),
            "Payrolls and hires are recomputed by IdentityMD's oracle from chain data before it signs. A count is attached to the print it shares more than half its blocks with, so a count may cover a window shifted by a few blocks: this site recounts the amount over the print's blocks and the count over the count's own.",
            o.crown
              ? `Employers of the week (round ${o.crown.round}, blocks ${formatInt(o.crown.fromBlock)} to ${formatInt(o.crown.toBlock)}): ${o.crown.places.join(", ")}. This list is settled by panel agreement; IdentityMD does not recompute it.`
              : "Employers of the week: no round has been crowned. That list comes from a feed a panel judges, and the report is complete without it.",
            fence(m.officialCommands.map((c) => `# ${c.comment}\n${c.command}`).join("\n\n"), "sh"),
          ).trimEnd()
        : null,
      o.printed ? "## The unofficial tally, beside it" : "## The robot employment situation",
      m.summary,
      m.coverage ? `Coverage: ${m.coverage.words}` : null,
      t
        ? doc(
            "## Table A. Summary",
            table(
              ["Measure", "Total", "HOUSE (ours)", "OUTSIDE"],
              [
                [
                  "Non-human payrolls, IMD",
                  formatImd(t.totalWei),
                  formatImd(t.houseWei),
                  formatImd(t.outsideWei),
                ],
                ["Payments", formatInt(t.payments), formatInt(t.housePayments), formatInt(t.outsidePayments)],
                ["Employers (distinct payers)", formatInt(t.payers), "", ""],
                ["Largest single payment, IMD", formatImd(t.largestWei), "", ""],
              ],
            ),
            "## Table B. By UTC day",
            table(
              ["Day", "IMD paid", "Payments", "Employers", "Coverage"],
              t.days.map((d) => [
                d.day,
                formatImd(d.totalWei),
                formatInt(d.payments),
                formatInt(d.payers),
                d.partial ? "part of the day" : "whole day",
              ]),
            ),
            "## Table C. Employers of the period",
            table(
              ["Rank", "Payer", "IMD paid", "Payments", "Share", "Origin"],
              t.topPayers.map((p) => [
                p.rank,
                p.address,
                formatImd(p.totalWei),
                formatInt(p.payments),
                bpsPercent(p.shareBps),
                p.house ? "HOUSE" : "OUTSIDE",
              ]),
            ),
            "## Table D. Payments by size",
            table(
              ["Payment, IMD", "Count", "IMD in all"],
              t.sizes.map((s) => [formatImd(s.amountWei), formatInt(s.payments), formatImd(s.totalWei)]),
            ),
            t.hours.length > 0
              ? doc(
                  "## Table E. By hour (UTC)",
                  table(
                    ["Hour starting", "IMD paid", "Payments"],
                    t.hours.map((h) => [
                      `${utcDay(h.start * 1000)} ${utcClock(h.start * 1000)}`,
                      formatImd(h.totalWei),
                      formatInt(h.payments),
                    ]),
                  ),
                ).trimEnd()
              : null,
          ).trimEnd()
        : `The tally could not be computed: ${m.tallyError ?? "unknown error"}.`,
      m.earlier && m.earlier.days.length > 0
        ? doc(
            "## Table F. Earlier days held by this server",
            m.earlier.note,
            table(
              ["Day", "IMD paid", "Payments", "Employers", "Coverage"],
              m.earlier.days.map((d) => [
                d.day,
                formatImd(d.totalWei),
                formatInt(d.payments),
                formatInt(d.payers),
                d.partial ? "part of the day" : "whole day",
              ]),
            ),
          ).trimEnd()
        : null,
      o.printed
        ? null
        : doc(
            "## The official print",
            o.unread
              ? "The JobsReport contract could not be read just now. A print appears here as soon as one can be read; the commands below read the contract directly."
              : o.launched
                ? "The JobsReport contract is live and has not printed yet. A print appears here as soon as an answered round of the payrolls feed has been copied into it; anyone may call print()."
                : `Nothing has printed: the JobsReport contract is ${o.contract.label}. Once it is launched, a contract with no owner buys these figures from IdentityMD's oracle once a day, checks the signed answers and stores them, and this page leads with them.`,
            fence(m.officialCommands.map((c) => `# ${c.comment}\n${c.command}`).join("\n\n"), "sh"),
          ).trimEnd(),
      ...m.flows.map(flowMarkdown),
      m.notLive.length > 0 ? doc("## What is not live", bullets(m.notLive)).trimEnd() : null,
      "## Technical notes",
      bullets(m.technicalNotes),
      `The fee address is ${link(m.payee, m.payeeUrl)}.`,
      "## Reproduce the tally",
      fence(m.commands.map((c) => `# ${c.comment}\n${c.command}`).join("\n\n"), "sh"),
    );
  },
};
