/** Reads everything `decideEndowments` needs, at one block. Sends nothing. */
import type { Address, Hex } from "viem";
import {
  ENDOWMENTS_ABI,
  ENDOWMENT_KIND,
  type EndowmentView,
  type EndowmentsSnapshot,
} from "../modules/endowments.js";
import { messageOf, readAt, type ObserveContext } from "./common.js";
import { big, num } from "./questions.js";

export interface EndowmentsTargets {
  endowments: Address;
  /** The most endowments read in one pass. */
  maxEndowments: number;
}

/** Reads the snapshot `decideEndowments` takes. Sends nothing. */
export async function observeEndowments(
  ctx: ObserveContext,
  targets: EndowmentsTargets,
): Promise<EndowmentsSnapshot> {
  const { endowments } = targets;
  const read = (name: string, args: readonly unknown[] = []) =>
    readAt(ctx, endowments, ENDOWMENTS_ABI, name, args);
  const [count, pendingTotal, nextStakeBlock, lastStakeBlock] = await Promise.all([
    read("endowmentCount"),
    read("pendingTotal"),
    read("nextStakeBlock"),
    read("lastStakeBlock"),
  ]);
  // Both ask sIMD. If the vault cannot be read the contract's own calls would fail too: say so by
  // treating the price as fallen, which keeps the keeper from sending either.
  let priceBelowMark = false;
  let vaultHold = false;
  try {
    [priceBelowMark, vaultHold] = (await Promise.all([read("priceBelowMark"), read("vaultHold")])) as [
      boolean,
      boolean,
    ];
  } catch (error) {
    ctx.log.warn("could not read sIMD through Endowments; nothing is staked or harvested this pass", {
      error: messageOf(error),
    });
    priceBelowMark = true;
  }
  const endowmentCount = big(count);
  const ids: bigint[] = [];
  for (let id = 1n; id <= endowmentCount && ids.length < targets.maxEndowments; id++) ids.push(id);
  const list: EndowmentView[] = [];
  for (const id of ids) {
    const e = (await read("endowment", [id])) as readonly unknown[];
    const kind = num(e[0]);
    if (kind === ENDOWMENT_KIND.None) continue;
    let harvestable = 0n;
    try {
      harvestable = big(await read("harvestable", [id]));
    } catch (error) {
      // A meter endowment's figure reverts when Questions cannot be read: nothing to send then.
      ctx.log.debug("could not read what an endowment can harvest", {
        endowment: id.toString(),
        error: messageOf(error),
      });
    }
    list.push({ id, kind, target: e[1] as Hex, principal: big(e[3]), harvestable });
  }
  return {
    now: ctx.block.timestamp,
    block: ctx.block.number,
    endowments,
    endowmentCount,
    pendingTotal: big(pendingTotal),
    nextStakeBlock: big(nextStakeBlock),
    lastStakeBlock: big(lastStakeBlock),
    priceBelowMark,
    vaultHold,
    list,
  };
}
