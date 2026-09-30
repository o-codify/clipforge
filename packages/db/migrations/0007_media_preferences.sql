ALTER TABLE streamers ADD COLUMN IF NOT EXISTS ad_check_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE vods ADD COLUMN IF NOT EXISTS ad_check_enabled boolean;
ALTER TABLE streamers DROP CONSTRAINT IF EXISTS streamers_audio_mode_check;
ALTER TABLE vods DROP CONSTRAINT IF EXISTS vods_audio_mode_check;
ALTER TABLE streamers ADD CONSTRAINT streamers_audio_mode_check CHECK (audio_mode IN ('original','dtln','dtln-gated'));
ALTER TABLE vods ADD CONSTRAINT vods_audio_mode_check CHECK (audio_mode IN ('original','dtln','dtln-gated'));
