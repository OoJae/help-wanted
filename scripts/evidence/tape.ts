/**
 * A recording of one run's reads, and a way to play it back.
 *
 * The tests of the evidence builder must run with no network and still exercise the real code:
 * the same reads, the same checks, the same counting. So a real run can write down every answer
 * it got (the JSON-RPC results by method and parameters, the API answers by URL), and a test hands
 * those answers back through the same two doors, `HttpPost` and `HttpGet`. A request the recording
 * does not hold fails like a node that does not answer, which is also how the tests show that a
 * failed read stops the run.
 */
import type { HttpGet } from "./imd.js";
import type { HttpPost } from "./rpc.js";

export interface Tape {
  /** What the tape is, for somebody who opens the file. */
  note: string;
  /** JSON-RPC answers: `<method> <params as JSON>` to the `result`, or to `{ "error": ... }`. */
  rpc: Record<
    string,
    { result: unknown } | { error: { code: number; message: string } }
  >;
  /** API answers: the path and query to the status and the JSON body. */
  api: Record<string, { status: number; body: unknown }>;
}

export function emptyTape(note: string): Tape {
  return { note, rpc: {}, api: {} };
}

const rpcKey = (method: string, params: unknown) =>
  `${method} ${JSON.stringify(params)}`;

function apiKey(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

/** Passes every request through and writes its answer on the tape. */
export function recordingPost(inner: HttpPost, tape: Tape): HttpPost {
  return async (url, body, signal) => {
    const answer = await inner(url, body, signal);
    try {
      const request = JSON.parse(body) as { method: string; params: unknown };
      const envelope = JSON.parse(answer.text) as Record<string, unknown>;
      // Only an answer is kept: a refusal on one node is often an answer on the next.
      if (answer.status === 200 && "result" in envelope) {
        tape.rpc[rpcKey(request.method, request.params)] = {
          result: envelope.result,
        };
      }
    } catch {
      // What cannot be read cannot be recorded; the run itself deals with it.
    }
    return answer;
  };
}

export function recordingGet(inner: HttpGet, tape: Tape): HttpGet {
  return async (url, init) => {
    const response = await inner(url, init);
    const copy = response.clone();
    try {
      tape.api[apiKey(url)] = { status: copy.status, body: await copy.json() };
    } catch {
      // Not JSON: nothing to record.
    }
    return response;
  };
}

const pick = (value: unknown, keys: readonly string[]): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const from = value as Record<string, unknown>;
  return Object.fromEntries(
    keys.filter((key) => key in from).map((key) => [key, from[key]]),
  );
};

/**
 * The tape with only what the builder reads. A block is served with every transaction hash in it
 * and a launch transaction with 48,000 bytes of calldata; the builder looks at three fields of
 * the one and four of the other. A pipeline job is served with its whole request text, twice; a
 * short beginning is kept. A launch's record keeps the fields of its list row and its contracts.
 * Logs, code and call results are kept whole.
 */
export function slimTape(tape: Tape): Tape {
  const rpc: Tape["rpc"] = {};
  for (const [key, held] of Object.entries(tape.rpc)) {
    if (!("result" in held)) {
      rpc[key] = held;
      continue;
    }
    const method = key.slice(0, key.indexOf(" "));
    let result = held.result;
    if (method === "eth_getBlockByNumber")
      result = pick(result, ["number", "hash", "timestamp"]);
    else if (method === "eth_getTransactionByHash")
      result = pick(result, ["hash", "from", "to", "blockNumber"]);
    else if (
      method === "eth_getTransactionReceipt" &&
      typeof result === "object" &&
      result !== null
    ) {
      const receipt = result as Record<string, unknown>;
      result = {
        status: receipt.status,
        logs: Array.isArray(receipt.logs)
          ? receipt.logs.map((log) => pick(log, ["address", "topics", "data"]))
          : [],
      };
    }
    rpc[key] = { result };
  }
  const api: Tape["api"] = {};
  for (const [key, held] of Object.entries(tape.api)) {
    let body = held.body;
    if (key.startsWith("/jobs/") && typeof body === "object" && body !== null) {
      const job = pick(body, [
        "id",
        "state",
        "template",
        "objective",
        "createdAt",
        "updatedAt",
        "paidBy",
        "launch",
      ]) as Record<string, unknown>;
      if (typeof job.objective === "string" && job.objective.length > 120) {
        job.objective = `${job.objective.slice(0, 120)} [the rest is left out of this recording]`;
      }
      body = job;
    } else if (
      /^\/launches\/[0-9a-f-]{36}$/.test(key) &&
      typeof body === "object" &&
      body !== null
    ) {
      // A launch's own record also holds its attestation, its pipeline job and its allocations;
      // the builder reads the fields of the list row and each contract's verification fields.
      body = pick(body, [
        "id",
        "launchNumber",
        "kind",
        "status",
        "chainId",
        "sourceRepoUrl",
        "sourceCommit",
        "parkedReason",
        "artifactCount",
        "artifacts",
        "createdAt",
        "updatedAt",
      ]);
    } else if (
      key.startsWith("/oracle/requests/") &&
      typeof body === "object" &&
      body !== null
    ) {
      const {
        members: _members,
        computed: _computed,
        attempts: _attempts,
        ...rest
      } = body as Record<string, unknown>;
      body = rest;
    }
    api[key] = { status: held.status, body };
  }
  return { note: tape.note, rpc, api };
}

/** Answers from the tape. A request the tape does not hold throws, as a dead node would. */
export function replayPost(tape: Tape, seen?: string[]): HttpPost {
  return async (_url, body) => {
    const request = JSON.parse(body) as {
      id: number;
      method: string;
      params: unknown;
    };
    const key = rpcKey(request.method, request.params);
    seen?.push(key);
    const held = tape.rpc[key];
    if (!held)
      throw new Error(`the tape holds no answer for ${key.slice(0, 120)}`);
    return {
      status: 200,
      text: JSON.stringify({ jsonrpc: "2.0", id: request.id, ...held }),
    };
  };
}

export function replayGet(tape: Tape, seen?: string[]): HttpGet {
  return async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") throw new Error(`the tape was asked for a ${method}`);
    const key = apiKey(url);
    seen?.push(key);
    const held = tape.api[key];
    if (!held) throw new Error(`the tape holds no answer for ${key}`);
    return new Response(JSON.stringify(held.body), {
      status: held.status,
      headers: { "content-type": "application/json" },
    });
  };
}
