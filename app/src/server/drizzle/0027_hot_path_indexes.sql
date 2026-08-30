-- Indexes for the queries that run on a timer or grow without bound. Nothing here matters at
-- current row counts — Postgres rightly prefers a seq scan on a 25-row table — but each of these
-- backs a query whose cost rises with traffic, and partial indexes stay tiny.

-- Retention sweeper runs hourly: SELECT ... WHERE purge_at IS NOT NULL AND purge_at < now.
-- Partial, so it only ever holds rows still awaiting purge.
CREATE INDEX IF NOT EXISTS "idx_events_purge_at"
  ON "events" ("purge_at") WHERE "purge_at" IS NOT NULL;

-- Lifecycle/reminder passes scan by window: starts_at BETWEEN now AND now+7d, expires_at > now.
CREATE INDEX IF NOT EXISTS "idx_events_starts_at" ON "events" ("starts_at");
CREATE INDEX IF NOT EXISTS "idx_events_expires_at" ON "events" ("expires_at");

-- client_errors grows with every browser error and is read by the error-spike check on a timer
-- (created_at > now-1h), the daily digest (NOT handled) and a TTL delete (created_at < cutoff).
CREATE INDEX IF NOT EXISTS "idx_client_errors_created" ON "client_errors" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_client_errors_open"
  ON "client_errors" ("created_at") WHERE NOT "handled";

-- contact_messages is ordered "unhandled first, newest first" in Site admin and counted by the
-- digest. Spam makes this the table most likely to grow unexpectedly.
CREATE INDEX IF NOT EXISTS "idx_contact_open"
  ON "contact_messages" ("created_at") WHERE NOT "handled";
