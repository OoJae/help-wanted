/**
 * Where HELP WANTED's own contracts live, as this site sees them.
 *
 * THE ADDRESSES ARE NOT IN THIS FILE. They are in the deployments book of the shared package
 * (`DEPLOYMENT_BOOK` in `packages/shared/src/deployments.ts`), the one place the bots, the indexer
 * and this site all read. When a launch is mined, its transaction, its block and its addresses are
 * written there, and every page, every twin, `/llms.txt` and `/api/v1/deployments` switch on from
 * that one edit. Until then each contract reads "not launched yet".
 *
 * What this file adds is what only a page needs: each contract's name and what it does in one
 * plain sentence, and an override from the environment for a fork or a rehearsal
 * (`HW_ADDR_<KEY>`, e.g. `HW_ADDR_WORK_ORDERS=0x…`), so that a build can be pointed at contracts
 * that are not the launched ones without touching the book.
 */
import { getAddress, isAddress, type Address, type Hex } from "viem";
import {
  CHAIN_ID,
  DEPLOYMENT_BOOK,
  flattenBook,
  launchOf,
  type ContractName,
  type DeploymentBook,
  type LaunchKey as BookLaunchKey,
} from "@help-wanted/shared";

export type ContractKey = ContractName;

/** A launch as a page names it. The shared book spells the same three in lowercase. */
export type LaunchKey = "A" | "B" | "C";

export interface LaunchInfo {
  key: LaunchKey;
  name: string;
  /** What the launch is for, in one plain sentence. */
  purpose: string;
  /** The Foundry project the launch is imported from, e.g. `launches/a-payroll`. */
  project: string;
  contracts: ContractKey[];
  /** IdentityMD's launch number, once it exists. */
  launchNumber: number | null;
  /** The one transaction that created every contract of the launch. */
  txHash: Hex | null;
  block: number | null;
}

export interface ContractInfo {
  key: ContractKey;
  name: string;
  launch: LaunchKey;
  /** What the contract does, in one plain sentence. */
  role: string;
  address: Address | null;
}

const BOOK_KEY: Record<LaunchKey, BookLaunchKey> = { A: "a", B: "b", C: "c" };
const PAGE_KEY: Record<BookLaunchKey, LaunchKey> = { a: "A", b: "B", c: "C" };

const LAUNCHES: Record<LaunchKey, { name: string; purpose: string }> = {
  A: {
    name: "Payroll and Questions",
    purpose:
      "The fee split, the Standing Questions that buy their own oracle answers, and the Robot Jobs Report.",
  },
  B: {
    name: "The hire desk",
    purpose: "The receipt check, the order escrow, crowd pots and the Doorbell demo employer.",
  },
  C: {
    name: "The company",
    purpose: "Repeating rules, endowments whose yield pays for work, and paying with ETH.",
  },
};

/** In manifest order, launch by launch. */
const CONTRACTS: Record<ContractKey, { name: string; role: string }> = {
  questions: {
    name: "Questions",
    role: "Buys oracle answers from the IdentityMD Intake on a schedule or when a line is crossed, checks the signed answer and stores it as a feed.",
  },
  jobsReport: {
    name: "JobsReport",
    role: "Turns two daily house feeds into the Robot Jobs Report: IMD paid to the swarm and the number of payments. A third, weekly feed names the top three payers.",
  },
  payroll: {
    name: "Payroll",
    role: "Receives every fee and splits it by fixed code: 50% to sIMD stakers as a seven-day stream, 30% to seat owners, 20% to the feeds.",
  },
  workProof: {
    name: "WorkProof",
    role: "Checks a work record against the WorkRegistry receipt and reads the job id, kind, objective, state and agent ids out of it. Stateless.",
  },
  workOrders: {
    name: "WorkOrders",
    role: "The hire desk: escrows IMD against a pinned job text and pays on a proven receipt or, only if the employer allowed it, on an unchallenged bonded claim.",
  },
  crowdPots: {
    name: "CrowdPots",
    role: "Many wallets chip in to commission one job; every chip is refundable pro rata if the work is not delivered.",
  },
  doorbell: {
    name: "Doorbell",
    role: "An ownerless demo employer: every 25th ring it opens an order on the hire desk from its own code.",
  },
  rules: {
    name: "Rules",
    role: "Standing sentences: WHEN a view call or a feed crosses a line, THEN hire or pay, from the rule's own escrow, as often as its creator allowed.",
  },
  endowments: {
    name: "Endowments",
    role: "Stakes deposits into sIMD; the exact principal stays withdrawable and only the yield funds a feed's meter, a pot or a recipient.",
  },
  zap: {
    name: "Zap",
    role: "Swaps ETH to IMD on the Uniswap v4 pool, with the caller's minimum and deadline, and chips into a pot or funds a feed's meter in the caller's name.",
  },
};

export const CONTRACT_KEYS = Object.keys(CONTRACTS) as ContractKey[];
export const LAUNCH_KEYS = Object.keys(LAUNCHES) as LaunchKey[];

function envName(key: ContractKey): string {
  return `HW_ADDR_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}

export interface Deployments {
  chainId: 1;
  contracts: Record<ContractKey, ContractInfo>;
  launches: Record<LaunchKey, LaunchInfo>;
  /** How many of our contracts have an address. */
  launchedCount: number;
  /** Keys whose address came from an environment variable instead of the deployments book. */
  fromEnv: ContractKey[];
}

/**
 * The deployments as this process sees them: the shared book, with any `HW_ADDR_*` override on
 * top. A value that is not an address is ignored rather than trusted.
 */
export function resolveDeployments(
  env: Record<string, string | undefined> = process.env,
  book: DeploymentBook = DEPLOYMENT_BOOK,
): Deployments {
  const flat = flattenBook(book);
  const contracts = {} as Record<ContractKey, ContractInfo>;
  const fromEnv: ContractKey[] = [];
  let launchedCount = 0;
  for (const key of CONTRACT_KEYS) {
    let address = flat[key];
    const override = env[envName(key)];
    if (override && isAddress(override, { strict: false })) {
      address = getAddress(override);
      fromEnv.push(key);
    }
    if (address) launchedCount++;
    contracts[key] = { key, ...CONTRACTS[key], launch: PAGE_KEY[launchOf(key)], address };
  }
  const launches = {} as Record<LaunchKey, LaunchInfo>;
  for (const key of LAUNCH_KEYS) {
    const record = book[BOOK_KEY[key]];
    launches[key] = {
      key,
      ...LAUNCHES[key],
      project: record.project,
      contracts: CONTRACT_KEYS.filter((c) => PAGE_KEY[launchOf(c)] === key),
      launchNumber: record.launchNumber,
      txHash: record.transaction,
      block: record.block,
    };
  }
  return { chainId: CHAIN_ID, contracts, launches, launchedCount, fromEnv };
}

/** `HW_ADDR_WORK_ORDERS` and friends, for the configuration notes. */
export function deploymentEnvNames(): Record<ContractKey, string> {
  return Object.fromEntries(CONTRACT_KEYS.map((k) => [k, envName(k)])) as Record<ContractKey, string>;
}

/** Where a launch is filled in, for the sentences that say how a page switches on. */
export const DEPLOYMENT_BOOK_PATH = "packages/shared/src/deployments.ts" as const;

export const NOT_LAUNCHED = "not launched yet" as const;
