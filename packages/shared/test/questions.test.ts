import { readFileSync } from "node:fs";
import { decodeAbiParameters, keccak256, stringToHex, zeroAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  ABANDON_STEP,
  ANSWER_TYPE_CODE,
  HOUSE_FEEDS,
  HOUSE_FEED_NAMES,
  MAINNET,
  QUESTIONS_WAITS,
  REQUEST_BLOCKER,
  ROUND_STATUS,
  abandonStepName,
  assembleOracleBody,
  checkOracleBody,
  feedBody,
  feedBodyHex,
  feedIdOf,
  feedQuestionHash,
  holdsPanelEvidence,
  houseFeedById,
  isHouseFeedName,
  isSignedFor,
  oracleBodyParts,
  questionHashOfRequest,
  requestBlockerName,
  roundStatusName,
  signedAttestation,
  verifyAttestation,
  type AnswerType,
  type OracleQuestion,
  type OracleTerms,
} from "../src/index.js";
import { IntakeRead, OracleAttestationDocument, OracleRequest } from "../src/api/index.js";
import {
  FEED_FIXTURES_REL,
  HOUSE_FEEDS_FILE,
  feedFixturesPresent,
  renderHouseFeedsFile,
} from "../scripts/house-feeds-build.js";
import { REPO, readJson, repoFile } from "./paths.js";

const feeds = HOUSE_FEED_NAMES.map((name) => HOUSE_FEEDS[name]);

describe("the three house feeds", () => {
  it("the generated file is what the generator would write from launch A's fixtures now", (ctx) => {
    if (!feedFixturesPresent(REPO)) {
      return ctx.skip(`${FEED_FIXTURES_REL} is absent: the house feeds cannot be compared with their source`);
    }
    expect(
      readFileSync(HOUSE_FEEDS_FILE, "utf8") === renderHouseFeedsFile(REPO),
      "src/generated/houseFeeds.ts differs from the fixtures: run `pnpm --filter @help-wanted/shared feeds:gen`",
    ).toBe(true);
  });

  it("are payrolls, hires and employers, in Payroll's order A, B, C", () => {
    expect(feeds.map((f) => f.name)).toEqual(["payrolls", "hires", "employers"]);
    expect(feeds.map((f) => f.payrollSlot)).toEqual(["A", "B", "C"]);
    expect(feeds.map((f) => f.runwayRequests)).toEqual([14, 14, 4]);
    expect(isHouseFeedName("hires")).toBe(true);
    expect(isHouseFeedName("rules")).toBe(false);
    expect(houseFeedById(HOUSE_FEEDS.hires.id.toUpperCase().replace("0X", "0x"))?.name).toBe("hires");
    expect(houseFeedById(`0x${"00".repeat(32)}`)).toBeUndefined();
  });

  it.each(feeds.map((f) => [f.name, f] as const))("%s: the id is the hash of its own parts", (_n, feed) => {
    expect(feedIdOf(feed.params, feed.qPrefix, feed.tail)).toBe(feed.id);
    // One byte of the question, or one parameter, gives another feed.
    expect(feedIdOf(feed.params, `${feed.qPrefix}20` as Hex, feed.tail)).not.toBe(feed.id);
    expect(feedIdOf({ ...feed.params, tip: feed.params.tip + 1n }, feed.qPrefix, feed.tail)).not.toBe(
      feed.id,
    );
    expect(stringToHex(feed.qPrefixText)).toBe(feed.qPrefix);
    expect(stringToHex(feed.tailText)).toBe(feed.tail);
  });

  it("are the ids launch A's manifest gives JobsReport and Payroll, when the document is there", (ctx) => {
    const path = repoFile("launches", "a-payroll", "docs", "LAUNCH.md");
    if (!path) return ctx.skip("launches/a-payroll/docs/LAUNCH.md is absent");
    const text = readFileSync(path, "utf8");
    for (const feed of feeds) {
      const block = new RegExp(`<!-- feedId:${feed.name} -->\\s*\`\`\`text\\s*(0x[0-9a-f]{64})`).exec(text);
      expect(block?.[1], `${feed.name}: no feed id block in LAUNCH.md`).toBe(feed.id);
    }
    const manifest = /<!-- manifest -->\s*```json\s*([\s\S]*?)```/.exec(text)?.[1];
    expect(manifest).toBeDefined();
    const contracts = (
      JSON.parse(manifest as string) as { contracts: { contract: string; constructorArgs: string[] }[] }
    ).contracts;
    expect(contracts.map((c) => c.contract)).toEqual(["Questions", "JobsReport", "Payroll"]);
    const ids = feeds.map((f) => f.id);
    expect(contracts[1]?.constructorArgs.slice(1)).toEqual(ids);
    expect(contracts[2]?.constructorArgs.slice(6)).toEqual(ids);
    // Questions is built on version 2 of the Intake, IMD and the oracle signer.
    expect(contracts[0]?.constructorArgs).toEqual(
      [MAINNET.INTAKE, MAINNET.IMD, MAINNET.ORACLE_SIGNER].map((a) => a.toLowerCase()),
    );
  });

  it("have the parameters the launch fixes: daily, daily, weekly", () => {
    const { payrolls, hires, employers } = HOUSE_FEEDS;
    for (const feed of [payrolls, hires]) {
      expect(feed.answerType).toBe("uint256");
      expect(feed.evidence).toBe("chain");
      expect(feed.submit).toBe(true);
      expect(feed.params.cadenceBlocks).toBe(7_000);
      expect(feed.params.maxWindowBlocks).toBe(21_600);
      expect(feed.params.contiguous).toBe(true);
    }
    expect(employers.answerType).toBe("address[]");
    expect(employers.evidence).toBe("panel");
    // A panel judges it, so only the Intake's own callback can answer a round.
    expect(employers.submit).toBe(false);
    expect(employers.params.cadenceBlocks).toBe(49_000);
    expect(employers.params.maxWindowBlocks).toBe(50_400);
    expect(employers.params.contiguous).toBe(false);
    for (const feed of feeds) {
      expect(feed.params.action).toBe(MAINNET.ORACLE_ACTION);
      expect(feed.params.chainId).toBe(1n);
      expect([feed.params.panelSize, feed.params.quorum, feed.params.minAgreed]).toEqual([7, 5, 5]);
      expect(feed.params.validFor).toBe(86_400);
      expect(feed.params.lagBlocks).toBe(12);
      expect(feed.params.pinHash).toBe(true);
      expect(feed.params.maxPrice).toBe(2_000_000_000_000_000_000n);
      expect(feed.params.tip).toBe(50_000_000_000_000_000n);
      expect(feed.params.gateCmp).toBe(0);
      expect(feed.params.gateTarget).toBe(zeroAddress);
      expect(ANSWER_TYPE_CODE[feed.answerType]).toBe(feed.params.answerType);
    }
  });

  it("tell a panel-judged prefix from a chain-evidence one the way the contract does", () => {
    expect(holdsPanelEvidence(HOUSE_FEEDS.employers.qPrefix)).toBe(true);
    expect(holdsPanelEvidence(HOUSE_FEEDS.employers.qPrefixText)).toBe(true);
    expect(holdsPanelEvidence(HOUSE_FEEDS.payrolls.qPrefix)).toBe(false);
    // Inside a JSON string a quote is escaped, so wording about evidence does not count.
    expect(holdsPanelEvidence('{"question":"is \\"evidence\\":\\"panel\\" set?"')).toBe(false);
  });

  it.each(feeds.map((f) => [f.name, f] as const))(
    "%s: a body built for a window is valid, and its hash is the pinned one",
    (_n, feed) => {
      const window = { fromBlock: 26_172_770, toBlock: 26_179_769 };
      const body = feedBody(feed, window);
      expect(checkOracleBody(body)).toEqual([]);
      const parsed = JSON.parse(body) as Record<string, unknown>;
      expect(parsed.window).toEqual(window);
      expect(parsed.panelSize).toBe(7);
      expect(parsed.consumer).toBeUndefined();
      expect(feedBodyHex(feed, window)).toBe(stringToHex(body));
      expect(feedQuestionHash(feed, window)).toBe(
        keccak256(stringToHex(`${feed.qPrefixText}${window.fromBlock},"toBlock":${window.toBlock}}}`)),
      );
    },
  );
});

interface ProofIndex {
  proofs: {
    feed: string;
    feedId: Hex;
    transaction: Hex;
    intakeRequestId: Hex;
    bodyHash: Hex;
    oracleRequestId: string;
    fromBlock: number;
    toBlock: number;
    questionHash: Hex;
    answerAbiEncoded: Hex;
    agreed: number;
  }[];
}

describe("the proof records of launch A: one real request per house feed", () => {
  const proofFile = (name: string) =>
    repoFile("launches", "a-payroll", "test", "fixtures", "questions", "proofs", name);
  const indexPath = proofFile("index.json");
  const skipNote =
    "launches/a-payroll/test/fixtures/questions/proofs is absent: the proofs cannot be replayed";

  it("has a proof for each feed", (ctx) => {
    if (!indexPath) return ctx.skip(skipNote);
    const index = readJson<ProofIndex>(indexPath);
    expect(index.proofs.map((p) => p.feed)).toEqual(["payrolls", "hires", "employers"]);
    for (const proof of index.proofs) {
      expect(proof.feedId).toBe(HOUSE_FEEDS[proof.feed as keyof typeof HOUSE_FEEDS].id);
    }
  });

  it.for(feeds.map((f) => [f.name, f] as const))(
    "%s: the body that was bought and the hash that was signed are the ones built here",
    async ([, feed], ctx) => {
      if (!indexPath) return ctx.skip(skipNote);
      const proof = readJson<ProofIndex>(indexPath).proofs.find((p) => p.feed === feed.name);
      if (proof === undefined) throw new Error(`no proof for ${feed.name}`);
      const window = { fromBlock: proof.fromBlock, toBlock: proof.toBlock };

      // 1. The Intake service hashed the body it received: it is this feed's body for that window.
      const intake = IntakeRead.parse(readJson(proofFile(`${feed.name}.intake.json`) as string));
      const entry = intake.entries.find((e) => e.requestId === proof.intakeRequestId);
      expect(entry, "the proof's request is in the Intake record").toBeDefined();
      expect(keccak256(feedBodyHex(feed, window))).toBe(proof.bodyHash);
      expect(entry?.bodyHash).toBe(proof.bodyHash);
      expect(entry?.admission?.result?.requestId).toBe(proof.oracleRequestId);
      expect(intake.transactionHash).toBe(proof.transaction);

      // 2. The hash the oracle attested is the one the contract pins for that window.
      const document = OracleAttestationDocument.parse(
        readJson(proofFile(`${feed.name}.attestation.json`) as string),
      );
      expect(feedQuestionHash(feed, window)).toBe(proof.questionHash);
      expect(document.message.questionHash).toBe(proof.questionHash);

      // 3. Built from nothing but the oracle's own record of the request (the question, its
      // definitions, `evidence` when it is "panel", `head` when there is one), the hash, the
      // prefix and the tail come out the same: the builder handles all three shapes.
      const record = OracleRequest.parse(readJson(proofFile(`${feed.name}.oracle.json`) as string));
      expect(questionHashOfRequest(record)).toBe(proof.questionHash);
      const question: OracleQuestion = {
        question: record.question,
        chainId: record.chainId,
        answerType: record.answerType as AnswerType,
        definitions: record.definitions,
        evidence: record.evidence === "panel" ? "panel" : "chain",
        head: record.head,
      };
      const terms: OracleTerms = {
        panelSize: record.panelSize,
        quorum: record.quorum,
        validForSeconds: record.validForSeconds,
        toleranceBps: record.toleranceBps,
      };
      const parts = oracleBodyParts(question, terms);
      expect(parts.qPrefix).toBe(feed.qPrefixText);
      expect(parts.tail).toBe(feed.tailText);
      expect(keccak256(stringToHex(assembleOracleBody(parts, window)))).toBe(proof.bodyHash);
      if (feed.name === "employers") {
        expect(record.evidence).toBe("panel");
        expect(record.head).toBe(3);
        expect(parts.qPrefix).toContain('"evidence":"panel","head":3,"question"');
      } else {
        expect(record.evidence).toBe("chain");
        expect(record.head).toBeUndefined();
      }

      // 4. The answer is of the feed's type, from a panel the feed accepts, and really signed by
      // the oracle signer. It was signed for nobody: the proofs named no callback.
      const signed = signedAttestation(document);
      expect(signed.oracleRequestId).toBe(proof.oracleRequestId);
      expect(signed.message.answerType).toBe(feed.params.answerType);
      expect(signed.message.answer).toBe(proof.answerAbiEncoded);
      expect(signed.message.panelSize).toBeGreaterThanOrEqual(feed.params.panelSize);
      expect(signed.message.quorum).toBeGreaterThanOrEqual(feed.params.quorum);
      expect(signed.message.agreed).toBeGreaterThanOrEqual(signed.message.quorum);
      expect(Number(signed.message.expiresAt - signed.message.issuedAt)).toBe(feed.params.validFor);
      expect(isSignedFor(signed, { chainId: 1, verifyingContract: zeroAddress })).toBe(true);
      expect(isSignedFor(signed, { chainId: 1, verifyingContract: MAINNET.INTAKE })).toBe(false);
      expect(
        await verifyAttestation(signed.consumer, signed.message, signed.signature, MAINNET.ORACLE_SIGNER),
      ).toBe(true);
      // In any other contract's domain the same signature recovers somebody else.
      expect(
        await verifyAttestation(
          { chainId: 1, verifyingContract: MAINNET.INTAKE },
          signed.message,
          signed.signature,
          MAINNET.ORACLE_SIGNER,
        ),
      ).toBe(false);
      if (feed.name === "employers") {
        const [list] = decodeAbiParameters([{ type: "address[]" }], signed.message.answer);
        expect(list.length).toBe(3);
      } else {
        const [figure] = decodeAbiParameters([{ type: "uint256" }], signed.message.answer);
        expect(figure).toBe(feed.name === "payrolls" ? 114_000_000_000_000_000_000n : 228n);
      }
    },
  );

  it("the first employers body, which was not attested, has no signed answer to read", (ctx) => {
    const path = proofFile("employers-first-attempt.oracle.json");
    if (!path) return ctx.skip(skipNote);
    const record = OracleRequest.parse(readJson(path));
    expect(record.status).toBe("mismatch");
    expect(record.attestation ?? null).toBeNull();
    expect(
      IntakeRead.parse(readJson(proofFile("employers-first-attempt.intake.json") as string)).entries.length,
    ).toBe(1);
  });
});

describe("the enums and waits of Questions", () => {
  const strip = (text: string) => text.replace(/\/\/\/.*$/gm, "").replace(/\/\/.*$/gm, "");
  const enumOf = (source: string, name: string): string[] => {
    const body = new RegExp(`enum ${name} \\{([\\s\\S]*?)\\}`).exec(source)?.[1];
    if (body === undefined) throw new Error(`enum ${name} not found`);
    return body
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
  };

  it("are declared in the order the contract declares them", (ctx) => {
    const questions = repoFile("launches", "a-payroll", "src", "questions", "Questions.sol");
    const iface = repoFile("launches", "a-payroll", "src", "interfaces", "IQuestions.sol");
    if (!questions || !iface) return ctx.skip("launches/a-payroll/src is absent");
    const source = strip(readFileSync(questions, "utf8"));
    expect(Object.keys(REQUEST_BLOCKER)).toEqual(enumOf(source, "Blocker"));
    expect(Object.keys(ABANDON_STEP)).toEqual(enumOf(source, "AbandonStep"));
    expect(Object.keys(ROUND_STATUS)).toEqual(enumOf(strip(readFileSync(iface, "utf8")), "RoundStatus"));
    for (const table of [REQUEST_BLOCKER, ABANDON_STEP, ROUND_STATUS]) {
      expect(Object.values(table)).toEqual(Object.values(table).map((_v, i) => i));
    }
  });

  it("carry the waits the contract fixes", (ctx) => {
    const questions = repoFile("launches", "a-payroll", "src", "questions", "Questions.sol");
    const attestation = repoFile("launches", "a-payroll", "src", "questions", "OracleAttestation.sol");
    if (!questions || !attestation) return ctx.skip("launches/a-payroll/src is absent");
    const seconds = (source: string, name: string): number => {
      const m = new RegExp(`constant ${name} = (\\d+) (minutes|hours);`).exec(source);
      if (!m) throw new Error(`${name} not found`);
      return Number(m[1]) * (m[2] === "hours" ? 3600 : 60);
    };
    const source = readFileSync(questions, "utf8");
    expect(QUESTIONS_WAITS.SUBMIT_AFTER_SILENCE).toBe(seconds(source, "SUBMIT_AFTER_SILENCE"));
    expect(QUESTIONS_WAITS.ABANDON_AFTER_COMPLETED).toBe(seconds(source, "ABANDON_AFTER_COMPLETED"));
    expect(QUESTIONS_WAITS.ABANDON_AFTER_SILENCE).toBe(seconds(source, "ABANDON_AFTER_SILENCE"));
    expect(QUESTIONS_WAITS.ISSUED_AT_TOLERANCE).toBe(
      seconds(readFileSync(attestation, "utf8"), "ISSUED_AT_TOLERANCE"),
    );
  });

  it("names a code and refuses one it does not know", () => {
    expect(requestBlockerName(9)).toBe("MeterTooLow");
    expect(requestBlockerName(0)).toBe("None");
    expect(abandonStepName(1)).toBe("StartWait");
    expect(roundStatusName(2)).toBe("Answered");
    expect(() => requestBlockerName(10)).toThrow(RangeError);
    expect(() => abandonStepName(3)).toThrow(RangeError);
  });
});
