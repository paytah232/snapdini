CREATE TABLE IF NOT EXISTS "event_cohosts" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
	"email" text NOT NULL,
	"user_id" text REFERENCES "users"("id") ON DELETE CASCADE,
	"status" text NOT NULL DEFAULT 'invited',
	"token" text NOT NULL,
	"invited_by_user_id" text,
	"created_at" bigint NOT NULL,
	"accepted_at" bigint
);
CREATE INDEX IF NOT EXISTS "idx_cohosts_event" ON "event_cohosts" ("event_id");
CREATE INDEX IF NOT EXISTS "idx_cohosts_user" ON "event_cohosts" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cohosts_token" ON "event_cohosts" ("token");
