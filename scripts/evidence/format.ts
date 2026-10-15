/** Small formatters for the Markdown file. Nothing here rounds: an amount is printed exactly. */

/** `26184421` as `26,184,421`. */
export function int(value: number | bigint | string): string {
  const text = String(value);
  if (!/^-?[0-9]+$/.test(text))
    throw new TypeError(`not a whole number: ${text}`);
  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  return `${negative ? "-" : ""}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** Wei (18 decimals) as IMD, exactly: `550000000000000000` is `0.55`, `112000000000000000000` is `112`. */
export function imd(wei: string | bigint): string {
  const value = BigInt(wei);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10n ** 18n;
  const fraction = (abs % 10n ** 18n)
    .toString(10)
    .padStart(18, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${int(whole)}${fraction ? `.${fraction}` : ""}`;
}

/** A cell of a Markdown table: pipes and line breaks cannot end it early. */
export function cell(value: string | number | boolean | null): string {
  if (value === null) return "";
  return String(value)
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ");
}

export function table(
  head: readonly string[],
  rows: readonly (readonly (string | number | boolean | null)[])[],
): string {
  const line = (cells: readonly (string | number | boolean | null)[]) =>
    `| ${cells.map(cell).join(" | ")} |`;
  return [
    line(head),
    `|${head.map(() => " --- ").join("|")}|`,
    ...rows.map(line),
  ].join("\n");
}

export const code = (value: string) => `\`${value}\``;

/** `2026-10-13T13:10:11Z` as `13 Oct 2026, 13:10:11 UTC`. */
export function utc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new TypeError(`not a time: ${iso}`);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} UTC`;
}
