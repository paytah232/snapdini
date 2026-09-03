// Referral capture + gallery engagement. All endpoints are public and deliberately cheap: they are
// called from a guest's browser, must never block rendering, and must never leak event data.
import { Router, type Request, type Response } from 'express';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { db } from '../db';
import { events, photos } from '../schema';
import { captureReferral } from '../referrals';

const router = Router();

// ── POST /api/track/ref  { ref } ──────────────────────────────────────────────
// Sets the attribution cookie for a guest arriving from someone's gallery, and counts the click on
// the SOURCE event. Always 200 — an unknown code is ignored, never surfaced, so this cannot be used
// to probe which join codes exist.
router.post('/ref', async (req: Request, res: Response) => {
  const ref = String((req.body as { ref?: string })?.ref || '');
  try { await captureReferral(req, res, ref); } catch { /* attribution is best-effort */ }
  res.json({ ok: true });
});

// ── POST /api/track/gallery/:joinCode ─────────────────────────────────────────
// One gallery view. Counted per page load, not per photo render.
router.post('/gallery/:joinCode', async (req: Request, res: Response) => {
  const code = String(req.params.joinCode || '').toUpperCase().slice(0, 40);
  try {
    await db.update(events)
      .set({ galleryViews: sql`${events.galleryViews} + 1` })
      .where(eq(events.joinCode, code));
  } catch { /* never fail a page view over a counter */ }
  res.json({ ok: true });
});

// ── POST /api/track/photos  { ids: string[], kind: 'view' | 'download' } ──────
// Batched so a gallery scroll is one request, not one per thumbnail. Ids are scoped to a single
// event so a caller cannot bump counters across the whole instance.
router.post('/photos', async (req: Request, res: Response) => {
  const body = (req.body || {}) as { ids?: unknown; kind?: unknown; joinCode?: unknown };
  const kind = body.kind === 'download' ? 'download' : 'view';
  const code = String(body.joinCode || '').toUpperCase().slice(0, 40);
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((i): i is string => typeof i === 'string').slice(0, 200)
    : [];
  if (!ids.length || !code) return res.json({ ok: true, counted: 0 });

  try {
    const [ev] = await db.select({ id: events.id }).from(events).where(eq(events.joinCode, code));
    if (!ev) return res.json({ ok: true, counted: 0 });
    const col = kind === 'download' ? photos.downloadCount : photos.viewCount;
    const result = await db.update(photos)
      .set(kind === 'download'
        ? { downloadCount: sql`${photos.downloadCount} + 1` }
        : { viewCount: sql`${photos.viewCount} + 1` })
      .where(and(eq(photos.eventId, ev.id), inArray(photos.id, ids)));
    void col; void result;
    return res.json({ ok: true, counted: ids.length });
  } catch {
    return res.json({ ok: true, counted: 0 });
  }
});

export default router;
