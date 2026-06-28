-- Organizer "Hide photos" override — lets a manager force-hide even an ended at_end event. Idempotent.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "reveal_hidden" boolean NOT NULL DEFAULT false;
