CREATE TABLE IF NOT EXISTS "youtube_upload_sessions" (
  "publication_id" text PRIMARY KEY REFERENCES "publications"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "size" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
