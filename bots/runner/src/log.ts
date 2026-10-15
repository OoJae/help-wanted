/**
 * Logging for the runner: one JSON object per line, with every secret removed before it is written.
 *
 * Two layers, because either alone can be bypassed by a careless call site:
 * 1. a field whose name suggests a secret (key, secret, token, authorization, signature) is replaced
 *    whatever it holds;
 * 2. the finished line is searched for the literal secrets the process was started with (the wallet
 *    key and the request token, with and without `0x`), and any hit is replaced.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export const REDACTED = "[redacted]";

const SECRET_NAME = /(private|secret|token|authorization|signature|paymentheader|password)/i;
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function scrub(value: unknown, depth: number): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "[too deep]";
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_NAME.test(key) ? REDACTED : scrub(inner, depth + 1);
  }
  return out;
}

/** Every spelling of a secret that could end up in a line: as given, lowercase, and without `0x`. */
function spellings(secrets: readonly (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const secret of secrets) {
    if (!secret || secret.length < 16) continue;
    const bare = secret.startsWith("0x") || secret.startsWith("0X") ? secret.slice(2) : secret;
    for (const form of [secret, bare, secret.toLowerCase(), bare.toLowerCase(), bare.toUpperCase()])
      out.add(form);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Removes every known secret from a piece of text. */
export function redactText(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const form of spellings(secrets)) out = out.split(form).join(REDACTED);
  return out;
}

export interface LoggerOptions {
  secrets?: readonly (string | null | undefined)[];
  level?: LogLevel;
  write?: (line: string) => void;
  now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const secrets = options.secrets ?? [];
  const threshold = LEVELS[options.level ?? "info"];
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVELS[level] < threshold) return;
    const line = JSON.stringify({
      t: now().toISOString(),
      level,
      msg,
      ...(scrub(fields ?? {}, 0) as LogFields),
    });
    write(redactText(line, secrets));
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}

/** A logger that keeps what it was given, for tests. */
export function memoryLogger(secrets: readonly string[] = []): Logger & { lines: string[] } {
  const lines: string[] = [];
  return Object.assign(createLogger({ secrets, level: "debug", write: (line) => lines.push(line) }), {
    lines,
  });
}
