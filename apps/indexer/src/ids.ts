/**
 * A swarm job has one id written two ways: the chain uses `bytes16` (`0xe9efec16…fc7d`) and the
 * IdentityMD API uses a UUID (`e9efec16-56f3-40d3-9243-52c453effc7d`). Both are the same 16 bytes.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BYTES16 = /^0x[0-9a-f]{32}$/;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** `0x` + 32 hex → the UUID spelling. Accepts either case, returns lowercase. */
export function jobIdToUuid(jobId: string): string {
  const lower = jobId.toLowerCase();
  if (!BYTES16.test(lower)) throw new TypeError(`not a bytes16 job id: ${jobId}`);
  const h = lower.slice(2);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A UUID → `0x` + 32 hex, lowercase. */
export function uuidToJobId(uuid: string): `0x${string}` {
  const lower = uuid.toLowerCase();
  if (!UUID.test(lower)) throw new TypeError(`not a UUID: ${uuid}`);
  return `0x${lower.replaceAll("-", "")}`;
}

/** Either spelling → the chain's. Null when the text is neither. */
export function normalizeJobId(value: string): `0x${string}` | null {
  const lower = value.toLowerCase();
  if (BYTES16.test(lower)) return lower as `0x${string}`;
  if (UUID.test(lower)) return uuidToJobId(lower);
  return null;
}
