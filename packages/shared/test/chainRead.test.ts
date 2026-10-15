import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  toFunctionSelector,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  MAINNET,
  answerDelivery,
  checksumAddress,
  classifyLogsError,
  decodeLogUnder,
  errorText,
  eventNamesOf,
  jobsReportAbi,
  keccakOfHex,
  payrollAbi,
  questionsAbi,
  viewCallData,
  viewResult,
  workOrdersAbi,
} from "../src/index.js";

const H1 = "0x60CcC928eb8EEE1d64CA0164565BfA9858669560";
const FEED = "0x4bf83605cd50e9658472bde9be314bb3848a563301fa793328bef17ad2a07b61";

describe("decodeLogUnder", () => {
  it("names a real log: the OracleSignerSet of launch A's launch transaction", () => {
    // Log 0x3ae of transaction 0x9ce6111c…2c58, block 26,182,869, as the node serves it.
    const named = decodeLogUnder(
      questionsAbi,
      [
        "0x5f6477abf0bbd4c4bd971fd692c640800f86a93a8ba2450d0aa31e68700194c2",
        "0x0000000000000000000000005598aa9146215bc13eb26f2c692ad1461fd32982",
      ],
      "0x",
    );
    expect(named).toEqual({ event: "OracleSignerSet", args: { signer: MAINNET.ORACLE_SIGNER } });
  });

  it("gives arguments by name, integers as bigint and addresses checksummed", () => {
    const topics = encodeEventTopics({
      abi: questionsAbi,
      eventName: "RoundAnswered",
      args: { feedId: FEED, round: 1n, oracleRequestId: `0x${"ab".repeat(16)}${"00".repeat(16)}` },
    });
    const data = encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint16" },
        { type: "bytes32" },
        { type: "address" },
      ],
      [112n * 10n ** 18n, 112n, 0, `0x${"00".repeat(32)}`, H1.toLowerCase() as `0x${string}`],
    );
    const named = decodeLogUnder(questionsAbi, topics as string[], data);
    expect(named?.event).toBe("RoundAnswered");
    expect(named?.args).toMatchObject({
      feedId: FEED,
      round: 1n,
      value: 112n * 10n ** 18n,
      figure: 112n,
      agreed: 0,
      deliveredBy: getAddress(H1),
    });
  });

  it("answers null for a log the ABI does not know, never an error", () => {
    const printed = encodeEventTopics({
      abi: jobsReportAbi,
      eventName: "Printed",
      args: { index: 0n, round: 1n },
    });
    // A JobsReport event held against the Questions ABI.
    expect(decodeLogUnder(questionsAbi, printed as string[], "0x")).toBeNull();
    // No topics (an anonymous log), no ABI, and text that is not hex.
    expect(decodeLogUnder(questionsAbi, [], "0x")).toBeNull();
    expect(decodeLogUnder([], printed as string[], "0x")).toBeNull();
    expect(decodeLogUnder(jobsReportAbi, printed as string[], "not hex")).toBeNull();
  });

  it("is strict: the right event with data that is too short is not named", () => {
    const topics = encodeEventTopics({
      abi: jobsReportAbi,
      eventName: "Printed",
      args: { index: 0n, round: 1n },
    });
    const whole = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint64" }, { type: "uint64" }, { type: "uint256" }, { type: "uint256" }],
      [5n, 1n, 2n, 5n, 1n],
    );
    expect(decodeLogUnder(jobsReportAbi, topics as string[], whole)?.event).toBe("Printed");
    expect(decodeLogUnder(jobsReportAbi, topics as string[], whole.slice(0, whole.length - 64))).toBeNull();
  });
});

describe("eventNamesOf", () => {
  it("lists an ABI's events and nothing else", () => {
    const names = eventNamesOf(jobsReportAbi);
    expect(names).toEqual([
      "BestDay",
      "CountRecorded",
      "Counted",
      "EmployersOfTheWeek",
      "Printed",
      "RoundSkipped",
    ]);
    expect(eventNamesOf(workOrdersAbi)).toContain("OrderOpened");
    expect(eventNamesOf([])).toEqual([]);
  });
});

describe("viewCallData and viewResult", () => {
  it("builds the calldata of a view and reads its answer back by name", () => {
    expect(viewCallData(payrollAbi, "ledger")).toBe(toFunctionSelector("function ledger()"));
    expect(viewCallData(questionsAbi, "roundCount", [FEED])).toBe(
      `${toFunctionSelector("function roundCount(bytes32)")}${FEED.slice(2)}`,
    );
    const ledger = {
      received: 1n,
      toStakers: 2n,
      toSeats: 3n,
      toFeeds: 4n,
      dripped: 5n,
      seatClaimed: 6n,
      tipsIn: 7n,
      tipsClaimed: 8n,
      feedsFunded: 9n,
      tipsToSeats: 10n,
      feedsReleased: 11n,
    };
    const returned = encodeFunctionResult({ abi: payrollAbi, functionName: "ledger", result: ledger });
    expect(viewResult(payrollAbi, "ledger", returned)).toEqual(ledger);
  });

  it("throws for an answer that does not fit, which is what an address with no code gives", () => {
    expect(() => viewResult(payrollAbi, "ledger", "0x")).toThrow();
    expect(() => viewCallData(payrollAbi, "noSuchFunction")).toThrow();
  });
});

describe("checksumAddress and keccakOfHex", () => {
  it("spells an address with its checksum and refuses what is not one", () => {
    expect(checksumAddress(H1.toLowerCase())).toBe(H1);
    expect(() => checksumAddress("0x1234")).toThrow();
  });

  it("hashes bytes given as hex: no bytes give the empty hash", () => {
    expect(keccakOfHex("0x")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(keccakOfHex("0x00")).toBe("0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a");
    expect(() => keccakOfHex("0x0")).toThrow(TypeError);
    expect(() => keccakOfHex("zz")).toThrow(TypeError);
  });
});

describe("classifyLogsError", () => {
  const rpc = (message: string, code = -32000) =>
    Object.assign(new Error("RPC Request failed."), { details: message, code });

  it("tells a range the node finds too large from history it does not keep", () => {
    expect(classifyLogsError(rpc("query exceeds max block range 2000"))).toBe("range");
    expect(classifyLogsError(rpc("eth_getLogs is limited to a 10,000 range"))).toBe("range");
    expect(classifyLogsError(Object.assign(new Error("HTTP request failed."), { status: 413 }))).toBe(
      "range",
    );
    expect(classifyLogsError(rpc("Archive requests require a personal token"))).toBe("history");
    expect(classifyLogsError(rpc("missing trie node 0xabc"))).toBe("history");
  });

  it("calls everything else other, a rate limit included", () => {
    expect(classifyLogsError(rpc("Rate limit exceeded", -32005))).toBe("other");
    expect(classifyLogsError(Object.assign(new Error("HTTP request failed."), { status: 429 }))).toBe(
      "other",
    );
    expect(classifyLogsError(new Error("fetch failed"))).toBe("other");
    expect(classifyLogsError(null)).toBe("other");
  });

  it("reads through a chain of causes", () => {
    const wrapped = new Error("outer", { cause: rpc("block range is too wide") });
    expect(classifyLogsError(wrapped)).toBe("range");
    expect(errorText(wrapped).parts).toContain("block range is too wide");
  });
});

describe("answerDelivery", () => {
  it("is the callback when the Intake delivered, submit for anyone else", () => {
    expect(answerDelivery(MAINNET.INTAKE.toLowerCase(), MAINNET.INTAKE)).toBe("callback");
    expect(answerDelivery(H1, MAINNET.INTAKE)).toBe("submit");
    // The legacy Intake is not the one launch A's Questions is built on.
    expect(answerDelivery(MAINNET.INTAKE_V1, MAINNET.INTAKE)).toBe("submit");
  });
});
