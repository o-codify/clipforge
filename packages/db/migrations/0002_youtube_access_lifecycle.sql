ALTER TABLE "platform_accounts" ADD COLUMN "verified_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "platform_accounts" ADD COLUMN "disconnect_requested_at" timestamptz;
