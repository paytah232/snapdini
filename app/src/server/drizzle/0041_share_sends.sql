-- A record of who a link has actually been emailed to.
--
-- The gallery email used to send and forget: the route returned {sent, errors} and nothing was
-- written down, so a host had no way to answer "did I already send this to Mum?" — and no way to
-- know that a send had failed. They re-sent to everyone, or to nobody.
--
-- One table for BOTH kinds of link, keyed by which one it was:
--   share_id IS NULL  → the standing gallery link, which every event has and nobody creates
--   share_id IS NOT NULL → one of the curated shares the host made in Review & Curate
-- Splitting those into two tables would duplicate every query and every bit of UI for a
-- distinction that is one nullable column.
--
-- event_id is kept even though share_id implies it: the gallery-link rows have no share to imply
-- it from, and the admin page reads every send for an event in one query.
--
-- `ok` rather than deleting failures. A bounced or rejected address is exactly the thing the host
-- needs to see — dropping the row would hide the one send that needs their attention, and leave
-- the list quietly claiming everything went out.
CREATE TABLE IF NOT EXISTS share_sends (
  id       text PRIMARY KEY,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  share_id text REFERENCES shares(id) ON DELETE CASCADE,
  email    text NOT NULL,
  ok       boolean NOT NULL DEFAULT true,
  sent_at  bigint NOT NULL
);

-- The admin page's only read: every send for one event, newest first.
CREATE INDEX IF NOT EXISTS idx_share_sends_event ON share_sends(event_id, sent_at DESC);
