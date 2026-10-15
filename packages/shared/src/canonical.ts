/**
 * Canonical JSON exactly as IdentityMD writes it.
 *
 * This is a line-for-line port of `canonicalize` in `dist/client.js` of the published worker
 * (github.com/Identity-md/worker, commit 1045bbe0, read on 10 Oct 2026). The rules:
 *
 * - object keys in `Object.keys(value).sort()` order, which is UTF-16 code unit order;
 * - no whitespace anywhere;
 * - strings and keys exactly as `JSON.stringify` writes them: only `"`, `\`, the control characters
 *   below 0x20 and lone surrogates are escaped, everything else is raw (UTF-8 once encoded);
 * - numbers must be finite integers, and `-0` is written `0`;
 * - `undefined`, bigint, functions, symbols and any object that is not a plain object or an array
 *   are refused. Nothing is dropped silently.
 *
 * Work records, oracle question documents and the x402 payment hash all go through this one
 * function, so a difference of one byte here breaks a hash somewhere else.
 */
import { keccak256, sha256, stringToBytes, type Hex } from "viem";

export class CanonicalError extends Error {
  readonly path: readonly string[];

  constructor(reason: string, path: readonly string[]) {
    const at = path.length > 0 ? ` at $.${path.join(".")}` : "";
    super(`cannot canonicalize: ${reason}${at}`);
    this.name = "CanonicalError";
    this.path = path;
  }
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describe(value: object): string {
  const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
  return proto?.constructor?.name ?? "unknown";
}

function write(value: unknown, path: readonly string[]): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalError("non-finite number", path);
      if (!Number.isInteger(value)) throw new CanonicalError("non-integer number", path);
      return JSON.stringify(value === 0 ? 0 : value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const items = value.map((item, index) => write(item, [...path, String(index)]));
        return `[${items.join(",")}]`;
      }
      if (isPlainObject(value)) {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        const entries = keys.map((key) => {
          const entry = record[key];
          if (entry === undefined) throw new CanonicalError(`undefined at key "${key}"`, path);
          return `${JSON.stringify(key)}:${write(entry, [...path, key])}`;
        });
        return `{${entries.join(",")}}`;
      }
      throw new CanonicalError(`unsupported object (${describe(value)})`, path);
    }
    default:
      throw new CanonicalError(`unsupported type "${typeof value}"`, path);
  }
}

/** The canonical JSON text of `value`. Throws `CanonicalError` for anything it cannot write exactly. */
export function canonicalize(value: unknown): string {
  return write(value, []);
}

/** The canonical JSON as the UTF-8 bytes that get hashed. */
export function canonicalBytes(value: unknown): Uint8Array {
  return stringToBytes(canonicalize(value));
}

/** keccak256 of the canonical bytes: what the WorkRegistry and the oracle's `questionHash` use. */
export function canonicalKeccak(value: unknown): Hex {
  return keccak256(canonicalBytes(value));
}

/** SHA-256 of the canonical bytes: what the paid-action `paymentHash` and the worker envelopes use. */
export function canonicalSha256(value: unknown): Hex {
  return sha256(canonicalBytes(value));
}
