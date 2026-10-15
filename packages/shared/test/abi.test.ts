import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  keccak256,
  parseAbi,
  toEventSelector,
  toFunctionSelector,
  type Abi,
  type AbiEvent,
  type AbiFunction,
} from "viem";
import { describe, expect, it } from "vitest";
import * as abis from "../src/abi/index.js";
import {
  BUILT_CONTRACTS,
  GENERATED_DIR,
  artifactRelPath,
  readArtifact,
  renderBuiltAbiFile,
  renderBuiltIndexFile,
  staleSources,
  type BuiltContract,
} from "../scripts/abi-build.js";
import { ABI_SOURCES } from "../scripts/abi-sources.js";
import { REPO, repoFile, vector } from "./paths.js";

const byName = abis as unknown as Record<string, Abi>;

function selectorOf(abi: Abi, signature: string): string | undefined {
  const name = signature.slice(0, signature.indexOf("("));
  for (const item of abi) {
    if (
      item.type === "function" &&
      item.name === name &&
      toFunctionSelector(item as AbiFunction) === toFunctionSelector(signature)
    ) {
      return toFunctionSelector(item as AbiFunction);
    }
  }
  return undefined;
}

function topicOf(abi: Abi, signature: string): string | undefined {
  const name = signature.slice(0, signature.indexOf("("));
  const item = abi.find((i) => i.type === "event" && i.name === name);
  return item ? toEventSelector(item as AbiEvent) : undefined;
}

const namesOf = (abi: Abi): Set<string> =>
  new Set(abi.map((i) => ("name" in i ? `${i.type}:${i.name}` : i.type)));

describe("ABIs of our own contracts, generated from the build output", () => {
  it("exports one ABI per listed contract and nothing else beside the protocol's", () => {
    expect(Object.keys(byName).sort()).toEqual(
      [...ABI_SOURCES.map((s) => `${s.name}Abi`), ...BUILT_CONTRACTS.map((c) => `${c.name}Abi`)].sort(),
    );
    const files = readdirSync(GENERATED_DIR).sort();
    expect(files).toEqual([...BUILT_CONTRACTS.map((c) => `${c.name}.ts`), "index.ts"].sort());
    expect(readFileSync(join(GENERATED_DIR, "index.ts"), "utf8")).toBe(renderBuiltIndexFile());
  });

  it.for(BUILT_CONTRACTS.map((c) => [c.name, c] as const))(
    "%s is exactly what the generator would write now",
    ([, contract], ctx) => {
      const artifact = readArtifact(contract, REPO);
      if (artifact === null) {
        // The launch project has not been built here. That is not a failure of this package: the
        // committed file stays as it is until somebody builds the project and runs the generator.
        return ctx.skip(
          `${artifactRelPath(contract)} is absent: run \`forge build\` in launches/${contract.project} to check this ABI`,
        );
      }
      const committed = readFileSync(join(GENERATED_DIR, `${contract.name}.ts`), "utf8");
      const hint = `src/abi/generated/${contract.name}.ts differs from ${artifactRelPath(contract)}: run \`pnpm --filter @help-wanted/shared abi:gen\``;
      expect(committed === renderBuiltAbiFile(contract, artifact.abi), hint).toBe(true);
      expect(byName[`${contract.name}Abi`], hint).toEqual(artifact.abi);
    },
  );

  it.for(BUILT_CONTRACTS.map((c) => [c.name, c] as const))(
    "%s was built from the sources that are on disk",
    ([, contract], ctx) => {
      if (readArtifact(contract, REPO) === null) {
        return ctx.skip(
          `${artifactRelPath(contract)} is absent: run \`forge build\` in launches/${contract.project}`,
        );
      }
      // The compiler records the hash of every source in the artifact. A source that changed since
      // means the ABI above may be yesterday's, however well it matches the artifact.
      expect(
        staleSources(contract, REPO),
        `${artifactRelPath(contract)} is older than its sources: run \`forge build\` in launches/${contract.project}, then \`pnpm --filter @help-wanted/shared abi:gen\``,
      ).toEqual([]);
    },
  );

  it("reads only out/, never the stale per-area folders", () => {
    for (const contract of BUILT_CONTRACTS) {
      expect(artifactRelPath(contract)).toMatch(/^launches\/[a-z-]+\/out\/\w+\.sol\/\w+\.json$/);
    }
  });

  // Each interface file other contracts compile against, and the ABI that must carry every
  // function, event and error it declares.
  const interfaces: [string[], string][] = [
    [["launches", "a-payroll", "src", "interfaces", "IPayroll.sol"], "payroll"],
    [["launches", "a-payroll", "src", "interfaces", "IQuestions.sol"], "questions"],
    [["launches", "b-desk", "src", "interfaces", "IWorkOrders.sol"], "workOrders"],
    [["launches", "b-desk", "src", "interfaces", "IWorkOrdersRunner.sol"], "workOrders"],
    [["launches", "b-desk", "src", "interfaces", "IWorkProof.sol"], "workProof"],
    [["launches", "b-desk", "src", "interfaces", "ICrowdPots.sol"], "crowdPots"],
  ];

  it.for(interfaces)("carries everything declared in %s", ([parts, name], ctx) => {
    const path = repoFile(...parts);
    if (!path) return ctx.skip(`${parts.join("/")} is absent`);
    const source = readFileSync(path, "utf8")
      .replace(/\/\/\/.*$/gm, "")
      .replace(/\/\/.*$/gm, "");
    const have = namesOf(byName[`${name}Abi`] as Abi);
    // IWorkOrders.sol also declares IWorkEmployer, the employer's side of the callback.
    const employer = namesOf(byName.workEmployerAbi as Abi);
    const declared = [...source.matchAll(/\b(function|error|event)\s+(\w+)\s*\(/g)].map(
      (m) => `${m[1]}:${m[2]}`,
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const item of declared) {
      expect(have.has(item) || employer.has(item), `${name} lacks ${item}`).toBe(true);
    }
  });

  it("carries what the keeper and the pages call on launch A", () => {
    const expectAll = (name: string, items: string[]) => {
      const have = namesOf(byName[`${name}Abi`] as Abi);
      for (const item of items) expect(have.has(item), `${name} lacks ${item}`).toBe(true);
    };
    expectAll("questions", [
      "function:createFeed",
      "function:request",
      "function:submit",
      "function:abandon",
      "function:collectTips",
      "function:tipsOf",
      "function:canRequest",
      "function:canSubmit",
      "function:canAbandon",
      "function:feedState",
      "function:roundRequest",
      "function:fundFor",
      "function:redeemable",
      "function:SUBMIT_AFTER_SILENCE",
      "function:ABANDON_AFTER_SILENCE",
      "function:ABANDON_AFTER_COMPLETED",
      "event:RoundOpened",
      "event:RoundAnswered",
      "event:RoundFailed",
      "event:CompletionSeen",
      "event:TipsCollected",
      "error:RequestBlocked",
      "error:SubmitTooEarly",
      "error:TooEarlyToAbandon",
    ]);
    expectAll("jobsReport", ["function:print", "function:crown", "function:summary", "function:crownOf"]);
    expectAll("payroll", [
      "function:book",
      "function:drip",
      "function:fundFeeds",
      "function:unbooked",
      "function:stream",
      "function:feedShortfalls",
      "function:feedBudget",
      "function:feedBudgetDue",
      "function:clock",
    ]);
  });

  it("OrderParams has the fifteen fields of the frozen struct, in order", () => {
    const create = (byName.workOrdersAbi as Abi).find(
      (i) => i.type === "function" && i.name === "createOrder",
    ) as AbiFunction;
    const params = create.inputs[0] as unknown as { components: { name: string; type: string }[] };
    expect(params.components.map((c) => `${c.type} ${c.name}`)).toEqual([
      "bytes32 kindHash",
      "uint96 minPay",
      "uint96 maxPay",
      "uint32 rampSecs",
      "uint32 deliverySecs",
      "uint40 expiresAt",
      "uint96 bond",
      "uint8 flags",
      "address runnerOnly",
      "address arbiter",
      "address condTarget",
      "bytes4 condSelector",
      "bytes32 condArg",
      "uint8 condCmp",
      "uint256 condThreshold",
    ]);
  });

  it("gives Order and Claim the fields the runner reads, in the contract's order", () => {
    const outputOf = (fn: string): string[] => {
      const item = (byName.workOrdersAbi as Abi).find(
        (i) => i.type === "function" && i.name === fn,
      ) as AbiFunction;
      const tuple = item.outputs[0] as unknown as { components: { name: string; type: string }[] };
      return tuple.components.map((c) => `${c.type} ${c.name}`);
    };
    const order = outputOf("orderOf");
    const claim = outputOf("claimOf");
    expect(order.length).toBe(26);
    expect(order.slice(0, 5)).toEqual([
      "address employer",
      "uint40 expiresAt",
      "uint40 rampFrom",
      "uint8 state",
      "uint8 flags",
    ]);
    expect(claim).toEqual([
      "address runner",
      "uint40 claimedAt",
      "uint40 registeredAt",
      "uint96 price",
      "bytes16 jobId",
      "address challenger",
      "uint40 assertedAt",
      "bytes32 recordHash",
    ]);
  });
});

describe("the generator's checks, on a made-up project", () => {
  const contract: BuiltContract = {
    name: "thing",
    project: "a-payroll",
    file: "Thing",
    contract: "Thing",
    comment: "A contract that exists only in this test.",
  };

  function project(): { root: string; source: string; artifact: string } {
    const root = mkdtempSync(join(tmpdir(), "hw-abi-"));
    const dir = join(root, "launches", "a-payroll");
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "out", "Thing.sol"), { recursive: true });
    const source = join(dir, "src", "Thing.sol");
    writeFileSync(source, "contract Thing { function ping() external {} }\n");
    const artifact = join(dir, "out", "Thing.sol", "Thing.json");
    writeFileSync(
      artifact,
      JSON.stringify({
        abi: [{ type: "function", name: "ping", inputs: [], outputs: [], stateMutability: "nonpayable" }],
        metadata: {
          sources: { "src/Thing.sol": { keccak256: keccak256(new Uint8Array(readFileSync(source))) } },
        },
      }),
    );
    return { root, source, artifact };
  }

  it("reads an artifact, and knows a project that was never built", () => {
    const { root, artifact } = project();
    try {
      expect(readArtifact(contract, root)?.abi).toHaveLength(1);
      expect(staleSources(contract, root)).toEqual([]);
      rmSync(artifact);
      expect(readArtifact(contract, root)).toBeNull();
      expect(staleSources(contract, root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sees a source that changed after the build, even by a comment, and one that is gone", () => {
    const { root, source } = project();
    try {
      writeFileSync(source, "// a note\ncontract Thing { function ping() external {} }\n");
      expect(staleSources(contract, root)).toEqual(["src/Thing.sol"]);
      rmSync(source);
      expect(staleSources(contract, root)).toEqual(["src/Thing.sol (not on disk)"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders a file whose text changes with the ABI and names where it came from", () => {
    const one = renderBuiltAbiFile(contract, [{ type: "function", name: "ping" }]);
    const two = renderBuiltAbiFile(contract, [{ type: "function", name: "pong" }]);
    expect(one).not.toBe(two);
    expect(one).toContain("launches/a-payroll/out/Thing.sol/Thing.json");
    expect(one).toContain("export const thingAbi = [");
    expect(one.trimEnd().endsWith("] as const;")).toBe(true);
  });
});

describe("ABIs of the protocol's contracts, written from signatures", () => {
  it("the committed files are what the signatures generate", () => {
    for (const source of ABI_SOURCES) {
      expect(byName[`${source.name}Abi`], source.name).toEqual(
        parseAbi(source.signatures as readonly string[]),
      );
      expect(existsSync(join(GENERATED_DIR, "..", `${source.name}.ts`)), source.name).toBe(true);
    }
  });

  // The external interface files each launch project keeps, and the ABI that must carry what
  // they declare. Each project holds only the files it uses, so every copy that exists is read.
  const external: [string, string][] = [
    ["IIntake.sol", "intake"],
    ["IWorkRegistry.sol", "workRegistry"],
    ["ISeatAdapter.sol", "seatAdapter"],
  ];

  it.for(external)("carries every function, event and error declared in %s", ([file, name], ctx) => {
    const paths = ["a-payroll", "b-desk", "c-company"]
      .map((project) => repoFile("launches", project, "src", "interfaces", "external", file))
      .filter((p): p is string => p !== null);
    if (paths.length === 0) return ctx.skip(`no launch project holds ${file}`);
    const have = namesOf(byName[`${name}Abi`] as Abi);
    // ISeatAdapter.sol also declares ISeats, the one ERC-721 read the seat payouts need.
    const seats = namesOf(byName.erc721Abi as Abi);
    for (const path of paths) {
      const source = readFileSync(path, "utf8")
        .replace(/\/\/\/.*$/gm, "")
        .replace(/\/\/.*$/gm, "");
      const declared = [...source.matchAll(/\b(function|error|event)\s+(\w+)\s*\(/g)].map(
        (m) => `${m[1]}:${m[2]}`,
      );
      expect(declared.length).toBeGreaterThan(0);
      for (const item of declared) {
        expect(have.has(item) || seats.has(item), `${name} lacks ${item} (${path})`).toBe(true);
      }
    }
  });

  it("the Intake ABI has what version 2 added, beside everything version 1 has", () => {
    const have = namesOf(byName.intakeAbi as Abi);
    for (const item of [
      "function:request",
      "function:requests",
      "function:priceOf",
      "function:callbackGas",
      "event:Requested",
      "event:Completed",
      "function:requestWithFailure",
      "function:failureSelectorOf",
      "event:FailureHookSet",
    ]) {
      expect(have.has(item), item).toBe(true);
    }
  });
});

describe("selectors and topics", () => {
  const golden = vector<{
    functions: Record<string, Record<string, string>>;
    events: Record<string, Record<string, string>>;
    errors: Record<string, Record<string, string>>;
  }>("abi-selectors.json");

  it("function selectors match the ones cast computes", () => {
    let checked = 0;
    for (const [name, sigs] of Object.entries(golden.functions)) {
      for (const [signature, selector] of Object.entries(sigs)) {
        expect(selectorOf(byName[`${name}Abi`] as Abi, signature), `${name}: ${signature}`).toBe(selector);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  it("event topics match the ones cast computes", () => {
    for (const [name, sigs] of Object.entries(golden.events)) {
      for (const [signature, topic] of Object.entries(sigs)) {
        expect(topicOf(byName[`${name}Abi`] as Abi, signature), `${name}: ${signature}`).toBe(topic);
      }
    }
  });

  it("the callback the Intake makes on Questions is onOracleResult", () => {
    const item = (byName.questionsAbi as Abi).find(
      (i) => i.type === "function" && i.name === "onOracleResult",
    ) as AbiFunction;
    const hashes = vector<{ hashes: Record<string, string> }>("abi-selectors.json").hashes;
    expect(toFunctionSelector(item)).toBe(hashes["onOracleResult selector"]);
  });
});
