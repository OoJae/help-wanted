/**
 * What every `.astro` page does first: load its model through the shared loader, or answer 404.
 */
import type { AstroGlobal } from "astro";
import { loadPath, requestContext, type Loaded } from "./twins";

const STATUS_TEXT: Record<number, string> = {
  404: "Not Found",
  429: "Too Many Requests",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

export async function pageData<M>(astro: AstroGlobal): Promise<(Loaded<M> & { model: M }) | Response> {
  const ctx = requestContext(astro.url, astro.request, () => astro.clientAddress);
  const loaded = await loadPath(astro.url.pathname, ctx);
  if (!loaded) return astro.rewrite("/404");
  astro.response.status = loaded.status;
  if (loaded.status !== 200) astro.response.statusText = STATUS_TEXT[loaded.status] ?? "";
  for (const [name, value] of Object.entries(loaded.headers)) astro.response.headers.set(name, value);
  return loaded as Loaded<M> & { model: M };
}
