/**
 * The fixed little world the runner tests live in: one desk, one order, one claim, one test wallet.
 *
 * THE TEST KEY. `TEST_PRIVATE_KEY` is account 0 of Foundry's Anvil and of Hardhat, printed in their
 * documentation and known to everyone. It is used here only to make signatures that tests then
 * verify. It must never hold anything, and `loadConfig` refuses to go live with it.
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import {
  MAINNET,
  buildJobInput,
  JOB_TEMPLATES,
  orderHeader,
  orderTicket,
  type JobTemplate,
} from "@help-wanted/shared";
import { mainnetTerms, requestKey, type PayJob, type PayTerms } from "../src/pay.js";

export const TEST_PRIVATE_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVATE_KEY);
export const RUNNER: Address = TEST_ACCOUNT.address;

export const DESK: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
export const EMPLOYER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const ORDER_ID = 7n;
export const CLAIM_SEQ = 1;
export const API = "https://api.imd.fun";
/** 2026-10-10T20:00:00Z. */
export const NOW = 1_791_662_400;
export const PRICE = 500_000_000_000_000_000n;

export const SPEC =
  "Write a sourced report on who paid the IdentityMD swarm this week and for what. Use on-chain IMD transfers only.";
export const TEMPLATE = JOB_TEMPLATES["skill:research-report"] as JobTemplate;

export const CLAIM = { chainId: 1, workOrders: DESK, orderId: ORDER_ID, claimSeq: CLAIM_SEQ, runner: RUNNER };
export const TICKET = orderTicket(CLAIM);
export const HEADER = orderHeader(TICKET);
export const OBJECTIVE = HEADER + SPEC;

export function jobInput(): Record<string, unknown> {
  const built = buildJobInput(TEMPLATE, OBJECTIVE, SPEC);
  if (!built.ok) throw new Error(built.reason);
  return built.input;
}

export const JOB: PayJob = { claim: CLAIM, header: HEADER, objective: OBJECTIVE, input: jobInput() };
export const TERMS: PayTerms = mainnetTerms(RUNNER, PRICE, API);
export const REQUEST_KEY = requestKey({ ...CLAIM, attempt: 1 });

/** The id IdentityMD would give the paid order; any UUID will do. */
export const REQUEST_ID = "3f1c2b4a-9d7e-4c6f-8a1b-2e3d4c5b6a79";
export const JOB_ID = "8d2f6c1e-4b3a-4f5d-9c7e-1a2b3c4d5e6f";
export const FEE_PAYEE_LOWER = MAINNET.FEE_PAYEE.toLowerCase();
export const IMD_LOWER = MAINNET.IMD.toLowerCase();
