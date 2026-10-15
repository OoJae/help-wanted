/**
 * Buying one swarm job from IdentityMD: quote, challenge, two signatures, submit, poll.
 *
 * The flow is the one in IdentityMD's API guide ("How paying works") and `GET /openapi.json`, with
 * `@x402/core` and `@x402/evm` at exactly 2.28.0 (the versions the control plane pins):
 *
 *   1. POST /requests/quote {requestKey, action, input}        a priced order, nothing charged
 *   2. POST /requests/:id/submit (no body)                     402 with the x402 challenge
 *   3. sign the Permit2 payment (x402 "exact", assetTransferMethod permit2)
 *   4. sign the EIP-712 QuoteApproval over that exact payment
 *   5. POST /requests/:id/submit with PAYMENT-SIGNATURE and {quoteSignature}
 *   6. GET /requests/:id until `admitted`; read `admission.result.jobId`
 *
 * The payment buys admission only. It is never refunded, whatever happens to the job. So every step
 * before a signature is a check, and each check is a named function with its own tests:
 *
 * - `checkQuote`: the price, token, recipient, network and lifetime are what the runner agreed to.
 * - `checkPreparedInput`: the input the server saved is the input that was sent: the objective
 *   byte for byte, and every other field with the value it was sent with. The guide says the
 *   prepared input "may differ from the original input"; a job whose objective lost the order
 *   header could never be settled on the desk, and one whose skill, template or repository
 *   changed would be a job of another kind, which the desk does not pay for either.
 * - `checkChallenge`: `accepts[0]` matches the quote; the quote is the one we were given; the
 *   payment window ends before the quote does.
 * - `GuardedSigner`: what the payment library is handed. It signs only the two typed messages this
 *   flow needs, and only with the values that were checked. Whatever a library asks it to sign
 *   beyond that is refused. (The same account also signs the runner's own transactions, through
 *   the wallet client in `chain.ts`; the payment library never sees that client.)
 * - `checkPayment`: the payload the x402 library produced says what was checked, has no field the
 *   server would refuse, and its signature verifies.
 *
 * WHAT IS VERIFIED AND HOW. No real payment has been made with this code: that needs a funded key.
 * The request and response shapes come from the published guide and OpenAPI document; the Permit2
 * payload and its typed data come from reading and running `@x402/evm@2.28.0`; the fixtures under
 * `test/fixtures` are built by hand from those documents, not recorded. The first live run should be
 * watched, and its challenge saved as a fixture.
 */
import { createHash } from "node:crypto";
import { x402Client } from "@x402/core/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import {
  getAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type LocalAccount,
  type TypedDataDomain,
} from "viem";
import {
  MAINNET,
  OFFCHAIN,
  bytes16ToUuid,
  canonicalSha256,
  canonicalize,
  sameAddress,
  uuidToBytes16,
} from "@help-wanted/shared";
import {
  ApiErrorBody,
  Challenge,
  Quote,
  QuoteResponse,
  RequestStatus,
  type PaidAction,
  type PaymentRequirements,
} from "@help-wanted/shared/api";
import type { Logger } from "./log.js";
import type { PayState, SubmitRecord } from "./store.js";

// -------------------------------------------------------------------------------------------------
// Constants taken from the protocol
// -------------------------------------------------------------------------------------------------

/** The EIP-712 types Permit2 signs for an x402 "exact" payment (`permit2WitnessTypes` in @x402/evm). */
export const PERMIT2_WITNESS_TYPES = {
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

/** `x-imd-quote-approval.types` in the OpenAPI document. */
export const QUOTE_APPROVAL_TYPES = {
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

export const QUOTE_APPROVAL_DOMAIN_NAME = "IdentityMD Paid Action" as const;
export const QUOTE_APPROVAL_DOMAIN_VERSION = "1" as const;
export const PERMIT2_DOMAIN_NAME = "Permit2" as const;

// -------------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------------

export type PayErrorCode =
  // a check of ours refused to go on
  | "quote_mismatch"
  | "quote_expiring"
  | "prepared_input_not_object"
  | "prepared_objective_lost_header"
  | "prepared_objective_changed"
  | "prepared_input_changed"
  | "prepared_input_unexpected_field"
  | "challenge_mismatch"
  | "challenge_window"
  | "payment_shape"
  | "payment_mismatch"
  | "sign_refused"
  | "cap_exceeded"
  | "live_payment_outstanding"
  // the protocol refused
  | "input_refused"
  | "protocol_refused"
  | "payment_rejected"
  | "payment_failed"
  | "admission_refused"
  | "unexpected_response";

/** Whether the swarm's fee was taken when the error was raised. */
export type Charged = "no" | "maybe" | "yes";

export class PayError extends Error {
  readonly code: PayErrorCode;
  readonly charged: Charged;
  readonly detail: string | undefined;

  constructor(code: PayErrorCode, message: string, charged: Charged = "no", detail?: string) {
    super(`${code}: ${message}`);
    this.name = "PayError";
    this.code = code;
    this.charged = charged;
    this.detail = detail;
  }
}

// -------------------------------------------------------------------------------------------------
// Terms and checks
// -------------------------------------------------------------------------------------------------

/** What the runner agreed to before it asked for a quote. Nothing in a response can widen it. */
export interface PayTerms {
  action: PaidAction;
  chainId: number;
  /** The token the fee is paid in: IMD. */
  asset: Address;
  /** Where the fee goes: IdentityMD's payee. */
  payTo: Address;
  /** The most this one request may cost, in atomic units. */
  maxAmount: bigint;
  /** The wallet that pays. */
  payer: Address;
  /** `https://api.imd.fun`, without a trailing slash. */
  apiBase: string;
  /** How many seconds a quote must still have left when a payment is signed. */
  minQuoteHeadroom: number;
}

export function mainnetTerms(payer: Address, maxAmount: bigint, apiBase: string): PayTerms {
  return {
    action: "job.open",
    chainId: 1,
    asset: MAINNET.IMD,
    payTo: MAINNET.FEE_PAYEE,
    maxAmount,
    payer,
    apiBase: apiBase.replace(/\/+$/, ""),
    minQuoteHeadroom: 30,
  };
}

function network(terms: PayTerms): string {
  return `eip155:${terms.chainId}`;
}

/** The address of a paid order: where its status is read, and what IdentityMD names as the x402 resource. */
export function requestUrl(terms: PayTerms, requestId: string): string {
  return `${terms.apiBase}/requests/${requestId}`;
}

/** The submit URL of a paid order: where the challenge is asked for and the paying request is sent. */
export function submitUrl(terms: PayTerms, requestId: string): string {
  return `${terms.apiBase}/requests/${requestId}/submit`;
}

/**
 * Check 1: the quote. The price, the token, the recipient and the network must be the ones the
 * runner agreed to, and the quote must still be alive long enough to pay it.
 */
export function checkQuote(quote: Quote, requestId: string, terms: PayTerms, now: number): bigint {
  const fail = (what: string): never => {
    throw new PayError("quote_mismatch", what);
  };
  if (quote.id !== requestId) fail(`the quote is for order ${quote.id}, not ${requestId}`);
  if (quote.action !== terms.action) fail(`the quote is for ${quote.action}, not ${terms.action}`);
  if (quote.payment.network !== network(terms)) fail(`the quote is on ${quote.payment.network}`);
  if (!sameAddress(quote.payment.asset, terms.asset)) fail(`the quote is priced in ${quote.payment.asset}`);
  if (!sameAddress(quote.payment.payTo, terms.payTo)) fail(`the quote pays ${quote.payment.payTo}`);
  if (quote.payment.decimals !== 18) fail(`the quote states ${quote.payment.decimals} decimals`);
  const amount = BigInt(quote.payment.amount);
  if (amount <= 0n) fail("the quote asks for nothing");
  if (amount > terms.maxAmount) fail(`the quote asks ${amount}, above the limit of ${terms.maxAmount}`);
  if (quote.runs !== undefined && quote.runs !== 1) fail(`the quote is for ${quote.runs} runs`);
  if (quote.payer !== undefined && !sameAddress(quote.payer, terms.payer))
    fail(`the quote names payer ${quote.payer}`);
  if (quote.issuedAt > now + 120) fail("the quote is dated in the future");
  if (quote.expiresAt <= now + terms.minQuoteHeadroom) {
    throw new PayError(
      "quote_expiring",
      `the quote expires at ${quote.expiresAt}, too soon to pay at ${now}`,
    );
  }
  return amount;
}

/**
 * Fields that decide what kind of job it is, what it works on, or that turn it into a launch. A
 * prepared input may not gain one of these with a value, whatever else is tolerated.
 */
const NEVER_ADDED_FIELDS: readonly string[] = [
  "skill",
  "template",
  "steps",
  "shape",
  "repoUrl",
  "baseCommit",
  "contracts",
  "paths",
  "inputs",
  "outputs",
  "onchain",
  "launch",
  "launchKind",
  "parentJobId",
  "projectId",
  "owner",
  "economics",
  "chainId",
  "pairWith",
];

/** Deep equality of two JSON values; object keys may come in any order. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((k) => k in y && sameValue(x[k], y[k]));
}

/** A value that says nothing: what a server writes for a default it did not fill in. */
function isInert(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

/** What the prepared input is compared with. A `PayJob` has all three. */
export interface ExpectedInput {
  /** The 85-byte order header. */
  header: string;
  /** `header ‖ spec`. */
  objective: string;
  /** The whole input that was sent, objective included. */
  input: Readonly<Record<string, unknown>>;
}

/**
 * Check 2: the prepared input. The server may rewrite an input before it prices it. The job is
 * worth paying for only if it is still the job that was asked for:
 *
 * - its objective is exactly the order header followed by the spec;
 * - every field that was sent is there with the value it was sent with (`skill` or `template`
 *   decide the record's kind, and the desk pays only for the order's kind; `repoUrl` and
 *   `baseCommit` decide what is audited);
 * - a field that was not sent is tolerated only when it holds nothing (null, false, empty), or
 *   when the operator listed it in `extraKeys` as a default the protocol fills in. A field that
 *   decides the kind of job, its source or makes it a launch is never tolerated with a value.
 */
export function checkPreparedInput(
  input: unknown,
  expected: ExpectedInput,
  extraKeys: readonly string[] = [],
): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PayError("prepared_input_not_object", "the prepared input is not an object");
  }
  const record = input as Record<string, unknown>;
  const objective = record.objective;
  if (typeof objective !== "string" || !objective.startsWith(expected.header)) {
    throw new PayError(
      "prepared_objective_lost_header",
      "the prepared objective does not start with the order header",
    );
  }
  if (objective !== expected.objective) {
    throw new PayError(
      "prepared_objective_changed",
      "the prepared objective is not the header followed by the spec",
    );
  }
  for (const [key, sent] of Object.entries(expected.input)) {
    if (key === "objective") continue;
    if (!(key in record)) {
      throw new PayError("prepared_input_changed", `the prepared input lost "${key}"`);
    }
    if (!sameValue(record[key], sent)) {
      throw new PayError("prepared_input_changed", `the prepared input's "${key}" is not what was sent`);
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key in expected.input || isInert(value)) continue;
    if (NEVER_ADDED_FIELDS.includes(key) || !extraKeys.includes(key)) {
      throw new PayError(
        "prepared_input_unexpected_field",
        `the prepared input carries "${key}", which was not sent`,
      );
    }
  }
}

/** Seconds allowed between checking a challenge and the payment library reading the clock. */
export const SIGNING_SLACK_SECONDS = 5;

function decodeBase64Json(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

/**
 * Check 3: the challenge. Returns `accepts[0]`, the only payment option the runner will take.
 *
 * `paymentRequiredHeader` is the `PAYMENT-REQUIRED` response header when the server sent one; it
 * must say the same as the JSON body.
 */
export function checkChallenge(
  challenge: Challenge,
  known: { requestId: string; quote: Quote },
  terms: PayTerms,
  expected: ExpectedInput,
  now: number,
  paymentRequiredHeader?: string | null,
  extraKeys: readonly string[] = [],
): PaymentRequirements {
  const fail = (what: string): never => {
    throw new PayError("challenge_mismatch", what);
  };
  if (canonicalize(challenge.quote) !== canonicalize(known.quote))
    fail("the challenge carries another quote");
  // The challenge must be for this order and no other. IdentityMD names the order itself as the
  // resource (`<api>/requests/<id>`, seen live on 13 October 2026); the address the paying request
  // goes to (`<api>/requests/<id>/submit`) is accepted as well. Both name this order on this API.
  const named = [requestUrl(terms, known.requestId), submitUrl(terms, known.requestId)];
  if (!named.includes(challenge.resourceUrl)) fail(`the challenge is for ${challenge.resourceUrl}`);
  if (!named.includes(challenge.resource.url)) fail(`the challenge's resource is ${challenge.resource.url}`);

  const req = challenge.accepts[0];
  if (req === undefined) return fail("the challenge offers no way to pay");
  if (req.scheme !== "exact") fail(`accepts[0] uses scheme ${req.scheme}`);
  if (req.network !== network(terms)) fail(`accepts[0] is on ${req.network}`);
  if (!sameAddress(req.asset, terms.asset)) fail(`accepts[0] is priced in ${req.asset}`);
  if (!sameAddress(req.payTo, terms.payTo)) fail(`accepts[0] pays ${req.payTo}`);
  if (req.amount !== known.quote.payment.amount)
    fail(`accepts[0] asks ${req.amount}, the quote ${known.quote.payment.amount}`);
  if (BigInt(req.amount) > terms.maxAmount) fail(`accepts[0] asks ${req.amount}, above the limit`);
  const extra = req.extra ?? {};
  if (extra.assetTransferMethod !== "permit2") fail(`accepts[0] does not use permit2`);
  if (extra.paymentFlow !== undefined) fail(`accepts[0] names a payment flow`);

  if (paymentRequiredHeader) {
    let decoded: { x402Version?: unknown; accepts?: unknown[] };
    try {
      decoded = decodeBase64Json(paymentRequiredHeader) as typeof decoded;
    } catch {
      return fail("the PAYMENT-REQUIRED header is not base64 JSON");
    }
    if (decoded.x402Version !== 2) fail("the PAYMENT-REQUIRED header is not x402 version 2");
    const first: unknown = Array.isArray(decoded.accepts) ? decoded.accepts[0] : undefined;
    if (first === undefined || canonicalize(first) !== canonicalize(req)) {
      fail("the PAYMENT-REQUIRED header and the challenge body offer different terms");
    }
  }

  checkPreparedInput(challenge.input, expected, extraKeys);

  // The Permit2 deadline is `now + maxTimeoutSeconds`, read from the clock again when the payment
  // is made, and must fall before the quote expires. A few seconds are kept in hand for that.
  if (now + req.maxTimeoutSeconds + SIGNING_SLACK_SECONDS >= known.quote.expiresAt) {
    throw new PayError(
      "challenge_window",
      `a payment signed now would be valid until ${now + req.maxTimeoutSeconds}, not safely before the quote's ${known.quote.expiresAt}`,
    );
  }
  return req;
}

// -------------------------------------------------------------------------------------------------
// The signer
// -------------------------------------------------------------------------------------------------

interface TypedDataRequest {
  domain?: TypedDataDomain | Record<string, unknown>;
  types?: unknown;
  primaryType?: string;
  message?: unknown;
}

export interface PermitExpectation {
  chainId: number;
  token: Address;
  amount: bigint;
  payTo: Address;
  /** The signature must expire strictly before this (the quote's expiry), and after `notBefore`. */
  deadlineBefore: number;
  notBefore: number;
}

export interface ApprovalExpectation {
  chainId: number;
  message: QuoteApprovalMessage;
}

export interface QuoteApprovalMessage {
  resource: string;
  requesterScopeHash: Hex;
  quoteId: string;
  quoteHash: Hex;
  paymentHash: Hex;
  action: string;
  asset: Address;
  amount: bigint;
  payTo: Address;
  expiresAt: bigint;
}

function refuse(what: string): never {
  throw new PayError("sign_refused", what);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * What the payment library is given in place of the account. It signs exactly two kinds of typed
 * message, each only once, and each only when it has been told beforehand what the message must say:
 *
 * - a Permit2 `PermitWitnessTransferFrom` in Permit2's own domain, for the expected token and
 *   amount, to the x402 exact proxy as spender, with the expected recipient as witness;
 * - a `QuoteApproval` in IdentityMD's domain with exactly the expected fields.
 *
 * It exposes no `signMessage`, no `signTransaction` and no raw `sign`. A library handed this object
 * cannot use the key for anything else. It is not the only holder of the account in the process:
 * the wallet client that sends the runner's own transactions holds it too (see `chain.ts`).
 */
export class GuardedSigner {
  readonly address: Address;
  readonly #account: LocalAccount;
  #permit: PermitExpectation | null = null;
  #approval: ApprovalExpectation | null = null;

  constructor(account: LocalAccount) {
    this.#account = account;
    this.address = account.address;
  }

  /** Allows one Permit2 signature with these terms. */
  expectPermit(expectation: PermitExpectation): void {
    this.#permit = expectation;
  }

  /** Allows one QuoteApproval signature with exactly this message. */
  expectApproval(expectation: ApprovalExpectation): void {
    this.#approval = expectation;
  }

  /** Withdraws any permission that was not used. */
  disarm(): void {
    this.#permit = null;
    this.#approval = null;
  }

  // An arrow property, so the method keeps its `this` when a library stores it and calls it later.
  readonly signTypedData = async (request: TypedDataRequest): Promise<Hex> => {
    if (request.primaryType === "PermitWitnessTransferFrom") return this.#signPermit(request);
    if (request.primaryType === "QuoteApproval") return this.#signApproval(request);
    return refuse(`a ${String(request.primaryType)} message is not one this runner signs`);
  };

  async #signPermit(request: TypedDataRequest): Promise<Hex> {
    const want = this.#permit;
    if (want === null) return refuse("no Permit2 payment is expected");
    this.#permit = null; // one signature per expectation, whatever happens next

    const domain = (request.domain ?? {}) as Record<string, unknown>;
    const domainKeys = Object.keys(domain).sort().join(",");
    if (domainKeys !== "chainId,name,verifyingContract")
      refuse(`unexpected Permit2 domain fields: ${domainKeys}`);
    if (domain.name !== PERMIT2_DOMAIN_NAME) refuse("the domain is not Permit2's");
    if (Number(domain.chainId) !== want.chainId) refuse(`the domain is for chain ${String(domain.chainId)}`);
    if (!sameAddress(String(domain.verifyingContract), MAINNET.PERMIT2))
      refuse("the verifying contract is not Permit2");
    if (!sameJson(request.types, PERMIT2_WITNESS_TYPES))
      refuse("the Permit2 types are not the expected ones");

    const m = request.message as {
      permitted?: { token?: unknown; amount?: unknown };
      spender?: unknown;
      nonce?: unknown;
      deadline?: unknown;
      witness?: { to?: unknown; validAfter?: unknown };
    };
    if (!sameAddress(String(m.permitted?.token), want.token)) refuse("the permit is for another token");
    if (typeof m.permitted?.amount !== "bigint" || m.permitted.amount !== want.amount) {
      refuse("the permit is for another amount");
    }
    if (!sameAddress(String(m.spender), OFFCHAIN.X402_EXACT_PERMIT2_PROXY)) {
      refuse("the permit's spender is not the x402 exact proxy");
    }
    if (!sameAddress(String(m.witness?.to), want.payTo)) refuse("the permit pays another recipient");
    if (m.witness?.validAfter !== 0n) refuse("the permit is not valid from now");
    if (typeof m.nonce !== "bigint" || m.nonce < 0n) refuse("the permit has no nonce");
    if (typeof m.deadline !== "bigint") return refuse("the permit has no deadline");
    if (m.deadline <= BigInt(want.notBefore)) refuse("the permit is already expired");
    if (m.deadline >= BigInt(want.deadlineBefore)) refuse("the permit outlives the quote");

    return this.#account.signTypedData({
      domain: { name: PERMIT2_DOMAIN_NAME, chainId: want.chainId, verifyingContract: MAINNET.PERMIT2 },
      types: PERMIT2_WITNESS_TYPES,
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: getAddress(want.token), amount: want.amount },
        spender: OFFCHAIN.X402_EXACT_PERMIT2_PROXY,
        nonce: m.nonce as bigint,
        deadline: m.deadline,
        witness: { to: getAddress(want.payTo), validAfter: 0n },
      },
    });
  }

  async #signApproval(request: TypedDataRequest): Promise<Hex> {
    const want = this.#approval;
    if (want === null) return refuse("no quote approval is expected");
    this.#approval = null;

    const domain = (request.domain ?? {}) as Record<string, unknown>;
    const domainKeys = Object.keys(domain).sort().join(",");
    if (domainKeys !== "chainId,name,version") refuse(`unexpected approval domain fields: ${domainKeys}`);
    if (domain.name !== QUOTE_APPROVAL_DOMAIN_NAME || domain.version !== QUOTE_APPROVAL_DOMAIN_VERSION) {
      refuse("the domain is not IdentityMD Paid Action version 1");
    }
    if (Number(domain.chainId) !== want.chainId) refuse(`the domain is for chain ${String(domain.chainId)}`);
    if (!sameJson(request.types, QUOTE_APPROVAL_TYPES))
      refuse("the approval types are not the expected ones");
    const got = request.message as Record<string, unknown>;
    const expected = want.message as unknown as Record<string, unknown>;
    const keys = Object.keys(expected);
    if (Object.keys(got).sort().join(",") !== [...keys].sort().join(","))
      refuse("the approval has other fields");
    for (const key of keys) {
      if (got[key] !== expected[key]) refuse(`the approval's ${key} is not the expected one`);
    }
    return this.#account.signTypedData({
      domain: {
        name: QUOTE_APPROVAL_DOMAIN_NAME,
        version: QUOTE_APPROVAL_DOMAIN_VERSION,
        chainId: want.chainId,
      },
      types: QUOTE_APPROVAL_TYPES,
      primaryType: "QuoteApproval",
      message: want.message,
    });
  }
}

// -------------------------------------------------------------------------------------------------
// The payment and the approval
// -------------------------------------------------------------------------------------------------

/** The x402 payment payload as IdentityMD parses it: strictly, with no key beyond these. */
export interface PaymentPayload {
  x402Version: 2;
  resource?: { url: string; description?: string; mimeType?: string };
  accepted: PaymentRequirements;
  payload: {
    signature: Hex;
    permit2Authorization: {
      from: string;
      permitted: { token: string; amount: string };
      spender: string;
      nonce: string;
      deadline: string;
      witness: { to: string; validAfter: string };
    };
  };
}

function keysOf(value: unknown): string {
  return typeof value === "object" && value !== null
    ? Object.keys(value).sort().join(",")
    : "(not an object)";
}

/**
 * Check 4: the payment payload, as the server will read it. Every key is one the server allows,
 * every value is one that was agreed, and the signature really is the payer's over those values.
 */
export async function checkPayment(
  payment: unknown,
  context: { req: PaymentRequirements; challenge: Challenge; terms: PayTerms; now: number },
): Promise<PaymentPayload> {
  const shape = (what: string): never => {
    throw new PayError("payment_shape", what);
  };
  const mismatch = (what: string): never => {
    throw new PayError("payment_mismatch", what);
  };
  const { req, challenge, terms, now } = context;
  const p = payment as PaymentPayload;

  const top = keysOf(p);
  if (top !== "accepted,payload,resource,x402Version" && top !== "accepted,payload,x402Version") {
    shape(`unexpected payment fields: ${top}`);
  }
  if (p.x402Version !== 2) shape("the payment is not x402 version 2");
  if (p.resource !== undefined) {
    for (const key of Object.keys(p.resource)) {
      if (key !== "url" && key !== "description" && key !== "mimeType")
        shape(`unexpected resource field ${key}`);
    }
    if (p.resource.url !== challenge.resource.url) mismatch("the payment names another resource");
  }
  if (canonicalize(p.accepted) !== canonicalize(req)) mismatch("accepted is not the challenge's accepts[0]");
  if (keysOf(p.payload) !== "permit2Authorization,signature")
    shape(`unexpected payload fields: ${keysOf(p.payload)}`);
  const auth = p.payload.permit2Authorization;
  if (keysOf(auth) !== "deadline,from,nonce,permitted,spender,witness")
    shape(`unexpected permit fields: ${keysOf(auth)}`);
  if (keysOf(auth.permitted) !== "amount,token") shape("unexpected fields in permitted");
  if (keysOf(auth.witness) !== "to,validAfter") shape("unexpected fields in witness");
  if (!/^0x[0-9a-fA-F]{130}$/.test(p.payload.signature)) shape("the signature is not 65 bytes");
  if (!/^[0-9]+$/.test(auth.nonce) || !/^[0-9]+$/.test(auth.deadline))
    shape("nonce and deadline must be decimal");

  if (!sameAddress(auth.from, terms.payer)) mismatch("the payment is from another wallet");
  if (!sameAddress(auth.permitted.token, terms.asset)) mismatch("the payment moves another token");
  if (auth.permitted.amount !== req.amount) mismatch("the payment is for another amount");
  if (BigInt(auth.permitted.amount) > terms.maxAmount) mismatch("the payment is above the limit");
  if (!sameAddress(auth.spender, OFFCHAIN.X402_EXACT_PERMIT2_PROXY))
    mismatch("the spender is not the x402 exact proxy");
  if (!sameAddress(auth.witness.to, terms.payTo)) mismatch("the payment goes to another recipient");
  if (auth.witness.validAfter !== "0") mismatch("the payment is not valid from now");
  const deadline = Number(auth.deadline);
  if (!(deadline > now)) mismatch("the payment is already expired");
  if (!(deadline < challenge.quote.expiresAt)) mismatch("the payment outlives the quote");

  const signer = await recoverTypedDataAddress({
    domain: { name: PERMIT2_DOMAIN_NAME, chainId: terms.chainId, verifyingContract: MAINNET.PERMIT2 },
    types: PERMIT2_WITNESS_TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: getAddress(auth.permitted.token), amount: BigInt(auth.permitted.amount) },
      spender: getAddress(auth.spender),
      nonce: BigInt(auth.nonce),
      deadline: BigInt(auth.deadline),
      witness: { to: getAddress(auth.witness.to), validAfter: 0n },
    },
    signature: p.payload.signature,
  });
  if (!sameAddress(signer, terms.payer)) mismatch("the payment's signature is not the payer's");
  return p;
}

/**
 * Step 3: the Permit2 payment, made by the x402 library through the guarded signer.
 *
 * The x402 client refuses any token that is not one of its default assets unless it is listed in
 * `spendControls.allowedAssets`; IMD is listed here with this request's limit as its cap, so the
 * library enforces the limit a second time. `extensions` are dropped: the server refuses them.
 */
export async function createPayment(
  challenge: Challenge,
  req: PaymentRequirements,
  signer: GuardedSigner,
  terms: PayTerms,
  now: number,
): Promise<PaymentPayload> {
  signer.expectPermit({
    chainId: terms.chainId,
    token: terms.asset,
    amount: BigInt(req.amount),
    payTo: terms.payTo,
    notBefore: now,
    deadlineBefore: challenge.quote.expiresAt,
  });
  try {
    type Net = `${string}:${string}`;
    const requirements = { ...req, network: req.network as Net, extra: req.extra ?? {} };
    const client = x402Client.fromConfig({
      schemes: [{ network: req.network as Net, client: new ExactEvmScheme(signer) }],
      spendControls: {
        maxAmountPerPayment: false,
        allowedAssets: [
          { network: req.network as Net, asset: req.asset, maxAmountPerPayment: terms.maxAmount.toString() },
        ],
      },
    });
    const created = await client.createPaymentPayload({
      x402Version: 2,
      resource: challenge.resource,
      accepts: [requirements],
    });
    const { extensions: _dropped, ...generated } = created;
    void _dropped;
    // The round trip through JSON drops undefined fields, exactly as the header encoding will.
    const payment: unknown = JSON.parse(JSON.stringify({ ...generated, accepted: req }));
    return await checkPayment(payment, { req, challenge, terms, now });
  } finally {
    signer.disarm();
  }
}

/** `0x` + SHA-256 of the canonical JSON of the exact payment sent in `PAYMENT-SIGNATURE`. */
export function paymentHash(payment: PaymentPayload): Hex {
  return canonicalSha256(payment);
}

/** The QuoteApproval message: every field from the challenge or from the payment being sent. */
export function quoteApprovalMessage(challenge: Challenge, payment: PaymentPayload): QuoteApprovalMessage {
  const q = challenge.quote;
  return {
    resource: challenge.resourceUrl,
    requesterScopeHash: `0x${challenge.requesterScopeHash}`,
    quoteId: q.id,
    quoteHash: `0x${q.quoteHash}`,
    paymentHash: paymentHash(payment),
    action: q.action,
    asset: getAddress(q.payment.asset),
    amount: BigInt(q.payment.amount),
    payTo: getAddress(q.payment.payTo),
    expiresAt: BigInt(q.expiresAt),
  };
}

/** Step 4: the EIP-712 approval of that exact payment for this quote, by the same wallet. */
export async function signQuoteApproval(
  challenge: Challenge,
  payment: PaymentPayload,
  signer: GuardedSigner,
  terms: PayTerms,
): Promise<Hex> {
  const message = quoteApprovalMessage(challenge, payment);
  if (!sameAddress(message.asset, terms.asset) || !sameAddress(message.payTo, terms.payTo)) {
    throw new PayError("challenge_mismatch", "the approval would name another token or recipient");
  }
  if (message.amount > terms.maxAmount)
    throw new PayError("challenge_mismatch", "the approval is above the limit");
  signer.expectApproval({ chainId: terms.chainId, message });
  try {
    return await signer.signTypedData({
      domain: {
        name: QUOTE_APPROVAL_DOMAIN_NAME,
        version: QUOTE_APPROVAL_DOMAIN_VERSION,
        chainId: terms.chainId,
      },
      types: QUOTE_APPROVAL_TYPES,
      primaryType: "QuoteApproval",
      message,
    });
  } finally {
    signer.disarm();
  }
}

/**
 * The exact bytes of the paying request: URL, `PAYMENT-SIGNATURE` header and JSON body. `url` is the
 * order's submit URL. It is not taken from the challenge, whose `resourceUrl` names the order and
 * not the route the payment is sent to.
 */
export function buildSubmit(
  url: string,
  payment: PaymentPayload,
  quoteSignature: Hex,
  now: number,
): SubmitRecord {
  return {
    url,
    paymentHeader: encodePaymentSignatureHeader(
      payment as unknown as Parameters<typeof encodePaymentSignatureHeader>[0],
    ),
    body: JSON.stringify({ quoteSignature }),
    signedAt: now,
    deadline: Number(payment.payload.permit2Authorization.deadline),
    amount: payment.payload.permit2Authorization.permitted.amount,
  };
}

// -------------------------------------------------------------------------------------------------
// Request keys
// -------------------------------------------------------------------------------------------------

/** RFC 4122 version 5 UUID (SHA-1 of a namespace and a name). */
export function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(uuidToBytes16(namespace).slice(2), "hex");
  const digest = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  return bytes16ToUuid(`0x${bytes.toString("hex")}`);
}

const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const REQUEST_KEY_NAMESPACE = uuidV5("request-key.runner.help-wanted", DNS_NAMESPACE);

/**
 * The `requestKey` of a quote. It is a function of the claim and the attempt, so a retry of the same
 * attempt always reuses its key (the protocol then returns the same order) and can never open a
 * second priced order by accident. A new attempt, after an unpaid quote expired, gets a new key.
 */
export function requestKey(claim: {
  chainId: number;
  workOrders: Address;
  orderId: bigint | string;
  claimSeq: number;
  runner: Address;
  attempt: number;
  /** Which job of the claim, when it is not the first (see `PayState.series`). */
  series?: number | undefined;
}): string {
  const parts: (string | number)[] = [
    claim.chainId,
    claim.workOrders.toLowerCase(),
    String(claim.orderId),
    claim.claimSeq,
    claim.runner.toLowerCase(),
    claim.attempt,
  ];
  // The first job's keys are spelled as they always were; a later job adds its number.
  if (claim.series !== undefined) parts.push(`job${claim.series}`);
  return uuidV5(parts.join(":"), REQUEST_KEY_NAMESPACE);
}

// -------------------------------------------------------------------------------------------------
// HTTP
// -------------------------------------------------------------------------------------------------

export interface PaidRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface PaidResponse {
  status: number;
  /** Lowercase header names. */
  headers: Record<string, string>;
  text: string;
}

/** One HTTP exchange with the paid routes. Throws only when no response arrived. */
export type PaidHttp = (request: PaidRequest) => Promise<PaidResponse>;

/** `PaidHttp` over `fetch`, with a timeout and no retries: the flow decides what to send again. */
export function fetchPaidHttp(doFetch: typeof fetch = fetch, timeoutMs = 30_000): PaidHttp {
  return async (request) => {
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    };
    if (request.body !== undefined) init.body = request.body;
    const response = await doFetch(request.url, init);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, headers, text: await response.text() };
  };
}

function parseJson(text: string): unknown {
  try {
    return text.length > 0 ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function errorCode(body: unknown): { code: string; detail: string | undefined } {
  const parsed = ApiErrorBody.safeParse(body);
  if (!parsed.success) return { code: "unknown", detail: undefined };
  return { code: parsed.data.error, detail: parsed.data.detail ?? parsed.data.reason };
}

// -------------------------------------------------------------------------------------------------
// The flow
// -------------------------------------------------------------------------------------------------

export interface PayJob {
  /** Identifies the claim the job is for; the request key is derived from it. */
  claim: {
    chainId: number;
    workOrders: Address;
    orderId: bigint | string;
    claimSeq: number;
    runner: Address;
  };
  /** The 85-byte order header. */
  header: string;
  /** `header ‖ spec`. */
  objective: string;
  /** The `job.open` input, whose `objective` is the one above. */
  input: Record<string, unknown>;
}

export interface PayDeps {
  http: PaidHttp;
  /** Present in live mode only. Without it nothing can be signed and `advance` refuses to start. */
  signer: GuardedSigner | null;
  /** The paid-request Bearer token. */
  token: string;
  terms: PayTerms;
  /** Unix seconds. */
  now: () => number;
  log: Logger;
  /** Called after every change of state, before anything further is sent. */
  persist: (state: PayState) => void;
  /**
   * Reserves `amount` against the runner's caps just before a payment is signed. Returns false when
   * a cap would be exceeded; the payment is then not signed.
   */
  reserve: (amount: bigint) => boolean;
  /**
   * Gives a reservation back when it is certain the fee was not taken. `day` is the UTC day the
   * reservation was booked on, so that it is taken off that day and not off today.
   */
  release: (amount: bigint, day?: string) => void;
  /**
   * Asked once more just before a payment is signed. A reason not to pay now (the runner could not
   * send the transaction that must follow, say) leaves the payment unsigned for this pass.
   */
  mayPay?: () => Promise<string | null>;
  /**
   * Handed every 402 the protocol answers, before any check: the body as parsed and the
   * `PAYMENT-REQUIRED` header. Neither holds a secret. The command line saves them beside the
   * store, so that a check that fails on a real answer can be read and turned into a fixture.
   */
  onChallenge?: (seen: { requestId: string; body: unknown; paymentRequired: string | null }) => void;
  /** Fields the protocol may add to a prepared input with a value (see `checkPreparedInput`). */
  extraInputKeys?: readonly string[];
  /** How many quotes one claim may go through before the runner gives up. Default 4. */
  maxAttempts?: number;
}

export type PayOutcome =
  /** The job is admitted: `state.jobId` is set. */
  | { kind: "admitted"; jobId: string }
  /**
   * Nothing more to do right now; call again later. `unreadable` counts status reads in a row that
   * gave no usable answer, so the caller can look for the job another way.
   */
  | { kind: "pending"; why: string; unreadable?: number }
  /** This attempt is over. `charged` says whether the fee was taken. */
  | { kind: "failed"; code: string; charged: Charged; detail?: string };

/** What a look at the quote and the challenge, before anything is staked, came to. */
export type Precheck =
  | { ok: true }
  /** `retry`: worth asking again later (the protocol was busy), as opposed to a check that failed. */
  | { ok: false; retry: boolean; code: string; detail: string };

export function newPayState(job: PayJob, attempt = 1, series?: number): PayState {
  return {
    attempt,
    ...(series === undefined ? {} : { series }),
    requestKey: requestKey({ ...job.claim, attempt, series }),
    stage: "new",
    objective: job.objective,
  };
}

/** Protocol refusals after which the same signed bytes are worth sending again later. */
const RESEND_STATUSES = new Set([429, 500, 502, 503, 504]);
/** 409 codes that mean "a payment for this order is already under way": the status route decides. */
const PAYMENT_UNDER_WAY = new Set([
  "order_payment_already_started",
  "payment_already_reserved",
  "payment_attempt_conflict",
  "payment_not_confirmed",
  "order_not_payable",
]);
/** Order statuses that mean a payment was started for the order, whatever the age of its quote. */
const PAYMENT_STARTED = new Set(["paid", "payment_pending", "payment_failed"]);
/** Refusals of a first send after which nothing was taken and a new quote is worth asking for. */
const RETRY_AFTER_REFUSAL = new Set(["invalid_payment_window", "quote_not_yet_valid"]);

function utcDayOf(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export class PayFlow {
  readonly #deps: PayDeps;

  constructor(deps: PayDeps) {
    this.#deps = deps;
  }

  #auth(): Record<string, string> {
    return { authorization: `Bearer ${this.#deps.token}`, accept: "application/json" };
  }

  #giveBack(state: PayState): void {
    if (state.reserved === undefined) return;
    this.#deps.release(BigInt(state.reserved), state.reservedDay);
    delete state.reserved;
    delete state.reservedDay;
  }

  #fail(state: PayState, code: string, charged: Charged, detail?: string): PayOutcome {
    const { persist } = this.#deps;
    if (charged === "no") this.#giveBack(state);
    state.stage = "failed";
    state.failure =
      detail === undefined ? { code, charged } : { code, charged, detail: detail.slice(0, 300) };
    persist(state);
    return detail === undefined
      ? { kind: "failed", code, charged }
      : { kind: "failed", code, charged, detail };
  }

  /**
   * Starts the next quote after one ended with nothing taken: it expired unpaid, or its payment
   * failed or was refused. Refused while a signed payment could still be settled: two live
   * authorisations for one claim must never exist. `cause` is why the last attempt ended, for the
   * report when no attempt is left.
   */
  #requote(state: PayState, job: PayJob, cause?: { code: string; detail?: string }): PayOutcome {
    const { now, persist } = this.#deps;
    if (state.submit !== undefined && now() <= state.submit.deadline) {
      return { kind: "pending", why: "an earlier signed payment has not expired yet" };
    }
    if (state.attempt >= (this.#deps.maxAttempts ?? 4)) {
      return this.#fail(
        state,
        cause?.code ?? "protocol_refused",
        "no",
        `no quote could be paid in ${state.attempt} attempts${cause?.detail ? ` (last: ${cause.detail})` : ""}`,
      );
    }
    this.#giveBack(state);
    const next = newPayState(job, state.attempt + 1, state.series);
    for (const key of Object.keys(state) as (keyof PayState)[]) delete state[key];
    Object.assign(state, next);
    persist(state);
    return {
      kind: "pending",
      why: cause
        ? `${cause.code}; a new quote will be requested`
        : "the quote expired unpaid; a new one will be requested",
    };
  }

  /**
   * A payment that ended with nothing taken (`payment_failed`, or a first send refused for its
   * timing). The signed bytes are not sent again, and once their permit has run out a new quote
   * takes their place, while attempts remain.
   */
  #retryUncharged(state: PayState, job: PayJob, cause: { code: string; detail?: string }): PayOutcome {
    const { persist, log, now } = this.#deps;
    if (state.submit === undefined && state.quoteExpiresAt !== undefined && now() <= state.quoteExpiresAt) {
      // The payment was signed by an earlier run and its bytes are gone, so its deadline is not
      // known. It is always before the quote's expiry: until then no second payment is signed.
      return {
        kind: "pending",
        why: `${cause.code}; waiting for the earlier quote to run out before asking for another`,
      };
    }
    if (state.abandoned !== true) {
      state.abandoned = true;
      state.stage = "submitted";
      persist(state);
      log.warn("payment ended with nothing taken; a new quote follows once its permit has run out", {
        requestId: state.requestId,
        code: cause.code,
        detail: cause.detail,
        attempt: state.attempt,
      });
    }
    return this.#requote(state, job, cause);
  }

  /**
   * Takes the payment as far as it can go without waiting, and says where it stands. Safe to call
   * again at any time and after a restart: every step either reads state or repeats a request the
   * protocol treats as the same request.
   */
  async advance(state: PayState, job: PayJob): Promise<PayOutcome> {
    if (state.objective !== job.objective) {
      throw new PayError("challenge_mismatch", "the saved payment is for another objective");
    }
    for (let guard = 0; guard < 8; guard++) {
      switch (state.stage) {
        case "new": {
          const outcome = await this.#quote(state, job);
          if (outcome) return outcome;
          break;
        }
        case "quoted": {
          const outcome = await this.#challengeAndSign(state, job);
          if (outcome) return outcome;
          break;
        }
        case "signed": {
          const outcome = await this.#send(state, job);
          if (outcome) return outcome;
          break;
        }
        case "submitted":
          return this.#poll(state, job);
        case "admitted":
          if (state.jobId === undefined)
            throw new PayError("unexpected_response", "admitted without a job id", "yes");
          return { kind: "admitted", jobId: state.jobId };
        case "failed":
          return this.#failed(state);
      }
    }
    return { kind: "pending", why: "still working" };
  }

  #failed(state: PayState): PayOutcome {
    return {
      kind: "failed",
      code: state.failure?.code ?? "unknown",
      charged: state.failure?.charged ?? "maybe",
      ...(state.failure?.detail === undefined ? {} : { detail: state.failure.detail }),
    };
  }

  /**
   * Asks for the quote and the challenge and runs every check on them, and signs nothing. The
   * runner does this before it claims an order: what IdentityMD makes of the job (does the header
   * survive, is the price the expected one, does the payment window fit) is then known before a
   * bond is posted, and a refusal costs nothing. A quote is free and lasts ten minutes; the same
   * order is paid after the claim.
   */
  async precheck(state: PayState, job: PayJob): Promise<Precheck> {
    if (state.objective !== job.objective) {
      throw new PayError("challenge_mismatch", "the saved payment is for another objective");
    }
    const asPrecheck = (outcome: PayOutcome): Precheck => {
      if (outcome.kind === "pending") return { ok: false, retry: true, code: "pending", detail: outcome.why };
      if (outcome.kind === "failed") {
        return { ok: false, retry: false, code: outcome.code, detail: outcome.detail ?? outcome.code };
      }
      return { ok: true };
    };
    if (state.stage === "new") {
      const outcome = await this.#quote(state, job);
      if (outcome) return asPrecheck(outcome);
    }
    if (state.stage === "failed") return asPrecheck(this.#failed(state));
    // Anything past the quote was checked when it got there (an earlier run signed or paid).
    if (state.stage !== "quoted") return { ok: true };
    const got = await this.#fetchChallenge(state, job);
    if ("outcome" in got) return got.outcome === null ? { ok: true } : asPrecheck(got.outcome);
    return { ok: true };
  }

  /** Step 1. */
  async #quote(state: PayState, job: PayJob): Promise<PayOutcome | null> {
    const { http, terms, now, persist, log } = this.#deps;
    if (this.#deps.signer === null) throw new PayError("sign_refused", "no signer: the runner is not live");
    const body = JSON.stringify({ requestKey: state.requestKey, action: terms.action, input: job.input });
    const response = await http({
      method: "POST",
      url: `${terms.apiBase}/requests/quote`,
      headers: { ...this.#auth(), "content-type": "application/json" },
      body,
    });
    const data = parseJson(response.text);
    if (response.status === 422) {
      const { detail } = errorCode(data);
      return this.#fail(state, "input_refused", "no", detail ?? response.text.slice(0, 300));
    }
    if (RESEND_STATUSES.has(response.status))
      return { kind: "pending", why: `quote answered ${response.status}` };
    if (response.status !== 200 && response.status !== 201) {
      const { code, detail } = errorCode(data);
      return this.#fail(
        state,
        "protocol_refused",
        "no",
        `quote ${response.status} ${code}${detail ? `: ${detail}` : ""}`,
      );
    }
    const parsed = QuoteResponse.safeParse(data);
    if (!parsed.success) {
      return this.#fail(
        state,
        "unexpected_response",
        "no",
        `quote: ${parsed.error.issues[0]?.message ?? "bad shape"}`,
      );
    }
    const order = parsed.data.order;
    if (order.requestKey !== state.requestKey) {
      return this.#fail(state, "quote_mismatch", "no", "the order carries another request key");
    }
    if (PAYMENT_STARTED.has(order.status)) {
      // A payment for this order was started by an earlier run of this runner (the key is a
      // function of the claim). Whether it went through is the status route's to say, whatever the
      // age of the quote: reading it as "an unpaid quote that ran out" would buy the job twice.
      state.requestId = order.id;
      state.quoteHash = order.quote.quoteHash;
      state.quoteJson = canonicalize(order.quote);
      state.quoteExpiresAt = order.quote.expiresAt;
      state.quoteAmount = order.quote.payment.amount;
      state.stage = "submitted";
      persist(state);
      log.info("found a payment already started for this claim", {
        requestId: order.id,
        orderStatus: order.status,
      });
      return null;
    }
    if (order.status === "expired") return this.#requote(state, job);
    try {
      const amount = checkQuote(order.quote, order.id, terms, now());
      checkPreparedInput(parseJson(order.inputJson), job, this.#deps.extraInputKeys);
      state.requestId = order.id;
      state.quoteHash = order.quote.quoteHash;
      state.quoteJson = canonicalize(order.quote);
      state.quoteExpiresAt = order.quote.expiresAt;
      state.quoteAmount = amount.toString();
    } catch (error) {
      if (error instanceof PayError && error.code === "quote_expiring") return this.#requote(state, job);
      if (error instanceof PayError) return this.#fail(state, error.code, "no", error.message);
      throw error;
    }
    state.stage = "quoted";
    persist(state);
    log.info("quoted", { requestId: order.id, amount: state.quoteAmount, expiresAt: order.quote.expiresAt });
    return null;
  }

  /**
   * Step 2: asks for the challenge and checks it. `outcome: null` means the order has moved past
   * the challenge by itself (an earlier run paid, or is paying) and the state says so.
   */
  async #fetchChallenge(
    state: PayState,
    job: PayJob,
  ): Promise<{ outcome: PayOutcome | null } | { challenge: Challenge; req: PaymentRequirements }> {
    const { http, terms, now, persist } = this.#deps;
    if (state.requestId === undefined || state.quoteJson === undefined) {
      throw new PayError("unexpected_response", "quoted without an order id");
    }
    const knownQuote = Quote.parse(JSON.parse(state.quoteJson));
    const response = await http({
      method: "POST",
      url: submitUrl(terms, state.requestId),
      headers: this.#auth(),
    });
    const data = parseJson(response.text);
    if (response.status === 410) return { outcome: this.#requote(state, job) };
    if (RESEND_STATUSES.has(response.status))
      return { outcome: { kind: "pending", why: `challenge answered ${response.status}` } };
    if (response.status === 200 || response.status === 202) {
      // The order is past the challenge: it was paid, or is being paid, by an earlier run.
      state.stage = "submitted";
      persist(state);
      return { outcome: null };
    }
    if (response.status === 409) {
      const { code } = errorCode(data);
      if (code === "quote_too_close_to_expiry") return { outcome: this.#requote(state, job) };
      if (PAYMENT_UNDER_WAY.has(code)) {
        state.stage = "submitted";
        persist(state);
        return { outcome: null };
      }
    }
    if (response.status !== 402) {
      const { code, detail } = errorCode(data);
      return {
        outcome: this.#fail(
          state,
          "protocol_refused",
          "no",
          `challenge ${response.status} ${code}${detail ? `: ${detail}` : ""}`,
        ),
      };
    }
    try {
      this.#deps.onChallenge?.({
        requestId: state.requestId,
        body: data,
        paymentRequired: response.headers["payment-required"] ?? null,
      });
    } catch {
      // Keeping a copy is a convenience; failing to must not stop a payment.
    }
    const parsed = Challenge.safeParse(data);
    if (!parsed.success) {
      const { code, detail } = errorCode(data);
      if (code !== "unknown") {
        return {
          outcome: this.#fail(state, "payment_rejected", "no", `${code}${detail ? `: ${detail}` : ""}`),
        };
      }
      return {
        outcome: this.#fail(
          state,
          "unexpected_response",
          "no",
          `challenge: ${parsed.error.issues[0]?.message ?? "bad shape"}`,
        ),
      };
    }
    const challenge = parsed.data;
    try {
      const req = checkChallenge(
        challenge,
        { requestId: state.requestId, quote: knownQuote },
        terms,
        job,
        now(),
        response.headers["payment-required"] ?? null,
        this.#deps.extraInputKeys,
      );
      checkQuote(challenge.quote, state.requestId, terms, now());
      return { challenge, req };
    } catch (error) {
      if (error instanceof PayError && error.code === "quote_expiring") {
        return { outcome: this.#requote(state, job) };
      }
      if (error instanceof PayError && error.code === "challenge_window") {
        // Either this quote is nearly spent, or the protocol's payment window is as long as its
        // quotes live. A new quote settles which; `maxAttempts` bounds the second case.
        return { outcome: this.#requote(state, job, { code: error.code, detail: error.message }) };
      }
      if (error instanceof PayError) return { outcome: this.#fail(state, error.code, "no", error.message) };
      throw error;
    }
  }

  /** Steps 2, 3 and 4. Nothing is sent after the signatures until they are saved. */
  async #challengeAndSign(state: PayState, job: PayJob): Promise<PayOutcome | null> {
    const { terms, now, persist, signer, reserve, log, mayPay } = this.#deps;
    if (signer === null) throw new PayError("sign_refused", "no signer: the runner is not live");
    if (state.submit !== undefined) {
      // Never a second signature for an order that already has one.
      state.stage = "signed";
      persist(state);
      return null;
    }
    const got = await this.#fetchChallenge(state, job);
    if ("outcome" in got) return got.outcome;
    const { challenge, req } = got;

    const notNow = mayPay ? await mayPay() : null;
    if (notNow !== null) return { kind: "pending", why: `not paying yet: ${notNow}` };

    const amount = BigInt(req.amount);
    if (!reserve(amount)) {
      return this.#fail(state, "cap_exceeded", "no", "paying this job would exceed a spending cap");
    }
    state.reserved = amount.toString();
    state.reservedDay = utcDayOf(now());
    persist(state);

    try {
      const signedAt = now();
      const payment = await createPayment(challenge, req, signer, terms, signedAt);
      const quoteSignature = await signQuoteApproval(challenge, payment, signer, terms);
      if (state.requestId === undefined)
        throw new PayError("unexpected_response", "signing without an order id");
      state.submit = buildSubmit(submitUrl(terms, state.requestId), payment, quoteSignature, signedAt);
    } catch (error) {
      // Nothing was sent, so nothing can have been charged. A signature the guard refused (the
      // clock moved past the window between the check and the library reading it, say) is worth
      // one more quote; `maxAttempts` bounds a refusal that would repeat.
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof PayError ? error.code : "sign_refused";
      this.#giveBack(state);
      persist(state);
      return this.#requote(state, job, { code, detail: message });
    }
    state.stage = "signed";
    persist(state); // saved before a single byte is sent
    log.info("payment signed", {
      requestId: state.requestId,
      amount: state.submit.amount,
      deadline: state.submit.deadline,
    });
    return null;
  }

  /** Step 5. Sends the saved bytes; sends the same bytes again if the answer was lost. */
  async #send(state: PayState, job: PayJob): Promise<PayOutcome | null> {
    const { http, persist, now, log } = this.#deps;
    const submit = state.submit;
    if (submit === undefined) throw new PayError("unexpected_response", "signed without saved bytes");
    // The saved bytes carry the token and a signed payment: they go to this order's own URL on the
    // configured API and nowhere else, whatever the store file says.
    if (state.requestId === undefined || submit.url !== submitUrl(this.#deps.terms, state.requestId)) {
      return this.#fail(
        state,
        "challenge_mismatch",
        "maybe",
        "the saved request is addressed to another URL",
      );
    }
    if (now() > submit.deadline || state.abandoned === true) {
      // Too late for these bytes to be settled if they were never received; the status route knows.
      state.stage = "submitted";
      persist(state);
      return null;
    }
    // Counted and saved before the bytes leave: an answer to anything but the first send cannot
    // tell whether an earlier copy was received.
    const sends = (state.sends ?? 0) + 1;
    state.sends = sends;
    persist(state);
    let response: PaidResponse;
    try {
      response = await http({
        method: "POST",
        url: submit.url,
        headers: {
          ...this.#auth(),
          "content-type": "application/json",
          "payment-signature": submit.paymentHeader,
        },
        body: submit.body,
      });
    } catch (error) {
      log.warn("submit got no answer; the same bytes will be sent again", { error });
      return { kind: "pending", why: "the paying request got no answer" };
    }
    const data = parseJson(response.text);
    if (response.status === 200 || response.status === 202) {
      state.stage = "submitted";
      persist(state);
      return null;
    }
    if (RESEND_STATUSES.has(response.status))
      return { kind: "pending", why: `submit answered ${response.status}` };
    const { code, detail } = errorCode(data);
    if (response.status === 409 && PAYMENT_UNDER_WAY.has(code)) {
      state.stage = "submitted";
      persist(state);
      return null;
    }
    if (sends > 1) {
      // A refusal of a resend says nothing about the first copy: if that one was received and
      // settled, a duplicate is refused because the payment is spent. Only the status route knows.
      log.warn("a resend of the paying request was refused; asking the status route what happened", {
        requestId: state.requestId,
        http: response.status,
        code,
      });
      state.stage = "submitted";
      persist(state);
      return null;
    }
    const said = `${code}${detail ? `: ${detail}` : ""}`;
    if (response.status === 410 || (response.status === 409 && code === "quote_too_close_to_expiry")) {
      return this.#retryUncharged(state, job, { code: "quote_expired", detail: said });
    }
    if ((response.status === 400 || response.status === 409) && RETRY_AFTER_REFUSAL.has(code)) {
      return this.#retryUncharged(state, job, { code, detail: said });
    }
    if (response.status === 402 || response.status === 400) {
      // The first and only send, refused before anything moved: a rejected payment (no funds, no
      // allowance), or a payload the server would not read.
      return this.#fail(state, response.status === 402 ? "payment_rejected" : "protocol_refused", "no", said);
    }
    return this.#fail(state, "protocol_refused", "maybe", `submit ${response.status} ${said}`);
  }

  /** Step 6. Reading never charges. */
  async #poll(state: PayState, job: PayJob): Promise<PayOutcome> {
    const { http, terms, persist, now, log } = this.#deps;
    if (state.requestId === undefined)
      throw new PayError("unexpected_response", "submitted without an order id");
    const response = await http({
      method: "GET",
      url: `${terms.apiBase}/requests/${state.requestId}`,
      headers: this.#auth(),
    });
    if (response.status === 410) return this.#requote(state, job);
    const data = parseJson(response.text);
    const parsed = response.status === 200 ? RequestStatus.safeParse(data) : null;
    if (parsed === null || !parsed.success) {
      // Not an answer that can be acted on. While a payment is signed the claim cannot be given
      // back, so this must not go unnoticed: it is said every time, louder as it goes on.
      const failures = (state.statusFailures ?? 0) + 1;
      state.statusFailures = failures;
      persist(state);
      const { code } = errorCode(data);
      const why =
        parsed === null
          ? `status answered ${response.status} ${code}`
          : "status answered in an unexpected shape";
      const busy = RESEND_STATUSES.has(response.status);
      if (!busy || failures >= 3) {
        (failures >= 5 ? log.error : log.warn)("the paid order's status cannot be read", {
          requestId: state.requestId,
          http: response.status,
          code,
          passes: failures,
          ...(response.status === 401 || response.status === 403 || response.status === 404
            ? { hint: "the request token may not be the one the order was made with (IMD_PAID_TOKEN)" }
            : {}),
        });
      }
      return { kind: "pending", why, unreadable: failures };
    }
    if (state.statusFailures !== undefined) delete state.statusFailures;
    const status = parsed.data;
    if (typeof status.payment?.transactionHash === "string") state.paymentTx = status.payment.transactionHash;

    switch (status.status) {
      case "admitted": {
        const result = status.admission?.result;
        if (result?.kind === "job" && result.jobId !== undefined) {
          state.jobId = result.jobId;
          state.stage = "admitted";
          persist(state);
          log.info("admitted", {
            requestId: state.requestId,
            jobId: result.jobId,
            paymentTx: state.paymentTx,
          });
          return { kind: "admitted", jobId: result.jobId };
        }
        // Paid, and refused at admission: the fee is gone.
        return this.#fail(
          state,
          "admission_refused",
          "yes",
          JSON.stringify(result?.problems ?? result ?? null),
        );
      }
      case "payment_failed":
        // The fee was not taken (the settlement reverted, or the permit ran out first). An
        // ordinary event: quote again rather than give the order back.
        return this.#retryUncharged(state, job, {
          code: "payment_failed",
          detail: JSON.stringify(status.payment ?? null).slice(0, 200),
        });
      case "expired":
        return this.#requote(state, job);
      case "quoted":
        // The server holds no payment for this order. If our bytes can still be settled, send them
        // again; otherwise a new quote takes their place once their permit has run out.
        if (state.submit === undefined) {
          state.stage = "quoted";
          persist(state);
          return { kind: "pending", why: "the order is quoted and unpaid" };
        }
        if (state.abandoned !== true && now() <= state.submit.deadline) {
          state.stage = "signed";
          persist(state);
          return {
            kind: "pending",
            why: "the order shows no payment yet; the same bytes will be sent again",
          };
        }
        return this.#requote(state, job);
      case "payment_pending":
      case "admission_pending":
        persist(state);
        return { kind: "pending", why: status.status };
    }
  }
}
