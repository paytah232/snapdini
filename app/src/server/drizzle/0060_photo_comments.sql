-- Guest comments: a guest leaves a short message on somebody else's photo.
--
-- NOT the same thing as photos.caption (0040), and deliberately a separate table rather than a
-- second text column. A caption is ONE voice about the picture — the photographer's or the host's —
-- and it belongs to the photo. A comment is a thread: many of them, each belonging to the person
-- who wrote it, each deletable by that person and by the host and by nobody else. A column cannot
-- hold an author or a second row.
--
-- Shaped after photo_hearts (0057–0059) because a security audit has already walked every one of
-- these mistakes on that table, and the lessons are cheaper to copy than to relearn:
--
--   * NO COUNTER COLUMN. photos.comment_count is the obvious shape and the wrong one: a
--     denormalised tally drifts the moment any path forgets it — a purge, a cascade, a host
--     deleting one — and the drift is invisible until somebody counts by hand. COUNT(*) over the
--     index below is the count.
--
--   * event_id is CARRIED on the row. That is the opposite of the counter mistake, not a version
--     of it: a photo's event never changes, so this is a copy of an immutable fact and nothing can
--     make it wrong after it is written. What it buys is the hot read — every count for one
--     event — scoping off one index with no join to photos at all.
CREATE TABLE IF NOT EXISTS photo_comments (
  id              text PRIMARY KEY,
  photo_id        text NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  event_id        text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- CASCADE, like a heart, and for a sharper reason than a heart has: a comment is SIGNED. It is
  -- rendered under the writer's name, so a participant row that is removed must take their words
  -- with it. A message left standing under a name the event no longer holds is worse than a lost
  -- comment.
  participant_id  text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  -- The text exactly as it was typed (trimmed, whitespace collapsed, cut at 300 graphemes). Stored
  -- RAW: no HTML is escaped, stripped or rewritten on the way in. Escaping belongs to the renderer,
  -- which is Svelte's `{text}`, and a store that half-sanitises is how you end up with `&amp;amp;`
  -- in somebody's message and an injection in whatever reads the column next.
  body            text NOT NULL,
  created_at      bigint NOT NULL
);

-- THE hot read: every comment count for one event, keyed, with no join to photos.
CREATE INDEX IF NOT EXISTS photo_comments_event_photo_idx ON photo_comments (event_id, photo_id);
-- The other direction — "which of this event's comments are this guest's". The composite above
-- cannot serve it: photo_id is its trailing column, not participant_id. photo_hearts shipped
-- without this index and had to add it in 0058 once a guest opening a large gallery was scanning
-- every row in the event to find their own; there is no reason to repeat that.
CREATE INDEX IF NOT EXISTS photo_comments_event_participant_idx ON photo_comments (event_id, participant_id);
-- Reading one photo's thread in the order it was written. (event_id, photo_id) finds the rows;
-- this is the sort, so a thread comes back ordered instead of sorted per request.
CREATE INDEX IF NOT EXISTS photo_comments_photo_created_idx ON photo_comments (photo_id, created_at);

COMMENT ON TABLE photo_comments IS
  'One row per guest message on one photo. COUNT(*) is the count — there is no counter column to drift.';

-- OFF by default, which is the exact opposite of hearts_enabled (0057) and deliberately so.
--
-- A heart only ever ADDS to a screen — a number nobody has to read — so switching it on for
-- everyone takes nothing away from anyone. A comment puts one guest's WORDS on somebody else's
-- wedding gallery, permanently, under their name. A default that alters another person's screen is
-- not a default we get to make, so this one is an opt-IN: the host turns it on, having decided they
-- want it.
ALTER TABLE events ADD COLUMN IF NOT EXISTS comments_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN events.comments_enabled IS
  'Host opt-IN, default false. false hides comments entirely and refuses the endpoints; existing rows are kept, not deleted, so turning it back on restores the thread.';
