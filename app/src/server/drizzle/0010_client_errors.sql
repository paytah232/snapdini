-- Client-side diagnostic/error reports (technical only — no photos/personal content). Idempotent.
CREATE TABLE IF NOT EXISTS "client_errors" (
  "id" text PRIMARY KEY,
  "message" text NOT NULL,
  "context" text,
  "event_code" text,
  "user_agent" text,
  "url" text,
  "handled" boolean DEFAULT false NOT NULL,
  "created_at" bigint NOT NULL
);
