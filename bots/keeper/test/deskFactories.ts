/** Snapshots for the decision tests of the modules of launches B and C. Nothing here reaches a node. */
import { keccak256, stringToBytes, toHex, type Address, type Hex } from "viem";
import {
  ORDER_STATE,
  canonicalize,
  kindHash,
  orderHeader,
  orderTicket,
  judgeRecord,
  specHash,
} from "@help-wanted/shared";
import type {
  ClaimEvidence,
  DeskOrderView,
  DeskPolicy,
  DeskSnapshot,
  ReceiptView,
} from "../src/modules/desk.js";

export const DESK: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
export const IMD_TOKEN: Address = "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7";
export const KEEPER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const RUNNER: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
export const EMPLOYER: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
export const OTHER: Address = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

export const NOW = 1_791_900_000n;
export const DAY = 86_400n;
export const BOND = 25n * 10n ** 16n;
export const IMD = (tenths: number): bigint => BigInt(tenths) * 10n ** 17n;
export const SPEC = "Write a sourced report on who paid the swarm this week.";
export const KIND = "skill:research-report";
export const JOB = "8d2f6c1e-4b3a-4f5d-9c7e-1a2b3c4d5e6f";

export const ticketOf = (id: bigint, seq = 1, runner: Address = RUNNER): Hex =>
  orderTicket({ chainId: 1, workOrders: DESK, orderId: id, claimSeq: seq, runner });

/** A canonical work record for a job of an order. */
export function record(
  over: { id?: bigint; jobId?: string; objective?: string; kind?: string; state?: string } = {},
): Uint8Array {
  return stringToBytes(
    canonicalize({
      assessments: [],
      jobId: over.jobId ?? JOB,
      kind: over.kind ?? KIND,
      nodes: [],
      objective: over.objective ?? orderHeader(ticketOf(over.id ?? 7n)) + SPEC,
      schema: "identitymd-work-v1",
      signals: [{ agentId: "52211", value: 1 }],
      state: over.state ?? "completed",
      submissions: [],
    }),
  );
}

/** A receipt the registry holds for an order's job, read as the desk would read it. */
export function receipt(
  order: Pick<DeskOrderView, "id" | "kindHash" | "specHash" | "ticket">,
  bytes?: Uint8Array,
): ReceiptView {
  const raw = bytes ?? record({ id: order.id });
  return {
    kind: "read",
    hash: keccak256(raw),
    record: toHex(raw),
    bytes: raw.length,
    verdict: judgeRecord(
      { jobId: JOB, ticket: order.ticket, specHash: order.specHash, kindHash: order.kindHash },
      raw,
    ),
  };
}

/** What the API says about a job that really is the order's, with the named record listed. */
export function evidence(
  order: Pick<DeskOrderView, "ticket" | "claim">,
  over: Partial<{
    state: string;
    template: string | null;
    objective: string;
    hashes: Hex[];
  }> = {},
): ClaimEvidence {
  return {
    job: {
      kind: "read",
      state: over.state ?? "completed",
      template: over.template === undefined ? KIND : over.template,
      objective: over.objective ?? orderHeader(order.ticket) + SPEC,
    },
    records: { kind: "read", hashes: over.hashes ?? [order.claim.recordHash] },
  };
}

/** An open order nobody holds, expiring in a week. */
export function order(
  id = 7n,
  over: Partial<DeskOrderView> = {},
  claim: Partial<DeskOrderView["claim"]> = {},
): DeskOrderView {
  return {
    id,
    state: ORDER_STATE.Open,
    employer: EMPLOYER,
    expiresAt: NOW + 7n * DAY,
    flags: 1,
    kindHash: kindHash(KIND),
    specHash: specHash(SPEC),
    deliverySecs: 7n * DAY,
    bond: BOND,
    arbiter: ZERO,
    seq: 1,
    proven: false,
    conditional: false,
    condMet: true,
    condHoldsNow: true,
    claim: {
      runner: ZERO,
      claimedAt: 0n,
      registeredAt: 0n,
      jobId: null,
      challenger: ZERO,
      assertedAt: 0n,
      recordHash: ZERO_HASH,
      ...claim,
    },
    ticket: ticketOf(id, over.seq ?? 1, (claim.runner as Address | undefined) ?? RUNNER),
    receipt: null,
    evidence: null,
    failingSince: null,
    knownTrue: false,
    ...over,
  };
}

/** An order a runner claimed `age` seconds ago and has registered no job for. */
export const claimed = (age: bigint, over: Partial<DeskOrderView> = {}): DeskOrderView =>
  order(7n, { state: ORDER_STATE.Claimed, ...over }, { runner: RUNNER, claimedAt: NOW - age });

/** An order whose job was registered `age` seconds ago. */
export const registered = (age: bigint, over: Partial<DeskOrderView> = {}): DeskOrderView =>
  order(
    7n,
    { state: ORDER_STATE.Registered, receipt: { kind: "none" }, ...over },
    { runner: RUNNER, claimedAt: NOW - age - 600n, registeredAt: NOW - age, jobId: JOB },
  );

/** An order whose delivery was claimed `age` seconds ago, on a job registered an hour before that. */
export function asserted(
  age: bigint,
  over: Partial<DeskOrderView> = {},
  claim: Partial<DeskOrderView["claim"]> = {},
): DeskOrderView {
  const named = keccak256(record());
  const view = order(
    7n,
    { state: ORDER_STATE.Asserted, receipt: { kind: "none" }, ...over },
    {
      runner: RUNNER,
      claimedAt: NOW - age - 4_200n,
      registeredAt: NOW - age - 3_600n,
      jobId: JOB,
      assertedAt: NOW - age,
      recordHash: named,
      ...claim,
    },
  );
  if (view.evidence === null && over.evidence === undefined) view.evidence = evidence(view);
  return view;
}

export const deskPolicy = (over: Partial<DeskPolicy> = {}): DeskPolicy => ({
  keeper: KEEPER,
  challengeFloat: IMD(10),
  challengeDailyCap: IMD(5),
  challengeArbiters: new Set(),
  challengeEmployers: new Set(),
  challengeConfirmSeconds: 900,
  ownRunners: new Set(),
  maxRecordBytes: 100_000,
  finalizeClaims: true,
  settleReceipts: true,
  ...over,
});

export function desk(orders: DeskOrderView[], over: Partial<DeskSnapshot> = {}): DeskSnapshot {
  return {
    now: NOW,
    block: 26_200_000n,
    chainId: 1,
    workOrders: DESK,
    imd: IMD_TOKEN,
    orderCount: BigInt(orders.length),
    orders,
    keeperImd: IMD(20),
    keeperAllowance: 0n,
    challengedToday: 0n,
    receiptsFlowing: false,
    ...over,
  };
}
