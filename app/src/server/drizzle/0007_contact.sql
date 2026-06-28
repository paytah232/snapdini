-- DB-backed contact mailbox (fallback when email is unconfigured / fails). Idempotent.
CREATE TABLE IF NOT EXISTS "contact_messages" (
  "id" text PRIMARY KEY,
  "name" text,
  "email" text,
  "message" text NOT NULL,
  "emailed" boolean DEFAULT false NOT NULL,
  "handled" boolean DEFAULT false NOT NULL,
  "created_at" bigint NOT NULL
);
