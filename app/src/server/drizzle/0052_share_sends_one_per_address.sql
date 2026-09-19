-- "One gallery link per address, ever" becomes a rule the database keeps.
--
-- 0041 created share_sends to answer "have I already sent this to Mum?", and both senders ask it
-- the same way: read every ok row for the event/share, then send to whoever is not in the set
-- (routes/events.ts email-link, guest-delivery.ts priorLinkAddresses). Read-then-write, with no
-- unique index behind it — so two presses of Send, or the host's blast landing alongside the
-- automatic guest send, put the same link in the same inbox twice and wrote two rows saying so.
--
-- WHY TWO PARTIAL INDEXES rather than one over (event_id, share_id, email):
-- share_id IS NULL is the standing gallery link — the common case, and every send the automatic
-- guest delivery makes. NULLs are DISTINCT in a Postgres unique index by default, so a single
-- three-column index would constrain the curated shares and leave the gallery-link rows completely
-- unconstrained, which is the half that matters most. (PG15 could say NULLS NOT DISTINCT; a partial
-- pair needs no version floor, and self-hosters choose their own Postgres.)
--
-- WHY lower(btrim(email)) rather than the column:
-- both readers key their set on `(email || '').trim().toLowerCase()`, and neither writer stores a
-- normalised address — participants.email is kept as the guest typed it, deliberately, so the host
-- sees what they see. An index on the raw column would let Mum@x.com and mum@x.com both through the
-- constraint while the readers treat them as one person. The index has to agree with the reads.
--
-- event_id is not in the second index: share_id already implies it (shares.event_id), and a
-- curated share belongs to exactly one event.
--
-- NOTE for whoever next touches guest-delivery.ts: recordSends() inserts here with no ON CONFLICT
-- clause. A duplicate is now a unique violation, which its catch swallows — the mail still goes and
-- nothing 500s, but the whole batch of ledger rows is lost rather than the one colliding row. It
-- wants `.onConflictDoNothing()`, the same as routes/events.ts now has.

-- Deduplicate FIRST; a unique index cannot be built over existing duplicates. share_sends was
-- empty in production when this was written (the table only reaches it with 1.5.0), but a devel or
-- self-hosted database that has been sending for a while can hold plenty.
--
-- Which row survives: the row the readers already behave as if they had. They only look at `ok`
-- rows, so a successful send outranks a failed one for the same address; after that the LATEST
-- send is the one whose timestamp the host's list should show.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY event_id, coalesce(share_id, ''), lower(btrim(email))
    ORDER BY ok DESC, sent_at DESC, id
  ) AS rn
  FROM share_sends
)
DELETE FROM share_sends WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS ux_share_sends_gallery
  ON share_sends (event_id, lower(btrim(email))) WHERE share_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_share_sends_share
  ON share_sends (share_id, lower(btrim(email))) WHERE share_id IS NOT NULL;
