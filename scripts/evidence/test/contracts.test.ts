import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACTS, LAUNCH_KEYS, contractSpec } from "../contracts.js";
import {
  DEPLOYMENT_BOOK,
  eventNamesOf,
  launchOf,
  type Abi,
} from "../shared.js";
import { ROOT } from "./helpers.js";

const viewsWithoutArguments = (abi: Abi) =>
  abi.flatMap((item) =>
    item.type === "function" &&
    item.inputs.length === 0 &&
    (item.stateMutability === "view" || item.stateMutability === "pure")
      ? [item.name]
      : [],
  );

describe("the ten contracts, as the evidence builder lists them", () => {
  it("are the contracts of the deployments book, in its order, each in its launch", () => {
    const book = LAUNCH_KEYS.flatMap((key) =>
      Object.keys(DEPLOYMENT_BOOK[key].contracts),
    );
    expect(CONTRACTS.map((contract) => contract.key)).toEqual(book);
    for (const contract of CONTRACTS)
      expect(contract.launch).toBe(launchOf(contract.key));
    expect(CONTRACTS).toHaveLength(10);
  });

  it("each name a source file that exists, in the project of its launch", () => {
    for (const contract of CONTRACTS) {
      expect(
        contract.source.startsWith(
          `${DEPLOYMENT_BOOK[contract.launch].project}/src/`,
        ),
      ).toBe(true);
      expect(contract.source.endsWith(`/${contract.name}.sol`)).toBe(true);
      expect([
        contract.source,
        existsSync(join(ROOT, contract.source)),
      ]).toEqual([contract.source, true]);
    }
  });

  it("have a counting rule for every event of their ABI, and for nothing else", () => {
    for (const contract of CONTRACTS) {
      // An event added to an ABI and not given a rule here would be counted for nobody, or not at
      // all. This is the test that makes somebody decide.
      expect([contract.name, Object.keys(contract.events).sort()]).toEqual([
        contract.name,
        eventNamesOf(contract.abi).sort(),
      ]);
      for (const rule of Object.values(contract.events))
        expect(rule.of.length).toBeGreaterThan(0);
    }
    // WorkProof changes no state and logs nothing.
    expect(eventNamesOf(contractSpec("workProof").abi)).toEqual([]);
  });

  it("read only views that exist and take no argument", () => {
    for (const contract of CONTRACTS) {
      const known = viewsWithoutArguments(contract.abi);
      for (const view of contract.views)
        expect([contract.name, view, known.includes(view)]).toEqual([
          contract.name,
          view,
          true,
        ]);
    }
  });

  it("refuses a name that is not a contract", () => {
    expect(() => contractSpec("treasury" as never)).toThrow(
      /no contract named treasury/,
    );
  });
});
