import { Router, type Request, type Response } from 'express';
import { requireAdmin } from '../auth';
import { get, all, run } from '../db';
import { billingEnabled, stripe, CURRENCY } from '../billing';
import { sweep } from '../cleanup';

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
       (SELECT count(*) FROM events)                         AS events,
       (SELECT count(*) FROM events WHERE paid)              AS paid_events,
       (SELECT count(*) FROM events WHERE expires_at > ?)    AS active_events,
       (SELECT count(*) FROM participants)                   AS participants,
       (SELECT count(*) FROM photos)                         AS photos`,
    [now],
  );
  res.json({ stats, now });
});

// Recent events (newest first).
router.get('/events', async (_req: Request, res: Response) => {
  // Counts come from pre-aggregated subqueries joined on event_id (one grouped index scan each)
  // rather than a correlated count per row.
  const events = await all(
    `SELECT e.join_code, e.slug, e.name, e.guest_cap, e.video_seconds, e.paid,
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
    `SELECT id, name, email, message, emailed, handled, created_at
       FROM contact_messages ORDER BY handled ASC, created_at DESC LIMIT 200`);
  const unhandled = await get<{ n: number }>(`SELECT count(*) AS n FROM contact_messages WHERE NOT handled`);
  res.json({ messages, unhandled: Number(unhandled?.n ?? 0) });
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

export default router;
