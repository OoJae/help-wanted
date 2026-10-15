/**
 * Reads everything `decidePots` needs, at one block. Sends nothing.
 *
 * A pot keeps only the hash of its spec and no list of its contributors: both are in its events
 * (`SpecPinned`, `ChippedIn`). They are read from the logs only when they are needed (a full pot
 * to launch, a settled pot with something to give back) and then kept in the state file.
 */
import { getAbiItem, type AbiEvent, type Address, type Hex } from "viem";
import { crowdPotsAbi } from "@help-wanted/shared";
import { POTS_ABI, POT_STAGE, type PotView, type PotsSnapshot } from "../modules/pots.js";
import { isDone, markDone } from "../store.js";
import { logsSince, messageOf, readAt, readOnce, type ObserveContext } from "./common.js";
import { big, num } from "./questions.js";

const SPEC_PINNED = getAbiItem({ abi: crowdPotsAbi, name: "SpecPinned" }) as AbiEvent;
const CHIPPED_IN = getAbiItem({ abi: crowdPotsAbi, name: "ChippedIn" }) as AbiEvent;

export interface PotsTargets {
  crowdPots: Address;
  /** The block to read the pots' logs from: the block launch B was mined in. */
  startBlock: bigint;
  /** The most pots read in one pass, and the most contributors asked about per pot. */
  maxPots: number;
  maxContributors: number;
}

interface PotStruct {
  specHash: Hex;
  target: unknown;
  raised: unknown;
  deadline: unknown;
  stage: unknown;
  pool: unknown;
  orderId: unknown;
}

function save(ctx: ObserveContext): void {
  try {
    ctx.store.save();
  } catch (error) {
    ctx.log.debug("the state file could not be written", { error: messageOf(error) });
  }
}

/** The spec text behind a hash, from the pot's `SpecPinned` event. Kept once found. */
async function specOf(ctx: ObserveContext, targets: PotsTargets, specHash: Hex): Promise<Hex | null> {
  const key = `pot-spec:${specHash.toLowerCase()}`;
  const kept = ctx.store.data.texts?.[key];
  if (kept !== undefined) return kept as Hex;
  try {
    const logs = await logsSince(ctx, {
      address: targets.crowdPots,
      event: SPEC_PINNED,
      args: { specHash },
      fromBlock: targets.startBlock,
    });
    const spec = (logs[0]?.args as { spec?: Hex } | undefined)?.spec;
    if (spec === undefined) return null;
    ctx.store.data.texts = { ...(ctx.store.data.texts ?? {}), [key]: spec };
    save(ctx);
    return spec;
  } catch (error) {
    ctx.log.warn("could not read a pot's spec from its SpecPinned log", {
      specHash,
      error: messageOf(error),
    });
    return null;
  }
}

/**
 * Everybody a chip was made for in a pot, from its `ChippedIn` logs. Kept once the pot is past
 * collecting, since no chip can follow. Null when the logs cannot be read.
 */
async function contributorsOf(
  ctx: ObserveContext,
  targets: PotsTargets,
  potId: bigint,
  collecting: boolean,
): Promise<Address[] | null> {
  const kept = ctx.store.data.chips?.[potId.toString()];
  if (kept !== undefined) return kept as Address[];
  try {
    const logs = await logsSince(ctx, {
      address: targets.crowdPots,
      event: CHIPPED_IN,
      args: { potId },
      fromBlock: targets.startBlock,
    });
    const seen = new Set<string>();
    const out: Address[] = [];
    for (const log of logs) {
      const who = (log.args as { beneficiary?: Address } | undefined)?.beneficiary;
      if (who === undefined || seen.has(who.toLowerCase())) continue;
      seen.add(who.toLowerCase());
      out.push(who);
    }
    if (!collecting) {
      ctx.store.data.chips = { ...(ctx.store.data.chips ?? {}), [potId.toString()]: out };
      save(ctx);
    }
    return out;
  } catch (error) {
    ctx.log.warn("could not read a pot's contributors from its ChippedIn logs", {
      pot: potId.toString(),
      error: messageOf(error),
    });
    return null;
  }
}

/** Reads the snapshot `decidePots` takes. Sends nothing. */
export async function observePots(ctx: ObserveContext, targets: PotsTargets): Promise<PotsSnapshot> {
  const { crowdPots } = targets;
  const state = ctx.store.data;
  const now = ctx.block.timestamp;
  const [potCount, launchGrace] = await Promise.all([
    readAt(ctx, crowdPots, POTS_ABI, "potCount"),
    readOnce<unknown>(ctx, crowdPots, POTS_ABI, "LAUNCH_GRACE"),
  ]);
  const count = big(potCount);
  const live: bigint[] = [];
  for (let id = 1n; id <= count && live.length < targets.maxPots; id++) {
    if (!isDone(state, "pots", id)) live.push(id);
  }
  const reads = (await Promise.all(
    live.flatMap((id) => [
      readAt(ctx, crowdPots, POTS_ABI, "potOf", [id]),
      readAt(ctx, crowdPots, POTS_ABI, "stageOf", [id]),
    ]),
  )) as (PotStruct | unknown)[];

  const pots: PotView[] = [];
  let changed = false;
  for (let i = 0; i < live.length; i++) {
    const id = live[i] as bigint;
    const p = reads[2 * i] as PotStruct;
    const stage = num(p.stage);
    const liveStage = num(reads[2 * i + 1]);
    const pool = big(p.pool);
    const settled = stage === POT_STAGE.Delivered || stage === POT_STAGE.Refundable;
    // A series holds no money, and a settled pot with an empty pool has paid everybody.
    if (stage === POT_STAGE.Series || stage === POT_STAGE.None || (settled && pool === 0n)) {
      changed = markDone(state, "pots", id) || changed;
      continue;
    }
    const target = big(p.target);
    const raised = big(p.raised);
    const deadline = big(p.deadline);
    const view: PotView = {
      id,
      stage,
      liveStage,
      target,
      raised,
      deadline,
      specHash: p.specHash,
      spec: null,
      orderId: big(p.orderId),
      pool,
      refundable: [],
      contributorsKnown: true,
    };
    const launchable = stage === POT_STAGE.Funding && raised === target && now <= deadline + big(launchGrace);
    if (launchable) view.spec = await specOf(ctx, targets, p.specHash);

    const over = liveStage === POT_STAGE.Delivered || liveStage === POT_STAGE.Refundable;
    if (over && !launchable) {
      const contributors = await contributorsOf(ctx, targets, id, stage === POT_STAGE.Funding);
      if (contributors === null) {
        view.contributorsKnown = false;
      } else {
        const asked = contributors.slice(0, targets.maxContributors);
        const amounts = (await Promise.all(
          asked.map((who) => readAt(ctx, crowdPots, POTS_ABI, "refundOf", [id, who])),
        )) as unknown[];
        asked.forEach((contributor, n) => {
          const amount = big(amounts[n]);
          if (amount > 0n) view.refundable.push({ contributor, amount });
        });
      }
    }
    pots.push(view);
  }
  if (changed) save(ctx);
  return { now, crowdPots, potCount: count, launchGrace: big(launchGrace), pots };
}
