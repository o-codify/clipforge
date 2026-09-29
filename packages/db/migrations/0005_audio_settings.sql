ALTER TABLE "streamers" ADD COLUMN IF NOT EXISTS "audio_mode" text NOT NULL DEFAULT 'original' CHECK (audio_mode IN ('original','dtln'));
--> statement-breakpoint
ALTER TABLE "vods" ADD COLUMN IF NOT EXISTS "audio_mode" text CHECK (audio_mode IN ('original','dtln'));
