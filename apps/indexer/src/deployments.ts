/**
 * Addresses of HELP WANTED's own contracts, and the block each was deployed in.
 *
 * They come from one place: the deployments book of `@help-wanted/shared`
 * (`packages/shared/src/deployments.ts`), which the bots and the web app read too. When a launch is
 * mined, its transaction, its block and its addresses are written there, and the indexer starts
 * that launch's modules at the launch block on its next start: nothing has to be configured.
 *
 * The environment can still name a contract (`ADDR_WORK_ORDERS=0x…@26170000`), for a fork, a
 * rehearsal or a contract the book does not hold yet. An address given that way replaces the
 * book's, and must come with the block the contract was deployed in: a module reads its contract
 * from its first event. The keys are the ones the shared package uses for the same list.
 */
import { getAddress, type Address } from "viem";
import { DEPLOYMENT_BOOK, flattenBook, launchOf, type DeploymentBook } from "@help-wanted/shared";

export const OWN_CONTRACTS = [
  // Launch A
  "questions",
  "jobsReport",
  "payroll",
  // Launch B
  "workOrders",
  "crowdPots",
  "doorbell",
  // Launch C
  "rules",
  "endowments",
  "zap",
] as const;

export type OwnContract = (typeof OWN_CONTRACTS)[number];

export type Deployments = Record<OwnContract, Address | null>;

export const NO_DEPLOYMENTS: Deployments = {
  questions: null,
  jobsReport: null,
  payroll: null,
  workOrders: null,
  crowdPots: null,
  doorbell: null,
  rules: null,
  endowments: null,
  zap: null,
};

export interface BookDeployments {
  /** The address of each contract the book holds, checksummed; null for one it does not. */
  deployments: Deployments;
  /** The block each of those contracts was created in: its launch's block. Absent when the book gives none. */
  startBlocks: Partial<Record<OwnContract, number>>;
}

/**
 * What a deployments book says of the contracts the indexer has a module for. The real book is the
 * default; a test passes its own, so that what is launched is never assumed.
 *
 * (`WorkProof` is in the book and has no module here: it is stateless and emits no event.)
 */
export function deploymentsFromBook(book: DeploymentBook = DEPLOYMENT_BOOK): BookDeployments {
  const flat = flattenBook(book);
  const deployments: Deployments = { ...NO_DEPLOYMENTS };
  const startBlocks: Partial<Record<OwnContract, number>> = {};
  for (const contract of OWN_CONTRACTS) {
    const address = flat[contract];
    if (address === null) continue;
    deployments[contract] = getAddress(address);
    const block = book[launchOf(contract)].block;
    if (block !== null) startBlocks[contract] = block;
  }
  return { deployments, startBlocks };
}

/** `workOrders` → `work_orders`: the name of the module that indexes the contract. */
export function moduleNameOf(contract: OwnContract): string {
  return contract.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** `workOrders` → `ADDR_WORK_ORDERS`. */
export function deploymentEnvKey(contract: OwnContract): string {
  return `ADDR_${moduleNameOf(contract).toUpperCase()}`;
}
