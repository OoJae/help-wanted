/**
 * Opens the database: Postgres when a connection string is given, otherwise PGlite, a full Postgres
 * compiled to WebAssembly that keeps its files in a local folder. Both speak the same SQL and run
 * the same migrations, so the rest of the code never asks which one it has.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/**
 * The query surface every function in this package takes. A transaction has the same type, so a
 * handler does not know (or care) whether it runs inside one.
 */
export type Db = PgDatabase<PgQueryResultHKT>;

export interface Database {
  db: Db;
  kind: "postgres" | "pglite";
  /** Where the data lives, for logs. Never includes a credential. */
  where: string;
  close(): Promise<void>;
}

export interface OpenDatabaseOptions {
  /** A Postgres connection string. When set, it wins. */
  databaseUrl?: string | null;
  /** A folder for PGlite. Null or undefined keeps the database in memory (tests). */
  pgliteDir?: string | null;
  /** Apply pending migrations before returning. Default true. */
  migrate?: boolean;
}

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

function describePostgres(url: string): string {
  try {
    const parsed = new URL(url);
    return `postgres://${parsed.host}${parsed.pathname}`;
  } catch {
    return "postgres";
  }
}

export async function openDatabase(options: OpenDatabaseOptions = {}): Promise<Database> {
  const shouldMigrate = options.migrate ?? true;

  if (options.databaseUrl) {
    const [{ default: pg }, { drizzle }, { migrate }] = await Promise.all([
      import("pg"),
      import("drizzle-orm/node-postgres"),
      import("drizzle-orm/node-postgres/migrator"),
    ]);
    const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 5 });
    const db = drizzle(pool);
    if (shouldMigrate) await migrate(db, { migrationsFolder: MIGRATIONS });
    return {
      db: db as unknown as Db,
      kind: "postgres",
      where: describePostgres(options.databaseUrl),
      close: () => pool.end(),
    };
  }

  const [{ PGlite }, { drizzle }, { migrate }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm/pglite"),
    import("drizzle-orm/pglite/migrator"),
  ]);
  if (options.pgliteDir) await mkdir(dirname(options.pgliteDir), { recursive: true });
  const client = options.pgliteDir ? new PGlite(options.pgliteDir) : new PGlite();
  await client.waitReady;
  const db = drizzle(client);
  if (shouldMigrate) await migrate(db, { migrationsFolder: MIGRATIONS });
  return {
    db: db as unknown as Db,
    kind: "pglite",
    where: options.pgliteDir ? `pglite:${options.pgliteDir}` : "pglite:memory",
    close: () => client.close(),
  };
}
