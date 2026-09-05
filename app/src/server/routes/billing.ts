import { Router, type Request, type Response } from 'express';
import { eq, and, or } from 'drizzle-orm';
import { billingEnabled, stripe, CURRENCY, publicBillingConfig, quote, brandingRemovable, BRANDING_REMOVAL_CENTS } from '../billing';
import { db } from '../db';
import { GUEST_SHOT_PACK, GUEST_SHOT_PACK_CENTS, GUEST_UPGRADE_CUTOFF_MS, effectiveMaxPhotos } from '../allowance';
import { events, participants } from '../schema';
import { sendWelcome } from '../lifecycle';

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
  res.json({ ...quote({ maxGuests, maxPhotos, aspectRatios, videoSeconds, durationHours, retentionDays }), billingEnabled });
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

  const [event] = await db.select().from(events).where(
    or(eq(events.joinCode, joinCode.toUpperCase()), eq(events.slug, joinCode.toLowerCase())),
  );
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

  const [event] = await db.select().from(events).where(
    or(eq(events.joinCode, joinCode.toUpperCase()), eq(events.slug, joinCode.toLowerCase())),
  );
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
  // Full price of the upgraded config. Use amountCents (NOT a tier check): under the current
  // model even ≤10-guest "free" events owe for paid add-ons (duration/retention), so gating on
  // tier==='paid' wrongly zeroed those and let them apply free + disagreed with the client quote.
  const newTotal = q.amountCents;
  const diff = newTotal - event.amountPaidCents;
  const newExpiresAt = event.startsAt + Math.round(durationHours * 3_600_000);

  const entitlement = {
    guestCap: maxGuests, maxPhotos: q.maxPhotos, videoSeconds: q.videoSeconds,
    retentionDays, aspectRatios: JSON.stringify(q.aspectRatios), expiresAt: newExpiresAt,
    purgeAt: newExpiresAt + retentionDays * 86_400_000,
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
      guestCap: String(maxGuests), maxPhotos: String(q.maxPhotos), videoSeconds: String(q.videoSeconds),
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
  const [event] = await db.select().from(events).where(
    or(eq(events.joinCode, joinCode.toUpperCase()), eq(events.slug, joinCode.toLowerCase())),
  );
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

  if (evt.type === 'checkout.session.completed') {
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
      const [cur] = await db.select({
          extraPhotos: participants.extraPhotos,
          amountPaidCents: participants.amountPaidCents,
          stripePaymentIntent: participants.stripePaymentIntent,
          email: participants.email,
        }).from(participants).where(eq(participants.id, m.participantId));
      if (!cur) return res.json({ received: true });
      // Stripe retries webhooks; without this a redelivery grants the shots twice.
      if (paymentIntent && cur.stripePaymentIntent === paymentIntent) return res.json({ received: true });
      // The guest's OWN address wins — it is what they will type to recover this session on another
      // device, so overwriting it with the card's billing email would strand their paid roll.
      const stripeEmail = (session as { customer_details?: { email?: string | null } }).customer_details?.email || null;
      await db.update(participants).set({
        extraPhotos: (cur.extraPhotos || 0) + shots,
        amountPaidCents: (cur.amountPaidCents || 0) + paidNow,
        stripePaymentIntent: paymentIntent,
        upgradeEmail: stripeEmail,
        email: cur.email || stripeEmail,
      }).where(eq(participants.id, m.participantId));
      console.log(`[billing] guest top-up: +${shots} shots to participant ${m.participantId} (${paidNow}c)`);
      return res.json({ received: true });
    }

    if (eventId && settled) {
      // Record the ACTUAL amount Stripe charged (amount_total, after any promo/discount) — NOT
      // the pre-discount quote in metadata. Trusting metadata would credit a $0 promo checkout as
      // if it paid full price, letting a later upgrade undercharge (diff = newTotal − inflatedPaid).
      const paidNow = typeof session.amount_total === 'number' ? session.amount_total : (parseInt(m.amountCents, 10) || 0);
      if (m.kind === 'upgrade') {
        // amountPaidCents is cumulative real money, so an upgrade ADDS what it actually charged.
        const [cur] = await db.select({ amountPaidCents: events.amountPaidCents }).from(events).where(eq(events.id, eventId));
        await db.update(events).set({
          paid: true,
          amountPaidCents: (cur?.amountPaidCents || 0) + paidNow,
          guestCap: parseInt(m.guestCap, 10) || undefined,
          maxPhotos: parseInt(m.maxPhotos, 10) || undefined,
          videoSeconds: parseInt(m.videoSeconds, 10) || 0,
          retentionDays: parseInt(m.retentionDays, 10) || undefined,
          aspectRatios: m.aspectRatios || undefined,
          expiresAt: parseInt(m.expiresAt, 10) || undefined,
          purgeAt: (parseInt(m.expiresAt, 10) || 0) + (parseInt(m.retentionDays, 10) || 7) * 86_400_000,
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
  }
  res.json({ received: true });
}

export default router;
