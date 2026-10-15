/**
 * What happens to one planned call between "the visitor pressed the button" and "it is mined", as a
 * small state machine with no wallet library in it. The wallet island supplies the three things that
 * touch a wallet or a node (`allowance`, `write`, `wait`); the tests supply fakes.
 *
 * The rule it exists to keep: once the wallet has returned a transaction hash, the step can never
 * go back to a state that offers to send again. From that moment the transaction may be pending or
 * mined whatever this page manages to read, and a second send could escrow or approve twice. A
 * receipt that cannot be read leaves the step "unconfirmed", with its hash, and the only thing
 * offered is to look for the receipt again.
 */
import type { Hex } from "viem";

export type StepState =
  | { status: "idle" }
  | { status: "skipped"; note: string }
  | { status: "signing" }
  | { status: "mining"; hash: Hex }
  /** Sent, receipt not read. Not a failure: the transaction may be pending or mined. */
  | { status: "unconfirmed"; hash: Hex; message: string }
  | { status: "done"; hash: Hex; note: string | null }
  /** Nothing of this step is pending on chain. `hash` links a transaction that was mined and reverted, or that took its place. */
  | { status: "failed"; message: string; hash: Hex | null };

/** How a wallet can swap a pending transaction for another with the same nonce. */
export type Replacement = "repriced" | "cancelled" | "replaced";

export interface MinedReceipt {
  status: "success" | "reverted";
  transactionHash: Hex;
}

export interface StepDeps {
  /**
   * A check made before anything is signed: resolves with why the step must not be sent, or null
   * when it may be. A step it refuses fails with nothing sent.
   */
  guard?(): Promise<string | null>;
  /** For an approval: skip it when the allowance already covers the amount. */
  allowance?: { needed: bigint; read(): Promise<bigint> };
  /** True when a contract answers at the target address. Asked before anything is signed. */
  hasCode?(): Promise<boolean>;
  /** Asks the wallet to sign and send; resolves with the hash once the wallet has sent it. */
  write(): Promise<Hex>;
  /**
   * Resolves when the transaction, or one that replaced it, is mined. `onReplaced` is told how it
   * was replaced. Rejects when the receipt could not be read.
   */
  wait(hash: Hex, onReplaced: (reason: Replacement) => void): Promise<MinedReceipt>;
}

export function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const first = message.split("\n")[0] ?? message;
  return first.length > 220 ? `${first.slice(0, 220)}…` : first;
}

/** True only for a state from which sending (again) cannot double anything. */
export function canSend(state: StepState): boolean {
  return state.status === "idle" || state.status === "failed";
}

/** Signs and sends one call, then waits for it. Emits every state on the way; never throws. */
export async function sendStep(deps: StepDeps, emit: (state: StepState) => void): Promise<void> {
  let hash: Hex;
  try {
    if (deps.guard) {
      const refusal = await deps.guard();
      if (refusal) {
        emit({ status: "failed", message: `Not sent: ${refusal}`, hash: null });
        return;
      }
    }
    if (deps.hasCode && !(await deps.hasCode())) {
      emit({
        status: "failed",
        message: "No contract answers at the address this step would call. Nothing was sent.",
        hash: null,
      });
      return;
    }
    if (deps.allowance) {
      const allowed = await deps.allowance.read();
      if (allowed >= deps.allowance.needed) {
        emit({ status: "skipped", note: "Already allowed; nothing to send." });
        return;
      }
    }
    emit({ status: "signing" });
    hash = await deps.write();
  } catch (error) {
    // Nothing left the wallet: a refused signature, a failed read. Sending again is safe.
    emit({ status: "failed", message: shortError(error), hash: null });
    return;
  }
  await confirmStep(hash, deps, emit);
}

/** Waits for a transaction that has been sent. Also what "Check again" runs. Never throws. */
export async function confirmStep(
  hash: Hex,
  deps: Pick<StepDeps, "wait">,
  emit: (state: StepState) => void,
): Promise<void> {
  emit({ status: "mining", hash });
  let replaced: Replacement | null = null;
  let receipt: MinedReceipt;
  try {
    receipt = await deps.wait(hash, (reason) => {
      replaced = reason;
    });
  } catch (error) {
    emit({
      status: "unconfirmed",
      hash,
      message: `Sent, but its receipt could not be read just now (${shortError(error)}). It may be pending or already mined: do not send it again. Check again, or look at the transaction.`,
    });
    return;
  }
  const mined = receipt.transactionHash;
  const swapped = mined.toLowerCase() !== hash.toLowerCase();
  const reason = replaced as Replacement | null;
  if (reason === "cancelled") {
    emit({
      status: "failed",
      message: "You cancelled this transaction in your wallet. This step was not carried out.",
      hash: mined,
    });
    return;
  }
  if (reason === "replaced" || (swapped && reason !== "repriced")) {
    emit({
      status: "failed",
      message: "Your wallet replaced this transaction with a different one. This step was not carried out.",
      hash: mined,
    });
    return;
  }
  if (receipt.status !== "success") {
    emit({
      status: "failed",
      message: "The transaction was mined and reverted. Nothing changed apart from the gas it cost.",
      hash: mined,
    });
    return;
  }
  emit({
    status: "done",
    hash: mined,
    note: swapped ? "Mined after its fee was raised in the wallet." : null,
  });
}
