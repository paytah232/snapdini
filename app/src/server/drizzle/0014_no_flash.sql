ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "no_flash" boolean DEFAULT false NOT NULL;
