/**
 * The database the tests run on: an in-memory Postgres (PGlite) with the real migrations applied,
 * one per test file.
 *
 * Production runs on a Postgres server through another driver (node-postgres). To run the same
 * tests on that path, set `TEST_DATABASE_URL` to a server on this machine, for example a CI
 * service container: `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres`.
 * Each test file then gets a database of its own on that server, created before and dropped
 * after, so files running side by side never see each other's rows. The role must be allowed to
 * create databases. Without the variable nothing leaves the process.
 */
import { getTableName, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { SyncConfig } from "../../src/config.js";
import { openDatabase, type Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";

function isTable(value: unknown): value is PgTable {
  return typeof value === "object" && value !== null && Symbol.for("drizzle:IsDrizzleTable") in value;
}

export const ALL_TABLES: PgTable[] = (Object.values(schema) as unknown[]).filter(isTable);

/** The Postgres server to test on, or null for the embedded database. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() || null;

async function onServer(serverUrl: string, statement: string): Promise<void> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: serverUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

export async function openTestDatabase(): Promise<Database> {
  if (TEST_DATABASE_URL === null) return openDatabase({ pgliteDir: null });

  // Letters, digits and underscores only: the name goes into the statement as an identifier.
  const name = `hw_test_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const serverUrl = TEST_DATABASE_URL;
  await onServer(serverUrl, `create database ${name}`);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const database = await openDatabase({ databaseUrl: url.toString() });
  return {
    ...database,
    close: async () => {
      await database.close();
      await onServer(serverUrl, `drop database if exists ${name}`);
    },
  };
}

/** Empties every table, so tests in one file do not see each other's rows. */
export async function emptyDatabase(database: Database): Promise<void> {
  for (const table of ALL_TABLES) await database.db.delete(table);
}

export async function countRows(database: Database, table: PgTable): Promise<number> {
  const result = await database.db.execute(
    sql`select count(*)::int as n from ${sql.identifier(getTableName(table))}`,
  );
  const rows = (result as unknown as { rows: { n: number }[] }).rows;
  return rows[0]?.n ?? 0;
}

/** Sync settings for tests: start at a fixed block, no waiting for confirmations unless asked. */
export function testSync(overrides: Partial<SyncConfig> & { start: number }): SyncConfig {
  const { start, ...rest } = overrides;
  return {
    startBlock: { kind: "absolute", block: start },
    startBlocks: {},
    chunkSize: 2000,
    confirmations: 0,
    reorgDepth: 64,
    pollIntervalMs: 1000,
    ...rest,
  };
}
