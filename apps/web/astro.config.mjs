// @ts-check
import { fileURLToPath } from "node:url";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

// Server-rendered on Node (Railway). Every page is complete in the HTML it sends; React loads only
// on the pages that have a wallet action. `SITE_ORIGIN` and the RPC are read at run time, not here.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [react()],
  trailingSlash: "ignore",
  compressHTML: true,
  devToolbar: { enabled: false },
  server: { host: true, port: Number(process.env.PORT) || 4321 },
  build: { inlineStylesheets: "auto" },
  vite: {
    // `fileURLToPath`, not `.pathname`: the repository path may contain a space.
    resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  },
});
