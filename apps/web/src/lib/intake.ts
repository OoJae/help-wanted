/**
 * Requests bought on chain through the IdentityMD Intake, decoded from its two events:
 * `Requested` (someone paid and asked) and `Completed` (the writer closed the request).
 *
 * There are two Intake contracts on mainnet: version 2, which IdentityMD names for anything new
 * and which launch A is built on, and the legacy version 1, which holds the earlier history. Both
 * emit the same two events, so one decoder reads both; each row says which contract logged it.
 * Each counts every request it takes in its `nonce()`: version 2 sells oracle questions, jobs,
 * launches and workflows on Ethereum, version 1 oracle questions only. Each row names its action.
 *
 * The question text inside a request body is written by whoever paid for it. It is third-party
 * text: the pages print it inside a quotation and never treat it as anything else.
 */
import { decodeEventLog, hexToString, type Hex } from "viem";
import { intakeAbi, MAINNET, questionOfBody, sameAddress } from "@help-wanted/shared";
import { TOPIC } from "~/config/chain";
import type { RawLog } from "./jsonrpc";

export type CompletionStatus = "answered" | "refused" | "no_answer" | "unknown";

/** Which Intake logged a request: 2 is the current contract, 1 the legacy one. */
export type IntakeVersion = 1 | 2;

export const INTAKE_ADDRESS: Record<IntakeVersion, `0x${string}`> = {
  1: MAINNET.INTAKE_V1,
  2: MAINNET.INTAKE,
};

export function intakeVersionOf(address: string): IntakeVersion | null {
  if (sameAddress(address, MAINNET.INTAKE)) return 2;
  if (sameAddress(address, MAINNET.INTAKE_V1)) return 1;
  return null;
}

export interface IntakeCompletion {
  status: CompletionStatus;
  statusCode: number;
  resultHash: Hex;
  uri: string;
  /** False when the callback reverted, ran out of gas, or there was none. */
  delivered: boolean;
  block: number;
  timestamp: number | null;
  txHash: Hex;
}

export interface IntakeQuestion {
  text: string;
  answerType: string | null;
  panelSize: number | null;
  quorum: number | null;
  evidence: string | null;
  /** The window as the body states it: `{fromBlock, toBlock}` or `{hours}`. */
  window: string | null;
  validForSeconds: number | null;
}

export interface IntakeRequest {
  requestId: Hex;
  /** Which Intake contract logged the request. */
  version: IntakeVersion;
  /** Lowercase. */
  payer: `0x${string}`;
  /** The action id as text, e.g. `oracle.request@oracle-1`. */
  action: string;
  bodyBytes: number;
  /** The parsed question, or null when the body is not the JSON the oracle expects. */
  question: IntakeQuestion | null;
  /** Null when the request asked for no callback: the payer reads the answer off chain. */
  callbackTarget: `0x${string}` | null;
  callbackSelector: Hex | null;
  asset: `0x${string}`;
  amountWei: bigint;
  block: number;
  timestamp: number | null;
  txHash: Hex;
  completion: IntakeCompletion | null;
}

const STATUS: Record<number, CompletionStatus> = { 0: "answered", 1: "refused", 2: "no_answer" };

function ts(log: RawLog): number | null {
  return log.blockTimestamp ? Number(BigInt(log.blockTimestamp)) : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Reads the fields a page shows out of a request body. The body is untrusted JSON: anything that
 * is not an object with a text question reads as "no question". Where the body is a well-formed
 * oracle request, the hashed part is taken apart by the shared package's own reader.
 */
export function parseQuestionBody(body: string): IntakeQuestion | null {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const o = doc as Record<string, unknown>;
  const text = str(o.question);
  if (text === null) return null;
  let window: string | null = null;
  let answerType = str(o.answerType);
  let evidence = str(o.evidence);
  try {
    const read = questionOfBody(body);
    answerType = read.question.answerType;
    // The shared reader names the default; a page says only what the payer wrote.
    if (evidence === null && read.question.evidence === "panel") evidence = "panel";
    if ("hours" in read.window) {
      window = `the last ${read.window.hours} hour${read.window.hours === 1 ? "" : "s"}`;
    } else {
      const { fromBlock, toBlock } = read.window;
      window = fromBlock === toBlock ? `block ${fromBlock}` : `blocks ${fromBlock} to ${toBlock}`;
    }
  } catch {
    // Not a body the oracle would take as it stands (it names no chain, say). The question text
    // and the window it states are still worth showing, read as plain data.
    const w = typeof o.window === "object" && o.window !== null ? (o.window as Record<string, unknown>) : {};
    const hours = num(w.hours);
    const fromBlock = num(w.fromBlock);
    const toBlock = num(w.toBlock);
    if (hours !== null) window = `the last ${hours} hour${hours === 1 ? "" : "s"}`;
    else if (fromBlock !== null && toBlock !== null) {
      window = fromBlock === toBlock ? `block ${fromBlock}` : `blocks ${fromBlock} to ${toBlock}`;
    }
  }
  return {
    text,
    answerType,
    panelSize: num(o.panelSize),
    quorum: num(o.quorum),
    evidence,
    window,
    validForSeconds: num(o.validForSeconds),
  };
}

/**
 * Joins `Requested` and `Completed` logs into one row per request, oldest first. Logs that are
 * neither event, that come from a contract that is not an Intake, or that do not decode, are
 * skipped: a page must not fail on one odd log.
 */
export function decodeIntakeLogs(logs: readonly RawLog[]): IntakeRequest[] {
  const requests = new Map<string, IntakeRequest>();
  const completions = new Map<string, IntakeCompletion>();

  for (const log of logs) {
    if (log.removed) continue;
    const version = intakeVersionOf(log.address);
    if (version === null) continue;
    const topic0 = log.topics[0]?.toLowerCase();
    // A request id is the Intake's own; the two contracts count separately, so the key names both.
    const keyOf = (requestId: string) => `${version}:${requestId.toLowerCase()}`;
    try {
      if (topic0 === TOPIC.INTAKE_REQUESTED) {
        const { args } = decodeEventLog({
          abi: intakeAbi,
          eventName: "Requested",
          topics: log.topics as [Hex, ...Hex[]],
          data: log.data as Hex,
        });
        const body = hexToString(args.body);
        const target = args.callbackTarget.toLowerCase() as `0x${string}`;
        const hasCallback = !/^0x0{40}$/.test(target);
        requests.set(keyOf(args.requestId), {
          requestId: args.requestId.toLowerCase() as Hex,
          version,
          payer: args.payer.toLowerCase() as `0x${string}`,
          action: hexToString(args.action, { size: 32 }),
          bodyBytes: (args.body.length - 2) / 2,
          question: parseQuestionBody(body),
          callbackTarget: hasCallback ? target : null,
          callbackSelector: hasCallback ? args.callbackSelector : null,
          asset: args.asset.toLowerCase() as `0x${string}`,
          amountWei: args.amount,
          block: Number(BigInt(log.blockNumber)),
          timestamp: ts(log),
          txHash: log.transactionHash.toLowerCase() as Hex,
          completion: null,
        });
      } else if (topic0 === TOPIC.INTAKE_COMPLETED) {
        const { args } = decodeEventLog({
          abi: intakeAbi,
          eventName: "Completed",
          topics: log.topics as [Hex, ...Hex[]],
          data: log.data as Hex,
        });
        completions.set(keyOf(args.requestId), {
          status: STATUS[args.status] ?? "unknown",
          statusCode: args.status,
          resultHash: args.resultHash,
          uri: args.uri,
          delivered: args.delivered,
          block: Number(BigInt(log.blockNumber)),
          timestamp: ts(log),
          txHash: log.transactionHash.toLowerCase() as Hex,
        });
      }
    } catch {
      // Not one of ours, or not decodable: leave it out.
    }
  }

  for (const [id, completion] of completions) {
    const request = requests.get(id);
    if (request) request.completion = completion;
  }
  return [...requests.values()].sort((a, b) => a.block - b.block);
}

export function completionWords(request: IntakeRequest): string {
  const c = request.completion;
  if (!c) return "not completed";
  if (c.status === "answered") return c.delivered ? "answered, delivered to the contract" : "answered";
  if (c.status === "refused") return "refused";
  if (c.status === "no_answer") return "no answer";
  return `status ${c.statusCode}`;
}
