-- The guest list, the invites sent to it, and what became of each one.
--
-- Three tables, because they answer three questions that outlive each other:
--
--   event_guests       WHO the host means to invite. Survives every send; edited freely.
--   guest_invites      WHAT HAPPENED to one message to one address. Immutable in identity
--                      (one row per send), mutable in state (the webhook writes to it later).
--   email_suppressions WHICH ADDRESSES MUST NEVER BE MAILED AGAIN, deployment-wide.
--
-- Why guest_invites is not just more columns on event_guests: a host sends more than once
-- (the invite, then a nudge, then the gallery link). Delivery state belongs to the MESSAGE,
-- not the person — "Mum bounced" is meaningless without "which one bounced, and when".
--
-- Why email_suppressions is GLOBAL rather than per-event: sending reputation is a property of
-- the sending DOMAIN, not of one party. An address that hard-bounced at Jo's wedding is just as
-- dead at Sam's birthday, and mailing it again from the same domain is what gets a domain
-- throttled and then blocked — after which nothing this deployment sends is delivered to anyone.
-- Scoping suppression to the event would defeat the entire point of having it.

-- ── The guest list ────────────────────────────────────────────────────────────
--
-- Every field but the event and the timestamps is nullable, INCLUDING email. A host typing up
-- their list from a wedding spreadsheet has phone numbers for some people, emails for others, and
-- a plus-one whose name is "Dan's partner". Requiring an email would make the list refuse the
-- thing it is for — a record of who is coming — in service of one of the several ways of reaching
-- them. Rows without an email are simply not mailable, and the UI says so.
CREATE TABLE IF NOT EXISTS event_guests (
  id         text PRIMARY KEY,
  event_id   text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name       text,
  -- Stored already lower-cased and trimmed by the writer. That is what makes the partial unique
  -- index below a real duplicate check: Postgres compares bytes, so "Mum@x.com" and "mum@x.com"
  -- would otherwise both land, and the second CSV import of the same spreadsheet would double
  -- the list. Normalising on write rather than with a lower() expression index keeps the stored
  -- value and the indexed value the same thing, so nothing can query one and miss the other.
  email      text,
  phone      text,
  notes      text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

-- The list view: one event's guests, oldest first (the order they were added/imported, which is
-- the order the host's own spreadsheet was in).
CREATE INDEX IF NOT EXISTS idx_event_guests_event ON event_guests(event_id, created_at);

-- One address appears at most once per event. Partial, because a list may hold any number of
-- guests with no email at all and those are not duplicates of each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_guests_event_email
  ON event_guests(event_id, email) WHERE email IS NOT NULL;

-- ── One invite, to one address ────────────────────────────────────────────────
--
-- Created at send time with status 'sent' (or 'failed', if the transport refused it on the spot),
-- and then UPDATED later by the Mailgun webhook as the outside world reports back. A send whose
-- provider cannot report back never leaves 'sent', which is honest: it means "we handed it over
-- and heard nothing more", not "it arrived".
CREATE TABLE IF NOT EXISTS guest_invites (
  id       text PRIMARY KEY,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: removing someone from the guest list must not erase the evidence that
  -- an email was sent to them. The address is denormalised below precisely so the record still
  -- reads after the guest row is gone.
  guest_id text REFERENCES event_guests(id) ON DELETE SET NULL,
  email    text NOT NULL,

  -- 'sent' → handed to the transport, nothing heard since
  -- 'delivered' → the receiving server accepted it
  -- 'bounced' → permanent failure; the address is dead (suppressed)
  -- 'complained' → marked as spam by the recipient (suppressed)
  -- 'unsubscribed' → the recipient opted out (suppressed)
  -- 'failed' → a temporary failure, or an immediate transport error at send time. Mailgun keeps
  --            retrying a temporary failure, so this is not final — it becomes 'delivered' or
  --            'bounced' later, and only stays 'failed' if nothing further ever arrives.
  status   text NOT NULL DEFAULT 'sent',

  -- Which transport carried it. This is the column that tells the UI whether 'sent' means
  -- "we don't know yet" (mailgun, a webhook is coming) or "we will never know" (smtp).
  provider text,

  -- Our own correlation id, minted before the send and attached to the message as a Mailgun
  -- custom variable. The webhook echoes it back, which is what joins an event to this row.
  --
  -- Deliberately not relying on the provider's message id alone: it is assigned by the provider
  -- AFTER we commit to sending, so a crash or a slow response between the API call and the insert
  -- loses the only join key. A token we generated is already in hand.
  token    text NOT NULL,

  -- The provider's id for the message, when it gave us one. Kept as a secondary join key and for
  -- looking a message up in the provider's own logs when a host asks what happened.
  provider_message_id text,

  -- Why it failed, in the provider's words (an SMTP response, a rejection reason). Shown to the
  -- host verbatim: "mailbox full" and "no such user" call for completely different actions, and
  -- collapsing both to "failed" throws that away.
  reason   text,

  -- 'permanent' | 'temporary' — as reported by the provider, NOT inferred by us. This is the
  -- single field that decides whether an address gets suppressed, so it is recorded rather than
  -- guessed from the reason text.
  severity text,

  sent_at    bigint NOT NULL,
  -- When the state last changed, and the provider's own timestamp for the event that changed it.
  -- Both, because they answer different questions: updated_at orders our writes, event_at orders
  -- THEIR events — and webhooks arrive out of order, so the provider's clock is what decides
  -- whether an arriving event is newer than the one already recorded.
  updated_at bigint NOT NULL,
  event_at   bigint
);

-- The host's view: every invite for one event, newest first.
CREATE INDEX IF NOT EXISTS idx_guest_invites_event ON guest_invites(event_id, sent_at DESC);

-- The webhook's lookup. Unique: a token identifies exactly one send, and that uniqueness is what
-- makes a redelivered webhook idempotent rather than a second row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_invites_token ON guest_invites(token);

-- The fallback lookup, for a provider event that carries a message id but lost our variable.
CREATE INDEX IF NOT EXISTS idx_guest_invites_message
  ON guest_invites(provider_message_id) WHERE provider_message_id IS NOT NULL;

-- Per-guest state on the guest-list screen ("last invited: bounced").
CREATE INDEX IF NOT EXISTS idx_guest_invites_guest
  ON guest_invites(guest_id, sent_at DESC) WHERE guest_id IS NOT NULL;

-- ── Addresses that must not be mailed again ───────────────────────────────────
--
-- The email IS the primary key, lower-cased. There is no id and no event: a row here is a global
-- statement about an address, and making it the key is what makes an upsert from a webhook
-- naturally idempotent — Mailgun redelivers events, and the same bounce arriving three times must
-- not produce three rows.
CREATE TABLE IF NOT EXISTS email_suppressions (
  email      text PRIMARY KEY,
  -- 'bounced' | 'complained' | 'unsubscribed' | 'manual'
  reason     text NOT NULL,
  detail     text,          -- the provider's description, shown to the host
  created_at bigint NOT NULL
);
