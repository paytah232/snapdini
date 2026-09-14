-- The shape the guest ASKED for when they took a clip.
--
-- Stored because asking and getting are different things. The camera is asked for the shape via
-- applyConstraints({aspectRatio}); Chrome on Android obliges, iOS Safari has never implemented
-- resizeMode and ignores it, and Firefox on Android ignores it too. So a clip can arrive full-frame
-- from a guest who chose Square, and nothing in the file records that they chose Square — the file
-- looks exactly like a deliberate full-frame clip.
--
-- That is what this column is for: it is the only record of the intent, and it is what lets the
-- server crop the clip afterwards to the shape that was actually wanted. It also means a clip whose
-- crop failed, or which arrived before the cropper existed, can be found and done later, rather
-- than the intent being lost the moment the upload finished.
--
-- Values are the same vocabulary the camera uses ('1:1', '4:5', '9:16', '3:4', 'full'), NULL for
-- photos (which are cropped in the browser at the moment of capture and always arrive correct) and
-- for anything predating this column.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS capture_shape text;

-- Finding the clips that still need cropping: those that asked for a real shape. Partial, because
-- the overwhelming majority of rows are photos and full-frame clips, and they are never the answer
-- to this question.
CREATE INDEX IF NOT EXISTS idx_photos_capture_shape
  ON photos(event_id) WHERE capture_shape IS NOT NULL AND capture_shape <> 'full';
