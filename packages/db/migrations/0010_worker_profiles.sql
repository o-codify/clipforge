ALTER TABLE remote_worker_leases ALTER COLUMN vod_id DROP NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS remote_lease_catalog_active ON remote_worker_leases(queue,(payload->>'login')) WHERE state='active' AND vod_id IS NULL;
