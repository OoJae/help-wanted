import type { APIRoute } from "astro";
import { textResponse } from "~/lib/http";
import { robotsTxt } from "~/lib/siteDocs";
import { loadContext } from "~/lib/twins";

export const prerender = false;

export const GET: APIRoute = ({ url }) => textResponse(robotsTxt(loadContext(url)), "text/plain");
