/**
 * Small helpers for the Markdown twin of each page. The twins are read by agents over plain HTTP,
 * so they are kept to what every Markdown reader understands: headings, paragraphs, lists, tables,
 * fenced code and block quotes.
 */

/** Makes a value safe inside a table cell: no pipes, no line breaks. */
export function cell(value: string | number | bigint | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  return String(value)
    .replace(/\r?\n+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

export function table(
  headers: readonly string[],
  rows: readonly (readonly (string | number | bigint | null | undefined)[])[],
): string {
  if (rows.length === 0) return "";
  const head = `| ${headers.map(cell).join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(cell).join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}

export function link(text: string, url: string | null | undefined): string {
  if (!url) return text;
  return `[${text.replace(/[\[\]]/g, "")}](${url.replace(/[()\s]/g, encodeURIComponent)})`;
}

/** A fenced block. Backtick runs inside the content are broken so they cannot close the fence. */
export function fence(content: string, language = ""): string {
  return `\`\`\`${language}\n${content.replace(/```/g, "` ` `")}\n\`\`\``;
}

export function inline(code: string): string {
  return `\`${code.replace(/`/g, "'")}\``;
}

/**
 * Third-party text, quoted. Every line is prefixed so that nothing inside it can be taken for the
 * page's own words: text that came from a job objective or an oracle question is data, not prose.
 */
export function quote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

export function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

export function numbered(items: readonly string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

/** Joins blocks with one blank line and drops empty ones. */
export function doc(...blocks: (string | null | undefined | false)[]): string {
  return `${blocks.filter((b): b is string => typeof b === "string" && b.trim() !== "").join("\n\n")}\n`;
}
