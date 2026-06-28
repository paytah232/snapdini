-- Per-file media metadata (size, dimensions, video duration) for display on the review/gallery
-- pages. All nullable — legacy rows simply won't show stats. Idempotent.
ALTER TABLE "photos" ADD COLUMN IF NOT EXISTS "size_bytes" bigint;
ALTER TABLE "photos" ADD COLUMN IF NOT EXISTS "width" integer;
ALTER TABLE "photos" ADD COLUMN IF NOT EXISTS "height" integer;
ALTER TABLE "photos" ADD COLUMN IF NOT EXISTS "duration_ms" integer;
