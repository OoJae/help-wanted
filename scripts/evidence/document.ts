/**
 * The shape of `evidence/evidence.json`.
 *
 * Rules that hold for every field:
 * - an amount of IMD is a decimal string of wei (IMD has 18 decimals), its name ends in `Wei`;
 * - a count is split HOUSE and OUTSIDE (`Split`), and a zero is written as a zero;
 * - `null` means "not read because it cannot exist yet" (a launch with no address), never zero;
 * - addresses are EIP-55 checksummed, hashes lowercase.
 */
import type {
  AmountSplit,
  Counted,
  Side,
  Split,
  TransactionSplit,
} from "./house.js";

export const EVIDENCE_SCHEMA = "help-wanted-evidence-v1";

export interface PinnedBlock {
  number: number;
  hash: string;
  /** Unix seconds. */
  timestamp: number;
  /** The same moment in ISO 8601, UTC. */
  time: string;
  /** `finalized`: the node's finalized block when the run began. `chosen`: set by hand with EVIDENCE_BLOCK. */
  finality: "finalized" | "chosen";
}

export interface HouseRow {
  label: string;
  address: string;
  kind: "wallet" | "contract";
  note: string;
}

export interface ContractRow {
  key: string;
  name: string;
  source: string;
  /** Null while the deployments book holds no address. */
  address: string | null;
  /** Null for a contract that is not launched. */
  code: { nonEmpty: boolean; bytes: number; keccak256: string } | null;
  /** Whether the ProjectFactory's log in the launch transaction names this address. Null when not launched. */
  namedInLaunchTransaction: boolean | null;
  /** IMD the contract held at the pinned block. Null when not launched. */
  imdHeldWei: string | null;
  /** Every event of the contract's ABI with how often it was logged. Null when not launched. */
  events: Record<string, Split & { countedFor: string }> | null;
}

export interface LaunchTransaction {
  hash: string;
  block: number;
  /** ISO 8601, UTC. */
  time: string;
  from: string;
  to: string;
  succeeded: boolean;
  /** The launch number in the ProjectFactory's log of this transaction, or null when no such log is in it. */
  factoryLaunchNumber: number | null;
}

export interface Check {
  /** What is compared, in words. */
  what: string;
  /** What the builder counted from the logs, or what the deployments book or the protocol's address list says. */
  expected: string;
  expectedFrom:
    | "logs"
    | "the deployments book"
    | "IdentityMD's addresses in packages/shared";
  /** What the contract itself answered at the pinned block. */
  contractSays: string;
  agree: boolean;
}

export interface FeedRow {
  feedId: string;
  /** `payrolls`, `hires` or `employers` for a house feed, null for any other. */
  houseFeed: string | null;
  creator: string;
  side: Side;
  createdTx: string;
  createdBlock: number;
  cadenceBlocks: number;
  /** IMD on the meter at the pinned block. */
  meterWei: string;
  rounds: {
    opened: number;
    answeredBySubmit: number;
    answeredByCallback: number;
    closed: number;
    pending: number;
  };
  /** The newest answer the contract holds, or null when it holds none. */
  latest: {
    round: number;
    value: string;
    fromBlock: number;
    toBlock: number;
    updatedAt: number;
  } | null;
}

export type RoundEnding =
  | "answered by submit"
  | "answered by the Intake's callback"
  | "closed without an answer"
  | "pending";

export interface RoundRow {
  feedId: string;
  houseFeed: string | null;
  round: number;
  /** The oracle request this round bought: the `request` transaction and the Intake's id for it. */
  request: {
    tx: string;
    block: number;
    time: string;
    intakeRequestId: string;
    questionHash: string;
    fromBlock: number;
    toBlock: number;
    priceWei: string;
    tipWei: string;
  };
  opener: string;
  openerSide: Side;
  ending: RoundEnding;
  /** Null while the round is pending. */
  ended: {
    tx: string;
    block: number;
    time: string;
    /** Who handed the answer in or closed the round. For the callback this is the Intake. */
    by: string;
    /** Null for the Intake's callback: the protocol's own delivery is neither HOUSE nor OUTSIDE. */
    bySide: Side | null;
  } | null;
  /** Null unless the round was answered. */
  answer: {
    /** The answer as the one word the contract stores. */
    value: string;
    /** The figure the oracle signed. */
    figure: string;
    agreed: number;
    /** The oracle request's id at IdentityMD, when the attestation's id is a UUID. */
    oracleRequestId: string;
  } | null;
}

export interface PrintRow {
  index: number;
  tx: string;
  block: number;
  time: string;
  printedBy: string;
  side: Side;
  /** IMD paid to the swarm in the window, as the payrolls feed answered. */
  amountWei: string;
  payrollsRound: number;
  fromBlock: number;
  toBlock: number;
  totalWei: string;
  streak: number;
  bestDay: boolean;
  /** The number of payments, from the hires feed, with the hires round's own window. Null until attached. */
  count: {
    count: string;
    hiresRound: number;
    fromBlock: number | null;
    toBlock: number | null;
  } | null;
}

export interface CrownRow {
  round: number;
  tx: string;
  block: number;
  first: string;
  second: string;
  third: string;
  fromBlock: number;
  toBlock: number;
}

export interface LaunchAEvidence {
  questions: {
    intake: string;
    feedsCreated: Split;
    feeds: FeedRow[];
    meterFunding: Counted;
    meterDefunding: Counted;
    /** Each is an oracle request bought from the Intake by the contract. */
    roundsOpened: Split;
    /** How the rounds ended, split by who opened them. The four add up to `roundsOpened`. */
    endings: {
      answeredBySubmit: Split;
      answeredByCallback: Split;
      closedWithoutAnswer: Split;
      pending: Split;
    };
    /** Answers handed in with `submit`, split by who handed them in. */
    submits: Split;
    /** What the meters paid the Intake for the requests. */
    paidToIntake: AmountSplit;
    /** Keeper tips of answered rounds, by the opener who earned them, and what keepers have taken out. */
    keeperTips: { earned: Counted; collected: Counted };
    answersRevealed: Split;
    rounds: RoundRow[];
  };
  jobsReport: {
    prints: Split;
    countsRecorded: Split;
    crowns: Split;
    roundsSkipped: Split;
    /** `summary()` at the pinned block. */
    summary: {
      prints: number;
      totalWei: string;
      counts: number;
      totalCount: string;
      bestAmountWei: string;
      bestIndex: number;
      streak: number;
      longestStreak: number;
      crowns: number;
    };
    printRows: PrintRow[];
    crownRows: CrownRow[];
  };
  payroll: {
    /** `ledger()` at the pinned block: the contract's own totals since launch. */
    ledger: {
      receivedWei: string;
      toStakersWei: string;
      toSeatsWei: string;
      toFeedsWei: string;
      drippedWei: string;
      seatClaimedWei: string;
      tipsInWei: string;
      tipsClaimedWei: string;
      feedsFundedWei: string;
      tipsToSeatsWei: string;
      feedsReleasedWei: string;
    };
    /** `owed()` and `unbooked()` at the pinned block. */
    owed: {
      stakersWei: string;
      seatsWei: string;
      tipsWei: string;
      feedsWei: string;
      totalWei: string;
    };
    unbookedWei: string;
    /** Payments through `pay`, by payer. */
    paid: Counted;
    /** Every booking, `pay` and plain transfers alike, by the sender of the booking transaction. */
    booked: Counted;
    /** Tips through `tip`, by payer. */
    tips: Counted;
    tipsClaimed: Counted;
    tipsSwept: Counted;
    drips: Counted;
    seatClaims: Counted;
    feedTopUps: Counted;
    feedBudgetReleased: Counted;
  };
}

export type OrderOutcome =
  | "open"
  | "held by a runner"
  | "job registered"
  | "delivery claimed"
  | "disputed"
  | "settled, proven by a receipt"
  | "paid on a claim, not proven"
  | "paid on a claim, proven later"
  | "cancelled"
  | "refunded";

export interface OrderRow {
  id: string;
  employer: string;
  side: Side;
  /** Which of our employer contracts opened it, when one did. */
  openedBy: "Doorbell" | "CrowdPots" | "Rules" | null;
  openedTx: string;
  openedBlock: number;
  maxPayWei: string;
  allowsClaimedPath: boolean;
  outcome: OrderOutcome;
  runner: string | null;
  /** The swarm job the runner registered, as a UUID. */
  jobId: string | null;
  recordHash: string | null;
  settledTx: string | null;
}

export interface LaunchBEvidence {
  workOrders: {
    ordersOpened: Counted;
    /** Of the orders opened, how many each of our employer contracts opened. */
    openedByOurEmployers: {
      doorbell: number;
      crowdPots: number;
      rules: number;
    };
    claimsTaken: Split;
    jobsRegistered: Split;
    settledProven: Counted;
    paidOnAClaim: Counted;
    /** Orders paid on a claim whose receipt was matched afterwards (`Proven`). */
    provenLater: Split;
    refunded: Counted;
    cancelled: Counted;
    deliveryClaims: Split;
    challenges: Split;
    arbiterDecisions: Split;
    claimsEnded: Split;
    receiptsThatDidNotSettle: Split;
    /** Paid out at settlement, over all delivered orders. */
    paidToRunnersWei: string;
    feesWei: string;
    tipsWei: string;
    payrollFallbacks: Split;
    orders: OrderRow[];
  };
  crowdPots: {
    potsOpened: Split;
    seriesOpened: Split;
    chips: Counted;
    potsFilled: Split;
    potsLaunched: Split;
    potsSettled: Split;
    refundsPaid: Counted;
  };
  doorbell: {
    rings: Split;
    hires: Counted;
    hiresSkipped: Split;
    deliveries: Split;
    funded: boolean;
    allowsClaimedPath: boolean;
  };
}

export interface LaunchCEvidence {
  rules: {
    created: Counted;
    /** Fires, by the rule's creator. */
    fired: Split;
    /** The same fires, by who called `fire`. */
    firedByCaller: Split;
    hires: Split;
    pays: Split;
    toppedUp: Counted;
    cancelled: Split;
    reconciled: Split;
    totalEscrowedWei: string;
  };
  endowments: {
    created: Split;
    deposits: Counted;
    donations: Counted;
    withdrawals: Counted;
    harvests: Counted;
    stakes: Split;
    meterTopUps: Counted;
    pendingTotalWei: string;
  };
  zap: {
    bought: Counted;
    chippedIn: Counted;
    meterFunded: Counted;
  };
}

export interface LaunchEvidence<E> {
  key: "a" | "b" | "c";
  title: string;
  /** The Foundry project the launch is imported from. */
  project: string;
  threats: string;
  /** True when the deployments book holds an address for every contract of the launch. */
  launched: boolean;
  status: string;
  launchNumber: number | null;
  transaction: LaunchTransaction | null;
  contracts: ContractRow[];
  /** The block range whose logs were read, and how many logs it held. Null when not launched. */
  logs: {
    fromBlock: number;
    toBlock: number;
    count: number;
    transactions: number;
  } | null;
  /** Null when not launched: nothing can be counted on a contract that does not exist. */
  evidence: E | null;
}

export interface IdentityMdReads {
  read: boolean;
  /** Why not, when it was not read. */
  reason: string | null;
  base: string;
  /** ISO 8601, UTC: when the first of these reads was made. They are not pinned to a block. */
  fetchedAt: string | null;
  /** IdentityMD's own public record of each launch the book holds a number for. */
  launches: {
    launch: "a" | "b" | "c";
    launchNumber: number;
    id: string;
    status: string;
    kind: string | null;
    sourceRepoUrl: string | null;
    sourceCommit: string | null;
    artifacts: { name: string; address: string; verifiedAt: string | null }[];
    /** Whether IdentityMD lists exactly the addresses the deployments book holds. */
    addressesMatchTheBook: boolean;
  }[];
  /** What IdentityMD says of the oracle request behind each round that was pending at the pinned block. */
  pendingRounds: {
    feedId: string;
    houseFeed: string | null;
    round: number;
    requestTx: string;
    /** The state of the Intake entry (`received`, `paid`, `admitted`, `completing`, `completed`, `refused`, `failed`), or null when IdentityMD does not know the transaction. */
    intakeState: string | null;
    oracleRequestId: string | null;
    /** The oracle request's status (`assessing`, `attested`, `disagreed`, ...). */
    oracleStatus: string | null;
    attestedAt: string | null;
  }[];
  /** Launches that are requested and not in the book: the pipeline job as IdentityMD describes it. */
  launchRequests: {
    launch: "a" | "b" | "c";
    jobId: string;
    state: string;
    paidBy: string | null;
    paidBySide: Side | null;
    createdAt: string;
    launchStatus: string | null;
  }[];
}

export interface EvidenceDocument {
  schema: typeof EVIDENCE_SCHEMA;
  about: string;
  chainId: number;
  pinnedBlock: PinnedBlock;
  houseRule: string;
  house: HouseRow[];
  /** Counts over all launches: how many contracts exist, and the one figure a reader asks first. */
  headline: {
    contractsInTheBook: number;
    contractsLaunched: number;
    contractsWithCode: number;
    /** Transactions that touched our contracts after their launch, by sender. */
    transactions: TransactionSplit;
  };
  launches: {
    a: LaunchEvidence<LaunchAEvidence>;
    b: LaunchEvidence<LaunchBEvidence>;
    c: LaunchEvidence<LaunchCEvidence>;
  };
  /** Logs held against the contracts' own counters at the pinned block. Every one agrees, or nothing is written. */
  checks: Check[];
  identitymd: IdentityMdReads;
  /** How the reads were made. No URL is written: an RPC URL can hold a key. */
  reads: { rpcHosts: string[]; chunkSize: number; logChunks: number };
}
