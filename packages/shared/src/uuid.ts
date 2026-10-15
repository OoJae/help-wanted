/**
 * UUID helpers. IdentityMD names jobs, oracle requests and paid orders with UUIDs; on chain a job id
 * is the same sixteen bytes as a `bytes16`, and inside an attestation it is those sixteen bytes
 * left-aligned in a `bytes32`.
 */
import type { Hex } from "viem";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True for a UUID in the lowercase form the API writes. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** `e9efec16-56f3-…` to `0xe9efec1656f3…` (16 bytes). Accepts lowercase only, as the API writes it. */
export function uuidToBytes16(uuid: string): Hex {
  if (!isUuid(uuid)) throw new TypeError(`not a lowercase UUID: ${uuid}`);
  return `0x${uuid.replaceAll("-", "")}`;
}

/** The same sixteen bytes left-aligned in 32, as `requestId` and `panelJobId` appear in attestations. */
export function uuidToBytes32(uuid: string): Hex {
  return `${uuidToBytes16(uuid)}${"0".repeat(32)}`;
}

export function bytes16ToUuid(value: Hex): string {
  if (!/^0x[0-9a-fA-F]{32}$/.test(value)) throw new TypeError("expected 0x followed by 32 hex characters");
  const h = value.slice(2).toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
