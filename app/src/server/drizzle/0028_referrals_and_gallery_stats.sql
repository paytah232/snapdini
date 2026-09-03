-- ── Guest referral funnel ────────────────────────────────────────────────────
-- Guests are the only warm audience the product has: they have just used it at someone else's
-- event. Attribution is stamped from a `ref` cookie at BOTH signup and event creation, because a
-- guest may sign up weeks before they run anything.
ALTER TABLE "users"  ADD COLUMN IF NOT EXISTS "referred_by_event_id" text;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "referred_by_event_id" text;

-- Counters on the SOURCE event, so a host can see what their gallery generated.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "gallery_views"    integer NOT NULL DEFAULT 0;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "referral_clicks"  integer NOT NULL DEFAULT 0;

-- ── Host reward ──────────────────────────────────────────────────────────────
-- A single-use Stripe promotion code issued to the host after their event, valid ~90 days towards
-- their NEXT event. Stored here only so we can show it and avoid re-issuing; Stripe remains the
-- authority on redemption.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "host_reward_code"       text;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "host_reward_expires_at" bigint;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "host_reward_sent_at"    bigint;

-- ── Gallery engagement ───────────────────────────────────────────────────────
-- Per-item counters rather than one row per view: at this volume a counter answers every question
-- we have ("which photos got looked at / downloaded") without an unbounded analytics table.
ALTER TABLE "photos" ADD COLUMN IF NOT EXISTS "view_count"     integer NOT NULL DEFAULT 0;
ALTER TABLE "photos" ADD COLUMN IF NOT EXISTS "download_count" integer NOT NULL DEFAULT 0;

-- Funnel queries filter by these, and referral lookups join on them.
CREATE INDEX IF NOT EXISTS "idx_users_referred_by"  ON "users"  ("referred_by_event_id")
  WHERE "referred_by_event_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_events_referred_by" ON "events" ("referred_by_event_id")
  WHERE "referred_by_event_id" IS NOT NULL;
