ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "guest_cap" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "video_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "paid" boolean DEFAULT false NOT NULL;