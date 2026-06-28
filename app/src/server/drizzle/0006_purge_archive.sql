-- Retention-end archive: keep a slim event record (settings + final stats) after media is
-- purged. Idempotent.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "purged_at" bigint;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "stat_participants" integer DEFAULT 0 NOT NULL;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "stat_photos" integer DEFAULT 0 NOT NULL;
