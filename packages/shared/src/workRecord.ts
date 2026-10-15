/**
 * Work records: fetching one by hash, checking it against its keccak, and reading the same fields
 * out of it that the on-chain scanner (`WorkProof`) reads.
 *
 * A work record is the canonical JSON document IdentityMD writes when a job ends. Its keccak256 is
 * what `WorkRegistry.latest(jobId)` returns. The bytes must be handled as bytes: the record is raw
 * UTF-8 and any re-serialisation changes the hash.
 *
 * The scanner here is deliberately not `JSON.parse`. It walks the top level byte by byte with the
 * rules the contract uses, so the web app and the bots see exactly what a proof will see.
 */
import { bytesToHex, hexToBytes, isHex, keccak256, type Hex } from "viem";
import { IMD_API_BASE } from "./addresses.js";
import { bytes16ToUuid, uuidToBytes16 } from "./uuid.js";

export const WORK_RECORD_SCHEMA = "identitymd-work-v1" as const;
/** The state a paid order needs: `keccak256("completed")` on chain. */
export const WORK_RECORD_COMPLETED = "completed" as const;
/** The scanner keeps at most this many distinct agent ids, as the contract does. */
export const MAX_AGENT_IDS = 16 as const;

/** Top-level keys of a record in canonical order, as observed on real records. */
export const WORK_RECORD_KEYS = [
  "assessments",
  "deployments",
  "fuzz",
  "identity",
  "interpretation",
  "jobId",
  "kind",
  "nodes",
  "objective",
  "parentJobId",
  "planHash",
  "previousHash",
  "projectId",
  "publication",
  "receiptIdentity",
  "registry",
  "research",
  "schema",
  "signals",
  "site",
  "snapshotHash",
  "state",
  "submissions",
  "verification",
] as const;

export type WorkRecordErrorCode =
  | "Malformed"
  | "MissingKey"
  | "WrongSchema"
  | "JobIdMismatch"
  | "HeadTooLong"
  | "HashMismatch"
  | "BadHash"
  | "Http";

/** Mirrors the errors of `IWorkProof`, plus the two that only exist off chain (`BadHash`, `Http`). */
export class WorkRecordError extends Error {
  readonly code: WorkRecordErrorCode;
  /** Byte offset for `Malformed`. */
  readonly pos: number | undefined;

  constructor(code: WorkRecordErrorCode, message: string, pos?: number) {
    super(`${code}: ${message}`);
    this.name = "WorkRecordError";
    this.code = code;
    this.pos = pos;
  }
}

/** Normalises a record hash to 64 lowercase hex characters without `0x`, the form the URL takes. */
export function recordHashHex(hash: string): string {
  const bare = hash.startsWith("0x") || hash.startsWith("0X") ? hash.slice(2) : hash;
  if (!/^[0-9a-fA-F]{64}$/.test(bare)) {
    throw new WorkRecordError("BadHash", "a record hash is 64 hex characters");
  }
  return bare.toLowerCase();
}

/** `https://api.imd.fun/work-records/<64 hex, no 0x>.json`. */
export function workRecordUrl(hash: string, baseUrl: string = IMD_API_BASE): string {
  return `${baseUrl.replace(/\/+$/, "")}/work-records/${recordHashHex(hash)}.json`;
}

export interface CheckedRecord {
  /** The exact bytes whose keccak256 is `recordHash`: what `settle` and `prove` take. */
  bytes: Uint8Array;
  recordHash: Hex;
  /** True when the served body carried one trailing newline that had to be removed. */
  strippedNewline: boolean;
}

/**
 * Checks served bytes against the hash they were asked for.
 *
 * Records are served with no trailing newline: for all 41 records compared on 10 Oct 2026 the
 * served bytes hash to the on-chain receipt as they are, and the contract refuses a record that
 * ends in one. A newline some proxy or tool appended is tolerated all the same: the bytes are tried
 * as served, then with exactly one trailing `\n` removed, and the bytes returned are always the
 * ones that hash. Anything else is a mismatch.
 */
export function checkRecordBytes(served: Uint8Array, expectedHash: string): CheckedRecord {
  const want = `0x${recordHashHex(expectedHash)}` as Hex;
  if (keccak256(served) === want) return { bytes: served, recordHash: want, strippedNewline: false };
  if (served.length > 0 && served[served.length - 1] === 0x0a) {
    const trimmed = served.subarray(0, served.length - 1);
    if (keccak256(trimmed) === want) return { bytes: trimmed, recordHash: want, strippedNewline: true };
  }
  throw new WorkRecordError("HashMismatch", `served bytes hash to ${keccak256(served)}, expected ${want}`);
}

export interface FetchRecordOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** Fetches a record by hash as raw bytes and refuses anything that does not hash to it. */
export async function fetchWorkRecord(
  hash: string,
  options: FetchRecordOptions = {},
): Promise<CheckedRecord> {
  const doFetch = options.fetch ?? fetch;
  const url = workRecordUrl(hash, options.baseUrl);
  const init: RequestInit = { headers: { accept: "application/json" } };
  if (options.signal) init.signal = options.signal;
  const response = await doFetch(url, init);
  if (!response.ok) {
    throw new WorkRecordError("Http", `GET ${url} answered ${response.status}`);
  }
  return checkRecordBytes(new Uint8Array(await response.arrayBuffer()), hash);
}

export interface WorkRecordScan {
  /** keccak256 of the whole record; equal to `WorkRegistry.latest(jobId)` for a real receipt. */
  recordHash: Hex;
  /** The job id as the API writes it. */
  jobId: string;
  /** The job id as the contract takes it (`bytes16`). */
  jobIdBytes16: Hex;
  kind: string;
  /** keccak256 of the raw `kind` contents. */
  kindHash: Hex;
  /**
   * The objective with its JSON escapes resolved, for people to read. Like `kind` and `state`, it
   * is decoded text: two different byte strings can decode to the same text, so anything that
   * decides money compares `kindHash`, `stateHash`, `headHash` and `specHash`, as the desk does.
   */
  objective: string;
  /** The objective exactly as it sits between its quotes in the record, still escaped. */
  objectiveRaw: Uint8Array;
  /** keccak256 of the first `headLen` raw bytes of the objective. */
  headHash: Hex;
  /** keccak256 of the rest of the raw objective. */
  specHash: Hex;
  schema: string;
  /** Decoded for reading. Compare `stateHash` with `WORK_RECORD_COMPLETED_HASH`, never this text. */
  state: string;
  /** keccak256 of the raw `state` contents. */
  stateHash: Hex;
  /** True when `stateHash` is `keccak256("completed")`: the desk's own test for a finished job. */
  completed: boolean;
  /**
   * ERC-8004 agent ids from the top-level `signals`, de-duplicated, at most 16. A signal that
   * records a rejected submission (`"value":0`) names nobody.
   */
  agentIds: bigint[];
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

/** A top-level key is 1 to 31 bytes, as `JsonScan` reads it from one 32-byte word. */
const MAX_KEY_BYTES = 31;
/** 77 decimal digits always fit a uint256; the contract refuses a 78th. */
const MAX_ID_DIGITS = 77;

function malformed(pos: number, what: string): never {
  throw new WorkRecordError("Malformed", `${what} at byte ${pos}`, pos);
}

function missingKey(what: string): never {
  throw new WorkRecordError("MissingKey", what);
}

/**
 * `p` is the first byte of a string's contents. Returns the index of the closing quote, or `end`
 * when the buffer ends inside the string. A backslash always consumes the byte after
 * it, which covers `\"`, `\\`, `\n` and `\uXXXX` alike.
 */
function closingQuote(bytes: Uint8Array, p: number, end: number): number {
  while (p < end) {
    const b = bytes[p];
    if (b === QUOTE) return p;
    p += b === BACKSLASH ? 2 : 1;
  }
  return end;
}

/**
 * `p` is an opening bracket. Returns the index just past its matching close, or 0 when the buffer
 * ends first. Only strings and depth are tracked; the two kinds of bracket are not told apart.
 */
function skipNested(bytes: Uint8Array, p: number, end: number): number {
  let depth = 0;
  while (p < end) {
    const c = bytes[p] as number;
    if (c === QUOTE) {
      p = closingQuote(bytes, p + 1, end);
      if (p >= end) return 0;
    } else if (c === OPEN_BRACE || c === OPEN_BRACKET) {
      depth++;
    } else if (c === CLOSE_BRACE || c === CLOSE_BRACKET) {
      if (--depth === 0) return p + 1;
    }
    p++;
  }
  return 0;
}

/** Bytes a bare literal may hold: `+ - .`, digits and ASCII letters. */
function isLiteralByte(b: number | undefined): boolean {
  if (b === undefined) return false;
  return (
    b === 0x2b ||
    b === 0x2d ||
    b === 0x2e ||
    (b >= 0x30 && b <= 0x39) ||
    (b >= 0x41 && b <= 0x5a) ||
    (b >= 0x61 && b <= 0x7a)
  );
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/**
 * Reads a top-level key whose first byte is at `p`. Returns the index of its closing quote, or 0 when
 * it is not a valid key: empty, 32 bytes or longer, cut off by the end of the record, or holding a
 * backslash or a byte outside 0x20 to 0x7F.
 */
function keyEnd(bytes: Uint8Array, p: number): number {
  for (let i = 0; i <= MAX_KEY_BYTES; i++) {
    const b = bytes[p + i];
    if (b === undefined || b === BACKSLASH) return 0;
    if (b === QUOTE) return i === 0 ? 0 : p + i;
    if (b < 0x20 || b > 0x7f) return 0;
  }
  return 0;
}

/**
 * UTF-8 to text with nothing dropped. A plain `TextDecoder` removes a leading byte order mark,
 * which would make two different byte strings read the same; everything here that is compared is
 * compared as bytes, and this is only for showing text to people.
 */
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

function decodeJsonString(raw: Uint8Array): string {
  const text = UTF8.decode(raw);
  try {
    return JSON.parse(`"${text}"`) as string;
  } catch {
    // The contract hashes the raw bytes and never decodes them, so an escape it cannot be decoded
    // from is shown as it stands rather than refused.
    return text;
  }
}

const TEXT = new TextEncoder();
const AGENT_PREFIX = TEXT.encode('{"agentId":"');
/** What a `signals` element ends with when it records a submission that verification rejected. */
const REJECTED_SUFFIX = TEXT.encode(',"value":0}');
const KEY_JOB_ID = TEXT.encode("jobId");
const KEY_KIND = TEXT.encode("kind");
const KEY_OBJECTIVE = TEXT.encode("objective");
const KEY_SCHEMA = TEXT.encode("schema");
const KEY_SIGNALS = TEXT.encode("signals");
const KEY_STATE = TEXT.encode("state");
const SCHEMA_BYTES = TEXT.encode(WORK_RECORD_SCHEMA);
/** `keccak256("completed")`: what the desk compares a record's `stateHash` with. */
export const WORK_RECORD_COMPLETED_HASH: Hex = keccak256(TEXT.encode(WORK_RECORD_COMPLETED));

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && compareBytes(a, b) === 0;
}

const DASH = 0x2d;
const UUID_BYTES = 36;

/**
 * `JsonScan._uuid`: exactly 36 bytes, a dash at 8, 13, 18 and 23, a lowercase hex digit everywhere
 * else. Compared as bytes, so nothing that merely decodes to a UUID passes.
 */
function isUuidBytes(raw: Uint8Array): boolean {
  if (raw.length !== UUID_BYTES) return false;
  for (let i = 0; i < UUID_BYTES; i++) {
    const b = raw[i] as number;
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (b !== DASH) return false;
    } else if (!((b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66))) return false;
  }
  return true;
}

/**
 * Reads agent ids the way `JsonScan.agentIds` does. Never throws. Each element of `signals` must
 * begin `{"agentId":"<1 to 77 digits>"`. The result holds each id once, in order of first
 * appearance, and stops at sixteen (later elements are not read). If any element that is read has
 * another shape the result is empty: a partial list would pay some workers and silently drop others,
 * and an empty one sends the tip to the general seat pool.
 *
 * Rejected submissions are left out, as the contract leaves them out: the writer adds a signal for
 * every submission that was verified, with `value` 1 when it was accepted and 0 when it was
 * rejected. An element whose last eleven bytes are `,"value":0}` is read and not counted, so an
 * agent is named only if at least one of its signals is not a rejection.
 */
function scanAgentIds(value: Uint8Array | null): bigint[] {
  if (value === null || value.length <= 2) return [];
  const end = value.length;
  const ids: bigint[] = [];
  let p = 1;
  for (;;) {
    if (end - p < AGENT_PREFIX.length) return [];
    for (let k = 0; k < AGENT_PREFIX.length; k++) {
      if (value[p + k] !== AGENT_PREFIX[k]) return [];
    }
    const next = skipNested(value, p, end);
    if (next === 0 || next >= end) return [];
    p += AGENT_PREFIX.length;
    let id = 0n;
    let digits = 0;
    for (;;) {
      const d = (value[p] as number) - 0x30;
      if (!(d >= 0 && d <= 9)) break;
      if (digits === MAX_ID_DIGITS) {
        digits = 0;
        break;
      }
      id = id * 10n + BigInt(d);
      digits++;
      p++;
    }
    if (digits === 0 || value[p] !== QUOTE) return [];
    // `p` is on the id's closing quote and `next` is just past the element's closing brace. The
    // suffix counts only if it lies wholly after the id.
    const rejected =
      next - p > REJECTED_SUFFIX.length &&
      compareBytes(value.subarray(next - REJECTED_SUFFIX.length, next), REJECTED_SUFFIX) === 0;
    if (!rejected && !ids.includes(id)) {
      ids.push(id);
      if (ids.length === MAX_AGENT_IDS) return ids;
    }
    const c = value[next];
    if (c === CLOSE_BRACKET && next + 1 === end) return ids;
    if (c !== COMMA) return [];
    p = next + 1;
  }
}

/**
 * Parses a record without consulting the registry. A port of `JsonScan.scan` and `WorkProof._read`
 * (launches/b-desk/src/proof), rule for rule, including the byte offset each `Malformed` reports:
 *
 * 1. byte 0 is `{` and the last byte is `}` (which is what turns away a file with a trailing newline);
 * 2. a member is `"key":value`, members are separated by one `,`;
 * 3. a key is 1 to 31 bytes of printable ASCII with no `"` and no `\`;
 * 4. each key is strictly greater than the one before it, so no key can appear twice;
 * 5. a value is a string, an object, an array, or a bare literal of letters, digits and `+-.`;
 * 6. `schema` is exactly `identitymd-work-v1`, and `jobId` is a lowercase 8-4-4-4-12 UUID.
 *
 * It stops at `state`: the members after it (`submissions`, `verification`) are covered by the record
 * hash and never walked. `signals` is optional; a record without it names no agents.
 *
 * `headLen` is how many leading raw bytes of the objective are hashed separately: 85 for an order.
 * A participant in a job controls only string contents and nested values, and `JSON.stringify`
 * escapes every quote and backslash inside them, so nothing a participant writes can close a string
 * or appear as a key at depth 1.
 */
export function scanWorkRecord(record: Uint8Array, headLen: number = 85): WorkRecordScan {
  if (!Number.isInteger(headLen) || headLen < 0)
    throw new RangeError("headLen must be a non-negative integer");
  const end = record.length;
  if (end === 0 || record[0] !== OPEN_BRACE) malformed(0, "a record starts with {");
  if (record[end - 1] !== CLOSE_BRACE) malformed(end - 1, "a record ends with }");
  if (record[1] === CLOSE_BRACE) missingKey("the record is an empty object");

  let jobId: string | null = null;
  let kind: Uint8Array | null = null;
  let objective: Uint8Array | null = null;
  let schemaSeen = false;
  let signals: Uint8Array | null = null;
  let state: Uint8Array | null = null;

  let previousKey: Uint8Array | null = null;
  let p = 1;
  while (state === null) {
    // --- key ---
    if (p >= end || record[p] !== QUOTE) malformed(p, "expected a key");
    const q = keyEnd(record, p + 1);
    if (q === 0 || q >= end) malformed(p, "not a canonical key");
    const key = record.subarray(p + 1, q);
    if (previousKey !== null && compareBytes(key, previousKey) <= 0)
      malformed(p, "keys out of canonical order");
    // Keys only rise, so once one sorts after `state` that member cannot still be coming.
    if (compareBytes(key, KEY_STATE) > 0) missingKey('the record has no top-level "state"');
    previousKey = key;

    p = q + 1;
    if (p >= end || record[p] !== COLON) malformed(p, "expected :");
    p++;
    if (p >= end) malformed(end, "the record ends after a key");

    // --- value ---
    const v = p;
    const c = record[p] as number;
    let close = 0;
    if (c === QUOTE) {
      close = closingQuote(record, p + 1, end);
      if (close >= end) malformed(end, "unterminated string");
      p = close + 1;
    } else if (c === OPEN_BRACE || c === OPEN_BRACKET) {
      p = skipNested(record, p, end);
      if (p === 0) malformed(end, "unterminated object or array");
    } else {
      while (isLiteralByte(record[p])) p++;
      if (p === v) malformed(v, "not a value");
    }

    // --- capture ---
    // Keys are compared as bytes, like everything else: the contract reads a key as one word.
    if (compareBytes(key, KEY_JOB_ID) >= 0) {
      if (sameBytes(key, KEY_SIGNALS)) {
        // Soft by design: anything but an array leaves the list empty.
        if (c === OPEN_BRACKET) signals = record.subarray(v, p);
      } else {
        const isJobId = sameBytes(key, KEY_JOB_ID);
        const isKind = sameBytes(key, KEY_KIND);
        const isObjective = sameBytes(key, KEY_OBJECTIVE);
        const isSchema = sameBytes(key, KEY_SCHEMA);
        const isState = sameBytes(key, KEY_STATE);
        if (isJobId || isKind || isObjective || isSchema || isState) {
          if (c !== QUOTE) malformed(v, `"${UTF8.decode(key)}" is not a string`);
          const raw = record.subarray(v + 1, close);
          if (isJobId) {
            if (!isUuidBytes(raw)) malformed(v, "jobId is not a lowercase UUID");
            jobId = UTF8.decode(raw);
          } else if (isKind) {
            kind = raw;
          } else if (isObjective) {
            objective = raw;
          } else if (isSchema) {
            if (!sameBytes(raw, SCHEMA_BYTES)) {
              throw new WorkRecordError(
                "WrongSchema",
                `schema is "${UTF8.decode(raw)}", expected "${WORK_RECORD_SCHEMA}"`,
              );
            }
            schemaSeen = true;
          } else {
            // `state`: the last member the scanner needs.
            if (jobId === null || kind === null || objective === null || !schemaSeen) {
              missingKey("a required member is missing before state");
            }
            state = raw;
            break;
          }
        }
      }
    }

    // --- separator ---
    if (p >= end) malformed(end, "the record ends inside its top level");
    if (record[p] === CLOSE_BRACE) missingKey('the top level ended before "state"');
    if (record[p] !== COMMA) malformed(p, "expected ,");
    p++;
  }

  // The loop above only leaves through `state`, with the other four members present.
  if (jobId === null || kind === null || objective === null) missingKey("a required member is missing");
  if (headLen > objective.length) {
    throw new WorkRecordError(
      "HeadTooLong",
      `headLen ${headLen} exceeds the objective's ${objective.length} bytes`,
    );
  }

  return {
    recordHash: keccak256(record),
    jobId,
    jobIdBytes16: uuidToBytes16(jobId),
    kind: decodeJsonString(kind),
    kindHash: keccak256(kind),
    objective: decodeJsonString(objective),
    objectiveRaw: objective,
    headHash: keccak256(objective.subarray(0, headLen)),
    specHash: keccak256(objective.subarray(headLen)),
    schema: WORK_RECORD_SCHEMA,
    state: decodeJsonString(state),
    stateHash: keccak256(state),
    completed: sameBytes(state, TEXT.encode(WORK_RECORD_COMPLETED)),
    agentIds: scanAgentIds(signals),
  };
}

/** `scanWorkRecord`, then the `JobIdMismatch` check `prove` makes against the job it was asked about. */
export function scanWorkRecordFor(jobId: string, record: Uint8Array, headLen: number = 85): WorkRecordScan {
  const want = isHex(jobId) ? bytes16ToUuid(jobId) : jobId;
  const scan = scanWorkRecord(record, headLen);
  if (scan.jobId !== want) {
    throw new WorkRecordError("JobIdMismatch", `the record is for job ${scan.jobId}, not ${want}`);
  }
  return scan;
}

/** Accepts a record as bytes, as `0x` hex, or as text, and returns the bytes. */
export function toRecordBytes(record: Uint8Array | string): Uint8Array {
  if (typeof record !== "string") return record;
  return isHex(record, { strict: true }) ? hexToBytes(record) : new TextEncoder().encode(record);
}

/** The record as `0x` hex calldata for `settle`, `prove` and `stamp`. */
export function recordToHex(record: Uint8Array): Hex {
  return bytesToHex(record);
}
