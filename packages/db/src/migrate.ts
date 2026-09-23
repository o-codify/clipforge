import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "./client.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDatabase({ url });
try {
  let connected = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await db.sql`select 1`; connected = true; break; }
    catch { console.log("Waiting for PostgreSQL…"); await new Promise(r => setTimeout(r, 2000)); }
  }
  if (!connected) throw new Error("PostgreSQL is unavailable; application was not started");
  const lease = await db.sql.reserve();
  try {
    await lease`select pg_advisory_lock(740022)`;
    const [schema] = await lease`select to_regclass('public.accounts') as accounts,
      to_regclass('drizzle.__drizzle_migrations') as migrations`;
    if (!schema) throw new Error("Could not inspect database schema");
    if (schema.accounts && !schema.migrations) {
      throw new Error("Existing database has no migration history. Back it up and baseline it explicitly; automatic schema replacement is forbidden.");
    }
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
    console.log("Database migrations complete");
  } finally {
    await lease`select pg_advisory_unlock(740022)`;
    lease.release();
  }
} finally { await db.close(); }
