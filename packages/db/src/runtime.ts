import { sql } from "drizzle-orm";
import type { Database } from "./client.js";

/** Additive, idempotent upgrade for existing installations. Never drops data. */
export async function upgradeRuntime(db: Database): Promise<void> {
  await db.execute(sql`ALTER TYPE account_role ADD VALUE IF NOT EXISTS 'moderator'`);
  await db.execute(sql`ALTER TYPE account_role ADD VALUE IF NOT EXISTS 'user'`);
  await db.execute(sql`UPDATE accounts SET role = 'user' WHERE role = 'streamer'`);
  await db.execute(sql`ALTER TABLE publications ADD COLUMN IF NOT EXISTS privacy text`);
  await db.execute(sql`ALTER TABLE clips ADD COLUMN IF NOT EXISTS archived_at timestamptz`);
  await db.execute(sql`ALTER TABLE clips ADD COLUMN IF NOT EXISTS archive_reason text`);
  await db.execute(sql`ALTER TABLE clips ADD COLUMN IF NOT EXISTS media_storage jsonb`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS platform_runtime (
    key text PRIMARY KEY, value jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS job_events (
    id bigserial PRIMARY KEY, job_id uuid NOT NULL, message text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events(job_id, id)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS pipeline_attempts (
    vod_id text PRIMARY KEY REFERENCES vods(id) ON DELETE CASCADE,
    attempts integer NOT NULL DEFAULT 0, state text NOT NULL DEFAULT 'pending',
    error text, updated_at timestamptz NOT NULL DEFAULT now()
  )`);
}

export async function runtimeValue(db: Database, key: string, value: unknown): Promise<void> {
  await db.execute(sql`INSERT INTO platform_runtime(key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`);
}

/** All producers share this lock, including the API and scheduler. */
export async function enqueueUnique(db: Database, queue: string, key: string, send: () => Promise<string | null>): Promise<string | null> {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const existing = await tx.execute(sql`select id from jobs.job
      where name = ${queue} and singleton_key = ${key} and state in ('created','retry','active') limit 1`);
    if (existing.length) return null;
    return send();
  });
}

export async function withVodLock<T>(db: Database, vodId: string, work: () => Promise<T>): Promise<T> {
  const connection = await db.sql.reserve();
  const key = `vod:${vodId}`;
  try {
    await connection`select pg_advisory_lock(hashtextextended(${key}, 0))`;
    return await work();
  } finally {
    await connection`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
    connection.release();
  }
}
