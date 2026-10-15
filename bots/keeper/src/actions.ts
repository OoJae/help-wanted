/**
 * What a module's `decide` returns: actions, each with the reason its rule fired, and the things
 * the module is waiting for, each with why. Both go into the status file word for word.
 */
import type { Abi, Address } from "viem";
import type { ModuleName } from "./modules/names.js";

export type ActionSource = ModuleName | "firstDay";

export interface Action {
  module: ActionSource;
  /** The kind of step: "request", "submit", "abandon", "collectTips", "print", "drip", … */
  kind: string;
  /** What it is about: a feed's name, "report", "payroll". */
  subject: string;
  /** A few words for the log: "request payrolls". */
  label: string;
  /** Why the rule fired, as a sentence an operator can read. */
  reason: string;
  call: {
    address: Address;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
  };
  /**
   * IMD of the keeper's own that this action posts, in wei: the bond of a challenge. Only the
   * desk module's `challenge` sets it; the pass books it against the day's cap once it is mined.
   */
  postsImd?: bigint;
  /**
   * The least gas to send with. For a call that swallows the failure of its inner calls: a gas
   * estimate finds the least gas at which the outer call does not revert, and with that little the
   * inner calls can run out and be skipped without any sign of it.
   */
  gasFloor?: bigint;
}

export interface Waiting {
  module: ActionSource;
  subject: string;
  /** What is being waited for and why, as a sentence. */
  reason: string;
  /** When it is expected to change, in unix seconds, when that is known. */
  until?: number;
  /** True when an operator should look: the keeper cannot move this by itself. */
  attention?: boolean;
}

export interface Decision {
  actions: Action[];
  waiting: Waiting[];
}

/** What identifies a call: where it goes and what it says. */
export function callKey(call: Action["call"]): string {
  const args = JSON.stringify(call.args, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  return `${call.address.toLowerCase()}:${call.functionName}:${args}`;
}

/** The same call asked for by two rules is sent once: the first rule's reason stands. */
export function dedupe(actions: readonly Action[]): Action[] {
  const seen = new Set<string>();
  const out: Action[] = [];
  for (const action of actions) {
    const key = callKey(action.call);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }
  return out;
}
