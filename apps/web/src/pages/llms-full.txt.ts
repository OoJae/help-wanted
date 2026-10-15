import type { APIRoute } from "astro";
import { textResponse } from "~/lib/http";
import { llmsFullTxt } from "~/lib/siteDocs";
import { loadContext } from "~/lib/twins";

export const prerender = false;

export const GET: APIRoute = async ({ url }) =>
  textResponse(await llmsFullTxt(loadContext(url)), "text/plain");
