import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  DEPLOYMENTS,
  DEPLOYMENT_BOOK,
  deployed,
  flattenBook,
  isLaunched,
  launchBlock,
  launchOf,
  unlaunchedBook,
  type ContractName,
  type DeploymentBook,
} from "../src/index.js";
import { BUILT_CONTRACTS } from "../scripts/abi-build.js";

const NAMES: ContractName[] = [
  "questions",
  "jobsReport",
  "payroll",
  "workProof",
  "workOrders",
  "crowdPots",
  "doorbell",
  "rules",
  "endowments",
  "zap",
];

describe("the deployments book", () => {
  it("lists the ten contracts in manifest order, launch by launch", () => {
    expect(Object.keys(DEPLOYMENT_BOOK.a.contracts)).toEqual(["questions", "jobsReport", "payroll"]);
    expect(Object.keys(DEPLOYMENT_BOOK.b.contracts)).toEqual([
      "workProof",
      "workOrders",
      "crowdPots",
      "doorbell",
    ]);
    expect(Object.keys(DEPLOYMENT_BOOK.c.contracts)).toEqual(["rules", "endowments", "zap"]);
    expect(Object.keys(DEPLOYMENTS).sort()).toEqual(["chainId", ...NAMES].sort());
    expect(DEPLOYMENTS.chainId).toBe(1);
  });

  it("has an ABI generated from the build output for every contract it lists", () => {
    const built = new Set(BUILT_CONTRACTS.map((c) => c.name));
    for (const name of NAMES) expect(built.has(name), name).toBe(true);
    for (const contract of BUILT_CONTRACTS) {
      if (contract.name === "workEmployer") continue; // an interface employers implement, never deployed by us
      expect(DEPLOYMENT_BOOK[launchOf(contract.name as ContractName)].project).toBe(
        `launches/${contract.project}`,
      );
    }
  });

  it("is consistent: a launch has all of its addresses, transaction and block, or none", () => {
    for (const key of ["a", "b", "c"] as const) {
      const record = DEPLOYMENT_BOOK[key];
      const addresses = Object.values(record.contracts);
      const filled = addresses.filter((a) => a !== null);
      expect([0, addresses.length], `launch ${key} is half filled`).toContain(filled.length);
      expect(record.transaction === null, `launch ${key}: transaction`).toBe(filled.length === 0);
      expect(record.block === null, `launch ${key}: block`).toBe(filled.length === 0);
      expect(isLaunched(key)).toBe(filled.length > 0);
      for (const address of filled) expect(() => getAddress(address as string)).not.toThrow();
      if (record.transaction !== null) expect(record.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    }
    const all = NAMES.map((n) => DEPLOYMENTS[n]).filter((a) => a !== null);
    expect(new Set(all).size, "two contracts share an address").toBe(all.length);
  });

  it("gives an address once a launch is written in, and says what is missing before", () => {
    // From a book with nothing launched, so this says the same thing whatever is launched today.
    const blank = unlaunchedBook();
    const filled: DeploymentBook = {
      ...blank,
      a: {
        ...blank.a,
        contracts: {
          questions: "0x00000000000000000000000000000000000a11ce",
          jobsReport: "0x0000000000000000000000000000000000000b0b",
          payroll: "0x000000000000000000000000000000000000c0de",
        },
        transaction: `0x${"ab".repeat(32)}`,
        block: 26_200_000,
        launchNumber: 1300,
      },
    };
    const flat = flattenBook(filled);
    // Written in any letter case, read back checksummed.
    expect(deployed("questions", flat)).toBe(getAddress("0x00000000000000000000000000000000000a11ce"));
    expect(isLaunched("a", filled)).toBe(true);
    expect(launchBlock("a", filled)).toBe(26_200_000n);
    expect(isLaunched("b", filled)).toBe(false);
    expect(launchBlock("b", filled)).toBeNull();
    expect(() => deployed("workOrders", flat)).toThrow(/launch B is not written into the deployments book/);
    expect(launchOf("zap")).toBe("c");
  });

  it("the unlaunched book keeps the shape and holds no address", () => {
    const blank = unlaunchedBook();
    expect(blank.chainId).toBe(DEPLOYMENT_BOOK.chainId);
    for (const key of ["a", "b", "c"] as const) {
      expect(Object.keys(blank[key].contracts)).toEqual(Object.keys(DEPLOYMENT_BOOK[key].contracts));
      expect(Object.values(blank[key].contracts).every((a) => a === null)).toBe(true);
      expect(blank[key].project).toBe(DEPLOYMENT_BOOK[key].project);
      expect(isLaunched(key, blank)).toBe(false);
      expect(launchBlock(key, blank)).toBeNull();
    }
  });
});
