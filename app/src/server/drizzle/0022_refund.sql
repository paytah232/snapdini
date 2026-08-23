ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "stripe_payment_intent" text;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "refunded_at" bigint;
