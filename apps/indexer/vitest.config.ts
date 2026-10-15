import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // No test may touch the network: this makes fetch and sockets throw.
    setupFiles: ["test/helpers/noNetwork.ts"],
    // Each test file starts its own in-memory Postgres; the first query pays for the start-up.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
