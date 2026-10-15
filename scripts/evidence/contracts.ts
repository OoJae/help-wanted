/**
 * The ten contracts of HELP WANTED as the evidence builder sees them: where each one's source is,
 * which views are read at the pinned block, and, for every event of every contract, whom an
 * occurrence is counted for.
 *
 * That last table is the HOUSE and OUTSIDE rule made exact. Each event is counted for one account:
 *
 * - `caller`   the account the event names as having made the call (the creator of a feed, the
 *              employer that opened an order, the ringer). It is HOUSE when that account or the
 *              sender of the transaction is on the house list, so a house wallet acting through a
 *              contract of its own is still HOUSE.
 * - `named`    an account the event concerns that did not have to make the call (the owner a seat
 *              claim pays). HOUSE when that account is on the list; who sent the transaction does
 *              not matter, because anyone may send it.
 * - `subject`  an account settled by an earlier event (the round's opener, the order's employer,
 *              the rule's creator), with the side it was given then. An order of an outside
 *              employer stays OUTSIDE when a house keeper settles it.
 * - `sender`   the event names nobody: the sender of the transaction.
 * - `launch`   an event of the constructor, emitted in the launch transaction: HOUSE.
 * - `self`     something the contract itself did as an employer: HOUSE, since every contract in the
 *              deployments book is on the house list.
 *
 * Every event of every ABI has a rule. A test fails when an ABI gains an event that has none, so a
 * new event cannot be counted, or ignored, without somebody deciding how.
 */
import { addr, big, type Args } from "./args.js";
import type { HouseList, Side } from "./house.js";
import {
  answerDelivery,
  crowdPotsAbi,
  doorbellAbi,
  endowmentsAbi,
  jobsReportAbi,
  launchOf,
  payrollAbi,
  questionsAbi,
  rulesAbi,
  workOrdersAbi,
  workProofAbi,
  zapAbi,
  type Abi,
  type Address,
  type ContractName,
  type Hex,
  type LaunchKey,
} from "./shared.js";

/** An account a count is made for, with the side it has. */
export interface Subject {
  /** Lowercase. Null only when the event names nobody and no sender is known, which never happens for a mined log. */
  account: Address;
  side: Side;
}

/** What the rules know while the logs are walked in chain order. */
export interface Walk {
  house: HouseList;
  /** The Intake `Questions` is built on (`INTAKE()` at the pinned block), or null before launch A. */
  intake: Address | null;
  /** Our own addresses, lowercase, for the contracts the book holds. */
  addresses: Partial<Record<ContractName, Address>>;
  /** `feedId:round` to the keeper that opened the round. */
  roundOpener: Map<string, Subject>;
  orderEmployer: Map<string, Subject>;
  /** The runner that holds an order now (the newest claim). */
  orderRunner: Map<string, Subject>;
  potOpener: Map<string, Subject>;
  ruleCreator: Map<string, Subject>;
  endowmentCreator: Map<string, Subject>;
  /** The desk order settled in a transaction, by transaction hash: how a tip finds its order. */
  orderOfTx: Map<Hex, string>;
}

export interface LogInWalk {
  contract: ContractName;
  event: string;
  args: Args;
  txHash: Hex;
  /** Lowercase. */
  txFrom: Address;
}

export interface CountRule {
  /** Whom the event is counted for, in words, for the document. */
  of: string;
  pick: (log: LogInWalk, walk: Walk) => Subject;
}

export interface ContractSpec {
  key: ContractName;
  /** The Solidity contract, which is also the name of its build artifact. */
  name: string;
  launch: LaunchKey;
  /** The source file, from the repository root. */
  source: string;
  abi: Abi;
  /** Views without arguments read at the pinned block. */
  views: readonly string[];
  /** One rule per event of the ABI. */
  events: Record<string, CountRule>;
}

const where = (log: LogInWalk) => `${log.contract}.${log.event}`;

function caller(log: LogInWalk, walk: Walk, account: Address): Subject {
  return {
    account,
    side:
      walk.house.has(account) || walk.house.has(log.txFrom)
        ? "HOUSE"
        : "OUTSIDE",
  };
}

const callerRule = (arg: string, of: string): CountRule => ({
  of,
  pick: (log, walk) => caller(log, walk, addr(log.args, arg, where(log))),
});

const namedRule = (arg: string, of: string): CountRule => ({
  of,
  pick: (log, walk) => {
    const account = addr(log.args, arg, where(log));
    return { account, side: walk.house.sideOf(account) };
  },
});

const senderRule = (of = "the sender of the transaction"): CountRule => ({
  of,
  pick: (log, walk) => ({
    account: log.txFrom,
    side: walk.house.sideOf(log.txFrom),
  }),
});

const launchRule: CountRule = {
  of: "the launch itself (emitted by the constructor)",
  pick: (log, walk) => ({
    account: walk.addresses[log.contract] ?? log.txFrom,
    side: "HOUSE",
  }),
};

const selfRule = (of: string): CountRule => ({
  of,
  pick: (log, walk) => {
    const account = walk.addresses[log.contract];
    if (!account)
      throw new Error(`${where(log)}: the contract has no address in the book`);
    return { account, side: walk.house.sideOf(account) };
  },
});

/** A rule that looks its account up among the subjects earlier events settled. */
function subjectRule(
  of: string,
  table: (walk: Walk) => Map<string, Subject>,
  key: (log: LogInWalk) => string,
  what: string,
): CountRule {
  return {
    of,
    pick: (log, walk) => {
      const id = key(log);
      const subject = table(walk).get(id);
      if (!subject) {
        // The logs are read from the launch block, so an event about something never opened means
        // logs are missing. Counting on would be counting on a hole.
        throw new Error(
          `${where(log)} in transaction ${log.txHash} is about ${what} ${id}, which no earlier log opened. Logs are missing from what the node returned.`,
        );
      }
      return subject;
    },
  };
}

const roundKey = (log: LogInWalk) =>
  `${String(log.args.feedId).toLowerCase()}:${big(log.args, "round", where(log)).toString(10)}`;
const idKey = (arg: string) => (log: LogInWalk) =>
  big(log.args, arg, where(log)).toString(10);

const ofOpener = (of: string) =>
  subjectRule(of, (w) => w.roundOpener, roundKey, "round");
const ofEmployer = (of = "the order's employer") =>
  subjectRule(of, (w) => w.orderEmployer, idKey("id"), "order");
const ofRunner = (of = "the runner that holds the order") =>
  subjectRule(of, (w) => w.orderRunner, idKey("id"), "order");
const ofPotOpener = (of = "the pot's opener") =>
  subjectRule(of, (w) => w.potOpener, idKey("potId"), "pot");
const ofRuleCreator = (of = "the rule's creator") =>
  subjectRule(of, (w) => w.ruleCreator, idKey("id"), "rule");
const ofEndowmentCreator = (of = "the endowment's creator") =>
  subjectRule(of, (w) => w.endowmentCreator, idKey("id"), "endowment");

/** `bytes32(orderId)`, as the desk writes the memo of its fee, back to the order id. */
function memoToOrder(memo: unknown): string | null {
  if (typeof memo !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(memo))
    return null;
  return BigInt(memo).toString(10);
}

const QUESTIONS: Record<string, CountRule> = {
  OracleSignerSet: launchRule,
  EIP712DomainChanged: launchRule,
  FeedCreated: callerRule("creator", "the feed's creator"),
  Funded: callerRule("funder", "the funder"),
  FundedFor: callerRule("payer", "the payer"),
  Defunded: callerRule("funder", "the funder that took IMD back"),
  RoundOpened: callerRule("keeper", "the keeper that opened the round"),
  RoundAnswered: {
    of: "whoever handed the answer in with submit; the round's opener when the Intake's callback delivered it",
    pick: (log, walk) => {
      const deliveredBy = addr(log.args, "deliveredBy", where(log));
      if (
        walk.intake !== null &&
        answerDelivery(deliveredBy, walk.intake) === "callback"
      ) {
        return ofOpener("").pick(log, walk);
      }
      return caller(log, walk, deliveredBy);
    },
  },
  RoundFailed: senderRule(
    "whoever closed the round (the sender of the transaction)",
  ),
  CompletionSeen: senderRule(),
  AnswerRevealed: senderRule(),
  SharesRetired: senderRule(),
  SharesRescaled: senderRule(),
  TipsCollected: callerRule("keeper", "the keeper that collected"),
};

const JOBS_REPORT: Record<string, CountRule> = {
  Printed: senderRule("whoever called print (the sender of the transaction)"),
  CountRecorded: senderRule(
    "whoever called print (the sender of the transaction)",
  ),
  Counted: senderRule("whoever called print (the sender of the transaction)"),
  BestDay: senderRule("whoever called print (the sender of the transaction)"),
  RoundSkipped: senderRule(
    "whoever called print (the sender of the transaction)",
  ),
  EmployersOfTheWeek: senderRule(
    "whoever called crown (the sender of the transaction)",
  ),
};

const PAYROLL: Record<string, CountRule> = {
  Paid: {
    of: "the payer; for a fee the hire desk pays, the employer of the order named in the memo",
    pick: (log, walk) => {
      const from = addr(log.args, "from", where(log));
      if (walk.addresses.workOrders && from === walk.addresses.workOrders) {
        const order = memoToOrder(log.args.memo);
        const employer =
          order === null ? undefined : walk.orderEmployer.get(order);
        if (employer) return employer;
      }
      return caller(log, walk, from);
    },
  },
  Booked: senderRule("the sender of the transaction that booked the IMD"),
  Dripped: callerRule("caller", "the caller of drip"),
  SeatClaimed: namedRule("owner", "the seat's owner, who is paid"),
  Tipped: {
    of: "the payer; for a tip the hire desk pays, the employer of the order settled in the same transaction",
    pick: (log, walk) => {
      const from = addr(log.args, "from", where(log));
      if (walk.addresses.workOrders && from === walk.addresses.workOrders) {
        const order = walk.orderOfTx.get(log.txHash);
        const employer =
          order === undefined ? undefined : walk.orderEmployer.get(order);
        if (employer) return employer;
      }
      return caller(log, walk, from);
    },
  },
  TipClaimed: namedRule("owner", "the seat's owner, who is paid"),
  TipSwept: senderRule(),
  FeedFunded: senderRule("the sender of the transaction that called fundFeeds"),
  FeedFundingFailed: senderRule(
    "the sender of the transaction that called fundFeeds",
  ),
  FeedBudgetReleased: senderRule(
    "the sender of the transaction that called fundFeeds",
  ),
  FeedBudgetAged: senderRule(),
  StreamLevelled: senderRule(),
};

const WORK_ORDERS: Record<string, CountRule> = {
  OrderOpened: callerRule("employer", "the employer"),
  Triggered: ofEmployer(),
  Cancelled: ofEmployer(),
  Refunded: ofEmployer(),
  Claimed: callerRule("runner", "the runner"),
  Registered: ofRunner(),
  DeliveryClaimed: ofRunner(),
  Challenged: callerRule("challenger", "the challenger"),
  Resolved: callerRule("arbiter", "the arbiter"),
  ClaimEnded: ofRunner("the runner whose claim ended"),
  Failed: ofEmployer(),
  Delivered: ofEmployer(),
  Proven: ofEmployer(),
  CallbackFailed: ofEmployer(),
  Redelivered: ofEmployer(),
  PayrollFallback: ofEmployer(),
};

const CROWD_POTS: Record<string, CountRule> = {
  PotOpened: callerRule("opener", "the pot's opener"),
  SeriesOpened: callerRule("opener", "the series' opener"),
  SpecPinned: senderRule(),
  ChippedIn: callerRule("payer", "the payer of the chip"),
  PotFilled: ofPotOpener(),
  PotLaunched: callerRule("launcher", "whoever launched the pot"),
  WorkDelivered: ofPotOpener(),
  PotSettled: ofPotOpener(),
  RefundPaid: namedRule("contributor", "the contributor, who is paid"),
};

const DOORBELL: Record<string, CountRule> = {
  Rang: callerRule("ringer", "the ringer"),
  Hired: callerRule("ringer", "the ringer whose ring hired"),
  HireSkipped: senderRule("the ringer (the sender of the transaction)"),
  Delivered: selfRule("the Doorbell, as the order's employer"),
};

const RULES: Record<string, CountRule> = {
  RuleCreated: callerRule("creator", "the rule's creator"),
  ToppedUp: callerRule("from", "the payer of the top-up"),
  Fired: ofRuleCreator(),
  RuleCancelled: ofRuleCreator(),
  Recalled: ofRuleCreator(),
  Reconciled: ofRuleCreator(),
  WorkDelivered: ofRuleCreator(),
};

const ENDOWMENTS: Record<string, CountRule> = {
  Created: callerRule("creator", "the endowment's creator"),
  Deposited: callerRule("depositor", "the depositor"),
  Donated: callerRule("donor", "the donor"),
  Withdrawn: callerRule("depositor", "the depositor"),
  Harvested: callerRule("caller", "the caller of harvest"),
  MeterFunded: ofEndowmentCreator(),
  FallbackPaid: ofEndowmentCreator(),
  Settled: ofEndowmentCreator(),
  Staked: senderRule(),
  PriceMarked: senderRule(),
};

const ZAP: Record<string, CountRule> = {
  Bought: callerRule("caller", "the caller"),
  ChippedIn: callerRule("caller", "the caller"),
  MeterFunded: callerRule("caller", "the caller"),
};

const spec = (
  key: ContractName,
  name: string,
  source: string,
  abi: Abi,
  views: readonly string[],
  events: Record<string, CountRule>,
): ContractSpec => ({
  key,
  name,
  launch: launchOf(key),
  source,
  abi,
  views,
  events,
});

/** In launch and manifest order, as the deployments book lists them. */
export const CONTRACTS: readonly ContractSpec[] = [
  spec(
    "questions",
    "Questions",
    "launches/a-payroll/src/questions/Questions.sol",
    questionsAbi,
    ["INTAKE", "IMD", "oracleSigner", "feedCount", "totalMetered", "totalTips"],
    QUESTIONS,
  ),
  spec(
    "jobsReport",
    "JobsReport",
    "launches/a-payroll/src/payroll/JobsReport.sol",
    jobsReportAbi,
    ["QUESTIONS", "PAYROLLS_FEED", "HIRES_FEED", "EMPLOYERS_FEED", "summary"],
    JOBS_REPORT,
  ),
  spec(
    "payroll",
    "Payroll",
    "launches/a-payroll/src/payroll/Payroll.sol",
    payrollAbi,
    ["QUESTIONS", "ledger", "owed", "unbooked", "stream"],
    PAYROLL,
  ),
  spec(
    "workProof",
    "WorkProof",
    "launches/b-desk/src/proof/WorkProof.sol",
    workProofAbi,
    ["WORK_REGISTRY"],
    {},
  ),
  spec(
    "workOrders",
    "WorkOrders",
    "launches/b-desk/src/desk/WorkOrders.sol",
    workOrdersAbi,
    ["WORK_PROOF", "PAYROLL", "orderCount"],
    WORK_ORDERS,
  ),
  spec(
    "crowdPots",
    "CrowdPots",
    "launches/b-desk/src/pots/CrowdPots.sol",
    crowdPotsAbi,
    ["WORK_ORDERS", "potCount", "owed"],
    CROWD_POTS,
  ),
  spec(
    "doorbell",
    "Doorbell",
    "launches/b-desk/src/pots/Doorbell.sol",
    doorbellAbi,
    ["WORK_ORDERS", "ALLOW_CLAIMED", "rings", "hires", "receipts", "funded"],
    DOORBELL,
  ),
  spec(
    "rules",
    "Rules",
    "launches/c-company/src/rules/Rules.sol",
    rulesAbi,
    ["WORK_ORDERS", "ruleCount", "totalEscrowed"],
    RULES,
  ),
  spec(
    "endowments",
    "Endowments",
    "launches/c-company/src/endowments/Endowments.sol",
    endowmentsAbi,
    ["QUESTIONS", "CROWD_POTS", "endowmentCount", "pendingTotal", "epoch"],
    ENDOWMENTS,
  ),
  spec(
    "zap",
    "Zap",
    "launches/c-company/src/rules/Zap.sol",
    zapAbi,
    ["QUESTIONS", "CROWD_POTS"],
    ZAP,
  ),
];

export function contractSpec(key: ContractName): ContractSpec {
  const found = CONTRACTS.find((contract) => contract.key === key);
  if (!found) throw new Error(`no contract named ${key}`);
  return found;
}

export const LAUNCH_KEYS: readonly LaunchKey[] = ["a", "b", "c"];

/** What each launch is, in a few words, for the tables. */
export const LAUNCH_TITLES: Record<LaunchKey, string> = {
  a: "Standing Questions, the Robot Jobs Report and Payroll",
  b: "WorkProof, the hire desk, crowd pots and the Doorbell",
  c: "Rules, Endowments and Zap",
};

/**
 * The subjects an event settles for the events after it. Called for every log, after its own rule
 * has been applied, with the subject that rule gave.
 */
export function remember(log: LogInWalk, subject: Subject, walk: Walk): void {
  const at = where(log);
  if (log.contract === "questions" && log.event === "RoundOpened")
    walk.roundOpener.set(roundKey(log), subject);
  else if (log.contract === "workOrders" && log.event === "OrderOpened") {
    walk.orderEmployer.set(big(log.args, "id", at).toString(10), subject);
  } else if (log.contract === "workOrders" && log.event === "Claimed") {
    walk.orderRunner.set(big(log.args, "id", at).toString(10), subject);
  } else if (log.contract === "crowdPots" && log.event === "PotOpened") {
    walk.potOpener.set(big(log.args, "potId", at).toString(10), subject);
  } else if (log.contract === "rules" && log.event === "RuleCreated") {
    walk.ruleCreator.set(big(log.args, "id", at).toString(10), subject);
  } else if (log.contract === "endowments" && log.event === "Created") {
    walk.endowmentCreator.set(big(log.args, "id", at).toString(10), subject);
  }
}
