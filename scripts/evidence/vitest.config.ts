// The tests of the evidence builder run on vitest from the shared package's install:
//   pnpm evidence:test
// Test files may import viem (to build logs to count); everything else in this folder imports
// nothing by package name.
import { fileURLToPath } from "node:url";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default {
  root: at("."),
  resolve: { alias: { viem: at("../../packages/shared/node_modules/viem") } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
    // A few tests start `node` or `bash`; on a busy machine that alone can take seconds.
    testTimeout: 30_000,
  },
};
