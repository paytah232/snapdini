import { Router, type Request, type Response } from 'express';
import { eq, and, or, sql } from 'drizzle-orm';
import { billingEnabled, stripe, CURRENCY, publicBillingConfig, quote, brandingRemovable, BRANDING_REMOVAL_CENTS, customPlanError } from '../billing';
import { db } from '../db';
import { GUEST_SHOT_PACK, GUEST_SHOT_PACK_CENTS, GUEST_UPGRADE_CUTOFF_MS, effectiveMaxPhotos } from '../allowance';
import { events, participants, processedStripeEvents } from '../schema';
import { sendWelcome } from '../lifecycle';
import { RETENTION_DAYS, purgeAtFor } from '../lib';

const router = Router();

const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');

// Plans/tiers for the pricing UI. Always safe to return — the frontend only surfaces
// pricing when billingEnabled is true.
router.get('/plans', (_req: Request, res: Response) => {
  res.json(publicBillingConfig());
});

// Live price + feature set for an event configuration. Pure pricing (no Stripe).
// Powers the "price updates live" behaviour in the create flow and the billing page.
router.post('/quote', (req: Request, res: Response) => {
  const maxGuests = parseInt(req.body?.maxGuests, 10);
  const maxPhotos = parseInt(req.body?.maxPhotos, 10) || undefined;
  const videoSeconds = parseInt(req.body?.videoSeconds, 10) || 0;
  const durationHours = parseInt(req.body?.durationHours, 10) || undefined;
  const retentionDays = parseInt(req.body?.retentionDays, 10) || undefined;
  const aspectRatios = Array.isArray(req.body?.aspectRatios) ? req.body.aspectRatios.map(String) : undefined;
  if (!Number.isFinite(maxGuests) || maxGuests < 1) {
    return res.status(400).json({ error: 'maxGuests must be a positive number' });
  }
  // `current` is what the event already HAS, so the panel can show the same number the upgrade route
  // will charge: the difference between two configurations, both priced today. It is display only —
  // /upgrade recomputes this from the event row and never trusts a client for it — so a caller who
  // sends nonsense here can only mislead itself.
  const cur = req.body?.current;
  const coveredCents = cur && typeof cur === 'object'
    ? quote({
        maxGuests: parseInt(cur.maxGuests, 10) || 1,
        maxPhotos: parseInt(cur.maxPhotos, 10) || undefined,
        aspectRatios: Array.isArray(cur.aspectRatios) ? cur.aspectRatios.map(String) : undefined,
        videoSeconds: parseInt(cur.videoSeconds, 10) || 0,
        durationHours: parseInt(cur.durationHours, 10) || undefined,
        retentionDays: parseInt(cur.retentionDays, 10) || undefined,
      }).amountCents
    : 0;
  res.json({ ...quote({ maxGuests, maxPhotos, aspectRatios, videoSeconds, durationHours, retentionDays }),
             coveredCents, billingEnabled });
});

// ── GET /api/billing/session/:id — minimal, non-PII lookup of a completed Checkout session ──
// Used by the payment-success page to fire a Google Ads purchase conversion with the ACTUAL amount
// charged (after any promo) + a stable transaction id. Returns only money fields — never customer
// data. The Stripe session id is an unguessable secret, and we only report a paid session.
router.get('/session/:id', async (req: Request, res: Response) => {
  if (!billingEnabled || !stripe) return res.json({ paid: false });
  const id = String(req.params.id || '');
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: 'Invalid session id' });
  try {
    const s = await stripe.checkout.sessions.retrieve(id);
    const paid = s.payment_status === 'paid' || s.payment_status === 'no_payment_required';
    if (!paid) return res.json({ paid: false });
    res.json({
      paid: true,
      amountTotalCents: typeof s.amount_total === 'number' ? s.amount_total : 0,
      currency: (s.currency || CURRENCY).toUpperCase(),
      // Prefer the PaymentIntent id as the order id; fall back to the session id.
      transactionId: typeof s.payment_intent === 'string' ? s.payment_intent : s.id,
    });
  } catch {
    return res.status(404).json({ error: 'Session not found' });
  }
});

// ── POST /api/billing/checkout — start a Stripe Checkout session for a paid event ──
// Body: { joinCode, organizerCode }. Authorized by the event's organizer code. Builds
// the line items dynamically from the event's entitlement (no pre-created Stripe products),
// then returns the hosted-checkout URL to redirect to.
// ── Guest self-upgrade ────────────────────────────────────────────────────────────────────────
// A guest who has run out may top up their OWN roll, if the host allows it. Flat product, no
// ladder: someone standing at a party with an empty roll should not be handed a pricing decision.
router.post('/guest-upgrade', async (req: Request, res: Response) => {
  if (!stripe) return res.status(503).json({ error: 'Payments are not enabled on this server' });
  const sessionToken = String(req.body?.sessionToken || '');
  if (!sessionToken) return res.status(400).json({ error: 'sessionToken required' });

  const [p] = await db.select({
      id: participants.id, name: participants.name, email: participants.email,
      extraPhotos: participants.extraPhotos, photosTaken: participants.photosTaken,
      eventId: events.id, joinCode: events.joinCode, eventName: events.name,
      maxPhotos: events.maxPhotos, expiresAt: events.expiresAt, isLocked: events.isLocked,
      mayBuy: events.guestMayBuyShots,
    }).from(participants).innerJoin(events, eq(events.id, participants.eventId))
    .where(eq(participants.sessionToken, sessionToken));
  if (!p) return res.status(403).json({ error: 'Invalid session' });
  if (!p.mayBuy) return res.status(403).json({ error: 'The host has turned off guest top-ups for this event' });
  if (p.isLocked) return res.status(423).json({ error: 'The host has locked this event' });

  // Shots bought minutes before the camera closes are worthless and come back as a refund request.
  const msLeft = Number(p.expiresAt) - Date.now();
  if (msLeft <= 0) return res.status(410).json({ error: 'This event has ended' });
  if (msLeft < GUEST_UPGRADE_CUTOFF_MS) {
    return res.status(409).json({ error: 'This event is nearly over, so top-ups are closed' });
  }

  const base = BASE_URL;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    // Stripe collects and verifies the email and sends the receipt; the webhook binds it, unless
    // the guest already gave us one when they joined — theirs wins, because that is the address
    // they will type to recover this session on another device.
    customer_email: p.email || undefined,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: CURRENCY,
        unit_amount: GUEST_SHOT_PACK_CENTS,
        product_data: { name: `${GUEST_SHOT_PACK} more shots — ${p.eventName}` },
      },
    }],
    metadata: {
      kind: 'guest_upgrade',            // the webhook branches on this; without it the money would
      participantId: p.id,              // land on the HOST's event total and corrupt revenue reporting
      eventId: p.eventId,
      shots: String(GUEST_SHOT_PACK),
    },
    success_url: `${base}/join/${p.joinCode}?topup=1`,
    cancel_url: `${base}/join/${p.joinCode}`,
  });
  res.json({ url: session.url, shots: GUEST_SHOT_PACK, amountCents: GUEST_SHOT_PACK_CENTS });
});

// A guest asking the host for more, rather than paying. Free, and the only option when the host has
// switched top-ups off. One timestamp per guest — a counter just invites mashing the button.
router.post('/guest-request-more', async (req: Request, res: Response) => {
  const sessionToken = String(req.body?.sessionToken || '');
  if (!sessionToken) return res.status(400).json({ error: 'sessionToken required' });
  const [p] = await db.select({
      id: participants.id, requestedMoreAt: participants.requestedMoreAt,
      mayRequest: events.guestMayRequest,
    }).from(participants).innerJoin(events, eq(events.id, participants.eventId))
    .where(eq(participants.sessionToken, sessionToken));
  if (!p) return res.status(403).json({ error: 'Invalid session' });
  // A host can take top-ups without wanting to field requests mid-event, so this is its own switch.
  if (!p.mayRequest) return res.status(403).json({ error: 'The host has turned off guest requests for this event' });
  if (!p.requestedMoreAt) {
    await db.update(participants).set({ requestedMoreAt: Date.now() }).where(eq(participants.id, p.id));
  }
  res.json({ success: true });
});

router.post('/checkout', async (req: Request, res: Response) => {
  if (!billingEnabled || !stripe) return res.status(400).json({ error: 'Billing is not enabled' });

  const joinCode = String(req.body?.joinCode || '');
  const organizerCode = String(req.body?.organizerCode || '');
  if (!joinCode || !organizerCode) return res.status(400).json({ error: 'joinCode and organizerCode required' });

  // JOIN CODE WINS on a tie — the same rule eventByIdentifier applies, written here because this
  // lookup does not go through it. The two namespaces can collide (see isSlugAvailable), and a join
  // code is the stronger claim; without the sort, which event this resolves to is whichever row the
  // planner happens to return first.
  const evRows = await db.select().from(events).where(
    or(eq(events.joinCode, joinCode.toUpperCase()), eq(events.slug, joinCode.toLowerCase())),
  ).limit(2);
  const event = evRows.length < 2 ? evRows[0]
    : (evRows.find((e) => e.joinCode === joinCode.toUpperCase()) ?? evRows[0]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.organizerCode !== organizerCode) return res.status(403).json({ error: 'Invalid organizer code' });

  let aspectRatios: string[] = ['1:1'];
  try { const p = JSON.parse(event.aspectRatios || '["1:1"]'); if (Array.isArray(p)) aspectRatios = p.map(String); } catch { /* keep default */ }
  const durationHours = Math.max(1, Math.round((event.expiresAt - event.startsAt) / 3_600_000));
  const q = quote({ maxGuests: event.guestCap, maxPhotos: event.maxPhotos, aspectRatios, videoSeconds: event.videoSeconds, durationHours, retentionDays: event.retentionDays });
  if (!q.requiresPayment) return res.status(400).json({ error: 'This event does not require payment' });
  if (event.paid) return res.status(409).json({ error: 'This event is already paid' });

  const mkItem = (unit_amount: number, name: string) =>
    ({ price_data: { currency: CURRENCY, unit_amount, product_data: { name } }, quantity: 1 });
  const lineItems = [mkItem(q.baseCents, `Snapdini event — up to ${event.guestCap} guests`)];
  if (q.shotsCents > 0) lineItems.push(mkItem(q.shotsCents, `Extra shots (${event.maxPhotos}/guest)`));
  if (q.frameCents > 0) lineItems.push(mkItem(q.frameCents, 'Frame-sizes pack'));
  if (q.videoCents > 0) lineItems.push(mkItem(q.videoCents, `Video clips (${event.videoSeconds}s)`));
  if (q.durationCents > 0) lineItems.push(mkItem(q.durationCents, `Extended event (${Math.round(durationHours / 24)} days)`));
  if (q.retentionCents > 0) lineItems.push(mkItem(q.retentionCents, `Extended photo retention (${event.retentionDays} days)`));

  const adminUrl = `${BASE_URL}/admin/${event.joinCode}#${encodeURIComponent(organizerCode)}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: lineItems,
    allow_promotion_codes: true,   // Stripe-native promo codes (managed in site-admin)
    metadata: { eventId: event.id, kind: 'event', amountCents: String(q.amountCents) },
    success_url: `${BASE_URL}/admin/${event.joinCode}?paid=1&session_id={CHECKOUT_SESSION_ID}#${encodeURIComponent(organizerCode)}`,
    cancel_url: adminUrl,
  });
  res.json({ url: session.url });
});

// ── POST /api/billing/upgrade — top up an existing event to a bigger config ──
// Body: { joinCode, organizerCode, maxGuests?, maxPhotos?, aspectRatios?, videoSeconds?,
// durationHours?, retentionDays? }. Each value is clamped UP to at least the current
// entitlement (no downgrades). Charges only the difference vs amount already paid. Works
// before/during/after the event (e.g. extend retention post-event). Free deltas apply at once.
router.post('/upgrade', async (req: Request, res: Response) => {
  if (!billingEnabled || !stripe) return res.status(400).json({ error: 'Billing is not enabled' });
  const joinCode = String(req.body?.joinCode || '');
  const organizerCode = String(req.body?.organizerCode || '');
  if (!joinCode || !organizerCode) return res.status(400).json({ error: 'joinCode and organizerCode required' });

  // JOIN CODE WINS on a tie — the same rule eventByIdentifier applies, written here because this
  // lookup does not go through it. The two namespaces can collide (see isSlugAvailable), and a join
  // code is the stronger claim; without the sort, which event this resolves to is whichever row the
  // planner happens to return first.
  const evRows = await db.select().from(events).where(
    or(eq(events.joinCode, joinCode.toUpperCase()), eq(events.slug, joinCode.toLowerCase())),
  ).limit(2);
  const event = evRows.length < 2 ? evRows[0]
    : (evRows.find((e) => e.joinCode === joinCode.toUpperCase()) ?? evRows[0]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.organizerCode !== organizerCode) return res.status(403).json({ error: 'Invalid organizer code' });

  let curAspects: string[] = ['1:1'];
  try { const p = JSON.parse(event.aspectRatios || '["1:1"]'); if (Array.isArray(p)) curAspects = p.map(String); } catch { /* default */ }
  const curDuration = Math.max(1, Math.round((event.expiresAt - event.startsAt) / 3_600_000));

  // Clamp every field UP to the current entitlement — upgrades only.
  const maxGuests = Math.max(event.guestCap, parseInt(req.body?.maxGuests, 10) || event.guestCap);
  const maxPhotos = Math.max(event.maxPhotos, parseInt(req.body?.maxPhotos, 10) || event.maxPhotos);
  const videoSeconds = Math.max(event.videoSeconds, parseInt(req.body?.videoSeconds, 10) || 0);
  const durationHours = Math.max(curDuration, parseFloat(req.body?.durationHours) || curDuration);
  const retentionDays = Math.max(event.retentionDays, parseInt(req.body?.retentionDays, 10) || event.retentionDays);
  const reqAspects = Array.isArray(req.body?.aspectRatios) ? req.body.aspectRatios.map(String) : [];
  const aspectRatios = Array.from(new Set([...curAspects, ...reqAspects]));   // can only add shapes

  const q = quote({ maxGuests, maxPhotos, aspectRatios, videoSeconds, durationHours, retentionDays });
  // Off the top of any ladder there is no price to charge a difference against, and the difference
  // is what this route bills. An upgrade to 1000 guests quotes baseCents 0, so `diff` goes negative
  // against what the host already paid and the free-delta branch below applies it at once — the
  // A$59 customer upgrades to unlimited by asking. Refused for the same reason create refuses it.
  //
  // This covers duration and retention as well as guests (see MAX_QUOTABLE_HOURS / _DAYS), which is
  // where it mattered most: `durationHours: 100000` on a ≤10-guest event quoted $0, took the
  // diff <= 0 branch, and wrote an expiresAt/purgeAt no cleanup sweep would ever reach.
  if (q.tier === 'custom') return res.status(400).json({ error: customPlanError(q) });
  // Full price of the upgraded config. Use amountCents (NOT a tier check): under the current
  // model even ≤10-guest "free" events owe for paid add-ons (duration/retention), so gating on
  // tier==='paid' wrongly zeroed those and let them apply free + disagreed with the client quote.
  const newTotal = q.amountCents;

  // WHAT THE EVENT ALREADY HAS, priced at TODAY'S prices — and the difference is the bill.
  //
  // This used to be `newTotal - event.amountPaidCents`, which quietly made every price change
  // retroactive. amount_paid_cents is a record of real money taken at some past moment; newTotal is
  // what the same configuration costs now. Move any rung and the two stop agreeing for every event
  // already sold at the old one — so a host who had changed nothing was shown, and would have been
  // charged, the difference. Observed: raising the 36-shot rung by $1 added $1 to the next upgrade
  // of every existing 36-shot event.
  //
  // Pricing both sides at today's ladder makes the charge the delta between two configurations
  // rather than between a configuration and a memory of a payment. Changing nothing is then always
  // zero, whatever we do to prices afterwards.
  //
  // It is NOT a way to get something for nothing: every field above is clamped UP to what the event
  // already holds, so `covered` can only ever describe a subset of `q`. And features that are free
  // below the paid guest tier and charged above it still bill correctly on the way up — at the old
  // tier `covered` prices them at zero, exactly as the host experienced them.
  const covered = quote({
    maxGuests: event.guestCap,
    maxPhotos: event.maxPhotos,
    aspectRatios: curAspects,
    videoSeconds: event.videoSeconds,
    durationHours: curDuration,
    retentionDays: event.retentionDays,
  }).amountCents;
  //
  // The BETTER of the two for the host, never just one of them. `covered` stops a price change from
  // becoming a bill; `amountPaidCents` protects a host who has genuinely paid more than their
  // configuration costs today — a promo, or a tier they later came down from — and pricing on
  // `covered` alone would have quietly confiscated that credit. Whichever is larger is the one they
  // are entitled to have already spent.
  const alreadyCovered = Math.max(covered, event.amountPaidCents);
  const diff = newTotal - alreadyCovered;
  const newExpiresAt = event.startsAt + Math.round(durationHours * 3_600_000);

  // The entitled roll is the QUOTE's number, which is the rung's cap — not the number requested.
  // quote() used to hand `maxPhotos` straight back, so `maxPhotos: 1000000` was written to the
  // event here for the top rung's $8 (and on a ≤10-guest event, where shots are free, for nothing).
  // Floored at what the event already holds so an upgrade can never be a downgrade: a grandfathered
  // row above MAX_QUOTABLE_SHOTS (created while billing was off, or before the cap existed) keeps
  // what it has.
  const entMaxPhotos = Math.max(event.maxPhotos, q.maxPhotos);

  const entitlement = {
    guestCap: maxGuests, maxPhotos: entMaxPhotos, videoSeconds: q.videoSeconds,
    retentionDays, aspectRatios: JSON.stringify(q.aspectRatios), expiresAt: newExpiresAt,
    purgeAt: purgeAtFor(newExpiresAt, retentionDays),
  };

  // Free delta (e.g. config grew but still within the paid tier, or a ≤10 event) → apply now.
  if (diff <= 0) {
    await db.update(events).set({ ...entitlement, paid: true }).where(eq(events.id, event.id));
    return res.json({ applied: true });
  }

  const adminUrl = `${BASE_URL}/admin/${event.joinCode}#${encodeURIComponent(organizerCode)}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price_data: { currency: CURRENCY, unit_amount: diff, product_data: { name: `Snapdini upgrade — up to ${maxGuests} guests` } }, quantity: 1 }],
    allow_promotion_codes: true,
    metadata: {
      eventId: event.id, kind: 'upgrade', amountCents: String(newTotal),
      guestCap: String(maxGuests), maxPhotos: String(entMaxPhotos), videoSeconds: String(q.videoSeconds),
      retentionDays: String(retentionDays), aspectRatios: JSON.stringify(q.aspectRatios), expiresAt: String(newExpiresAt),
    },
    success_url: `${BASE_URL}/admin/${event.joinCode}?upgraded=1&session_id={CHECKOUT_SESSION_ID}#${encodeURIComponent(organizerCode)}`,
    cancel_url: adminUrl,
  });
  res.json({ url: session.url, diffCents: diff });
});

// ── POST /api/billing/branding-removal — buy the $1 "remove Snapdini slideshow frames" add-on ──
router.post('/branding-removal', async (req: Request, res: Response) => {
  const joinCode = String(req.body?.joinCode || '');
  const organizerCode = String(req.body?.organizerCode || '');
  if (!joinCode || !organizerCode) return res.status(400).json({ error: 'joinCode and organizerCode required' });
  // JOIN CODE WINS on a tie — the same rule eventByIdentifier applies, written here because this
  // lookup does not go through it. The two namespaces can collide (see isSlugAvailable), and a join
  // code is the stronger claim; without the sort, which event this resolves to is whichever row the
  // planner happens to return first.
  const evRows = await db.select().from(events).where(
    or(eq(events.joinCode, joinCode.toUpperCase()), eq(events.slug, joinCode.toLowerCase())),
  ).limit(2);
  const event = evRows.length < 2 ? evRows[0]
    : (evRows.find((e) => e.joinCode === joinCode.toUpperCase()) ?? evRows[0]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.organizerCode !== organizerCode) return res.status(403).json({ error: 'Invalid organizer code' });

  // Already free for this event (self-host, already bought, or spent > $50) → nothing to pay.
  if (brandingRemovable(event)) return res.json({ entitled: true });
  if (!stripe) return res.status(400).json({ error: 'Billing is not enabled' });

  const adminUrl = `${BASE_URL}/admin/${event.joinCode}/review#${encodeURIComponent(organizerCode)}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price_data: { currency: CURRENCY, unit_amount: BRANDING_REMOVAL_CENTS, product_data: { name: 'Snapdini — remove slideshow intro/outro frames' } }, quantity: 1 }],
    metadata: { eventId: event.id, kind: 'branding' },
    success_url: `${BASE_URL}/admin/${event.joinCode}/review?brandingpaid=1&session_id={CHECKOUT_SESSION_ID}#${encodeURIComponent(organizerCode)}`,
    cancel_url: adminUrl,
  });
  res.json({ url: session.url });
});

// ── Webhook replay guard ─────────────────────────────────────────────────────
// Stripe redelivers any event it does not get a 2xx for, with backoff, for up to three days, and
// can deliver the same event twice regardless. Most of the handler below is idempotent by accident
// (it SETs a total, or flips a boolean); the `upgrade` branch is not, because amountPaidCents is
// cumulative — and an inflated total makes the host's NEXT upgrade free, since the upgrade route
// only charges newTotal − amountPaidCents. See processed_stripe_events (0050) for why this is a
// table and not another payment-intent column.

/** Claim a Stripe event id. False means this deployment has already processed it.
 *
 *  The INSERT *is* the claim, so two deliveries racing each other cannot both win — which a
 *  read-then-write check could not promise. */
async function claimStripeEvent(id: string, type: string): Promise<boolean> {
  const rows = await db.insert(processedStripeEvents)
    .values({ id, type, processedAt: Date.now() })
    .onConflictDoNothing()
    .returning({ id: processedStripeEvents.id });
  return rows.length > 0;
}

/** Hand the claim back, so Stripe's retry is processed instead of swallowed.
 *
 *  Claiming before the work is what makes the guard atomic, but it means a failure half-way would
 *  otherwise leave the event marked done and the payment never credited — a permanently lost
 *  payment, which is the worse of the two failures. */
async function releaseStripeEvent(id: string): Promise<void> {
  try {
    await db.delete(processedStripeEvents).where(eq(processedStripeEvents.id, id));
  } catch (e) {
    console.error('[billing] could not release webhook claim', id, (e as Error).message);
  }
}

// ── Stripe webhook ────────────────────────────────────────────────────────────
// Mounted in index.ts with express.raw (BEFORE express.json) so the signature can be
// verified against the raw body. On successful payment, marks the event paid (active).
export async function stripeWebhookHandler(req: Request, res: Response) {
  if (!billingEnabled || !stripe) return res.status(400).end();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(400).end();

  let evt;
  try {
    evt = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature') as string, secret);
  } catch (err) {
    return res.status(400).send(`Webhook signature error: ${(err as Error).message}`);
  }

  // Every other event type is acknowledged and ignored — and deliberately NOT claimed, so the
  // table holds only deliveries that actually changed something.
  if (evt.type !== 'checkout.session.completed') return res.json({ received: true });

  // Claimed before any of the work, and given back below if the work throws.
  if (!(await claimStripeEvent(evt.id, evt.type))) {
    console.log(`[billing] ignoring replayed Stripe event ${evt.id}`);
    return res.json({ received: true, duplicate: true });
  }

  try {
    const session = evt.data.object as { metadata?: Record<string, string>; payment_status?: string; amount_total?: number | null; payment_intent?: string | null };
    const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : null;
    const m = session.metadata ?? {};
    const eventId = m.eventId;
    // Only grant entitlement once the session is actually settled (paid, or a genuine $0
    // comp via a 100%-off promo we created). Never on an unpaid/incomplete session.
    const settled = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
    // A guest topping up their OWN roll. This MUST branch before the event handling below: that path
    // keys purely on eventId and would credit the guest's A$3 to the HOST's event total, silently
    // corrupting revenue reporting and the upgrade-difference maths.
    if (settled && m.kind === 'guest_upgrade' && m.participantId) {
      const shots = parseInt(m.shots, 10) || 0;
      const paidNow = typeof session.amount_total === 'number' ? session.amount_total : 0;
      // The guest's OWN address wins — it is what they will type to recover this session on another
      // device, so overwriting it with the card's billing email would strand their paid roll.
      const stripeEmail = (session as { customer_details?: { email?: string | null } }).customer_details?.email || null;

      // Granting the shots and recording the money are ONE statement, and the arithmetic is the
      // DATABASE's — never a number this process read a moment ago and added a pack to.
      //
      // It used to be a SELECT followed by `set({ extraPhotos: (cur.extraPhotos || 0) + shots,
      // amountPaidCents: (cur.amountPaidCents || 0) + paidNow })`. Six settled top-ups for one
      // guest, delivered together, all read extra_photos=0 and all wrote 12: the guest was handed
      // ONE pack for six payments, and amount_paid_cents recorded A$3 of the A$18 taken. Measured
      // exactly that on this box before this change — see 22-guest-topup-race, which fires the
      // deliveries for real. The lost money column is also what HID it: the refund the guest then
      // asks for is priced off a total that never recorded the charge.
      //
      // Money taken for an entitlement we then failed to grant is the worst thing this product can
      // do, so it does not depend on how the deliveries happen to interleave.
      //
      // The replay guard is the WHERE, for the same reason the upload path's roll cap is
      // (routes/photos.ts): a guard that reads the row and decides in JS is check-then-act, and
      // under concurrency every racer reads the same NULL. Postgres re-evaluates this predicate
      // against the row it has locked, so a racer that arrives second sees what the first wrote.
      //
      // `IS DISTINCT FROM` rather than `<>`: the column is NULL until a guest's first top-up, and
      // `NULL <> 'pi_x'` is NULL, which no WHERE clause ever honours.
      //
      // Added only when Stripe named a payment intent. A genuine $0 comp (no_payment_required) has
      // none, and a missing intent must never read as "already credited" — a replayed comp is the
      // event-id claim's job, above.
      //
      // Which is also why this is the SECOND line of defence and not the first: claimStripeEvent()
      // already makes a redelivery of one event id atomically impossible. What it cannot see is a
      // NEW event id carrying a payment we have already credited, or — on the release path, where
      // a transient failure deliberately hands the claim back — a retry of a delivery whose UPDATE
      // had in fact landed.
      const notYetCredited = paymentIntent
        ? sql`${participants.stripePaymentIntent} is distinct from ${paymentIntent}`
        : undefined;
      const [granted] = await db.update(participants).set({
        extraPhotos: sql`${participants.extraPhotos} + ${shots}`,
        amountPaidCents: sql`${participants.amountPaidCents} + ${paidNow}`,
        // Left alone when this session named no intent, rather than overwritten with NULL: the
        // column is the operator's one-click refund handle, so a $0 comp must not erase the handle
        // for the real payment before it.
        stripePaymentIntent: paymentIntent ?? undefined,
        upgradeEmail: stripeEmail,
        // The SQL of `cur.email || stripeEmail`, and only written when there is something to write:
        // a top-up Stripe gave us no address for leaves the guest's own address exactly as it was.
        email: stripeEmail ? sql`coalesce(nullif(${participants.email}, ''), ${stripeEmail})` : undefined,
      }).where(and(eq(participants.id, m.participantId), notYetCredited))
        .returning({ extraPhotos: participants.extraPhotos, amountPaidCents: participants.amountPaidCents });
      // Nothing came back: this payment was already credited, or the participant is gone (purged,
      // or a host removing a duplicate join while the guest was in checkout). Both are
      // acknowledged — a non-2xx only makes Stripe redeliver something we have decided not to act
      // on, and the claim above is what keeps that decision stable.
      if (!granted) {
        console.log(`[billing] guest top-up not applied for participant ${m.participantId} — already credited, or the guest is gone`);
        return res.json({ received: true });
      }
      console.log(`[billing] guest top-up: +${shots} shots to participant ${m.participantId} (${paidNow}c)`
        + ` → ${granted.extraPhotos} extra shots, ${granted.amountPaidCents}c paid in total`);
      return res.json({ received: true });
    }

    if (eventId && settled) {
      // Record the ACTUAL amount Stripe charged (amount_total, after any promo/discount) — NOT
      // the pre-discount quote in metadata. Trusting metadata would credit a $0 promo checkout as
      // if it paid full price, letting a later upgrade undercharge (diff = newTotal − inflatedPaid).
      const paidNow = typeof session.amount_total === 'number' ? session.amount_total : (parseInt(m.amountCents, 10) || 0);
      if (m.kind === 'upgrade') {
        // amountPaidCents is cumulative real money, so an upgrade ADDS what it actually charged.
        // amountPaidCents is NOT read here any more — see the UPDATE below. What is left is read
        // only to fill in for metadata this delivery did not carry, and every one of those is a
        // plain SET, where "the last delivery wins" is the correct answer rather than a lost one.
        const [cur] = await db.select({
          expiresAt: events.expiresAt,
          retentionDays: events.retentionDays, purgeAt: events.purgeAt,
        }).from(events).where(eq(events.id, eventId));

        // The purge, rebuilt from what we can actually stand behind.
        //
        // Every other field here says `|| undefined`, which leaves the stored value alone when the
        // metadata is missing. purgeAt said `|| 0`, which did the opposite: an absent expiresAt
        // became the epoch, purgeAt landed in January 1970, and the next cleanup sweep deleted
        // every photo belonging to an event whose owner had — one webhook ago — paid us to make it
        // bigger. Metadata first, the event's own row behind it, and nothing computed at all if
        // neither can name an expiry.
        const upExpiresAt = parseInt(m.expiresAt, 10) || cur?.expiresAt || 0;
        const upRetention = parseInt(m.retentionDays, 10) || cur?.retentionDays || RETENTION_DAYS;
        // An upgrade only ever ADDS. If this arrives out of order, or the metadata is thinner than
        // what the event already holds, the longer window wins — a retry must not be able to walk
        // somebody's retention backwards.
        const upPurgeAt = upExpiresAt
          ? Math.max(purgeAtFor(upExpiresAt, upRetention), cur?.purgeAt ?? 0)
          : undefined;

        await db.update(events).set({
          paid: true,
          // The same defect as the guest branch above, on the host's side of the ladder and with
          // the loss pointing the other way: the upgrade route charges `newTotal −
          // amountPaidCents`, so a top-up whose credit is lost makes the host's NEXT upgrade
          // cheaper than it should be. Two upgrade checkouts for one event settling together is
          // the reachable case (two tabs, or Stripe's fleet delivering both at once), and the
          // arithmetic belongs to Postgres for the same reason it does there.
          amountPaidCents: sql`${events.amountPaidCents} + ${paidNow}`,
          guestCap: parseInt(m.guestCap, 10) || undefined,
          maxPhotos: parseInt(m.maxPhotos, 10) || undefined,
          videoSeconds: parseInt(m.videoSeconds, 10) || 0,
          retentionDays: parseInt(m.retentionDays, 10) || undefined,
          aspectRatios: m.aspectRatios || undefined,
          expiresAt: parseInt(m.expiresAt, 10) || undefined,
          purgeAt: upPurgeAt,
        }).where(eq(events.id, eventId));
      } else if (m.kind === 'branding') {
        // The $1 add-on: just flips the entitlement (doesn't touch the event's paid total/tier).
        await db.update(events).set({ brandingRemovalPaid: true }).where(eq(events.id, eventId));
      } else {
        await db.update(events).set({ paid: true, amountPaidCents: paidNow, stripePaymentIntent: paymentIntent ?? undefined }).where(eq(events.id, eventId));
        // Welcome email (idempotent; no-op unless LIFECYCLE_EMAILS=1). Fire-and-forget so the
        // webhook still 200s promptly even if email is slow/unavailable.
        sendWelcome(eventId).catch((e) => console.error('[lifecycle] welcome trigger:', (e as Error).message));
      }
    }
  } catch (err) {
    // The handler had no catch at all: a transient database error left Express to answer 500, and
    // Stripe's retry then re-applied whatever HAD succeeded — which on the upgrade branch is money.
    // Now the claim goes back and the retry is a first delivery again.
    await releaseStripeEvent(evt.id);
    console.error(`[billing] webhook ${evt.id} failed:`, (err as Error).message);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
  res.json({ received: true });
}

export default router;
