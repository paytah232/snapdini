-- Persist the poster designer's customisation against the event. Idempotent.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "poster_config" text;
