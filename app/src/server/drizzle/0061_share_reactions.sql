-- Reactions on a SHARE LINK, from people who were never at the event.
--
-- Hearts and comments have always belonged to participants — "the people who were there" — because
-- the only way in was the QR code. A curated share link breaks that assumption: the family gallery
-- goes to people who were not there, and they are exactly the audience most likely to want to react.
--
-- A link visitor is deliberately NOT a participant. Participants are the paid entitlement: they
-- count against `guest_cap`, they hold a roll, they are dealt a trick card, they appear in the guest
-- list and in exports. Reusing that row would have meant filtering visitors out of every one of
-- those, and the one that must never be missed is the cap — a forwarded link could otherwise eat a
-- host's paid allowance. A separate table cannot make that mistake.
CREATE TABLE IF NOT EXISTS share_visitors (
  id           text PRIMARY KEY,
  share_id     text NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  name         text NOT NULL,
  -- The visitor's own bearer secret, kept in their browser. Scoped to ONE link: the same person
  -- opening a different share of the same event is a different visitor, because a link is the unit
  -- of access here and carrying identity between them would leak who has seen what.
  session_token text NOT NULL,
  created_at   bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS share_visitors_token_uq ON share_visitors (session_token);
CREATE INDEX IF NOT EXISTS share_visitors_share_idx ON share_visitors (share_id);

-- Attribution becomes "one of two", not "always a participant".
ALTER TABLE photo_hearts   ALTER COLUMN participant_id DROP NOT NULL;
ALTER TABLE photo_comments ALTER COLUMN participant_id DROP NOT NULL;
ALTER TABLE photo_hearts   ADD COLUMN IF NOT EXISTS visitor_id text REFERENCES share_visitors(id) ON DELETE CASCADE;
ALTER TABLE photo_comments ADD COLUMN IF NOT EXISTS visitor_id text REFERENCES share_visitors(id) ON DELETE CASCADE;

-- Exactly one owner per row, always. Without this a bug could write a heart belonging to nobody, or
-- to two people, and the counts would be quietly wrong rather than loudly refused.
ALTER TABLE photo_hearts   ADD CONSTRAINT photo_hearts_one_author
  CHECK ((participant_id IS NULL) <> (visitor_id IS NULL)) NOT VALID;
ALTER TABLE photo_comments ADD CONSTRAINT photo_comments_one_author
  CHECK ((participant_id IS NULL) <> (visitor_id IS NULL)) NOT VALID;

-- One heart per visitor per photo, the same rule participants have — and the same mechanism, since
-- it is the unique index that makes a double tap or a retry idempotent rather than a second heart.
-- PARTIAL, because Postgres treats NULLs as distinct: a plain unique index on (photo_id, visitor_id)
-- would not constrain visitors at all while every participant row carries a NULL there. Same shape
-- and same reason as the paired partial indexes on share_sends (0052).
CREATE UNIQUE INDEX IF NOT EXISTS photo_hearts_photo_visitor_uq
  ON photo_hearts (photo_id, visitor_id) WHERE visitor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS photo_comments_visitor_idx ON photo_comments (visitor_id) WHERE visitor_id IS NOT NULL;

-- Per LINK, not per event: one event can have a family gallery that wants comments and a client
-- gallery that must not. An event-level switch cannot say that. Both default OFF — a share link can
-- be forwarded anywhere, so the audience is not knowable, and opening a gallery to reactions is the
-- host's decision to make on purpose rather than one they inherit.
ALTER TABLE shares ADD COLUMN IF NOT EXISTS hearts_enabled   boolean NOT NULL DEFAULT false;
ALTER TABLE shares ADD COLUMN IF NOT EXISTS comments_enabled boolean NOT NULL DEFAULT false;
