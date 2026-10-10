import { sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {upgradeRemoteWorkers} from './remote-workers.js';

/** Additive, idempotent upgrade for existing installations. Never drops data. */
export async function upgradeRuntime(db: Database): Promise<void> {
  await db.execute(sql`ALTER TABLE vods ADD COLUMN IF NOT EXISTS ad_protection jsonb`);
  await db.execute(sql`ALTER TABLE streamers ADD COLUMN IF NOT EXISTS audio_mode text NOT NULL DEFAULT 'original' CHECK (audio_mode IN ('original','dtln','dtln-gated'))`);
  await db.execute(sql`ALTER TABLE vods ADD COLUMN IF NOT EXISTS audio_mode text CHECK (audio_mode IN ('original','dtln','dtln-gated'))`);
  await db.execute(sql`ALTER TYPE account_role ADD VALUE IF NOT EXISTS 'moderator'`);
  await db.execute(sql`ALTER TYPE account_role ADD VALUE IF NOT EXISTS 'user'`);
  await db.execute(sql`UPDATE accounts SET role = 'user' WHERE role = 'streamer'`);
  await db.execute(sql`ALTER TABLE accounts ALTER COLUMN role SET DEFAULT 'user'`);
  await db.execute(sql`ALTER TABLE publications ADD COLUMN IF NOT EXISTS privacy text`);
  await db.execute(sql`ALTER TABLE clips ADD COLUMN IF NOT EXISTS archived_at timestamptz`);
  await db.execute(sql`ALTER TABLE clips ADD COLUMN IF NOT EXISTS archive_reason text`);
  await db.execute(sql`ALTER TABLE clips ADD COLUMN IF NOT EXISTS media_storage jsonb`);
  await db.execute(sql`ALTER TABLE clips ADD COLUMN IF NOT EXISTS media_released_at timestamptz`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS youtube_upload_sessions (
    publication_id text PRIMARY KEY REFERENCES publications(id) ON DELETE CASCADE,
    url text NOT NULL, size bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS platform_runtime (
    key text PRIMARY KEY, value jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS job_events (
    id bigserial PRIMARY KEY, job_id uuid NOT NULL, message text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events(job_id, id)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS worker_instances (
    id text PRIMARY KEY,label text NOT NULL,host text NOT NULL,role text NOT NULL,
    queues jsonb NOT NULL DEFAULT '[]',resources jsonb NOT NULL DEFAULT '{}',
    state text NOT NULL DEFAULT 'online',draining boolean NOT NULL DEFAULT false,
    started_at timestamptz NOT NULL DEFAULT now(),heartbeat_at timestamptz NOT NULL DEFAULT now(),version text
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS worker_jobs (
    job_id uuid PRIMARY KEY,worker_id text NOT NULL REFERENCES worker_instances(id),
    started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,stage text,
    heartbeat_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS worker_jobs_worker_idx ON worker_jobs(worker_id,started_at desc)`);
  await upgradeRemoteWorkers(db);
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
    // A remote assignment is durable across API restarts. A legacy/native
    // worker must not start the same VOD while its remote lease is alive.
    while((await connection`select 1 from remote_worker_leases where vod_id=${vodId} and state='active' and expires_at>now() limit 1`).length)
      await new Promise(resolve=>setTimeout(resolve,1000));
    return await work();
  } finally {
    await connection`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
    connection.release();
  }
}
