-- Per-event photo retention (days kept after the event ends). Idempotent.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "retention_days" integer DEFAULT 7 NOT NULL;
