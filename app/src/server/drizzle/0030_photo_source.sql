-- Where a photo/clip came from: 'capture' (shot in the app) or 'upload' (picked from the camera
-- roll). Nullable, because rows written before this existed genuinely have no answer — do not
-- backfill them to 'capture', which would invent data and skew the very metric this exists for.
--
-- The point is diagnostic, not enforcement: the server keeps over-length clips either way, but an
-- OVER-LIMIT clip whose source is 'capture' means the in-app recorder failed to stop itself, which
-- is a bug to chase. The same overage from 'upload' is a guest using their own camera, which is
-- working as intended.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS source text;

-- Partial: only over-length clips are ever queried here, and they should stay a small minority.
CREATE INDEX IF NOT EXISTS idx_photos_video_source
  ON photos (source) WHERE media_type = 'video';
