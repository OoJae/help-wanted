/**
 * The small pure pieces: constants, id spellings, JSON helpers, body decoding, error sorting and
 * configuration.
 */
import { getAddress, stringToHex, toEventSelector } from "viem";
import {
  DEPLOYMENT_BOOK,
  flattenBook,
  jobsReportAbi,
  launchOf,
  MAINNET,
  payrollAbi,
  questionsAbi,
} from "@help-wanted/shared";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyLogsError, HistoryUnavailableError, isBlockTime } from "../src/chain/logs.js";
import { createChainClient, redactRpcUrl } from "../src/chain/client.js";
import {
  loadConfig,
  loadHouseAddresses,
  MAX_API_CALLS_PER_MINUTE,
  parseStartBlock,
  resolveStartBlock,
} from "../src/config.js";
import {
  FEE_PAYEE,
  IMD,
  INTAKE,
  INTAKE_V1,
  INTAKES,
  intakeVersionOf,
  ORACLE_ACTION,
  TOPIC,
  WORK_REGISTRY,
} from "../src/constants.js";
import { openDatabase } from "../src/db/client.js";
import {
  deploymentEnvKey,
  deploymentsFromBook,
  moduleNameOf,
  NO_DEPLOYMENTS,
  OWN_CONTRACTS,
} from "../src/deployments.js";
import { isUuid, jobIdToUuid, normalizeJobId, uuidToJobId } from "../src/ids.js";
import {
  isStorableJson,
  JsonTooDeepError,
  jsonTextDepthWithin,
  MAX_JSON_DEPTH,
  MAX_STORED_JSON_DEPTH,
  sameJson,
  scrubJson,
  scrubText,
  stableStringify,
  storableJson,
  toJson,
} from "../src/json.js";
import {
  clearSecrets,
  createLogger,
  errorMessage,
  MAX_ERROR_CHARS,
  publicErrorMessage,
  redact,
  registerSecrets,
  secretsOfUrl,
} from "../src/log.js";
import { ALL_MODULES, EXTERNAL_MODULES, OWN_MODULES } from "../src/modules/index.js";
import { jobsReportModule } from "../src/modules/own/jobsReport.js";
import { payrollModule } from "../src/modules/own/payroll.js";
import { questionsModule } from "../src/modules/own/questions.js";
import { eventNamesOf } from "../src/modules/own/stub.js";
import { BOOKS, TEST_LAUNCH } from "./helpers/books.js";
import { bytes32Text, decodeBody, intakeStatusName, oracleRequestIdFromUri } from "../src/modules/intake.js";
import { DEFAULT_SNAPSHOT_DIR } from "../src/snapshot.js";

describe("constants", () => {
  it("has each topic equal to the hash of its event signature", () => {
    expect(TOPIC.Transfer).toBe(toEventSelector("Transfer(address,address,uint256)"));
    expect(TOPIC.WorkRecorded).toBe(toEventSelector("WorkRecorded(bytes16,bytes32,bytes32,string)"));
    expect(TOPIC.Requested).toBe(
      toEventSelector("Requested(bytes32,address,bytes32,bytes,address,bytes4,address,uint256)"),
    );
    expect(TOPIC.Completed).toBe(toEventSelector("Completed(bytes32,uint8,bytes32,string,bool)"));
  });

  it("spells every address with a valid checksum", () => {
    for (const address of [IMD, FEE_PAYEE, WORK_REGISTRY, INTAKE, INTAKE_V1]) {
      expect(getAddress(address)).toBe(address);
    }
  });

  it("takes its addresses from the shared package, with the Intake as version 2 and version 1 as legacy", () => {
    expect([IMD, FEE_PAYEE, WORK_REGISTRY, INTAKE, INTAKE_V1, ORACLE_ACTION]).toEqual([
      MAINNET.IMD,
      MAINNET.FEE_PAYEE,
      MAINNET.WORK_REGISTRY,
      MAINNET.INTAKE,
      MAINNET.INTAKE_V1,
      MAINNET.ORACLE_ACTION,
    ]);
    // The current Intake is version 2; version 1 is the legacy one. They are different contracts.
    expect(INTAKE.toLowerCase()).toBe("0xa43e6f75ee006411f79ac1c84120606c2330de82");
    expect(INTAKE_V1.toLowerCase()).toBe("0x1397434cd35e8a9c8ac312a61d3a285eb31dea56");
    expect(INTAKES).toEqual([INTAKE, INTAKE_V1]);
    expect(intakeVersionOf(INTAKE.toLowerCase())).toBe(2);
    expect(intakeVersionOf(INTAKE_V1.toUpperCase().replace("0X", "0x"))).toBe(1);
    expect(intakeVersionOf(IMD)).toBeNull();
  });

  it("has the oracle action as the padded text, not a hash", () => {
    expect(ORACLE_ACTION).toBe(stringToHex("oracle.request@oracle-1", { size: 32 }));
    expect(bytes32Text(ORACLE_ACTION)).toBe("oracle.request@oracle-1");
  });

  it("agrees with the contracts' own address lists where they are published", async () => {
    // `Mainnet.sol` is the list each launch project compiles against. Each project keeps only the
    // constants its own tests use, so no one copy holds them all: every address the indexer reads
    // must be in at least one copy, under the name given here, and no copy may disagree. If none is
    // there (this package checked out alone), there is nothing to compare with.
    const { readFile } = await import("node:fs/promises");
    const copies = (
      await Promise.all(
        ["a-payroll", "b-desk", "c-company"].map((project) =>
          readFile(
            new URL(`../../../launches/${project}/src/interfaces/external/Mainnet.sol`, import.meta.url),
            "utf8",
          ).catch(() => null),
        ),
      )
    ).filter((source): source is string => source !== null);
    if (copies.length === 0) return;
    const declared = (name: string): string[] =>
      copies.flatMap((source) => {
        const match = new RegExp(`address internal constant ${name} = (0x[0-9a-fA-F]{40});`).exec(source);
        return match?.[1] ? [match[1].toLowerCase()] : [];
      });
    for (const [name, address] of Object.entries({ IMD, FEE_PAYEE, WORK_REGISTRY, INTAKE, INTAKE_V1 })) {
      const values = declared(name);
      expect([name, values.length > 0], `${name} is in no Mainnet.sol`).toEqual([name, true]);
      expect([name, [...new Set(values)]]).toEqual([name, [address.toLowerCase()]]);
    }
  });
});

describe("modules", () => {
  it("names every module once, in snake case", () => {
    const names = ALL_MODULES.map((module) => module.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("runs the three finished modules with no configuration, and none of ours until it has an address", () => {
    const none = Object.fromEntries(OWN_CONTRACTS.map((contract) => [contract, null])) as Record<
      (typeof OWN_CONTRACTS)[number],
      null
    >;
    // The Intake module reads both Intake contracts: version 2, the current one, and the legacy one.
    expect(EXTERNAL_MODULES.map((module) => module.filter(none)?.address)).toEqual([
      WORK_REGISTRY,
      [INTAKE, INTAKE_V1],
      IMD,
    ]);
    expect(EXTERNAL_MODULES.every((module) => module.stub !== true)).toBe(true);
    expect(OWN_MODULES.map((module) => module.filter(none))).toEqual(OWN_MODULES.map(() => null));
    expect(OWN_MODULES).toHaveLength(OWN_CONTRACTS.length);

    const desk = "0x00000000000000000000000000000000000de5c0";
    const workOrders = OWN_MODULES.find((module) => module.name === "work_orders");
    expect(workOrders?.filter({ ...none, workOrders: desk })).toEqual({ address: desk });
  });

  it("folds the events of launch A's contracts, which are final, and keeps the others as stubs", () => {
    const stubs = OWN_MODULES.filter((module) => module.stub === true).map((module) => module.name);
    const finished = OWN_MODULES.filter((module) => module.stub !== true).map((module) => module.name);
    // Launch A is on mainnet and its events are folded. Launch B is on mainnet too, and launch C is
    // not launched: the modules of both store logs and say on every route that nothing is folded
    // yet, because their handlers are not written.
    expect(finished).toEqual(["questions", "jobs_report", "payroll"]);
    expect(stubs).toEqual(["work_orders", "crowd_pots", "doorbell", "rules", "endowments", "zap"]);
    for (const module of OWN_MODULES) {
      if (module.stub === true) expect(module.abi, module.name).toEqual([]);
    }
  });

  it("has a branch, or a stated reason for none, for every event of each launched contract's ABI", () => {
    // The ABIs are the ones the shared package generates from launch A's build output. An event
    // that is in neither list would be stored and silently go no further.
    for (const [module, abi] of [
      [questionsModule, questionsAbi],
      [jobsReportModule, jobsReportAbi],
      [payrollModule, payrollAbi],
    ] as const) {
      const events = eventNamesOf(abi);
      expect(events.length, module.name).toBeGreaterThan(4);
      expect([...module.folded, ...module.kept].sort(), module.name).toEqual([...events].sort());
      expect(new Set([...module.folded, ...module.kept]).size).toBe(events.length);
      expect(module.abi).toBe(abi);
    }
  });

  it("names each of our modules after its contract, and makes each ask for its deployment block", () => {
    // `ADDR_WORK_ORDERS=0x…@<block>` sets the start block of the module called `work_orders`, so
    // the two names must be the same thing.
    expect(OWN_MODULES.map((module) => module.name).sort()).toEqual(OWN_CONTRACTS.map(moduleNameOf).sort());
    expect(OWN_MODULES.every((module) => module.needsStartBlock === true)).toBe(true);
    // IdentityMD's contracts have long histories nobody needs in full: they may start anywhere.
    expect(EXTERNAL_MODULES.every((module) => module.needsStartBlock !== true)).toBe(true);
  });

  it("asks the node for transfers to the fee payee only", () => {
    const filter = EXTERNAL_MODULES[2]?.filter(
      Object.fromEntries(OWN_CONTRACTS.map((c) => [c, null])) as never,
    );
    expect(filter?.topics).toEqual([
      TOPIC.Transfer,
      null,
      "0x0000000000000000000000004e0fa57bde726079356537e2f34d671e9f41adbc",
    ]);
  });
});

describe("job ids", () => {
  const UUID = "e9efec16-56f3-40d3-9243-52c453effc7d";
  const BYTES = "0xe9efec1656f340d3924352c453effc7d";

  it("converts between the chain's spelling and the API's, both ways", () => {
    expect(jobIdToUuid(BYTES)).toBe(UUID);
    expect(uuidToJobId(UUID)).toBe(BYTES);
    expect(jobIdToUuid(BYTES.toUpperCase().replace("0X", "0x"))).toBe(UUID);
    expect(uuidToJobId(jobIdToUuid(BYTES))).toBe(BYTES);
  });

  it("accepts either spelling and refuses anything else", () => {
    expect(normalizeJobId(UUID)).toBe(BYTES);
    expect(normalizeJobId(BYTES)).toBe(BYTES);
    expect(normalizeJobId("e9efec16")).toBeNull();
    expect(normalizeJobId(`${BYTES}00`)).toBeNull();
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid(UUID.toUpperCase())).toBe(false);
    expect(() => jobIdToUuid("0x1234")).toThrow(/bytes16/);
    expect(() => uuidToJobId("not-a-uuid")).toThrow(/UUID/);
  });
});

describe("JSON helpers", () => {
  it("turns decoded values into plain JSON with integers as decimal strings", () => {
    expect(toJson({ a: 1n, b: [2n ** 255n, "x", true, null], c: undefined, d: { e: 0n } })).toEqual({
      a: "1",
      b: ["57896044618658097711785492504343953926634992332820282019728792003956564819968", "x", true, null],
      d: { e: "0" },
    });
    expect(toJson(Number.NaN)).toBeNull();
  });

  it("knows what Postgres refuses, and can replace it", () => {
    expect(isStorableJson({ a: ["fine", { b: "ok" }] })).toBe(true);
    expect(isStorableJson({ a: "nul\u0000" })).toBe(false);
    expect(isStorableJson({ "key\u0000": 1 })).toBe(false);
    expect(isStorableJson(["half \ud83d pair"])).toBe(false);
    expect(isStorableJson(["whole 😀 pair"])).toBe(true);

    expect(scrubText("a\u0000b\udc00c")).toBe("a�b�c");
    expect(scrubText("unchanged 😀")).toBe("unchanged 😀");
    const scrubbed = scrubJson({ "k\u0000": ["x\ud800", { y: "fine" }] });
    expect(scrubbed).toEqual({ "k�": ["x�", { y: "fine" }] });
    expect(isStorableJson(scrubbed)).toBe(true);
  });

  it("compares JSON without caring about key order", () => {
    expect(sameJson({ a: 1, b: { c: [1, 2], d: null } }, { b: { d: null, c: [1, 2] }, a: 1 })).toBe(true);
    expect(sameJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameJson(null, {})).toBe(false);
  });

  /** `levels` arrays inside one another around a 1. */
  const nested = (levels: number): unknown => {
    let value: unknown = 1;
    for (let i = 0; i < levels; i++) value = [value];
    return value;
  };

  it("gives up on a value nested too deep with an ordinary error, never a stack overflow", () => {
    // 100,000 levels would exhaust the stack of anything that followed them all the way down.
    const abyss = nested(100_000);
    for (const walk of [
      () => toJson(abyss),
      () => scrubJson(abyss as never),
      () => storableJson(abyss),
      () => stableStringify(abyss),
      () => sameJson(abyss as never, abyss as never),
    ]) {
      expect(walk).toThrow(JsonTooDeepError);
    }
    expect(isStorableJson(abyss as never)).toBe(false);
    // A value that contains itself is as deep as they come.
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => toJson(loop)).toThrow(JsonTooDeepError);
  });

  it("draws the line at a fixed depth: 32 levels to store, 64 to write out", () => {
    expect([MAX_STORED_JSON_DEPTH, MAX_JSON_DEPTH]).toEqual([32, 64]);
    expect(isStorableJson(nested(32) as never)).toBe(true);
    expect(isStorableJson(nested(33) as never)).toBe(false);
    expect(storableJson(nested(32))).toEqual(nested(32));
    expect(() => storableJson(nested(33))).toThrow(JsonTooDeepError);
    // A stored value sits inside a few levels of envelope when it is written out.
    expect(() => stableStringify({ rows: [{ column: nested(32) }] })).not.toThrow();
    expect(() => toJson(nested(64))).not.toThrow();
    expect(() => toJson(nested(65))).toThrow(JsonTooDeepError);
    // Objects count like arrays.
    expect(isStorableJson({ a: { b: nested(30) } } as never)).toBe(true);
    expect(isStorableJson({ a: { b: nested(31) } } as never)).toBe(false);
  });

  it("measures the nesting of JSON text without parsing it", () => {
    expect(jsonTextDepthWithin('{"a":[1,{"b":[]}]}', 4)).toBe(true);
    expect(jsonTextDepthWithin('{"a":[1,{"b":[]}]}', 3)).toBe(false);
    expect(jsonTextDepthWithin("[".repeat(8191) + "]".repeat(8191), 32)).toBe(false);
    // Brackets inside strings are text, not structure; an escaped quote does not end the string.
    expect(jsonTextDepthWithin('{"a":"[[[[[[[["}', 1)).toBe(true);
    expect(jsonTextDepthWithin('{"a":"\\"[[[[[[[["}', 1)).toBe(true);
    expect(jsonTextDepthWithin('{"a":"\\\\","b":[[[]]]}', 2)).toBe(false);
    expect(jsonTextDepthWithin("plain text", 0)).toBe(true);
  });

  it("refuses a number that overflowed when it was parsed, which would be written back as null", () => {
    expect(isStorableJson(JSON.parse("[1e999]") as never)).toBe(false);
    expect(isStorableJson(JSON.parse("[1e300, -5, 0.5]") as never)).toBe(true);
  });

  it("keeps a key named __proto__ as data", () => {
    // Written by plain assignment, this key would set the copy's prototype and vanish from it.
    const parsed = JSON.parse('{"__proto__":{"admin":true},"b":1}') as never;
    for (const copy of [toJson(parsed), scrubJson(parsed), storableJson(parsed)]) {
      expect(Object.keys(copy as object).sort()).toEqual(["__proto__", "b"]);
      expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
      expect(({} as { admin?: boolean }).admin).toBeUndefined();
    }
    expect(stableStringify(parsed)).toBe('{\n  "__proto__": {\n    "admin": true\n  },\n  "b": 1\n}\n');
    expect(sameJson(parsed, JSON.parse('{"b":1}') as never)).toBe(false);
  });
});

describe("Intake bodies", () => {
  const hex = (text: string) => `0x${Buffer.from(text, "utf8").toString("hex")}`;

  it("reads a well-formed body", () => {
    const text = '{"v":1,"question":"Is it so? ✓","answerType":"bool","window":{"hours":24}}';
    expect(decodeBody(hex(text))).toEqual({
      text,
      json: { v: 1, question: "Is it so? ✓", answerType: "bool", window: { hours: 24 } },
      question: "Is it so? ✓",
      answerType: "bool",
    });
  });

  it("keeps the text of a body that is not JSON, and nothing of one that is not text", () => {
    expect(decodeBody(hex("not json at all"))).toEqual({
      text: "not json at all",
      json: null,
      question: null,
      answerType: null,
    });
    expect(decodeBody(hex('["a","list"]'))).toMatchObject({ json: ["a", "list"], question: null });
    expect(decodeBody(hex('{"question":7}'))).toMatchObject({ question: null });
    // 0xff is never valid UTF-8; a NUL byte is valid UTF-8 but Postgres text cannot hold it.
    expect(decodeBody("0xff00ff")).toEqual({ text: null, json: null, question: null, answerType: null });
    expect(decodeBody(hex("a\u0000b")).text).toBeNull();
    expect(decodeBody("0x")).toMatchObject({ text: "", json: null });
  });

  it("declines to parse a body nested deeper than 32 levels, and never throws whatever it is given", () => {
    const nestedText = (levels: number) => `${"[".repeat(levels)}${"]".repeat(levels)}`;
    expect(decodeBody(hex(nestedText(32))).json).not.toBeNull();
    for (const levels of [33, 3000, 8191]) {
      expect(decodeBody(hex(nestedText(levels)))).toEqual({
        text: nestedText(levels),
        json: null,
        question: null,
        answerType: null,
      });
    }
    // Deep objects, and deep values hidden behind a shallow first key.
    expect(decodeBody(hex(`${'{"a":'.repeat(40)}1${"}".repeat(40)}`)).json).toBeNull();
    expect(decodeBody(hex(`{"question":"q","x":${nestedText(100)}}`))).toMatchObject({
      json: null,
      question: null,
    });
    // A number too large for a double would be stored as null: the text is kept instead.
    expect(decodeBody(hex('{"question":"q","threshold":1e999}'))).toMatchObject({ json: null });
    // Not hex at all: nothing is decoded and nothing is thrown.
    expect(decodeBody("0xnot-hex")).toEqual({ text: null, json: null, question: null, answerType: null });
    expect(decodeBody("")).toMatchObject({ json: null });
  });

  it("does not hand a body built to be deep to the parser at all", () => {
    // The nesting is judged from the text. Whatever a parser does with 8,191 nested arrays, it is
    // not asked to find out.
    const parse = vi.spyOn(JSON, "parse");
    try {
      decodeBody(hex("[".repeat(8191) + "]".repeat(8191)));
      expect(parse).not.toHaveBeenCalled();
      decodeBody(hex('{"question":"q"}'));
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  it("reads question and answerType only from the body's own keys", () => {
    // Nothing inherited from Object.prototype can pose as a field of the body.
    expect(decodeBody(hex('{"constructor":"x"}'))).toMatchObject({ question: null, answerType: null });
    expect(decodeBody(hex('{"__proto__":{"question":"smuggled"}}'))).toMatchObject({ question: null });
    expect(decodeBody(hex('{"question":"real","__proto__":{"question":"other"}}')).question).toBe("real");
  });

  it("does not try to store JSON that Postgres would refuse", () => {
    // Valid JSON text whose parsed value holds an escaped NUL, or half a surrogate pair.
    expect(decodeBody(hex('{"question":"a\\u0000b"}'))).toMatchObject({
      text: '{"question":"a\\u0000b"}',
      json: null,
    });
    expect(decodeBody(hex('{"question":"\\ud800"}'))).toMatchObject({ json: null, question: null });
  });

  it("names statuses and finds the oracle request in a completion's URI", () => {
    expect([0, 1, 2, 9].map(intakeStatusName)).toEqual(["answered", "refused", "unanswered", "9"]);
    const id = "03f89e74-3db8-4c10-8fa8-d3424c9a18d4";
    expect(oracleRequestIdFromUri(`https://api.imd.fun/oracle/requests/${id}/attestation`)).toBe(id);
    expect(oracleRequestIdFromUri(`https://api.imd.fun/oracle/requests/${id}`)).toBe(id);
    expect(oracleRequestIdFromUri(`https://api.imd.fun/jobs/${id}`)).toBeNull();
    expect(oracleRequestIdFromUri("")).toBeNull();
    expect(bytes32Text(`0x${"00".repeat(32)}`)).toBeNull();
    expect(bytes32Text(`0x${"ff".repeat(32)}`)).toBeNull();
  });
});

describe("sorting a failed log query", () => {
  const rpc = (message: string, code = -32000) =>
    Object.assign(new Error("RPC Request failed."), { details: message, code });

  it("recognises the range limits of the nodes we met", () => {
    for (const message of [
      "Invalid eth_getLogs request. 'fromBlock'-'toBlock' range too large. Max range: 800",
      "ranges over 10000 blocks are not supported on free plan",
      "query returned more than 10000 results. Try with this block range [0x1, 0x2].",
      "Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range",
      "eth_getLogs is limited to a 10,000 range",
      "exceed maximum block range: 5000",
      "block range is too wide",
      "query timeout exceeded",
    ]) {
      expect([message, classifyLogsError(rpc(message))]).toEqual([message, "range"]);
    }
    expect(classifyLogsError(Object.assign(new Error("HTTP request failed."), { status: 413 }))).toBe(
      "range",
    );
  });

  it("recognises a node that does not keep the history", () => {
    for (const message of [
      "Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode",
      "missing trie node 0xabc (path )",
      "pruned history unavailable",
      "this request requires an archive node",
    ]) {
      expect([message, classifyLogsError(rpc(message))]).toEqual([message, "history"]);
    }
  });

  it("does not mistake a rate limit or a network failure for a range problem", () => {
    expect(classifyLogsError(rpc("Rate limit exceeded", -32005))).toBe("other");
    expect(classifyLogsError(Object.assign(new Error("HTTP request failed."), { status: 429 }))).toBe(
      "other",
    );
    expect(classifyLogsError(rpc("service temporarily unavailable", -32603))).toBe("other");
    expect(classifyLogsError(new Error("fetch failed"))).toBe("other");
    expect(classifyLogsError("nonsense")).toBe("other");
    expect(classifyLogsError(null)).toBe("other");
  });

  it("looks through the chain of causes", () => {
    const wrapped = new Error("outer", {
      cause: new Error("middle", { cause: rpc("block range is too wide") }),
    });
    expect(classifyLogsError(wrapped)).toBe("range");
  });
});

describe("configuration", () => {
  it("runs with nothing set: embedded database, the free node, the last 7,000 blocks", () => {
    // A book with no launch in it: what the indexer does before anything of ours exists.
    const config = loadConfig({ HOUSE_WALLETS_FILE: "" }, BOOKS.none);
    expect(config.databaseUrl).toBeNull();
    expect(config.pgliteDir).toMatch(/apps\/indexer\/\.data\/pglite$/);
    expect(config.rpcUrls).toEqual(["https://ethereum-rpc.publicnode.com"]);
    expect(config.sync).toEqual({
      startBlock: { kind: "behind", blocks: 7000 },
      startBlocks: {},
      chunkSize: 2000,
      confirmations: 2,
      reorgDepth: 64,
      pollIntervalMs: 12_000,
    });
    expect(config.mirror).toMatchObject({
      enabled: true,
      baseUrl: "https://api.imd.fun",
      callsPerMinute: 12,
      watchJobs: [],
    });
    expect(config.http).toEqual({ enabled: true, host: "127.0.0.1", port: 8787 });
    expect(Object.values(config.deployments).every((address) => address === null)).toBe(true);
    expect(config.deploymentsFromEnv).toEqual([]);
    expect(config.houseAddresses).toEqual([]);
  });

  it("takes our own contracts from the deployments book: a launch written there starts its modules at its block", () => {
    // Launch A only: three addresses, each module starting at the launch block; nothing for B or C.
    const aOnly = loadConfig({ HOUSE_WALLETS_FILE: "" }, BOOKS.aOnly);
    expect(aOnly.deployments).toEqual({
      ...NO_DEPLOYMENTS,
      questions: getAddress(BOOKS.aOnly.a.contracts.questions as string),
      jobsReport: getAddress(BOOKS.aOnly.a.contracts.jobsReport as string),
      payroll: getAddress(BOOKS.aOnly.a.contracts.payroll as string),
    });
    const at = { kind: "absolute", block: TEST_LAUNCH.a.block };
    expect(aOnly.sync.startBlocks).toEqual({ questions: at, jobs_report: at, payroll: at });
    expect(aOnly.deploymentsFromEnv).toEqual([]);
    // Our contracts pay the swarm too (Questions buys its oracle requests), so they are HOUSE.
    expect(aOnly.houseAddresses).toEqual(Object.values(BOOKS.aOnly.a.contracts).sort());

    // Everything launched: every contract that has a module has an address and a start block.
    const all = loadConfig({ HOUSE_WALLETS_FILE: "" }, BOOKS.all);
    expect(Object.values(all.deployments).every((address) => address !== null)).toBe(true);
    expect(Object.keys(all.sync.startBlocks).sort()).toEqual(OWN_CONTRACTS.map(moduleNameOf).sort());
    expect(all.sync.startBlocks.work_orders).toEqual({ kind: "absolute", block: TEST_LAUNCH.b.block });
    expect(all.sync.startBlocks.rules).toEqual({ kind: "absolute", block: TEST_LAUNCH.c.block });

    // The environment sits on top of the book: an address given there replaces the book's and
    // must bring its own block; an explicit start block wins over the book's.
    const over = loadConfig(
      {
        HOUSE_WALLETS_FILE: "",
        ADDR_PAYROLL: "0x0000000000000000000000000000000000000a11@26170000",
        START_BLOCK_QUESTIONS: "26155555",
      },
      BOOKS.aOnly,
    );
    expect(over.deployments.payroll).toBe(getAddress("0x0000000000000000000000000000000000000a11"));
    expect(over.deploymentsFromEnv).toEqual(["payroll"]);
    expect(over.sync.startBlocks).toEqual({
      questions: { kind: "absolute", block: 26_155_555 },
      jobs_report: at,
      payroll: { kind: "absolute", block: 26_170_000 },
    });
    // The book's block is not borrowed for an address the book did not give.
    expect(() =>
      loadConfig(
        { HOUSE_WALLETS_FILE: "", ADDR_PAYROLL: "0x0000000000000000000000000000000000000a11" },
        BOOKS.aOnly,
      ),
    ).toThrow(/ADDR_PAYROLL needs the block the contract was deployed in/);
  });

  it("follows the real deployments book, whatever it holds today", () => {
    // No launch is named: the real book is read and the configuration held to it.
    const config = loadConfig({ HOUSE_WALLETS_FILE: "" });
    const flat = flattenBook(DEPLOYMENT_BOOK);
    for (const contract of OWN_CONTRACTS) {
      expect(config.deployments[contract], contract).toBe(flat[contract]);
      const block = DEPLOYMENT_BOOK[launchOf(contract)].block;
      expect(config.sync.startBlocks[moduleNameOf(contract)], contract).toEqual(
        flat[contract] !== null && block !== null ? { kind: "absolute", block } : undefined,
      );
    }
    expect(deploymentsFromBook().deployments).toEqual(config.deployments);
    // Every contract of ours that exists is HOUSE.
    for (const address of Object.values(config.deployments)) {
      if (address) expect(config.houseAddresses).toContain(address.toLowerCase());
    }
  });

  it("reads every knob", () => {
    const config = loadConfig(
      {
        DATABASE_URL: "postgres://user:secret@db.internal:5432/indexer",
        RPC_URL: " https://keyed.example/v2/KEY , https://ethereum-rpc.publicnode.com ",
        START_BLOCK: "26142962",
        START_BLOCK_FEE_TRANSFERS: "-50400",
        START_BLOCK_INTAKE: "latest-100",
        CHUNK_SIZE: "500",
        CONFIRMATIONS: "0",
        REORG_DEPTH: "12",
        POLL_INTERVAL_MS: "4000",
        // An address comes with the block the contract was deployed in...
        ADDR_WORK_ORDERS: "0x00000000000000000000000000000000000de5c0@26170000",
        // ...or the module's start block is given on its own.
        ADDR_JOBS_REPORT: "0x0000000000000000000000000000000000000a11",
        START_BLOCK_JOBS_REPORT: "26169000",
        API_MIRROR: "off",
        API_CALLS_PER_MINUTE: "4",
        WATCH_JOBS: "e9efec16-56f3-40d3-9243-52c453effc7d, E9EFEC16-56F3-40D3-9243-52C453EFFC7D",
        HTTP: "false",
        HOST: "0.0.0.0",
        PORT: "9000",
        HOUSE_WALLETS_FILE: "",
      },
      BOOKS.none,
    );
    expect(config.databaseUrl).toBe("postgres://user:secret@db.internal:5432/indexer");
    expect(config.rpcUrls).toEqual(["https://keyed.example/v2/KEY", "https://ethereum-rpc.publicnode.com"]);
    expect(config.sync.startBlock).toEqual({ kind: "absolute", block: 26_142_962 });
    expect(config.sync.startBlocks).toEqual({
      fee_transfers: { kind: "behind", blocks: 50_400 },
      intake: { kind: "behind", blocks: 100 },
      work_orders: { kind: "absolute", block: 26_170_000 },
      jobs_report: { kind: "absolute", block: 26_169_000 },
    });
    expect(config.sync).toMatchObject({
      chunkSize: 500,
      confirmations: 0,
      reorgDepth: 12,
      pollIntervalMs: 4000,
    });
    expect(config.deployments.workOrders).toBe(getAddress("0x00000000000000000000000000000000000de5c0"));
    expect(config.deployments.jobsReport).toBe(getAddress("0x0000000000000000000000000000000000000a11"));
    expect(config.deployments.payroll).toBeNull();
    // A configured contract of ours is counted as HOUSE without waiting for the published list.
    expect(config.houseAddresses).toEqual([
      "0x0000000000000000000000000000000000000a11",
      "0x00000000000000000000000000000000000de5c0",
    ]);
    expect(config.mirror).toMatchObject({ enabled: false, callsPerMinute: 4 });
    expect(config.mirror.watchJobs).toEqual(["e9efec16-56f3-40d3-9243-52c453effc7d"]);
    expect(config.http).toEqual({ enabled: false, host: "0.0.0.0", port: 9000 });
  });

  it("will not take the address of one of our contracts without the block it was deployed in", () => {
    // Started from the default look-back, the module would skip the contract's first events
    // without a word, and every table folded from creation events would be short from the start.
    const bad = (env: Record<string, string>) => () =>
      loadConfig({ HOUSE_WALLETS_FILE: "", ...env }, BOOKS.none);
    const desk = "0x00000000000000000000000000000000000de5c0";
    expect(bad({ ADDR_WORK_ORDERS: desk })).toThrow(
      /ADDR_WORK_ORDERS needs the block the contract was deployed in.+ADDR_WORK_ORDERS=<address>@<block>.+START_BLOCK_WORK_ORDERS/,
    );
    expect(bad({ ADDR_WORK_ORDERS: `${desk}@` })).toThrow(
      /ADDR_WORK_ORDERS must be <address>@<deployment block>/,
    );
    expect(bad({ ADDR_WORK_ORDERS: `${desk}@latest` })).toThrow(/ADDR_WORK_ORDERS must be/);
    expect(bad({ ADDR_WORK_ORDERS: `${desk}@1@2` })).toThrow(/ADDR_WORK_ORDERS must be/);
    expect(bad({ ADDR_WORK_ORDERS: `0x1234@26170000` })).toThrow(/ADDR_WORK_ORDERS is not an address/);
    // The general START_BLOCK does not count: it is a look-back, not a deployment block.
    expect(bad({ ADDR_WORK_ORDERS: desk, START_BLOCK: "26170000" })).toThrow(
      /ADDR_WORK_ORDERS needs the block/,
    );

    const config = loadConfig(
      {
        HOUSE_WALLETS_FILE: "",
        ADDR_WORK_ORDERS: ` ${desk}@26170000 `,
        ADDR_CROWD_POTS: "0x0000000000000000000000000000000000000c0d@26170001",
        // The more specific instruction wins over the block given with the address.
        START_BLOCK_CROWD_POTS: "26170500",
      },
      BOOKS.none,
    );
    expect(config.deployments.workOrders).toBe(getAddress(desk));
    expect(config.sync.startBlocks).toEqual({
      work_orders: { kind: "absolute", block: 26_170_000 },
      crowd_pots: { kind: "absolute", block: 26_170_500 },
    });
  });

  it("refuses values it cannot use, naming the variable", () => {
    const bad = (env: Record<string, string>) => () => loadConfig({ HOUSE_WALLETS_FILE: "", ...env });
    expect(bad({ CHUNK_SIZE: "0" })).toThrow(/CHUNK_SIZE/);
    expect(bad({ CHUNK_SIZE: "many" })).toThrow(/CHUNK_SIZE/);
    expect(bad({ START_BLOCK: "yesterday" })).toThrow(/START_BLOCK/);
    expect(bad({ START_BLOCK_INTAKE: "1e6" })).toThrow(/START_BLOCK_INTAKE/);
    expect(bad({ RPC_URL: "ws://node" })).toThrow(/RPC_URL/);
    expect(bad({ RPC_URL: " , " })).toThrow(/RPC_URL/);
    expect(bad({ ADDR_PAYROLL: "0x1234" })).toThrow(/ADDR_PAYROLL/);
    expect(bad({ WATCH_JOBS: "job-1" })).toThrow(/WATCH_JOBS/);
    expect(bad({ API_MIRROR: "maybe" })).toThrow(/API_MIRROR/);
    expect(bad({ PORT: "70000" })).toThrow(/PORT/);
  });

  it("will not be configured above 19 API calls a minute", () => {
    expect(MAX_API_CALLS_PER_MINUTE).toBe(19);
    expect(() => loadConfig({ HOUSE_WALLETS_FILE: "", API_CALLS_PER_MINUTE: "20" })).toThrow(
      /API_CALLS_PER_MINUTE/,
    );
    expect(loadConfig({ HOUSE_WALLETS_FILE: "", API_CALLS_PER_MINUTE: "19" }).mirror.callsPerMinute).toBe(19);
  });

  it("reads start blocks as a block or as a distance behind the head", () => {
    expect(parseStartBlock("26142962")).toEqual({ kind: "absolute", block: 26_142_962 });
    expect(parseStartBlock("-7000")).toEqual({ kind: "behind", blocks: 7000 });
    expect(parseStartBlock("latest-7000")).toEqual({ kind: "behind", blocks: 7000 });
    expect(parseStartBlock("latest")).toEqual({ kind: "behind", blocks: 0 });
    expect(resolveStartBlock({ kind: "behind", blocks: 7000 }, 26_164_615)).toBe(26_157_615);
    expect(resolveStartBlock({ kind: "behind", blocks: 7000 }, 100)).toBe(0);
    expect(resolveStartBlock({ kind: "absolute", block: 5 }, 100)).toBe(5);
  });

  it("names the environment variable of each contract", () => {
    expect(OWN_CONTRACTS.map(deploymentEnvKey)).toEqual([
      "ADDR_QUESTIONS",
      "ADDR_JOBS_REPORT",
      "ADDR_PAYROLL",
      "ADDR_WORK_ORDERS",
      "ADDR_CROWD_POTS",
      "ADDR_DOORBELL",
      "ADDR_RULES",
      "ADDR_ENDOWMENTS",
      "ADDR_ZAP",
    ]);
  });

  it("treats a missing house list as empty and reads one that exists", async () => {
    expect(loadHouseAddresses(null)).toEqual([]);
    expect(loadHouseAddresses("/nonexistent/house-wallets.json")).toEqual([]);

    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "hw-indexer-house-"));
    try {
      const file = join(dir, "house-wallets.json");
      await writeFile(
        file,
        JSON.stringify({
          wallets: [{ label: "W1", address: "0x871e507B6a70F858Ad4B414bddb77473630C366b" }],
          contracts: [
            { address: "0x60CcC928eb8EEE1d64CA0164565BfA9858669560" },
            { address: "0x871e507B6a70F858Ad4B414bddb77473630C366b" },
          ],
        }),
      );
      expect(loadHouseAddresses(file)).toEqual([
        "0x60ccc928eb8eee1d64ca0164565bfa9858669560",
        "0x871e507b6a70f858ad4b414bddb77473630c366b",
      ]);
      await writeFile(file, "{ this is not json");
      expect(() => loadHouseAddresses(file)).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("choosing the database", () => {
  it("takes Postgres when a connection string is given, without printing its credentials", async () => {
    // The pool connects on its first query, and none is made here: no server is needed or touched.
    const database = await openDatabase({
      databaseUrl: "postgres://indexer:not-a-real-password@127.0.0.1:1/helpwanted",
      migrate: false,
    });
    try {
      expect(database.kind).toBe("postgres");
      expect(database.where).toBe("postgres://127.0.0.1:1/helpwanted");
      expect(database.where).not.toMatch(/password|indexer:/);
    } finally {
      await database.close();
    }
  });
});

describe("the chain client", () => {
  it("is built for one node or for several, and needs at least one", () => {
    // No request is made here: building a client opens nothing.
    const lines: string[] = [];
    const log = createLogger("debug", (line) => lines.push(line));
    expect(createChainClient(["https://one.example/v2/KEY"], { log }).chain?.id).toBe(1);
    expect(createChainClient(["https://one.example/v2/KEY", "https://two.example"], { log }).chain?.id).toBe(
      1,
    );
    expect(() => createChainClient([])).toThrow(/at least one RPC URL/);
    expect(lines).toEqual([]);
  });

  describe("with a stand-in for fetch", () => {
    // The transport is viem's real HTTP transport; only the global `fetch` it calls is replaced,
    // so nothing leaves the process.
    const refusing = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = refusing;
    });
    const answer = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        headers: { "content-type": "application/json" },
      });

    it("cuts off a request in flight when the process is stopping", async () => {
      const controller = new AbortController();
      let sent = 0;
      // A node that never answers. Like the real `fetch`, the stand-in ends a request only when
      // its signal fires, and refuses at once a request whose signal has already fired.
      globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
        sent++;
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const fail = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
          if (signal?.aborted) return fail();
          signal?.addEventListener("abort", fail, { once: true });
        });
      }) as typeof fetch;
      const client = createChainClient(["https://node.example"], { signal: controller.signal });
      const began = Date.now();
      const pending = client.getBlockNumber({ cacheTime: 0 }).catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      expect(await pending).toBeInstanceOf(Error);
      // Far sooner than the transport's own 30-second timeout, retries included.
      expect(Date.now() - began).toBeLessThan(5000);
      expect(sent).toBeGreaterThanOrEqual(1);
    }, 10_000);

    it("says at debug level which node served a request when there are several", async () => {
      const lines: string[] = [];
      const log = createLogger("debug", (line) => lines.push(line));
      // The first node refuses the way a node without history does; the second serves.
      globalThis.fetch = (async (input: unknown) =>
        String(input).includes("first.example")
          ? new Response(
              JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "no history here" } }),
              { headers: { "content-type": "application/json" } },
            )
          : answer("0x10")) as typeof fetch;
      const client = createChainClient(
        ["https://first.example/v2/SECRETKEY123456", "https://second.example"],
        {
          log,
        },
      );
      expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(16n);
      const noted = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(noted.map((entry) => [entry.message, entry.method, entry.node, entry.served])).toEqual([
        ["rpc", "eth_blockNumber", "https://first.example", false],
        ["rpc", "eth_blockNumber", "https://second.example", true],
      ]);
      expect(lines.join("\n")).not.toMatch(/SECRETKEY/);
    });
  });
});

describe("what reaches a log", () => {
  afterEach(() => {
    clearSecrets();
  });

  it("keeps a keyed RPC URL's path out of it", () => {
    expect(redactRpcUrl("https://eth-mainnet.example/v2/SECRETKEY?token=abc")).toBe(
      "https://eth-mainnet.example",
    );
    expect(redactRpcUrl("not a url")).toBe("(unreadable RPC URL)");
  });

  it("reports an error as one line without the request it came from", () => {
    const viemLike = Object.assign(
      new Error("HTTP request failed.\n\nURL: https://eth-mainnet.example/v2/SECRETKEY\nRequest body: {}"),
      {
        shortMessage: "HTTP request failed.",
        details: "fetch failed",
      },
    );
    expect(errorMessage(viemLike)).toBe("HTTP request failed. (fetch failed)");
    expect(errorMessage(new Error("first line\nsecond line"))).toBe("first line");
    expect(errorMessage("plain")).toBe("plain");
  });

  it("puts a server's answer on one line and cuts it, however long it is", () => {
    const page = `<html>\n<body>\n${"upstream said no. ".repeat(500)}</body></html>`;
    const viemLike = Object.assign(new Error("HTTP request failed."), {
      shortMessage: "HTTP request failed.",
      details: page,
    });
    const message = errorMessage(viemLike);
    expect(message).not.toMatch(/\n/);
    expect(message.length).toBeLessThanOrEqual(240);
    expect(message.startsWith("HTTP request failed. (<html> <body> upstream said no.")).toBe(true);
    expect(errorMessage(new Error("x".repeat(5000))).length).toBe(MAX_ERROR_CHARS);
  });

  it("names the reason behind a failed database query, not the whole statement", () => {
    const failed = new Error(
      'Failed query: insert into "intake_requests" (…) values ($1, $2)\nparams: 0xabc',
      {
        cause: new Error("unsupported Unicode escape sequence\nDETAIL: \\u0000 cannot be converted to text."),
      },
    );
    expect(errorMessage(failed)).toBe("a database query failed (unsupported Unicode escape sequence)");
  });

  it("finds the parts of a URL that can hold a credential", () => {
    expect(secretsOfUrl("https://eth-mainnet.example/v2/0123456789abcdef0123")).toEqual([
      "https://eth-mainnet.example/v2/0123456789abcdef0123",
      "/v2/0123456789abcdef0123",
      "0123456789abcdef0123",
    ]);
    expect(secretsOfUrl("https://node.example/?apikey=s3cr3t-token")).toEqual([
      "https://node.example/?apikey=s3cr3t-token",
      "apikey=s3cr3t-token",
      "s3cr3t-token",
    ]);
    // The free node has nothing to hide, and a database's name is not a secret.
    expect(secretsOfUrl("https://ethereum-rpc.publicnode.com")).toEqual([]);
    expect(secretsOfUrl("postgres://indexer:p%40ssword1@db.internal:5432/indexer", { path: false })).toEqual([
      "postgres://indexer:p%40ssword1@db.internal:5432/indexer",
      "p%40ssword1",
      "p@ssword1",
    ]);
  });

  it("cuts registered secrets out of error texts and log lines, wherever they sit", () => {
    registerSecrets(secretsOfUrl("https://eth-mainnet.example/v2/0123456789abcdef0123"));
    // Too short to be a key: registering it would only blank ordinary words.
    registerSecrets(["v2", null, undefined]);

    expect(redact("GET /v2/0123456789abcdef0123 failed, v2 is fine")).toBe(
      "GET [redacted] failed, v2 is fine",
    );
    expect(redact("key=0123456789abcdef0123")).toBe("key=[redacted]");
    const gateway = Object.assign(new Error("HTTP request failed."), {
      shortMessage: "HTTP request failed.",
      details: "upstream error for /v2/0123456789abcdef0123",
    });
    expect(errorMessage(gateway)).toBe("HTTP request failed. (upstream error for [redacted])");

    const lines: string[] = [];
    const log = createLogger("info", (line) => lines.push(line));
    log.error("module failed", {
      error: gateway,
      text: "see https://eth-mainnet.example/v2/0123456789abcdef0123",
      nested: { url: "https://eth-mainnet.example/v2/0123456789abcdef0123" },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/0123456789abcdef0123/);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: "error",
      error: "HTTP request failed. (upstream error for [redacted])",
      text: "see [redacted]",
      nested: { url: "[redacted]" },
    });
  });

  it("shows the public only words this package or viem wrote", () => {
    // viem's sentence for the class of error, without the server's answer beside it.
    const gateway = Object.assign(new Error("HTTP request failed."), {
      shortMessage: "HTTP request failed.",
      details: "upstream error for /v2/0123456789abcdef0123",
    });
    expect(publicErrorMessage(gateway)).toBe("HTTP request failed.");
    // An error of ours carries its own public wording: the node's sentence is left out of it.
    const history = new HistoryUnavailableError(10, 20, "Archive requests require a personal token <b>");
    expect(history.message).toMatch(/Archive requests require a personal token <b>/);
    expect(publicErrorMessage(history)).toBe(
      "the node refused logs for blocks 10 to 20 because it does not keep history that far back. Point RPC_URL at a node that keeps old logs.",
    );
    expect(publicErrorMessage(history.withAdvice("Try the skip command."))).toMatch(
      /Try the skip command\.$/,
    );
    // Anything else is named by its class and nothing more.
    expect(publicErrorMessage(new RangeError("Maximum call stack size exceeded"))).toBe(
      "RangeError: see the indexer's log",
    );
    expect(publicErrorMessage(new Error("password=hunter2 rejected by db.internal"))).toBe(
      "Error: see the indexer's log",
    );
    expect(publicErrorMessage("just text")).toBe("an error occurred: see the indexer's log");
    expect(publicErrorMessage(null)).toBe("an error occurred: see the indexer's log");
  });
});

describe("the tests themselves", () => {
  it("cannot reach the network", () => {
    // `test/helpers/noNetwork.ts` is loaded before every test file.
    expect(() => fetch("https://api.imd.fun/health")).toThrow(/tests must run offline/);
    expect(() => net.connect(443, "api.imd.fun")).toThrow(/tests must run offline/);
    expect(() => net.connect({ port: 443, host: "api.imd.fun" })).toThrow(/tests must run offline/);
    // A port on this machine is no exception, unless it is the database the run was pointed at.
    expect(() => net.connect(9, "127.0.0.1")).toThrow(/tests must run offline/);
  });
});

describe("what a node may claim", () => {
  it("accepts as a block time only what a mainnet block can carry", () => {
    expect(isBlockTime(1_438_269_973)).toBe(true);
    expect(isBlockTime(1_791_273_263)).toBe(true);
    expect(isBlockTime(0)).toBe(false);
    expect(isBlockTime(1_438_269_972)).toBe(false);
    expect(isBlockTime(1.5e9 + 0.5)).toBe(false);
    expect(isBlockTime(8.64e15)).toBe(false);
    expect(isBlockTime(Number.NaN)).toBe(false);
  });
});

describe("where the evidence goes", () => {
  it("writes snapshots under evidence/indexer at the root of the repository by default", () => {
    // Brief section 11, decision 15.
    expect(DEFAULT_SNAPSHOT_DIR.replaceAll("\\", "/")).toMatch(/\/evidence\/indexer$/);
    expect(DEFAULT_SNAPSHOT_DIR).not.toMatch(/apps/);
  });
});
