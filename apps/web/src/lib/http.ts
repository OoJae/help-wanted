/**
 * Response helpers shared by the twins, the JSON API and the root text files. Everything machine
 * readable is served with open CORS and a short public cache.
 */

export const OPEN_CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const CACHE = "public, max-age=30, stale-while-revalidate=60";

/**
 * Sent with every response the server renders: pages, twins, the API and the root text files. Static
 * files in dist/client (/_astro/*, the icons, /og.png) are served by the Node adapter before the
 * middleware runs, so they go without them. No page may be framed by another site, so nothing on
 * it can be overlaid to trick a click (`frame-ancestors 'none'`, and X-Frame-Options for browsers
 * that predate it); the site is served over HTTPS only (HSTS, a year); nothing is sniffed into
 * another type; and an outbound link says only which site a reader came from.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": "frame-ancestors 'none'",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/** Puts the security headers on a response. A response whose headers are frozen is copied first. */
export function withSecurityHeaders(response: Response): Response {
  try {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) copy.headers.set(name, value);
    return copy;
  }
}

/** `JSON.stringify` that writes a bigint as a decimal string, so amounts in wei survive exactly. */
export function toJson(value: unknown, pretty = true): string {
  return JSON.stringify(
    value,
    (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
    pretty ? 2 : 0,
  );
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(`${toJson(body)}\n`, {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": CACHE,
      ...OPEN_CORS,
      ...init.headers,
    },
  });
}

export function textResponse(
  body: string,
  contentType: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      "content-type": `${contentType}; charset=utf-8`,
      "cache-control": CACHE,
      ...OPEN_CORS,
      ...init.headers,
    },
  });
}

/** A JSON error in one shape everywhere: `{ error, message }`. */
export function errorResponse(
  status: number,
  error: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse({ error, message }, { status, headers: { "cache-control": "no-store", ...headers } });
}

export function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: { ...OPEN_CORS, "access-control-max-age": "86400" } });
}

/**
 * Who is asking, for per-visitor limits and nothing else.
 *
 * A request header is believed only when the operator named it (`CLIENT_IP_HEADER`; on Railway the
 * edge writes `X-Real-IP`, and that is the default there). Otherwise the key is the address of the
 * socket, which a caller cannot choose. `X-Forwarded-For` is never read on its own: its first value
 * is whatever the caller wrote.
 */
export function clientKey(
  request: Request,
  socketAddress: string | null,
  trustedHeader: string | null,
): string {
  if (trustedHeader) {
    const value = request.headers.get(trustedHeader)?.split(",").pop()?.trim();
    if (value) return value.slice(0, 64);
  }
  return socketAddress || "unknown";
}
