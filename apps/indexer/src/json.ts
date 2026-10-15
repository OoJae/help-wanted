/**
 * JSON helpers shared by the event store, the API mirror, the HTTP API and the snapshot writer.
 *
 * Much of the JSON handled here was written by somebody else: a request body in a chain log, a
 * document another server sent. Three rules keep such a value harmless.
 *
 *  - Nothing nested deeper than `MAX_STORED_JSON_DEPTH` is stored. A real request body or API
 *    document is a handful of levels deep; a value with thousands of levels has no use except to
 *    exhaust the call stack of whatever reads it back.
 *  - Every function here that walks a value gives up with `JsonTooDeepError` at a fixed depth, so
 *    a walk is bounded whatever it is handed and never ends in "Maximum call stack size exceeded".
 *  - A key is always written as an own property, so a key named `__proto__` stays data.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** The deepest nesting kept in a `jsonb` column: `[]` is one level, `[[]]` is two. */
export const MAX_STORED_JSON_DEPTH = 32;

/**
 * The deepest nesting any walker here follows. Above the stored limit because what is written out
 * is a stored value inside a few levels of envelope (a file's `rows`, a row, a column).
 */
export const MAX_JSON_DEPTH = 64;

/** A value is nested deeper than this package is willing to follow. */
export class JsonTooDeepError extends Error {
  readonly publicMessage: string;

  constructor(limit: number) {
    super(`a JSON value is nested deeper than ${limit} levels`);
    this.name = "JsonTooDeepError";
    this.publicMessage = this.message;
  }
}

/** Assigns `out[key]` as an own property even when the key is `__proto__`. */
function setKey(out: { [key: string]: JsonValue }, key: string, value: JsonValue): void {
  if (key === "__proto__") {
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    out[key] = value;
  }
}

function convert(value: unknown, maxDepth: number, depth: number): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object") return String(value);
  if (depth >= maxDepth) throw new JsonTooDeepError(maxDepth);
  if (Array.isArray(value)) return value.map((inner) => convert(inner, maxDepth, depth + 1));
  const out: { [key: string]: JsonValue } = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (inner !== undefined) setKey(out, key, convert(inner, maxDepth, depth + 1));
  }
  return out;
}

/**
 * Turns a decoded value into plain JSON. A bigint becomes its decimal string, because JSON numbers
 * cannot hold a uint256 and a handler that needs the number calls `BigInt` on it again. (viem
 * decodes integers of up to 48 bits as numbers, and those stay numbers.)
 *
 * @throws JsonTooDeepError when the value is nested deeper than `maxDepth` (a value that contains
 * itself always is).
 */
export function toJson(value: unknown, maxDepth = MAX_JSON_DEPTH): JsonValue {
  return convert(value, maxDepth, 0);
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function storableText(text: string): boolean {
  return !text.includes("\u0000") && !LONE_SURROGATE.test(text);
}

function storable(value: JsonValue, maxDepth: number, depth: number): boolean {
  if (typeof value === "string") return storableText(value);
  if (typeof value === "number") return Number.isFinite(value);
  if (value === null || typeof value !== "object") return true;
  if (depth >= maxDepth) return false;
  if (Array.isArray(value)) return value.every((inner) => storable(inner, maxDepth, depth + 1));
  return Object.entries(value).every(
    ([key, inner]) => storableText(key) && storable(inner, maxDepth, depth + 1),
  );
}

/**
 * Whether a parsed JSON value can be kept in a `jsonb` column as it is. Three things JSON itself
 * allows are refused: a NUL character or half of a surrogate pair, in a string or in a key
 * (Postgres rejects both); a number that overflowed to infinity when it was parsed (it would be
 * written back as `null`, which is not what the text said); and nesting deeper than
 * `MAX_STORED_JSON_DEPTH`. Text that came from a chain log is untrusted, so this is checked before
 * an insert that would otherwise fail, or be read back at a cost, for ever.
 */
export function isStorableJson(value: JsonValue): boolean {
  return storable(value, MAX_STORED_JSON_DEPTH, 0);
}

/**
 * Whether the brackets of a JSON text ever nest deeper than `limit`, judged from the text alone,
 * so that a value built only to be deep is never parsed. Brackets inside strings do not count.
 * For text that is not JSON the answer means nothing, and the parser refuses such text anyway.
 */
export function jsonTextDepthWithin(text: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (code === 0x5c) i++;
      else if (code === 0x22) inString = false;
    } else if (code === 0x22) {
      inString = true;
    } else if (code === 0x5b || code === 0x7b) {
      if (++depth > limit) return false;
    } else if (code === 0x5d || code === 0x7d) {
      depth--;
    }
  }
  return true;
}

/** Text with the characters Postgres refuses replaced by U+FFFD. */
export function scrubText(text: string): string {
  if (storableText(text)) return text;
  return text.replaceAll("\u0000", "�").replace(new RegExp(LONE_SURROGATE, "g"), "�");
}

function scrub(value: JsonValue, maxDepth: number, depth: number): JsonValue {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= maxDepth) throw new JsonTooDeepError(maxDepth);
  if (Array.isArray(value)) return value.map((inner) => scrub(inner, maxDepth, depth + 1));
  const out: { [key: string]: JsonValue } = {};
  for (const [key, inner] of Object.entries(value)) {
    setKey(out, scrubText(key), scrub(inner, maxDepth, depth + 1));
  }
  return out;
}

/**
 * Replaces the characters Postgres refuses with U+FFFD, in strings and in keys. Lossy on purpose
 * and only ever applied to decoded copies: the raw bytes are stored beside them.
 *
 * @throws JsonTooDeepError beyond `maxDepth`.
 */
export function scrubJson(value: JsonValue, maxDepth = MAX_JSON_DEPTH): JsonValue {
  return scrub(value, maxDepth, 0);
}

/**
 * Any value as JSON that a `jsonb` column will take and that is safe to read back: converted like
 * `toJson`, cleaned like `scrubJson`.
 *
 * @throws JsonTooDeepError when the value is nested deeper than `MAX_STORED_JSON_DEPTH`. The
 * caller decides what that means: skip the entry, or keep only the raw bytes.
 */
export function storableJson(value: unknown): JsonValue {
  return scrub(convert(value, MAX_STORED_JSON_DEPTH, 0), MAX_STORED_JSON_DEPTH, 0);
}

function sortKeys(value: JsonValue, depth: number): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_JSON_DEPTH) throw new JsonTooDeepError(MAX_JSON_DEPTH);
  if (Array.isArray(value)) return value.map((inner) => sortKeys(inner, depth + 1));
  const out: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value).sort()) setKey(out, key, sortKeys(value[key] as JsonValue, depth + 1));
  return out;
}

/** Whether two JSON values are equal, whatever order their keys are in. */
export function sameJson(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(sortKeys(a, 0)) === JSON.stringify(sortKeys(b, 0));
}

/**
 * JSON text that depends only on the value: keys sorted at every depth, two-space indent, one
 * trailing newline. Two snapshots of the same data are the same bytes.
 *
 * @throws JsonTooDeepError beyond `MAX_JSON_DEPTH`.
 */
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeys(toJson(value), 0), null, 2)}\n`;
}
