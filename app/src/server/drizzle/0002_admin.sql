-- Site admin flag (bootstrapped from ADMIN_EMAIL/ADMIN_PASSWORD env). Idempotent.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_admin" boolean DEFAULT false NOT NULL;
