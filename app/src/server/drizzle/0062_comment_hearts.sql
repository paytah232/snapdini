-- Hearts on COMMENTS, not just on photos.
--
-- A thread under a photo can run long — a popular shot at a wedding collects twenty or thirty
-- remarks — and at that length "which of these are worth reading" becomes a real question that
-- chronological order cannot answer. A heart is the cheapest possible answer to it: no reply, no
-- thread, no notification, one tap.
--
-- Shaped exactly like photo_hearts after 0061, and deliberately so: the author is ONE OF TWO — a
-- participant who was at the event, or somebody holding a share link — and every rule that made
-- that safe there applies here unchanged. If you are changing one of these tables, check whether
-- the other needs the same change.
CREATE TABLE IF NOT EXISTS comment_hearts (
  id             text PRIMARY KEY,
  comment_id     text NOT NULL REFERENCES photo_comments(id) ON DELETE CASCADE,
  -- Carried on the row rather than joined for, the same trade 0059 made on photo_hearts: the read
  -- is "every heart on these comments" and the join to photo_comments to get there was the whole
  -- cost of it. An event id never changes, so this is a copy of an immutable fact, not a tally.
  event_id       text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  participant_id text REFERENCES participants(id) ON DELETE CASCADE,
  visitor_id     text REFERENCES share_visitors(id) ON DELETE CASCADE,
  created_at     bigint NOT NULL
);

-- Exactly one author per row. NOT VALID because there are no rows yet to validate and a validating
-- scan takes a lock this needs no part of.
ALTER TABLE comment_hearts
  ADD CONSTRAINT comment_hearts_one_author
  CHECK ((participant_id IS NULL) <> (visitor_id IS NULL)) NOT VALID;

-- PARTIAL, both of them. Postgres treats NULLs as distinct, so a plain composite over a nullable
-- column deduplicates nothing at all while looking exactly like idempotency — the trap 0052 and
-- 0061 already walked into. These indexes ARE the one-heart-per-person rule, and they are what
-- makes the endpoint safe to call twice on a double tap or a retry.
CREATE UNIQUE INDEX IF NOT EXISTS comment_hearts_comment_participant_uq
  ON comment_hearts (comment_id, participant_id) WHERE participant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS comment_hearts_comment_visitor_uq
  ON comment_hearts (comment_id, visitor_id) WHERE visitor_id IS NOT NULL;

-- "How many hearts has each of these comments got" — the only read on the hot path.
CREATE INDEX IF NOT EXISTS comment_hearts_comment_idx ON comment_hearts (comment_id);
-- "Which of this event's comments have I hearted", which the composites above cannot serve: both
-- lead on comment_id. Same lesson as 0058.
CREATE INDEX IF NOT EXISTS comment_hearts_event_participant_idx ON comment_hearts (event_id, participant_id);
CREATE INDEX IF NOT EXISTS comment_hearts_event_visitor_idx ON comment_hearts (event_id, visitor_id);
