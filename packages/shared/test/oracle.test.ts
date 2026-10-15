import { readdirSync } from "node:fs";
import { hexToString, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  ANSWER_TYPE_CODE,
  MAINNET,
  ORACLE_ATTESTATION_TYPES,
  ORACLE_BODY_MAX_BYTES,
  assembleOracleBody,
  attestationDigest,
  attestationMessage,
  buildOracleBody,
  checkOracleBody,
  isSignedFor,
  oracleBodyParts,
  questionDocumentText,
  questionHash,
  questionHashFromPrefix,
  questionHashOfBody,
  questionHashOfRequest,
  questionOfBody,
  recoverAttestationSigner,
  sameAddress,
  signedAttestation,
  uuidToBytes16,
  uuidToBytes32,
  bytes16ToUuid,
  verifyAttestation,
  type AnswerType,
  type OracleQuestion,
  type OracleTerms,
} from "../src/index.js";
import { OracleAttestationDocument, OracleRequest, OracleRequestsList } from "../src/api/index.js";
import { fixture, readJson, repoFile, vector } from "./paths.js";

const REQUESTS_DIR = fixture("oracle", "requests");
const files = readdirSync(REQUESTS_DIR).filter((n) => n.endsWith(".json"));
const requests = files.map((name) => OracleRequest.parse(readJson(fixture("oracle", "requests", name))));

interface OracleVector {
  id: string;
  questionDocument: string;
  questionHash: Hex;
  fromBlock: number;
  toBlock: number;
  qPrefix: string;
  tail: string;
  body: string;
  bodyBytes: number;
}
const vectors = vector<{ vectors: OracleVector[]; windowOpen: string }>("oracle-vectors.json");

function questionOf(r: (typeof requests)[number]): OracleQuestion {
  return {
    question: r.question,
    chainId: r.chainId,
    answerType: r.answerType as AnswerType,
    definitions: r.definitions,
    evidence: r.evidence === "panel" ? "panel" : "chain",
    head: r.head,
  };
}

function termsOf(r: (typeof requests)[number]): OracleTerms {
  const raw = r as unknown as { guards?: OracleTerms["guards"] };
  return {
    panelSize: r.panelSize,
    quorum: r.quorum,
    validForSeconds: r.validForSeconds,
    toleranceBps: r.toleranceBps,
    guards: raw.guards,
    consumer: r.consumer
      ? { chainId: r.consumer.chainId, verifyingContract: r.consumer.verifyingContract }
      : undefined,
  };
}

describe("oracle question hash against real requests", () => {
  it("has real requests of every shape the rule distinguishes, list questions included", () => {
    expect(requests.length).toBeGreaterThanOrEqual(30);
    // A rule no fixture exercises is a rule nobody checked. `head` was once left out of the hash
    // because every fixture was a scalar question.
    const lists = requests.filter((r) => r.answerType.endsWith("[]"));
    expect(lists.length).toBeGreaterThanOrEqual(5);
    expect(lists.some((r) => r.answerType === "address[]")).toBe(true);
    expect(lists.some((r) => r.answerType === "bytes32[]")).toBe(true);
    for (const r of lists) expect(r.head, r.id).toBe(1);
    expect(requests.filter((r) => r.head === undefined).length).toBeGreaterThanOrEqual(20);
    expect(requests.some((r) => r.definitions === undefined)).toBe(true);
    expect(requests.some((r) => r.definitions !== undefined)).toBe(true);
    expect(requests.some((r) => r.evidence === "chain")).toBe(true);
    expect(requests.some((r) => r.evidence === "panel")).toBe(true);
    expect(new Set(requests.map((r) => r.status)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(requests.map((r) => r.answerType)).size).toBe(6);
  });

  it.each(requests.map((r) => [r.id, r] as const))("reproduces the hash of %s", (_id, r) => {
    expect(questionHashOfRequest(r)).toBe(r.questionHash);
    expect(questionHash(questionOf(r), r.window)).toBe(r.questionHash);
  });

  it("agrees with the list REF fetched, for every fixture that list holds", () => {
    const list = OracleRequestsList.parse(readJson(fixture("oracle", "requests-list.json")));
    expect(list.requests.length).toBe(100);
    expect(sameAddress(list.attester, MAINNET.ORACLE_SIGNER)).toBe(true);
    const byId = new Map(list.requests.map((r) => [r.id, r]));
    // The list is the hundred newest; the older fixtures (the list questions among them) are not in it.
    const listed = requests.filter((r) => byId.has(r.id));
    expect(listed.length).toBeGreaterThanOrEqual(14);
    for (const r of listed) {
      const row = byId.get(r.id);
      expect(row?.question).toBe(r.question);
      expect(row?.window.fromBlock).toBe(r.window.fromBlock);
      expect(row?.window.toBlock).toBe(r.window.toBlock);
      expect(row?.answerType).toBe(r.answerType);
    }
  });

  it("leaves definitions out when there are none: an empty map does not reproduce the hash", () => {
    const bare = requests.filter((r) => r.definitions === undefined);
    expect(bare.length).toBeGreaterThanOrEqual(2);
    for (const r of bare) {
      const text = questionDocumentText(questionOf(r), r.window);
      expect(text).not.toContain('"definitions"');
      // `definitions` sorts right after `chainId`.
      const withEmpty = text.replace(/("chainId":[0-9]+,)/, '$1"definitions":{},');
      expect(withEmpty).not.toBe(text);
      expect(JSON.parse(withEmpty)).toMatchObject({ definitions: {} });
      expect(keccak256(stringToBytes(withEmpty))).not.toBe(r.questionHash);
      // Passing an empty map is the same as passing none.
      expect(questionHash({ ...questionOf(r), definitions: {} }, r.window)).toBe(r.questionHash);
    }
  });

  it("leaves evidence out for chain evidence and keeps it for panel evidence", () => {
    for (const r of requests) {
      const text = questionDocumentText(questionOf(r), r.window);
      expect(text.includes('"evidence":"panel"')).toBe(r.evidence === "panel");
      expect(text.includes('"evidence":"chain"')).toBe(false);
    }
  });

  it("hashes head when the request has one, and not otherwise", () => {
    const lists = requests.filter((r) => r.head !== undefined);
    for (const r of lists) {
      const text = questionDocumentText(questionOf(r), r.window);
      // `head` sorts between `evidence` and `question`.
      expect(text).toContain(`,"head":${r.head},"question":`);
      // Without it the hash is another one: this is the defect the list fixtures were added for.
      expect(questionHash({ ...questionOf(r), head: undefined }, r.window)).not.toBe(r.questionHash);
      expect(questionHash({ ...questionOf(r), head: (r.head as number) + 1 }, r.window)).not.toBe(
        r.questionHash,
      );
    }
    for (const r of requests.filter((x) => x.head === undefined)) {
      expect(questionDocumentText(questionOf(r), r.window)).not.toContain('"head"');
    }
    expect(() => questionHash({ ...questionOf(lists[0]!), head: 1.5 }, lists[0]!.window)).toThrow(RangeError);
  });

  it("does not depend on panel size, quorum, tolerance, validity, guards or consumer", () => {
    const r = requests.find((x) => x.id.startsWith("dbcac6c2"));
    expect(r).toBeDefined();
    if (!r) return;
    const text = questionDocumentText(questionOf(r), r.window);
    for (const key of ["panelSize", "quorum", "toleranceBps", "validForSeconds", "consumer", "guards"]) {
      expect(text).not.toContain(`"${key}"`);
    }
  });

  it("changes with the question, the window, the chain, the answer type and the definitions", () => {
    const q: OracleQuestion = { question: "How many?", chainId: 1, answerType: "uint256" };
    const w = { fromBlock: 100, toBlock: 200 };
    const hashes = new Set([
      questionHash(q, w),
      questionHash({ ...q, question: "How many? " }, w),
      questionHash({ ...q, chainId: 4663 }, w),
      questionHash({ ...q, answerType: "bool" }, w),
      questionHash({ ...q, definitions: { a: "b" } }, w),
      questionHash({ ...q, evidence: "panel" }, w),
      questionHash({ ...q, answerType: "address[]", head: 3 }, w),
      questionHash({ ...q, answerType: "address[]", head: 5 }, w),
      questionHash({ ...q, answerType: "address[]" }, w),
      questionHash(q, { fromBlock: 101, toBlock: 200 }),
      questionHash(q, { fromBlock: 100, toBlock: 201 }),
    ]);
    expect(hashes.size).toBe(11);
    expect(questionHash({ ...q, evidence: "chain" }, w)).toBe(questionHash(q, w));
    expect(questionHash(q, { fromBlock: 100n, toBlock: 200n })).toBe(questionHash(q, w));
  });
});

describe("oracle golden vectors", () => {
  const byId = new Map(requests.map((r) => [r.id, r]));

  it("has one vector per fixture", () => {
    expect(vectors.vectors.length).toBe(requests.length);
  });

  it.each(vectors.vectors.map((v) => [v.id, v] as const))(
    "document, prefix, tail and body of %s",
    (_id, v) => {
      const r = byId.get(v.id);
      expect(r).toBeDefined();
      if (!r) return;
      expect(questionDocumentText(questionOf(r), r.window)).toBe(v.questionDocument);
      const parts = oracleBodyParts(questionOf(r), termsOf(r));
      expect(parts.qPrefix).toBe(v.qPrefix);
      expect(parts.tail).toBe(v.tail);
      expect(parts.qPrefix.endsWith(vectors.windowOpen)).toBe(true);
      const window = { fromBlock: v.fromBlock, toBlock: v.toBlock };
      const body = assembleOracleBody(parts, window);
      expect(body).toBe(v.body);
      expect(buildOracleBody(questionOf(r), window, termsOf(r))).toBe(v.body);
      expect(stringToBytes(body).length).toBe(v.bodyBytes);
      expect(questionHashFromPrefix(parts.qPrefix, window)).toBe(v.questionHash);
      // The contract's two strings differ only in what follows the window.
      expect(body.startsWith(v.questionDocument.slice(0, -1))).toBe(true);
      // Some of these were bought when the largest panel was 200; today's published limit is 100.
      expect(checkOracleBody(body, { maxPanelSize: Math.max(100, r.panelSize) })).toEqual([]);
      if (r.panelSize > 100) expect(checkOracleBody(body).map((p) => p.code)).toContain("bad_value");
      // Nothing that is hashed sits in the tail, and reading the body back gives the same hash.
      expect(parts.tail).not.toContain('"head"');
      expect(parts.qPrefix.includes('"head":')).toBe(r.head !== undefined);
      expect(questionHashOfBody(body)).toBe(v.questionHash);
    },
  );

  it("puts head in the prefix, where the contract's pinned hash covers it", () => {
    const q: OracleQuestion = {
      question: "Which addresses sent the most IMD to the fee payee in the window?",
      chainId: 1,
      answerType: "address[]",
      head: 3,
    };
    const terms: OracleTerms = { panelSize: 7, quorum: 5, validForSeconds: 86400 };
    const parts = oracleBodyParts(q, terms);
    expect(parts.qPrefix).toBe(
      '{"answerType":"address[]","chainId":1,"head":3,"question":"Which addresses sent the most IMD to the fee payee in the window?","v":1,"window":{"fromBlock":',
    );
    expect(parts.tail).toBe(',"evidence":"chain","panelSize":7,"quorum":5,"validForSeconds":86400}');
    const window = { fromBlock: 26_113_828, toBlock: 26_164_227 };
    expect(questionHashFromPrefix(parts.qPrefix, window)).toBe(questionHash(q, window));
    expect(JSON.parse(assembleOracleBody(parts, window))).toMatchObject({ head: 3, panelSize: 7, window });
    // The old spelling, head among the terms, is refused rather than quietly put in the tail.
    const stale = { ...terms, head: 3 } as OracleTerms;
    expect(() => oracleBodyParts({ ...q, head: undefined }, stale)).toThrow(/head is part of the hashed/);
  });

  it("rebuilds the prefix and tail of the Standing Questions house feeds, when they are there", (ctx) => {
    const names = ["hires", "payrolls", "employers"];
    const paths = names.map((n) =>
      repoFile("launches", "a-payroll", "test", "fixtures", "questions", "feeds", `${n}.json`),
    );
    if (paths.some((p) => p === null)) return ctx.skip();
    for (const path of paths) {
      const feed = readJson<{
        name: string;
        qPrefix: string;
        tail: string;
        example: { fromBlock: number; toBlock: number; body: string };
      }>(path as string);
      const body = JSON.parse(feed.example.body) as Record<string, unknown>;
      const { question, window } = questionOfBody(feed.example.body);
      const terms: OracleTerms = {
        panelSize: body.panelSize as number,
        quorum: body.quorum as number,
        validForSeconds: body.validForSeconds as number,
        toleranceBps: body.toleranceBps as number | undefined,
      };
      const parts = oracleBodyParts(question, terms);
      expect(parts.qPrefix, feed.name).toBe(feed.qPrefix);
      expect(parts.tail, feed.name).toBe(feed.tail);
      expect(assembleOracleBody(parts, window as { fromBlock: number; toBlock: number })).toBe(
        feed.example.body,
      );
      expect(checkOracleBody(feed.example.body), feed.name).toEqual([]);
    }
    // The ranked feed is the list question: its head is in the prefix.
    const employers = readJson<{ qPrefix: string; tail: string }>(paths[2] as string);
    expect(employers.qPrefix).toContain('"head":3,"question"');
    expect(employers.tail).not.toContain("head");
  });

  it("the same prefix serves every window of a feed", () => {
    const q: OracleQuestion = {
      question:
        "What is the sum of the value argument of every Transfer event of IMD to the fee payee in the window?",
      chainId: 1,
      answerType: "uint256",
      definitions: { recipe: '{"kind":"log-sum"}' },
    };
    const parts = oracleBodyParts(q, { panelSize: 7, quorum: 5, validForSeconds: 86400, toleranceBps: 0 });
    expect(parts.tail).toBe(
      ',"evidence":"chain","panelSize":7,"quorum":5,"toleranceBps":0,"validForSeconds":86400}',
    );
    for (const window of [
      { fromBlock: 26_000_000, toBlock: 26_007_199 },
      { fromBlock: 26_007_200, toBlock: 26_014_399 },
    ]) {
      const body = assembleOracleBody(parts, window);
      expect(JSON.parse(body)).toMatchObject({ v: 1, window, evidence: "chain", panelSize: 7 });
      expect(questionHashFromPrefix(parts.qPrefix, window)).toBe(questionHash(q, window));
    }
    expect(() => assembleOracleBody(parts, { fromBlock: 2, toBlock: 1 })).toThrow(RangeError);
  });
});

describe("bodies read back from the Intake's own events", () => {
  it("hash to the question hash the API reports for the request they opened", (ctx) => {
    const path = repoFile(
      "launches",
      "a-payroll",
      "test",
      "fixtures",
      "questions",
      "intake",
      "requested.json",
    );
    if (!path) return ctx.skip();
    const file = readJson<{ requests: { bodyHex: Hex; oracleRequestId: string }[] }>(path);
    const byId = new Map(requests.map((r) => [r.id, r]));
    let checked = 0;
    for (const sent of file.requests) {
      const r = byId.get(sent.oracleRequestId);
      if (!r) continue;
      const body = hexToString(sent.bodyHex);
      expect(checkOracleBody(body), r.id).toEqual([]);
      // A body that asked for hours gets its blocks from the oracle; the request reports them.
      expect(questionHashOfBody(body, r.window), r.id).toBe(r.questionHash);
      checked++;
    }
    // Every body that belongs to a request kept here was compared above. That file is another
    // area's: if it comes to list only requests this package has no fixture for, there is nothing
    // to compare, which is reported as skipped rather than as passed.
    if (checked === 0) return ctx.skip();
    expect(checked).toBeGreaterThan(0);
  });

  it("needs the pinned blocks for a body that asked for hours", () => {
    const body = JSON.stringify({
      v: 1,
      question: "q",
      chainId: 1,
      window: { hours: 24 },
      answerType: "bool",
      panelSize: 5,
      quorum: 4,
      validForSeconds: 3600,
    });
    expect(() => questionHashOfBody(body)).toThrow(RangeError);
    expect(questionHashOfBody(body, { fromBlock: 1, toBlock: 2 })).toBe(
      questionHash({ question: "q", chainId: 1, answerType: "bool" }, { fromBlock: 1, toBlock: 2 }),
    );
    expect(() => questionOfBody("[]")).toThrow(TypeError);
    expect(() => questionOfBody('{"question":"q"}')).toThrow(TypeError);
  });
});

describe("oracle body checks", () => {
  const good = {
    v: 1,
    question: "How much IMD was burned on Ethereum mainnet in the window?",
    chainId: 1,
    window: { fromBlock: 20800000, toBlock: 20814400 },
    answerType: "uint256",
    evidence: "chain",
    panelSize: 5,
    quorum: 5,
    toleranceBps: 0,
    validForSeconds: 3600,
    definitions: { burn: "Transfer events to the zero address." },
    guards: { min: "0", max: "10000000000000000000000000" },
  };
  const codes = (body: unknown) =>
    checkOracleBody(typeof body === "string" ? body : JSON.stringify(body)).map((p) => p.code);

  it("accepts the examples in the protocol's guide", () => {
    expect(codes(good)).toEqual([]);
    expect(codes({ ...good, window: { hours: 24 } })).toEqual([]);
    expect(codes({ ...good, answerType: "bytes32[]", head: 3 })).toEqual([]);
  });

  it("refuses an unknown key at the top and inside guards", () => {
    expect(codes({ ...good, note: "x" })).toEqual(["unknown_key"]);
    expect(codes({ ...good, guards: { minimum: "0" } })).toEqual(["unknown_key"]);
  });

  it("refuses a missing required key", () => {
    for (const key of [
      "v",
      "question",
      "chainId",
      "window",
      "answerType",
      "panelSize",
      "quorum",
      "validForSeconds",
    ]) {
      const body: Record<string, unknown> = { ...good };
      delete body[key];
      expect(codes(body), key).toContain("missing_key");
    }
  });

  it("refuses values outside the published limits", () => {
    expect(codes({ ...good, v: 2 })).toEqual(["bad_value"]);
    expect(codes({ ...good, question: "" })).toEqual(["bad_value"]);
    expect(codes({ ...good, question: "q".repeat(2001) })).toEqual(["bad_value"]);
    expect(codes({ ...good, answerType: "string" })).toEqual(["bad_value"]);
    expect(codes({ ...good, evidence: "vibes" })).toEqual(["bad_value"]);
    expect(codes({ ...good, panelSize: 101 })).toContain("bad_value");
    expect(codes({ ...good, panelSize: 1, quorum: 2 })).toContain("bad_value");
    expect(codes({ ...good, quorum: 6 })).toEqual(["quorum_exceeds_panel"]);
    expect(codes({ ...good, validForSeconds: 59 })).toEqual(["bad_value"]);
    expect(codes({ ...good, validForSeconds: 2592001 })).toEqual(["bad_value"]);
    expect(codes({ ...good, toleranceBps: 10001 })).toEqual(["bad_value"]);
    expect(codes({ ...good, head: 33 })).toEqual(["bad_value"]);
    expect(codes({ ...good, window: { hours: 721 } })).toEqual(["bad_value"]);
    expect(codes({ ...good, window: { fromBlock: 5, toBlock: 4 } })).toEqual(["window_order"]);
    expect(codes({ ...good, window: { fromBlock: 5 } })).toEqual(["bad_value"]);
    expect(codes({ ...good, definitions: { k: "v".repeat(513) } })).toEqual(["bad_value"]);
    expect(codes({ ...good, definitions: { ["k".repeat(65)]: "v" } })).toEqual(["bad_value"]);
    expect(codes({ ...good, consumer: { chainId: 1 } })).toEqual(["bad_value"]);
  });

  it("refuses what is not a JSON object, and a body over 16 KiB", () => {
    expect(codes("not json")).toEqual(["not_json"]);
    expect(codes("[]")).toEqual(["not_json"]);
    const big = {
      ...good,
      definitions: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "v".repeat(500)])),
    };
    expect(stringToBytes(JSON.stringify(big)).length).toBeGreaterThan(ORACLE_BODY_MAX_BYTES);
    expect(codes(big)).toContain("too_large");
  });
});

describe("oracle attestation", () => {
  const signed = requests.filter((r) => r.attestation && r.signature && r.consumer);

  it("has real signed attestations to check", () => {
    expect(signed.length).toBeGreaterThanOrEqual(4);
  });

  it.each(signed.map((r) => [r.id, r] as const))(
    "the signature on %s recovers to the oracle signer",
    async (_id, r) => {
      if (!r.attestation || !r.signature || !r.consumer) throw new Error("unreachable");
      const consumer = {
        chainId: r.consumer.chainId,
        verifyingContract: r.consumer.verifyingContract as Address,
      };
      const message = attestationMessage(r.attestation);
      expect(message.questionHash).toBe(r.questionHash);
      expect(message.requestId).toBe(uuidToBytes32(r.id));
      if (r.jobId) expect(message.panelJobId).toBe(uuidToBytes32(r.jobId));
      expect(message.answerType).toBe(ANSWER_TYPE_CODE[r.answerType as AnswerType]);
      expect(Number(message.fromBlock)).toBe(r.window.fromBlock);
      expect(Number(message.toBlock)).toBe(r.window.toBlock);

      const signer = await recoverAttestationSigner(consumer, message, r.signature as Hex);
      expect(sameAddress(signer, MAINNET.ORACLE_SIGNER)).toBe(true);
      expect(sameAddress(signer, r.signer)).toBe(true);
      expect(await verifyAttestation(consumer, message, r.signature as Hex, MAINNET.ORACLE_SIGNER)).toBe(
        true,
      );

      // The same signature does not verify for another contract, another chain or another answer.
      const elsewhere = { ...consumer, verifyingContract: MAINNET.IMD as Address };
      expect(await verifyAttestation(elsewhere, message, r.signature as Hex, MAINNET.ORACLE_SIGNER)).toBe(
        false,
      );
      const otherChain = { ...consumer, chainId: consumer.chainId + 1 };
      expect(await verifyAttestation(otherChain, message, r.signature as Hex, MAINNET.ORACLE_SIGNER)).toBe(
        false,
      );
      const changed = { ...message, figure: message.figure + 1n };
      expect(await verifyAttestation(consumer, changed, r.signature as Hex, MAINNET.ORACLE_SIGNER)).toBe(
        false,
      );
      expect(attestationDigest(consumer, changed)).not.toBe(attestationDigest(consumer, message));
    },
  );

  it("reads a served attestation document into the struct and signature a contract takes", async () => {
    const document = OracleAttestationDocument.parse(
      readJson(fixture("oracle", "pending", "ebe551f9-attestation.json")),
    );
    const signed = signedAttestation(document);
    expect(signed.oracleRequestId).toBe("ebe551f9-ceb1-4515-becb-2af7e69f5242");
    expect(signed.message.requestId).toBe(uuidToBytes32(signed.oracleRequestId));
    expect(signed.message.answerType).toBe(ANSWER_TYPE_CODE.uint256);
    expect(signed.message.figure).toBe(3_206_678_956_099_408n);
    expect(signed.message.panelSize).toBe(100);
    expect(signed.message.agreed).toBe(68);
    expect(signed.signature).toBe(document.signature);
    // It is for the contract its domain names and for no other.
    const consumer = { chainId: 1, verifyingContract: "0x77e1684402869bf2b7c70b8bf21e1c7ca7104951" };
    expect(isSignedFor(signed, consumer)).toBe(true);
    expect(
      isSignedFor(signed, {
        ...consumer,
        verifyingContract: consumer.verifyingContract.toUpperCase().replace("0X", "0x"),
      }),
    ).toBe(true);
    expect(isSignedFor(signed, { ...consumer, chainId: 4663 })).toBe(false);
    // The request's callback target was another contract: an answer is signed for the body's
    // `consumer` when it names one, and only otherwise for the callback target.
    expect(
      isSignedFor(signed, { chainId: 1, verifyingContract: "0x00856bd495941f3b95da5b7e374c76d822c9059e" }),
    ).toBe(false);
    expect(
      await verifyAttestation(signed.consumer, signed.message, signed.signature, MAINNET.ORACLE_SIGNER),
    ).toBe(true);
    expect(
      await verifyAttestation(
        { chainId: 1, verifyingContract: "0x00856bd495941f3b95da5b7e374c76d822c9059e" },
        signed.message,
        signed.signature,
        MAINNET.ORACLE_SIGNER,
      ),
    ).toBe(false);
  });

  it("refuses a document that is not a version 2 oracle attestation", () => {
    const document = OracleAttestationDocument.parse(
      readJson(fixture("oracle", "pending", "ebe551f9-attestation.json")),
    );
    expect(() => signedAttestation({ ...document, primaryType: "Quote" })).toThrow(
      /not an oracle attestation/,
    );
    expect(() => signedAttestation({ ...document, domain: { ...document.domain, version: "1" } })).toThrow(
      /version "1"/,
    );
    expect(() => signedAttestation({ ...document, domain: { ...document.domain, name: "Other" } })).toThrow(
      /signed in domain/,
    );
    expect(() => signedAttestation({ ...document, signature: "0x1234" })).toThrow(/65 bytes/);
    expect(() =>
      signedAttestation({ ...document, requestId: "01604a11-d04f-4960-9b1d-a3811a000048" }),
    ).toThrow(/another request/);
  });

  it("a request with a callback and no consumer of its own is signed for the callback's contract", () => {
    // Two real requests made on chain with a callback, whose bodies named no `consumer`
    // (launch A's fixture of Intake events lists both): the oracle recorded the callback target
    // as the consumer. That is what lets anyone hand such an answer to the contract that asked.
    const callbacks: Record<string, { chainId: number; target: string }> = {
      "dbcac6c2-6328-47a9-8e07-4c7b55f78e45": {
        chainId: 4663,
        target: "0x3c81384aa1ca064316576a214e2fb30969992772",
      },
      "03f89e74-3db8-4c10-8fa8-d3424c9a18d4": {
        chainId: 1,
        target: "0x70c1b03ccc02905b2ad5683156592418424c787b",
      },
    };
    for (const [id, callback] of Object.entries(callbacks)) {
      const r = requests.find((request) => request.id === id);
      expect(r, id).toBeDefined();
      expect(r?.consumer?.chainId, id).toBe(callback.chainId);
      expect(sameAddress(r?.consumer?.verifyingContract, callback.target), id).toBe(true);
    }
  });

  it("refuses an attestation older than version 2 instead of checking it as one", () => {
    const old = requests.filter((r) => r.attestation && r.attestation.agreed === undefined);
    // The five list questions were attested in September, before the panel's numbers were signed.
    expect(old.length).toBeGreaterThanOrEqual(5);
    for (const r of old) {
      if (!r.attestation) throw new Error("unreachable");
      expect(() => attestationMessage(r.attestation as never)).toThrow(/version 2/);
    }
  });

  it("declares the struct in the order OracleAttestation.sol does", () => {
    expect(ORACLE_ATTESTATION_TYPES.OracleAttestation.map((f) => `${f.type} ${f.name}`).join(",")).toBe(
      "bytes32 requestId,uint256 chainId,bytes32 questionHash,uint8 answerType,bytes answer,uint256 figure,uint64 fromBlock,uint64 toBlock,bytes32 blockHash,bytes32 panelJobId,uint16 panelSize,uint16 quorum,uint16 agreed,uint64 issuedAt,uint64 expiresAt",
    );
    expect(ANSWER_TYPE_CODE).toEqual({
      bool: 0,
      address: 1,
      bytes32: 2,
      uint256: 3,
      "address[]": 4,
      "bytes32[]": 5,
    });
  });

  it("converts UUIDs to and from their on-chain forms", () => {
    const id = "e9efec16-56f3-40d3-9243-52c453effc7d";
    expect(uuidToBytes16(id)).toBe("0xe9efec1656f340d3924352c453effc7d");
    expect(uuidToBytes32(id)).toBe(`0xe9efec1656f340d3924352c453effc7d${"0".repeat(32)}`);
    expect(bytes16ToUuid("0xE9EFEC1656F340D3924352C453EFFC7D")).toBe(id);
    expect(() => uuidToBytes16(id.toUpperCase())).toThrow(TypeError);
    expect(() => bytes16ToUuid("0x1234")).toThrow(TypeError);
  });
});
