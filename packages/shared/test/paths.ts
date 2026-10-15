import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `packages/shared`. */
export const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The repository root, for the cross-checks against other areas' files. */
export const REPO = join(PKG, "..", "..");

export function fixture(...parts: string[]): string {
  return join(PKG, "fixtures", ...parts);
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

export function vector<T = unknown>(name: string): T {
  return readJson<T>(join(PKG, "vectors", name));
}

/** A file owned by another area. Tests that read one skip themselves when it is not there. */
export function repoFile(...parts: string[]): string | null {
  const path = join(REPO, ...parts);
  return existsSync(path) ? path : null;
}
