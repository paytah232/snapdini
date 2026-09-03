-- Permission to PUBLISH a survey comment as a testimonial.
--
-- `contact_opt_in` already existed, but consenting to be contacted is not consenting to be quoted
-- on a public website — using it that way would be wrong, and in some jurisdictions unlawful. This
-- is an explicit, separate opt-in, plus the name the customer is happy to be credited as.
ALTER TABLE "survey_responses" ADD COLUMN IF NOT EXISTS "testimonial_ok"   boolean NOT NULL DEFAULT false;
ALTER TABLE "survey_responses" ADD COLUMN IF NOT EXISTS "testimonial_name" text;
-- Set once the operator actually publishes it, so the site can show a curated set rather than
-- everything that was ever consented to.
ALTER TABLE "survey_responses" ADD COLUMN IF NOT EXISTS "published_at"     bigint;

-- The site will query "consented and published, best first".
CREATE INDEX IF NOT EXISTS "idx_survey_publishable"
  ON "survey_responses" ("created_at") WHERE "testimonial_ok";
