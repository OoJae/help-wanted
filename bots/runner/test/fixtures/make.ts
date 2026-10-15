/**
 * Writes the hand-built protocol fixtures next to this file.
 *
 *   pnpm --filter @help-wanted/runner exec tsx test/fixtures/make.ts
 *
 * They are NOT recordings. No paid request has been made with this code. Every field follows the
 * published shapes: `components.schemas` of GET https://api.imd.fun/openapi.json (Quote, Order,
 * Challenge, Status) and the examples in IdentityMD's API guide, "How paying works". The values are
 * those of the test world in `../world.ts`.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { API, FEE_PAYEE_LOWER, IMD_LOWER, JOB_ID, NOW, PRICE, REQUEST_ID, REQUEST_KEY, jobInput } from "../world.js";

const here = dirname(fileURLToPath(import.meta.url));
const write = (name: string, value: unknown) => writeFileSync(join(here, name), `${JSON.stringify(value, null, 2)}\n`);

const quote = {
  v: 1,
  id: REQUEST_ID,
  action: "job.open",
  policyVersion: "job-1",
  inputHash: "5c1f0a9e3b7d2468ace013579bdf02468ace13579bdf0246a8c0e2f4b6d8a1c3",
  issuedAt: NOW,
  expiresAt: NOW + 600,
  payment: {
    network: "eip155:1",
    asset: IMD_LOWER,
    amount: PRICE.toString(),
    payTo: FEE_PAYEE_LOWER,
    decimals: 18,
    scheme: "exact",
  },
  terms: { purchase: "action-admission", resultGuaranteed: false },
  quoteHash: "9a3c5e7f1b2d4f6081a2c3e4f506172839a4b5c6d7e8f9011223344556677889",
};

const order = {
  id: REQUEST_ID,
  requestKey: REQUEST_KEY,
  status: "quoted",
  quote,
  inputJson: JSON.stringify(jobInput()),
  createdAt: "2026-10-10T20:00:00.000Z",
  paidAt: null,
};

const resourceUrl = `${API}/requests/${REQUEST_ID}/submit`;

write("quote-response.json", { created: true, order });

write("challenge-402.json", {
  x402Version: 2,
  resource: { url: resourceUrl, description: "IMD paid request: job.open", mimeType: "application/json" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:1",
      asset: IMD_LOWER,
      amount: PRICE.toString(),
      payTo: FEE_PAYEE_LOWER,
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: "permit2" },
    },
  ],
  quote,
  requesterScopeHash: "0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0",
  resourceUrl,
  input: jobInput(),
});

write("status-payment-pending.json", {
  status: "payment_pending",
  order: { ...order, status: "payment_pending" },
  payment: { status: "pending", paid: false, transactionHash: null },
  admission: null,
});

write("status-admitted.json", {
  status: "admitted",
  order: { ...order, status: "paid", paidAt: "2026-10-10T20:01:10.000Z" },
  payment: {
    status: "confirmed",
    paid: true,
    transactionHash: "0x6d1f0e2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6",
  },
  admission: {
    action: "job.open",
    result: {
      kind: "job",
      jobId: JOB_ID,
      launch: false,
      statusUrl: `/jobs/${JOB_ID}`,
      resultUrl: `/jobs/${JOB_ID}/result`,
    },
  },
});

write("status-payment-failed.json", {
  status: "payment_failed",
  order: { ...order, status: "payment_failed" },
  payment: { status: "failed", paid: false, transactionHash: null, reason: "payment_permission_expired" },
  admission: null,
});

write("status-refused.json", {
  status: "admitted",
  order: { ...order, status: "paid", paidAt: "2026-10-10T20:01:10.000Z" },
  payment: {
    status: "confirmed",
    paid: true,
    transactionHash: "0x6d1f0e2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6",
  },
  admission: { action: "job.open", result: { kind: "refused", problems: [{ code: "catalog_changed" }] } },
});

console.log("fixtures written to", here);
