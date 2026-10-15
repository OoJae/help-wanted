/**
 * The first real payment challenge the runner was given, on 13 October 2026, for order 1 of the
 * launched desk (the Doorbell's picture job). It was saved by a `LOOK_ONLY=1` run: nothing was
 * claimed and nothing was paid for it. The answer holds no secret.
 *
 * These tests put that answer through every check and both signatures, with the published test
 * key in the payer's place, so that the code that signs a payment has met a real challenge before
 * it meets one with money behind it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recoverTypedDataAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JOB_TEMPLATES,
  MAINNET,
  buildJobInput,
  parseObjective,
  sameAddress,
  type JobTemplate,
} from "@help-wanted/shared";
import { Challenge } from "@help-wanted/shared/api";
import {
  GuardedSigner,
  QUOTE_APPROVAL_DOMAIN_NAME,
  QUOTE_APPROVAL_DOMAIN_VERSION,
  QUOTE_APPROVAL_TYPES,
  buildSubmit,
  checkChallenge,
  checkPayment,
  checkPreparedInput,
  checkQuote,
  createPayment,
  mainnetTerms,
  quoteApprovalMessage,
  requestUrl,
  signQuoteApproval,
  submitUrl,
} from "../src/pay.js";
import { TEST_ACCOUNT } from "./world.js";

const here = dirname(fileURLToPath(import.meta.url));
const seen = JSON.parse(
  readFileSync(join(here, "fixtures", "live", "challenge-2026-10-13-create-image.json"), "utf8"),
) as { requestId: string; body: unknown; paymentRequired: string | null };

const API = "https://api.imd.fun";
const FEE = 500_000_000_000_000_000n;
const TERMS = mainnetTerms(TEST_ACCOUNT.address, FEE, API);

describe("the live challenge of 13 October 2026", () => {
  const ch = Challenge.parse(seen.body);
  /** A moment inside the quote's life: five seconds after it was issued. */
  const at = ch.quote.issuedAt + 5;
  const objective = (ch.input as { objective: string }).objective;
  const parsed = parseObjective(objective);
  const built = buildJobInput(
    JOB_TEMPLATES["skill:create-image"] as JobTemplate,
    objective,
    parsed?.spec ?? "",
  );
  if (!built.ok) throw new Error(built.reason);
  const expected = { header: objective.slice(0, 85), objective, input: built.input };

  // The payment library reads the clock itself: hold it at the moment the checks are made, inside
  // the quote's life, so that the test means the same thing on any later day.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is the answer for the Doorbell's order, with the header kept byte for byte", () => {
    expect(seen.requestId).toBe(ch.quote.id);
    expect(parsed?.spec.startsWith("Draw the doorbell of the day.")).toBe(true);
    expect(objective.slice(0, 85)).toMatch(/^\[help-wanted order [0-9a-f]{64}\] $/);
    expect((ch.input as { skill: string }).skill).toBe("create-image");
  });

  it("names the order itself as the resource, in both places", () => {
    expect(ch.resourceUrl).toBe(requestUrl(TERMS, seen.requestId));
    expect(ch.resource.url).toBe(requestUrl(TERMS, seen.requestId));
    expect(ch.resourceUrl).not.toBe(submitUrl(TERMS, seen.requestId));
  });

  it("passes the checks made before a claim", () => {
    expect(() => checkQuote(ch.quote, seen.requestId, TERMS, at)).not.toThrow();
    // What the protocol saved is what the runner sends for a picture job; the fields it added
    // (`contracts: []`, `github: false`) hold nothing.
    expect(() => checkPreparedInput(ch.input, expected)).not.toThrow();
    const req = checkChallenge(
      ch,
      { requestId: seen.requestId, quote: ch.quote },
      TERMS,
      expected,
      at,
      seen.paymentRequired,
    );
    expect(req.amount).toBe(FEE.toString());
    expect(sameAddress(req.payTo, MAINNET.FEE_PAYEE)).toBe(true);
    expect(sameAddress(req.asset, MAINNET.IMD)).toBe(true);
    expect(req.maxTimeoutSeconds).toBe(300);
  });

  it("is signed twice and built into the paying request, for the submit route", async () => {
    const req = checkChallenge(
      ch,
      { requestId: seen.requestId, quote: ch.quote },
      TERMS,
      expected,
      at,
      seen.paymentRequired,
    );
    const signer = new GuardedSigner(TEST_ACCOUNT);
    const payment = await createPayment(ch, req, signer, TERMS, at);
    // The payload the strict parser will read: these keys and no others.
    expect(Object.keys(payment).sort()).toEqual(["accepted", "payload", "resource", "x402Version"]);
    expect(payment.resource).toEqual(ch.resource);
    expect(payment.accepted).toEqual(req);
    expect(payment.payload.permit2Authorization.permitted).toEqual({
      token: expect.stringMatching(new RegExp(`^${MAINNET.IMD}$`, "i")) as unknown as string,
      amount: FEE.toString(),
    });
    expect(Number(payment.payload.permit2Authorization.deadline)).toBeLessThan(ch.quote.expiresAt);
    await expect(checkPayment(payment, { req, challenge: ch, terms: TERMS, now: at })).resolves.toEqual(
      payment,
    );

    const quoteSignature = await signQuoteApproval(ch, payment, signer, TERMS);
    const message = quoteApprovalMessage(ch, payment);
    expect(message.resource).toBe(ch.resourceUrl);
    expect(message.quoteId).toBe(seen.requestId);
    expect(
      await recoverTypedDataAddress({
        domain: { name: QUOTE_APPROVAL_DOMAIN_NAME, version: QUOTE_APPROVAL_DOMAIN_VERSION, chainId: 1 },
        types: QUOTE_APPROVAL_TYPES,
        primaryType: "QuoteApproval",
        message,
        signature: quoteSignature,
      }),
    ).toBe(TEST_ACCOUNT.address);

    const submit = buildSubmit(submitUrl(TERMS, seen.requestId), payment, quoteSignature, at);
    expect(submit.url).toBe(`${API}/requests/${seen.requestId}/submit`);
    expect(submit.paymentHeader.length).toBeLessThan(12288);
    expect(submit.amount).toBe(FEE.toString());
  });
});
