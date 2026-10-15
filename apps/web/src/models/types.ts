/**
 * A page is three renderings of one model: HTML (an `.astro` file), JSON and Markdown (the twins).
 * `load` builds the model from the data sources; the `.astro` page and the twins all start from it,
 * so the three can never disagree about a number.
 */
import type { Sources } from "~/data";

export interface LoadContext {
  sources: Sources;
  now: Date;
  /** The request URL, for query parameters. */
  url: URL;
  /**
   * Who is asking, as far as the server can tell (see `clientKey`). Present only for a request that
   * came from outside; reads the server makes on its own account carry none. Used for per-visitor
   * limits and nothing else, and never printed.
   */
  visitor?: string | null;
}

export interface PageMeta {
  title: string;
  description: string;
}

export interface PageDef<M> {
  /** A short stable name, e.g. `jobs-report`. */
  id: string;
  /** The path pattern, e.g. `/verify/:jobId`. */
  pattern: string;
  /** Builds the model. Returns null when the path names something that cannot exist (HTTP 404). */
  load(ctx: LoadContext, params: Record<string, string>): Promise<M | null>;
  meta(model: M): PageMeta;
  /** The Markdown twin's body (without the shared header and footer). */
  markdown(model: M): string;
  /** The HTTP status of all three renderings. Default 200. */
  status?(model: M): number;
  /** Extra response headers for all three renderings, e.g. `retry-after` on a "try again later". */
  headers?(model: M): Record<string, string>;
}

/** Where a number came from and how old it is. Printed at the foot of each page and in each twin. */
export interface SourceNote {
  name: string;
  detail: string;
  /** ISO time the value was read; null when it could not be read at all. */
  fetchedAt: string | null;
  stale: boolean;
  error: string | null;
  /** Said in place of a read time when there is none and nothing failed, e.g. "a stored copy". */
  note?: string;
}

export function sourceNote(
  name: string,
  detail: string,
  read: { fetchedAt: number; stale: boolean; error: string | null } | null,
  error: string | null = null,
): SourceNote {
  return {
    name,
    detail,
    fetchedAt: read ? new Date(read.fetchedAt).toISOString() : null,
    stale: read?.stale ?? true,
    error: read?.error ?? error,
  };
}
