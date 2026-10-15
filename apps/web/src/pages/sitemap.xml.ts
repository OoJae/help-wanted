import type { APIRoute } from "astro";
import { textResponse } from "~/lib/http";
import { sitemapXml } from "~/lib/siteDocs";
import { loadContext } from "~/lib/twins";

export const prerender = false;

export const GET: APIRoute = ({ url }) => {
  const xml = sitemapXml(loadContext(url));
  return xml === null
    ? textResponse(
        "No sitemap: this server has not been told its public address (SITE_ORIGIN is not set), and a sitemap may only list absolute addresses. Every page is listed, by path, in /llms.txt.\n",
        "text/plain",
        { status: 404, headers: { "cache-control": "no-store" } },
      )
    : textResponse(xml, "application/xml");
};
