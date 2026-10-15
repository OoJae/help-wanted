/**
 * The tables: that the committed migrations are what the code's table definitions describe, and
 * that they build a working database from nothing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableName, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { ALL_MODULES } from "../src/modules/index.js";
import { ALL_TABLES, openTestDatabase } from "./helpers/db.js";

let database: Database;

beforeAll(async () => {
  database = await openTestDatabase();
});
afterAll(async () => {
  await database.close();
});

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("migrations", () => {
  it("are up to date with the table definitions (run `pnpm db:generate` if this fails)", async () => {
    const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
    const journal = JSON.parse(read("../drizzle/meta/_journal.json")) as { entries: { idx: number }[] };
    const last = journal.entries.at(-1);
    if (!last) throw new Error("no migration has been generated");
    const committed = JSON.parse(
      read(`../drizzle/meta/${String(last.idx).padStart(4, "0")}_snapshot.json`),
    ) as {
      id: string;
    };
    const current = generateDrizzleJson(schema as Record<string, unknown>, committed.id);
    const missing = await generateMigration(committed as never, current);
    expect(missing).toEqual([]);
  });

  it("create every table the code defines, with every column", async () => {
    const result = await database.db.execute(
      sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`,
    );
    const rows = (result as unknown as { rows: { table_name: string; column_name: string }[] }).rows;
    const inDatabase = new Map<string, Set<string>>();
    for (const row of rows) {
      const columns = inDatabase.get(row.table_name) ?? new Set<string>();
      columns.add(row.column_name);
      inDatabase.set(row.table_name, columns);
    }

    expect(ALL_TABLES.length).toBe(18);
    for (const table of ALL_TABLES) {
      const config = getTableConfig(table);
      const present = inDatabase.get(config.name);
      expect([config.name, present !== undefined]).toEqual([config.name, true]);
      for (const column of config.columns) {
        expect([config.name, column.name, present?.has(column.name)]).toEqual([
          config.name,
          column.name,
          true,
        ]);
      }
    }
  });

  it("can be applied to a database that already has them", async () => {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const folder = fileURLToPath(new URL("../drizzle", import.meta.url));
    await expect(migrate(database.db as never, { migrationsFolder: folder })).resolves.toBeUndefined();
  });
});

describe("tables", () => {
  it("has the tables the brief asks for, by name", () => {
    const names = ALL_TABLES.map(getTableName).sort();
    for (const wanted of [
      "orders",
      "claims",
      "pots",
      "chips",
      "feeds",
      "rounds",
      "prints",
      "payroll_movements",
      "rules",
      "receipts",
      "intake_requests",
      "fee_transfers",
      "events",
      "cursors",
    ]) {
      expect(names).toContain(wanted);
    }
  });

  it("gives every table a module writes to exactly one module", () => {
    const owner = new Map<string, string>();
    for (const module of ALL_MODULES) {
      for (const table of module.tables) {
        const name = getTableName(table);
        expect([name, owner.get(name)]).toEqual([name, undefined]);
        owner.set(name, module.name);
      }
    }
    // A replay empties a module's tables. The engine's own tables and the API mirror must never
    // be among them.
    for (const forbidden of [
      "events",
      "cursors",
      "api_health",
      "api_jobs",
      "api_job_records",
      "api_oracle_requests",
    ]) {
      expect(owner.has(forbidden)).toBe(false);
    }
  });

  it("keys every one-row-per-log table by transaction hash and log index", () => {
    for (const name of ["receipts", "fee_transfers", "payroll_movements"]) {
      const table = ALL_TABLES.find((candidate) => getTableName(candidate) === name);
      if (!table) throw new Error(`no table ${name}`);
      const [key] = getTableConfig(table).primaryKeys;
      expect([name, key?.columns.map((column) => column.name)]).toEqual([name, ["tx_hash", "log_index"]]);
    }
  });
});
