-- Scope hearts by event without joining photos to find out which event they are in.
--
-- Measured on a synthetic 400-guest event (14,000 photos, 60,215 hearts): reading every count for
-- the event took 64.9ms, all of it a sequential scan of the whole hearts table plus a hash join
-- against photos — and it grows with the number of hearts, which is exactly the number that grows
-- fastest at a busy event. The gallery polls this for live counts, so it is the hot read.
--
-- Carrying event_id on the heart removes the join. This is NOT the counter-column mistake 0057
-- avoided: a counter is derived state that drifts when any path forgets to update it, whereas a
-- photo's event never changes, so this column cannot become wrong after it is written. It is a copy
-- of an immutable fact, not a running total.
ALTER TABLE photo_hearts ADD COLUMN IF NOT EXISTS event_id text REFERENCES events(id) ON DELETE CASCADE;

UPDATE photo_hearts h SET event_id = p.event_id
FROM photos p WHERE p.id = h.photo_id AND h.event_id IS NULL;

-- Safe to enforce: the backfill above covers every existing row, and the table ships new in 1.5.0
-- (created by 0057), so no released version can be carrying rows this did not reach.
ALTER TABLE photo_hearts ALTER COLUMN event_id SET NOT NULL;

-- The live poll: every count for one event, keyed, with no join.
CREATE INDEX IF NOT EXISTS photo_hearts_event_photo_idx ON photo_hearts (event_id, photo_id);
-- And "which of this event's photos are mine", likewise.
CREATE INDEX IF NOT EXISTS photo_hearts_event_participant_idx ON photo_hearts (event_id, participant_id);

COMMENT ON COLUMN photo_hearts.event_id IS
  'Copy of photos.event_id, which never changes. Lets the live count read one event without joining photos.';
