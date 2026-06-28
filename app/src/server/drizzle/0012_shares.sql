-- Shareable gallery links: whole-library ('all') or a hand-picked subset ('selected'). Idempotent.
CREATE TABLE IF NOT EXISTS "shares" (
  "id" text PRIMARY KEY,
  "event_id" text NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "kind" text NOT NULL DEFAULT 'all',
  "photo_ids" text,
  "created_at" bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "shares_event_idx" ON "shares" ("event_id");
