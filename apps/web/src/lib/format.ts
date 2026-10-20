/**
 * How numbers, amounts, addresses and times are written on every page and in every twin.
 * Everything is deterministic and in UTC, so the HTML, the Markdown and the JSON agree.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** `1234567` to `1,234,567`. */
export function formatInt(value: number | bigint): string {
  const text = typeof value === "bigint" ? value.toString() : Math.trunc(value).toString();
  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}

/**
 * An amount in base units as a decimal string, exact, with trailing zeros removed.
 * `formatUnits(500000000000000000n, 18)` is `"0.5"`.
 */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const text = fraction ? `${whole}.${fraction}` : whole.toString();
  return negative ? `-${text}` : text;
}

/**
 * IMD for people: grouped thousands and at most `maxDecimals` decimals, rounded down so a page never
 * shows more than was paid. `formatImd(121000000000000000000n)` is `"121"`.
 */
export function formatImd(wei: bigint, maxDecimals = 4): string {
  const exact = formatUnits(wei, 18);
  const negative = exact.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? exact.slice(1) : exact).split(".");
  const cut = fraction.slice(0, maxDecimals).replace(/0+$/, "");
  const grouped = formatInt(BigInt(whole));
  const text = cut ? `${grouped}.${cut}` : grouped;
  return negative ? `-${text}` : text;
}

/**
 * Parses a decimal amount typed by a person into base units. Returns null for anything that is not
 * unmistakably one number.
 *
 * The decimal mark is a point. A comma is refused wherever it could be one: "0,5" is half an IMD to
 * much of the world and would be five if commas were simply dropped, and "1,000" is one thousand to
 * some and one to others. Commas are accepted only as thousands separators in a number that also
 * has a decimal point ("1,000.5"), where no other reading exists.
 */
export function parseUnits(text: string, decimals: number): bigint | null {
  let trimmed = text.trim();
  if (trimmed.includes(",")) {
    if (!/^\d{1,3}(,\d{3})+\.\d+$/.test(trimmed)) return null;
    trimmed = trimmed.replace(/,/g, "");
  }
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(trimmed)) return null;
  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** True when an amount was typed with a comma that `parseUnits` will not read, so a form can say why. */
export function hasAmbiguousComma(text: string): boolean {
  return text.includes(",") && parseUnits(text, 18) === null;
}

/** `0x4e0f…adbc`. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** `0x3db99325…b2c5` for a 32-byte hash; shorter strings are returned whole. */
export function shortHash(hash: string, head = 10, tail = 4): string {
  return hash.length > head + tail + 1 ? `${hash.slice(0, head)}…${hash.slice(-tail)}` : hash;
}

function two(n: number): string {
  return n.toString().padStart(2, "0");
}

function toDate(value: Date | string | number): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `10 Oct 2026, 21:21 UTC`. */
export function formatUtc(value: Date | string | number): string {
  const d = toDate(value);
  if (!d) return "unknown time";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

/** `10 Oct, 21:21 UTC`: for card lines where the year is noise. */
export function formatUtcShort(value: Date | string | number): string {
  const d = toDate(value);
  if (!d) return "unknown time";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

/** `Saturday, 10 October 2026` in the long form a masthead or a release carries. */
export function formatUtcLongDay(value: Date | string | number): string {
  const d = toDate(value);
  if (!d) return "unknown day";
  const month = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ][d.getUTCMonth()];
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}

/** `2026-10-10`: the UTC day a timestamp falls in. */
export function utcDay(value: Date | string | number): string {
  const d = toDate(value);
  if (!d) return "0000-00-00";
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
}

/** `21:21` UTC. */
export function utcClock(value: Date | string | number): string {
  const d = toDate(value);
  if (!d) return "--:--";
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** `1 min 15 s`, `2 h 5 min`, `3 d 4 h`: a length of time in at most two units. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d} d` : `${d} d ${h % 24} h`;
}

/** `2 min ago`, measured against the moment the page was made (which the page also prints). */
export function ago(then: Date | string | number, now: Date | number): string {
  const a = toDate(then);
  const b = toDate(now);
  if (!a || !b) return "at an unknown time";
  const ms = b.getTime() - a.getTime();
  if (ms < 0) return "just now";
  if (ms < 45_000) return "just now";
  return `${formatDuration(ms)
    .replace(/ \d+ s$/, "")
    .replace(/^(\d+ h) \d+ min$/, "$1")
    .replace(/^(\d+ d) \d+ h$/, "$1")} ago`;
}

export function plural(count: number | bigint, one: string, many = `${one}s`): string {
  return `${formatInt(count)} ${count === 1 || count === 1n ? one : many}`;
}

/** Cuts text at a word boundary and adds an ellipsis. Whitespace runs collapse to one space. */
export function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/**
 * An amount in base units rounded to a few significant digits, for an estimate that should not look
 * exact: `significant(2173400000000n, 18)` is `"0.0000022"` (ETH), `significant(75445729n, 9)` is
 * `"0.075"` (gwei).
 */
export function significant(value: bigint, decimals: number, digits = 2): string {
  if (value <= 0n) return "0";
  const drop = value.toString().length - digits;
  if (drop <= 0) return formatUnits(value, decimals);
  const unit = 10n ** BigInt(drop);
  return formatUnits(((value + unit / 2n) / unit) * unit, decimals);
}

/** `1st`, `2nd`, `3rd`, `11th`, `50th`. */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${formatInt(n)}${suffix}`;
}

/** Basis points as a percentage with one decimal, rounded down: `6115` is `61.1%`. */
export function bpsPercent(bps: number): string {
  const tenths = Math.floor(Math.max(0, bps) / 10);
  return `${Math.floor(tenths / 10)}.${tenths % 10}%`;
}

/** A share of a whole as `61.2%`, rounded down; `null` when the whole is zero. */
export function percent(part: bigint, whole: bigint, decimals = 1): string | null {
  if (whole === 0n) return null;
  const scale = 10n ** BigInt(decimals + 2);
  const scaled = (part * scale) / whole;
  const text = scaled.toString().padStart(decimals + 1, "0");
  const head = text.slice(0, text.length - decimals) || "0";
  const tail = decimals > 0 ? `.${text.slice(-decimals)}` : "";
  return `${head}${tail}%`;
}
