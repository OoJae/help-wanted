/**
 * `EVIDENCE.md` from the evidence document. Pure: the same document gives the same text.
 *
 * The Markdown file says nothing the JSON file does not hold. It is the same facts laid out for a
 * person: what was read and at which block, what exists, every count with HOUSE and OUTSIDE beside
 * it, and, as plainly, what does not exist yet.
 */
import type {
  ContractRow,
  EvidenceDocument,
  LaunchAEvidence,
  LaunchBEvidence,
  LaunchCEvidence,
  LaunchEvidence,
} from "./document.js";
import { code, imd, int, table, utc } from "./format.js";
import type { AmountSplit, Counted, Split } from "./house.js";

const ETHERSCAN = "https://etherscan.io";
const txLink = (hash: string) => `[\`${hash}\`](${ETHERSCAN}/tx/${hash})`;
const addressLink = (address: string) =>
  `[\`${address}\`](${ETHERSCAN}/address/${address})`;

/** How many rows of a long list the Markdown shows; the JSON file always has all of them. */
export const MAX_ROWS = 60;

type CountRow = [string, string, string, string];

const splitRow = (what: string, split: Split): CountRow => [
  what,
  int(split.total),
  int(split.house),
  int(split.outside),
];
const amountRow = (what: string, amount: AmountSplit): CountRow => [
  what,
  imd(amount.totalWei),
  imd(amount.houseWei),
  imd(amount.outsideWei),
];

/** A count, and under it the IMD it carried when it carries one. */
function countRows(
  what: string,
  counted: Counted,
  amountLabel = `${what}, IMD`,
): CountRow[] {
  return counted.imd
    ? [splitRow(what, counted), amountRow(amountLabel, counted.imd)]
    : [splitRow(what, counted)];
}

const counts = (rows: CountRow[]) =>
  table(["What", "Total", "HOUSE", "OUTSIDE"], rows);

function newest<T>(rows: readonly T[]): { shown: T[]; note: string } {
  if (rows.length <= MAX_ROWS) return { shown: [...rows], note: "" };
  return {
    shown: rows.slice(rows.length - MAX_ROWS),
    note: `\n\nThe newest ${MAX_ROWS} of ${int(rows.length)} are shown. \`evidence/evidence.json\` holds every one.`,
  };
}

/** An answer in the words of its feed. The contract stores every answer as one word. */
function answerWords(houseFeed: string | null, value: string): string {
  if (houseFeed === "payrolls") return `${imd(value)} IMD paid to the swarm`;
  if (houseFeed === "hires") return `${int(value)} payments`;
  if (houseFeed === "employers")
    return `a list of addresses; the contract stores its hash, ${value}`;
  return value;
}

const plural = (count: number | string, one: string, many: string) =>
  `${int(count)} ${String(count) === "1" ? one : many}`;

function contractsTable(doc: EvidenceDocument): string {
  const rows: (string | number | boolean | null)[][] = [];
  for (const launch of [
    doc.launches.a,
    doc.launches.b,
    doc.launches.c,
  ] as LaunchEvidence<unknown>[]) {
    for (const contract of launch.contracts as ContractRow[]) {
      rows.push(
        contract.address === null || contract.code === null
          ? [
              launch.key.toUpperCase(),
              code(contract.name),
              "not launched",
              "",
              "",
              "",
              code(contract.source),
            ]
          : [
              launch.key.toUpperCase(),
              code(contract.name),
              addressLink(contract.address),
              `${contract.code.nonEmpty ? "yes" : "NO"}: ${int(contract.code.bytes)} bytes, keccak256 ${code(contract.code.keccak256)}`,
              contract.namedInLaunchTransaction ? "yes" : "NO",
              `${imd(contract.imdHeldWei ?? "0")}`,
              code(contract.source),
            ],
      );
    }
  }
  return table(
    [
      "Launch",
      "Contract",
      "Address",
      "Code at the pinned block",
      "Named in the factory's launch log",
      "IMD held",
      "Source",
    ],
    rows,
  );
}

function eventsTable(launch: LaunchEvidence<unknown>): string {
  const rows: (string | number)[][] = [];
  for (const contract of launch.contracts) {
    for (const [name, row] of Object.entries(contract.events ?? {})) {
      rows.push([
        code(contract.name),
        code(name),
        int(row.total),
        int(row.house),
        int(row.outside),
        row.countedFor,
      ]);
    }
  }
  return table(
    ["Contract", "Event", "Total", "HOUSE", "OUTSIDE", "Counted for"],
    rows,
  );
}

function launchA(e: LaunchAEvidence): string {
  const q = e.questions;
  const feedName = (houseFeed: string | null, feedId: string) =>
    houseFeed ?? `${feedId.slice(0, 10)}…`;
  const feeds = table(
    [
      "Feed",
      "Feed id",
      "Created by",
      "Side",
      "Created in",
      "Asked every",
      "Rounds opened",
      "On the meter, IMD",
      "Newest answer",
    ],
    q.feeds.map((feed) => [
      feed.houseFeed ?? "(not a house feed)",
      code(feed.feedId),
      code(feed.creator),
      feed.side,
      txLink(feed.createdTx),
      `${int(feed.cadenceBlocks)} blocks`,
      int(feed.rounds.opened),
      imd(feed.meterWei),
      feed.latest
        ? `round ${feed.latest.round}: ${answerWords(feed.houseFeed, feed.latest.value)}`
        : "none yet",
    ]),
  );
  const rounds = newest(q.rounds);
  const roundTable = table(
    [
      "Feed",
      "Round",
      "Request (transaction)",
      "Block",
      "Asked about blocks",
      "Opened by",
      "How it ended",
      "Ended in",
      "By",
      "Answer",
    ],
    rounds.shown.map((row) => [
      feedName(row.houseFeed, row.feedId),
      row.round,
      txLink(row.request.tx),
      int(row.request.block),
      `${int(row.request.fromBlock)} to ${int(row.request.toBlock)}`,
      `${code(row.opener)} (${row.openerSide})`,
      row.ending,
      row.ended ? `${txLink(row.ended.tx)}, block ${int(row.ended.block)}` : "",
      row.ended
        ? `${code(row.ended.by)}${row.ended.bySide ? ` (${row.ended.bySide})` : " (the Intake)"}`
        : "",
      row.answer ? answerWords(row.houseFeed, row.answer.value) : "",
    ]),
  );
  const requestIds = table(
    [
      "Feed",
      "Round",
      "Intake request id",
      "Price, IMD",
      "Tip set aside, IMD",
      "Oracle request at IdentityMD",
    ],
    rounds.shown.map((row) => [
      feedName(row.houseFeed, row.feedId),
      row.round,
      code(row.request.intakeRequestId),
      imd(row.request.priceWei),
      imd(row.request.tipWei),
      row.answer ? code(row.answer.oracleRequestId) : "",
    ]),
  );

  const j = e.jobsReport;
  const prints = newest(j.printRows);
  const printTable = table(
    [
      "Print",
      "Transaction",
      "Block",
      "Time",
      "Printed by",
      "IMD paid to the swarm",
      "In blocks",
      "Payments",
      "Counted in blocks",
      "Running total, IMD",
      "Streak",
      "Best day when printed",
    ],
    prints.shown.map((row) => [
      `no. ${row.index + 1} (index ${row.index})`,
      txLink(row.tx),
      int(row.block),
      utc(row.time),
      `${code(row.printedBy)} (${row.side})`,
      imd(row.amountWei),
      `${int(row.fromBlock)} to ${int(row.toBlock)}`,
      row.count ? int(row.count.count) : "not attached yet",
      row.count && row.count.fromBlock !== null && row.count.toBlock !== null
        ? `${int(row.count.fromBlock)} to ${int(row.count.toBlock)}`
        : "",
      imd(row.totalWei),
      row.streak,
      row.bestDay ? "yes" : "no",
    ]),
  );

  const p = e.payroll;
  const ledger = table(
    ["Payroll's own total since launch", "IMD"],
    [
      ["Received and booked", imd(p.ledger.receivedWei)],
      ["Of that, to the stakers' stream", imd(p.ledger.toStakersWei)],
      ["Of that, to the seat pool", imd(p.ledger.toSeatsWei)],
      ["Of that, to the feed budget", imd(p.ledger.toFeedsWei)],
      ["Sent on to sIMD stakers", imd(p.ledger.drippedWei)],
      ["Claimed by seat owners", imd(p.ledger.seatClaimedWei)],
      ["Tips taken in", imd(p.ledger.tipsInWei)],
      ["Tips claimed", imd(p.ledger.tipsClaimedWei)],
      ["Tips that joined the seat pool", imd(p.ledger.tipsToSeatsWei)],
      ["Placed on the house feeds' meters", imd(p.ledger.feedsFundedWei)],
      ["Feed budget released to stakers", imd(p.ledger.feedsReleasedWei)],
      ["Still owed, all told", imd(p.owed.totalWei)],
      ["Arrived by plain transfer and not booked yet", imd(p.unbookedWei)],
    ],
  );

  return [
    "### Standing Questions (`Questions`)",
    "",
    `The contract is built on the Intake at ${code(q.intake)}. A round is one oracle request the contract bought from it.`,
    "",
    counts([
      splitRow("Feeds created", q.feedsCreated),
      ...countRows(
        "Meter fundings, by funder",
        q.meterFunding,
        "Put on the meters, IMD",
      ),
      ...countRows(
        "Meter withdrawals, by funder",
        q.meterDefunding,
        "Taken back from the meters, IMD",
      ),
      splitRow(
        "Rounds opened (oracle requests bought), by opener",
        q.roundsOpened,
      ),
      splitRow("Of those: answered by `submit`", q.endings.answeredBySubmit),
      splitRow(
        "Of those: answered by the Intake's callback",
        q.endings.answeredByCallback,
      ),
      splitRow(
        "Of those: closed without an answer",
        q.endings.closedWithoutAnswer,
      ),
      splitRow("Of those: pending at the pinned block", q.endings.pending),
      splitRow(
        "Answers handed in with `submit`, by who handed them in",
        q.submits,
      ),
      amountRow("Paid to the Intake for the requests, IMD", q.paidToIntake),
      ...countRows(
        "Keeper tips earned (answered rounds, by opener)",
        q.keeperTips.earned,
        "Keeper tips earned, IMD",
      ),
      ...countRows(
        "Keeper tip collections, by keeper",
        q.keeperTips.collected,
        "Keeper tips collected, IMD",
      ),
      splitRow("Lists revealed", q.answersRevealed),
    ]),
    "",
    "#### Feeds",
    "",
    q.feeds.length === 0 ? "No feed has been created." : feeds,
    "",
    "#### Rounds: every oracle request, and how it ended",
    "",
    q.rounds.length === 0
      ? "No round has been opened."
      : `${roundTable}\n\n${requestIds}${rounds.note}`,
    "",
    "### The Robot Jobs Report (`JobsReport`)",
    "",
    counts([
      splitRow("Prints, by who called `print`", j.prints),
      splitRow("Counts recorded", j.countsRecorded),
      splitRow("Employers of the week crowned", j.crowns),
      splitRow("Rounds read and skipped", j.roundsSkipped),
    ]),
    "",
    j.printRows.length === 0
      ? "Nothing has been printed."
      : `${printTable}${prints.note}`,
    "",
    "A print's amount and its count come from two feeds, each asked about its own block window, so the two windows can differ by a block or two.",
    "",
    `The contract's own summary at the pinned block: ${plural(j.summary.prints, "print", "prints")}, ${imd(j.summary.totalWei)} IMD in all; ${plural(j.summary.counts, "count", "counts")}, ${plural(j.summary.totalCount, "payment", "payments")} in all; a streak of ${int(j.summary.streak)}; ${plural(j.summary.crowns, "crown", "crowns")}.`,
    "",
    "### Payroll",
    "",
    ledger,
    "",
    counts([
      ...countRows(
        "Payments through `pay`, by payer",
        p.paid,
        "Paid through `pay`, IMD",
      ),
      ...countRows(
        "Bookings (`pay` and plain transfers), by who sent the booking",
        p.booked,
        "Booked, IMD",
      ),
      ...countRows("Tips through `tip`, by payer", p.tips, "Tipped, IMD"),
      ...countRows(
        "Tip claims, by the seat owner paid",
        p.tipsClaimed,
        "Tips claimed, IMD",
      ),
      ...countRows(
        "Sweeps of unclaimed tips to the seat pool",
        p.tipsSwept,
        "Tips swept, IMD",
      ),
      ...countRows("Drips to sIMD, by caller", p.drips, "Dripped to sIMD, IMD"),
      ...countRows(
        "Seat claims, by the seat owner paid",
        p.seatClaims,
        "Claimed by seats, IMD",
      ),
      ...countRows(
        "Meter top-ups from the feed budget",
        p.feedTopUps,
        "Placed on meters, IMD",
      ),
      ...countRows(
        "Releases of feed budget to stakers",
        p.feedBudgetReleased,
        "Feed budget released, IMD",
      ),
    ]),
  ].join("\n");
}

function launchB(e: LaunchBEvidence): string {
  const w = e.workOrders;
  const orders = newest(w.orders);
  return [
    "### The hire desk (`WorkOrders`)",
    "",
    counts([
      ...countRows(
        "Orders opened, by employer",
        w.ordersOpened,
        "Escrowed when opened (the top of each price range), IMD",
      ),
      splitRow("Claims taken, by runner", w.claimsTaken),
      splitRow("Jobs registered, by runner", w.jobsRegistered),
      ...countRows(
        "Settled, proven by a receipt, by employer",
        w.settledProven,
        "Price of those orders, IMD",
      ),
      ...countRows(
        "Paid on a claim, not proven, by employer",
        w.paidOnAClaim,
        "Price of those orders, IMD",
      ),
      splitRow(
        "Of those: proven later, when the receipt landed",
        w.provenLater,
      ),
      ...countRows(
        "Refunded, by employer",
        w.refunded,
        "Returned by refunds, IMD",
      ),
      ...countRows(
        "Cancelled, by employer",
        w.cancelled,
        "Returned by cancellations, IMD",
      ),
      splitRow("Delivery claims, by runner", w.deliveryClaims),
      splitRow("Challenges, by challenger", w.challenges),
      splitRow("Disputes decided by an arbiter", w.arbiterDecisions),
      splitRow("Claims ended without a delivery, by runner", w.claimsEnded),
      splitRow(
        "Receipts reported that did not settle an order",
        w.receiptsThatDidNotSettle,
      ),
      splitRow(
        "Settlements whose fee or tip reached Payroll by plain transfer",
        w.payrollFallbacks,
      ),
    ]),
    "",
    `Of the orders opened, our own employer contracts opened: the Doorbell ${int(w.openedByOurEmployers.doorbell)}, CrowdPots ${int(w.openedByOurEmployers.crowdPots)}, Rules ${int(w.openedByOurEmployers.rules)}. Those count as HOUSE orders; the outside part of them shows in the chips, the rings and the rules below.`,
    "",
    `Paid out at settlement over all delivered orders: ${imd(w.paidToRunnersWei)} IMD to runners, ${imd(w.feesWei)} IMD in fees to Payroll, ${imd(w.tipsWei)} IMD in tips.`,
    "",
    w.orders.length === 0
      ? "No order has been opened."
      : `${table(
          [
            "Order",
            "Employer",
            "Side",
            "Opened in",
            "Escrow, IMD",
            "Allows the claimed path",
            "Where it stands",
            "Runner",
            "Swarm job",
            "Settled in",
          ],
          orders.shown.map((row) => [
            row.id,
            `${code(row.employer)}${row.openedBy ? ` (${row.openedBy})` : ""}`,
            row.side,
            txLink(row.openedTx),
            imd(row.maxPayWei),
            row.allowsClaimedPath ? "yes" : "no",
            row.outcome,
            row.runner ? code(row.runner) : "",
            row.jobId ?? "",
            row.settledTx ? txLink(row.settledTx) : "",
          ]),
        )}${orders.note}`,
    "",
    "### Crowd pots (`CrowdPots`)",
    "",
    counts([
      splitRow("Pots opened, by opener", e.crowdPots.potsOpened),
      splitRow("Series opened, by opener", e.crowdPots.seriesOpened),
      ...countRows("Chips, by payer", e.crowdPots.chips, "Chipped in, IMD"),
      splitRow("Pots filled", e.crowdPots.potsFilled),
      splitRow(
        "Pots that hired (launched an order), by who launched",
        e.crowdPots.potsLaunched,
      ),
      splitRow("Pots settled", e.crowdPots.potsSettled),
      ...countRows(
        "Refunds paid, by contributor",
        e.crowdPots.refundsPaid,
        "Refunded to contributors, IMD",
      ),
    ]),
    "",
    "### The Doorbell",
    "",
    counts([
      splitRow("Rings, by ringer", e.doorbell.rings),
      ...countRows(
        "Hires by the Doorbell, by the ringer whose ring hired",
        e.doorbell.hires,
        "Escrowed by those hires, IMD",
      ),
      splitRow(
        "Rings that should have hired and could not (too little IMD)",
        e.doorbell.hiresSkipped,
      ),
      splitRow("Deliveries recorded", e.doorbell.deliveries),
    ]),
    "",
    `At the pinned block the Doorbell ${e.doorbell.funded ? "holds" : "does not hold"} the escrow for its next hire, and its orders ${e.doorbell.allowsClaimedPath ? "allow" : "do not allow"} the claimed path.`,
  ].join("\n");
}

function launchC(e: LaunchCEvidence): string {
  return [
    "### Rules",
    "",
    counts([
      ...countRows(
        "Rules created, by creator",
        e.rules.created,
        "Deposited at creation, IMD",
      ),
      splitRow("Fires, by the rule's creator", e.rules.fired),
      splitRow("The same fires, by who called `fire`", e.rules.firedByCaller),
      splitRow("Of the fires: hires", e.rules.hires),
      splitRow("Of the fires: payments", e.rules.pays),
      ...countRows("Top-ups, by payer", e.rules.toppedUp, "Topped up, IMD"),
      splitRow("Rules cancelled", e.rules.cancelled),
      splitRow("Orders reconciled", e.rules.reconciled),
    ]),
    "",
    `In escrow in Rules at the pinned block: ${imd(e.rules.totalEscrowedWei)} IMD.`,
    "",
    "### Endowments",
    "",
    counts([
      splitRow("Endowments created, by creator", e.endowments.created),
      ...countRows(
        "Deposits, by depositor",
        e.endowments.deposits,
        "Deposited, IMD",
      ),
      ...countRows(
        "Donations, by donor",
        e.endowments.donations,
        "Donated, IMD",
      ),
      ...countRows(
        "Withdrawals, by depositor",
        e.endowments.withdrawals,
        "Principal withdrawn, IMD",
      ),
      ...countRows(
        "Harvests, by caller",
        e.endowments.harvests,
        "Yield harvested, IMD",
      ),
      splitRow("Stakes into sIMD", e.endowments.stakes),
      ...countRows(
        "Meter top-ups paid from yield",
        e.endowments.meterTopUps,
        "Placed on meters from yield, IMD",
      ),
    ]),
    "",
    `Waiting to be staked at the pinned block: ${imd(e.endowments.pendingTotalWei)} IMD.`,
    "",
    "### Zap",
    "",
    counts([
      ...countRows(
        "Swaps handed over as IMD, by caller",
        e.zap.bought,
        "Bought and handed over, IMD",
      ),
      ...countRows(
        "Chips paid with ETH, by caller",
        e.zap.chippedIn,
        "Bought for chips, IMD",
      ),
      ...countRows(
        "Meter fundings paid with ETH, by caller",
        e.zap.meterFunded,
        "Bought for meters, IMD",
      ),
    ]),
  ].join("\n");
}

/** What a launch that does not exist yet will be counted by, so the reader knows what is missing. */
const WILL_COUNT: Record<"a" | "b" | "c", string> = {
  a: "feeds created, rounds opened and how each ended, every oracle request with its transaction, every print of the Jobs Report, Payroll's ledger and tips",
  b: "orders opened, orders settled against a receipt, orders paid on a claim, refunds, challenges, pots and chips, rings and hires by the Doorbell",
  c: "rules created and fired, endowments created, deposits and harvests, swaps through Zap",
};

function launchSection<E>(
  doc: EvidenceDocument,
  launch: LaunchEvidence<E>,
  body: (e: E) => string,
): string {
  const head = `## Launch ${launch.key.toUpperCase()}: ${launch.title}`;
  if (
    !launch.launched ||
    launch.evidence === null ||
    launch.transaction === null ||
    launch.logs === null
  ) {
    const request = doc.identitymd.launchRequests.find(
      (r) => r.launch === launch.key,
    );
    const requested = request
      ? ` A launch has been requested: IdentityMD's API described its pipeline job ${code(request.jobId)} as ${code(request.state)} when it was read (${utc(doc.identitymd.fetchedAt ?? request.createdAt)})${request.launchStatus ? `, launch status ${code(request.launchStatus)}` : ", with no launch reported yet"}. The job was created on ${utc(request.createdAt)}${request.paidBy ? ` and paid for by ${code(request.paidBy)} (${request.paidBySide})` : ""}. A requested launch is not a launch: the pipeline can still park it.`
      : "";
    return [
      head,
      "",
      `**Not launched.** The deployments book holds no address for ${launch.contracts.map((c) => code(c.name)).join(", ")}, so there is nothing on chain to read and nothing is counted.${requested}`,
      "",
      `The source is in ${code(launch.project)}; its known limits are in ${code(launch.threats)}. Once the launch's addresses are written into the book, the next run counts: ${WILL_COUNT[launch.key]}.`,
    ].join("\n");
  }
  const tx = launch.transaction;
  return [
    head,
    "",
    `**Live.** ${launch.launchNumber !== null ? `IdentityMD launch ${launch.launchNumber}. ` : ""}Created in transaction ${txLink(tx.hash)}, block ${int(tx.block)} (${utc(tx.time)}), sent by ${code(tx.from)} to ${code(tx.to)}; the transaction ${tx.succeeded ? "succeeded" : "DID NOT succeed"}.`,
    "",
    `${int(launch.logs.count)} logs of these contracts, in ${int(launch.logs.transactions)} transactions, were read from block ${int(launch.logs.fromBlock)} to block ${int(launch.logs.toBlock)}. The source is in ${code(launch.project)}; its known limits are in ${code(launch.threats)}.`,
    "",
    body(launch.evidence),
    "",
    `### Every event of launch ${launch.key.toUpperCase()}'s contracts`,
    "",
    "Every event in each contract's ABI, with how often it was logged. A row of zeros is an event that has never been logged.",
    "",
    eventsTable(launch as LaunchEvidence<unknown>),
  ].join("\n");
}

function identityMdSection(doc: EvidenceDocument): string {
  const api = doc.identitymd;
  if (!api.read) {
    return `## What IdentityMD's API said\n\nNot read in this run: ${api.reason ?? "no reason given"}. Everything else in this file comes from the chain.`;
  }
  const lines: string[] = [
    "## What IdentityMD's API said",
    "",
    `Read from ${code(api.base)} with GET requests, starting at ${utc(api.fetchedAt ?? "")}. These answers are not pinned to a block: they are what IdentityMD's service said when it was asked, and they are kept apart from the chain reads above.`,
    "",
  ];
  if (api.launches.length > 0) {
    lines.push(
      table(
        [
          "Launch",
          "IdentityMD's record",
          "Status",
          "Kind",
          "Source repository IdentityMD built from",
          "Commit",
          "Lists the book's addresses",
          "Verification time on record",
        ],
        api.launches.map((l) => [
          `${l.launch.toUpperCase()} (no. ${l.launchNumber})`,
          code(l.id),
          l.status,
          l.kind ?? "",
          l.sourceRepoUrl ?? "",
          l.sourceCommit ? code(l.sourceCommit) : "",
          l.addressesMatchTheBook ? "yes" : "NO",
          l.artifacts.every((a) => a.verifiedAt !== null)
            ? "yes, for every contract"
            : `none for ${l.artifacts
                .filter((a) => a.verifiedAt === null)
                .map((a) => a.name)
                .join(", ")}`,
        ]),
      ),
      "",
      'The last column is the `verifiedAt` field of IdentityMD\'s record for each contract: the time it records a source verification on a block explorer. "None" means the record holds no such time. `pnpm repro` compares the code at each address with a build of the source in this repository, whatever an explorer shows.',
      "",
    );
  }
  if (api.pendingRounds.length > 0) {
    lines.push(
      "Rounds that were pending at the pinned block, as IdentityMD described their oracle requests:",
      "",
      table(
        [
          "Feed",
          "Round",
          "Request (transaction)",
          "State of the Intake request",
          "Oracle request",
          "Its status",
          "Attested at",
        ],
        api.pendingRounds.map((r) => [
          r.houseFeed ?? `${r.feedId.slice(0, 10)}…`,
          r.round,
          code(r.requestTx),
          r.intakeState ?? "IdentityMD does not know the transaction",
          r.oracleRequestId ? code(r.oracleRequestId) : "",
          r.oracleStatus ?? "",
          r.attestedAt ? utc(r.attestedAt) : "",
        ]),
      ),
      "",
      "An oracle request that IdentityMD shows as attested is still pending on chain until its answer is delivered to the contract.",
      "",
    );
  } else {
    lines.push(
      "No round was pending at the pinned block, so no oracle request was looked up.",
      "",
    );
  }
  if (api.launchRequests.length > 0) {
    lines.push(
      table(
        [
          "Launch requested",
          "Pipeline job",
          "Job state",
          "Launch status",
          "Created",
          "Paid by",
        ],
        api.launchRequests.map((r) => [
          r.launch.toUpperCase(),
          code(r.jobId),
          r.state,
          r.launchStatus ?? "none reported",
          utc(r.createdAt),
          r.paidBy ? `${code(r.paidBy)} (${r.paidBySide})` : "",
        ]),
      ),
      "",
    );
  }
  return lines.join("\n").trimEnd();
}

export function render(doc: EvidenceDocument): string {
  const { a, b, c } = doc.launches;
  const pin = doc.pinnedBlock;
  const launches = [a, b, c] as LaunchEvidence<unknown>[];
  const live = launches.filter((l) => l.launched);
  const tx = doc.headline.transactions;

  const summary: string[] = [
    `- **${int(doc.headline.contractsLaunched)} of ${int(doc.headline.contractsInTheBook)} contracts are launched**, and each of them has code at its address${live.length > 0 ? ` (${live.map((l) => `launch ${l.key.toUpperCase()}`).join(", ")})` : ""}.${
      launches.filter((l) => !l.launched).length > 0
        ? ` Not launched: ${launches
            .filter((l) => !l.launched)
            .map((l) => `launch ${l.key.toUpperCase()}`)
            .join(", ")}.`
        : ""
    }`,
    `- **Transactions that touched the launched contracts after their launch: ${int(tx.total)}. HOUSE ${int(tx.house)}, OUTSIDE ${int(tx.outside)}${tx.byIdentityMd > 0 ? `, and ${int(tx.byIdentityMd)} sent by IdentityMD's own service` : ""}.**${tx.byIdentityMd > 0 ? " IdentityMD's service sends a transaction when its Intake delivers an oracle answer that was paid for; that is nobody's use of the contracts, and it is counted apart." : ""}${tx.house + tx.outside > 0 && tx.outside === 0 ? ` ${tx.byIdentityMd > 0 ? "Every other one" : "Every one"} was sent by the team's own wallets: nobody outside the team has used these contracts yet.` : ""}`,
  ];
  if (a.evidence) {
    const q = a.evidence.questions;
    const j = a.evidence.jobsReport;
    summary.push(
      `- Standing Questions: ${int(q.feedsCreated.total)} feeds created (HOUSE ${int(q.feedsCreated.house)}, OUTSIDE ${int(q.feedsCreated.outside)}); ${int(q.roundsOpened.total)} oracle requests bought (HOUSE ${int(q.roundsOpened.house)}, OUTSIDE ${int(q.roundsOpened.outside)}), of which ${int(q.endings.answeredBySubmit.total)} answered by \`submit\`, ${int(q.endings.answeredByCallback.total)} by the Intake's callback, ${int(q.endings.closedWithoutAnswer.total)} closed without an answer and ${int(q.endings.pending.total)} pending.`,
      `- Robot Jobs Report: ${int(j.prints.total)} ${j.prints.total === 1 ? "print" : "prints"} (HOUSE ${int(j.prints.house)}, OUTSIDE ${int(j.prints.outside)}), ${imd(j.summary.totalWei)} IMD and ${int(j.summary.totalCount)} payments recorded in all.`,
      `- Payroll: ${imd(a.evidence.payroll.ledger.receivedWei)} IMD received since launch, ${imd(a.evidence.payroll.ledger.tipsInWei)} IMD in tips.`,
    );
  }
  if (b.evidence) {
    const w = b.evidence.workOrders;
    summary.push(
      `- Hire desk: ${int(w.ordersOpened.total)} orders opened (HOUSE ${int(w.ordersOpened.house)}, OUTSIDE ${int(w.ordersOpened.outside)}); ${int(w.settledProven.total)} settled against a receipt, ${int(w.paidOnAClaim.total)} paid on a claim, ${int(w.refunded.total)} refunded.`,
    );
  }
  if (c.evidence) {
    summary.push(
      `- Rules: ${int(c.evidence.rules.created.total)} created, ${int(c.evidence.rules.fired.total)} fires. Endowments: ${int(c.evidence.endowments.created.total)} created.`,
    );
  }

  const parts: string[] = [
    "# HELP WANTED: evidence",
    "",
    "This file is written by `pnpm evidence` (`scripts/evidence/build.ts`) and by nothing else. Do not edit it: run the command again. The same facts, for a program, are in `evidence/evidence.json`.",
    "",
    `Everything below was read from Ethereum mainnet (chain ${doc.chainId}) at **block ${int(pin.number)}**, hash ${code(pin.hash)}, mined ${utc(pin.time)}. ${pin.finality === "finalized" ? "It was the node's finalized block when the run began, so it can no longer change." : "The block was named by hand for this run; whether it was final was not checked."} Logs were read from each launch's own block up to that block, in ranges of at most ${int(doc.reads.chunkSize)} blocks; code and views were read at that block. Read through ${doc.reads.rpcHosts.map(code).join(", ")}.`,
    "",
    'A number is here only if it was read. A zero is a count that was read and is zero. "Not launched" means there is nothing to read.',
    "",
    "## In one screen",
    "",
    ...summary,
    "",
    "## HOUSE and OUTSIDE",
    "",
    doc.houseRule,
    "",
    table(
      ["Label", "Address", "What it is", "Note"],
      doc.house.map((h) => [h.label, addressLink(h.address), h.kind, h.note]),
    ),
    "",
    "## Launches",
    "",
    table(
      [
        "Launch",
        "What it holds",
        "Status",
        "Launch transaction",
        "Block",
        "Source",
        "Known limits",
      ],
      launches.map((l) => [
        l.key.toUpperCase(),
        l.title,
        l.status,
        l.transaction ? txLink(l.transaction.hash) : "",
        l.transaction ? int(l.transaction.block) : "",
        code(l.project),
        code(l.threats),
      ]),
    ),
    "",
    "## Contracts",
    "",
    contractsTable(doc),
    "",
    '"Named in the factory\'s launch log" means: the log IdentityMD\'s ProjectFactory wrote in the launch transaction lists this address. "IMD held" is the token\'s `balanceOf` for the address at the pinned block.',
    "",
    launchSection(doc, a, launchA),
    "",
    launchSection(doc, b, launchB),
    "",
    launchSection(doc, c, launchC),
    "",
    "## Checks: the logs and the book against the chain",
    "",
    doc.checks.length === 0
      ? "Nothing is launched, so there was nothing to check."
      : "Before anything was written, what the builder counted from the logs, what the deployments book says and the addresses of IdentityMD's own contracts were held against what the chain itself answers at the pinned block. Had one of these disagreed, the run would have stopped and written nothing.",
    "",
    doc.checks.length === 0
      ? ""
      : table(
          ["What", "Expected, from", "Expected", "The chain says", "Agree"],
          doc.checks.map((ch) => [
            ch.what,
            ch.expectedFrom,
            code(ch.expected),
            code(ch.contractSays),
            ch.agree ? "yes" : "NO",
          ]),
        ),
    "",
    identityMdSection(doc),
    "",
    "## Make this file again",
    "",
    "```sh",
    "pnpm install",
    "pnpm evidence",
    "```",
    "",
    "The command reads only: it holds no key and sends no transaction. It prints the block it pinned. Settings, all optional: `RPC_URL` (one URL, or several separated by commas; the default public node keeps logs for about 9,000 blocks, so an older launch needs a node with history), `CHUNK_SIZE` (blocks per log query, default 2000), `EVIDENCE_BLOCK` (pin a block by number), `EVIDENCE_API=off` (leave IdentityMD's API out). When a read fails, or a count disagrees with a contract, nothing is written.",
    "",
  ];
  return `${parts
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}
