/**
 * Small zod pieces for reading an event's stored arguments back in a handler.
 *
 * Arguments are stored as JSON, with wide integers as decimal strings and narrow ones as numbers
 * (see `toJson`). A handler parses them through a schema instead of casting, so an ABI and a
 * handler that drift apart fail loudly on the first event instead of writing wrong rows.
 */
import { z } from "zod";

const HEX = /^0x[0-9a-fA-F]*$/;

/** Any hex string, lowercased. */
export const hex = z
  .string()
  .regex(HEX)
  .transform((value) => value.toLowerCase() as `0x${string}`);

/** A 20-byte address, lowercased: the spelling every table uses. */
export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase() as `0x${string}`);

/** A 32-byte word, lowercased. */
export const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as `0x${string}`);

/** A 16-byte word, lowercased: a job id as the chain writes it. */
export const bytes16 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{32}$/)
  .transform((value) => value.toLowerCase() as `0x${string}`);

/** An unsigned integer of any size, stored as a decimal string or a small JSON number. */
export const uint = z
  .union([z.string().regex(/^[0-9]+$/), z.number().int().nonnegative()])
  .transform((value) => BigInt(value));

/** An unsigned integer known to stay below 2^53 (a block number, a counter, a uint8). */
export const smallUint = uint.transform((value, ctx) => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    ctx.addIssue({ code: "custom", message: "does not fit a JavaScript number" });
    return z.NEVER;
  }
  return Number(value);
});

/** Parses an event's arguments, naming the event in the error when they do not fit. */
export function parseArgs<S extends z.ZodType>(
  schema: S,
  event: { event: string; args: unknown },
): z.infer<S> {
  const parsed = schema.safeParse(event.args);
  if (!parsed.success) {
    const where = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new Error(`${event.event}: arguments do not match the handler: ${where.slice(0, 4).join("; ")}`);
  }
  return parsed.data;
}
