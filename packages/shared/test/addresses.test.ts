import { readFileSync } from "node:fs";
import { getAddress, stringToHex } from "viem";
import { describe, expect, it } from "vitest";
import {
  CAIP2_NETWORK,
  CHAIN_ID,
  DEPLOYMENT_BOOK,
  INTAKES,
  MAINNET,
  OFFCHAIN,
  PAID_ACTION_PRICE,
  WORK_RECORDED_TOPIC,
  WORK_REGISTRY_LATEST_SELECTOR,
  isIntake,
  lowerAddress,
  sameAddress,
} from "../src/index.js";
import { Capabilities, Health } from "../src/api/index.js";
import { fixture, readJson, repoFile, vector } from "./paths.js";

describe("addresses", () => {
  it("are EIP-55 checksummed", () => {
    for (const [name, value] of Object.entries({ ...MAINNET, ...OFFCHAIN })) {
      if (typeof value !== "string" || value.length !== 42) continue;
      expect(getAddress(value), name).toBe(value);
    }
  });

  // Each launch project keeps its own copy of Mainnet.sol and only the constants its tests use,
  // so the three copies differ. Every copy that exists is read.
  const copies = ["a-payroll", "b-desk", "c-company"]
    .map((project) => ({
      project,
      path: repoFile("launches", project, "src", "interfaces", "external", "Mainnet.sol"),
    }))
    .filter((copy): copy is { project: string; path: string } => copy.path !== null)
    .map(({ project, path }) => {
      const declared = new Map<string, string>();
      for (const m of readFileSync(path, "utf8").matchAll(
        /(?:address|bytes32|uint256) internal constant (\w+) =\s*(0x[0-9a-fA-F]+|\d+);/g,
      )) {
        declared.set(m[1] as string, m[2] as string);
      }
      return { project, declared };
    });

  it("each constant is the one a launch project's Mainnet.sol declares", (ctx) => {
    if (copies.length === 0) return ctx.skip("no launch project is on disk");
    const mine = MAINNET as Record<string, string | number>;
    // What the copies declare, each constant read from every project that still has it.
    const union = new Map<string, string>();
    for (const { project, declared } of copies) {
      expect(declared.size, `${project}: no constants found`).toBeGreaterThan(0);
      for (const [name, value] of declared) {
        expect(String(mine[name]), `${name} in launches/${project} is missing here or differs`).toBe(value);
        union.set(name, value);
      }
    }
    // With all three projects on disk every constant here must be declared in at least one of them.
    if (copies.length < 3) return;
    expect(Object.keys(mine).sort()).toEqual([...union.keys()].sort());
    expect(union.size).toBeGreaterThanOrEqual(20);
  });

  it("copies of Mainnet.sol in the three launches agree wherever they share a constant", (ctx) => {
    if (copies.length < 2) return ctx.skip("fewer than two launch projects are on disk");
    const seen = new Map<string, { project: string; value: string }>();
    for (const { project, declared } of copies) {
      for (const [name, value] of declared) {
        const first = seen.get(name);
        if (first === undefined) seen.set(name, { project, value });
        else expect(value, `${name} differs between ${first.project} and ${project}`).toBe(first.value);
      }
    }
  });

  it("our own contracts here are the addresses the deployment book records", () => {
    expect(sameAddress(MAINNET.PAYROLL, DEPLOYMENT_BOOK.a.contracts.payroll)).toBe(true);
    expect(sameAddress(MAINNET.QUESTIONS, DEPLOYMENT_BOOK.a.contracts.questions)).toBe(true);
    expect(sameAddress(MAINNET.WORK_ORDERS, DEPLOYMENT_BOOK.b.contracts.workOrders)).toBe(true);
    expect(sameAddress(MAINNET.CROWD_POTS, DEPLOYMENT_BOOK.b.contracts.crowdPots)).toBe(true);
  });

  it("the Intake is version 2, with version 1 kept as the legacy address", () => {
    expect(MAINNET.INTAKE).toBe("0xa43e6F75ee006411F79Ac1C84120606C2330DE82");
    expect(MAINNET.INTAKE_V1).toBe("0x1397434cd35e8a9C8aC312A61D3A285EB31dea56");
    expect(INTAKES).toEqual([MAINNET.INTAKE, MAINNET.INTAKE_V1]);
    expect(isIntake(MAINNET.INTAKE.toLowerCase())).toBe(true);
    expect(isIntake(MAINNET.INTAKE_V1)).toBe(true);
    expect(isIntake(MAINNET.IMD)).toBe(false);
    expect(isIntake(null)).toBe(false);
    // The live capabilities of 13 October 2026 name the same two for Ethereum.
    const caps = Capabilities.parse(readJson(fixture("api", "requests-capabilities-2026-10-13.json")));
    const mainnet = caps.onchain?.chains?.find((c) => c.chainId === CHAIN_ID) as
      { intake: string; legacyIntakes?: string[]; payTo: string; asset: string } | undefined;
    expect(sameAddress(mainnet?.intake, MAINNET.INTAKE)).toBe(true);
    expect(mainnet?.legacyIntakes?.map((a) => a.toLowerCase())).toEqual([MAINNET.INTAKE_V1.toLowerCase()]);
    expect(sameAddress(mainnet?.payTo, MAINNET.FEE_PAYEE)).toBe(true);
    expect(sameAddress(mainnet?.asset, MAINNET.IMD)).toBe(true);
    const deliveries = (caps.onchain as { deliveries?: { chainId: number; delivery: string }[] }).deliveries;
    expect(
      sameAddress(deliveries?.find((d) => d.chainId === CHAIN_ID)?.delivery, MAINNET.INTAKE_DELIVERY),
    ).toBe(true);
  });

  it("the oracle action is the padded text, not a hash", () => {
    expect(MAINNET.ORACLE_ACTION).toBe(stringToHex("oracle.request@oracle-1", { size: 32 }));
    const golden = vector<{ hashes: Record<string, string> }>("abi-selectors.json").hashes;
    expect(MAINNET.ORACLE_ACTION).toBe(golden['bytes32("oracle.request@oracle-1")']);
  });

  it("agree with what the live API reported", () => {
    const caps = Capabilities.parse(readJson(fixture("api", "requests-capabilities.json")));
    const job = caps.actions.find((a) => a.action === "job.open");
    expect(job).toBeDefined();
    expect(job?.payment.network).toBe(CAIP2_NETWORK);
    expect(sameAddress(job?.payment.asset, MAINNET.IMD)).toBe(true);
    expect(sameAddress(job?.payment.payTo, MAINNET.FEE_PAYEE)).toBe(true);
    expect(BigInt(job?.payment.amount ?? 0)).toBe(PAID_ACTION_PRICE);
    expect(sameAddress(caps.onchain?.quoteSigner, OFFCHAIN.QUOTE_SIGNER)).toBe(true);
    const mainnet = caps.onchain?.chains?.find((c) => c.chainId === CHAIN_ID);
    // This fixture is of 10 October 2026, before version 2 of the Intake was adopted.
    expect(sameAddress(mainnet?.intake, MAINNET.INTAKE_V1)).toBe(true);
    expect(sameAddress(mainnet?.asset, MAINNET.IMD)).toBe(true);

    const health = Health.parse(readJson(fixture("api", "health.json")));
    expect(sameAddress(health.identity?.collection, MAINNET.SEATS)).toBe(true);
    expect(sameAddress(health.identity?.adapter, MAINNET.SEAT_ADAPTER)).toBe(true);
    expect(sameAddress(health.payments?.gasWallet?.address, OFFCHAIN.X402_GAS_WALLET)).toBe(true);
  });

  it("pin the WorkRegistry selector and topic", () => {
    const golden = vector<{
      functions: Record<string, Record<string, string>>;
      events: Record<string, Record<string, string>>;
    }>("abi-selectors.json");
    expect(WORK_REGISTRY_LATEST_SELECTOR).toBe(golden.functions.workRegistry?.["latest(bytes16)"]);
    expect(WORK_RECORDED_TOPIC).toBe(
      golden.events.workRegistry?.["WorkRecorded(bytes16,bytes32,bytes32,string)"],
    );
  });

  it("compares addresses without regard to case", () => {
    expect(sameAddress(MAINNET.IMD, MAINNET.IMD.toLowerCase())).toBe(true);
    expect(sameAddress(MAINNET.IMD, MAINNET.SIMD)).toBe(false);
    expect(sameAddress(MAINNET.IMD, null)).toBe(false);
    expect(sameAddress("not an address", MAINNET.IMD)).toBe(false);
    expect(lowerAddress(MAINNET.IMD)).toBe("0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7");
  });
});
