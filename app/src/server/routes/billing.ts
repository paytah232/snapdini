import { Router, type Request, type Response } from 'express';
import { eq, and, or } from 'drizzle-orm';
import { billingEnabled, stripe, CURRENCY, publicBillingConfig, quote, brandingRemovable, BRANDING_REMOVAL_CENTS } from '../billing';
import { db } from '../db';
import { events } from '../schema';

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

// ── POST /api/billing/checkout — start a Stripe Checkout session for a paid event ──
// Body: { joinCode, organizerCode }. Authorized by the event's organizer code. Builds
// the line items dynamically from the event's entitlement (no pre-created Stripe products),
// then returns the hosted-checkout URL to redirect to.
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
    success_url: `${BASE_URL}/admin/${event.joinCode}?paid=1#${encodeURIComponent(organizerCode)}`,
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
    success_url: `${BASE_URL}/admin/${event.joinCode}?upgraded=1#${encodeURIComponent(organizerCode)}`,
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
    success_url: `${BASE_URL}/admin/${event.joinCode}/review?brandingpaid=1#${encodeURIComponent(organizerCode)}`,
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
    const session = evt.data.object as { metadata?: Record<string, string>; payment_status?: string; amount_total?: number | null };
    const m = session.metadata ?? {};
    const eventId = m.eventId;
    // Only grant entitlement once the session is actually settled (paid, or a genuine $0
    // comp via a 100%-off promo we created). Never on an unpaid/incomplete session.
    const settled = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
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
        await db.update(events).set({ paid: true, amountPaidCents: paidNow }).where(eq(events.id, eventId));
      }
    }
  }
  res.json({ received: true });
}

export default router;
