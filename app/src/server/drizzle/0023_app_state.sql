CREATE TABLE IF NOT EXISTS "app_state" (
  "key" text PRIMARY KEY NOT NULL,
  "value" text NOT NULL,
  "updated_at" bigint NOT NULL
);
