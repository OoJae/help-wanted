/**
 * The deployments book: where HELP WANTED's own contracts live.
 *
 * THE ONE PLACE TO FILL IN. Each launch goes through IdentityMD's launch pipeline as one
 * transaction. When it is mined, write the launch's transaction hash, its block and the address of
 * each contract into `DEPLOYMENT_BOOK` below (the addresses are in the factory's `ContractsLaunched`
 * event and on the launch's page), and into `evidence/`. Until then every entry is null, and
 * anything that needs an address takes it from its own configuration (the bots read `QUESTIONS`,
 * `JOBS_REPORT`, `PAYROLL`, `WORK_ORDERS` from the environment and fall back to this book).
 *
 * `DEPLOYMENTS` is the same book flattened to one address per contract, which is what most callers
 * want. `deployed("questions")` gives an address or throws a sentence that says what is missing.
 */
import { getAddress, type Address, type Hex } from "viem";

export type LaunchKey = "a" | "b" | "c";

export interface LaunchRecord<Names extends string> {
  /** The Foundry project the launch was imported from. */
  project: string;
  /** The contracts in manifest order, each with its address once launched. */
  contracts: Record<Names, Address | null>;
  /** The launch transaction, and the block it was mined in: where a log reader starts. */
  transaction: Hex | null;
  block: number | null;
  /** IdentityMD's number for the launch, as its page shows it. */
  launchNumber: number | null;
}

export interface DeploymentBook {
  chainId: number;
  a: LaunchRecord<"questions" | "jobsReport" | "payroll">;
  b: LaunchRecord<"workProof" | "workOrders" | "crowdPots" | "doorbell">;
  c: LaunchRecord<"rules" | "endowments" | "zap">;
}

/** Fill this in after each launch. Addresses in any letter case; they are checksummed below. */
export const DEPLOYMENT_BOOK: DeploymentBook = {
  chainId: 1,
  a: {
    project: "launches/a-payroll",
    contracts: {
      questions: "0xeece4628ceb091c13393fc64056be8b8501fd3f6",
      jobsReport: "0x58963b57e179f7fe4e95090c21e8e9d75353bce4",
      payroll: "0x6e4362a5cec59eb3f611af6b2d81915cf5b45f1f",
    },
    transaction: "0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58",
    block: 26182869,
    launchNumber: 1531,
  },
  b: {
    project: "launches/b-desk",
    contracts: {
      workProof: "0xb268297db06985ba0b806ba97bcb90364b137469",
      workOrders: "0x730cb6c845d896e33283d3a4ed8967f8baa778d2",
      crowdPots: "0x8c2ffcdcb103659aa05c772b8f2059868b496eb5",
      doorbell: "0xfd5ab7e03e8554210faa3ccd3b9d47c622fffccb",
    },
    transaction: "0xfb28bef9c477cfe3777231d8c41f202e691673fc4cec98ecb8b07f1bfff7bf9c",
    block: 26184581,
    launchNumber: 1573,
  },
  c: {
    project: "launches/c-company",
    contracts: { rules: null, endowments: null, zap: null },
    transaction: null,
    block: null,
    launchNumber: null,
  },
};

export interface Deployments {
  chainId: number;
  /** Launch A. */
  questions: Address | null;
  jobsReport: Address | null;
  payroll: Address | null;
  /** Launch B. */
  workProof: Address | null;
  workOrders: Address | null;
  crowdPots: Address | null;
  doorbell: Address | null;
  /** Launch C. */
  rules: Address | null;
  endowments: Address | null;
  zap: Address | null;
}

export type ContractName = Exclude<keyof Deployments, "chainId">;

const checksummed = (address: Address | null): Address | null =>
  address === null ? null : getAddress(address);

/** The book flattened: one address per contract, null until its launch is written in. */
export function flattenBook(book: DeploymentBook): Deployments {
  return {
    chainId: book.chainId,
    questions: checksummed(book.a.contracts.questions),
    jobsReport: checksummed(book.a.contracts.jobsReport),
    payroll: checksummed(book.a.contracts.payroll),
    workProof: checksummed(book.b.contracts.workProof),
    workOrders: checksummed(book.b.contracts.workOrders),
    crowdPots: checksummed(book.b.contracts.crowdPots),
    doorbell: checksummed(book.b.contracts.doorbell),
    rules: checksummed(book.c.contracts.rules),
    endowments: checksummed(book.c.contracts.endowments),
    zap: checksummed(book.c.contracts.zap),
  };
}

export const DEPLOYMENTS: Deployments = flattenBook(DEPLOYMENT_BOOK);

/**
 * The same book with nothing launched: every address, transaction, block and launch number null.
 * For tests, so that what they assert does not change on the day a launch is written in above.
 */
export function unlaunchedBook(book: DeploymentBook = DEPLOYMENT_BOOK): DeploymentBook {
  const blank = <Names extends string>(record: LaunchRecord<Names>): LaunchRecord<Names> => ({
    project: record.project,
    contracts: Object.fromEntries(Object.keys(record.contracts).map((name) => [name, null])) as Record<
      Names,
      Address | null
    >,
    transaction: null,
    block: null,
    launchNumber: null,
  });
  return { chainId: book.chainId, a: blank(book.a), b: blank(book.b), c: blank(book.c) };
}

const LAUNCH_OF: Record<ContractName, LaunchKey> = {
  questions: "a",
  jobsReport: "a",
  payroll: "a",
  workProof: "b",
  workOrders: "b",
  crowdPots: "b",
  doorbell: "b",
  rules: "c",
  endowments: "c",
  zap: "c",
};

/** Which launch a contract belongs to. */
export function launchOf(name: ContractName): LaunchKey {
  return LAUNCH_OF[name];
}

/** The address of one of our contracts, or an error that says its launch is not written in yet. */
export function deployed(name: ContractName, deployments: Deployments = DEPLOYMENTS): Address {
  const address = deployments[name];
  if (address === null) {
    throw new Error(
      `${name} has no address yet: launch ${LAUNCH_OF[name].toUpperCase()} is not written into the deployments book (packages/shared/src/deployments.ts)`,
    );
  }
  return address;
}

/** True once every contract of a launch has an address. */
export function isLaunched(launch: LaunchKey, book: DeploymentBook = DEPLOYMENT_BOOK): boolean {
  return Object.values(book[launch].contracts).every((address) => address !== null);
}

/** The block a log reader starts from for a launch, or null before it. */
export function launchBlock(launch: LaunchKey, book: DeploymentBook = DEPLOYMENT_BOOK): bigint | null {
  const block = book[launch].block;
  return block === null ? null : BigInt(block);
}
