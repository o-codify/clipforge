import {sql} from 'drizzle-orm';
import type {Database} from './client.js';

export async function upgradeRemoteWorkers(db:Database){
  await db.execute(sql`create table if not exists remote_worker_enrollments (
    id uuid primary key, token_hash text unique not null, label text not null, policy jsonb not null,
    expires_at timestamptz not null, worker_id text, created_at timestamptz not null default now())`);
  await db.execute(sql`create table if not exists remote_worker_auth (
    worker_id text primary key references worker_instances(id), secret_hash text unique not null,
    policy jsonb not null, revoked_at timestamptz)`);
  await db.execute(sql`create table if not exists remote_worker_leases (
    id uuid primary key, job_id uuid not null, worker_id text not null references remote_worker_auth(worker_id),
    queue text not null, vod_id text not null references vods(id), payload jsonb not null,
    state text not null default 'active', expires_at timestamptz not null,
    created_at timestamptz not null default now(), finished_at timestamptz)`);
  await db.execute(sql`create unique index if not exists remote_lease_job_active on remote_worker_leases(job_id) where state='active'`);
  await db.execute(sql`alter table remote_worker_leases alter column vod_id drop not null`);
  await db.execute(sql`create unique index if not exists remote_lease_catalog_active on remote_worker_leases(queue,(payload->>'login')) where state='active' and vod_id is null`);
  await db.execute(sql`create unique index if not exists remote_lease_vod_active on remote_worker_leases(vod_id) where state='active'`);
  await db.execute(sql`create unique index if not exists remote_lease_worker_active on remote_worker_leases(worker_id) where state='active'`);
  await db.execute(sql`create table if not exists remote_worker_uploads (
    id uuid primary key, lease_id uuid not null references remote_worker_leases(id), clip_id text not null,
    kind text not null check(kind in ('video','poster')), size bigint not null, sha256 text not null,
    received bigint not null default 0, state text not null default 'receiving', storage_key text,
    created_at timestamptz not null default now(), unique(lease_id,clip_id,kind))`);
}
