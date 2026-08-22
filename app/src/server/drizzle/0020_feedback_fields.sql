ALTER TABLE "contact_messages" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'contact' NOT NULL;
ALTER TABLE "contact_messages" ADD COLUMN IF NOT EXISTS "image_filename" text;
