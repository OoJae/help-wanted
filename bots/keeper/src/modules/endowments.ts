/**
 * The endowments module: stake what is waiting, and send yield where it belongs.
 *
 * `decideEndowments` is a pure function of a snapshot and the operator's settings. Both calls are
 * open to anyone and move only the endowments' own money: the keeper pays gas and never IMD.
 *
 * stake     `Endowments.stake()` when the buffer is not empty (at least the operator's minimum is
 *           waiting), the gap since the last stake has passed (`nextStakeBlock`), and sIMD's price
 *           is not below the highest the contract has seen (the call would revert `PriceFell`).
 *           For the rest of that block sIMD pays nothing out to the contract, so a harvest decided
 *           in the same pass is sent first.
 * harvest   `Endowments.harvest(id)` when there is something to harvest and the target has room:
 *           `harvestable(id)` is the contract's own figure for both (for a meter it is cut to what
 *           the meter has room for under its thirty-request runway, for a pot to what the pot
 *           still needs), and it must reach the operator's minimum. Not while sIMD is holding the
 *           contract (`vaultHold`), and not in the block of a stake.
 */
import type { Abi, Address, Hex } from "viem";
import { endowmentsAbi } from "@help-wanted/shared";
import type { Action, Decision, Waiting } from "../actions.js";

export const ENDOWMENTS_ABI = endowmentsAbi as unknown as Abi;

/** `Endowments.Kind`. */
export const ENDOWMENT_KIND = { None: 0, Meter: 1, Pot: 2, Recipient: 3 } as const;
const KIND_NAMES = ["none", "meter", "pot", "recipient"];
export const endowmentKindName = (kind: number): string => KIND_NAMES[kind] ?? `kind ${kind}`;

/**
 * A pot harvest reverts `LowGas` unless the pot can be handed its whole allowance: a gas limit of
 * a little over 800,000 today, and 850,000 is the figure launch C's documents give.
 */
export const POT_HARVEST_GAS_FLOOR = 850_000n;

export interface EndowmentsPolicy {
  /** Stake once at least this much IMD is waiting in the buffer. Above zero. */
  stakeMin: bigint;
  /** Harvest an endowment once at least this much IMD can be sent to its target. */
  harvestMin: bigint;
}

export interface EndowmentView {
  id: bigint;
  kind: number;
  /** The feed id (meter) or pot id (pot); zero for a recipient endowment. */
  target: Hex;
  principal: bigint;
  /** `harvestable(id)`: what `harvest` would send now. Zero when it would revert. */
  harvestable: bigint;
}

export interface EndowmentsSnapshot {
  now: bigint;
  block: bigint;
  endowments: Address;
  endowmentCount: bigint;
  /** IMD waiting in the buffer for the next stake. */
  pendingTotal: bigint;
  /** The first block in which `stake` can be called again. */
  nextStakeBlock: bigint;
  /** The block of the last stake. */
  lastStakeBlock: bigint;
  /** True when sIMD's price is below the highest the contract has seen. */
  priceBelowMark: boolean;
  /** True when sIMD will pay nothing out to the contract in this block. */
  vaultHold: boolean;
  list: EndowmentView[];
}

/** State in, actions with reasons out. Pure. */
export function decideEndowments(snapshot: EndowmentsSnapshot, policy: EndowmentsPolicy): Decision {
  const actions: Action[] = [];
  const waiting: Waiting[] = [];
  const call = (functionName: string, args: readonly unknown[] = []) => ({
    address: snapshot.endowments,
    abi: ENDOWMENTS_ABI,
    functionName,
    args,
  });

  if (snapshot.priceBelowMark) {
    waiting.push({
      module: "endowments",
      subject: "endowments",
      reason:
        "sIMD's price is below the highest the contract has seen: stake and harvest both refuse to run until it is back",
      attention: true,
    });
  }

  // Harvests first: a stake in this pass would put the contract on hold for its block.
  for (const e of snapshot.list) {
    if (e.kind === ENDOWMENT_KIND.None || e.harvestable === 0n) continue;
    const subject = `endowment ${e.id}`;
    if (e.harvestable < policy.harvestMin) {
      waiting.push({
        module: "endowments",
        subject,
        reason: `${e.harvestable} IMD can be harvested to its ${endowmentKindName(e.kind)}; it is sent once at least ${policy.harvestMin} can be`,
      });
      continue;
    }
    if (snapshot.priceBelowMark) continue;
    if (snapshot.vaultHold || snapshot.block <= snapshot.lastStakeBlock) {
      waiting.push({
        module: "endowments",
        subject,
        reason: `${e.harvestable} IMD can be harvested, and sIMD is holding the contract in this block: it is sent on the next pass`,
      });
      continue;
    }
    actions.push({
      module: "endowments",
      kind: "harvest",
      subject,
      label: `harvest endowment ${e.id}`,
      reason: `${e.harvestable} IMD of yield can be sent to its ${endowmentKindName(e.kind)} now: there is something to harvest and the target has room for it`,
      call: call("harvest", [e.id]),
      ...(e.kind === ENDOWMENT_KIND.Pot ? { gasFloor: POT_HARVEST_GAS_FLOOR } : {}),
    });
  }

  if (snapshot.pendingTotal > 0n) {
    if (snapshot.pendingTotal < policy.stakeMin) {
      waiting.push({
        module: "endowments",
        subject: "stake",
        reason: `${snapshot.pendingTotal} IMD waits unstaked; it is staked once at least ${policy.stakeMin} is waiting`,
      });
    } else if (snapshot.block < snapshot.nextStakeBlock) {
      waiting.push({
        module: "endowments",
        subject: "stake",
        reason: `${snapshot.pendingTotal} IMD waits unstaked; the next stake is possible from block ${snapshot.nextStakeBlock}`,
        until: Number(snapshot.now + (snapshot.nextStakeBlock - snapshot.block) * 12n),
      });
    } else if (!snapshot.priceBelowMark) {
      actions.push({
        module: "endowments",
        kind: "stake",
        subject: "stake",
        label: "stake the endowments' buffer",
        reason: `${snapshot.pendingTotal} IMD waits unstaked and the gap since the last stake (block ${snapshot.lastStakeBlock}) has passed`,
        call: call("stake"),
      });
    }
  }
  return { actions, waiting };
}
