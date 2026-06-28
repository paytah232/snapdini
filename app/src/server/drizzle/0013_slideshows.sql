-- Versioned slideshow exports (recent list; favourite = retained). Idempotent.
CREATE TABLE IF NOT EXISTS "slideshows" (
  "id" text PRIMARY KEY,
  "event_id" text NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "filename" text NOT NULL,
  "favourite" boolean NOT NULL DEFAULT false,
  "label" text,
  "created_at" bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "slideshows_event_idx" ON "slideshows" ("event_id");
