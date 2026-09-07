-- First-party product analytics. Deliberately NOT a third-party tag: the README sells "no GTAG_ID
-- => zero third-party tracking", and the point of this table is to answer "where do people give
-- up" without contradicting that.
--
-- Cookieless by design. There is no identifier stored on the visitor's device: `visit` is a hash of
-- (daily-rotating salt + IP + user-agent), computed server-side and never reversible, so sessions
-- can be stitched within a day for funnel maths and cannot be followed across days or sites. The
-- raw IP is never written.
CREATE TABLE IF NOT EXISTS "site_events" (
  "id"         bigserial PRIMARY KEY,
  "name"       text    NOT NULL,          -- from a server-side allowlist; never free text
  "path"       text,                      -- route pattern, never a full URL with query
  "visit"      text,                      -- daily, non-reversible visit hash (see above)
  "event_id"   text,                      -- the Snapdini event, when guest-side. No FK: analytics
                                          -- must survive the retention purge deleting the event.
  "props"      jsonb   NOT NULL DEFAULT '{}'::jsonb,
  "created_at" bigint  NOT NULL
);

-- The three shapes every panel query uses: newest-first, count-by-name over a window, and
-- per-visit funnel stitching.
CREATE INDEX IF NOT EXISTS "idx_site_events_created" ON "site_events" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_site_events_name_created" ON "site_events" ("name", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_site_events_visit" ON "site_events" ("visit") WHERE "visit" IS NOT NULL;
