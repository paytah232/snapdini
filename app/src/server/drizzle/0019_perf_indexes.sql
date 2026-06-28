-- 1.0 performance pass: index the hot query paths. photos + participants are filtered by event_id
-- on virtually every gallery view, count, download and slideshow render but had no such index, so
-- each was a full table scan over ALL events' rows.
CREATE INDEX IF NOT EXISTS "idx_photos_event" ON "photos" ("event_id");
CREATE INDEX IF NOT EXISTS "idx_photos_event_status" ON "photos" ("event_id", "status");
CREATE INDEX IF NOT EXISTS "idx_photos_event_taken" ON "photos" ("event_id", "taken_at");
CREATE INDEX IF NOT EXISTS "idx_photos_participant" ON "photos" ("participant_id");
CREATE INDEX IF NOT EXISTS "idx_participants_event" ON "participants" ("event_id");
-- Co-host invites are looked up case-insensitively by email (a functional index is required so the
-- lower() lookup can use it).
CREATE INDEX IF NOT EXISTS "idx_cohosts_email_lower" ON "event_cohosts" (lower("email"));
-- Unindexed FKs that get scanned on account deletion / cascade.
CREATE INDEX IF NOT EXISTS "idx_sessions_user" ON "sessions" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_email_tokens_user" ON "email_tokens" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_auth_identities_user" ON "auth_identities" ("user_id");
