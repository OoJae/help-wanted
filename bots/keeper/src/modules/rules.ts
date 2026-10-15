/**
 * The rules module: fire a rule whose WHEN is true, and hand back to a rule what the desk returned
 * for an order it opened.
 *
 * `decideRules` is a pure function of a snapshot and the operator's settings.
 *
 * fire       `Rules.fire(id, spec)` when the contract's own `canFire(id)` says yes (the rule is
 *            armed, its cooldown has passed, its escrow covers the action and the tip, and its
 *            condition holds now) and the fire is worth sending:
 *            - always for a rule on the operator's house list;
 *            - otherwise only when the rule's tip, which is paid in IMD, covers the gas of the
 *              fire at the current fee. Gas is paid in ETH, so the comparison needs the operator's
 *              figure for what one ETH is worth in IMD (`RULES_IMD_PER_ETH`); without it only
 *              house rules are fired.
 *            A HIRE rule needs its job text, which the contract publishes once, in `RuleCreated`,
 *            and keeps only the hash of.
 * reconcile  `Rules.reconcile(ruleId, orderId)` when an order of a rule has ended (delivered,
 *            cancelled or refunded) and the desk's books show more returned for it than the rule
 *            has been credited with. A rule that asked for the desk's callback gets the change of
 *            a delivered order without this call.
 *
 * The keeper is paid the tip of every rule it fires. A condition somebody can make true for the
 * length of one transaction can be fired by whoever does that; what such a caller gains is bounded
 * by the rule itself, and the keeper's simulation refuses a fire whose condition no longer holds.
 */
import type { Abi, Address, Hex } from "viem";
import { isTerminalOrderState, orderStateName, rulesAbi } from "@help-wanted/shared";
import type { Action, Decision, Waiting } from "../actions.js";

export const RULES_ABI = rulesAbi as unknown as Abi;

/** `Rules.Status`. */
export const RULE_STATUS = { None: 0, Armed: 1, Exhausted: 2, Cancelled: 3 } as const;
/** `Rules.ACT_HIRE` and `ACT_PAY`. */
export const RULE_ACTION = { Hire: 1, Pay: 2 } as const;

/**
 * What a fire should be sent with. `fire` insists on about 122,000 gas in hand when it reads the
 * condition, whatever the read then uses, so an estimate alone can come out too low for a
 * condition whose cost varies. These are the figures launch C's documents give.
 */
export const FIRE_GAS_FLOOR = { hire: 700_000n, pay: 300_000n } as const;
/** What a fire was measured to use, for pricing the tip: 391,443 for a HIRE, 111,553 for a PAY. */
export const FIRE_GAS_USED = { hire: 450_000n, pay: 150_000n } as const;

const WAD = 10n ** 18n;

export interface RulesPolicy {
  /** Rule ids that are always fired when they can be, whatever their tip. */
  house: ReadonlySet<string>;
  /**
   * How many IMD one ETH is worth, in IMD-wei per ETH (18 decimals), by the operator's own
   * figure; null when none was given. It is used for one thing: whether a tip covers the gas.
   */
  imdPerEth: bigint | null;
  /** The tip must cover the gas this many times over, in ten-thousandths (10,000 is break-even). */
  tipCoverBps: bigint;
}

export interface RuleView {
  id: bigint;
  status: number;
  action: number;
  tip: bigint;
  escrow: bigint;
  /** `costOf(id)`: what one fire takes from the escrow. */
  cost: bigint;
  /** `canFire(id)`, read at the block of the snapshot. */
  canFire: boolean;
  /** `check(id)`: whether the condition holds, and the word it read. */
  met: boolean;
  value: bigint;
  fires: number;
  maxFires: number;
  /** When the cooldown is over, in the chain's seconds; zero when the rule has never fired. */
  readyAt: bigint;
  /** HIRE: the job text from `RuleCreated`, as hex; null when it could not be found. */
  spec: Hex | null;
}

/** An order on the desk whose employer is the Rules contract. */
export interface RuleOrderView {
  ruleId: bigint;
  orderId: bigint;
  /** The desk's state of the order. */
  state: number;
  /** `accountOf(orderId).returned`: everything the desk sent back for the order. */
  returned: bigint;
  /** `Rules.orderOf(orderId).credited`: how much of that the rule has been handed. */
  credited: bigint;
}

export interface RulesSnapshot {
  now: bigint;
  rules: Address;
  ruleCount: bigint;
  /** The network's current fee per gas, in wei; null when it could not be read. */
  feePerGas: bigint | null;
  list: RuleView[];
  orders: RuleOrderView[];
}

/** What the gas of a fire costs in IMD-wei at a fee, by the operator's figure. */
export function fireCostInImd(action: number, feePerGas: bigint, imdPerEth: bigint): bigint {
  const gas = action === RULE_ACTION.Hire ? FIRE_GAS_USED.hire : FIRE_GAS_USED.pay;
  return (gas * feePerGas * imdPerEth) / WAD;
}

/** State in, actions with reasons out. Pure. */
export function decideRules(snapshot: RulesSnapshot, policy: RulesPolicy): Decision {
  const actions: Action[] = [];
  const waiting: Waiting[] = [];

  for (const rule of snapshot.list) {
    const subject = `rule ${rule.id}`;
    const wait = (reason: string, extra: Partial<Waiting> = {}) =>
      waiting.push({ module: "rules", subject, reason, ...extra });
    if (rule.status !== RULE_STATUS.Armed) continue;
    const house = policy.house.has(rule.id.toString());
    if (!rule.canFire) {
      if (rule.met && rule.escrow < rule.cost) {
        wait(
          `its condition holds, but its escrow of ${rule.escrow} is below the ${rule.cost} one fire costs: it fires once somebody tops it up`,
          { attention: house },
        );
      } else if (rule.met && snapshot.now < rule.readyAt) {
        wait(`its condition holds; its cooldown ends at ${rule.readyAt}`, { until: Number(rule.readyAt) });
      } else if (house) {
        wait("a house rule; its condition does not hold");
      }
      continue;
    }

    const hire = rule.action === RULE_ACTION.Hire;
    let worth: string | null = null;
    if (house) {
      worth = "it is on the house list, which is always fired";
    } else if (policy.imdPerEth === null) {
      wait(
        `it can be fired for a tip of ${rule.tip}, and is not: a tip in IMD cannot be held against gas in ETH without RULES_IMD_PER_ETH, and it is not on the house list`,
      );
      continue;
    } else if (snapshot.feePerGas === null) {
      wait(
        "it can be fired, but the network's fee could not be read: the tip cannot be held against the gas",
      );
      continue;
    } else {
      const gasCost = fireCostInImd(rule.action, snapshot.feePerGas, policy.imdPerEth);
      const needed = (gasCost * policy.tipCoverBps) / 10_000n;
      if (rule.tip < needed) {
        wait(
          `it can be fired, but its tip of ${rule.tip} does not cover the gas at the current fee (about ${gasCost} IMD-wei; ${needed} is asked for)`,
        );
        continue;
      }
      worth = `its tip of ${rule.tip} covers the gas at the current fee (about ${gasCost} IMD-wei)`;
    }
    if (hire && rule.spec === null) {
      wait(
        "it can be fired, but its job text was not found in the RuleCreated logs: fire it by hand, or give the keeper an RPC that serves older logs",
        { attention: true },
      );
      continue;
    }
    actions.push({
      module: "rules",
      kind: "fire",
      subject,
      label: `fire rule ${rule.id}`,
      reason: `canFire says yes: the condition reads ${rule.value} and holds, the cooldown has passed and the escrow of ${rule.escrow} covers the ${rule.cost} a fire costs; ${worth}. ${
        hire ? "It opens an order on the desk" : "It makes its payment"
      } and pays the caller the tip`,
      call: {
        address: snapshot.rules,
        abi: RULES_ABI,
        functionName: "fire",
        args: [rule.id, hire ? (rule.spec as Hex) : "0x"],
      },
      gasFloor: hire ? FIRE_GAS_FLOOR.hire : FIRE_GAS_FLOOR.pay,
    });
  }

  for (const order of snapshot.orders) {
    const subject = `rule ${order.ruleId} order ${order.orderId}`;
    const owed = order.returned > order.credited ? order.returned - order.credited : 0n;
    if (owed === 0n) continue;
    if (!isTerminalOrderState(order.state)) {
      // A bond the desk awarded the rule while its order goes on. It is handed back with the rest
      // when the order ends; nothing is lost by waiting.
      waiting.push({
        module: "rules",
        subject,
        reason: `the desk has returned ${owed} for the order, which is still ${orderStateName(order.state)}: it is handed back to the rule when the order ends`,
      });
      continue;
    }
    actions.push({
      module: "rules",
      kind: "reconcile",
      subject,
      label: `hand back what the desk returned for order ${order.orderId} of rule ${order.ruleId}`,
      reason: `the order is ${orderStateName(order.state)} and the desk's books show ${order.returned} returned for it, of which the rule has been credited ${order.credited}`,
      call: {
        address: snapshot.rules,
        abi: RULES_ABI,
        functionName: "reconcile",
        args: [order.ruleId, order.orderId],
      },
    });
  }
  // Fires first: a fire can be raced, a reconcile cannot.
  return { actions, waiting };
}
