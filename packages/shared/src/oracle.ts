/**
 * The IdentityMD oracle: the question hash, the request body, and the signed attestation.
 *
 * `questionHash` is keccak256 of the canonical JSON of
 *
 *   { answerType, chainId, definitions?, evidence?, head?, question, v: 1, window: { fromBlock, toBlock } }
 *
 * where `definitions` is present only when the request named definitions, `evidence` only when it is
 * "panel", and `head` only when the request has one (list answers: how many leading entries must
 * agree, and how many the signed list holds). Panel size, quorum, tolerance, guards, validity and
 * consumer are not part of the hash. This rule reproduces the `questionHash` of every real request
 * kept under `fixtures/oracle/requests`: some have no definitions at all, and five are list
 * questions with `head: 1`, which hash correctly only with `head` in the document.
 *
 * The body builder writes the request the way the `Questions` contract assembles it on chain:
 *
 *   body         = qPrefix ‖ dec(fromBlock) ‖ ',"toBlock":' ‖ dec(toBlock) ‖ '}' ‖ tail
 *   questionHash = keccak256(qPrefix ‖ dec(fromBlock) ‖ ',"toBlock":' ‖ dec(toBlock) ‖ '}}')
 *
 * so one stored prefix yields both the body bytes and the hash the answer must carry.
 */
import {
  getAddress,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  stringToBytes,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";
import { canonicalize } from "./canonical.js";
import { sameAddress } from "./addresses.js";
import { isUuid, uuidToBytes32 } from "./uuid.js";

export const ANSWER_TYPES = ["bool", "address", "bytes32", "uint256", "address[]", "bytes32[]"] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];

/** The `uint8 answerType` an attestation carries. */
export const ANSWER_TYPE_CODE: Record<AnswerType, number> = {
  bool: 0,
  address: 1,
  bytes32: 2,
  uint256: 3,
  "address[]": 4,
  "bytes32[]": 5,
};

export function isAnswerType(value: unknown): value is AnswerType {
  return typeof value === "string" && (ANSWER_TYPES as readonly string[]).includes(value);
}

export type Evidence = "chain" | "panel";

/** The intake refuses a body larger than this (`Intake.MAX_BODY_BYTES`, and the API's 16 KiB). */
export const ORACLE_BODY_MAX_BYTES = 16_384 as const;

export const ORACLE_LIMITS = {
  questionMaxChars: 2000,
  definitionKeyMaxChars: 64,
  definitionValueMaxChars: 512,
  /** The API accepts 2; the free preflight enforces 5. Launch feeds use at least 5. */
  panelSizeMin: 2,
  panelSizeCheckMin: 5,
  panelSizeMax: 100,
  quorumMin: 2,
  validForSecondsMin: 60,
  validForSecondsMax: 2_592_000,
  toleranceBpsMax: 10_000,
  headMin: 1,
  headMax: 32,
  windowHoursMin: 1,
  windowHoursMax: 720,
  /** `toBlock` must be at least this far behind the chain head when the request is read. */
  toBlockMinDepth: 5,
} as const;

export interface BlockWindow {
  fromBlock: number | bigint;
  toBlock: number | bigint;
}

/** The part of a request the hash covers, apart from the window. */
export interface OracleQuestion {
  question: string;
  chainId: number;
  answerType: AnswerType;
  /** Omit, or pass an empty map, for a question with no definitions. */
  definitions?: Record<string, string> | undefined;
  /** "chain" is the protocol default and is left out of the hashed document. */
  evidence?: Evidence | undefined;
  /**
   * For a list answer: how many leading entries the panel must agree on, which is also how many
   * the signed list holds. It is part of the hashed document whenever the request has it, so it
   * belongs to the question, not to the terms.
   */
  head?: number | undefined;
}

export interface OracleGuards {
  allow?: string[];
  deny?: string[];
  mustHaveCode?: boolean;
  min?: string;
  max?: string;
  sources?: string[];
  minSources?: number;
}

/** The part of a request the hash does not cover. */
export interface OracleTerms {
  panelSize: number;
  quorum: number;
  validForSeconds: number;
  toleranceBps?: number | undefined;
  guards?: OracleGuards | undefined;
  consumer?: { chainId: number; verifyingContract: string } | undefined;
  allowAmbiguous?: boolean | undefined;
  /** On-chain requests only: hand the answer to a contract on another chain. */
  deliver?: { chainId: number; target: string; selector: string } | undefined;
}

function blockNumber(name: string, value: number | bigint): number {
  const n = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return n;
}

function hasDefinitions(
  definitions: Record<string, string> | undefined,
): definitions is Record<string, string> {
  return definitions !== undefined && Object.keys(definitions).length > 0;
}

/**
 * The document the oracle hashes, as a plain object. Key order does not matter here; `canonicalize`
 * sorts it.
 */
export function questionDocument(q: OracleQuestion, window: BlockWindow): Record<string, unknown> {
  if (!isAnswerType(q.answerType)) throw new TypeError(`unknown answerType: ${String(q.answerType)}`);
  const doc: Record<string, unknown> = {
    answerType: q.answerType,
    chainId: q.chainId,
    question: q.question,
    v: 1,
    window: {
      fromBlock: blockNumber("fromBlock", window.fromBlock),
      toBlock: blockNumber("toBlock", window.toBlock),
    },
  };
  if (hasDefinitions(q.definitions)) doc.definitions = q.definitions;
  if (q.evidence === "panel") doc.evidence = "panel";
  if (q.head !== undefined) {
    if (!Number.isSafeInteger(q.head) || q.head < 0) throw new RangeError("head must be a whole number");
    doc.head = q.head;
  }
  return doc;
}

/** The exact text whose keccak256 is the question hash. */
export function questionDocumentText(q: OracleQuestion, window: BlockWindow): string {
  return canonicalize(questionDocument(q, window));
}

export function questionHash(q: OracleQuestion, window: BlockWindow): Hex {
  return keccak256(stringToBytes(questionDocumentText(q, window)));
}

/** The fields of `GET /oracle/requests/:id` the hash is built from. */
export interface OracleRequestLike {
  question: string;
  chainId: number;
  answerType: string;
  window: { fromBlock: number; toBlock: number };
  definitions?: Record<string, string> | null | undefined;
  evidence?: string | null | undefined;
  head?: number | null | undefined;
}

/** Recomputes the question hash of a request as the API describes it. */
export function questionHashOfRequest(request: OracleRequestLike): Hex {
  if (!isAnswerType(request.answerType)) throw new TypeError(`unknown answerType: ${request.answerType}`);
  return questionHash(
    {
      question: request.question,
      chainId: request.chainId,
      answerType: request.answerType,
      definitions: request.definitions ?? undefined,
      evidence: request.evidence === "panel" ? "panel" : "chain",
      head: request.head ?? undefined,
    },
    request.window,
  );
}

/**
 * Reads the hashed part back out of a request body, such as the bytes of an Intake `Requested`
 * event. A body may ask for `window: {hours}`; the oracle then pins the blocks itself, and the hash
 * can only be computed once they are known (`GET /oracle/requests/:id` reports them).
 */
export function questionOfBody(body: string): {
  question: OracleQuestion;
  window: BlockWindow | { hours: number };
} {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("an oracle body is a JSON object");
  }
  const b = parsed as Record<string, unknown>;
  if (typeof b.question !== "string" || typeof b.chainId !== "number" || !isAnswerType(b.answerType)) {
    throw new TypeError("an oracle body names a question, a chainId and an answerType");
  }
  const w = b.window as { hours?: unknown; fromBlock?: unknown; toBlock?: unknown } | undefined;
  let window: BlockWindow | { hours: number };
  if (typeof w?.hours === "number") window = { hours: w.hours };
  else if (typeof w?.fromBlock === "number" && typeof w.toBlock === "number") {
    window = { fromBlock: w.fromBlock, toBlock: w.toBlock };
  } else throw new TypeError("an oracle body has a window of {hours} or {fromBlock, toBlock}");
  const question: OracleQuestion = {
    question: b.question,
    chainId: b.chainId,
    answerType: b.answerType,
    evidence: b.evidence === "panel" ? "panel" : "chain",
  };
  if (typeof b.definitions === "object" && b.definitions !== null) {
    question.definitions = b.definitions as Record<string, string>;
  }
  if (typeof b.head === "number") question.head = b.head;
  return { question, window };
}

/**
 * The hash the oracle signs for a request body. `pinned` is the block window the oracle chose, and
 * is needed when the body asked for `window: {hours}`.
 */
export function questionHashOfBody(body: string, pinned?: BlockWindow): Hex {
  const { question, window } = questionOfBody(body);
  if ("hours" in window) {
    if (pinned === undefined) throw new RangeError("the body asks for hours: pass the pinned block window");
    return questionHash(question, pinned);
  }
  return questionHash(question, window);
}

const WINDOW_OPEN = '"window":{"fromBlock":';
const WINDOW_MID = ',"toBlock":';

export interface OracleBodyParts {
  /** The canonical question document up to and including `"window":{"fromBlock":`. */
  qPrefix: string;
  /** Everything after the window's closing brace: `,"panelSize":…}`. None of it is hashed. */
  tail: string;
}

function termsEntries(q: OracleQuestion, terms: OracleTerms): Record<string, unknown> {
  // `head` used to be listed with the terms. It is hashed, so a body with `head` in its tail would
  // be accepted by a feed and then never match the hash the oracle signs.
  if ((terms as { head?: unknown }).head !== undefined) {
    throw new TypeError("head is part of the hashed question: pass it on the question, not the terms");
  }
  const out: Record<string, unknown> = {
    panelSize: terms.panelSize,
    quorum: terms.quorum,
    validForSeconds: terms.validForSeconds,
  };
  // "chain" is the default, but a feed that depends on it says so: the body is public forever and a
  // reader should not need to know the default.
  if (q.evidence !== "panel") out.evidence = "chain";
  if (terms.toleranceBps !== undefined) out.toleranceBps = terms.toleranceBps;
  if (terms.guards !== undefined) out.guards = terms.guards;
  if (terms.consumer !== undefined) out.consumer = terms.consumer;
  if (terms.allowAmbiguous !== undefined) out.allowAmbiguous = terms.allowAmbiguous;
  if (terms.deliver !== undefined) out.deliver = terms.deliver;
  return out;
}

/**
 * Splits a request into the two byte strings a `Questions` feed stores. The block numbers are the
 * only thing the contract adds between them.
 */
export function oracleBodyParts(q: OracleQuestion, terms: OracleTerms): OracleBodyParts {
  // Canonicalise with placeholder blocks, then cut at the window. `window` sorts last among the
  // hashed keys, so everything before it is the prefix.
  const text = questionDocumentText(q, { fromBlock: 0, toBlock: 0 });
  const suffix = `${WINDOW_OPEN}0${WINDOW_MID}0}}`;
  if (!text.endsWith(suffix)) throw new Error("question document does not end with its window");
  const qPrefix = text.slice(0, text.length - suffix.length) + WINDOW_OPEN;
  const rest = canonicalize(termsEntries(q, terms));
  // `rest` is `{...}` with at least three members; drop its opening brace and join with a comma.
  const tail = `,${rest.slice(1)}`;
  return { qPrefix, tail };
}

/** `qPrefix ‖ dec(from) ‖ ',"toBlock":' ‖ dec(to) ‖ '}' ‖ tail`. */
export function assembleOracleBody(parts: OracleBodyParts, window: BlockWindow): string {
  const from = blockNumber("fromBlock", window.fromBlock);
  const to = blockNumber("toBlock", window.toBlock);
  if (to < from) throw new RangeError("toBlock is before fromBlock");
  return `${parts.qPrefix}${from}${WINDOW_MID}${to}}${parts.tail}`;
}

/** `keccak256(qPrefix ‖ dec(from) ‖ ',"toBlock":' ‖ dec(to) ‖ '}}')`: the hash the contract pins. */
export function questionHashFromPrefix(qPrefix: string, window: BlockWindow): Hex {
  const from = blockNumber("fromBlock", window.fromBlock);
  const to = blockNumber("toBlock", window.toBlock);
  return keccak256(stringToBytes(`${qPrefix}${from}${WINDOW_MID}${to}}}`));
}

/** The whole request body for a pinned block window, as compact UTF-8 JSON text. */
export function buildOracleBody(q: OracleQuestion, window: BlockWindow, terms: OracleTerms): string {
  return assembleOracleBody(oracleBodyParts(q, terms), window);
}

export interface OracleBodyProblem {
  code:
    | "not_json"
    | "too_large"
    | "unknown_key"
    | "missing_key"
    | "bad_value"
    | "quorum_exceeds_panel"
    | "window_order";
  detail: string;
}

const BODY_KEYS = new Set([
  "v",
  "question",
  "chainId",
  "window",
  "answerType",
  "panelSize",
  "quorum",
  "validForSeconds",
  "evidence",
  "head",
  "definitions",
  "guards",
  "toleranceBps",
  "consumer",
  "allowAmbiguous",
  "deliver",
]);
const GUARD_KEYS = new Set(["allow", "deny", "mustHaveCode", "min", "max", "sources", "minSources"]);
const REQUIRED_KEYS = [
  "v",
  "question",
  "chainId",
  "window",
  "answerType",
  "panelSize",
  "quorum",
  "validForSeconds",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function intIn(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Checks a body against the published limits before any money is spent on it. An unknown key makes
 * the intake refuse the request, and a refused request keeps its 0.5 IMD, so this is strict.
 *
 * It checks shape only. Whether the question is answerable, or the quorum reachable today, is what
 * the protocol's free `POST /requests/check` says.
 *
 * The largest panel is the one limit the protocol publishes live
 * (`limits["oracle.request"].maxPanelSize` in `GET /requests/capabilities`): 100 on 10 Oct 2026, and
 * higher before, as attested requests with a panel of 200 show. Pass the live figure when you have it.
 */
export function checkOracleBody(body: string, options: { maxPanelSize?: number } = {}): OracleBodyProblem[] {
  const problems: OracleBodyProblem[] = [];
  const size = stringToBytes(body).length;
  if (size === 0 || size > ORACLE_BODY_MAX_BYTES) {
    problems.push({
      code: "too_large",
      detail: `body is ${size} bytes; the limit is ${ORACLE_BODY_MAX_BYTES}`,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [...problems, { code: "not_json", detail: "body is not JSON" }];
  }
  if (!isRecord(parsed)) return [...problems, { code: "not_json", detail: "body is not a JSON object" }];

  for (const key of Object.keys(parsed)) {
    if (!BODY_KEYS.has(key)) problems.push({ code: "unknown_key", detail: `unknown key "${key}"` });
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in parsed)) problems.push({ code: "missing_key", detail: `missing "${key}"` });
  }
  const bad = (detail: string) => problems.push({ code: "bad_value", detail });
  const L = { ...ORACLE_LIMITS, panelSizeMax: options.maxPanelSize ?? ORACLE_LIMITS.panelSizeMax };

  if ("v" in parsed && parsed.v !== 1) bad("v must be 1");
  if ("question" in parsed) {
    const q = parsed.question;
    if (typeof q !== "string" || q.length < 1 || q.length > L.questionMaxChars) {
      bad(`question must be 1 to ${L.questionMaxChars} characters`);
    }
  }
  if ("chainId" in parsed && !intIn(parsed.chainId, 1, Number.MAX_SAFE_INTEGER)) {
    bad("chainId must be a positive integer");
  }
  if ("answerType" in parsed && !isAnswerType(parsed.answerType)) {
    bad(`answerType must be one of ${ANSWER_TYPES.join(", ")}`);
  }
  if ("evidence" in parsed && parsed.evidence !== "chain" && parsed.evidence !== "panel") {
    bad('evidence must be "chain" or "panel"');
  }
  if ("window" in parsed) {
    const w = parsed.window;
    if (!isRecord(w)) bad("window must be an object");
    else if ("hours" in w) {
      if (Object.keys(w).length !== 1 || !intIn(w.hours, L.windowHoursMin, L.windowHoursMax)) {
        bad(`window.hours must be ${L.windowHoursMin} to ${L.windowHoursMax} and stand alone`);
      }
    } else {
      const keys = Object.keys(w).sort().join(",");
      if (keys !== "fromBlock,toBlock") bad("window must be {hours} or {fromBlock, toBlock}");
      else if (
        !intIn(w.fromBlock, 0, Number.MAX_SAFE_INTEGER) ||
        !intIn(w.toBlock, 0, Number.MAX_SAFE_INTEGER)
      ) {
        bad("window blocks must be non-negative integers");
      } else if ((w.toBlock as number) < (w.fromBlock as number)) {
        problems.push({ code: "window_order", detail: "window.toBlock is before window.fromBlock" });
      }
    }
  }
  if ("panelSize" in parsed && !intIn(parsed.panelSize, L.panelSizeMin, L.panelSizeMax)) {
    bad(`panelSize must be ${L.panelSizeMin} to ${L.panelSizeMax}`);
  }
  if ("quorum" in parsed) {
    if (!intIn(parsed.quorum, L.quorumMin, L.panelSizeMax)) bad(`quorum must be at least ${L.quorumMin}`);
    else if (typeof parsed.panelSize === "number" && (parsed.quorum as number) > parsed.panelSize) {
      problems.push({ code: "quorum_exceeds_panel", detail: "quorum is larger than panelSize" });
    }
  }
  if (
    "validForSeconds" in parsed &&
    !intIn(parsed.validForSeconds, L.validForSecondsMin, L.validForSecondsMax)
  ) {
    bad(`validForSeconds must be ${L.validForSecondsMin} to ${L.validForSecondsMax}`);
  }
  if ("toleranceBps" in parsed && !intIn(parsed.toleranceBps, 0, L.toleranceBpsMax)) {
    bad(`toleranceBps must be 0 to ${L.toleranceBpsMax}`);
  }
  if ("head" in parsed && !intIn(parsed.head, L.headMin, L.headMax)) {
    bad(`head must be ${L.headMin} to ${L.headMax}`);
  }
  if ("allowAmbiguous" in parsed && typeof parsed.allowAmbiguous !== "boolean") {
    bad("allowAmbiguous must be a boolean");
  }
  if ("definitions" in parsed) {
    const d = parsed.definitions;
    if (!isRecord(d)) bad("definitions must be a map of strings");
    else {
      for (const [key, value] of Object.entries(d)) {
        if (key.length < 1 || key.length > L.definitionKeyMaxChars) {
          bad(`definitions key "${key.slice(0, 20)}" must be 1 to ${L.definitionKeyMaxChars} characters`);
        }
        if (typeof value !== "string" || value.length < 1 || value.length > L.definitionValueMaxChars) {
          bad(`definitions["${key.slice(0, 20)}"] must be 1 to ${L.definitionValueMaxChars} characters`);
        }
      }
    }
  }
  if ("guards" in parsed) {
    const g = parsed.guards;
    if (!isRecord(g)) bad("guards must be an object");
    else {
      for (const key of Object.keys(g)) {
        if (!GUARD_KEYS.has(key))
          problems.push({ code: "unknown_key", detail: `unknown key "guards.${key}"` });
      }
    }
  }
  if ("consumer" in parsed) {
    const c = parsed.consumer;
    if (
      !isRecord(c) ||
      Object.keys(c).sort().join(",") !== "chainId,verifyingContract" ||
      !intIn(c.chainId, 1, Number.MAX_SAFE_INTEGER) ||
      typeof c.verifyingContract !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(c.verifyingContract)
    ) {
      bad("consumer must be {chainId, verifyingContract}");
    }
  }
  return problems;
}

/** EIP-712 types of the version 2 attestation, as `OracleAttestation.sol` declares them. */
export const ORACLE_ATTESTATION_TYPES = {
  OracleAttestation: [
    { name: "requestId", type: "bytes32" },
    { name: "chainId", type: "uint256" },
    { name: "questionHash", type: "bytes32" },
    { name: "answerType", type: "uint8" },
    { name: "answer", type: "bytes" },
    { name: "figure", type: "uint256" },
    { name: "fromBlock", type: "uint64" },
    { name: "toBlock", type: "uint64" },
    { name: "blockHash", type: "bytes32" },
    { name: "panelJobId", type: "bytes32" },
    { name: "panelSize", type: "uint16" },
    { name: "quorum", type: "uint16" },
    { name: "agreed", type: "uint16" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export const ORACLE_DOMAIN_NAME = "IdentityMD Oracle" as const;
export const ORACLE_DOMAIN_VERSION = "2" as const;

/** The domain a consumer contract verifies in: its own chain and its own address. */
export function oracleDomain(consumerChainId: number, verifyingContract: Address): TypedDataDomain {
  return {
    name: ORACLE_DOMAIN_NAME,
    version: ORACLE_DOMAIN_VERSION,
    chainId: consumerChainId,
    verifyingContract: getAddress(verifyingContract),
  };
}

export interface OracleAttestationMessage {
  requestId: Hex;
  chainId: bigint;
  questionHash: Hex;
  answerType: number;
  answer: Hex;
  figure: bigint;
  fromBlock: bigint;
  toBlock: bigint;
  blockHash: Hex;
  panelJobId: Hex;
  panelSize: number;
  quorum: number;
  agreed: number;
  issuedAt: bigint;
  expiresAt: bigint;
}

/** The `attestation` object of `GET /oracle/requests/:id`, which spells some fields as text. */
export interface ApiAttestation {
  requestId: string;
  chainId: number;
  questionHash: string;
  answerType: string | number;
  answer: string;
  figure: string | number;
  fromBlock: number;
  toBlock: number;
  blockHash: string;
  panelJobId: string;
  /** Absent on attestations older than version 2, which cannot be checked as version 2. */
  panelSize?: number | undefined;
  quorum?: number | undefined;
  agreed?: number | undefined;
  issuedAt: number;
  expiresAt: number;
}

function bytes32Of(value: string): Hex {
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase() as Hex;
  if (isUuid(value)) return uuidToBytes32(value);
  throw new TypeError(`not a bytes32: ${value}`);
}

/** Converts the API's spelling of an attestation into the struct a contract and viem take. */
export function attestationMessage(a: ApiAttestation): OracleAttestationMessage {
  const answerType =
    typeof a.answerType === "number"
      ? a.answerType
      : isAnswerType(a.answerType)
        ? ANSWER_TYPE_CODE[a.answerType]
        : NaN;
  if (!Number.isInteger(answerType)) throw new TypeError(`unknown answerType: ${String(a.answerType)}`);
  if (!/^0x([0-9a-fA-F]{2})*$/.test(a.answer)) throw new TypeError("answer is not hex bytes");
  if (a.panelSize === undefined || a.quorum === undefined || a.agreed === undefined) {
    throw new TypeError("not a version 2 attestation: it has no panelSize, quorum and agreed");
  }
  return {
    requestId: bytes32Of(a.requestId),
    chainId: BigInt(a.chainId),
    questionHash: bytes32Of(a.questionHash),
    answerType,
    answer: a.answer as Hex,
    figure: BigInt(a.figure),
    fromBlock: BigInt(a.fromBlock),
    toBlock: BigInt(a.toBlock),
    blockHash: bytes32Of(a.blockHash),
    panelJobId: bytes32Of(a.panelJobId),
    panelSize: a.panelSize,
    quorum: a.quorum,
    agreed: a.agreed,
    issuedAt: BigInt(a.issuedAt),
    expiresAt: BigInt(a.expiresAt),
  };
}

/** The EIP-712 digest a consumer contract checks the signature against. */
export function attestationDigest(
  consumer: { chainId: number; verifyingContract: Address },
  message: OracleAttestationMessage,
): Hex {
  return hashTypedData({
    domain: oracleDomain(consumer.chainId, consumer.verifyingContract),
    types: ORACLE_ATTESTATION_TYPES,
    primaryType: "OracleAttestation",
    message,
  });
}

/** Recovers who signed an attestation for a given consumer. */
export async function recoverAttestationSigner(
  consumer: { chainId: number; verifyingContract: Address },
  message: OracleAttestationMessage,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({
    domain: oracleDomain(consumer.chainId, consumer.verifyingContract),
    types: ORACLE_ATTESTATION_TYPES,
    primaryType: "OracleAttestation",
    message,
    signature,
  });
}

/** True when `signature` over `message` in `consumer`'s domain comes from `expectedSigner`. */
export async function verifyAttestation(
  consumer: { chainId: number; verifyingContract: Address },
  message: OracleAttestationMessage,
  signature: Hex,
  expectedSigner: Address,
): Promise<boolean> {
  try {
    return sameAddress(await recoverAttestationSigner(consumer, message, signature), expectedSigner);
  } catch {
    return false;
  }
}

/** The fields of `GET /oracle/requests/:id/attestation` that `signedAttestation` reads. */
export interface AttestationDocumentLike {
  requestId: string;
  primaryType: string;
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  message: ApiAttestation;
  signature: string;
  signer: string;
}

/** A signed answer in the form a consumer contract takes it. */
export interface SignedAttestation {
  /** The oracle request's UUID. */
  oracleRequestId: string;
  /** The struct `onOracleResult` and `submit` take, field for field. */
  message: OracleAttestationMessage;
  signature: Hex;
  /** The contract the answer was signed for: the chain and verifying contract of its domain. */
  consumer: { chainId: number; verifyingContract: Address };
  /** Who the API says signed it. Nothing is proven until `verifyAttestation` has recovered it. */
  signer: Address;
}

/**
 * Reads an attestation document into the struct and signature a contract takes. Refuses anything
 * that is not a version 2 `OracleAttestation` in the `IdentityMD Oracle` domain: a version 1
 * document verifies under another domain and has no panel figures, and a consumer built on the
 * current library would reject it.
 *
 * This only reads. Before handing the result to a contract, check that it was signed for that
 * contract (`isSignedFor`) and by the signer that contract trusts (`verifyAttestation`).
 */
export function signedAttestation(document: AttestationDocumentLike): SignedAttestation {
  if (document.primaryType !== "OracleAttestation") {
    throw new TypeError(`not an oracle attestation: primaryType is ${document.primaryType}`);
  }
  if (document.domain.name !== ORACLE_DOMAIN_NAME || document.domain.version !== ORACLE_DOMAIN_VERSION) {
    throw new TypeError(
      `signed in domain "${document.domain.name}" version "${document.domain.version}", not "${ORACLE_DOMAIN_NAME}" version "${ORACLE_DOMAIN_VERSION}"`,
    );
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(document.signature)) {
    throw new TypeError("the signature is not 65 bytes of hex");
  }
  if (!isUuid(document.requestId)) throw new TypeError("requestId is not a UUID");
  const message = attestationMessage(document.message);
  if (message.requestId !== uuidToBytes32(document.requestId)) {
    throw new TypeError("the message is about another request than the document names");
  }
  return {
    oracleRequestId: document.requestId,
    message,
    signature: document.signature as Hex,
    consumer: {
      chainId: document.domain.chainId,
      verifyingContract: getAddress(document.domain.verifyingContract),
    },
    signer: getAddress(document.signer),
  };
}

/** True when the answer's domain names this chain and this contract. */
export function isSignedFor(
  signed: Pick<SignedAttestation, "consumer">,
  consumer: { chainId: number; verifyingContract: string },
): boolean {
  return (
    signed.consumer.chainId === consumer.chainId &&
    sameAddress(signed.consumer.verifyingContract, consumer.verifyingContract)
  );
}

/**
 * Oracle request statuses that end without a signed answer. `assessing` and `reproducing` are
 * still in progress; `attested` has an answer.
 */
export const ORACLE_STATUS_WITHOUT_ANSWER: readonly string[] = [
  "disagreed",
  "blocked",
  "mismatch",
  "refused",
  "failed",
];
