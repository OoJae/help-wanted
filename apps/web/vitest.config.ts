import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // No test may touch the network: `test/setup.ts` replaces `fetch` with a function that throws.
    setupFiles: ["test/setup.ts"],
  },
});
