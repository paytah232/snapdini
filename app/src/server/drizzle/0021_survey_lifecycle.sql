ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "welcome_sent_at" bigint;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "checkin_sent_at" bigint;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "feedback_sent_at" bigint;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "survey_token" text;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_events_survey_token" ON "events" ("survey_token") WHERE "survey_token" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "survey_responses" (
  "id" text PRIMARY KEY NOT NULL,
  "event_id" text NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "overall" smallint,
  "setup" smallint,
  "guest_experience" smallint,
  "value" smallint,
  "nps" smallint,
  "comments" text,
  "contact_opt_in" boolean DEFAULT false NOT NULL,
  "created_at" bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_survey_event" ON "survey_responses" ("event_id");
