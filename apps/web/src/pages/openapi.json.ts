import type { APIRoute } from "astro";
import { jsonResponse } from "~/lib/http";
import { openApiDocument } from "~/lib/openapi";
import { loadContext } from "~/lib/twins";

export const prerender = false;

export const GET: APIRoute = ({ url }) => {
  const ctx = loadContext(url);
  // With no public address configured, the document names no host: "/" means "wherever you fetched this".
  return jsonResponse(openApiDocument(ctx.sources.env.siteOrigin ?? "/"));
};
