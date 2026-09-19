-- Two gaps left by 0061/0063, both found by audit.
--
-- 1. `photo_hearts` got its (event_id, participant_id) index in 0059 — "which of this event's photos
--    have I hearted" — and never got the visitor half when 0061 and 0063 introduced visitors. The
--    only visitor index is the partial UNIQUE on (photo_id, visitor_id), which LEADS ON photo_id and
--    so cannot serve a lookup by (event_id, visitor_id) at all.
--
--    Measured on dev: the participant path is `Index Cond: (event_id = … AND participant_id = …)` —
--    keyed on both columns. The visitor path is `Index Cond: (event_id = …)` with
--    `Filter: (visitor_id = …)` — it reads EVERY heart in the event, plus a photos_pkey lookup per
--    row for the seeable join, to return a few dozen. At the 400-guest/60,215-heart shape 0059
--    benchmarks against that is the whole table for one person's answer.
--
--    `comment_hearts` already has both halves (0062). This is `photo_hearts` catching up. It is also
--    the ON DELETE CASCADE path from share_visitors, which today has no keyed route either.
CREATE INDEX IF NOT EXISTS photo_hearts_event_visitor_idx
  ON photo_hearts (event_id, visitor_id) WHERE visitor_id IS NOT NULL;

-- 2. The four one-author CHECKs were all added NOT VALID, which is right at the moment of adding
--    (no lock, and the existing rows provably satisfied them) and wrong to leave forever: the
--    planner cannot use an unvalidated constraint, and "was every existing row really checked?"
--    stays an open question. Cheap to settle now, while the tables are small.
ALTER TABLE photo_hearts    VALIDATE CONSTRAINT photo_hearts_one_author;
ALTER TABLE photo_comments  VALIDATE CONSTRAINT photo_comments_one_author;
ALTER TABLE comment_hearts  VALIDATE CONSTRAINT comment_hearts_one_author;
ALTER TABLE share_visitors  VALIDATE CONSTRAINT share_visitors_one_owner;

-- 3. The only FK child column in the schema with no index of its own — it is the cascade path from
--    events, i.e. the retention purge, and it is a sequential scan today.
CREATE INDEX IF NOT EXISTS guest_feedback_event_idx ON guest_feedback (event_id);
