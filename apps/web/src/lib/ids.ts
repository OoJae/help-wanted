/**
 * Job ids and hashes in the two spellings the protocol uses: a UUID in the API, `bytes16` on chain;
 * a record hash with `0x` on chain and without it in the record URL.
 */
import type { Hex } from "viem";
import { WORK_REGISTRY_LATEST_SELECTOR } from "@help-wanted/shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;

/**
 * Accepts what a person may paste: a UUID in any case, with surrounding space, a `bytes16` hex with
 * or without `0x`, or an explorer link that ends in the id. Returns the lowercase UUID, or null.
 */
export function parseJobId(input: string | null | undefined): string | null {
  if (!input) return null;
  let text = input.trim().toLowerCase();
  const fromUrl = text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#].*)?$/);
  if (fromUrl?.[1]) text = fromUrl[1];
  if (UUID.test(text)) return text;
  const bare = text.startsWith("0x") ? text.slice(2) : text;
  if (HEX32.test(bare)) {
    return `${bare.slice(0, 8)}-${bare.slice(8, 12)}-${bare.slice(12, 16)}-${bare.slice(16, 20)}-${bare.slice(20)}`;
  }
  return null;
}

export function isJobId(input: string): boolean {
  return UUID.test(input);
}

/** The job id as the contract takes it: the UUID's 16 bytes. */
export function jobIdToBytes16(jobId: string): Hex {
  if (!UUID.test(jobId)) throw new TypeError("a job id is a lowercase UUID");
  return `0x${jobId.replace(/-/g, "")}`;
}

/**
 * The calldata of `WorkRegistry.latest(bytes16 jobId)`: the selector, then the job id left-aligned
 * in one 32-byte word. Written out by hand so the browser's check needs no ABI library, and tested
 * against an ABI encoder.
 */
export function latestCalldata(jobIdBytes16: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{32}$/.test(jobIdBytes16))
    throw new TypeError("a bytes16 job id is 0x and 32 hex characters");
  return `${WORK_REGISTRY_LATEST_SELECTOR}${jobIdBytes16.slice(2).toLowerCase()}${"0".repeat(32)}`;
}

export function bytes16ToJobId(value: string): string | null {
  return parseJobId(value);
}

/** A 32-byte hash as `0x` plus 64 lowercase hex characters, or null for anything else. */
export function parseHash(input: string | null | undefined): Hex | null {
  if (!input) return null;
  const text = input.trim().toLowerCase();
  const bare = text.startsWith("0x") ? text.slice(2) : text;
  return HEX64.test(bare) ? `0x${bare}` : null;
}

/** The form the record URL takes: 64 hex characters, no `0x`. */
export function hashNo0x(hash: Hex): string {
  return hash.slice(2).toLowerCase();
}

export function isZeroHash(hash: string): boolean {
  return /^0x0*$/.test(hash);
}

/** A 20-byte address in lowercase with `0x`, or null. Checksums are not required of pasted input. */
export function parseAddress(input: string | null | undefined): `0x${string}` | null {
  if (!input) return null;
  const text = input.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(text) ? (text as `0x${string}`) : null;
}

/** A non-negative whole number that fits a JavaScript integer, or null. */
export function parseIndex(input: string | null | undefined, max = Number.MAX_SAFE_INTEGER): number | null {
  if (!input || !/^\d{1,15}$/.test(input.trim())) return null;
  const n = Number(input.trim());
  return n <= max ? n : null;
}
