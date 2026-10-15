import { defineConfig } from "drizzle-kit";

// Used only by `pnpm db:generate`, which turns `src/db/schema.ts` into SQL under `drizzle/`.
// It never connects to a database: the indexer applies the migrations itself when it starts.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
