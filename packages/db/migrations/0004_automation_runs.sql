CREATE TABLE IF NOT EXISTS automation_runs (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  state text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  output jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS automation_runs_name_started_idx ON automation_runs (name, started_at DESC);
