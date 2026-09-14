-- Getting the photos to the GUESTS, on the host's terms.
--
-- Until now every lifecycle email went to the host. A guest who stood in someone's kitchen and shot
-- half the roll had no way to be told the gallery existed, let alone when it opened — the host had
-- to copy a link into a group chat, or nobody saw anything. This is the server half of closing that.
--
-- ── Why nothing here changes an existing event ───────────────────────────────
--
-- The consent gate is participants.wants_photos, DEFAULT FALSE with no backfill. Every
-- participant row that exists today says "no", so every event
-- that exists today mails exactly nobody, whatever the columns below happen to default to. The
-- sweep is written to match: it looks for recipients FIRST and stops when there are none, so an old
-- event cannot even reach the "we were going to send this but the scope is empty" notice to the
-- host. The delivery defaults are what a NEW event should do, not a decision taken retroactively on
-- behalf of hosts who never asked for any of it.
--
-- ── The columns ──────────────────────────────────────────────────────────────
--
-- guest_delivery — WHEN the gallery link goes out. Four values rather than a boolean because the
-- four are genuinely different products:
--   'all_on_reveal'     the link goes at the release moment, automatically. The default.
--   'favourites_manual' nothing automatic; the host curates favourites and presses send.
--   'scheduled'         the link goes at guest_send_at, an instant the host picked.
--   'manual'            nothing automatic; the host presses send when they are ready.
-- TEXT and not an enum, for the same reason 0045 gave: the set is a product decision, and a CHECK
-- constraint would turn adding a fifth into a migration. Anything unrecognised is read as the
-- default (guest-delivery.ts), so a row left behind by a retired mode is inert rather than a fault.
--
-- guest_send_scope — WHICH photos the link shows: 'all' or 'favourites'. Separate from the mode
-- because a host can want the favourites link sent automatically at reveal, or the whole gallery
-- sent by hand. Folding the two into one column would have made half those combinations unsayable.
--
-- guest_send_at — the instant for 'scheduled'. Absolute epoch ms, same convention as reveal_at, and
-- NEVER earlier than the reveal: a gallery link that arrives before the gallery opens sends a guest
-- to a locked page, and they do not come back. Clamped up to the reveal on write (routes/events.ts)
-- and checked again at send time, because the reveal can move after the send was scheduled.
--
-- guests_sent_at / guest_thanks_sent_at / guest_reminder_sent_at — one-shot guards, exactly the
-- shape welcome_sent_at and friends already use. Each is claimed atomically
-- (UPDATE … WHERE col IS NULL RETURNING id) so two sweeps, or two app replicas, cannot both send.
-- Three columns rather than one because the three messages are three occasions: the guard that
-- stops the gallery link going twice must not also stop the thank-you that precedes it.
--
-- guest_mail_thanks / guest_mail_reminder / guest_mail_live — which of the three the host wants.
-- Thanks and live default TRUE (they are the point of the feature); the day-before reminder defaults
-- FALSE, because it is the one that is noise for most events and nobody should have to turn it off.
-- Note what guest_mail_thanks does NOT control: whether a guest who asked for their photos gets an
-- email at the end. They asked; that is consent and it stands on its own. The toggle decides whether
-- that message is ALSO a thank-you carrying the release date, or just their photos.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "guest_delivery"        text    NOT NULL DEFAULT 'all_on_reveal';
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "guest_send_scope"      text    NOT NULL DEFAULT 'all';
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "guest_send_at"         bigint;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "guests_sent_at"        bigint;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "guest_thanks_sent_at"  bigint;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "guest_reminder_sent_at" bigint;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "guest_mail_thanks"     boolean NOT NULL DEFAULT true;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "guest_mail_reminder"   boolean NOT NULL DEFAULT false;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "guest_mail_live"       boolean NOT NULL DEFAULT true;

-- The consent gate, and the whole reason none of the above changes anything for an event that
-- already exists. FALSE is "this guest has not asked us for anything", which is what every row
-- already in the table means — there was no way to ask.
ALTER TABLE "participants" ADD COLUMN IF NOT EXISTS "wants_photos" boolean NOT NULL DEFAULT false;

-- The sweep's only read of this table: the guests at one event who asked for their photos and left
-- an address to send them to. Partial, because the rows that matter are a small minority of a large
-- table and the index should be the size of the answer rather than the size of the question.
CREATE INDEX IF NOT EXISTS idx_participants_wants_photos
  ON participants(event_id)
  WHERE wants_photos AND email IS NOT NULL;
