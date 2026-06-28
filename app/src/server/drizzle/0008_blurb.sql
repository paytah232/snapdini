-- Optional event blurb (welcome line shown under the title on the join screen). Idempotent.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "blurb" text;
