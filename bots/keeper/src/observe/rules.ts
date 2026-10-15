/**
 * Reads everything `decideRules` needs, at one block. Sends nothing.
 *
 * A HIRE rule keeps only the hash of its job text, and nothing lists the orders a rule opened:
 * both are in the contract's events (`RuleCreated`, `Fired`). The job text is read from the logs
 * when a rule can be fired, and kept. The orders are read as the `Fired` logs come in, from where
 * the last pass stopped.
 */
import { getAbiItem, type Abi, type AbiEvent, type Address, type Hex } from "viem";
import { isTerminalOrderState, rulesAbi, workOrdersAbi } from "@help-wanted/shared";
import {
  RULES_ABI,
  RULE_ACTION,
  RULE_STATUS,
  type RuleOrderView,
  type RuleView,
  type RulesSnapshot,
} from "../modules/rules.js";
import { isDone, markDone } from "../store.js";
import { logsSince, messageOf, readAt, type ObserveContext } from "./common.js";
import { big, num } from "./questions.js";

const DESK_ABI = workOrdersAbi as unknown as Abi;
const RULE_CREATED = getAbiItem({ abi: rulesAbi, name: "RuleCreated" }) as AbiEvent;
const FIRED = getAbiItem({ abi: rulesAbi, name: "Fired" }) as AbiEvent;

export interface RulesTargets {
  rules: Address;
  workOrders: Address;
  /** The block to read the rules' logs from: the block launch C was mined in. */
  startBlock: bigint;
  maxRules: number;
}

interface RuleStruct {
  creator: Address;
  tip: unknown;
  action: unknown;
  cancelled: boolean;
  cooldown: unknown;
  maxFires: unknown;
  escrow: unknown;
  fires: unknown;
  lastFiredAt: unknown;
}

function save(ctx: ObserveContext): void {
  try {
    ctx.store.save();
  } catch (error) {
    ctx.log.debug("the state file could not be written", { error: messageOf(error) });
  }
}

/** A HIRE rule's job text, from its `RuleCreated` event. Kept once found. */
async function specOf(ctx: ObserveContext, targets: RulesTargets, id: bigint): Promise<Hex | null> {
  const key = `rule-spec:${targets.rules.toLowerCase()}:${id}`;
  const kept = ctx.store.data.texts?.[key];
  if (kept !== undefined) return kept as Hex;
  try {
    const logs = await logsSince(ctx, {
      address: targets.rules,
      event: RULE_CREATED,
      args: { id },
      fromBlock: targets.startBlock,
    });
    const spec = (logs[0]?.args as { spec?: Hex } | undefined)?.spec;
    if (spec === undefined) return null;
    ctx.store.data.texts = { ...(ctx.store.data.texts ?? {}), [key]: spec };
    save(ctx);
    return spec;
  } catch (error) {
    ctx.log.warn("could not read a rule's job text from its RuleCreated log", {
      rule: id.toString(),
      error: messageOf(error),
    });
    return null;
  }
}

/** Reads the `Fired` logs since the last pass and notes which order each fire opened. */
async function readFires(ctx: ObserveContext, targets: RulesTargets): Promise<void> {
  const state = ctx.store.data;
  const key = `rules:${targets.rules.toLowerCase()}`;
  const from = state.cursors?.[key] === undefined ? targets.startBlock : BigInt(state.cursors[key]) + 1n;
  if (from > ctx.block.number) return;
  const logs = await logsSince(ctx, { address: targets.rules, event: FIRED, fromBlock: from });
  const found: Record<string, string> = {};
  for (const log of logs) {
    const args = log.args as { id?: bigint; orderId?: bigint } | undefined;
    if (args?.id === undefined || args.orderId === undefined || args.orderId === 0n) continue;
    found[args.orderId.toString()] = args.id.toString();
  }
  state.ruleOrders = { ...(state.ruleOrders ?? {}), ...found };
  state.cursors = { ...(state.cursors ?? {}), [key]: ctx.block.number.toString() };
  save(ctx);
}

/** Reads the snapshot `decideRules` takes. Sends nothing. */
export async function observeRules(ctx: ObserveContext, targets: RulesTargets): Promise<RulesSnapshot> {
  const { rules, workOrders } = targets;
  const state = ctx.store.data;
  const now = ctx.block.timestamp;
  const ruleCount = big(await readAt(ctx, rules, RULES_ABI, "ruleCount"));

  const live: bigint[] = [];
  for (let id = 1n; id <= ruleCount && live.length < targets.maxRules; id++) {
    if (!isDone(state, "rules", id)) live.push(id);
  }
  const reads = (await Promise.all(
    live.flatMap((id) => [
      readAt(ctx, rules, RULES_ABI, "statusOf", [id]),
      readAt(ctx, rules, RULES_ABI, "getRule", [id]),
      readAt(ctx, rules, RULES_ABI, "costOf", [id]),
      readAt(ctx, rules, RULES_ABI, "canFire", [id]),
      readAt(ctx, rules, RULES_ABI, "check", [id]),
    ]),
  )) as unknown[];

  const list: RuleView[] = [];
  let changed = false;
  for (let i = 0; i < live.length; i++) {
    const id = live[i] as bigint;
    const status = num(reads[5 * i]);
    // A cancelled or exhausted rule never fires again. Its orders are followed separately.
    if (status !== RULE_STATUS.Armed) {
      changed = markDone(state, "rules", id) || changed;
      continue;
    }
    const r = reads[5 * i + 1] as RuleStruct;
    const check = reads[5 * i + 3 + 1] as readonly unknown[];
    const fires = num(r.fires);
    const view: RuleView = {
      id,
      status,
      action: num(r.action),
      tip: big(r.tip),
      escrow: big(r.escrow),
      cost: big(reads[5 * i + 2]),
      canFire: reads[5 * i + 3] === true,
      met: check[0] === true,
      value: big(check[1]),
      fires,
      maxFires: num(r.maxFires),
      readyAt: fires === 0 ? 0n : big(r.lastFiredAt) + big(r.cooldown),
      spec: null,
    };
    if (view.canFire && view.action === RULE_ACTION.Hire) view.spec = await specOf(ctx, targets, id);
    list.push(view);
  }
  if (changed) save(ctx);

  // The orders rules opened, and what the desk has returned for each.
  try {
    await readFires(ctx, targets);
  } catch (error) {
    ctx.log.warn(
      "could not read the rules' Fired logs; orders opened since the last read are not followed yet",
      {
        error: messageOf(error),
      },
    );
  }
  const orders: RuleOrderView[] = [];
  const pending = Object.entries(state.ruleOrders ?? {}).filter(
    ([orderId]) => !isDone(state, "ruleOrders", orderId),
  );
  const accounts = (await Promise.all(
    pending.flatMap(([orderId]) => [
      readAt(ctx, workOrders, DESK_ABI, "accountOf", [BigInt(orderId)]),
      readAt(ctx, rules, RULES_ABI, "orderOf", [BigInt(orderId)]),
    ]),
  )) as (readonly unknown[])[];
  let settled = false;
  pending.forEach(([orderId, ruleId], n) => {
    const account = accounts[2 * n] as readonly unknown[];
    const link = accounts[2 * n + 1] as readonly unknown[];
    const orderState = num(account[0]);
    const returned = big(account[4]);
    const credited = big(link[2]);
    // Ended, and everything it returned is handed back: nothing more can come of it.
    if (isTerminalOrderState(orderState) && returned <= credited) {
      settled = markDone(state, "ruleOrders", orderId) || settled;
      return;
    }
    orders.push({ ruleId: BigInt(ruleId), orderId: BigInt(orderId), state: orderState, returned, credited });
  });
  if (settled) save(ctx);

  let feePerGas: bigint | null = null;
  if (ctx.reader.getGasPrice !== undefined) {
    try {
      feePerGas = await ctx.reader.getGasPrice();
    } catch (error) {
      ctx.log.debug("could not read the network's fee", { error: messageOf(error) });
    }
  }
  return { now, rules, ruleCount, feePerGas, list, orders };
}
