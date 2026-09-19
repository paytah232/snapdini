-- Guest hearts: a guest can love somebody else's photo, and everyone sees how many did.
--
-- NO COUNTER COLUMN, deliberately. The obvious shape is photos.heart_count kept in step by the
-- insert and delete, and this codebase has already been bitten repeatedly by exactly that: a
-- denormalised tally drifts the moment any path forgets it (a purge, a cascade, a moderation
-- reject), and the drift is invisible until someone counts by hand. A row per heart with a unique
-- index is the truth, and COUNT(*) over a few hundred photos is nothing next to being wrong.
--
-- The unique index is what makes the endpoint idempotent: "heart this" cannot double-count on a
-- double tap, a retried request or two tabs, because the database refuses the second row rather
-- than the handler having to remember to check.
CREATE TABLE IF NOT EXISTS photo_hearts (
  id              text PRIMARY KEY,
  photo_id        text NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  -- CASCADE, not SET NULL: a heart is anonymous in the UI but it is one PERSON's, and the count
  -- has to fall when that person's participation is removed. Feedback keeps its row because a
  -- rating is data about the event; a heart is only meaningful while its owner is in it.
  participant_id  text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  created_at      bigint NOT NULL
);

-- One heart per person per photo. See above: this is the idempotency, not a nicety.
CREATE UNIQUE INDEX IF NOT EXISTS photo_hearts_photo_participant_uq
  ON photo_hearts (photo_id, participant_id);
-- The gallery asks "how many hearts does each of these photos have" for a whole event at once.
CREATE INDEX IF NOT EXISTS photo_hearts_photo_idx ON photo_hearts (photo_id);

COMMENT ON TABLE photo_hearts IS
  'One row per guest per photo. COUNT(*) is the heart count — there is no counter column to drift.';

-- On by default: a heart only ever ADDS to a screen, so switching it on for everyone takes nothing
-- away from anyone. (Guest comments, which put other people's words on a host's gallery, default
-- OFF for the opposite reason.)
ALTER TABLE events ADD COLUMN IF NOT EXISTS hearts_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN events.hearts_enabled IS
  'Host opt-out. false hides hearts entirely and refuses the endpoint; existing rows are kept, not deleted, so turning it back on restores the counts.';
