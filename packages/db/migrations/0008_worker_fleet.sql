CREATE TABLE IF NOT EXISTS worker_instances (
  id text PRIMARY KEY, label text NOT NULL, host text NOT NULL, role text NOT NULL,
  queues jsonb NOT NULL DEFAULT '[]', resources jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'online', draining boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(), heartbeat_at timestamptz NOT NULL DEFAULT now(), version text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS worker_jobs (
  job_id uuid PRIMARY KEY, worker_id text NOT NULL REFERENCES worker_instances(id),
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, stage text,
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS worker_jobs_worker_idx ON worker_jobs(worker_id, started_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS publication_metrics_history_idx ON publication_metrics(publication_id, collected_at DESC);
