/**
 * The IdentityMD Intake: every oracle request a contract or wallet has bought on chain.
 *
 * There are two Intake contracts on mainnet and this module reads both. Version 2 is the one
 * IdentityMD names for anything new and the one launch A's `Questions` buys its answers through;
 * version 1 is legacy and holds the earlier history. They emit the same two events, so one handler
 * folds both, and each row says which contract logged it (`intake`).
 *
 * `Requested` carries the request's whole body (the event is the one place it can be read back
 * from) and `Completed` says how it ended: 0 answered, 1 refused, 2 unanswered. A refused or
 * unanswered request spent its price and was never called back. One row per request id; a request
 * with no completion yet has the completion columns null.
 *
 * A body is whatever bytes the buyer sent. It is stored and shown as data: nothing in it is ever
 * fetched, followed or executed here.
 */
import { boolean, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { hexToBytes, parseAbi } from "viem";
import { z } from "zod";
import { INTAKE_STATUS, INTAKES, TOPIC } from "../constants.js";
import { int53, wei } from "../db/columns.js";
import { address, bytes32, hex, parseArgs, smallUint, uint } from "../engine/args.js";
import type { ContractModule } from "../engine/module.js";
import { isStorableJson, jsonTextDepthWithin, MAX_STORED_JSON_DEPTH, type JsonValue } from "../json.js";

export const intakeRequests = pgTable(
  "intake_requests",
  {
    requestId: text("request_id").primaryKey(),
    /**
     * The Intake contract that logged the request, lowercase: version 2 or the legacy version 1.
     * Null only for a row written before the module read both contracts, until it is rebuilt.
     */
    intake: text("intake"),

    // From `Requested`. Null when only the completion has been seen (its request is below the
    // module's start block).
    payer: text("payer"),
    /** The action id as bytes32, e.g. `bytes32("oracle.request@oracle-1")`. */
    action: text("action"),
    /** The same bytes as text when they are printable ASCII. */
    actionName: text("action_name"),
    /** The body exactly as sent, hex. */
    bodyHex: text("body_hex"),
    /** The body as text when it is valid UTF-8 without NUL bytes. */
    bodyText: text("body_text"),
    /**
     * The body parsed as JSON, when it parses and is fit to keep (see `decodeBody`). A convenience
     * copy: numbers are JavaScript doubles here, so exact digits are read from `body_text`.
     */
    bodyJson: jsonb("body_json").$type<JsonValue>(),
    /** `question` and `answerType` lifted out of the body for listing; null when absent. */
    question: text("question"),
    answerType: text("answer_type"),
    /** Zero address and selector when the buyer asked for no callback. */
    callbackTarget: text("callback_target"),
    callbackSelector: text("callback_selector"),
    asset: text("asset"),
    amount: wei("amount"),
    requestedBlock: int53("requested_block"),
    requestedTime: int53("requested_time"),
    requestedTx: text("requested_tx"),
    requestedLogIndex: int53("requested_log_index"),

    // From `Completed`.
    status: int53("status"),
    /** `answered`, `refused` or `unanswered`; the number as text for a status this version does not know. */
    statusName: text("status_name"),
    resultHash: text("result_hash"),
    uri: text("uri"),
    /** The oracle request's UUID, when `uri` points at `…/oracle/requests/<uuid>`. */
    oracleRequestId: text("oracle_request_id"),
    /** True when the Intake's callback to the buyer went through. */
    delivered: boolean("delivered"),
    completedBlock: int53("completed_block"),
    completedTime: int53("completed_time"),
    completedTx: text("completed_tx"),
    completedLogIndex: int53("completed_log_index"),
  },
  (t) => [
    index("intake_requests_requested_idx").on(t.requestedBlock, t.requestedLogIndex),
    index("intake_requests_payer_idx").on(t.payer),
    index("intake_requests_callback_idx").on(t.callbackTarget),
  ],
);

export const intakeAbi = parseAbi([
  "event Requested(bytes32 indexed requestId, address indexed payer, bytes32 indexed action, bytes body, address callbackTarget, bytes4 callbackSelector, address asset, uint256 amount)",
  "event Completed(bytes32 indexed requestId, uint8 status, bytes32 resultHash, string uri, bool delivered)",
]);

const Requested = z.object({
  requestId: bytes32,
  payer: address,
  action: bytes32,
  body: hex,
  callbackTarget: address,
  callbackSelector: hex,
  asset: address,
  amount: uint,
});

const Completed = z.object({
  requestId: bytes32,
  status: smallUint,
  resultHash: bytes32,
  uri: z.string(),
  delivered: z.boolean(),
});

/** A bytes32 that holds right-padded printable ASCII → that text; otherwise null. */
export function bytes32Text(word: string): string | null {
  const bytes = hexToBytes(word as `0x${string}`);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  if (end === 0) return null;
  let text = "";
  for (let i = 0; i < end; i++) {
    const byte = bytes[i] as number;
    if (byte < 0x20 || byte > 0x7e) return null;
    text += String.fromCharCode(byte);
  }
  return text;
}

export interface DecodedBody {
  text: string | null;
  json: JsonValue | null;
  question: string | null;
  answerType: string | null;
}

/**
 * Reads a request body as far as it can be read. A body is whatever bytes a buyer sent: the
 * Intake checks only that it is 1 to 16,384 bytes long, emits it whole, and anyone may buy a
 * request. So the decoding stops, at the level it has reached, on anything out of the ordinary:
 * invalid UTF-8, a NUL byte (which Postgres text cannot hold), malformed JSON, JSON that Postgres
 * would refuse, or JSON nested deeper than `MAX_STORED_JSON_DEPTH` (a real body is two or three
 * levels deep; thousands of nested brackets fit in 16 KB and exist only to exhaust the stack of
 * whatever walks them). The hex is always kept, and this function never throws: whatever goes
 * wrong, the answer is "not decoded", so one body cannot stop the module.
 */
export function decodeBody(bodyHex: string): DecodedBody {
  const none: DecodedBody = { text: null, json: null, question: null, answerType: null };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(bodyHex as `0x${string}`));
  } catch {
    return none;
  }
  if (text.includes("\u0000")) return none;

  try {
    // Judged from the text, so a value built only to be deep is never even parsed.
    if (!jsonTextDepthWithin(text, MAX_STORED_JSON_DEPTH)) return { ...none, text };
    const json = JSON.parse(text) as JsonValue;
    if (!isStorableJson(json)) return { ...none, text };

    const field = (key: string): string | null => {
      if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
      const value = Object.hasOwn(json, key) ? json[key] : undefined;
      return typeof value === "string" ? value : null;
    };
    return { text, json, question: field("question"), answerType: field("answerType") };
  } catch {
    return { ...none, text };
  }
}

const ORACLE_REQUEST_URI =
  /\/oracle\/requests\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/attestation)?\/?$/;

/** The UUID in `https://api.imd.fun/oracle/requests/<uuid>[/attestation]`, or null. */
export function oracleRequestIdFromUri(uri: string): string | null {
  return ORACLE_REQUEST_URI.exec(uri)?.[1] ?? null;
}

export function intakeStatusName(status: number): string {
  return (INTAKE_STATUS as Record<number, string>)[status] ?? String(status);
}

export const intakeModule: ContractModule = {
  name: "intake",
  title: "Intake Requested and Completed (oracle requests bought on chain, both Intake contracts)",
  abi: intakeAbi,
  filter: () => ({ address: INTAKES, topics: [[TOPIC.Requested, TOPIC.Completed]] }),
  tables: [intakeRequests],
  async apply(db, event) {
    if (event.event === "Requested") {
      const args = parseArgs(Requested, event);
      const body = decodeBody(args.body);
      const request = {
        intake: event.address,
        payer: args.payer,
        action: args.action,
        actionName: bytes32Text(args.action),
        bodyHex: args.body,
        bodyText: body.text,
        bodyJson: body.json,
        question: body.question,
        answerType: body.answerType,
        callbackTarget: args.callbackTarget,
        callbackSelector: args.callbackSelector,
        asset: args.asset,
        amount: args.amount,
        requestedBlock: event.blockNumber,
        requestedTime: event.blockTime,
        requestedTx: event.txHash,
        requestedLogIndex: event.logIndex,
      };
      // The two events fill disjoint columns, so they can arrive in either order.
      await db
        .insert(intakeRequests)
        .values({ requestId: args.requestId, ...request })
        .onConflictDoUpdate({ target: intakeRequests.requestId, set: request });
      return;
    }

    if (event.event === "Completed") {
      const args = parseArgs(Completed, event);
      const completion = {
        intake: event.address,
        status: args.status,
        statusName: intakeStatusName(args.status),
        resultHash: args.resultHash,
        uri: args.uri,
        oracleRequestId: oracleRequestIdFromUri(args.uri),
        delivered: args.delivered,
        completedBlock: event.blockNumber,
        completedTime: event.blockTime,
        completedTx: event.txHash,
        completedLogIndex: event.logIndex,
      };
      await db
        .insert(intakeRequests)
        .values({ requestId: args.requestId, ...completion })
        .onConflictDoUpdate({ target: intakeRequests.requestId, set: completion });
    }
  },
};
