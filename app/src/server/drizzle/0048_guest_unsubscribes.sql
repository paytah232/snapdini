-- What a guest asked us to stop sending, and (if they felt like saying) why.
--
-- The invite email now carries two unsubscribe mechanisms, and they write to the same place:
--
--   the List-Unsubscribe header  the mail client POSTs a URL with no page and no confirmation
--                                (RFC 8058). Gmail and Yahoo's bulk-sender rules expect it, and
--                                its whole value is that it is the cheapest thing on screen — the
--                                alternative the recipient reaches for otherwise is "report spam",
--                                which costs the sending domain far more than one lost guest.
--   a link in the body           a page with the two choices a guest actually has.
--
-- Why a table and not a column on event_guests: the opt-out belongs to the ADDRESS at this event,
-- not to the host's row for that person. A host who removes a guest and re-imports their
-- spreadsheet would otherwise resurrect someone who had already said stop — the request honoured
-- until the next import, which is the same as not honouring it.
--
-- Why it is not email_suppressions: that table is global and has no event, deliberately (0047). A
-- guest who wants out of one wedding's mail has not asked to be cut off from every Snapdini event
-- they are ever invited to, and recording it there would be us answering a question they were not
-- asked. The GLOBAL choice still lands in email_suppressions — this table then records that it was
-- a request rather than a bounce, and which event it came from.
CREATE TABLE IF NOT EXISTS guest_unsubscribes (
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- Lower-cased and trimmed by the writer, like every other address in this schema. The primary
  -- key is a byte comparison, so an address stored with its original casing is an address that
  -- escapes its own opt-out on the next send.
  email    text NOT NULL,

  -- 'event' → stop mail about THIS event
  -- 'all'   → never mail this address from Snapdini again. Mirrored into email_suppressions,
  --           which is what the send paths actually consult; this row records the provenance.
  scope    text NOT NULL,

  -- 'one-click' | 'page'. Worth keeping apart: a one-click unsubscribe is a mail client acting on
  -- a header, and if those ever vastly outnumber the page it means the body link is not being
  -- found — which is a thing to fix rather than a thing to guess about.
  source   text NOT NULL,

  -- The invite this came from. No foreign key: guest_invites rows outlive the guest they were sent
  -- to on purpose, but an event purge takes both, and a dangling token here is harmless history.
  invite_token text,

  -- Optional, and asked for AFTER the unsubscribe has already been applied — never as a condition
  -- of it. A feedback step that gates the opt-out stops it being low-cost, which is the one
  -- property the whole mechanism depends on.
  feedback_reason  text,
  feedback_comment text,

  created_at bigint NOT NULL,
  -- Moves when someone reopens their link and changes scope, or adds feedback later. created_at
  -- stays put: it is the record of when they asked, which is the date that matters if anyone ever
  -- asks whether we honoured it promptly.
  updated_at bigint NOT NULL,

  PRIMARY KEY (event_id, email)
);

-- "Has this address opted out of anything, anywhere?" — the lookup the global escalation and any
-- future cross-event check needs. The primary key already serves the per-event send path.
CREATE INDEX IF NOT EXISTS idx_guest_unsubscribes_email ON guest_unsubscribes(email);
