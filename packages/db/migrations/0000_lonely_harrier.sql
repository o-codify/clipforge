CREATE TYPE "public"."account_role" AS ENUM('admin', 'streamer', 'moderator', 'user');--> statement-breakpoint
CREATE TYPE "public"."automation_scope" AS ENUM('global', 'game', 'streamer', 'pair');--> statement-breakpoint
CREATE TYPE "public"."clip_state" AS ENUM('draft', 'ready', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."discovery_status" AS ENUM('new', 'added', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."game_state" AS ENUM('known', 'active', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."publication_status" AS ENUM('draft', 'queued', 'uploading', 'uploaded', 'processing', 'published', 'failed', 'takedown');--> statement-breakpoint
CREATE TYPE "public"."streamer_state" AS ENUM('candidate', 'active', 'paused');--> statement-breakpoint
CREATE TYPE "public"."vod_state" AS ENUM('known', 'fetching', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"login" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "account_role" DEFAULT 'user' NOT NULL,
	"streamer" text,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "automation" (
	"scope" "automation_scope" NOT NULL,
	"key" text DEFAULT '' NOT NULL,
	"enabled" boolean,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "clips" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"vod_id" text NOT NULL,
	"streamer" text NOT NULL,
	"game" text,
	"segment_key" text NOT NULL,
	"version" text DEFAULT '' NOT NULL,
	"file" text NOT NULL,
	"trigger" text,
	"peak" double precision,
	"start" double precision,
	"end" double precision,
	"duration" double precision,
	"score" double precision,
	"parts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"text" text,
	"width" integer,
	"height" integer,
	"fps" real,
	"size_bytes" integer,
	"state" "clip_state" DEFAULT 'draft' NOT NULL,
	"blocked_reason" text,
	"archived_at" timestamp with time zone,
	"archive_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery" (
	"login" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"game" text,
	"language" text,
	"viewers" integer,
	"followers" integer,
	"score" double precision DEFAULT 0 NOT NULL,
	"reason" text,
	"status" "discovery_status" DEFAULT 'new' NOT NULL,
	"found_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "games" (
	"slug" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"twitch_id" text,
	"box_art" text,
	"state" "game_state" DEFAULT 'known' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_attempts" (
	"vod_id" text PRIMARY KEY NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"external_id" text DEFAULT '' NOT NULL,
	"credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_runtime" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publication_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"publication_id" text NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"views" integer,
	"likes" integer,
	"comments" integer,
	"shares" integer,
	"extended" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" text PRIMARY KEY NOT NULL,
	"clip_id" text NOT NULL,
	"platform" text NOT NULL,
	"account" text DEFAULT '' NOT NULL,
	"operation_id" text,
	"media_id" text,
	"url" text,
	"status" "publication_status" DEFAULT 'draft' NOT NULL,
	"privacy" text,
	"title" text,
	"caption" text,
	"scheduled_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"vod_id" text NOT NULL,
	"streamer" text NOT NULL,
	"game" text,
	"out_dir" text NOT NULL,
	"candidates" integer DEFAULT 0 NOT NULL,
	"version" text DEFAULT '' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"acting_as" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "streamer_games" (
	"streamer" text NOT NULL,
	"game" text NOT NULL,
	"seconds" double precision DEFAULT 0 NOT NULL,
	"streams" integer DEFAULT 0 NOT NULL,
	"last_seen" timestamp with time zone,
	CONSTRAINT "streamer_games_streamer_game_pk" PRIMARY KEY("streamer","game")
);
--> statement-breakpoint
CREATE TABLE "streamers" (
	"login" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"twitch_id" text,
	"avatar" text,
	"description" text,
	"followers" integer,
	"language" text,
	"live" boolean DEFAULT false NOT NULL,
	"live_game" text,
	"live_viewers" integer,
	"last_game" text,
	"state" "streamer_state" DEFAULT 'candidate' NOT NULL,
	"auto_publish" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone,
	"indexed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"vod_id" text PRIMARY KEY NOT NULL,
	"language" text NOT NULL,
	"duration" double precision NOT NULL,
	"model" text NOT NULL,
	"segments" jsonb NOT NULL,
	"dropped_loops" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vods" (
	"id" text PRIMARY KEY NOT NULL,
	"streamer" text NOT NULL,
	"game" text,
	"title" text,
	"duration" double precision,
	"chapters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" "vod_state" DEFAULT 'known' NOT NULL,
	"error" text,
	"facecam" jsonb,
	"signals" jsonb,
	"published_at" timestamp with time zone,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_vod_id_vods_id_fk" FOREIGN KEY ("vod_id") REFERENCES "public"."vods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_attempts" ADD CONSTRAINT "pipeline_attempts_vod_id_vods_id_fk" FOREIGN KEY ("vod_id") REFERENCES "public"."vods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_metrics" ADD CONSTRAINT "publication_metrics_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_vod_id_vods_id_fk" FOREIGN KEY ("vod_id") REFERENCES "public"."vods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streamer_games" ADD CONSTRAINT "streamer_games_streamer_streamers_login_fk" FOREIGN KEY ("streamer") REFERENCES "public"."streamers"("login") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streamer_games" ADD CONSTRAINT "streamer_games_game_games_slug_fk" FOREIGN KEY ("game") REFERENCES "public"."games"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_vod_id_vods_id_fk" FOREIGN KEY ("vod_id") REFERENCES "public"."vods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vods" ADD CONSTRAINT "vods_streamer_streamers_login_fk" FOREIGN KEY ("streamer") REFERENCES "public"."streamers"("login") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vods" ADD CONSTRAINT "vods_game_games_slug_fk" FOREIGN KEY ("game") REFERENCES "public"."games"("slug") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_login_key" ON "accounts" USING btree (lower("login"));--> statement-breakpoint
CREATE UNIQUE INDEX "clips_segment_version_key" ON "clips" USING btree ("vod_id","segment_key","version");--> statement-breakpoint
CREATE INDEX "clips_run_idx" ON "clips" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "clips_streamer_idx" ON "clips" USING btree ("streamer");--> statement-breakpoint
CREATE INDEX "clips_game_idx" ON "clips" USING btree ("game");--> statement-breakpoint
CREATE INDEX "clips_state_idx" ON "clips" USING btree ("state");--> statement-breakpoint
CREATE INDEX "clips_trigger_idx" ON "clips" USING btree ("trigger");--> statement-breakpoint
CREATE INDEX "discovery_status_idx" ON "discovery" USING btree ("status","score");--> statement-breakpoint
CREATE INDEX "job_events_job_idx" ON "job_events" USING btree ("job_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_accounts_key" ON "platform_accounts" USING btree ("platform","external_id");--> statement-breakpoint
CREATE INDEX "metrics_publication_idx" ON "publication_metrics" USING btree ("publication_id","collected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "publications_target_key" ON "publications" USING btree ("clip_id","platform","account");--> statement-breakpoint
CREATE INDEX "publications_status_idx" ON "publications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runs_vod_idx" ON "runs" USING btree ("vod_id");--> statement-breakpoint
CREATE INDEX "sessions_account_idx" ON "sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "streamer_games_game_idx" ON "streamer_games" USING btree ("game");--> statement-breakpoint
CREATE INDEX "streamers_state_idx" ON "streamers" USING btree ("state");--> statement-breakpoint
CREATE INDEX "vods_streamer_idx" ON "vods" USING btree ("streamer");--> statement-breakpoint
CREATE INDEX "vods_game_idx" ON "vods" USING btree ("game");--> statement-breakpoint
CREATE INDEX "vods_state_idx" ON "vods" USING btree ("state");