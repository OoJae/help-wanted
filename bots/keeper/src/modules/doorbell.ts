/**
 * The doorbell module: nothing automatic.
 *
 * Ringing is for people: every 25th ring spends the Doorbell's IMD on a picture, and a keeper that
 * rang on a timer would turn a demonstration into a subscription. This module reads the Doorbell
 * and says in the status file where it stands: how many rings until the next hire, whether it
 * holds enough for one, and what its last order is doing. The desk module keeps the Doorbell's
 * orders like any others (refund, evict, the watch on delivery claims).
 */
import type { Address, Hex } from "viem";
import type { Decision, Waiting } from "../actions.js";

export interface DoorbellSnapshot {
  doorbell: Address;
  workOrders: Address;
  rings: bigint;
  hires: bigint;
  receipts: bigint;
  ringsUntilHire: bigint;
  /** Whether it holds enough IMD for the next 25th ring to hire. */
  funded: boolean;
  balance: bigint;
  /** What one order escrows. */
  maxPay: bigint;
  minPay: bigint;
  bond: bigint;
  deliverySecs: bigint;
  kindHash: Hex;
  /** Whether its orders accept a bonded delivery claim when there is no receipt. */
  allowClaimed: boolean;
  lastOrderId: bigint;
  /** The desk's state of its last order, by name; null before the first hire. */
  lastOrderState: string | null;
}

/** State in, notes out. It never asks for a transaction. */
export function decideDoorbell(snapshot: DoorbellSnapshot): Decision {
  const waiting: Waiting[] = [];
  const note = (reason: string, attention = false) =>
    waiting.push({ module: "doorbell", subject: "doorbell", reason, ...(attention ? { attention } : {}) });
  if (!snapshot.funded) {
    note(
      `it holds ${snapshot.balance} IMD, less than the ${snapshot.maxPay} one order escrows: the next 25th ring is counted and hires nothing until it is funded by a plain transfer`,
    );
  } else {
    note(
      `${snapshot.ringsUntilHire} ring${snapshot.ringsUntilHire === 1n ? "" : "s"} until the next hire; it holds ${snapshot.balance} IMD, enough for ${snapshot.maxPay === 0n ? 0n : snapshot.balance / snapshot.maxPay} order${snapshot.balance / (snapshot.maxPay === 0n ? 1n : snapshot.maxPay) === 1n ? "" : "s"}. Ringing is left to people`,
    );
  }
  if (snapshot.allowClaimed) {
    note(
      "its orders accept delivery claims without a receipt: each claim on them is checked by the desk module, and a challenge needs CHALLENGE_FLOAT_IMD",
    );
  }
  return { actions: [], waiting };
}
