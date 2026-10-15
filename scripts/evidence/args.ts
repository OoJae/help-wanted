/**
 * Reading an event's arguments, strictly.
 *
 * A decoded log gives its arguments by name. The builder asks for each one by the name and the
 * type it expects, and stops the run when the answer is anything else: an ABI and a counting rule
 * that have drifted apart must fail loudly, never write a wrong number.
 */
import type { Address, Hex } from "./shared.js";

export type Args = Record<string, unknown>;

export class ArgumentError extends Error {
  constructor(where: string, name: string, wanted: string) {
    super(
      `${where}: argument "${name}" is missing or is not ${wanted}. The ABI in packages/shared and the evidence builder disagree; regenerate the ABIs or correct the builder.`,
    );
    this.name = "ArgumentError";
  }
}

/** An address argument, lowercased (the spelling every comparison here uses). */
export function addr(args: Args, name: string, where: string): Address {
  const value = args[name];
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value))
    throw new ArgumentError(where, name, "an address");
  return value.toLowerCase() as Address;
}

/** An unsigned integer argument of any width. */
export function big(args: Args, name: string, where: string): bigint {
  const value = args[name];
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  throw new ArgumentError(where, name, "an unsigned integer");
}

/** An unsigned integer argument that fits a JavaScript number (a block, a counter, a small enum). */
export function num(args: Args, name: string, where: string): number {
  const value = big(args, name, where);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ArgumentError(where, name, "a whole number that fits");
  return Number(value);
}

export function flag(args: Args, name: string, where: string): boolean {
  const value = args[name];
  if (typeof value !== "boolean")
    throw new ArgumentError(where, name, "a boolean");
  return value;
}

/** Hex bytes of any length, lowercased. */
export function hex(args: Args, name: string, where: string): Hex {
  const value = args[name];
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value))
    throw new ArgumentError(where, name, "hex bytes");
  return value.toLowerCase() as Hex;
}

/** A 32-byte word, lowercased. */
export function word(args: Args, name: string, where: string): Hex {
  const value = hex(args, name, where);
  if (value.length !== 66)
    throw new ArgumentError(where, name, "a 32-byte word");
  return value;
}

/** A struct argument: its fields by name. */
export function struct(args: Args, name: string, where: string): Args {
  const value = args[name];
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ArgumentError(where, name, "a struct");
  return value as Args;
}

export function list(args: Args, name: string, where: string): unknown[] {
  const value = args[name];
  if (!Array.isArray(value)) throw new ArgumentError(where, name, "a list");
  return value;
}

export function text(args: Args, name: string, where: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new ArgumentError(where, name, "text");
  return value;
}
