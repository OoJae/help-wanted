/**
 * From decoded logs and pinned views to the evidence. Pure: no network, no clock, no file.
 *
 * The logs of every launched contract are walked once, in chain order, and each is given the
 * account it is counted for and that account's side (`contracts.ts` holds the rule of every
 * event). Everything after that is counting: how many of an event, the sum of one of its amounts,
 * HOUSE and OUTSIDE apart. The same logs are then held against the contracts' own counters at the
 * pinned block (`checks`); the caller writes nothing unless every check agrees.
 */
import { addr, big, flag, hex, num, struct, word, type Args } from "./args.js";
import {
  contractSpec,
  remember,
  type LogInWalk,
  type Subject,
  type Walk,
} from "./contracts.js";
import type {
  Check,
  CrownRow,
  FeedRow,
  LaunchAEvidence,
  LaunchBEvidence,
  LaunchCEvidence,
  OrderOutcome,
  OrderRow,
  PrintRow,
  RoundRow,
} from "./document.js";
import {
  Tally,
  type HouseList,
  type Side,
  type Split,
  type TransactionSplit,
} from "./house.js";
import {
  answerDelivery,
  bytes16ToUuid,
  checksumAddress,
  eventNamesOf,
  houseFeedById,
  MAINNET,
  ORDER_FLAG,
  ORDER_STATE,
  type Address,
  type ContractName,
  type Hex,
} from "./shared.js";

/** A log of one of our contracts, named under its ABI, with the sender of its transaction. */
export interface DecodedLog extends LogInWalk {
  blockNumber: number;
  /** Unix seconds. */
  blockTime: number;
  logIndex: number;
}

export interface Attributed extends DecodedLog {
  subject: Subject;
}

/** What was read with `eth_call` at the pinned block, by `viewKey`. */
export type Views = ReadonlyMap<string, unknown>;

export function viewKey(
  contract: ContractName,
  fn: string,
  args: readonly unknown[] = [],
): string {
  return `${contract}.${fn}(${args.map((arg) => String(arg).toLowerCase()).join(",")})`;
}

function view(
  views: Views,
  contract: ContractName,
  fn: string,
  args: readonly unknown[] = [],
): unknown {
  const key = viewKey(contract, fn, args);
  if (!views.has(key))
    throw new Error(`${key} was not read at the pinned block`);
  return views.get(key);
}

const asArgs = (value: unknown, what: string): Args => {
  if (typeof value !== "object" || value === null)
    throw new Error(`${what} did not return what its ABI says`);
  return value as Args;
};

export function isoTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

const byChainOrder = (a: DecodedLog, b: DecodedLog) =>
  a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;

export interface WalkInput {
  house: HouseList;
  intake: Address | null;
  addresses: Partial<Record<ContractName, Address>>;
}

/** Gives every log the account it is counted for. Throws on a log whose event has no rule. */
export function attribute(
  logs: readonly DecodedLog[],
  input: WalkInput,
): Attributed[] {
  const sorted = [...logs].sort(byChainOrder);
  const walk: Walk = {
    ...input,
    roundOpener: new Map(),
    orderEmployer: new Map(),
    orderRunner: new Map(),
    potOpener: new Map(),
    ruleCreator: new Map(),
    endowmentCreator: new Map(),
    orderOfTx: new Map(),
  };
  // A tip names no order. The desk pays it inside the transaction that settles one, so the
  // settlement of each transaction is found first.
  for (const log of sorted) {
    if (log.contract === "workOrders" && log.event === "Delivered") {
      walk.orderOfTx.set(
        log.txHash,
        big(log.args, "id", "workOrders.Delivered").toString(10),
      );
    }
  }
  return sorted.map((log) => {
    const rule = contractSpec(log.contract).events[log.event];
    if (!rule) {
      throw new Error(
        `${log.contract}.${log.event} has no counting rule in scripts/evidence/contracts.ts. An event must not be counted, or left out, by accident.`,
      );
    }
    const subject = rule.pick(log, walk);
    remember(log, subject, walk);
    return { ...log, subject };
  });
}

type Pick = (log: Attributed) => boolean;

function select(
  logs: readonly Attributed[],
  contract: ContractName,
  event: string | readonly string[],
  pick?: Pick,
): Attributed[] {
  const names = typeof event === "string" ? [event] : event;
  return logs.filter(
    (log) =>
      log.contract === contract &&
      names.includes(log.event) &&
      (pick ? pick(log) : true),
  );
}

/** Counts logs by the side of their subject, adding up one amount when a reader of it is given. */
function count(
  logs: readonly Attributed[],
  amount?: (log: Attributed) => bigint,
): Tally {
  const tally = new Tally(amount !== undefined);
  for (const log of logs)
    tally.add(log.subject.side, amount ? amount(log) : 0n);
  return tally;
}

const amountOf = (name: string) => (log: Attributed) =>
  big(log.args, name, `${log.contract}.${log.event}`);

/** Every event of a contract's ABI with how often it was logged; an event never logged is a row of zeros. */
export function eventTable(
  logs: readonly Attributed[],
  contract: ContractName,
): Record<string, Split & { countedFor: string }> {
  const spec = contractSpec(contract);
  const table: Record<string, Split & { countedFor: string }> = {};
  for (const name of eventNamesOf(spec.abi)) {
    const rule = spec.events[name];
    if (!rule)
      throw new Error(
        `${contract}.${name} has no counting rule in scripts/evidence/contracts.ts`,
      );
    table[name] = {
      ...count(select(logs, contract, name)).split(),
      countedFor: rule.of,
    };
  }
  return table;
}

/**
 * Transactions that touched the given contracts, by sender. The launch transaction itself is left
 * out. A transaction sent by one of `services` (IdentityMD's own accounts) is counted apart.
 */
export function transactionsBySender(
  logs: readonly Attributed[],
  house: HouseList,
  launchTransactions: readonly string[],
  services: readonly string[] = [],
): TransactionSplit {
  const seen = new Map<string, Side | "IDENTITYMD">();
  const skip = new Set(launchTransactions.map((hash) => hash.toLowerCase()));
  const service = new Set(services.map((address) => address.toLowerCase()));
  for (const log of logs) {
    if (skip.has(log.txHash)) continue;
    if (seen.has(log.txHash)) continue;
    seen.set(
      log.txHash,
      service.has(log.txFrom.toLowerCase())
        ? "IDENTITYMD"
        : house.sideOf(log.txFrom),
    );
  }
  const tally = new Tally();
  let byIdentityMd = 0;
  for (const side of seen.values()) {
    if (side === "IDENTITYMD") byIdentityMd++;
    else tally.add(side);
  }
  const split = tally.split();
  return { ...split, total: split.total + byIdentityMd, byIdentityMd };
}

/** An address is shown with its checksum on both sides, whatever spelling it was read in. */
const shown = (value: bigint | number | string): string => {
  const text = String(value);
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? checksumAddress(text) : text;
};

const check = (
  what: string,
  expected: bigint | number | string,
  contractSays: bigint | number | string,
  expectedFrom: Check["expectedFrom"] = "logs",
): Check => {
  const left = shown(expected);
  const right = shown(contractSays);
  return {
    what,
    expected: left,
    expectedFrom,
    contractSays: right,
    agree: left === right,
  };
};

const sum = (logs: readonly Attributed[], name: string): bigint =>
  logs.reduce(
    (total, log) => total + big(log.args, name, `${log.contract}.${log.event}`),
    0n,
  );

const toUuid = (value: Hex): string =>
  /^0x[0-9a-f]{32}0{32}$/.test(value)
    ? bytes16ToUuid(value.slice(0, 34) as Hex)
    : value;

// ------------------------------------------------------------------------------------------------
// Launch A
// ------------------------------------------------------------------------------------------------

export function foldLaunchA(
  logs: readonly Attributed[],
  views: Views,
  book: { questions: Address },
): { evidence: LaunchAEvidence; checks: Check[] } {
  const checks: Check[] = [];
  const intake = addr(
    { intake: view(views, "questions", "INTAKE") },
    "intake",
    "Questions.INTAKE",
  );

  // ---- Questions: feeds and rounds ----
  const rounds = new Map<string, RoundRow>();
  const tips = new Map<string, bigint>();
  const feedOrder: string[] = [];
  const created = new Map<string, Attributed>();
  for (const log of select(logs, "questions", [
    "FeedCreated",
    "RoundOpened",
    "RoundAnswered",
    "RoundFailed",
  ])) {
    const at = `questions.${log.event}`;
    const feedId = word(log.args, "feedId", at);
    if (log.event === "FeedCreated") {
      if (!created.has(feedId)) feedOrder.push(feedId);
      created.set(feedId, log);
      continue;
    }
    const round = num(log.args, "round", at);
    const key = `${feedId}:${round}`;
    if (log.event === "RoundOpened") {
      rounds.set(key, {
        feedId,
        houseFeed: houseFeedById(feedId)?.name ?? null,
        round,
        request: {
          tx: log.txHash,
          block: log.blockNumber,
          time: isoTime(log.blockTime),
          intakeRequestId: word(log.args, "intakeRequestId", at),
          questionHash: word(log.args, "questionHash", at),
          fromBlock: num(log.args, "fromBlock", at),
          toBlock: num(log.args, "toBlock", at),
          priceWei: big(log.args, "price", at).toString(10),
          tipWei: big(log.args, "tip", at).toString(10),
        },
        opener: checksumAddress(log.subject.account),
        openerSide: log.subject.side,
        ending: "pending",
        ended: null,
        answer: null,
      });
      tips.set(key, big(log.args, "tip", at));
      continue;
    }
    const row = rounds.get(key);
    if (!row)
      throw new Error(`${at}: round ${key} was never opened in the logs read`);
    if (log.event === "RoundAnswered") {
      const deliveredBy = addr(log.args, "deliveredBy", at);
      const callback = answerDelivery(deliveredBy, intake) === "callback";
      row.ending = callback
        ? "answered by the Intake's callback"
        : "answered by submit";
      row.ended = {
        tx: log.txHash,
        block: log.blockNumber,
        time: isoTime(log.blockTime),
        by: checksumAddress(deliveredBy),
        bySide: callback ? null : log.subject.side,
      };
      row.answer = {
        value: big(log.args, "value", at).toString(10),
        figure: big(log.args, "figure", at).toString(10),
        agreed: num(log.args, "agreed", at),
        oracleRequestId: toUuid(word(log.args, "oracleRequestId", at)),
      };
    } else {
      row.ending = "closed without an answer";
      row.ended = {
        tx: log.txHash,
        block: log.blockNumber,
        time: isoTime(log.blockTime),
        by: checksumAddress(log.subject.account),
        bySide: log.subject.side,
      };
    }
  }
  const roundRows = [...rounds.values()];
  const endingTally = (ending: RoundRow["ending"]) => {
    const tally = new Tally();
    for (const row of roundRows)
      if (row.ending === ending) tally.add(row.openerSide);
    return tally.split();
  };
  const earned = new Tally(true);
  const paidToIntake = new Tally(true);
  for (const row of roundRows) {
    paidToIntake.add(row.openerSide, BigInt(row.request.priceWei));
    if (row.answer)
      earned.add(row.openerSide, tips.get(`${row.feedId}:${row.round}`) ?? 0n);
  }

  const feeds: FeedRow[] = feedOrder.map((feedId) => {
    const log = created.get(feedId) as Attributed;
    const state = asArgs(
      view(views, "questions", "feedState", [feedId]),
      "Questions.feedState",
    );
    const latest = view(views, "questions", "latest", [feedId]);
    if (!Array.isArray(latest) || latest.length < 5)
      throw new Error("Questions.latest did not return five values");
    const mine = roundRows.filter((row) => row.feedId === feedId);
    const n = (ending: RoundRow["ending"]) =>
      mine.filter((row) => row.ending === ending).length;
    const params = struct(log.args, "params", "questions.FeedCreated");
    const name = houseFeedById(feedId)?.name ?? null;
    const label = name ?? feedId.slice(0, 10);
    const latestRound = num({ round: latest[3] }, "round", "Questions.latest");
    const answered = mine.filter((row) => row.answer !== null);
    const newest =
      answered.length > 0
        ? answered.reduce((a, b) => (b.round > a.round ? b : a))
        : null;
    checks.push(
      check(
        `Questions: rounds opened on the ${label} feed`,
        mine.length,
        num(state, "rounds", "Questions.feedState"),
      ),
      check(
        `Questions: the ${label} feed has a round pending`,
        String(n("pending") > 0),
        String(flag(state, "pending", "Questions.feedState")),
      ),
      check(
        `Questions: newest answered round of the ${label} feed`,
        newest?.round ?? 0,
        latestRound,
      ),
    );
    if (newest) {
      checks.push(
        check(
          `Questions: newest answer of the ${label} feed`,
          newest.answer?.value ?? "",
          big({ v: latest[0] }, "v", "Questions.latest"),
        ),
      );
    }
    return {
      feedId,
      houseFeed: name,
      creator: checksumAddress(log.subject.account),
      side: log.subject.side,
      createdTx: log.txHash,
      createdBlock: log.blockNumber,
      cadenceBlocks: num(
        params,
        "cadenceBlocks",
        "questions.FeedCreated.params",
      ),
      meterWei: big(state, "meterBalance", "Questions.feedState").toString(10),
      rounds: {
        opened: mine.length,
        answeredBySubmit: n("answered by submit"),
        answeredByCallback: n("answered by the Intake's callback"),
        closed: n("closed without an answer"),
        pending: n("pending"),
      },
      latest:
        latestRound === 0
          ? null
          : {
              round: latestRound,
              value: big({ v: latest[0] }, "v", "Questions.latest").toString(
                10,
              ),
              fromBlock: num({ v: latest[1] }, "v", "Questions.latest"),
              toBlock: num({ v: latest[2] }, "v", "Questions.latest"),
              updatedAt: num({ v: latest[4] }, "v", "Questions.latest"),
            },
    };
  });
  const theirs = "IdentityMD's addresses in packages/shared" as const;
  const bound = (fn: string) =>
    addr({ a: view(views, "questions", fn) }, "a", `Questions.${fn}`);
  checks.unshift(
    check(
      "Questions is built on IdentityMD's Intake, version 2",
      MAINNET.INTAKE,
      intake,
      theirs,
    ),
    check("Questions pays in IMD", MAINNET.IMD, bound("IMD"), theirs),
    check(
      "Questions accepts answers signed by IdentityMD's oracle signer",
      MAINNET.ORACLE_SIGNER,
      bound("oracleSigner"),
      theirs,
    ),
    check(
      "Questions: feeds created",
      feeds.length,
      big(
        { v: view(views, "questions", "feedCount") },
        "v",
        "Questions.feedCount",
      ),
    ),
  );

  const submits = select(
    logs,
    "questions",
    "RoundAnswered",
    (log) =>
      answerDelivery(
        addr(log.args, "deliveredBy", "questions.RoundAnswered"),
        intake,
      ) === "submit",
  );

  // ---- JobsReport ----
  const summary = asArgs(
    view(views, "jobsReport", "summary"),
    "JobsReport.summary",
  );
  const printed = select(logs, "jobsReport", "Printed");
  const countRecorded = select(logs, "jobsReport", "CountRecorded");
  const crowned = select(logs, "jobsReport", "EmployersOfTheWeek");
  const bestDays = new Set(
    select(logs, "jobsReport", "BestDay").map((log) =>
      num(log.args, "index", "jobsReport.BestDay"),
    ),
  );
  const windowOfHiresRound = new Map<
    number,
    { fromBlock: number; toBlock: number }
  >();
  for (const log of countRecorded) {
    windowOfHiresRound.set(num(log.args, "round", "jobsReport.CountRecorded"), {
      fromBlock: num(log.args, "fromBlock", "jobsReport.CountRecorded"),
      toBlock: num(log.args, "toBlock", "jobsReport.CountRecorded"),
    });
  }
  const countOfPrint = new Map<number, PrintRow["count"]>();
  for (const log of select(logs, "jobsReport", "Counted")) {
    const hiresRound = num(log.args, "round", "jobsReport.Counted");
    const window = windowOfHiresRound.get(hiresRound);
    countOfPrint.set(num(log.args, "index", "jobsReport.Counted"), {
      count: big(log.args, "count", "jobsReport.Counted").toString(10),
      hiresRound,
      fromBlock: window?.fromBlock ?? null,
      toBlock: window?.toBlock ?? null,
    });
  }
  const printRows: PrintRow[] = printed.map((log) => {
    const at = "jobsReport.Printed";
    const index = num(log.args, "index", at);
    return {
      index,
      tx: log.txHash,
      block: log.blockNumber,
      time: isoTime(log.blockTime),
      printedBy: checksumAddress(log.subject.account),
      side: log.subject.side,
      amountWei: big(log.args, "amount", at).toString(10),
      payrollsRound: num(log.args, "round", at),
      fromBlock: num(log.args, "fromBlock", at),
      toBlock: num(log.args, "toBlock", at),
      totalWei: big(log.args, "total", at).toString(10),
      streak: num(log.args, "streak", at),
      bestDay: bestDays.has(index),
      count: countOfPrint.get(index) ?? null,
    };
  });
  const crownRows: CrownRow[] = crowned.map((log) => {
    const at = "jobsReport.EmployersOfTheWeek";
    return {
      round: num(log.args, "round", at),
      tx: log.txHash,
      block: log.blockNumber,
      first: checksumAddress(addr(log.args, "first", at)),
      second: checksumAddress(addr(log.args, "second", at)),
      third: checksumAddress(addr(log.args, "third", at)),
      fromBlock: num(log.args, "fromBlock", at),
      toBlock: num(log.args, "toBlock", at),
    };
  });
  checks.push(
    check(
      "JobsReport: prints",
      printed.length,
      num(summary, "prints", "JobsReport.summary"),
    ),
    check(
      "JobsReport: IMD over all prints, in wei",
      sum(printed, "amount"),
      big(summary, "total", "JobsReport.summary"),
    ),
    check(
      "JobsReport: counts recorded",
      countRecorded.length,
      num(summary, "counts", "JobsReport.summary"),
    ),
    check(
      "JobsReport: payments over all counts",
      sum(countRecorded, "count"),
      big(summary, "totalCount", "JobsReport.summary"),
    ),
    check(
      "JobsReport: crowns",
      crowned.length,
      num(summary, "crowns", "JobsReport.summary"),
    ),
    check(
      "JobsReport is bound to the Questions address in the book",
      book.questions,
      addr(
        { a: view(views, "jobsReport", "QUESTIONS") },
        "a",
        "JobsReport.QUESTIONS",
      ),
      "the deployments book",
    ),
  );

  // ---- Payroll ----
  const ledger = asArgs(view(views, "payroll", "ledger"), "Payroll.ledger");
  const owed = view(views, "payroll", "owed");
  if (!Array.isArray(owed) || owed.length < 5)
    throw new Error("Payroll.owed did not return five values");
  const wei = (name: string) =>
    big(ledger, name, "Payroll.ledger").toString(10);
  const tipped = select(logs, "payroll", "Tipped");
  const booked = select(logs, "payroll", "Booked");
  const dripped = select(logs, "payroll", "Dripped");
  const seatClaimed = select(logs, "payroll", "SeatClaimed");
  const tipClaimed = select(logs, "payroll", "TipClaimed");
  const tipSwept = select(logs, "payroll", "TipSwept");
  const released = select(logs, "payroll", "FeedBudgetReleased");
  checks.push(
    check(
      "Payroll: IMD booked, in wei",
      sum(booked, "amount"),
      big(ledger, "received", "Payroll.ledger"),
    ),
    check(
      "Payroll: tips taken in, in wei",
      sum(tipped, "amount"),
      big(ledger, "tipsIn", "Payroll.ledger"),
    ),
    check(
      "Payroll: IMD sent to sIMD, in wei",
      sum(dripped, "amount"),
      big(ledger, "dripped", "Payroll.ledger"),
    ),
    check(
      "Payroll: IMD claimed by seats, in wei",
      sum(seatClaimed, "amount"),
      big(ledger, "seatClaimed", "Payroll.ledger"),
    ),
    check(
      "Payroll: tips claimed, in wei",
      sum(tipClaimed, "amount"),
      big(ledger, "tipsClaimed", "Payroll.ledger"),
    ),
    check(
      "Payroll: tips that joined the seat pool, in wei",
      sum(tipped, "toSeatPool") + sum(tipSwept, "amount"),
      big(ledger, "tipsToSeats", "Payroll.ledger"),
    ),
    check(
      "Payroll: feed budget released to stakers, in wei",
      sum(released, "amount"),
      big(ledger, "feedsReleased", "Payroll.ledger"),
    ),
    check(
      "Payroll is bound to the Questions address in the book",
      book.questions,
      addr(
        { a: view(views, "payroll", "QUESTIONS") },
        "a",
        "Payroll.QUESTIONS",
      ),
      "the deployments book",
    ),
  );

  const evidence: LaunchAEvidence = {
    questions: {
      intake: checksumAddress(intake),
      feedsCreated: count(select(logs, "questions", "FeedCreated")).split(),
      feeds,
      meterFunding: count(
        select(logs, "questions", ["Funded", "FundedFor"]),
        amountOf("amount"),
      ).counted(),
      meterDefunding: count(
        select(logs, "questions", "Defunded"),
        amountOf("amount"),
      ).counted(),
      roundsOpened: count(select(logs, "questions", "RoundOpened")).split(),
      endings: {
        answeredBySubmit: endingTally("answered by submit"),
        answeredByCallback: endingTally("answered by the Intake's callback"),
        closedWithoutAnswer: endingTally("closed without an answer"),
        pending: endingTally("pending"),
      },
      submits: count(submits).split(),
      paidToIntake: paidToIntake.amounts(),
      keeperTips: {
        earned: earned.counted(),
        collected: count(
          select(logs, "questions", "TipsCollected"),
          amountOf("amount"),
        ).counted(),
      },
      answersRevealed: count(
        select(logs, "questions", "AnswerRevealed"),
      ).split(),
      rounds: roundRows,
    },
    jobsReport: {
      prints: count(printed).split(),
      countsRecorded: count(countRecorded).split(),
      crowns: count(crowned).split(),
      roundsSkipped: count(select(logs, "jobsReport", "RoundSkipped")).split(),
      summary: {
        prints: num(summary, "prints", "JobsReport.summary"),
        totalWei: big(summary, "total", "JobsReport.summary").toString(10),
        counts: num(summary, "counts", "JobsReport.summary"),
        totalCount: big(summary, "totalCount", "JobsReport.summary").toString(
          10,
        ),
        bestAmountWei: big(
          summary,
          "bestAmount",
          "JobsReport.summary",
        ).toString(10),
        bestIndex: num(summary, "bestIndex", "JobsReport.summary"),
        streak: num(summary, "streak", "JobsReport.summary"),
        longestStreak: num(summary, "longestStreak", "JobsReport.summary"),
        crowns: num(summary, "crowns", "JobsReport.summary"),
      },
      printRows,
      crownRows,
    },
    payroll: {
      ledger: {
        receivedWei: wei("received"),
        toStakersWei: wei("toStakers"),
        toSeatsWei: wei("toSeats"),
        toFeedsWei: wei("toFeeds"),
        drippedWei: wei("dripped"),
        seatClaimedWei: wei("seatClaimed"),
        tipsInWei: wei("tipsIn"),
        tipsClaimedWei: wei("tipsClaimed"),
        feedsFundedWei: wei("feedsFunded"),
        tipsToSeatsWei: wei("tipsToSeats"),
        feedsReleasedWei: wei("feedsReleased"),
      },
      owed: {
        stakersWei: big({ v: owed[0] }, "v", "Payroll.owed").toString(10),
        seatsWei: big({ v: owed[1] }, "v", "Payroll.owed").toString(10),
        tipsWei: big({ v: owed[2] }, "v", "Payroll.owed").toString(10),
        feedsWei: big({ v: owed[3] }, "v", "Payroll.owed").toString(10),
        totalWei: big({ v: owed[4] }, "v", "Payroll.owed").toString(10),
      },
      unbookedWei: big(
        { v: view(views, "payroll", "unbooked") },
        "v",
        "Payroll.unbooked",
      ).toString(10),
      paid: count(
        select(logs, "payroll", "Paid"),
        amountOf("amount"),
      ).counted(),
      booked: count(booked, amountOf("amount")).counted(),
      tips: count(tipped, amountOf("amount")).counted(),
      tipsClaimed: count(tipClaimed, amountOf("amount")).counted(),
      tipsSwept: count(tipSwept, amountOf("amount")).counted(),
      drips: count(dripped, amountOf("amount")).counted(),
      seatClaims: count(seatClaimed, amountOf("amount")).counted(),
      feedTopUps: count(
        select(logs, "payroll", "FeedFunded"),
        amountOf("amount"),
      ).counted(),
      feedBudgetReleased: count(released, amountOf("amount")).counted(),
    },
  };
  return { evidence, checks };
}

// ------------------------------------------------------------------------------------------------
// Launch B
// ------------------------------------------------------------------------------------------------

export function foldLaunchB(
  logs: readonly Attributed[],
  views: Views,
  book: {
    workProof: Address;
    workOrders: Address;
    crowdPots: Address;
    doorbell: Address;
    /** Launch A's Payroll and launch C's Rules, when the book holds them. */
    payroll: Address | null;
    rules: Address | null;
  },
): { evidence: LaunchBEvidence; checks: Check[] } {
  const desk = "workOrders";
  const opened = select(logs, desk, "OrderOpened");
  const delivered = select(logs, desk, "Delivered");
  const proven = delivered.filter((log) =>
    flag(log.args, "proven", "workOrders.Delivered"),
  );
  const onClaim = delivered.filter(
    (log) => !flag(log.args, "proven", "workOrders.Delivered"),
  );
  const maxPay = (log: Attributed) =>
    big(
      struct(log.args, "params", "workOrders.OrderOpened"),
      "maxPay",
      "workOrders.OrderOpened.params",
    );
  const price = (log: Attributed) =>
    big(log.args, "runnerPay", "workOrders.Delivered") +
    big(log.args, "fee", "workOrders.Delivered") +
    big(log.args, "tip", "workOrders.Delivered");

  // ---- One row per order, by walking its events in chain order ----
  const rows = new Map<string, OrderRow>();
  const employerContracts: [string, OrderRow["openedBy"]][] = [
    [book.doorbell, "Doorbell"],
    [book.crowdPots, "CrowdPots"],
  ];
  if (book.rules) employerContracts.push([book.rules, "Rules"]);
  const stage = (row: OrderRow, outcome: OrderOutcome) => {
    row.outcome = outcome;
  };
  for (const log of select(logs, desk, [
    "OrderOpened",
    "Claimed",
    "Registered",
    "DeliveryClaimed",
    "Challenged",
    "ClaimEnded",
    "Delivered",
    "Proven",
    "Cancelled",
    "Refunded",
  ])) {
    const at = `workOrders.${log.event}`;
    const id = big(log.args, "id", at).toString(10);
    if (log.event === "OrderOpened") {
      const params = struct(log.args, "params", at);
      const employer = addr(log.args, "employer", at);
      rows.set(id, {
        id,
        employer: checksumAddress(employer),
        side: log.subject.side,
        openedBy:
          employerContracts.find(
            ([address]) => address.toLowerCase() === employer,
          )?.[1] ?? null,
        openedTx: log.txHash,
        openedBlock: log.blockNumber,
        maxPayWei: big(params, "maxPay", `${at}.params`).toString(10),
        allowsClaimedPath:
          (num(params, "flags", `${at}.params`) & ORDER_FLAG.ALLOW_CLAIMED) !==
          0,
        outcome: "open",
        runner: null,
        jobId: null,
        recordHash: null,
        settledTx: null,
      });
      continue;
    }
    const row = rows.get(id);
    if (!row)
      throw new Error(`${at}: order ${id} was never opened in the logs read`);
    switch (log.event) {
      case "Claimed":
        row.runner = checksumAddress(addr(log.args, "runner", at));
        stage(row, "held by a runner");
        break;
      case "Registered":
        row.jobId = bytes16ToUuid(hex(log.args, "jobId", at));
        stage(row, "job registered");
        break;
      case "DeliveryClaimed":
        row.recordHash = word(log.args, "recordHash", at);
        stage(row, "delivery claimed");
        break;
      case "Challenged":
        stage(row, "disputed");
        break;
      case "ClaimEnded": {
        // `next` is the state the claim's end leaves the order in: open again, or refunded.
        const next = num(log.args, "next", at);
        if (next === ORDER_STATE.Open) {
          row.runner = null;
          row.jobId = null;
          row.recordHash = null;
          stage(row, "open");
        } else if (next === ORDER_STATE.Refunded) stage(row, "refunded");
        break;
      }
      case "Delivered":
        row.runner = checksumAddress(addr(log.args, "runner", at));
        row.jobId = bytes16ToUuid(hex(log.args, "jobId", at));
        row.recordHash = word(log.args, "recordHash", at);
        row.settledTx = log.txHash;
        stage(
          row,
          flag(log.args, "proven", at)
            ? "settled, proven by a receipt"
            : "paid on a claim, not proven",
        );
        break;
      case "Proven":
        if (row.outcome === "paid on a claim, not proven")
          stage(row, "paid on a claim, proven later");
        break;
      case "Cancelled":
        stage(row, "cancelled");
        break;
      case "Refunded":
        stage(row, "refunded");
        break;
    }
  }
  const orders = [...rows.values()];
  const openedBy = (who: OrderRow["openedBy"]) =>
    orders.filter((row) => row.openedBy === who).length;

  const pots = "crowdPots";
  const bell = "doorbell";
  const potOpened = select(logs, pots, "PotOpened");
  const seriesOpened = select(logs, pots, "SeriesOpened");
  const rang = select(logs, bell, "Rang");
  const hired = select(logs, bell, "Hired");
  const bellDelivered = select(logs, bell, "Delivered");

  const address = (contract: ContractName, fn: string) =>
    addr({ a: view(views, contract, fn) }, "a", `${contract}.${fn}`);
  const counter = (contract: ContractName, fn: string) =>
    big({ v: view(views, contract, fn) }, "v", `${contract}.${fn}`);
  const checks: Check[] = [
    check(
      "WorkOrders: orders opened",
      opened.length,
      counter(desk, "orderCount"),
    ),
    check(
      "CrowdPots: pots and series opened",
      potOpened.length + seriesOpened.length,
      counter(pots, "potCount"),
    ),
    check("Doorbell: rings", rang.length, counter(bell, "rings")),
    check("Doorbell: hires", hired.length, counter(bell, "hires")),
    check(
      "Doorbell: deliveries",
      bellDelivered.length,
      counter(bell, "receipts"),
    ),
    check(
      "WorkProof reads IdentityMD's WorkRegistry",
      MAINNET.WORK_REGISTRY,
      address("workProof", "WORK_REGISTRY"),
      "IdentityMD's addresses in packages/shared",
    ),
    check(
      "WorkOrders is bound to the WorkProof address in the book",
      book.workProof,
      address(desk, "WORK_PROOF"),
      "the deployments book",
    ),
    check(
      "CrowdPots is bound to the WorkOrders address in the book",
      book.workOrders,
      address(pots, "WORK_ORDERS"),
      "the deployments book",
    ),
    check(
      "The Doorbell is bound to the WorkOrders address in the book",
      book.workOrders,
      address(bell, "WORK_ORDERS"),
      "the deployments book",
    ),
  ];
  if (book.payroll) {
    checks.push(
      check(
        "WorkOrders is bound to the Payroll address in the book",
        book.payroll,
        address(desk, "PAYROLL"),
        "the deployments book",
      ),
    );
  }

  const evidence: LaunchBEvidence = {
    workOrders: {
      ordersOpened: count(opened, maxPay).counted(),
      openedByOurEmployers: {
        doorbell: openedBy("Doorbell"),
        crowdPots: openedBy("CrowdPots"),
        rules: openedBy("Rules"),
      },
      claimsTaken: count(select(logs, desk, "Claimed")).split(),
      jobsRegistered: count(select(logs, desk, "Registered")).split(),
      settledProven: count(proven, price).counted(),
      paidOnAClaim: count(onClaim, price).counted(),
      provenLater: count(select(logs, desk, "Proven")).split(),
      refunded: count(
        select(logs, desk, "Refunded"),
        amountOf("toEmployer"),
      ).counted(),
      cancelled: count(
        select(logs, desk, "Cancelled"),
        amountOf("toEmployer"),
      ).counted(),
      deliveryClaims: count(select(logs, desk, "DeliveryClaimed")).split(),
      challenges: count(select(logs, desk, "Challenged")).split(),
      arbiterDecisions: count(select(logs, desk, "Resolved")).split(),
      claimsEnded: count(select(logs, desk, "ClaimEnded")).split(),
      receiptsThatDidNotSettle: count(select(logs, desk, "Failed")).split(),
      paidToRunnersWei: sum(delivered, "runnerPay").toString(10),
      feesWei: sum(delivered, "fee").toString(10),
      tipsWei: sum(delivered, "tip").toString(10),
      payrollFallbacks: count(select(logs, desk, "PayrollFallback")).split(),
      orders,
    },
    crowdPots: {
      potsOpened: count(potOpened).split(),
      seriesOpened: count(seriesOpened).split(),
      chips: count(
        select(logs, pots, "ChippedIn"),
        amountOf("amount"),
      ).counted(),
      potsFilled: count(select(logs, pots, "PotFilled")).split(),
      potsLaunched: count(select(logs, pots, "PotLaunched")).split(),
      potsSettled: count(select(logs, pots, "PotSettled")).split(),
      refundsPaid: count(
        select(logs, pots, "RefundPaid"),
        amountOf("amount"),
      ).counted(),
    },
    doorbell: {
      rings: count(rang).split(),
      hires: count(hired, amountOf("escrow")).counted(),
      hiresSkipped: count(select(logs, bell, "HireSkipped")).split(),
      deliveries: count(bellDelivered).split(),
      funded: flag({ v: view(views, bell, "funded") }, "v", "Doorbell.funded"),
      allowsClaimedPath: flag(
        { v: view(views, bell, "ALLOW_CLAIMED") },
        "v",
        "Doorbell.ALLOW_CLAIMED",
      ),
    },
  };
  return { evidence, checks };
}

// ------------------------------------------------------------------------------------------------
// Launch C
// ------------------------------------------------------------------------------------------------

export function foldLaunchC(
  logs: readonly Attributed[],
  views: Views,
  book: {
    questions: Address | null;
    workOrders: Address | null;
    crowdPots: Address | null;
  },
  house: HouseList,
): { evidence: LaunchCEvidence; checks: Check[] } {
  const created = select(logs, "rules", "RuleCreated");
  const fired = select(logs, "rules", "Fired");
  const byCaller = new Tally();
  for (const log of fired) {
    const caller = addr(log.args, "caller", "rules.Fired");
    byCaller.add(
      house.has(caller) || house.has(log.txFrom) ? "HOUSE" : "OUTSIDE",
    );
  }
  // A fire that hired carries the order it opened; a fire that paid carries none.
  const hires = fired.filter(
    (log) => big(log.args, "orderId", "rules.Fired") !== 0n,
  );
  const pays = fired.filter(
    (log) => big(log.args, "orderId", "rules.Fired") === 0n,
  );
  const endowed = select(logs, "endowments", "Created");

  const address = (contract: ContractName, fn: string) =>
    addr({ a: view(views, contract, fn) }, "a", `${contract}.${fn}`);
  const counter = (contract: ContractName, fn: string) =>
    big({ v: view(views, contract, fn) }, "v", `${contract}.${fn}`);
  const checks: Check[] = [
    check(
      "Rules: rules created",
      created.length,
      counter("rules", "ruleCount"),
    ),
    check(
      "Endowments: endowments created",
      endowed.length,
      counter("endowments", "endowmentCount"),
    ),
  ];
  const bound = (
    what: string,
    expected: Address | null,
    contract: ContractName,
    fn: string,
  ) => {
    if (expected)
      checks.push(
        check(what, expected, address(contract, fn), "the deployments book"),
      );
  };
  bound(
    "Rules is bound to the WorkOrders address in the book",
    book.workOrders,
    "rules",
    "WORK_ORDERS",
  );
  bound(
    "Endowments is bound to the Questions address in the book",
    book.questions,
    "endowments",
    "QUESTIONS",
  );
  bound(
    "Endowments is bound to the CrowdPots address in the book",
    book.crowdPots,
    "endowments",
    "CROWD_POTS",
  );
  bound(
    "Zap is bound to the Questions address in the book",
    book.questions,
    "zap",
    "QUESTIONS",
  );
  bound(
    "Zap is bound to the CrowdPots address in the book",
    book.crowdPots,
    "zap",
    "CROWD_POTS",
  );

  const evidence: LaunchCEvidence = {
    rules: {
      created: count(created, amountOf("deposit")).counted(),
      fired: count(fired).split(),
      firedByCaller: byCaller.split(),
      hires: count(hires).split(),
      pays: count(pays).split(),
      toppedUp: count(
        select(logs, "rules", "ToppedUp"),
        amountOf("amount"),
      ).counted(),
      cancelled: count(select(logs, "rules", "RuleCancelled")).split(),
      reconciled: count(select(logs, "rules", "Reconciled")).split(),
      totalEscrowedWei: counter("rules", "totalEscrowed").toString(10),
    },
    endowments: {
      created: count(endowed).split(),
      deposits: count(
        select(logs, "endowments", "Deposited"),
        amountOf("amount"),
      ).counted(),
      donations: count(
        select(logs, "endowments", "Donated"),
        amountOf("amount"),
      ).counted(),
      withdrawals: count(
        select(logs, "endowments", "Withdrawn"),
        amountOf("principal"),
      ).counted(),
      harvests: count(
        select(logs, "endowments", "Harvested"),
        amountOf("assets"),
      ).counted(),
      stakes: count(select(logs, "endowments", "Staked")).split(),
      meterTopUps: count(
        select(logs, "endowments", "MeterFunded"),
        amountOf("amount"),
      ).counted(),
      pendingTotalWei: counter("endowments", "pendingTotal").toString(10),
    },
    zap: {
      bought: count(
        select(logs, "zap", "Bought"),
        amountOf("imdOut"),
      ).counted(),
      chippedIn: count(
        select(logs, "zap", "ChippedIn"),
        amountOf("imdOut"),
      ).counted(),
      meterFunded: count(
        select(logs, "zap", "MeterFunded"),
        amountOf("imdOut"),
      ).counted(),
    },
  };
  return { evidence, checks };
}
