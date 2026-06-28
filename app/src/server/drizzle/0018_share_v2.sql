ALTER TABLE "shares" ADD COLUMN IF NOT EXISTS "label" text;
ALTER TABLE "shares" ADD COLUMN IF NOT EXISTS "slug" text;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_shares_slug" ON "shares" ("slug") WHERE "slug" IS NOT NULL;
