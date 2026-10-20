/**
 * `/mcp`: HELP WANTED's MCP endpoint, for AI agents. All the work is in `lib/mcp.ts`; this file
 * reads the request (refusing a body larger than `MCP_MAX_BODY_BYTES` without reading the rest)
 * and turns the answer into a Response. The middleware adds the security headers, as on every
 * response the server renders.
 */
import type { APIRoute } from "astro";
import { SlidingWindowLimiter } from "~/lib/cache";
import { handleMcpHttp, MCP_MAX_BODY_BYTES, TOOL_CALLS_PER_MINUTE, type McpHttpResponse } from "~/lib/mcp";
import { requestContext } from "~/lib/twins";

export const prerender = false;

/** One per process: tool calls per visitor per minute. */
const toolCalls = new SlidingWindowLimiter({ max: TOOL_CALLS_PER_MINUTE, windowMs: 60_000 });

/** The body as text, or null when it is larger than `max` bytes. */
async function readBody(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function toResponse(answer: McpHttpResponse): Response {
  return new Response(answer.body, { status: answer.status, headers: answer.headers });
}

export const ALL: APIRoute = async ({ request, url, clientAddress }) => {
  const ctx = requestContext(url, request, () => clientAddress);
  const body = request.method === "POST" ? await readBody(request, MCP_MAX_BODY_BYTES) : "";
  const answer = await handleMcpHttp({ method: request.method, headers: request.headers, body }, ctx, {
    // This server's own pages, wherever it is reached from; any other site's page is refused.
    allowedOrigins: [ctx.sources.env.siteOrigin, url.origin],
    toolCalls,
  });
  return toResponse(answer);
};
