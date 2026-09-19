-- A visitor can belong to the EVENT'S OWN gallery link, not only to a curated share.
--
-- 0061 scoped a visitor to one share, on the reasoning that a link is the unit of access. That is
-- still true — but it quietly made the event's own `/gallery/<code>` link the most restrictive link
-- in the product: a curated `/s/` link could be opened to hearts and comments for anyone holding
-- it, while the gallery link the host is far more likely to send round could not. A host sharing
-- "the whole gallery" and a host sharing a link to the whole gallery were being treated as two
-- different decisions.
--
-- So a visitor now hangs off ONE OF TWO things — exactly the shape 0061 gave the reaction tables:
--
--   share_id  → somebody holding a curated /s/ link   (reactions governed by that share's switches)
--   event_id  → somebody holding the /gallery/ link   (reactions INHERIT the event's own switches)
--
-- Inherit, not a third pair of columns: the gallery link is the event, so "can people react here"
-- is already answered by events.hearts_enabled / comments_enabled, and a second copy of that answer
-- is a second thing to keep in step.
ALTER TABLE share_visitors ALTER COLUMN share_id DROP NOT NULL;
ALTER TABLE share_visitors ADD COLUMN IF NOT EXISTS event_id text REFERENCES events(id) ON DELETE CASCADE;

-- Exactly one owner per visitor. NOT VALID because every existing row is a share visitor and
-- already satisfies it, and validating would take a lock nothing here needs.
ALTER TABLE share_visitors
  ADD CONSTRAINT share_visitors_one_owner
  CHECK ((share_id IS NULL) <> (event_id IS NULL)) NOT VALID;

-- "Who is this token?" is the hot read and it is already covered by share_visitors_token_uq.
-- This one answers the other direction for the gallery: the event's own visitors.
CREATE INDEX IF NOT EXISTS share_visitors_event_idx ON share_visitors (event_id);
