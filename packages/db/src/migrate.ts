import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
// Drizzle reads its own ledger using snake_case keys (created_at). The application's
// camelCase row transform makes existing migrations invisible to that comparison.
const sql = postgres(url, { max: 2, connect_timeout: 5, onnotice: () => {} });
const db = drizzle(sql);
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
try {
  let connected = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await sql`select 1`; connected = true; break; }
    catch { console.log("Waiting for PostgreSQL…"); await new Promise(r => setTimeout(r, 2000)); }
  }
  if (!connected) throw new Error("PostgreSQL is unavailable; application was not started");
  const lease = await sql.reserve();
  try {
    await lease`select pg_advisory_lock(740022)`;
    const [schema] = await lease`select to_regclass('public.accounts') as accounts,
      to_regclass('drizzle.__drizzle_migrations') as migrations`;
    if (!schema) throw new Error("Could not inspect database schema");
    if (schema.accounts && !schema.migrations) {
      throw new Error("Existing database has no migration history. Back it up and baseline it explicitly; automatic schema replacement is forbidden.");
    }
    await migrate(db, { migrationsFolder });
    const applied = await lease`select hash, created_at from drizzle.__drizzle_migrations`;
    for (const migration of readMigrationFiles({ migrationsFolder })) {
      if (!applied.some(row => row.hash === migration.hash && Number(row.created_at) === migration.folderMillis)) {
        throw new Error("Migration history does not match this release; application was not started");
      }
    }
    console.log("Database migrations complete");
  } finally {
    await lease`select pg_advisory_unlock(740022)`;
    lease.release();
  }
} finally { await sql.end({ timeout: 5 }); }
