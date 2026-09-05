-- Guest-paid upgrades. A guest who runs out of shots may top up their OWN roll, if the host allows
-- it. The allowance is therefore per participant on top of the event's, never a rewrite of it — so
-- a host lowering the event roll can never take away something a guest paid for.
ALTER TABLE participants
  ADD COLUMN IF NOT EXISTS extra_photos           integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS upgrade_email          text,
  ADD COLUMN IF NOT EXISTS amount_paid_cents      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent  text,
  -- Set when a guest asks the host for more rather than paying. One timestamp, not a counter:
  -- a counter invites mashing the button and tells the host nothing extra.
  ADD COLUMN IF NOT EXISTS requested_more_at      bigint;

-- What the host permits guests to buy for themselves. Shots are on by default because more shots
-- are invisible to everyone else; video and frames are off, because both change what turns up in
-- the host's gallery and that stays the host's call.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS guest_may_buy_shots   boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS guest_may_buy_video   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS guest_may_buy_frames  boolean NOT NULL DEFAULT false;

-- One address per event. Guests recover a session by email, so a second row sharing an address
-- would strand a paid upgrade on the row they did NOT land on. Enforced here rather than trusted
-- to a route remembering. Verified clean on dev and production before adding.
CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_event_email
  ON participants (event_id, lower(email)) WHERE email IS NOT NULL;

-- Stripe retries webhooks; delivery must be idempotent, and this is the key it dedupes on.
CREATE INDEX IF NOT EXISTS idx_participants_intent
  ON participants (stripe_payment_intent) WHERE stripe_payment_intent IS NOT NULL;
