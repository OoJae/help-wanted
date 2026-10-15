import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The integration test starts a local node and compiles the stand-in contracts first.
    testTimeout: 120_000,
    hookTimeout: 240_000,
  },
});
