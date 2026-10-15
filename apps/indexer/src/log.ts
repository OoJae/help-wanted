/**
 * One JSON object per line on stderr, so stdout stays free for a command's own output.
 *
 * Two kinds of text leave the process and are treated differently:
 *  - the log, read by the operator: an error is written in full, on one line, cut to a fixed
 *    length, with every registered secret removed (`errorMessage`);
 *  - the public status route: only words this package or viem wrote, never text a remote server
 *    put into its answer (`publicErrorMessage`). A gateway's error page may repeat the request
 *    path, and for a keyed provider the path is the key.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** No error text is longer than this, in a log line or anywhere else. */
export const MAX_ERROR_CHARS = 600;

/** The part of an error text that somebody else wrote (a node, a driver) is cut shorter still. */
export const MAX_FOREIGN_CHARS = 200;

const secrets = new Set<string>();

/**
 * Registers text that must never appear in a log line or an error message. Short strings are
 * ignored: removing every "v2" from the log would hide more than it protects.
 */
export function registerSecrets(values: Iterable<string | null | undefined>): void {
  for (const value of values) {
    if (typeof value === "string" && value.length >= 6) secrets.add(value);
  }
}

/** Forgets every registered secret. For tests. */
export function clearSecrets(): void {
  secrets.clear();
}

function decoded(text: string): string[] {
  try {
    const plainText = decodeURIComponent(text);
    return plainText === text ? [text] : [text, plainText];
  } catch {
    return [text];
  }
}

/**
 * The parts of a URL that can hold a credential: the password, the query and its values and, with
 * `path` (an RPC URL, where providers put the key), the path and each long segment of it. A
 * database URL is read without `path`: its path is only the database's name.
 */
export function secretsOfUrl(url: string, options: { path: boolean } = { path: true }): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }
  const found: string[] = [];
  const hasPath = options.path && parsed.pathname.length > 1;
  if (hasPath || parsed.search.length > 1 || parsed.password) found.push(url);
  if (hasPath) {
    found.push(parsed.pathname);
    // A key is long; "v2" or "mainnet" on its own is not one.
    for (const segment of parsed.pathname.split("/"))
      if (segment.length >= 12) found.push(...decoded(segment));
  }
  if (parsed.search.length > 1) {
    found.push(parsed.search.slice(1));
    for (const value of parsed.searchParams.values()) found.push(value);
  }
  if (parsed.password) found.push(...decoded(parsed.password));
  return found;
}

/** `text` with every registered secret replaced, longest first so no part of one is left over. */
export function redact(text: string): string {
  if (secrets.size === 0) return text;
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** Text on one line, without registered secrets, cut to `max` characters. */
export function oneLine(text: string, max = MAX_ERROR_CHARS): string {
  const flat = redact(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function plain(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString(10);
  if (value instanceof Error) return errorMessage(value);
  if (typeof value === "string") return redact(value);
  return value;
}

export function createLogger(
  minimum: LogLevel = "info",
  write: (line: string) => void = defaultWrite,
): Logger {
  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < ORDER[minimum]) return;
    const entry: Record<string, unknown> = { time: new Date().toISOString(), level, message };
    for (const [key, value] of Object.entries(fields ?? {})) entry[key] = plain(value);
    // A secret inside a nested field is caught here, after the line is built.
    write(redact(JSON.stringify(entry)));
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

function defaultWrite(line: string): void {
  process.stderr.write(`${line}\n`);
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function parseLogLevel(raw: string | undefined): LogLevel {
  const level = raw?.trim().toLowerCase();
  return level === "debug" || level === "warn" || level === "error" ? level : "info";
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

/**
 * An error for the operator's log: one line, no stack, at most `MAX_ERROR_CHARS` characters, with
 * registered secrets removed. It may hold text a remote server sent (viem's `details`, a database
 * driver's reason), cut to `MAX_FOREIGN_CHARS`, so it is not for a public page; use
 * `publicErrorMessage` there.
 */
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return oneLine(String(error), MAX_FOREIGN_CHARS);
  const short = (error as { shortMessage?: unknown }).shortMessage;
  const details = (error as { details?: unknown }).details;
  const cause = (error as { cause?: unknown }).cause;
  let head = typeof short === "string" ? short : firstLine(error.message);
  // The database layer puts the whole statement in its message and the reason in the cause.
  if (head.startsWith("Failed query:")) head = "a database query failed";
  const reason = oneLine(
    typeof details === "string" && details.length > 0
      ? details
      : cause instanceof Error && cause.message.length > 0
        ? firstLine(cause.message)
        : "",
    MAX_FOREIGN_CHARS,
  );
  return oneLine(reason.length > 0 && !head.includes(reason) ? `${head} (${reason})` : head);
}

/**
 * An error as it may be shown on a public page. Only three sources are trusted to be free of a
 * remote server's words: an error class of this package that carries `publicMessage`, viem's own
 * `shortMessage` (a fixed sentence per error class), and, for anything else, the error's class
 * name with a pointer to the log.
 */
export function publicErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const ours = (error as { publicMessage?: unknown }).publicMessage;
    if (typeof ours === "string") return oneLine(ours);
    const short = (error as { shortMessage?: unknown }).shortMessage;
    if (typeof short === "string") return oneLine(short);
    if (error instanceof Error) return `${oneLine(error.name, 60)}: see the indexer's log`;
  }
  return "an error occurred: see the indexer's log";
}
