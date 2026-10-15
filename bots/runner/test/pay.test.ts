import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PERMIT2_ADDRESS, permit2WitnessTypes, x402ExactPermit2ProxyAddress } from "@x402/evm";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { recoverTypedDataAddress, sha256, stringToBytes, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAINNET, OFFCHAIN, canonicalize, parseObjective, sameAddress } from "@help-wanted/shared";
import { Challenge, QuoteResponse, RequestStatus, type PaymentRequirements } from "@help-wanted/shared/api";
import { memoryLogger } from "../src/log.js";
import {
  GuardedSigner,
  PERMIT2_WITNESS_TYPES,
  PayError,
  PayFlow,
  QUOTE_APPROVAL_DOMAIN_NAME,
  QUOTE_APPROVAL_DOMAIN_VERSION,
  QUOTE_APPROVAL_TYPES,
  buildSubmit,
  checkChallenge,
  checkPayment,
  checkPreparedInput,
  checkQuote,
  createPayment,
  newPayState,
  paymentHash,
  quoteApprovalMessage,
  requestKey,
  requestUrl,
  signQuoteApproval,
  submitUrl,
  uuidV5,
  type PaidHttp,
  type PaidRequest,
  type PaidResponse,
  type PayDeps,
} from "../src/pay.js";
import { PayState } from "../src/store.js";
import {
  API,
  CLAIM,
  HEADER,
  JOB,
  JOB_ID,
  NOW,
  OBJECTIVE,
  PRICE,
  REQUEST_ID,
  REQUEST_KEY,
  RUNNER,
  SPEC,
  TERMS,
  TEST_ACCOUNT,
  TEST_PRIVATE_KEY,
} from "./world.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw = (name: string) => readFileSync(join(here, "fixtures", name), "utf8");
const load = <T = unknown>(name: string) => JSON.parse(raw(name)) as T;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const quoteResponse = () => QuoteResponse.parse(load("quote-response.json"));
const challenge = () => Challenge.parse(load("challenge-402.json"));
const expected = { header: HEADER, objective: OBJECTIVE, input: JOB.input };
const known = () => ({ requestId: REQUEST_ID, quote: quoteResponse().order.quote });

function payErrorOf(fn: () => unknown): PayError {
  try {
    fn();
  } catch (error) {
    if (error instanceof PayError) return error;
    throw error;
  }
  throw new Error("expected a PayError");
}

async function payErrorOfAsync(promise: Promise<unknown>): Promise<PayError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PayError) return error;
    throw error;
  }
  throw new Error("expected a PayError");
}

// The x402 library reads the system clock for the Permit2 deadline, so the tests pin it.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("what the code is pinned to", () => {
  it("runs against @x402/core and @x402/evm at exactly 2.28.0", () => {
    for (const name of ["core", "evm"]) {
      const manifest = JSON.parse(
        readFileSync(join(here, "..", "node_modules", "@x402", name, "package.json"), "utf8"),
      ) as { version: string };
      expect(manifest.version, name).toBe("2.28.0");
    }
    const mine = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(mine.dependencies["@x402/core"]).toBe("2.28.0");
    expect(mine.dependencies["@x402/evm"]).toBe("2.28.0");
  });

  it("uses the Permit2 address, proxy and types the x402 library uses", () => {
    expect(PERMIT2_ADDRESS).toBe(MAINNET.PERMIT2);
    expect(x402ExactPermit2ProxyAddress).toBe(OFFCHAIN.X402_EXACT_PERMIT2_PROXY);
    expect(permit2WitnessTypes).toEqual(PERMIT2_WITNESS_TYPES);
  });

  it("signs the QuoteApproval the protocol publishes in its OpenAPI document", () => {
    const openapi = JSON.parse(
      readFileSync(
        join(here, "..", "..", "..", "packages", "shared", "fixtures", "api", "openapi.json"),
        "utf8",
      ),
    ) as {
      paths: Record<
        string,
        {
          post?: {
            "x-imd-quote-approval"?: {
              domain: { name: string; version: string };
              primaryType: string;
              types: unknown;
            };
          };
        }
      >;
    };
    const published = openapi.paths["/requests/{id}/submit"]?.post?.["x-imd-quote-approval"];
    expect(published).toBeDefined();
    expect(published?.primaryType).toBe("QuoteApproval");
    expect(published?.types).toEqual(QUOTE_APPROVAL_TYPES);
    expect(published?.domain.name).toBe(QUOTE_APPROVAL_DOMAIN_NAME);
    expect(published?.domain.version).toBe(QUOTE_APPROVAL_DOMAIN_VERSION);
  });

  it("the fixtures hold together", () => {
    const { order } = quoteResponse();
    expect(order.id).toBe(REQUEST_ID);
    expect(order.requestKey).toBe(REQUEST_KEY);
    expect(order.requestKey).toBe(requestKey({ ...CLAIM, attempt: 1 }));
    expect((JSON.parse(order.inputJson) as { objective: string }).objective).toBe(OBJECTIVE);
    expect(parseObjective(OBJECTIVE)?.spec).toBe(SPEC);
    const ch = challenge();
    expect(ch.resourceUrl).toBe(submitUrl(TERMS, REQUEST_ID));
    expect(canonicalize(ch.quote)).toBe(canonicalize(order.quote));
    for (const name of [
      "status-admitted.json",
      "status-payment-pending.json",
      "status-payment-failed.json",
      "status-refused.json",
    ]) {
      expect(RequestStatus.safeParse(load(name)).success, name).toBe(true);
    }
  });

  it("derives request keys as RFC 4122 version 5 UUIDs", () => {
    // The standard example: uuid5(NAMESPACE_DNS, "python.org").
    expect(uuidV5("python.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(
      "886313e1-3b8a-5372-9b90-0c9aee199e5d",
    );
    const key = requestKey({ ...CLAIM, attempt: 1 });
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(requestKey({ ...CLAIM, attempt: 1 })).toBe(key);
    const others = [
      requestKey({ ...CLAIM, attempt: 2 }),
      requestKey({ ...CLAIM, claimSeq: 2, attempt: 1 }),
      requestKey({ ...CLAIM, orderId: 8n, attempt: 1 }),
      requestKey({ ...CLAIM, runner: MAINNET.IMD, attempt: 1 }),
      requestKey({ ...CLAIM, workOrders: MAINNET.IMD, attempt: 1 }),
    ];
    expect(new Set([key, ...others]).size).toBe(6);
  });
});

describe("check 1: the quote", () => {
  const quote = () => quoteResponse().order.quote;

  it("accepts the quote the runner agreed to and returns its price", () => {
    expect(checkQuote(quote(), REQUEST_ID, TERMS, NOW)).toBe(PRICE);
  });

  it.each([
    ["another action", (q: ReturnType<typeof quote>) => void (q.action = "launch.open")],
    ["another network", (q: ReturnType<typeof quote>) => void (q.payment.network = "eip155:4663")],
    ["another token", (q: ReturnType<typeof quote>) => void (q.payment.asset = MAINNET.SIMD.toLowerCase())],
    ["another recipient", (q: ReturnType<typeof quote>) => void (q.payment.payTo = RUNNER.toLowerCase())],
    [
      "a price above the limit",
      (q: ReturnType<typeof quote>) => void (q.payment.amount = (PRICE + 1n).toString()),
    ],
    ["a price of zero", (q: ReturnType<typeof quote>) => void (q.payment.amount = "0")],
    ["other decimals", (q: ReturnType<typeof quote>) => void (q.payment.decimals = 6)],
    ["several runs", (q: ReturnType<typeof quote>) => void (q.runs = 3)],
    ["another payer", (q: ReturnType<typeof quote>) => void (q.payer = MAINNET.IMD.toLowerCase())],
    ["a date in the future", (q: ReturnType<typeof quote>) => void (q.issuedAt = NOW + 3600)],
  ])("refuses %s", (_note, change) => {
    const q = quote();
    change(q);
    expect(payErrorOf(() => checkQuote(q, REQUEST_ID, TERMS, NOW)).code).toBe("quote_mismatch");
  });

  it("refuses a quote for another order, and one about to expire", () => {
    expect(payErrorOf(() => checkQuote(quote(), JOB_ID, TERMS, NOW)).code).toBe("quote_mismatch");
    expect(payErrorOf(() => checkQuote(quote(), REQUEST_ID, TERMS, NOW + 571)).code).toBe("quote_expiring");
    expect(payErrorOf(() => checkQuote(quote(), REQUEST_ID, TERMS, NOW + 9999)).code).toBe("quote_expiring");
    expect(checkQuote(quote(), REQUEST_ID, TERMS, NOW + 569)).toBe(PRICE);
  });

  it("accepts the payer when it is the runner, in either spelling", () => {
    const q = quote();
    q.payer = RUNNER.toLowerCase();
    expect(checkQuote(q, REQUEST_ID, TERMS, NOW)).toBe(PRICE);
  });
});

describe("check 2: the prepared input", () => {
  it("accepts the input exactly as it was sent", () => {
    expect(() => checkPreparedInput(JOB.input, expected)).not.toThrow();
    expect(() => checkPreparedInput(JSON.parse(quoteResponse().order.inputJson), expected)).not.toThrow();
  });

  it.each([
    ["the header removed", SPEC],
    ["a space in front", ` ${OBJECTIVE}`],
    ["text in front", `Note: ${OBJECTIVE}`],
    ["another ticket", OBJECTIVE.replace(/[0-9a-f]{64}/, "0".repeat(64))],
    ["the header in capitals", OBJECTIVE.replace("help-wanted", "HELP-WANTED")],
    ["no objective at all", undefined],
  ])("refuses an objective with %s", (_note, objective) => {
    const input = { ...JOB.input, objective };
    expect(payErrorOf(() => checkPreparedInput(input, expected)).code).toBe("prepared_objective_lost_header");
  });

  it.each([
    ["a full stop added", `${OBJECTIVE}.`],
    ["a newline added", `${OBJECTIVE}\n`],
    ["the last character cut", OBJECTIVE.slice(0, -1)],
    ["a word changed", OBJECTIVE.replace("week", "month")],
    ["two spaces made one", OBJECTIVE.replace("] Write", "]Write")],
  ])("refuses an objective with %s", (_note, objective) => {
    const input = { ...JOB.input, objective };
    const code = payErrorOf(() => checkPreparedInput(input, expected)).code;
    expect(["prepared_objective_changed", "prepared_objective_lost_header"]).toContain(code);
    if (objective.startsWith(HEADER)) expect(code).toBe("prepared_objective_changed");
  });

  it("refuses an input that is not an object, or that became a launch or a continuation", () => {
    for (const input of [null, "text", [JOB.input], 5]) {
      expect(payErrorOf(() => checkPreparedInput(input, expected)).code).toBe("prepared_input_not_object");
    }
    for (const extra of [
      { onchain: "evm_contracts" },
      { onchain: true },
      { launch: true },
      { parentJobId: JOB_ID },
      { owner: RUNNER },
    ]) {
      expect(payErrorOf(() => checkPreparedInput({ ...JOB.input, ...extra }, expected)).code).toBe(
        "prepared_input_unexpected_field",
      );
    }
  });

  // The desk pays only for a record of the order's kind, and the kind follows from `skill` or
  // `template`. The protocol says the prepared input "may differ from the original input", so every
  // field that was sent is compared, not the objective alone.
  it.each([
    ["another skill", { ...JOB.input, skill: "create-image" }],
    ["the skill gone", (({ skill: _gone, ...rest }) => rest)(JOB.input as { skill: string })],
    [
      "the outputs changed",
      { ...JOB.input, outputs: [{ name: "report", path: "artifacts/other.md", mediaType: "text/markdown" }] },
    ],
    [
      "one more output",
      {
        ...JOB.input,
        outputs: [
          ...(JOB.input.outputs as unknown[]),
          { name: "x", path: "artifacts/x", mediaType: "text/plain" },
        ],
      },
    ],
    ["delivery to GitHub switched on", { ...JOB.input, github: true }],
  ])("refuses a prepared input with %s", (_note, input) => {
    expect(payErrorOf(() => checkPreparedInput(input, expected)).code).toBe("prepared_input_changed");
  });

  it.each([
    ["a template added beside the skill", { ...JOB.input, template: "research" }],
    ["steps and a shape added", { ...JOB.input, steps: [{ skill: "research-report" }], shape: "chain" }],
    [
      "a repository added",
      { ...JOB.input, repoUrl: "https://github.com/x/other", baseCommit: "0".repeat(40) },
    ],
    ["an unknown field with a value", { ...JOB.input, minCitations: 5 }],
  ])("refuses a prepared input with %s", (_note, input) => {
    expect(payErrorOf(() => checkPreparedInput(input, expected)).code).toBe(
      "prepared_input_unexpected_field",
    );
  });

  it("refuses a job rewritten into another kind, though its objective is untouched", () => {
    expect(
      payErrorOf(() => checkPreparedInput({ objective: OBJECTIVE, template: "research" }, expected)).code,
    ).toBe("prepared_input_changed");
    const audit = {
      header: HEADER,
      objective: OBJECTIVE,
      input: {
        objective: OBJECTIVE,
        template: "audit",
        repoUrl: "https://github.com/o/r",
        baseCommit: "a".repeat(40),
      },
    };
    expect(() => checkPreparedInput(audit.input, audit)).not.toThrow();
    expect(
      payErrorOf(() => checkPreparedInput({ ...audit.input, repoUrl: "https://github.com/x/other" }, audit))
        .code,
    ).toBe("prepared_input_changed");
    expect(
      payErrorOf(() => checkPreparedInput({ ...audit.input, baseCommit: "b".repeat(40) }, audit)).code,
    ).toBe("prepared_input_changed");
  });

  it("lets through added fields that hold nothing, and the ones the operator listed", () => {
    // What a server writes for a default it did not fill in.
    expect(() =>
      checkPreparedInput(
        { ...JOB.input, onchain: false, launch: null, references: [], variables: {}, ipfs: false, note: "" },
        expected,
      ),
    ).not.toThrow();
    // A default with a value is refused until the operator has looked at it and listed it.
    const filled = { ...JOB.input, minCitations: 5 };
    expect(payErrorOf(() => checkPreparedInput(filled, expected)).code).toBe(
      "prepared_input_unexpected_field",
    );
    expect(() => checkPreparedInput(filled, expected, ["minCitations"])).not.toThrow();
    // Listing a field never lets in one that decides the kind of job or makes it a launch.
    for (const never of [{ template: "research" }, { onchain: true }, { parentJobId: JOB_ID }]) {
      const key = Object.keys(never)[0] as string;
      expect(payErrorOf(() => checkPreparedInput({ ...JOB.input, ...never }, expected, [key])).code).toBe(
        "prepared_input_unexpected_field",
      );
    }
    // Objects compare by content, whatever order their keys come in.
    const reordered = {
      github: false,
      outputs: [{ mediaType: "text/markdown", path: "artifacts/report.md", name: "report" }],
      skill: "research-report",
      objective: OBJECTIVE,
    };
    expect(() => checkPreparedInput(reordered, expected)).not.toThrow();
  });
});

describe("check 3: the challenge", () => {
  const check = (ch: Challenge, now = NOW, header?: string | null) =>
    checkChallenge(ch, known(), TERMS, expected, now, header);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

  it("accepts the challenge and returns accepts[0]", () => {
    const req = check(challenge());
    expect(req.amount).toBe(PRICE.toString());
    expect(req.extra).toEqual({ assetTransferMethod: "permit2" });
  });

  it.each([
    ["another scheme", (r: PaymentRequirements) => void (r.scheme = "upto")],
    ["another network", (r: PaymentRequirements) => void (r.network = "eip155:8453")],
    [
      "another token",
      (r: PaymentRequirements) => void (r.asset = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
    ],
    ["another recipient", (r: PaymentRequirements) => void (r.payTo = RUNNER.toLowerCase())],
    ["a higher amount", (r: PaymentRequirements) => void (r.amount = (PRICE * 2n).toString())],
    ["a lower amount than the quote", (r: PaymentRequirements) => void (r.amount = "1")],
    [
      "a transfer method other than permit2",
      (r: PaymentRequirements) => void (r.extra = { assetTransferMethod: "eip3009" }),
    ],
    ["no transfer method", (r: PaymentRequirements) => void (r.extra = {})],
    [
      "a payment flow",
      (r: PaymentRequirements) => void (r.extra = { assetTransferMethod: "permit2", paymentFlow: "escrow" }),
    ],
  ])("refuses accepts[0] with %s", (_note, change) => {
    const ch = challenge();
    change(ch.accepts[0] as PaymentRequirements);
    expect(payErrorOf(() => check(ch)).code).toBe("challenge_mismatch");
  });

  it("looks only at accepts[0]: a good second option does not rescue a bad first one", () => {
    const ch = challenge();
    const good = clone(ch.accepts[0] as PaymentRequirements);
    (ch.accepts[0] as PaymentRequirements).payTo = RUNNER.toLowerCase();
    ch.accepts.push(good);
    expect(payErrorOf(() => check(ch)).code).toBe("challenge_mismatch");
  });

  it("refuses a challenge whose quote is not the one that was quoted", () => {
    for (const change of [
      (c: Challenge) => void (c.quote.quoteHash = "0".repeat(64)),
      (c: Challenge) => void (c.quote.expiresAt += 1),
      (c: Challenge) => void (c.quote.inputHash = "1".repeat(64)),
      (c: Challenge) => void (c.quote.payment.payTo = RUNNER.toLowerCase()),
    ]) {
      const ch = challenge();
      change(ch);
      expect(payErrorOf(() => check(ch)).code).toBe("challenge_mismatch");
    }
  });

  it("refuses a challenge for another resource", () => {
    const ch = challenge();
    ch.resourceUrl = `${API}/requests/${JOB_ID}/submit`;
    expect(payErrorOf(() => check(ch)).code).toBe("challenge_mismatch");
    const ch2 = challenge();
    ch2.resource.url = "https://elsewhere.example/requests/x/submit";
    expect(payErrorOf(() => check(ch2)).code).toBe("challenge_mismatch");
    // Another order's own address, and this order's id on another host, are refused the same way.
    const ch3 = challenge();
    ch3.resourceUrl = `${API}/requests/${JOB_ID}`;
    expect(payErrorOf(() => check(ch3)).code).toBe("challenge_mismatch");
    const ch4 = challenge();
    ch4.resource.url = `https://elsewhere.example/requests/${REQUEST_ID}`;
    expect(payErrorOf(() => check(ch4)).code).toBe("challenge_mismatch");
  });

  it("takes a challenge that names the order itself as the resource, as the live protocol does", () => {
    // Seen live on 13 October 2026: `resourceUrl` was `<api>/requests/<id>`, not the submit URL.
    const ch = challenge();
    ch.resourceUrl = requestUrl(TERMS, REQUEST_ID);
    ch.resource.url = requestUrl(TERMS, REQUEST_ID);
    expect(() => check(ch)).not.toThrow();
    // Either field alone in that form passes too: both forms name this order on this API.
    const mixed = challenge();
    mixed.resourceUrl = requestUrl(TERMS, REQUEST_ID);
    expect(() => check(mixed)).not.toThrow();
  });

  it("refuses a challenge whose prepared input lost or changed the objective", () => {
    const lost = challenge();
    (lost.input as { objective: string }).objective = SPEC;
    expect(payErrorOf(() => check(lost)).code).toBe("prepared_objective_lost_header");
    const changed = challenge();
    (changed.input as { objective: string }).objective = `${OBJECTIVE} Thanks.`;
    expect(payErrorOf(() => check(changed)).code).toBe("prepared_objective_changed");
  });

  it("requires the payment window to end before the quote does, with a few seconds in hand", () => {
    // maxTimeoutSeconds is 300 and the quote lives 600 seconds from NOW. The payment library reads
    // the clock again when it signs, so five seconds are kept for that.
    expect(() => check(challenge(), NOW + 294)).not.toThrow();
    expect(payErrorOf(() => check(challenge(), NOW + 295)).code).toBe("challenge_window");
    expect(payErrorOf(() => check(challenge(), NOW + 300)).code).toBe("challenge_window");
    const long = challenge();
    (long.accepts[0] as PaymentRequirements).maxTimeoutSeconds = 600;
    expect(payErrorOf(() => check(long)).code).toBe("challenge_window");
  });

  it("compares the PAYMENT-REQUIRED header with the body when there is one", () => {
    const ch = challenge();
    const header = encode({ x402Version: 2, resource: ch.resource, accepts: ch.accepts });
    expect(() => check(ch, NOW, header)).not.toThrow();
    expect(() => check(ch, NOW, null)).not.toThrow();
    const other = clone(ch.accepts);
    (other[0] as PaymentRequirements).payTo = RUNNER.toLowerCase();
    expect(payErrorOf(() => check(ch, NOW, encode({ x402Version: 2, accepts: other }))).code).toBe(
      "challenge_mismatch",
    );
    expect(payErrorOf(() => check(ch, NOW, encode({ x402Version: 1, accepts: ch.accepts }))).code).toBe(
      "challenge_mismatch",
    );
    expect(payErrorOf(() => check(ch, NOW, "%%% not base64 json")).code).toBe("challenge_mismatch");
  });
});

describe("the guarded signer", () => {
  const permit = {
    chainId: 1,
    token: MAINNET.IMD,
    amount: PRICE,
    payTo: MAINNET.FEE_PAYEE,
    notBefore: NOW,
    deadlineBefore: NOW + 600,
  };
  const request = (overrides: Record<string, unknown> = {}, message: Record<string, unknown> = {}) => ({
    domain: { name: "Permit2", chainId: 1, verifyingContract: MAINNET.PERMIT2 },
    types: PERMIT2_WITNESS_TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: MAINNET.IMD, amount: PRICE },
      spender: OFFCHAIN.X402_EXACT_PERMIT2_PROXY,
      nonce: 12345n,
      deadline: BigInt(NOW + 300),
      witness: { to: MAINNET.FEE_PAYEE, validAfter: 0n },
      ...message,
    },
    ...overrides,
  });
  const armed = () => {
    const signer = new GuardedSigner(TEST_ACCOUNT);
    signer.expectPermit(permit);
    return signer;
  };

  it("signs the expected Permit2 payment, once", async () => {
    const signer = armed();
    const signature = await signer.signTypedData(request());
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect((await payErrorOfAsync(signer.signTypedData(request()))).code).toBe("sign_refused");
  });

  it("signs nothing it was not told to expect", async () => {
    const signer = new GuardedSigner(TEST_ACCOUNT);
    expect((await payErrorOfAsync(signer.signTypedData(request()))).code).toBe("sign_refused");
    expect(
      (await payErrorOfAsync(signer.signTypedData({ ...request(), primaryType: "QuoteApproval" }))).code,
    ).toBe("sign_refused");
  });

  it.each([
    ["an ERC-2612 permit", "Permit"],
    ["an EIP-3009 transfer", "TransferWithAuthorization"],
    ["a Permit2 allowance", "PermitSingle"],
    ["a plain Permit2 transfer", "PermitTransferFrom"],
    ["nothing at all", undefined],
  ])("refuses %s even when a payment is expected", async (_note, primaryType) => {
    const error = await payErrorOfAsync(
      armed().signTypedData({ ...request(), primaryType: primaryType as string }),
    );
    expect(error.code).toBe("sign_refused");
  });

  it.each([
    ["another token", {}, { permitted: { token: MAINNET.SIMD, amount: PRICE } }],
    ["a larger amount", {}, { permitted: { token: MAINNET.IMD, amount: PRICE + 1n } }],
    ["a smaller amount", {}, { permitted: { token: MAINNET.IMD, amount: PRICE - 1n } }],
    ["an amount that is not a bigint", {}, { permitted: { token: MAINNET.IMD, amount: PRICE.toString() } }],
    ["another spender", {}, { spender: RUNNER }],
    ["the upto proxy as spender", {}, { spender: "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002" }],
    ["another recipient", {}, { witness: { to: RUNNER, validAfter: 0n } }],
    ["a later start", {}, { witness: { to: MAINNET.FEE_PAYEE, validAfter: 5n } }],
    ["a deadline at the quote's expiry", {}, { deadline: BigInt(NOW + 600) }],
    ["a deadline after the quote's expiry", {}, { deadline: BigInt(NOW + 86400) }],
    ["a deadline in the past", {}, { deadline: BigInt(NOW) }],
    ["no nonce", {}, { nonce: undefined }],
    ["another chain", { domain: { name: "Permit2", chainId: 8453, verifyingContract: MAINNET.PERMIT2 } }, {}],
    [
      "another verifying contract",
      { domain: { name: "Permit2", chainId: 1, verifyingContract: RUNNER } },
      {},
    ],
    [
      "another domain name",
      { domain: { name: "Permit3", chainId: 1, verifyingContract: MAINNET.PERMIT2 } },
      {},
    ],
    [
      "a domain with a version",
      { domain: { name: "Permit2", version: "1", chainId: 1, verifyingContract: MAINNET.PERMIT2 } },
      {},
    ],
    ["other types", { types: { ...PERMIT2_WITNESS_TYPES, Witness: [{ name: "to", type: "address" }] } }, {}],
  ])("refuses a payment with %s", async (_note, overrides, message) => {
    const error = await payErrorOfAsync(armed().signTypedData(request(overrides, message)));
    expect(error.code).toBe("sign_refused");
  });

  it("offers no other way to use the key", () => {
    const signer = new GuardedSigner(TEST_ACCOUNT) as unknown as Record<string, unknown>;
    for (const method of [
      "signMessage",
      "signTransaction",
      "sign",
      "signAuthorization",
      "source",
      "account",
    ]) {
      expect(signer[method], method).toBeUndefined();
    }
    expect(JSON.stringify(signer)).not.toContain(TEST_PRIVATE_KEY.slice(2));
    expect(Object.keys(signer).sort()).toEqual(["address", "signTypedData"]);
  });

  it("forgets an expectation that is disarmed", async () => {
    const signer = armed();
    signer.disarm();
    expect((await payErrorOfAsync(signer.signTypedData(request()))).code).toBe("sign_refused");
  });
});

describe("the payment, made by the x402 library at 2.28.0", () => {
  const make = async () => {
    const ch = challenge();
    const req = checkChallenge(ch, known(), TERMS, expected, NOW);
    const signer = new GuardedSigner(TEST_ACCOUNT);
    const payment = await createPayment(ch, req, signer, TERMS, NOW);
    return { ch, req, signer, payment };
  };

  it("has exactly the fields the server allows, and says what was checked", async () => {
    const { payment, req, ch } = await make();
    expect(Object.keys(payment).sort()).toEqual(["accepted", "payload", "resource", "x402Version"]);
    expect("extensions" in payment).toBe(false);
    expect(payment.x402Version).toBe(2);
    expect(payment.accepted).toEqual(req);
    expect(payment.resource).toEqual(ch.resource);
    const auth = payment.payload.permit2Authorization;
    expect(auth.from).toBe(RUNNER);
    expect(sameAddress(auth.permitted.token, MAINNET.IMD)).toBe(true);
    expect(auth.permitted.amount).toBe(PRICE.toString());
    expect(auth.spender).toBe(OFFCHAIN.X402_EXACT_PERMIT2_PROXY);
    expect(sameAddress(auth.witness.to, MAINNET.FEE_PAYEE)).toBe(true);
    expect(auth.witness.validAfter).toBe("0");
    // deadline = now + accepts[0].maxTimeoutSeconds, and it falls before the quote expires.
    expect(auth.deadline).toBe(String(NOW + 300));
    expect(Number(auth.deadline)).toBeLessThan(ch.quote.expiresAt);
    expect(auth.nonce).toMatch(/^[0-9]+$/);
  });

  it("carries a signature that recovers to the payer over Permit2's typed data", async () => {
    const { payment } = await make();
    const auth = payment.payload.permit2Authorization;
    const signer = await recoverTypedDataAddress({
      domain: { name: "Permit2", chainId: 1, verifyingContract: PERMIT2_ADDRESS },
      types: permit2WitnessTypes,
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: auth.permitted.token as Hex, amount: BigInt(auth.permitted.amount) },
        spender: auth.spender as Hex,
        nonce: BigInt(auth.nonce),
        deadline: BigInt(auth.deadline),
        witness: { to: auth.witness.to as Hex, validAfter: 0n },
      },
      signature: payment.payload.signature,
    });
    expect(signer).toBe(RUNNER);
  });

  it("uses a fresh nonce every time", async () => {
    const a = await make();
    const b = await make();
    expect(a.payment.payload.permit2Authorization.nonce).not.toBe(
      b.payment.payload.permit2Authorization.nonce,
    );
  });

  it("leaves the signer disarmed afterwards", async () => {
    const { signer } = await make();
    const error = await payErrorOfAsync(
      signer.signTypedData({ primaryType: "PermitWitnessTransferFrom", domain: {}, types: {}, message: {} }),
    );
    expect(error.code).toBe("sign_refused");
  });

  it("the x402 client refuses IMD unless it is listed as an allowed asset", async () => {
    // Why `createPayment` passes spendControls: at 2.28.0 the client only pays its default assets
    // (USDC on mainnet) unless the token is allow-listed.
    const ch = challenge();
    const req = ch.accepts[0] as PaymentRequirements;
    const signer = new GuardedSigner(TEST_ACCOUNT);
    signer.expectPermit({
      chainId: 1,
      token: MAINNET.IMD,
      amount: PRICE,
      payTo: MAINNET.FEE_PAYEE,
      notBefore: NOW,
      deadlineBefore: NOW + 600,
    });
    const bare = x402Client.fromConfig({
      schemes: [{ network: "eip155:1", client: new ExactEvmScheme(signer) }],
    });
    await expect(
      bare.createPaymentPayload({
        x402Version: 2,
        resource: ch.resource,
        accepts: [{ ...req, network: "eip155:1", extra: req.extra ?? {} }],
      }),
    ).rejects.toThrow(/spendControls/);
  });

  it("refuses to sign above the runner's limit, in the library and in the guard", async () => {
    const ch = challenge();
    const req = clone(ch.accepts[0] as PaymentRequirements);
    req.amount = (PRICE + 1n).toString();
    const signer = new GuardedSigner(TEST_ACCOUNT);
    await expect(createPayment(ch, req, signer, TERMS, NOW)).rejects.toThrow();
  });

  it("check 4 refuses a payload that differs from what was agreed", async () => {
    const { payment, req, ch } = await make();
    const context = { req, challenge: ch, terms: TERMS, now: NOW };
    await expect(checkPayment(payment, context)).resolves.toBeDefined();

    const cases: [string, (p: typeof payment) => void, string][] = [
      [
        "extensions",
        (p) => void ((p as unknown as Record<string, unknown>).extensions = {}),
        "payment_shape",
      ],
      [
        "an unknown top-level field",
        (p) => void ((p as unknown as Record<string, unknown>).note = "x"),
        "payment_shape",
      ],
      [
        "an unknown permit field",
        (p) => void ((p.payload.permit2Authorization as unknown as Record<string, unknown>).memo = "x"),
        "payment_shape",
      ],
      [
        "an unknown resource field",
        (p) => void ((p.resource as unknown as Record<string, unknown>).serviceName = "x"),
        "payment_shape",
      ],
      [
        "another accepted",
        (p) => void (p.accepted = { ...p.accepted, payTo: RUNNER.toLowerCase() }),
        "payment_mismatch",
      ],
      [
        "another resource",
        (p) => void ((p.resource as { url: string }).url = "https://elsewhere.example/x"),
        "payment_mismatch",
      ],
      [
        "another recipient",
        (p) => void (p.payload.permit2Authorization.witness.to = RUNNER),
        "payment_mismatch",
      ],
      ["another spender", (p) => void (p.payload.permit2Authorization.spender = RUNNER), "payment_mismatch"],
      [
        "another amount",
        (p) => void (p.payload.permit2Authorization.permitted.amount = "1"),
        "payment_mismatch",
      ],
      [
        "another token",
        (p) => void (p.payload.permit2Authorization.permitted.token = MAINNET.SIMD),
        "payment_mismatch",
      ],
      ["another payer", (p) => void (p.payload.permit2Authorization.from = MAINNET.IMD), "payment_mismatch"],
      [
        "a deadline after the quote",
        (p) => void (p.payload.permit2Authorization.deadline = String(NOW + 9999)),
        "payment_mismatch",
      ],
      [
        "a changed nonce (the signature no longer matches)",
        (p) => void (p.payload.permit2Authorization.nonce = "1"),
        "payment_mismatch",
      ],
      ["a truncated signature", (p) => void (p.payload.signature = "0x1234"), "payment_shape"],
    ];
    for (const [note, change, code] of cases) {
      const copy = clone(payment);
      change(copy);
      const error = await payErrorOfAsync(checkPayment(copy, context));
      expect(error.code, note).toBe(code);
    }
    expect((await payErrorOfAsync(checkPayment(payment, { ...context, now: NOW + 301 }))).code).toBe(
      "payment_mismatch",
    );
  });
});

describe("the quote approval and the request bytes", () => {
  const sign = async () => {
    const ch = challenge();
    const req = checkChallenge(ch, known(), TERMS, expected, NOW);
    const signer = new GuardedSigner(TEST_ACCOUNT);
    const payment = await createPayment(ch, req, signer, TERMS, NOW);
    const quoteSignature = await signQuoteApproval(ch, payment, signer, TERMS);
    return { ch, payment, quoteSignature, signer };
  };

  it("hashes the payment as the protocol's own example does", async () => {
    const { payment } = await sign();
    // `canon` from the API guide, copied as published.
    const canon = (v: unknown): string =>
      v === null
        ? "null"
        : Array.isArray(v)
          ? `[${v.map(canon).join(",")}]`
          : typeof v === "object"
            ? `{${Object.keys(v as object)
                .sort()
                .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
                .join(",")}}`
            : JSON.stringify(v);
    expect(paymentHash(payment)).toBe(sha256(stringToBytes(canon(payment))));
  });

  it("is signed by the payer over every field the protocol lists", async () => {
    const { ch, payment, quoteSignature } = await sign();
    const message = quoteApprovalMessage(ch, payment);
    expect(message).toEqual({
      resource: ch.resourceUrl,
      requesterScopeHash: `0x${ch.requesterScopeHash}`,
      quoteId: REQUEST_ID,
      quoteHash: `0x${ch.quote.quoteHash}`,
      paymentHash: paymentHash(payment),
      action: "job.open",
      asset: MAINNET.IMD,
      amount: PRICE,
      payTo: MAINNET.FEE_PAYEE,
      expiresAt: BigInt(ch.quote.expiresAt),
    });
    const signer = await recoverTypedDataAddress({
      domain: { name: "IdentityMD Paid Action", version: "1", chainId: 1 },
      types: QUOTE_APPROVAL_TYPES,
      primaryType: "QuoteApproval",
      message,
      signature: quoteSignature,
    });
    expect(signer).toBe(RUNNER);
    expect(quoteSignature).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });

  it("changes when one byte of the payment changes", async () => {
    const { ch, payment } = await sign();
    const other = clone(payment);
    other.payload.permit2Authorization.nonce = `${other.payload.permit2Authorization.nonce}0`;
    expect(quoteApprovalMessage(ch, other).paymentHash).not.toBe(
      quoteApprovalMessage(ch, payment).paymentHash,
    );
  });

  it("the guard refuses an approval other than the one computed from the challenge", async () => {
    const { ch, payment, signer } = await sign();
    const message = quoteApprovalMessage(ch, payment);
    const ask = (changed: Record<string, unknown>, domain?: Record<string, unknown>) => {
      signer.expectApproval({ chainId: 1, message });
      return payErrorOfAsync(
        signer.signTypedData({
          domain: domain ?? { name: "IdentityMD Paid Action", version: "1", chainId: 1 },
          types: QUOTE_APPROVAL_TYPES,
          primaryType: "QuoteApproval",
          message: { ...message, ...changed },
        }),
      );
    };
    expect((await ask({ payTo: RUNNER })).code).toBe("sign_refused");
    expect((await ask({ amount: PRICE * 10n })).code).toBe("sign_refused");
    expect((await ask({ paymentHash: `0x${"0".repeat(64)}` })).code).toBe("sign_refused");
    expect((await ask({ extra: 1 })).code).toBe("sign_refused");
    expect((await ask({}, { name: "IdentityMD Paid Action", version: "2", chainId: 1 })).code).toBe(
      "sign_refused",
    );
    expect((await ask({}, { name: "IdentityMD Paid Action", version: "1", chainId: 4663 })).code).toBe(
      "sign_refused",
    );
  });

  it("signs for the live form of the challenge and still sends the payment to the submit URL", async () => {
    // The order itself is the x402 resource; the paying request goes to its submit route.
    const ch = challenge();
    ch.resourceUrl = requestUrl(TERMS, REQUEST_ID);
    ch.resource.url = requestUrl(TERMS, REQUEST_ID);
    const req = checkChallenge(ch, known(), TERMS, expected, NOW);
    const signer = new GuardedSigner(TEST_ACCOUNT);
    const payment = await createPayment(ch, req, signer, TERMS, NOW);
    expect(payment.resource?.url).toBe(requestUrl(TERMS, REQUEST_ID));
    const quoteSignature = await signQuoteApproval(ch, payment, signer, TERMS);
    expect(quoteApprovalMessage(ch, payment).resource).toBe(requestUrl(TERMS, REQUEST_ID));
    const submit = buildSubmit(submitUrl(TERMS, REQUEST_ID), payment, quoteSignature, NOW);
    expect(submit.url).toBe(`${API}/requests/${REQUEST_ID}/submit`);
  });

  it("refuses a payment that names another resource than the challenge handed over", async () => {
    const ch = challenge();
    ch.resourceUrl = requestUrl(TERMS, REQUEST_ID);
    const req = checkChallenge(ch, known(), TERMS, expected, NOW);
    const payment = await createPayment(ch, req, new GuardedSigner(TEST_ACCOUNT), TERMS, NOW);
    const moved = clone(payment);
    (moved.resource as { url: string }).url = requestUrl(TERMS, REQUEST_ID);
    // The challenge's `resource.url` is still the submit URL here: the payment must carry that one.
    expect(
      (await payErrorOfAsync(checkPayment(moved, { req, challenge: ch, terms: TERMS, now: NOW }))).code,
    ).toBe("payment_mismatch");
  });

  it("builds the exact request: the header is the payment, the body the signature", async () => {
    const { ch, payment, quoteSignature } = await sign();
    const submit = buildSubmit(submitUrl(TERMS, REQUEST_ID), payment, quoteSignature, NOW);
    expect(submit.url).toBe(`${API}/requests/${REQUEST_ID}/submit`);
    expect(JSON.parse(Buffer.from(submit.paymentHeader, "base64").toString("utf8"))).toEqual(payment);
    expect(submit.paymentHeader.length).toBeLessThan(12288); // the header's documented maximum
    expect(submit.body).toBe(`{"quoteSignature":"${quoteSignature}"}`);
    expect(submit.deadline).toBe(NOW + 300);
    expect(submit.amount).toBe(PRICE.toString());
  });
});

// -------------------------------------------------------------------------------------------------

interface Exchange {
  request: PaidRequest;
  response: PaidResponse | Error;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): PaidResponse {
  return { status, headers, text: typeof body === "string" ? body : JSON.stringify(body) };
}

function harness(
  script: (request: PaidRequest, n: number) => PaidResponse | Error,
  overrides: Partial<PayDeps> = {},
) {
  const exchanges: Exchange[] = [];
  const persisted: PayState[] = [];
  const reserved: bigint[] = [];
  const released: bigint[] = [];
  const releasedOn: (string | undefined)[] = [];
  const log = memoryLogger([TEST_PRIVATE_KEY, "f".repeat(64)]);
  let clock = NOW;
  let signatures = 0;
  const signer = new GuardedSigner(TEST_ACCOUNT);
  const counting = Object.assign(Object.create(signer) as GuardedSigner, {
    address: signer.address,
    signTypedData: async (request: Parameters<GuardedSigner["signTypedData"]>[0]) => {
      signatures++;
      return signer.signTypedData(request);
    },
    expectPermit: signer.expectPermit.bind(signer),
    expectApproval: signer.expectApproval.bind(signer),
    disarm: signer.disarm.bind(signer),
  });
  const http: PaidHttp = async (request) => {
    const response = script(request, exchanges.length + 1);
    exchanges.push({ request, response });
    if (response instanceof Error) throw response;
    return response;
  };
  const deps: PayDeps = {
    http,
    signer: counting,
    token: "f".repeat(64),
    terms: TERMS,
    now: () => clock,
    log,
    persist: (state) => persisted.push(PayState.parse(clone(state))),
    reserve: (amount) => {
      reserved.push(amount);
      return true;
    },
    release: (amount, day) => {
      released.push(amount);
      releasedOn.push(day);
    },
    ...overrides,
  };
  return {
    flow: new PayFlow(deps),
    deps,
    exchanges,
    persisted,
    reserved,
    released,
    releasedOn,
    log,
    signatures: () => signatures,
    setClock: (t: number) => {
      clock = t;
      vi.setSystemTime(t * 1000);
    },
  };
}

const QUOTE_URL = `${API}/requests/quote`;
const SUBMIT_URL = `${API}/requests/${REQUEST_ID}/submit`;
const STATUS_URL = `${API}/requests/${REQUEST_ID}`;

/** The protocol behaving as documented. */
function goodProtocol(request: PaidRequest, statuses: string[] = ["status-admitted.json"]): PaidResponse {
  if (request.url === QUOTE_URL) return json(201, raw("quote-response.json"));
  if (request.url === SUBMIT_URL && request.headers["payment-signature"] === undefined) {
    return json(402, raw("challenge-402.json"));
  }
  if (request.url === SUBMIT_URL) return json(202, raw("status-payment-pending.json"));
  if (request.url === STATUS_URL) return json(200, raw(statuses.shift() ?? "status-admitted.json"));
  return json(404, { error: "order_not_found" });
}

describe("the flow", () => {
  it("quotes, reads the challenge, signs twice, submits and polls to a job id", async () => {
    const statuses = ["status-payment-pending.json", "status-admitted.json"];
    const h = harness((request) => goodProtocol(request, statuses));
    const state = newPayState(JOB);
    expect(state.requestKey).toBe(REQUEST_KEY);

    const first = await h.flow.advance(state, JOB);
    expect(first).toEqual({ kind: "pending", why: "payment_pending" });
    const second = await h.flow.advance(state, JOB);
    expect(second).toEqual({ kind: "admitted", jobId: JOB_ID });
    expect(state.stage).toBe("admitted");
    expect(state.paymentTx).toMatch(/^0x[0-9a-f]{64}$/);

    expect(h.exchanges.map((e) => `${e.request.method} ${e.request.url}`)).toEqual([
      `POST ${QUOTE_URL}`,
      `POST ${SUBMIT_URL}`,
      `POST ${SUBMIT_URL}`,
      `GET ${STATUS_URL}`,
      `GET ${STATUS_URL}`,
    ]);
    // The quote is {requestKey, action, input} and nothing else.
    expect(JSON.parse(h.exchanges[0]?.request.body ?? "")).toEqual({
      requestKey: REQUEST_KEY,
      action: "job.open",
      input: JOB.input,
    });
    // The challenge request has no body; the paying request has both signatures.
    expect(h.exchanges[1]?.request.body).toBeUndefined();
    const paying = h.exchanges[2]?.request as PaidRequest;
    expect(paying.headers["payment-signature"]).toBe(state.submit?.paymentHeader);
    expect(paying.body).toBe(state.submit?.body);
    expect(paying.body).toMatch(/^\{"quoteSignature":"0x[0-9a-f]{130}"\}$/);
    for (const e of h.exchanges) expect(e.request.headers.authorization).toBe(`Bearer ${"f".repeat(64)}`);
    // Two signatures, one reservation of exactly the price, nothing given back.
    expect(h.signatures()).toBe(2);
    expect(h.reserved).toEqual([PRICE]);
    expect(h.released).toEqual([]);
  });

  it("pays when the challenge names the order itself, and keeps a copy of what was answered", async () => {
    const live = JSON.parse(raw("challenge-402.json")) as { resourceUrl: string; resource: { url: string } };
    live.resourceUrl = STATUS_URL;
    live.resource.url = STATUS_URL;
    const h = harness((request) =>
      request.url === SUBMIT_URL && request.headers["payment-signature"] === undefined
        ? json(402, live)
        : goodProtocol(request),
    );
    const seen: { requestId: string; body: unknown }[] = [];
    const flow = new PayFlow({ ...h.deps, onChallenge: (answer) => seen.push(answer) });
    const state = newPayState(JOB);
    const outcome = await flow.advance(state, JOB);
    expect(outcome).toEqual({ kind: "admitted", jobId: JOB_ID });
    expect(state.submit?.url).toBe(SUBMIT_URL);
    expect(h.exchanges.map((e) => `${e.request.method} ${e.request.url}`)).toEqual([
      `POST ${QUOTE_URL}`,
      `POST ${SUBMIT_URL}`,
      `POST ${SUBMIT_URL}`,
      `GET ${STATUS_URL}`,
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.requestId).toBe(REQUEST_ID);
    expect((seen[0]?.body as { resourceUrl: string }).resourceUrl).toBe(STATUS_URL);
  });

  it("a copy that cannot be kept does not stop the payment", async () => {
    const h = harness((request) => goodProtocol(request));
    const flow = new PayFlow({
      ...h.deps,
      onChallenge: () => {
        throw new Error("disk full");
      },
    });
    const state = newPayState(JOB);
    expect(await flow.advance(state, JOB)).toEqual({ kind: "admitted", jobId: JOB_ID });
  });

  it("saves the signed bytes before it sends them", async () => {
    const h = harness((request) => goodProtocol(request));
    const state = newPayState(JOB);
    let savedBeforeSend: PayState | undefined;
    const inner = h.deps.http;
    const spying = new PayFlow({
      ...h.deps,
      http: async (request) => {
        if (request.headers["payment-signature"] !== undefined) savedBeforeSend = h.persisted.at(-1);
        return inner(request);
      },
    });
    await spying.advance(state, JOB);
    expect(savedBeforeSend?.stage).toBe("signed");
    expect(savedBeforeSend?.submit?.paymentHeader).toBe(state.submit?.paymentHeader);
    expect(savedBeforeSend?.submit?.body).toBe(state.submit?.body);
    expect(savedBeforeSend?.reserved).toBe(PRICE.toString());
  });

  it("sends the same bytes again when the answer is lost, and never signs twice", async () => {
    let drop = true;
    const h = harness((request) => {
      if (request.headers["payment-signature"] !== undefined && drop) {
        drop = false;
        return new TypeError("fetch failed");
      }
      return goodProtocol(request);
    });
    const state = newPayState(JOB);
    expect(await h.flow.advance(state, JOB)).toEqual({
      kind: "pending",
      why: "the paying request got no answer",
    });
    expect(state.stage).toBe("signed");
    expect(await h.flow.advance(state, JOB)).toEqual({ kind: "admitted", jobId: JOB_ID });

    const paying = h.exchanges.filter((e) => e.request.headers["payment-signature"] !== undefined);
    expect(paying).toHaveLength(2);
    expect(paying[1]?.request).toEqual(paying[0]?.request);
    expect(h.signatures()).toBe(2);
    expect(h.reserved).toEqual([PRICE]);
    expect(h.exchanges.filter((e) => e.request.url === QUOTE_URL)).toHaveLength(1);
  });

  it("carries on after a restart from the saved state, with no signer needed to resend", async () => {
    let drop = true;
    const before = harness((request) => {
      if (request.headers["payment-signature"] !== undefined && drop) {
        drop = false;
        return new TypeError("socket hang up");
      }
      return goodProtocol(request);
    });
    const state = newPayState(JOB);
    await before.flow.advance(state, JOB);
    const saved = JSON.stringify(before.persisted.at(-1));

    // A new process: the state comes back from disk.
    const restored = PayState.parse(JSON.parse(saved));
    const after = harness((request) => goodProtocol(request));
    expect(await after.flow.advance(restored, JOB)).toEqual({ kind: "admitted", jobId: JOB_ID });
    expect(after.signatures()).toBe(0);
    expect(after.reserved).toEqual([]);
    const resent = after.exchanges[0]?.request as PaidRequest;
    const original = before.exchanges.find(
      (e) => e.request.headers["payment-signature"] !== undefined,
    )?.request;
    expect(resent).toEqual(original);
  });

  it("does not sign when the quote's prepared input changed the objective", async () => {
    const h = harness((request) => {
      if (request.url !== QUOTE_URL) return goodProtocol(request);
      const body = load<{ order: { inputJson: string } }>("quote-response.json");
      body.order.inputJson = JSON.stringify({ ...JOB.input, objective: `${OBJECTIVE} (edited)` });
      return json(201, body);
    });
    const state = newPayState(JOB);
    const outcome = await h.flow.advance(state, JOB);
    expect(outcome).toMatchObject({ kind: "failed", code: "prepared_objective_changed", charged: "no" });
    expect(h.signatures()).toBe(0);
    expect(h.reserved).toEqual([]);
    expect(h.exchanges).toHaveLength(1);
  });

  it("does not sign when the challenge's prepared input lost the header", async () => {
    const h = harness((request) => {
      if (request.url === SUBMIT_URL && request.headers["payment-signature"] === undefined) {
        const body = load<{ input: { objective: string } }>("challenge-402.json");
        body.input.objective = SPEC;
        return json(402, body);
      }
      return goodProtocol(request);
    });
    const state = newPayState(JOB);
    expect(await h.flow.advance(state, JOB)).toMatchObject({
      kind: "failed",
      code: "prepared_objective_lost_header",
      charged: "no",
    });
    expect(h.signatures()).toBe(0);
    expect(h.reserved).toEqual([]);
  });

  it.each([
    [
      "pays someone else",
      (c: { accepts: PaymentRequirements[] }) =>
        void ((c.accepts[0] as PaymentRequirements).payTo = RUNNER.toLowerCase()),
    ],
    [
      "asks for more",
      (c: { accepts: PaymentRequirements[] }) =>
        void ((c.accepts[0] as PaymentRequirements).amount = (PRICE * 3n).toString()),
    ],
    [
      "is in another token",
      (c: { accepts: PaymentRequirements[] }) =>
        void ((c.accepts[0] as PaymentRequirements).asset = MAINNET.SIMD.toLowerCase()),
    ],
    [
      "is on another network",
      (c: { accepts: PaymentRequirements[] }) =>
        void ((c.accepts[0] as PaymentRequirements).network = "eip155:8453"),
    ],
  ])("does not sign when accepts[0] %s", async (_note, change) => {
    const h = harness((request) => {
      if (request.url === SUBMIT_URL && request.headers["payment-signature"] === undefined) {
        const body = load<{ accepts: PaymentRequirements[] }>("challenge-402.json");
        change(body);
        return json(402, body);
      }
      return goodProtocol(request);
    });
    const state = newPayState(JOB);
    expect(await h.flow.advance(state, JOB)).toMatchObject({
      kind: "failed",
      code: "challenge_mismatch",
      charged: "no",
    });
    expect(h.signatures()).toBe(0);
    expect(h.reserved).toEqual([]);
  });

  it("does not sign when a spending cap would be exceeded", async () => {
    const h = harness((request) => goodProtocol(request), { reserve: () => false });
    const state = newPayState(JOB);
    expect(await h.flow.advance(state, JOB)).toMatchObject({
      kind: "failed",
      code: "cap_exceeded",
      charged: "no",
    });
    expect(h.signatures()).toBe(0);
    expect(h.exchanges.some((e) => e.request.headers["payment-signature"] !== undefined)).toBe(false);
  });

  it("makes no request at all without a signer", async () => {
    const h = harness((request) => goodProtocol(request), { signer: null });
    const error = await payErrorOfAsync(h.flow.advance(newPayState(JOB), JOB));
    expect(error.code).toBe("sign_refused");
    expect(h.exchanges).toHaveLength(0);
  });

  it("ends the attempt, uncharged, when the action refuses the input", async () => {
    const h = harness(() =>
      json(422, { error: "invalid_input", detail: "objective too vague", problems: [{ code: "x" }] }),
    );
    const state = newPayState(JOB);
    expect(await h.flow.advance(state, JOB)).toMatchObject({
      kind: "failed",
      code: "input_refused",
      charged: "no",
    });
    expect(state.failure?.detail).toContain("objective too vague");
  });

  it("waits, without failing, when the protocol is busy", async () => {
    const h = harness(() => json(503, { error: "paid_request_unavailable" }));
    const state = newPayState(JOB);
    expect((await h.flow.advance(state, JOB)).kind).toBe("pending");
    expect(state.stage).toBe("new");
  });

  it("asks for a new quote, under a new key, when the unpaid quote expired", async () => {
    let quotes = 0;
    const h = harness((request) => {
      if (request.url === QUOTE_URL) {
        quotes++;
        const body = load<{ order: { requestKey: string } }>("quote-response.json");
        body.order.requestKey = (JSON.parse(request.body ?? "{}") as { requestKey: string }).requestKey;
        return json(201, body);
      }
      if (request.url === SUBMIT_URL && request.headers["payment-signature"] === undefined && quotes === 1) {
        return json(410, { error: "quote_expired" });
      }
      return goodProtocol(request);
    });
    const state = newPayState(JOB);
    expect((await h.flow.advance(state, JOB)).kind).toBe("pending");
    expect(state.attempt).toBe(2);
    expect(state.requestKey).toBe(requestKey({ ...CLAIM, attempt: 2 }));
    expect(state.requestKey).not.toBe(REQUEST_KEY);
    expect(state.stage).toBe("new");
    expect(await h.flow.advance(state, JOB)).toEqual({ kind: "admitted", jobId: JOB_ID });
    expect(h.signatures()).toBe(2);
  });

  it("never asks for a new quote while an earlier signed payment could still be settled", async () => {
    const h = harness((request) => {
      if (request.url === STATUS_URL) {
        const body = load<{ status: string }>("status-payment-pending.json");
        body.status = "expired";
        return json(200, body);
      }
      return goodProtocol(request);
    });
    const state = newPayState(JOB);
    const outcome = await h.flow.advance(state, JOB);
    expect(outcome).toEqual({ kind: "pending", why: "an earlier signed payment has not expired yet" });
    expect(state.attempt).toBe(1);
    // Once the permit's deadline has passed it can no longer be settled, and a new quote is safe.
    h.setClock(NOW + 301);
    expect((await h.flow.advance(state, JOB)).kind).toBe("pending");
    expect(state.attempt).toBe(2);
    expect(state.submit).toBeUndefined();
    expect(h.released).toEqual([PRICE]);
  });

  it("gives up after a bounded number of quotes", async () => {
    const h = harness(
      (request) => {
        if (request.url === QUOTE_URL) {
          const body = load<{ order: { requestKey: string } }>("quote-response.json");
          body.order.requestKey = (JSON.parse(request.body ?? "{}") as { requestKey: string }).requestKey;
          return json(201, body);
        }
        return json(410, { error: "quote_expired" });
      },
      { maxAttempts: 3 },
    );
    const state = newPayState(JOB);
    const outcomes = [];
    for (let i = 0; i < 6; i++) outcomes.push((await h.flow.advance(state, JOB)).kind);
    expect(outcomes.at(-1)).toBe("failed");
    expect(state.attempt).toBe(3);
    expect(h.signatures()).toBe(0);
  });

  it("keeps the reservation when admission was refused: the fee is gone", async () => {
    const refused = harness((request) => goodProtocol(request, ["status-refused.json"]));
    const b = newPayState(JOB);
    expect(await refused.flow.advance(b, JOB)).toMatchObject({
      kind: "failed",
      code: "admission_refused",
      charged: "yes",
    });
    expect(refused.released).toEqual([]);
    expect(b.reserved).toBe(PRICE.toString());
  });

  it("quotes again after a failed settlement, once the failed payment's permit has run out", async () => {
    // GET /health counted 28 failed payment attempts in 3,568 on 10 Oct 2026: the settlement
    // reverted, or was sent after the permit's deadline. Nothing is taken, and a new quote does.
    let order = 0;
    const h = harness((request) => {
      if (request.url === QUOTE_URL) {
        order++;
        const body = load<{ order: { requestKey: string; quote: { issuedAt: number; expiresAt: number } } }>(
          "quote-response.json",
        );
        body.order.requestKey = (JSON.parse(request.body ?? "{}") as { requestKey: string }).requestKey;
        if (order > 1) {
          body.order.quote.issuedAt = NOW + 301;
          body.order.quote.expiresAt = NOW + 901;
        }
        return json(201, body);
      }
      if (request.url === SUBMIT_URL && request.headers["payment-signature"] === undefined) {
        const body = load<{ quote: { issuedAt: number; expiresAt: number } }>("challenge-402.json");
        if (order > 1) {
          body.quote.issuedAt = NOW + 301;
          body.quote.expiresAt = NOW + 901;
        }
        return json(402, body);
      }
      if (request.url === STATUS_URL) {
        return json(200, raw(order > 1 ? "status-admitted.json" : "status-payment-failed.json"));
      }
      return goodProtocol(request);
    });
    const state = newPayState(JOB);
    const first = await h.flow.advance(state, JOB);
    expect(first).toEqual({ kind: "pending", why: "an earlier signed payment has not expired yet" });
    expect(state.abandoned).toBe(true);
    expect(state.reservedDay).toBe("2026-10-10");
    expect(h.released).toEqual([]); // the permit is still live: the reservation stands
    // While it lives nothing is sent or signed again, however often the flow is asked.
    await h.flow.advance(state, JOB);
    await h.flow.advance(state, JOB);
    expect(h.signatures()).toBe(2);
    expect(h.exchanges.filter((e) => e.request.headers["payment-signature"] !== undefined)).toHaveLength(1);
    expect(h.log.lines.filter((l) => l.includes("payment ended with nothing taken"))).toHaveLength(1);

    h.setClock(NOW + 301);
    expect((await h.flow.advance(state, JOB)).kind).toBe("pending");
    expect(state.attempt).toBe(2);
    expect(state.abandoned).toBeUndefined();
    expect(h.released).toEqual([PRICE]);
    expect(h.releasedOn).toEqual(["2026-10-10"]); // taken off the day it was booked on
    expect(await h.flow.advance(state, JOB)).toEqual({ kind: "admitted", jobId: JOB_ID });
    expect(h.signatures()).toBe(4);
    expect(h.reserved).toEqual([PRICE, PRICE]);
  });

  it("gives up, uncharged, when settlements keep failing", async () => {
    const h = harness(
      (request) => {
        if (request.url === STATUS_URL) return json(200, raw("status-payment-failed.json"));
        return goodProtocol(request);
      },
      { maxAttempts: 1 },
    );
    const state = newPayState(JOB);
    await h.flow.advance(state, JOB);
    h.setClock(NOW + 301);
    expect(await h.flow.advance(state, JOB)).toMatchObject({
      kind: "failed",
      code: "payment_failed",
      charged: "no",
    });
    expect(h.released).toEqual([PRICE]);
  });

  it("asks the status route, not for a new quote, about an order that is already paid", async () => {
    // The saved payment was lost and the claim taken up from the chain, so the flow starts over
    // with the same key. The order comes back `paid`, and its quote ran out long ago. Reading that
    // as "an unpaid quote that expired" would buy the job a second time.
    const h = harness((request) => {
      if (request.url === QUOTE_URL) {
        const body = load<{ created: boolean; order: { status: string; paidAt: string | null } }>(
          "quote-response.json",
        );
        body.created = false;
        body.order.status = "paid";
        body.order.paidAt = "2026-10-10T20:01:10.000Z";
        return json(200, body);
      }
      return goodProtocol(request);
    });
    h.setClock(NOW + 900); // fifteen minutes after the quote was issued
    const state = newPayState(JOB);
    expect(await h.flow.advance(state, JOB)).toEqual({ kind: "admitted", jobId: JOB_ID });
    expect(state.attempt).toBe(1);
    expect(state.requestKey).toBe(REQUEST_KEY);
    expect(h.signatures()).toBe(0);
    expect(h.exchanges.map((e) => `${e.request.method} ${e.request.url}`)).toEqual([
      `POST ${QUOTE_URL}`,
      `GET ${STATUS_URL}`,
    ]);
  });

  it.each(["payment_pending", "payment_failed"])(
    "likewise for an order whose status is %s, whatever the age of its quote",
    async (status) => {
      const h = harness((request) => {
        if (request.url === QUOTE_URL) {
          const body = load<{ created: boolean; order: { status: string } }>("quote-response.json");
          body.created = false;
          body.order.status = status;
          return json(200, body);
        }
        return goodProtocol(request, ["status-payment-pending.json"]);
      });
      h.setClock(NOW + 900);
      const state = newPayState(JOB);
      expect(await h.flow.advance(state, JOB)).toEqual({ kind: "pending", why: "payment_pending" });
      expect(state.stage).toBe("submitted");
      expect(state.attempt).toBe(1);
      expect(h.signatures()).toBe(0);
    },
  );

  it("signs no second payment while one whose bytes were lost could still be settled", async () => {
    // An earlier run signed a payment and lost its bytes with the store. Its deadline is unknown,
    // but it is always before the quote's expiry: until then, a failed status starts no new quote.
    const h = harness((request) => {
      if (request.url === QUOTE_URL) {
        const body = load<{ created: boolean; order: { status: string } }>("quote-response.json");
        body.created = false;
        body.order.status = "payment_failed";
        return json(200, body);
      }
      if (request.url === STATUS_URL) return json(200, raw("status-payment-failed.json"));
      return goodProtocol(request);
    });
    h.setClock(NOW + 200); // the quote, and with it the lost permit, lives until NOW + 600
    const state = newPayState(JOB);
    const outcome = await h.flow.advance(state, JOB);
    expect(outcome.kind).toBe("pending");
    expect(state.attempt).toBe(1);
    expect(h.signatures()).toBe(0);
    h.setClock(NOW + 601);
    await h.flow.advance(state, JOB);
    expect(state.attempt).toBe(2);
    expect(state.stage).toBe("new");
  });

  it("asks the status route what happened when a resend of the saved bytes is refused", async () => {
    // The first copy got no answer. If it was received and settled, a duplicate is refused because
    // the payment is spent: the refusal says nothing about whether the fee was taken.
    let sends = 0;
    const h = harness((request) => {
      if (request.headers["payment-signature"] !== undefined) {
        sends++;
        return sends === 1
          ? new TypeError("socket hang up")
          : json(402, { error: "payment_rejected", reason: "nonce_already_used" });
      }
      return goodProtocol(request);
    });
    const state = newPayState(JOB);
    expect((await h.flow.advance(state, JOB)).kind).toBe("pending");
    expect(state.sends).toBe(1);
    expect(await h.flow.advance(state, JOB)).toEqual({ kind: "admitted", jobId: JOB_ID });
    expect(state.sends).toBe(2);
    expect(h.released).toEqual([]); // the fee was taken: the reservation stands
    expect(h.signatures()).toBe(2);
    expect(h.log.lines.some((l) => l.includes("a resend of the paying request was refused"))).toBe(true);
  });

  it("counts a send before it is made, so a crash in between is not taken for a first send", async () => {
    const h = harness((request) => goodProtocol(request));
    const state = newPayState(JOB);
    let countedBeforeSend: number | undefined;
    const flow = new PayFlow({
      ...h.deps,
      http: async (request) => {
        if (request.headers["payment-signature"] !== undefined) countedBeforeSend = h.persisted.at(-1)?.sends;
        return h.deps.http(request);
      },
    });
    await flow.advance(state, JOB);
    expect(countedBeforeSend).toBe(1);
  });

  it("quotes again when a first send is refused for its timing", async () => {
    const h = harness((request) => {
      if (request.headers["payment-signature"] !== undefined) {
        return json(400, { error: "invalid_payment_window", detail: "deadline too close to expiry" });
      }
      if (request.url === STATUS_URL) {
        // The server holds no payment for the order: it is still only quoted.
        const body = load<{ status: string; order: { status: string } }>("status-payment-pending.json");
        body.status = "quoted";
        body.order.status = "quoted";
        return json(200, body);
      }
      return goodProtocol(request);
    });
    const state = newPayState(JOB);
    expect(await h.flow.advance(state, JOB)).toEqual({
      kind: "pending",
      why: "an earlier signed payment has not expired yet",
    });
    expect(state.abandoned).toBe(true);
    // The refused bytes are not sent again.
    await h.flow.advance(state, JOB);
    expect(h.exchanges.filter((e) => e.request.headers["payment-signature"] !== undefined)).toHaveLength(1);
    h.setClock(NOW + 301);
    await h.flow.advance(state, JOB);
    expect(state.attempt).toBe(2);
    expect(h.released).toEqual([PRICE]);
  });

  it("says so, louder each time, when the paid order's status cannot be read", async () => {
    const h = harness((request) => {
      if (request.url === STATUS_URL) return json(404, { error: "order_not_found" });
      return goodProtocol(request);
    });
    const state = newPayState(JOB);
    const outcomes = [];
    for (let i = 0; i < 6; i++) outcomes.push(await h.flow.advance(state, JOB));
    expect(outcomes[0]).toEqual({
      kind: "pending",
      why: "status answered 404 order_not_found",
      unreadable: 1,
    });
    expect(outcomes[5]).toMatchObject({ kind: "pending", unreadable: 6 });
    const said = h.log.lines.filter((l) => l.includes("the paid order's status cannot be read"));
    expect(said).toHaveLength(6);
    expect(said.slice(0, 4).every((l) => l.includes('"level":"warn"'))).toBe(true);
    expect(said.slice(4).every((l) => l.includes('"level":"error"'))).toBe(true);
    expect(said[0]).toContain("IMD_PAID_TOKEN");
    expect(state.statusFailures).toBe(6);
    expect(h.signatures()).toBe(2); // nothing was signed again
  });

  it("reports an answer in an unknown shape the same way, and a busy protocol only if it lasts", async () => {
    const odd = harness((request) => {
      if (request.url === STATUS_URL) return json(200, { status: "something_new" });
      return goodProtocol(request);
    });
    expect(await odd.flow.advance(newPayState(JOB), JOB)).toEqual({
      kind: "pending",
      why: "status answered in an unexpected shape",
      unreadable: 1,
    });
    expect(odd.log.lines.some((l) => l.includes("status cannot be read"))).toBe(true);

    const busy = harness((request) => {
      if (request.url === STATUS_URL) return json(503, { error: "paid_request_unavailable" });
      return goodProtocol(request);
    });
    const state = newPayState(JOB);
    await busy.flow.advance(state, JOB);
    await busy.flow.advance(state, JOB);
    expect(busy.log.lines.some((l) => l.includes("status cannot be read"))).toBe(false);
    await busy.flow.advance(state, JOB);
    expect(busy.log.lines.some((l) => l.includes("status cannot be read"))).toBe(true);
  });

  it("forgets the count once the status can be read again", async () => {
    let broken = true;
    const h = harness((request) => {
      if (request.url === STATUS_URL && broken) return json(404, { error: "order_not_found" });
      return goodProtocol(request, ["status-payment-pending.json"]);
    });
    const state = newPayState(JOB);
    await h.flow.advance(state, JOB);
    expect(state.statusFailures).toBe(1);
    broken = false;
    await h.flow.advance(state, JOB);
    expect(state.statusFailures).toBeUndefined();
  });

  it("does not sign while it is told the payment should wait", async () => {
    let reason: string | null = "the network asks 90 gwei per gas; the cap is 30";
    const h = harness((request) => goodProtocol(request), { mayPay: async () => reason });
    const state = newPayState(JOB);
    expect(await h.flow.advance(state, JOB)).toEqual({
      kind: "pending",
      why: "not paying yet: the network asks 90 gwei per gas; the cap is 30",
    });
    expect(h.signatures()).toBe(0);
    expect(h.reserved).toEqual([]);
    expect(state.stage).toBe("quoted");
    reason = null;
    expect(await h.flow.advance(state, JOB)).toEqual({ kind: "admitted", jobId: JOB_ID });
  });

  it("asks for another quote, not for the order back, when the guard refuses a signature", async () => {
    // The clock moves between the check of the challenge and the payment library reading it: the
    // permit would now outlive the quote, the guard refuses, and nothing was sent.
    const h = harness((request) => goodProtocol(request));
    const real = h.deps.now;
    let calls = 0;
    const flow = new PayFlow({
      ...h.deps,
      // The fourth reading of the clock is the one taken as the signing time.
      now: () => {
        calls++;
        return real();
      },
    });
    const state = newPayState(JOB);
    // Make the library's own clock run 400 seconds ahead of the flow's.
    vi.setSystemTime((NOW + 400) * 1000);
    const outcome = await flow.advance(state, JOB);
    expect(calls).toBeGreaterThan(0);
    expect(outcome.kind).toBe("pending");
    expect(state.attempt).toBe(2);
    expect(state.submit).toBeUndefined();
    expect(h.released).toEqual([PRICE]);
    expect(h.exchanges.some((e) => e.request.headers["payment-signature"] !== undefined)).toBe(false);
  });

  it("treats a rejected payment as uncharged and does not sign again for the same order", async () => {
    const h = harness((request) => {
      if (request.headers["payment-signature"] !== undefined) {
        return json(402, { error: "payment_rejected", reason: "insufficient_funds" });
      }
      return goodProtocol(request);
    });
    const state = newPayState(JOB);
    expect(await h.flow.advance(state, JOB)).toMatchObject({
      kind: "failed",
      code: "payment_rejected",
      charged: "no",
    });
    expect(h.released).toEqual([PRICE]);
    expect(await h.flow.advance(state, JOB)).toMatchObject({ kind: "failed", code: "payment_rejected" });
    expect(h.signatures()).toBe(2);
  });

  it("polls instead of paying again when the protocol says a payment is already under way", async () => {
    const h = harness((request) => {
      if (request.headers["payment-signature"] !== undefined)
        return json(409, { error: "order_payment_already_started" });
      return goodProtocol(request);
    });
    const state = newPayState(JOB);
    expect(await h.flow.advance(state, JOB)).toEqual({ kind: "admitted", jobId: JOB_ID });
    expect(h.exchanges.filter((e) => e.request.headers["payment-signature"] !== undefined)).toHaveLength(1);
  });

  it("does not send saved bytes to a URL other than the order's own", async () => {
    const before = harness((request) =>
      request.headers["payment-signature"] !== undefined ? new TypeError("lost") : goodProtocol(request),
    );
    const state = newPayState(JOB);
    await before.flow.advance(state, JOB);
    expect(state.stage).toBe("signed");
    // The store file was changed by hand.
    (state.submit as { url: string }).url = "https://elsewhere.example/requests/x/submit";
    const after = harness((request) => goodProtocol(request));
    expect(await after.flow.advance(state, JOB)).toMatchObject({
      kind: "failed",
      code: "challenge_mismatch",
    });
    expect(after.exchanges).toEqual([]);
  });

  it("refuses to continue a saved payment for another objective", async () => {
    const h = harness((request) => goodProtocol(request));
    const state = newPayState(JOB);
    state.objective = `${OBJECTIVE}x`;
    expect((await payErrorOfAsync(h.flow.advance(state, JOB))).code).toBe("challenge_mismatch");
    expect(h.exchanges).toHaveLength(0);
  });

  it("can look at the quote and the challenge without signing anything", async () => {
    const h = harness((request) => goodProtocol(request));
    const state = newPayState(JOB);
    expect(await h.flow.precheck(state, JOB)).toEqual({ ok: true });
    expect(state.stage).toBe("quoted");
    expect(h.signatures()).toBe(0);
    expect(h.reserved).toEqual([]);
    expect(h.exchanges.map((e) => `${e.request.method} ${e.request.url}`)).toEqual([
      `POST ${QUOTE_URL}`,
      `POST ${SUBMIT_URL}`,
    ]);
    expect(h.exchanges.every((e) => e.request.headers["payment-signature"] === undefined)).toBe(true);
    // Asked again, it reads the challenge again and still signs nothing.
    expect(await h.flow.precheck(state, JOB)).toEqual({ ok: true });
    expect(h.signatures()).toBe(0);
    // The order that was looked at is the one that is then paid: no second quote.
    expect(await h.flow.advance(state, JOB)).toEqual({ kind: "admitted", jobId: JOB_ID });
    expect(h.exchanges.filter((e) => e.request.url === QUOTE_URL)).toHaveLength(1);
    expect(h.signatures()).toBe(2);
  });

  it("reports what failed in that look, with nothing signed and nothing reserved", async () => {
    const changed = harness((request) => {
      if (request.url !== QUOTE_URL) return goodProtocol(request);
      const body = load<{ order: { inputJson: string } }>("quote-response.json");
      body.order.inputJson = JSON.stringify({ objective: OBJECTIVE, template: "research" });
      return json(201, body);
    });
    expect(await changed.flow.precheck(newPayState(JOB), JOB)).toMatchObject({
      ok: false,
      retry: false,
      code: "prepared_input_changed",
    });
    expect(changed.signatures()).toBe(0);

    const dear = harness((request) => {
      if (request.url === SUBMIT_URL) {
        const body = load<{ accepts: PaymentRequirements[] }>("challenge-402.json");
        (body.accepts[0] as PaymentRequirements).payTo = RUNNER.toLowerCase();
        return json(402, body);
      }
      return goodProtocol(request);
    });
    expect(await dear.flow.precheck(newPayState(JOB), JOB)).toMatchObject({
      ok: false,
      retry: false,
      code: "challenge_mismatch",
    });
    expect(dear.signatures()).toBe(0);
    expect(dear.reserved).toEqual([]);

    const busy = harness(() => json(503, { error: "paid_request_unavailable" }));
    expect(await busy.flow.precheck(newPayState(JOB), JOB)).toMatchObject({ ok: false, retry: true });
  });

  it("ends in a refusal, not in quotes without end, when the payment window never fits", async () => {
    // A challenge whose window is as long as the quote lives can never be signed safely. Each look
    // asks for one more quote, up to the limit, and then says why.
    const h = harness((request) => {
      if (request.url === QUOTE_URL) {
        const body = load<{ order: { requestKey: string } }>("quote-response.json");
        body.order.requestKey = (JSON.parse(request.body ?? "{}") as { requestKey: string }).requestKey;
        return json(201, body);
      }
      const body = load<{ accepts: PaymentRequirements[] }>("challenge-402.json");
      (body.accepts[0] as PaymentRequirements).maxTimeoutSeconds = 600;
      return json(402, body);
    });
    const state = newPayState(JOB);
    const looks = [];
    for (let i = 0; i < 4; i++) looks.push(await h.flow.precheck(state, JOB));
    expect(looks.slice(0, 3).every((l) => !l.ok && l.retry)).toBe(true);
    expect(looks[3]).toMatchObject({ ok: false, retry: false, code: "challenge_window" });
    expect(h.signatures()).toBe(0);
    expect(h.exchanges.filter((e) => e.request.url === QUOTE_URL)).toHaveLength(4);
  });

  it("derives a later job's request keys apart from the first job's", () => {
    const first = newPayState(JOB);
    const second = newPayState(JOB, 1, 2);
    const third = newPayState(JOB, 1, 3);
    expect(first.series).toBeUndefined();
    expect(second.series).toBe(2);
    expect(new Set([first.requestKey, second.requestKey, third.requestKey]).size).toBe(3);
    // The first job's keys are what they always were.
    expect(first.requestKey).toBe(REQUEST_KEY);
    expect(second.requestKey).toBe(requestKey({ ...CLAIM, attempt: 1, series: 2 }));
    expect(PayState.parse(clone(second)).series).toBe(2);
  });

  it("never writes the token, the key or a signature to the log", async () => {
    const h = harness((request) => goodProtocol(request));
    const state = newPayState(JOB);
    await h.flow.advance(state, JOB);
    const text = h.log.lines.join("\n");
    expect(h.log.lines.length).toBeGreaterThan(0);
    expect(text).not.toContain("f".repeat(64));
    expect(text).not.toContain(TEST_PRIVATE_KEY.slice(2));
    expect(text).not.toContain(state.submit?.paymentHeader ?? "missing");
    expect(text).not.toContain(
      (JSON.parse(state.submit?.body ?? "{}") as { quoteSignature: string }).quoteSignature,
    );
  });
});
