/**
 * The pots module: crowd pots that are ready to hire, and pots whose order has ended.
 *
 * `decidePots` is a pure function of a snapshot and nothing else. Every call it asks for is open
 * to any caller and moves only the pot's own money: the keeper pays gas and never IMD.
 *
 * launch        a pot that is full and has not been launched, until one day after its deadline
 *               (`CrowdPots.launch(potId, spec)`): its whole amount becomes the escrow of one
 *               order on the desk. The spec text comes from the pot's `SpecPinned` event; the pot
 *               itself keeps only its hash.
 * reconcile     a pot whose stage, as `stageOf` reads it now, is no longer the stage it has stored:
 *               it did not hire in time, or its order was delivered, cancelled or refunded. This
 *               writes the pot's books from the desk's account of the order.
 * claimRefunds  a settled pot with contributors who have something to take back: the refund of a
 *               pot that did not deliver, or the change of one that did. The money only ever goes
 *               to the contributor.
 *
 * What it leaves alone: a pot that is still collecting, a pot whose order a runner holds (the desk
 * module ends a claim that ran out of time, and `reconcile` follows on the next look), and a series,
 * which holds no money itself.
 */
import type { Abi, Address, Hex } from "viem";
import { crowdPotsAbi } from "@help-wanted/shared";
import type { Action, Decision, Waiting } from "../actions.js";

export const POTS_ABI = crowdPotsAbi as unknown as Abi;

/** `CrowdPots.Stage`, in declaration order. */
export const POT_STAGE = {
  None: 0,
  Funding: 1,
  Hiring: 2,
  Delivered: 3,
  Refundable: 4,
  Series: 5,
} as const;
const STAGE_NAMES = ["None", "Funding", "Hiring", "Delivered", "Refundable", "Series"];
export const potStageName = (stage: number): string => STAGE_NAMES[stage] ?? `stage ${stage}`;

/** A launch opens an order on the desk (about 260,000 gas there) and checks what the desk did. */
export const LAUNCH_GAS_FLOOR = 600_000n;

export interface PotsPolicy {
  /** The most contributors paid in one `claimRefunds` call. */
  refundBatch: number;
  /** A refund below this is left for its contributor to claim: it would not be worth the gas. */
  refundMin: bigint;
}

export interface PotView {
  id: bigint;
  /** The stage the pot has stored, which moves lazily. */
  stage: number;
  /** `stageOf(potId)`: the stage `reconcile` would leave it in now. */
  liveStage: number;
  target: bigint;
  raised: bigint;
  /** The last second the pot accepts chips. */
  deadline: bigint;
  specHash: Hex;
  /** The spec text from `SpecPinned`, as hex; null when it could not be found. */
  spec: Hex | null;
  orderId: bigint;
  /** Once settled: IMD still waiting to be claimed. */
  pool: bigint;
  /** Contributors with something to take back now (`refundOf` above zero), and how much. */
  refundable: { contributor: Address; amount: bigint }[];
  /** False when the pot's contributors could not be read from its `ChippedIn` logs. */
  contributorsKnown: boolean;
}

export interface PotsSnapshot {
  now: bigint;
  crowdPots: Address;
  potCount: bigint;
  /** `LAUNCH_GRACE`: how long after its deadline a full pot can still be launched. */
  launchGrace: bigint;
  pots: PotView[];
}

/** State in, actions with reasons out. Pure. */
export function decidePots(snapshot: PotsSnapshot, policy: PotsPolicy): Decision {
  const actions: Action[] = [];
  const waiting: Waiting[] = [];
  const { now } = snapshot;
  const call = (functionName: string, args: readonly unknown[]) => ({
    address: snapshot.crowdPots,
    abi: POTS_ABI,
    functionName,
    args,
  });

  for (const pot of snapshot.pots) {
    const subject = `pot ${pot.id}`;
    const wait = (reason: string, extra: Partial<Waiting> = {}) =>
      waiting.push({ module: "pots", subject, reason, ...extra });
    if (pot.stage === POT_STAGE.Series || pot.stage === POT_STAGE.None) continue;

    if (pot.stage === POT_STAGE.Funding) {
      const full = pot.raised === pot.target;
      const lastLaunch = pot.deadline + snapshot.launchGrace;
      if (full && now <= lastLaunch) {
        if (pot.spec === null) {
          wait(
            `it is full (${pot.raised}) and can be launched until ${lastLaunch}, but its spec text was not found in the SpecPinned logs: launch it by hand, or give the keeper an RPC that serves older logs`,
            { attention: true, until: Number(lastLaunch) },
          );
        } else {
          actions.push({
            module: "pots",
            kind: "launch",
            subject,
            label: `launch pot ${pot.id}`,
            reason: `the pot raised its whole target of ${pot.target} and has not hired: launching turns it into one order on the desk, which is possible until ${lastLaunch}`,
            call: call("launch", [pot.id, pot.spec]),
            gasFloor: LAUNCH_GAS_FLOOR,
          });
        }
        continue;
      }
      if (pot.liveStage === POT_STAGE.Refundable) {
        // Ran out of time: unfilled at its deadline, or full and not launched within the grace.
        refundOrReconcile(pot, "it did not hire in time");
        continue;
      }
      wait(`it has raised ${pot.raised} of ${pot.target} and collects until ${pot.deadline}`, {
        until: Number(pot.deadline),
      });
      continue;
    }

    if (pot.stage === POT_STAGE.Hiring) {
      if (pot.liveStage === POT_STAGE.Delivered) {
        refundOrReconcile(pot, `its order ${pot.orderId} was delivered`);
      } else if (pot.liveStage === POT_STAGE.Refundable) {
        refundOrReconcile(pot, `its order ${pot.orderId} ended without a delivery`);
      } else {
        wait(`it is the employer of order ${pot.orderId}, which has not ended`);
      }
      continue;
    }

    // Settled already (Delivered or Refundable): only refunds are left.
    if (pot.pool > 0n) refundOrReconcile(pot, "its books are settled");
  }

  /**
   * Pays the contributors who have something to take back. `claimRefunds` settles the pot's books
   * itself first, so no separate `reconcile` is needed then; with nobody to pay, `reconcile` alone
   * brings the books up to date.
   */
  function refundOrReconcile(pot: PotView, why: string): void {
    const subject = `pot ${pot.id}`;
    const due = pot.refundable.filter((r) => r.amount >= policy.refundMin && r.amount > 0n);
    if (due.length > 0) {
      const batch = due.slice(0, policy.refundBatch);
      const total = batch.reduce((sum, r) => sum + r.amount, 0n);
      actions.push({
        module: "pots",
        kind: "claimRefunds",
        subject,
        label: `pay ${batch.length} contributor${batch.length === 1 ? "" : "s"} of pot ${pot.id}`,
        reason: `${why}, and ${due.length} contributor${due.length === 1 ? " has" : "s have"} ${
          pot.liveStage === POT_STAGE.Delivered ? "change" : "a refund"
        } to take back (${total} IMD in this call); the money goes to each contributor`,
        call: call("claimRefunds", [pot.id, batch.map((r) => r.contributor)]),
      });
      return;
    }
    if (pot.stage !== pot.liveStage) {
      actions.push({
        module: "pots",
        kind: "reconcile",
        subject,
        label: `settle the books of pot ${pot.id}`,
        reason: `${why}: the pot still reads ${potStageName(pot.stage)} and is ${potStageName(pot.liveStage)} now`,
        call: call("reconcile", [pot.id]),
      });
      return;
    }
    if (!pot.contributorsKnown && pot.pool > 0n) {
      waiting.push({
        module: "pots",
        subject,
        reason: `${pot.pool} IMD waits to be claimed and its contributors could not be read from the ChippedIn logs; each can call claimRefund for itself`,
        attention: true,
      });
    }
  }

  return { actions, waiting };
}
