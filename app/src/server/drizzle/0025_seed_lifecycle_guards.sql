-- Seed lifecycle-email guards for EXISTING rows so enabling emails never triggers a retroactive
-- blast (no "welcome"/"nudge" to established accounts, no "how did it go?" for past events). Runs
-- once, before the sweep starts. Rows created AFTER this migration flow through the normal lifecycle;
-- future events (e.g. one two months out) keep NULL guards, so they still get check-in + survey when due.

UPDATE "users"
   SET "account_welcome_sent_at"  = COALESCE("account_welcome_sent_at",  (extract(epoch from now()) * 1000)::bigint),
       "activation_nudge_sent_at" = COALESCE("activation_nudge_sent_at", (extract(epoch from now()) * 1000)::bigint);

-- Check-in: mark events already within/past the ~6-day pre-event window as handled.
UPDATE "events"
   SET "checkin_sent_at" = (extract(epoch from now()) * 1000)::bigint
 WHERE "checkin_sent_at" IS NULL
   AND "starts_at" <= (extract(epoch from now()) * 1000)::bigint + 6 * 86400000;

-- Survey: mark already-ended events as handled (no retroactive survey).
UPDATE "events"
   SET "feedback_sent_at" = (extract(epoch from now()) * 1000)::bigint
 WHERE "feedback_sent_at" IS NULL
   AND "expires_at" <= (extract(epoch from now()) * 1000)::bigint;
