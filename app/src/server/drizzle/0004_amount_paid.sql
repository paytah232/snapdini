-- Track total paid per event so upgrades can charge only the difference. Idempotent.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "amount_paid_cents" integer DEFAULT 0 NOT NULL;
