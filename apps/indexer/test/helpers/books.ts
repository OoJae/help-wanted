/**
 * Deployment books for tests, so that what is launched is injected and never assumed.
 *
 * Each is built on the shape of the shared package's real book (its projects, its contract names)
 * and holds stand-in addresses for exactly the launches it names. A test that is about "nothing
 * launched", "launch A only" or "everything launched" passes the matching book to `loadConfig`;
 * writing launch B and then launch C into the real book changes none of them.
 */
import type { Address, Hex } from "viem";
import { DEPLOYMENT_BOOK, type DeploymentBook, type LaunchKey } from "@help-wanted/shared";

const TEST_ADDRESSES = {
  a: {
    questions: "0x00000000000000000000000000000000000000a1",
    jobsReport: "0x00000000000000000000000000000000000000a2",
    payroll: "0x00000000000000000000000000000000000000a3",
  },
  b: {
    workProof: "0x00000000000000000000000000000000000000b1",
    workOrders: "0x00000000000000000000000000000000000000b2",
    crowdPots: "0x00000000000000000000000000000000000000b3",
    doorbell: "0x00000000000000000000000000000000000000b4",
  },
  c: {
    rules: "0x00000000000000000000000000000000000000c1",
    endowments: "0x00000000000000000000000000000000000000c2",
    zap: "0x00000000000000000000000000000000000000c3",
  },
} as const satisfies { [K in LaunchKey]: Record<keyof DeploymentBook[K]["contracts"], Address> };

/** The block, number and transaction a test book records for each launch it holds. */
export const TEST_LAUNCH = {
  a: { block: 26_150_000, launchNumber: 9001, transaction: `0x${"a1".repeat(32)}` },
  b: { block: 26_151_000, launchNumber: 9002, transaction: `0x${"b2".repeat(32)}` },
  c: { block: 26_152_000, launchNumber: 9003, transaction: `0x${"c3".repeat(32)}` },
} as const satisfies Record<LaunchKey, { block: number; launchNumber: number; transaction: Hex }>;

const emptied = (contracts: object): Record<string, null> =>
  Object.fromEntries(Object.keys(contracts).map((name) => [name, null]));

/** A deployments book in which exactly the named launches are written in. */
export function bookWith(launched: readonly LaunchKey[]): DeploymentBook {
  const record = <K extends LaunchKey>(key: K): DeploymentBook[K] =>
    (launched.includes(key)
      ? { project: DEPLOYMENT_BOOK[key].project, contracts: TEST_ADDRESSES[key], ...TEST_LAUNCH[key] }
      : {
          project: DEPLOYMENT_BOOK[key].project,
          contracts: emptied(DEPLOYMENT_BOOK[key].contracts),
          transaction: null,
          block: null,
          launchNumber: null,
        }) as DeploymentBook[K];
  return { chainId: DEPLOYMENT_BOOK.chainId, a: record("a"), b: record("b"), c: record("c") };
}

export const BOOKS = {
  /** Before any launch. */
  none: bookWith([]),
  /** Launch A only: Questions, JobsReport and Payroll exist, the hire desk and the company do not. */
  aOnly: bookWith(["a"]),
  /** All three launches. */
  all: bookWith(["a", "b", "c"]),
} as const;
