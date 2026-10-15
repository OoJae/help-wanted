/**
 * IdentityMD's service, played locally, for the two bots together: the Standing Questions routes
 * of `StandInService`, and on top of them the routes a runner and a keeper use on the hire desk.
 *
 * - The paid-request flow of IdentityMD's guide ("How paying works"): `POST /requests/quote`, the
 *   402 challenge of `POST /requests/:id/submit`, the paying submit, `GET /requests/:id`, and
 *   `GET /requests/paid-by/:address`. A paying submit is checked the way the guide describes
 *   before anything is admitted: the payment payload is parsed strictly, `accepted` must be the
 *   challenge's `accepts[0]`, the Permit2 signature must recover to the paying wallet, and the
 *   EIP-712 quote approval must recover to the same wallet over the SHA-256 of the canonical JSON
 *   of the exact payment sent. The fee is then moved on the local chain as Permit2 would move it:
 *   from the payer to IdentityMD's payee, out of the payer's allowance to Permit2.
 * - The free preflight `POST /requests/check`, `GET /requests/capabilities`.
 * - `GET /jobs/:id`, `GET /jobs/:id/records` and `GET /work-records/:hash.json`.
 *
 * The typed data below is written out from the guide and from Permit2's published witness type,
 * not imported from the runner: the stand-in must not agree with the runner by construction.
 *
 * Nothing here is a recording of the live service, and nothing here reaches it.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  recoverTypedDataAddress,
  stringToBytes,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { mainnet } from "viem/chains";
import { MAINNET, OFFCHAIN, canonicalize, uuidToBytes16 } from "@help-wanted/shared";
import { KEEPER_DIR, StandInService, WHO, standIn, type Node, type World } from "./harness.js";

/** The real work record of the job that carried our order header (job e70c56ce), as a template. */
const RECORD_TEMPLATE = JSON.parse(
  readFileSync(join(KEEPER_DIR, "test", "fixtures", "header-job-record.json"), "utf8"),
) as Record<string, unknown>;

/** Permit2's witness type for an x402 "exact" payment. */
const PERMIT2_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
} as const;

/** The quote approval, as the guide lists its fields. */
const QUOTE_APPROVAL_TYPES = {
  QuoteApproval: [
    { name: "resource", type: "string" },
    { name: "requesterScopeHash", type: "bytes32" },
    { name: "quoteId", type: "string" },
    { name: "quoteHash", type: "bytes32" },
    { name: "paymentHash", type: "bytes32" },
    { name: "action", type: "string" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "payTo", type: "address" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

/** `canon` from the guide: sorted keys, no whitespace. */
function canon(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

interface PaidOrder {
  id: string;
  token: string;
  requestKey: string;
  status: "quoted" | "paid";
  quote: Record<string, unknown> & { expiresAt: number; quoteHash: string };
  input: Record<string, unknown>;
  createdAt: string;
  paidAt: string | null;
  payer: Address | null;
  paymentTx: Hex | null;
  jobId: string | null;
}

export interface PlaneJob {
  id: string;
  state: string;
  template: string | null;
  objective: string;
  paidBy: Address | null;
  blockedReason: string | null;
  /** Record hashes, newest first, without `0x`, with the status the feedback queue shows. */
  records: { hash: string; status: string; txHash: Hex | null }[];
}

export interface VerifiedPayment {
  orderId: string;
  payer: Address;
  amount: bigint;
  /** The transaction that moved the fee on the local chain. */
  tx: Hex;
  jobId: string;
}

/** A refusal with its HTTP status, as the service words them. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error));
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export class StandInPlane extends StandInService {
  readonly #orders = new Map<string, PaidOrder>();
  readonly jobs = new Map<string, PlaneJob>();
  /** Work records by hash (no `0x`), exactly as they are served. */
  readonly records = new Map<string, Uint8Array>();
  /** Every body sent to the free preflight. */
  readonly checks: unknown[] = [];
  /** Every payment that passed both signature checks and was moved on chain. */
  readonly payments: VerifiedPayment[] = [];
  /** Every POST path, in order: to show what a dry run did and did not send. */
  readonly posts: string[] = [];
  /** Refusals of paying submits, with the reason, for a test that expects one. */
  readonly refusals: string[] = [];
  /** What `job.open` costs, in IMD-wei. */
  price = 500_000_000_000_000_000n;
  /** How long the 402 challenge gives a payment, in seconds, against a 600-second quote. */
  maxTimeoutSeconds = 300;
  readonly #imdAbi: Abi = standIn("StandInIMD", "StandInIMD").abi;
  readonly #registryAbi: Abi = standIn("StandInWorkRegistry", "StandInWorkRegistry").abi;

  constructor(node: Node, world: World) {
    super(node, world);
  }

  /** The clock the plane stamps quotes with: the test's, which follows the local chain. */
  #now(): number {
    return Math.floor(Date.now() / 1000);
  }

  // -------------------------------------------------------------------------------------------
  // What the test does as IdentityMD
  // -------------------------------------------------------------------------------------------

  /** A job that exists without having been bought through this plane (another payer's, say). */
  openJob(fields: { objective: string; template: string; paidBy: Address | null; state?: string }): PlaneJob {
    const job: PlaneJob = {
      id: randomUUID(),
      state: fields.state ?? "executing",
      template: fields.template,
      objective: fields.objective,
      paidBy: fields.paidBy,
      blockedReason: null,
      records: [],
    };
    this.jobs.set(job.id, job);
    return job;
  }

  job(id: string): PlaneJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`the plane has no job ${id}`);
    return job;
  }

  /**
   * The swarm finishes a job and writes its work record: the real record of job e70c56ce with
   * this job's id, kind, objective, state and agents. The record is canonical JSON with no
   * trailing newline, and its hash is listed by `GET /jobs/:id/records` as `queued`.
   */
  finishJob(
    id: string,
    fields: { state?: string; kind?: string; agentIds?: string[]; objective?: string } = {},
  ): { hash: Hex; bytes: Uint8Array } {
    const job = this.job(id);
    const state = fields.state ?? "completed";
    const signals = (fields.agentIds ?? ["52715"]).map((agentId) => ({
      ...(RECORD_TEMPLATE.signals as Record<string, unknown>[])[0],
      agentId,
    }));
    const previous = job.records[0]?.hash ?? "0".repeat(64);
    const document = {
      ...RECORD_TEMPLATE,
      jobId: id,
      projectId: id,
      kind: fields.kind ?? job.template,
      objective: fields.objective ?? job.objective,
      state,
      signals,
      previousHash: previous,
    };
    const bytes = stringToBytes(canonicalize(document));
    const hash = keccak256(bytes);
    this.records.set(hash.slice(2), bytes);
    job.state = state;
    job.blockedReason = state === "blocked" ? "verification rejected the work" : null;
    job.records.unshift({ hash: hash.slice(2), status: "queued", txHash: null });
    return { hash, bytes };
  }

  /** The receipt writer writes: the job's newest record hash goes into the WorkRegistry. */
  async writeReceipt(id: string): Promise<Hex> {
    const job = this.job(id);
    const newest = job.records[0];
    if (!newest) throw new Error(`job ${id} has no record to write a receipt for`);
    const tx = await this.node.wallet(WHO.writer).writeContract({
      address: MAINNET.WORK_REGISTRY,
      abi: this.#registryAbi,
      functionName: "record",
      args: [uuidToBytes16(id), `0x${newest.hash}`, `${this.url}/work-records/${newest.hash}.json`],
      account: WHO.writer.account,
      chain: mainnet,
    });
    const receipt = await this.node.public.waitForTransactionReceipt({ hash: tx });
    if (receipt.status !== "success") throw new Error("the receipt could not be written");
    newest.status = "sent";
    newest.txHash = tx;
    return tx;
  }

  /** The paid orders a wallet's token has made, for assertions. */
  ordersOf(payer: Address): PaidOrder[] {
    return [...this.#orders.values()].filter((o) => o.payer?.toLowerCase() === payer.toLowerCase());
  }

  // -------------------------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------------------------

  protected override async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? "").split("?")[0] ?? "";
    const method = request.method ?? "GET";
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };
    if (this.down) return json(503, { error: "unavailable" });
    if (method === "POST") this.posts.push(path);
    try {
      if (method === "GET" && path === "/requests/capabilities") return json(200, this.#capabilities());
      if (method === "POST" && path === "/requests/check") {
        const body = JSON.parse(await readBody(request)) as { action: string; input: unknown };
        this.checks.push(body);
        // What the live preflight answered for a header-carrying objective on 11 October 2026:
        // no blockers, and a `kind` that is not a work-record kind.
        return json(200, { action: body.action, blockers: [], suggestions: [], kind: "report" });
      }
      if (method === "POST" && path === "/requests/quote") {
        const answer = this.#quote(this.#token(request), JSON.parse(await readBody(request)));
        return json(answer.created ? 201 : 200, answer);
      }
      const submit = /^\/requests\/([0-9a-f-]{36})\/submit$/.exec(path);
      if (method === "POST" && submit) {
        const order = this.#orderFor(this.#token(request), submit[1] as string);
        const header = request.headers["payment-signature"];
        const body = await readBody(request);
        if (order.status === "paid") return json(200, this.#status(order));
        if (this.#now() >= order.quote.expiresAt) throw new Refusal(410, { error: "quote_expired" });
        if (typeof header !== "string") {
          const challenge = this.#challenge(order);
          return json(402, challenge, {
            "payment-required": Buffer.from(
              JSON.stringify({ x402Version: 2, resource: challenge.resource, accepts: challenge.accepts }),
            ).toString("base64"),
          });
        }
        await this.#pay(order, header, body);
        return json(200, this.#status(order));
      }
      const paidBy = /^\/requests\/paid-by\/(0x[0-9a-fA-F]{40})$/.exec(path);
      if (method === "GET" && paidBy) {
        const orders = this.ordersOf(paidBy[1] as Address).reverse();
        return json(200, {
          payer: (paidBy[1] as string).toLowerCase(),
          count: orders.length,
          orders: orders.map((o) => ({
            orderId: o.id,
            action: "job.open",
            status: "admitted",
            createdAt: o.createdAt,
            paidAt: o.paidAt,
            payment: { status: "confirmed", transactionHash: o.paymentTx, reason: null },
            result: {
              kind: "job",
              jobId: o.jobId,
              statusUrl: `/jobs/${o.jobId}`,
              resultUrl: `/jobs/${o.jobId}/result`,
            },
          })),
        });
      }
      const status = /^\/requests\/([0-9a-f-]{36})$/.exec(path);
      if (method === "GET" && status) {
        return json(200, this.#status(this.#orderFor(this.#token(request), status[1] as string)));
      }
      const records = /^\/jobs\/([0-9a-f-]{36})\/records$/.exec(path);
      if (method === "GET" && records) {
        const job = this.jobs.get(records[1] as string);
        if (!job) throw new Refusal(404, { error: "job_not_found" });
        return json(200, {
          records: job.records.map((r) => ({
            id: job.id,
            hash: r.hash,
            chainId: 1,
            registry: MAINNET.WORK_REGISTRY.toLowerCase(),
            status: r.status,
            txHash: r.txHash,
            failure: null,
          })),
          oracleBatches: [],
        });
      }
      const job = /^\/jobs\/([0-9a-f-]{36})$/.exec(path);
      if (method === "GET" && job) {
        const found = this.jobs.get(job[1] as string);
        if (!found) throw new Refusal(404, { error: "job_not_found" });
        return json(200, {
          id: found.id,
          state: found.state,
          template: found.template,
          objective: found.objective,
          blockedReason: found.blockedReason,
          createdAt: "2026-10-13T00:00:00.000Z",
          updatedAt: "2026-10-13T00:00:00.000Z",
          paidBy: found.paidBy === null ? null : found.paidBy.toLowerCase(),
        });
      }
      const record = /^\/work-records\/([0-9a-f]{64})\.json$/.exec(path);
      if (method === "GET" && record) {
        const bytes = this.records.get(record[1] as string);
        if (!bytes) throw new Refusal(404, { error: "unknown_record" });
        // Served byte for byte, with no trailing newline.
        response.writeHead(200, { "content-type": "application/json" });
        response.end(Buffer.from(bytes));
        return;
      }
    } catch (error) {
      if (error instanceof Refusal) {
        if (path.endsWith("/submit")) this.refusals.push(String(error.body.error));
        return json(error.status, error.body);
      }
      return json(500, {
        error: "stand_in_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return super.route(request, response);
  }

  #token(request: IncomingMessage): string {
    const header = request.headers.authorization;
    const token = typeof header === "string" ? /^Bearer ([0-9a-f]{64})$/.exec(header)?.[1] : undefined;
    if (token === undefined) throw new Refusal(401, { error: "request_token_required" });
    return token;
  }

  #orderFor(token: string, id: string): PaidOrder {
    const order = this.#orders.get(id);
    // An order read with another token than the one it was made with does not exist.
    if (!order || order.token !== token) throw new Refusal(404, { error: "order_not_found" });
    return order;
  }

  #payment(): Record<string, unknown> {
    return {
      network: "eip155:1",
      asset: MAINNET.IMD.toLowerCase(),
      amount: this.price.toString(),
      payTo: MAINNET.FEE_PAYEE.toLowerCase(),
      decimals: 18,
    };
  }

  #capabilities(): Record<string, unknown> {
    const policy = (action: string) => ({
      action,
      version: `${action.split(".")[0]}-1`,
      payment: this.#payment(),
      quoteTtlSeconds: 600,
    });
    return {
      actions: [policy("job.open"), policy("oracle.request")],
      limits: {},
      authentication: { scheme: "bearer" },
      payment: { x402Version: 2, scheme: "exact", assetTransferMethod: "permit2", quoteApproval: "eip712" },
    };
  }

  #quote(token: string, body: { requestKey?: string; action?: string; input?: Record<string, unknown> }) {
    if (body.action !== "job.open") throw new Refusal(400, { error: "action_not_enabled" });
    const input = body.input;
    const objective = input?.objective;
    if (typeof body.requestKey !== "string" || input === undefined) {
      throw new Refusal(400, { error: "invalid_request", detail: "requestKey and input are required" });
    }
    if (typeof objective !== "string" || objective.length === 0 || objective.length > 8000) {
      throw new Refusal(422, { error: "invalid_input", detail: "objective must be 1 to 8,000 characters" });
    }
    if (typeof input.skill !== "string" && typeof input.template !== "string") {
      throw new Refusal(422, { error: "invalid_input", detail: "a job names a skill or a template" });
    }
    const existing = [...this.#orders.values()].find(
      (o) => o.token === token && o.requestKey === body.requestKey,
    );
    if (existing) {
      if (canon(existing.input) !== canon(input)) throw new Refusal(409, { error: "request_key_conflict" });
      return { created: false, order: this.#orderDocument(existing) };
    }
    const id = randomUUID();
    const now = this.#now();
    const unsigned = {
      v: 1,
      id,
      action: "job.open",
      policyVersion: "job-1",
      inputHash: sha256Hex(canon(input)),
      issuedAt: now,
      expiresAt: now + 600,
      payment: { ...this.#payment(), scheme: "exact" },
      terms: { purchase: "action-admission", resultGuaranteed: false },
    };
    const order: PaidOrder = {
      id,
      token,
      requestKey: body.requestKey,
      status: "quoted",
      quote: { ...unsigned, quoteHash: sha256Hex(canon(unsigned)) },
      // The plane prepares the input exactly as it was sent.
      input,
      createdAt: new Date(now * 1000).toISOString(),
      paidAt: null,
      payer: null,
      paymentTx: null,
      jobId: null,
    };
    this.#orders.set(id, order);
    return { created: true, order: this.#orderDocument(order) };
  }

  #orderDocument(order: PaidOrder): Record<string, unknown> {
    const expired = order.status === "quoted" && this.#now() >= order.quote.expiresAt;
    return {
      id: order.id,
      requestKey: order.requestKey,
      status: expired ? "expired" : order.status,
      quote: order.quote,
      inputJson: JSON.stringify(order.input),
      createdAt: order.createdAt,
      paidAt: order.paidAt,
    };
  }

  #resourceUrl(order: PaidOrder): string {
    return `${this.url}/requests/${order.id}/submit`;
  }

  #challenge(order: PaidOrder) {
    const resourceUrl = this.#resourceUrl(order);
    return {
      x402Version: 2,
      resource: { url: resourceUrl, description: "IMD paid request: job.open", mimeType: "application/json" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:1",
          asset: MAINNET.IMD.toLowerCase(),
          amount: this.price.toString(),
          payTo: MAINNET.FEE_PAYEE.toLowerCase(),
          maxTimeoutSeconds: this.maxTimeoutSeconds,
          extra: { assetTransferMethod: "permit2" },
        },
      ],
      quote: order.quote,
      requesterScopeHash: sha256Hex(order.token),
      resourceUrl,
      input: order.input,
    };
  }

  /** The paying submit: both signatures checked as the guide describes, then the fee moved. */
  async #pay(order: PaidOrder, header: string, body: string): Promise<void> {
    const challenge = this.#challenge(order);
    const accepted = challenge.accepts[0];
    let payment: Record<string, unknown>;
    try {
      payment = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new Refusal(400, {
        error: "invalid_payment_shape",
        detail: "PAYMENT-SIGNATURE is not base64 JSON",
      });
    }
    // Parsed strictly: a key that is not listed, at any depth, is refused.
    const strict = (value: unknown, allowed: string[], where: string) => {
      if (typeof value !== "object" || value === null) {
        throw new Refusal(400, { error: "invalid_payment_shape", detail: `${where} is not an object` });
      }
      for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
          throw new Refusal(400, { error: "invalid_payment_shape", detail: `${where}.${key}` });
        }
      }
    };
    strict(payment, ["x402Version", "resource", "accepted", "payload", "extensions"], "payment");
    if (payment.extensions !== undefined && Object.keys(payment.extensions as object).length > 0) {
      throw new Refusal(400, { error: "invalid_payment_shape", detail: "payment.extensions" });
    }
    if (payment.x402Version !== 2)
      throw new Refusal(400, { error: "invalid_payment_shape", detail: "x402Version" });
    if (payment.resource !== undefined) {
      strict(payment.resource, ["url", "description", "mimeType"], "payment.resource");
      if ((payment.resource as { url?: string }).url !== challenge.resourceUrl) {
        throw new Refusal(400, { error: "payment_terms_mismatch", detail: "resource.url" });
      }
    }
    if (canon(payment.accepted) !== canon(accepted)) {
      throw new Refusal(400, { error: "payment_terms_mismatch", detail: "accepted is not accepts[0]" });
    }
    const payload = payment.payload as {
      signature?: Hex;
      permit2Authorization?: {
        from: string;
        permitted: { token: string; amount: string };
        spender: string;
        nonce: string;
        deadline: string;
        witness: { to: string; validAfter: string };
      };
    };
    strict(payload, ["signature", "permit2Authorization"], "payment.payload");
    const auth = payload.permit2Authorization;
    if (auth === undefined || payload.signature === undefined) {
      throw new Refusal(400, { error: "invalid_payment_shape", detail: "payment.payload" });
    }
    strict(auth, ["from", "permitted", "spender", "nonce", "deadline", "witness"], "permit2Authorization");
    strict(auth.permitted, ["token", "amount"], "permitted");
    strict(auth.witness, ["to", "validAfter"], "witness");

    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (
      !same(auth.permitted.token, MAINNET.IMD) ||
      auth.permitted.amount !== this.price.toString() ||
      !same(auth.spender, OFFCHAIN.X402_EXACT_PERMIT2_PROXY) ||
      !same(auth.witness.to, MAINNET.FEE_PAYEE) ||
      auth.witness.validAfter !== "0"
    ) {
      throw new Refusal(400, { error: "payment_terms_mismatch", detail: "permit2Authorization" });
    }
    // The payment window must end before the quote does, and must not have ended already.
    const deadline = Number(auth.deadline);
    if (!(deadline > this.#now()) || !(deadline < order.quote.expiresAt)) {
      throw new Refusal(400, { error: "invalid_payment_window" });
    }

    // Signature one: the Permit2 payment, in Permit2's own domain.
    const payer = await recoverTypedDataAddress({
      domain: { name: "Permit2", chainId: 1, verifyingContract: MAINNET.PERMIT2 },
      types: PERMIT2_TYPES,
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: getAddress(auth.permitted.token), amount: BigInt(auth.permitted.amount) },
        spender: getAddress(auth.spender),
        nonce: BigInt(auth.nonce),
        deadline: BigInt(auth.deadline),
        witness: { to: getAddress(auth.witness.to), validAfter: 0n },
      },
      signature: payload.signature,
    });
    if (!same(payer, auth.from)) {
      throw new Refusal(402, { error: "payment_rejected", reason: "invalid_signature" });
    }

    // Signature two: the quote approval, by the same wallet, over this exact payment.
    let quoteSignature: unknown;
    try {
      quoteSignature = (JSON.parse(body) as { quoteSignature?: unknown }).quoteSignature;
    } catch {
      quoteSignature = undefined;
    }
    if (typeof quoteSignature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(quoteSignature)) {
      throw new Refusal(400, { error: "invalid_quote_approval", detail: "quoteSignature is 0x and 130 hex" });
    }
    const quote = order.quote as unknown as {
      id: string;
      action: string;
      quoteHash: string;
      expiresAt: number;
      payment: { asset: string; amount: string; payTo: string; network: string };
    };
    const approver = await recoverTypedDataAddress({
      domain: {
        name: "IdentityMD Paid Action",
        version: "1",
        chainId: Number(quote.payment.network.slice(7)),
      },
      types: QUOTE_APPROVAL_TYPES,
      primaryType: "QuoteApproval",
      message: {
        resource: challenge.resourceUrl,
        requesterScopeHash: `0x${challenge.requesterScopeHash}`,
        quoteId: quote.id,
        quoteHash: `0x${quote.quoteHash}`,
        paymentHash: `0x${sha256Hex(canon(payment))}`,
        action: quote.action,
        asset: getAddress(quote.payment.asset),
        amount: BigInt(quote.payment.amount),
        payTo: getAddress(quote.payment.payTo),
        expiresAt: BigInt(quote.expiresAt),
      },
      signature: quoteSignature as Hex,
    });
    if (!same(approver, payer)) throw new Refusal(400, { error: "invalid_quote_approval" });

    // The settlement, as Permit2 would make it: out of the payer's allowance to Permit2.
    const tx = await this.#settle(getAddress(payer), this.price);
    order.status = "paid";
    order.payer = getAddress(payer);
    order.paymentTx = tx;
    order.paidAt = new Date(this.#now() * 1000).toISOString();
    // Admission: the job exists from here on, under the template the input names.
    const input = order.input;
    const template = typeof input.skill === "string" ? `skill:${input.skill}` : (input.template as string);
    const job = this.openJob({ objective: input.objective as string, template, paidBy: order.payer });
    order.jobId = job.id;
    this.payments.push({ orderId: order.id, payer: order.payer, amount: this.price, tx, jobId: job.id });
  }

  /** Moves the fee from the payer to IdentityMD's payee, as Permit2, on the local node. */
  async #settle(payer: Address, amount: bigint): Promise<Hex> {
    const node = this.node;
    await node.rpc("anvil_impersonateAccount", [MAINNET.PERMIT2]);
    await node.setBalance(MAINNET.PERMIT2, 10n ** 18n);
    try {
      const data = encodeFunctionData({
        abi: this.#imdAbi,
        functionName: "transferFrom",
        args: [payer, MAINNET.FEE_PAYEE, amount],
      });
      let tx: Hex;
      try {
        tx = (await node.rpc("eth_sendTransaction", [
          { from: MAINNET.PERMIT2, to: MAINNET.IMD, data, gas: "0x30d40" },
        ])) as Hex;
      } catch {
        throw new Refusal(402, { error: "payment_rejected", reason: "insufficient_funds" });
      }
      const receipt = await node.public.waitForTransactionReceipt({ hash: tx });
      if (receipt.status !== "success") {
        throw new Refusal(402, { error: "payment_rejected", reason: "insufficient_funds" });
      }
      return tx;
    } finally {
      await node.rpc("anvil_stopImpersonatingAccount", [MAINNET.PERMIT2]);
    }
  }

  #status(order: PaidOrder): Record<string, unknown> {
    if (order.status !== "paid") {
      const expired = this.#now() >= order.quote.expiresAt;
      return {
        status: expired ? "expired" : "quoted",
        order: this.#orderDocument(order),
        payment: null,
        admission: null,
      };
    }
    return {
      status: "admitted",
      order: this.#orderDocument(order),
      payment: { status: "confirmed", paid: true, transactionHash: order.paymentTx },
      admission: {
        action: "job.open",
        result: {
          kind: "job",
          jobId: order.jobId,
          launch: false,
          statusUrl: `/jobs/${order.jobId}`,
          resultUrl: `/jobs/${order.jobId}/result`,
        },
      },
    };
  }
}
