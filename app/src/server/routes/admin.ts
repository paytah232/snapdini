import { Router, type Request, type Response } from 'express';
import path from 'path';
import { requireAdmin } from '../auth';
import { get, all, run } from '../db';
import { billingEnabled, stripe, CURRENCY } from '../billing';
import { sweep } from '../cleanup';
import { UPLOADS_DIR } from '../paths';

// ── Site-admin API ────────────────────────────────────────────────────────────
// Every route is gated by requireAdmin (signed-in user with the is_admin flag).
// Admins are bootstrapped from ADMIN_EMAIL/ADMIN_PASSWORD (see auth.ensureAdminFromEnv);
// self-host default is no admin at all. Promo-code management is mounted here too.
const router = Router();
router.use(requireAdmin);

// Instance overview — headline counts for the dashboard.
router.get('/overview', async (_req: Request, res: Response) => {
  const now = Date.now();
  const stats = await get(
    `SELECT
       (SELECT count(*) FROM users)                          AS users,
       (SELECT count(*) FROM users WHERE is_admin)           AS admins,
       -- Demo events are created unauthenticated (owner_user_id IS NULL) and are flagged paid=true
       -- with amount_paid_cents = 0 so they bypass billing. Counting them as "paid" reported 21
       -- demos alongside 2 real sales. Real events and demos are now counted separately, and
       -- "paid" means money was actually taken.
       (SELECT count(*) FROM events WHERE owner_user_id IS NOT NULL)  AS events,
       (SELECT count(*) FROM events WHERE owner_user_id IS NULL)      AS demo_events,
       (SELECT count(*) FROM events
         WHERE amount_paid_cents > 0 AND refunded_at IS NULL)         AS paid_events,
       (SELECT count(*) FROM events
         WHERE expires_at > ? AND owner_user_id IS NOT NULL)          AS active_events,
       (SELECT count(*) FROM participants)                   AS participants,
       (SELECT count(*) FROM photos)                         AS photos,
       (SELECT count(*) FROM photos WHERE media_type = 'video')       AS videos,
       -- How often guests actually exceed the seconds they paid for. Over-length clips are KEPT
       -- (see photos.ts), so this is the number that says whether the leniency costs anything and
       -- whether the seconds ladder is worth enforcing at all.
       (SELECT count(*) FROM photos p JOIN events e ON e.id = p.event_id
         WHERE p.media_type = 'video' AND e.video_seconds > 0
           AND p.duration_ms > (e.video_seconds + 3) * 1000)          AS videos_over_limit,
       -- Split by source, because the two mean opposite things. An over-length clip from the CAMERA
       -- ROLL is the feature working: a guest shot it outside the app and we kept it. The same
       -- overage from in-app CAPTURE is a defect — the recorder was supposed to stop itself — and is
       -- the number to actually chase.
       (SELECT count(*) FROM photos p JOIN events e ON e.id = p.event_id
         WHERE p.media_type = 'video' AND e.video_seconds > 0 AND p.source = 'capture'
           AND p.duration_ms > (e.video_seconds + 3) * 1000)          AS capture_overshoots`,
    [now],
  );
  // The detail behind videos_over_limit: which event, what they paid for, what they actually sent.
  const videoOverages = await all(
    `SELECT e.join_code, e.name, e.video_seconds AS purchased_secs, p.source,
            round(p.duration_ms / 1000.0)  AS actual_secs,
            round((p.duration_ms / 1000.0) - e.video_seconds) AS over_by_secs,
            p.taken_at
       FROM photos p JOIN events e ON e.id = p.event_id
      WHERE p.media_type = 'video' AND e.video_seconds > 0
        AND p.duration_ms > (e.video_seconds + 3) * 1000
      ORDER BY p.taken_at DESC
      LIMIT 20`);
  res.json({ stats, videoOverages, now });
});

// ── GET /api/admin/referral-funnel ────────────────────────────────────────────
// The whole point of the referral work: does a guest who came from someone else's gallery actually
// run an event? Codes-redeemed is a vanity metric; the step that matters is signup → event created,
// because that is exactly where paid traffic dies.
router.get('/referral-funnel', async (_req: Request, res: Response) => {
  const totals = await get<Record<string, number>>(
    `SELECT
       (SELECT COALESCE(sum(gallery_views), 0)   FROM events)                             AS gallery_views,
       (SELECT COALESCE(sum(referral_clicks), 0) FROM events)                             AS referral_clicks,
       (SELECT count(*) FROM users  WHERE referred_by_event_id IS NOT NULL)               AS referred_signups,
       (SELECT count(*) FROM events WHERE referred_by_event_id IS NOT NULL)               AS referred_events,
       (SELECT count(*) FROM events WHERE referred_by_event_id IS NOT NULL
                                     AND amount_paid_cents > 0 AND refunded_at IS NULL)   AS referred_paid,
       (SELECT COALESCE(sum(amount_paid_cents), 0) FROM events
         WHERE referred_by_event_id IS NOT NULL AND refunded_at IS NULL)                  AS referred_cents`);

  // Which galleries are actually generating anything, so the operator knows where it works.
  const sources = await all(
    `SELECT e.join_code, e.name, e.gallery_views, e.referral_clicks,
            (SELECT count(*) FROM users  u WHERE u.referred_by_event_id = e.id) AS signups,
            (SELECT count(*) FROM events c WHERE c.referred_by_event_id = e.id) AS events_created
       FROM events e
      WHERE e.gallery_views > 0 OR e.referral_clicks > 0
      ORDER BY e.referral_clicks DESC, e.gallery_views DESC
      LIMIT 50`);

  // Engagement, so "did anyone look at the photos" is answerable without a separate tool.
  const engagement = await get<Record<string, number>>(
    `SELECT COALESCE(sum(view_count),0) AS photo_views, COALESCE(sum(download_count),0) AS photo_downloads
       FROM photos`);

  res.json({ totals, sources, engagement });
});

// Recent events (newest first).
router.get('/events', async (_req: Request, res: Response) => {
  // Counts come from pre-aggregated subqueries joined on event_id (one grouped index scan each)
  // rather than a correlated count per row.
  const events = await all(
    `SELECT e.id, e.join_code, e.slug, e.name, e.guest_cap, e.video_seconds, e.paid,
            e.amount_paid_cents, e.refunded_at,
            e.organizer_code, e.purged_at, e.purge_at, e.expires_at, e.created_at,
            COALESCE(pc.n, 0) AS participants,
            COALESCE(phc.n, 0) AS photos,
            u.email AS owner
       FROM events e
       LEFT JOIN users u ON u.id = e.owner_user_id
       LEFT JOIN (SELECT event_id, count(*) AS n FROM participants GROUP BY event_id) pc ON pc.event_id = e.id
       LEFT JOIN (SELECT event_id, count(*) AS n FROM photos GROUP BY event_id) phc ON phc.event_id = e.id
      ORDER BY e.created_at DESC
      LIMIT 200`,
  );
  res.json({ events });
});

// Recent users (newest first).
router.get('/users', async (_req: Request, res: Response) => {
  const users = await all(
    `SELECT u.id, u.email, u.display_name, u.plan, u.is_admin, u.email_verified_at, u.created_at,
            COALESCE(ec.n, 0) AS events
       FROM users u
       LEFT JOIN (SELECT owner_user_id, count(*) AS n FROM events WHERE owner_user_id IS NOT NULL GROUP BY owner_user_id) ec ON ec.owner_user_id = u.id
      ORDER BY u.created_at DESC
      LIMIT 500`,
  );
  res.json({ users });
});

// Contact-form messages (DB-backed mailbox). Unhandled first, newest first.
router.get('/contact', async (_req: Request, res: Response) => {
  const messages = await all(
    `SELECT id, name, email, message, kind, image_filename AS "imageFilename", emailed, handled, created_at
       FROM contact_messages ORDER BY handled ASC, created_at DESC LIMIT 200`);
  const unhandled = await get<{ n: number }>(`SELECT count(*) AS n FROM contact_messages WHERE NOT handled`);
  res.json({ messages, unhandled: Number(unhandled?.n ?? 0) });
});

// Admin-gated view of a feedback screenshot (kept out of the public /uploads tree).
router.get('/feedback-image/:file', (req: Request, res: Response) => {
  const file = String(req.params.file || '');
  if (!/^[A-Za-z0-9_-]+\.jpg$/.test(file)) return res.status(400).end();
  return res.sendFile(path.join(UPLOADS_DIR, 'feedback', file));
});
router.post('/contact/:id/handled', async (req: Request, res: Response) => {
  await run(`UPDATE contact_messages SET handled = NOT handled WHERE id = ?`, [String(req.params.id)]);
  res.json({ ok: true });
});

// Client-side error reports (diagnostic). Unresolved first, newest first.
router.get('/client-errors', async (_req: Request, res: Response) => {
  const errors = await all(
    `SELECT id, message, context, event_code, user_agent, url, handled, created_at
       FROM client_errors ORDER BY handled ASC, created_at DESC LIMIT 300`);
  const open = await get<{ n: number }>(`SELECT count(*) AS n FROM client_errors WHERE NOT handled`);
  res.json({ errors, open: Number(open?.n ?? 0) });
});
router.post('/client-errors/:id/handled', async (req: Request, res: Response) => {
  await run(`UPDATE client_errors SET handled = NOT handled WHERE id = ?`, [String(req.params.id)]);
  res.json({ ok: true });
});

// Post-event survey responses (newest first), with the event they belong to.
router.get('/survey-responses', async (_req: Request, res: Response) => {
  const responses = await all(
    `SELECT s.id, s.overall, s.setup, s.guest_experience AS "guestExperience", s.value, s.nps,
            s.comments, s.contact_opt_in AS "contactOptIn",
            s.testimonial_ok AS "testimonialOk", s.testimonial_name AS "testimonialName",
            s.published_at AS "publishedAt", s.created_at,
            e.name AS "eventName", e.join_code AS "joinCode"
       FROM survey_responses s JOIN events e ON e.id = s.event_id
      ORDER BY s.created_at DESC LIMIT 200`);
  res.json({ responses });
});

// One-click FULL refund of an event's payment via Stripe, then lock the event (a full refund is a
// cancellation). Partial/goodwill refunds stay in the Stripe dashboard. Idempotent: refuses if
// already refunded, and requires a payment intent on file (captured at checkout).
router.post('/refund/:eventId', async (req: Request, res: Response) => {
  if (!billingEnabled || !stripe) return res.status(400).json({ error: 'Billing is not enabled' });
  const eventId = String(req.params.eventId);
  const ev = await get<{ pi: string | null; refunded: number | null; cents: number }>(
    `SELECT stripe_payment_intent AS pi, refunded_at AS refunded, amount_paid_cents AS cents FROM events WHERE id = ?`, [eventId]);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  if (ev.refunded) return res.status(400).json({ error: 'This event has already been refunded' });
  if (!ev.pi) return res.status(400).json({ error: 'No Stripe payment on file — refund manually in the Stripe dashboard' });
  try {
    const refund = await stripe.refunds.create({ payment_intent: ev.pi });
    await run(`UPDATE events SET refunded_at = ?, is_locked = true WHERE id = ?`, [Date.now(), eventId]);
    res.json({ ok: true, refundId: refund.id, amountCents: ev.cents });
  } catch (e) {
    res.status(502).json({ error: 'Stripe refund failed: ' + (e as Error).message });
  }
});

// Guest top-ups. These are participant-level payments and were invisible here, so a chargeback or
// a genuine failure meant going to the Stripe dashboard by hand. Australian Consumer Law does not
// let you contract out of consumer guarantees, so a refund path has to exist even though the stated
// position is that change-of-mind top-ups are not refunded.
router.get('/guest-payments', async (_req: Request, res: Response) => {
  const rows = await all(
    `SELECT p.id, p.name, COALESCE(p.upgrade_email, p.email) AS email, p.extra_photos,
            p.amount_paid_cents, p.stripe_payment_intent, p.requested_more_at,
            e.join_code, e.name AS event_name
       FROM participants p JOIN events e ON e.id = p.event_id
      WHERE p.amount_paid_cents > 0
      ORDER BY p.joined_at DESC
      LIMIT 100`);
  res.json({ payments: rows });
});

router.post('/refund-guest/:participantId', async (req: Request, res: Response) => {
  if (!billingEnabled || !stripe) return res.status(400).json({ error: 'Billing is not enabled' });
  const id = String(req.params.participantId);
  const p = await get<{ pi: string | null; cents: number; extra: number }>(
    `SELECT stripe_payment_intent AS pi, amount_paid_cents AS cents, extra_photos AS extra
       FROM participants WHERE id = ?`, [id]);
  if (!p) return res.status(404).json({ error: 'Guest not found' });
  if (!p.cents) return res.status(400).json({ error: 'This guest has not paid for anything' });
  if (!p.pi) return res.status(400).json({ error: 'No Stripe payment on file — refund manually in the Stripe dashboard' });
  try {
    const refund = await stripe.refunds.create({ payment_intent: p.pi });
    // Take the shots back with the money. Photos they already took are untouched — the roll simply
    // returns to whatever the event allows.
    await run(`UPDATE participants SET amount_paid_cents = 0, extra_photos = 0, stripe_payment_intent = NULL WHERE id = ?`, [id]);
    res.json({ ok: true, refundId: refund.id, amountCents: p.cents, shotsRemoved: p.extra });
  } catch (e) {
    res.status(502).json({ error: 'Stripe refund failed: ' + (e as Error).message });
  }
});

// Guest feedback. Collecting it without a way to read it is just a table that fills up, so this
// exists for the same reason the collection does.
router.get('/guest-feedback', async (_req: Request, res: Response) => {
  const rows = await all(
    `SELECT gf.id, gf.rating, gf.comment, gf.created_at,
            p.name AS guest_name, e.join_code, e.name AS event_name
       FROM guest_feedback gf
       LEFT JOIN participants p ON p.id = gf.participant_id
       JOIN events e            ON e.id = gf.event_id
      ORDER BY gf.created_at DESC
      LIMIT 100`);
  const stats = await get<{ n: number; avg: number | null }>(
    `SELECT count(*) AS n, avg(rating)::float AS avg FROM guest_feedback WHERE rating IS NOT NULL`);
  res.json({ feedback: rows, count: Number(stats?.n || 0), average: stats?.avg ?? null });
});

// Run the retention sweeper on demand (the same job the hourly timer runs) — purges events past
// their retention window. Useful for ops + lets the test suite exercise purge deterministically.
router.post('/run-sweep', async (_req: Request, res: Response) => {
  const purged = await sweep();
  res.json({ ok: true, purged });
});

// ── Promo codes (Stripe-native) ───────────────────────────────────────────────
// Codes are created as a Stripe coupon (the discount) + promotion code (what guests type
// at Checkout). Stripe enforces redemption limits + expiry; allow_promotion_codes is already
// set on the checkout session. Only available when billing is enabled.

router.get('/promos', async (_req: Request, res: Response) => {
  if (!billingEnabled || !stripe) return res.json({ billingEnabled: false, promos: [] });
  const list = await stripe.promotionCodes.list({ limit: 100, expand: ['data.promotion.coupon'] });
  const promos = list.data.map((p) => {
    const coupon = (p.promotion as { coupon?: { percent_off?: number | null; amount_off?: number | null; currency?: string | null } })?.coupon;
    return {
      id: p.id,
      code: p.code,
      active: p.active,
      timesRedeemed: p.times_redeemed,
      maxRedemptions: p.max_redemptions ?? null,
      expiresAt: p.expires_at ? p.expires_at * 1000 : null,
      percentOff: coupon?.percent_off ?? null,
      amountOff: coupon?.amount_off ?? null,
      currency: coupon?.currency ?? null,
      created: p.created * 1000,
    };
  });
  res.json({ billingEnabled: true, promos });
});

router.post('/promos', async (req: Request, res: Response) => {
  if (!billingEnabled || !stripe) return res.status(400).json({ error: 'Billing is not enabled' });
  const code = String(req.body?.code || '').trim().toUpperCase();
  const percentOff = req.body?.percentOff != null ? Number(req.body.percentOff) : null;
  const amountOff = req.body?.amountOff != null ? Math.round(Number(req.body.amountOff) * 100) : null; // dollars → cents
  const maxRedemptions = req.body?.maxRedemptions != null ? parseInt(req.body.maxRedemptions, 10) : null;
  const expiresAt = req.body?.expiresAt != null ? parseInt(req.body.expiresAt, 10) : null; // epoch ms

  if (!code || !/^[A-Z0-9_-]{3,40}$/.test(code)) return res.status(400).json({ error: 'Code must be 3–40 chars (A–Z, 0–9, - or _)' });
  const hasPct = percentOff != null && percentOff > 0 && percentOff <= 100;
  const hasAmt = amountOff != null && amountOff > 0;
  if (hasPct === hasAmt) return res.status(400).json({ error: 'Set exactly one of percentOff (1–100) or amountOff (>0)' });
  if (maxRedemptions != null && (!Number.isFinite(maxRedemptions) || maxRedemptions < 1)) return res.status(400).json({ error: 'maxRedemptions must be ≥ 1' });
  if (expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) return res.status(400).json({ error: 'expiresAt must be in the future' });

  // Discount lives on the coupon (one-off payment ⇒ duration 'once').
  const coupon = await stripe.coupons.create(
    hasPct
      ? { percent_off: percentOff as number, duration: 'once', name: `Snapdini ${code}` }
      : { amount_off: amountOff as number, currency: CURRENCY, duration: 'once', name: `Snapdini ${code}` },
  );
  const promo = await stripe.promotionCodes.create({
    promotion: { type: 'coupon', coupon: coupon.id },
    code,
    ...(maxRedemptions != null ? { max_redemptions: maxRedemptions } : {}),
    ...(expiresAt != null ? { expires_at: Math.floor(expiresAt / 1000) } : {}),
  });
  res.json({ id: promo.id, code: promo.code });
});

// Deactivate a promo code (Stripe codes can't be deleted, only deactivated).
router.post('/promos/:id/deactivate', async (req: Request, res: Response) => {
  if (!billingEnabled || !stripe) return res.status(400).json({ error: 'Billing is not enabled' });
  await stripe.promotionCodes.update(String(req.params.id), { active: false });
  res.json({ ok: true });
});

// ── Revenue & spend history ───────────────────────────────────────────────────
// All money is events.amount_paid_cents (cumulative real $ per event, incl. upgrades + the branding
// add-on). Time basis = the event's created_at (there's no separate per-payment timestamp). Read-only.
router.get('/revenue', async (_req: Request, res: Response) => {
  if (!billingEnabled) return res.json({ billingEnabled: false, currency: CURRENCY, totals: { all: 0, d30: 0, d7: 0 }, users: [] });
  const now = Date.now();
  const d30 = now - 30 * 24 * 3600 * 1000;
  const d7 = now - 7 * 24 * 3600 * 1000;

  const totals = await get<{ all_cents: number; d30_cents: number; d7_cents: number }>(
    `SELECT COALESCE(SUM(amount_paid_cents),0) AS all_cents,
            COALESCE(SUM(CASE WHEN created_at >= ? THEN amount_paid_cents ELSE 0 END),0) AS d30_cents,
            COALESCE(SUM(CASE WHEN created_at >= ? THEN amount_paid_cents ELSE 0 END),0) AS d7_cents
       FROM events WHERE amount_paid_cents > 0`, [d30, d7]);

  const rows = await all<{ eventid: string; name: string; cents: number; createdat: number; branding: boolean; userid: string | null; email: string | null; displayname: string | null }>(
    `SELECT e.id AS eventId, e.name AS name, e.amount_paid_cents AS cents, e.created_at AS createdAt,
            e.branding_removal_paid AS branding, u.id AS userId, u.email AS email, u.display_name AS displayName
       FROM events e LEFT JOIN users u ON u.id = e.owner_user_id
      WHERE e.amount_paid_cents > 0
      ORDER BY e.created_at DESC`);

  // Group per owner (null owner → "(no account)").
  const map = new Map<string, { userId: string | null; email: string; displayName: string | null; totalCents: number; events: { id: string; name: string; cents: number; createdAt: number; branding: boolean }[] }>();
  for (const r of rows) {
    const key = r.userid || '(none)';
    let g = map.get(key);
    if (!g) { g = { userId: r.userid, email: r.email || '(no account)', displayName: r.displayname, totalCents: 0, events: [] }; map.set(key, g); }
    g.totalCents += r.cents;
    g.events.push({ id: r.eventid, name: r.name, cents: r.cents, createdAt: r.createdat, branding: !!r.branding });
  }
  const users = [...map.values()].sort((a, b) => b.totalCents - a.totalCents);

  res.json({
    billingEnabled: true,
    currency: CURRENCY,
    totals: { all: totals?.all_cents || 0, d30: totals?.d30_cents || 0, d7: totals?.d7_cents || 0 },
    users,
  });
});

export default router;
