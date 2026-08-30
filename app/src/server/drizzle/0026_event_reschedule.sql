-- Reschedule an UNUSED event. Gate is usage, not time: an event that no guest ever
-- joined can be moved even after it has ended. `original_starts_at` anchors the
-- 6-month window so repeated reschedules can't walk the event forward forever.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "original_starts_at" bigint;

-- Backfill: existing events anchor on their current start.
UPDATE "events" SET "original_starts_at" = "starts_at" WHERE "original_starts_at" IS NULL;
