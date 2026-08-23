ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "account_welcome_sent_at" bigint;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "activation_nudge_sent_at" bigint;
