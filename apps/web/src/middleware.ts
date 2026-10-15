/**
 * Two jobs, both before any page runs.
 *
 * 1. Twins. A path ending in `.json` or `.md` is the JSON or Markdown form of the page at the same
 *    path without the ending. They are answered here, from the same model as the HTML page.
 * 2. Headers. Every HTML page says it is UTF-8, may be cached briefly by anyone, and names its
 *    twins in `Link` headers so a client that reads only headers can still find them. Every
 *    response this middleware answers (pages, twins, the API) carries the security headers of
 *    `lib/http.ts`: no framing by another site, HTTPS only, no sniffing. Static files are served by
 *    the Node adapter before the middleware runs, and go without them.
 */
import type { APIContext, MiddlewareNext } from "astro";
import { defineMiddleware } from "astro:middleware";
import { messageOf, UpstreamBusyError, UpstreamDownError } from "~/lib/cache";
import { errorResponse, preflightResponse, textResponse, withSecurityHeaders } from "~/lib/http";
import { matchPage, parseTwinPath, twinPaths, type TwinFormat } from "~/models/registry";
import { loadPath, requestContext, twinResponse } from "~/lib/twins";

/** "Not found" in the form the path asked for: JSON for `.json`, Markdown for `.md`. */
function twinNotFound(twin: { path: string; format: TwinFormat }): Response {
  return twin.format === "json"
    ? errorResponse(404, "not_found", `There is no page at ${twin.path}.`)
    : textResponse(
        `# Not found\n\nThere is no page at ${twin.path}. See /llms.txt for every page.\n`,
        "text/markdown",
        {
          status: 404,
        },
      );
}

export const onRequest = defineMiddleware(async (context, next) =>
  withSecurityHeaders(await respond(context, next)),
);

async function respond(context: APIContext, next: MiddlewareNext): Promise<Response> {
  const { url, request } = context;
  const twin = parseTwinPath(url.pathname);

  if (twin && !url.pathname.startsWith("/api/") && matchPage(twin.path)) {
    if (request.method === "OPTIONS") return preflightResponse();
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(405, "method_not_allowed", "Twins answer GET only.", {
        allow: "GET, HEAD, OPTIONS",
      });
    }
    try {
      const ctx = requestContext(url, request, () => context.clientAddress);
      const loaded = await loadPath(twin.path, ctx);
      if (!loaded) return twinNotFound(twin);
      return twinResponse(loaded, twin.format);
    } catch (error) {
      const waiting = error instanceof UpstreamBusyError || error instanceof UpstreamDownError;
      return errorResponse(
        waiting ? 503 : 502,
        error instanceof UpstreamBusyError
          ? "upstream_budget_spent"
          : waiting
            ? "upstream_not_answering"
            : "upstream_failed",
        messageOf(error),
        {
          "retry-after": waiting ? String(Math.ceil(error.retryAfterMs / 1000)) : "30",
        },
      );
    }
  }

  const response = await next();
  // A path that ends like a twin but names no page gets its "not found" in the form it asked for.
  if (twin && response.status === 404 && !url.pathname.startsWith("/api/")) return twinNotFound(twin);
  const type = response.headers.get("content-type") ?? "";
  if (type.startsWith("text/html")) {
    response.headers.set("content-type", "text/html; charset=utf-8");
    if (response.status >= 500) {
      response.headers.set("cache-control", "no-store");
    } else if (!response.headers.has("cache-control")) {
      response.headers.set("cache-control", "public, max-age=30, stale-while-revalidate=60");
    }
    if (matchPage(url.pathname)) {
      const paths = twinPaths(url.pathname);
      response.headers.append("link", `<${paths.json}>; rel="alternate"; type="application/json"`);
      response.headers.append("link", `<${paths.md}>; rel="alternate"; type="text/markdown"`);
    }
  }
  return response;
}
