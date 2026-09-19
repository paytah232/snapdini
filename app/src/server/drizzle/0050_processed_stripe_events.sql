-- Stripe webhook deliveries this deployment has already acted on.
--
-- Stripe retries any delivery that does not answer 2xx, with backoff, for up to three days. The
-- webhook handler had no record of what it had processed, and its `upgrade` branch ADDS money:
--
--   amount_paid_cents = amount_paid_cents + <what Stripe charged>
--
-- so a single redelivery credited the same payment twice. That is not just a wrong figure in a
-- report: the upgrade route charges newTotal − amount_paid_cents, so an inflated total makes the
-- host's NEXT upgrade free (diff <= 0 applies the new entitlement immediately, with no checkout).
-- One transient 500, or one duplicate delivery, was enough.
--
-- The guest top-up branch already guarded itself by remembering participants.stripe_payment_intent
-- and skipping a repeat. That shape does not transfer to events:
--
--   · events.stripe_payment_intent is the refund handle for the event's ORIGINAL payment (the
--     site-admin one-click refund reads it). An upgrade writing its own intent there would
--     repoint that refund at the top-up.
--   · one slot only remembers the last payment, and upgrades are meant to be repeatable. Stripe's
--     retry window is long enough for upgrade A's retry to land after upgrade B has succeeded, by
--     which time the slot says B and A is applied a second time.
--
-- Keyed by Stripe's own event id, which every retry of a delivery reuses. Ordering-independent,
-- and it covers every branch of the handler (and any branch added later) rather than one.
--
-- Rows are small and are kept: they are the record of which payments we have acted on, and are
-- worth having when a figure is ever disputed. Prune by processed_at if that ever changes.
CREATE TABLE IF NOT EXISTS processed_stripe_events (
  id           text PRIMARY KEY,   -- Stripe event id (evt_…)
  type         text NOT NULL,      -- e.g. 'checkout.session.completed'
  processed_at bigint NOT NULL
);
