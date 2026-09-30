CREATE TABLE IF NOT EXISTS remote_worker_enrollments (
  id uuid PRIMARY KEY, token_hash text UNIQUE NOT NULL, label text NOT NULL, policy jsonb NOT NULL,
  expires_at timestamptz NOT NULL, worker_id text, created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS remote_worker_auth (
  worker_id text PRIMARY KEY REFERENCES worker_instances(id), secret_hash text UNIQUE NOT NULL,
  policy jsonb NOT NULL, revoked_at timestamptz
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS remote_worker_leases (
  id uuid PRIMARY KEY, job_id uuid NOT NULL, worker_id text NOT NULL REFERENCES remote_worker_auth(worker_id),
  queue text NOT NULL, vod_id text NOT NULL REFERENCES vods(id), payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'active', expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS remote_lease_job_active ON remote_worker_leases(job_id) WHERE state='active';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS remote_lease_vod_active ON remote_worker_leases(vod_id) WHERE state='active';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS remote_lease_worker_active ON remote_worker_leases(worker_id) WHERE state='active';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS remote_worker_uploads (
  id uuid PRIMARY KEY, lease_id uuid NOT NULL REFERENCES remote_worker_leases(id), clip_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('video','poster')), size bigint NOT NULL, sha256 text NOT NULL,
  received bigint NOT NULL DEFAULT 0, state text NOT NULL DEFAULT 'receiving', storage_key text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(lease_id,clip_id,kind)
);
