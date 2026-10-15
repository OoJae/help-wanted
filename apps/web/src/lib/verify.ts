/**
 * The check behind the product's central claim: a swarm job's work record is proven when
 * `keccak256(record bytes) == WorkRegistry.latest(jobId)`.
 *
 * This module is the whole check and nothing else. It takes its three reads as functions, so the
 * same code runs on the server (cached reads), in a visitor's browser (the visitor's own RPC call
 * and the visitor's own hashing) and in tests (a recorded record and a mocked registry). It trusts
 * none of its inputs: the record bytes prove themselves by hashing to the receipt, or they do not.
 */
import { keccak256, type Hex } from "viem";
import { isZeroHash, jobIdToBytes16, parseHash, parseJobId } from "./ids";

/** What the IdentityMD API lists for a job's work record (`GET /jobs/:id/records`). */
export interface RecordRef {
  hash: Hex;
  /** `sent` once the receipt transaction is mined, `queued` while it waits, `failed` if it was dropped. */
  status: string;
  txHash: Hex | null;
  failure: string | null;
}

export interface VerifyDeps {
  /** `WorkRegistry.latest(bytes16 jobId)`: the receipt, or the zero hash. */
  readReceipt(jobIdBytes16: Hex): Promise<Hex>;
  /** The record exactly as served, or null when the server has no record under that hash. */
  fetchRecord(hash: Hex): Promise<Uint8Array | null>;
  /** The API's list for the job; null when the API does not know the job. Optional. */
  listRecords?(jobId: string): Promise<RecordRef[] | null>;
}

export type Verdict = "proven" | "no_receipt" | "mismatch" | "unchecked";

export const STAMP: Record<Verdict, string> = {
  proven: "PROVEN ON CHAIN",
  no_receipt: "NO RECEIPT YET",
  mismatch: "DOES NOT MATCH",
  unchecked: "COULD NOT CHECK",
};

export type StepKey = "receipt" | "record" | "hash" | "compare";

export interface VerifyStep {
  key: StepKey;
  title: string;
  /** true passed, false failed, null not reached or not applicable. */
  ok: boolean | null;
  detail: string;
  /** The value the step produced, when it produced one. */
  value: string | null;
}

/** What the record itself says, read only from bytes that were checked against a hash. */
export interface RecordFacts {
  schema: string | null;
  jobId: string | null;
  kind: string | null;
  state: string | null;
  objective: string | null;
  /** The ERC-8004 agent ids in `signals`, each once, in order of first appearance. */
  agentIds: string[];
  parentJobId: string | null;
  /** The hash of the receipt this record replaced; null for a job's first record. */
  previousHash: string | null;
}

export interface CheckedRecord {
  /** The hash the bytes were fetched under: the receipt the registry returned. */
  hash: Hex;
  bytes: number;
  /** keccak256 of the bytes as hashed (after removing one trailing newline, if that was needed). */
  keccak: Hex;
  matches: boolean;
  strippedNewline: boolean;
}

export interface VerifyResult {
  jobId: string;
  jobIdBytes16: Hex;
  verdict: Verdict;
  stamp: string;
  /** One plain sentence saying what was found. */
  summary: string;
  /** `WorkRegistry.latest(jobId)` as read; null when the read failed. */
  receipt: Hex | null;
  record: CheckedRecord | null;
  /** The API's entry for the job's record, when it was asked and had one. */
  listed: RecordRef | null;
  facts: RecordFacts | null;
  steps: VerifyStep[];
  /** Reads that failed, in plain words. */
  problems: string[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** keccak256 of served bytes; tries them as served, then with exactly one trailing newline removed. */
export function hashServedRecord(
  served: Uint8Array,
  expected: Hex,
): { keccak: Hex; matches: boolean; strippedNewline: boolean; bytes: number } {
  const want = expected.toLowerCase();
  const asServed = keccak256(served);
  if (asServed === want)
    return { keccak: asServed, matches: true, strippedNewline: false, bytes: served.length };
  if (served.length > 0 && served[served.length - 1] === 0x0a) {
    const trimmed = served.subarray(0, served.length - 1);
    const hashed = keccak256(trimmed);
    if (hashed === want)
      return { keccak: hashed, matches: true, strippedNewline: true, bytes: trimmed.length };
  }
  return { keccak: asServed, matches: false, strippedNewline: false, bytes: served.length };
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Reads the display facts out of a record. This is `JSON.parse`, for people; the contract's own
 * scanner (`WorkProof`) walks the bytes instead. Returns null when the bytes are not a JSON object.
 */
export function readRecordFacts(bytes: Uint8Array): RecordFacts | null {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const record = doc as Record<string, unknown>;
  const agentIds: string[] = [];
  if (Array.isArray(record.signals)) {
    for (const signal of record.signals) {
      if (typeof signal !== "object" || signal === null) continue;
      const raw = (signal as Record<string, unknown>).agentId;
      const id = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : null;
      if (id && /^\d+$/.test(id) && !agentIds.includes(id)) agentIds.push(id);
    }
  }
  return {
    schema: asString(record.schema),
    jobId: asString(record.jobId),
    kind: asString(record.kind),
    state: asString(record.state),
    objective: asString(record.objective),
    agentIds,
    parentJobId: asString(record.parentJobId),
    previousHash: nonZeroHex(asString(record.previousHash)),
  };
}

/** A first receipt carries a `previousHash` of zeros; only a real earlier hash is worth showing. */
function nonZeroHex(value: string | null): string | null {
  return value !== null && /^(0x)?0*$/.test(value) ? null : value;
}

/** The four steps, in order, as every rendering of the check names them. */
export const STEP_TITLES: Record<StepKey, string> = {
  receipt: "Read the receipt from the WorkRegistry",
  record: "Fetch the work record",
  hash: "Hash the record",
  compare: "Compare the two",
};
export const STEP_KEYS: readonly StepKey[] = ["receipt", "record", "hash", "compare"];

function pending(key: StepKey): VerifyStep {
  return { key, title: STEP_TITLES[key], ok: null, detail: "Not reached.", value: null };
}

/**
 * The result of a check that was not run at all (the server declined to start it). Every step is
 * "not reached", so no rendering can mistake it for a finding about the job.
 */
export function notRunResult(jobIdInput: string, summary: string): VerifyResult {
  const jobId = parseJobId(jobIdInput);
  if (!jobId) throw new TypeError("not a job id");
  return {
    jobId,
    jobIdBytes16: jobIdToBytes16(jobId),
    verdict: "unchecked",
    stamp: STAMP.unchecked,
    summary,
    receipt: null,
    record: null,
    listed: null,
    facts: null,
    steps: STEP_KEYS.map(pending),
    problems: [],
  };
}

/**
 * Runs the check for one job. Never throws for a failed read: the result says which read failed.
 * Throws only for a job id that is not a UUID, which is the caller's to refuse first.
 */
export async function verifyJob(jobIdInput: string, deps: VerifyDeps): Promise<VerifyResult> {
  const jobId = parseJobId(jobIdInput);
  if (!jobId) throw new TypeError("not a job id");
  const jobIdBytes16 = jobIdToBytes16(jobId);
  const problems: string[] = [];

  const steps: Record<StepKey, VerifyStep> = {
    receipt: pending("receipt"),
    record: pending("record"),
    hash: pending("hash"),
    compare: pending("compare"),
  };
  const result: VerifyResult = {
    jobId,
    jobIdBytes16,
    verdict: "unchecked",
    stamp: STAMP.unchecked,
    summary: "",
    receipt: null,
    record: null,
    listed: null,
    facts: null,
    steps: [],
    problems,
  };
  const finish = (verdict: Verdict, summary: string): VerifyResult => {
    result.verdict = verdict;
    result.stamp = STAMP[verdict];
    result.summary = summary;
    result.steps = [steps.receipt, steps.record, steps.hash, steps.compare];
    return result;
  };

  // 1. The receipt, from the chain.
  let receipt: Hex;
  try {
    const read = parseHash(await deps.readReceipt(jobIdBytes16));
    if (!read) throw new Error("the registry did not return a 32-byte word");
    receipt = read;
  } catch (error) {
    problems.push(`The WorkRegistry could not be read: ${errorText(error)}`);
    steps.receipt = {
      ...steps.receipt,
      ok: false,
      detail: "The chain read failed. Nothing can be said yet.",
    };
    return finish("unchecked", "The WorkRegistry could not be read, so the job could not be checked.");
  }
  result.receipt = receipt;
  const hasReceipt = !isZeroHash(receipt);
  steps.receipt = {
    ...steps.receipt,
    ok: hasReceipt,
    value: receipt,
    detail: hasReceipt
      ? "The registry holds a receipt for this job."
      : "The registry returned zero: no receipt has been written for this job.",
  };

  // What the API lists. Needed only to explain a missing receipt and to link the receipt transaction.
  // `listRead` is null when nobody was asked (the browser's own check has no list to ask), false
  // when the list was asked for and could not be read. Neither is "the API lists nothing".
  let listRead: boolean | null = null;
  if (deps.listRecords) {
    try {
      const listed = await deps.listRecords(jobId);
      listRead = true;
      if (listed && listed.length > 0) {
        result.listed = listed.find((r) => r.hash.toLowerCase() === receipt) ?? listed[0] ?? null;
      }
    } catch (error) {
      listRead = false;
      problems.push(`The IdentityMD API's record list could not be read: ${errorText(error)}`);
    }
  }

  if (!hasReceipt) {
    // Without a receipt there is nothing on chain to hash a record against. What the API lists is
    // reported as what it is: the swarm's own statement, not a proof.
    steps.record = {
      ...steps.record,
      value: result.listed?.hash ?? null,
      detail: result.listed
        ? `Not fetched. The IdentityMD API lists a record with this hash (status ${result.listed.status}), but no receipt commits to it.`
        : listRead === true
          ? "Not fetched: there is no receipt, and the IdentityMD API lists no record for this job."
          : listRead === false
            ? "Not fetched: there is no receipt. Whether the IdentityMD API lists a record for this job could not be read just now."
            : "Not fetched: there is no receipt to fetch a record under.",
    };
    steps.hash = { ...steps.hash, detail: "Nothing to hash against." };
    steps.compare = { ...steps.compare, ok: false, detail: "No receipt to compare with." };
    return finish("no_receipt", noReceiptSummary(result.listed, listRead));
  }

  // 2. The record, as bytes, under the hash the chain returned.
  let served: Uint8Array | null;
  try {
    served = await deps.fetchRecord(receipt);
  } catch (error) {
    problems.push(`The work record could not be fetched: ${errorText(error)}`);
    served = null;
  }
  if (!served) {
    steps.record = {
      ...steps.record,
      ok: false,
      value: receipt,
      detail: "The record could not be fetched under the hash the registry returned.",
    };
    steps.hash = { ...steps.hash, detail: "Nothing to hash." };
    steps.compare = {
      ...steps.compare,
      detail: "The receipt exists, but there were no bytes to hash against it.",
    };
    return finish(
      "unchecked",
      "The WorkRegistry holds a receipt for this job, but the record could not be fetched to hash it.",
    );
  }
  steps.record = {
    ...steps.record,
    ok: true,
    value: `${served.length.toLocaleString("en-US")} bytes`,
    detail: "Fetched under the hash the registry returned.",
  };

  // 3. The hash of those bytes.
  const hashed = hashServedRecord(served, receipt);
  result.record = {
    hash: receipt,
    bytes: hashed.bytes,
    keccak: hashed.keccak,
    matches: hashed.matches,
    strippedNewline: hashed.strippedNewline,
  };
  steps.hash = {
    ...steps.hash,
    ok: true,
    value: hashed.keccak,
    detail: hashed.strippedNewline
      ? `keccak256 of ${hashed.bytes.toLocaleString("en-US")} bytes, after removing one trailing newline the server added.`
      : `keccak256 of the ${hashed.bytes.toLocaleString("en-US")} bytes exactly as served.`,
  };

  // 4. The comparison.
  if (!hashed.matches) {
    steps.compare = {
      ...steps.compare,
      ok: false,
      detail:
        "The hash of the served bytes is not the receipt. These bytes are not the record the registry holds.",
    };
    return finish(
      "mismatch",
      "The served record does not hash to the receipt the WorkRegistry holds for this job.",
    );
  }
  const facts = readRecordFacts(hashed.strippedNewline ? served.subarray(0, served.length - 1) : served);
  result.facts = facts;
  if (facts?.jobId && facts.jobId !== jobId) {
    steps.compare = {
      ...steps.compare,
      ok: false,
      detail: `The bytes hash to the receipt, but the record names job ${facts.jobId}, not this one.`,
    };
    return finish("mismatch", "The record hashes to the receipt but names a different job.");
  }
  steps.compare = {
    ...steps.compare,
    ok: true,
    detail: "keccak256(record) equals WorkRegistry.latest(jobId), byte for byte.",
  };
  // A receipt proves what the record says, whatever it says. Jobs that end blocked get receipts
  // too, so a proven record is not always a delivery, and the sentence must not read as if it were.
  const ending =
    facts?.state && facts.state !== COMPLETED_STATE
      ? ` The record says the job ended "${facts.state}", not completed: what is proven is that outcome, not a delivery.`
      : "";
  return finish(
    "proven",
    `The work record (${hashed.bytes.toLocaleString("en-US")} bytes) hashes to the receipt the WorkRegistry holds for this job.${ending}`,
  );
}

/** The `state` a work record carries when the job was delivered. The hire desk pays on no other. */
export const COMPLETED_STATE = "completed";

/**
 * True when a proven record says the job was completed, false when it says anything else, null when
 * nothing is proven or the record names no state.
 */
export function provenDelivery(result: Pick<VerifyResult, "verdict" | "facts">): boolean | null {
  if (result.verdict !== "proven" || !result.facts?.state) return null;
  return result.facts.state === COMPLETED_STATE;
}

function noReceiptSummary(listed: RecordRef | null, listRead: boolean | null): string {
  if (!listed) {
    if (listRead === true) {
      return "The WorkRegistry holds no receipt for this job, and the IdentityMD API lists no work record for it.";
    }
    if (listRead === false) {
      return "The WorkRegistry holds no receipt for this job. What the IdentityMD API lists for it could not be read just now.";
    }
    return "The WorkRegistry holds no receipt for this job.";
  }
  if (listed.status === "queued") {
    return "The swarm has produced a work record for this job, but its receipt is still queued: the WorkRegistry has not been written.";
  }
  if (listed.status === "failed") {
    return "The swarm produced a work record for this job, but writing its receipt failed: the WorkRegistry holds nothing.";
  }
  return `The IdentityMD API lists a work record for this job (status ${listed.status}), but the WorkRegistry holds no receipt.`;
}

export interface VerifyCommandInput {
  jobId: string;
  rpcUrl: string;
  workRegistry: string;
  apiBase: string;
  /** The record hash to fetch, when one is known; otherwise the command reads it from the chain. */
  recordHash: Hex | null;
}

/**
 * The same check by hand, with Foundry's `cast` and `curl`. Each line was run against the reference
 * job before it was printed here: `cast keccak` hashes the bytes it reads from standard input.
 */
export function verifyCommands(input: VerifyCommandInput): { comment: string; command: string }[] {
  const jobHex = jobIdToBytes16(input.jobId);
  const base = input.apiBase.replace(/\/+$/, "");
  const call = `cast call ${input.workRegistry} "latest(bytes16)(bytes32)" ${jobHex} --rpc-url ${input.rpcUrl}`;
  const recordUrl = input.recordHash
    ? `${base}/work-records/${input.recordHash.slice(2)}.json`
    : `${base}/work-records/$(${call} | cut -c3-).json`;
  return [
    { comment: "1. The receipt the WorkRegistry holds for the job (zero means none).", command: call },
    {
      comment: "2. The work record, hashed exactly as served.",
      command: `curl -s ${recordUrl} | cast keccak`,
    },
    {
      comment: "3. The two lines above must print the same 32 bytes. Or, in one go:",
      command: `[ "$(${call})" = "$(curl -s ${recordUrl} | cast keccak)" ] && echo PROVEN || echo "NOT PROVEN"`,
    },
  ];
}
