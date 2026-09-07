// Referral capture + gallery engagement. All endpoints are public and deliberately cheap: they are
// called from a guest's browser, must never block rendering, and must never leak event data.
import { Router, type Request, type Response } from 'express';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { db } from '../db';
import { events, photos } from '../schema';
import { captureReferral } from '../referrals';
import { bumpPhotoViews, bumpPhotoDownloads, bumpGalleryView } from '../counters';
import { isEventName, cleanProps, cleanPath, visitKey, record } from '../analytics';

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
  // Respond first; the counter is coalesced in memory and flushed in batches (see counters.ts).
  res.json({ ok: true });
  try {
    const [ev] = await db.select({ id: events.id }).from(events).where(eq(events.joinCode, code));
    if (ev) bumpGalleryView(ev.id);
  } catch { /* never let a counter surface as an error */ }
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

  res.json({ ok: true, counted: ids.length });
  try {
    // Scope the ids to this event so a caller cannot bump counters across the instance, then hand
    // off. The scoping read is indexed and cheap; the writes are batched elsewhere.
    const owned = await db.select({ id: photos.id }).from(photos)
      .where(and(eq(photos.eventId, sql`(SELECT id FROM events WHERE join_code = ${code})`), inArray(photos.id, ids)));
    const ownedIds = owned.map((r) => r.id);
    if (ownedIds.length) (kind === 'download' ? bumpPhotoDownloads : bumpPhotoViews)(ownedIds);
  } catch { /* analytics only */ }
});

// ── POST /api/track/events  { events: [{ name, path?, props?, joinCode? }] } ──
// First-party product analytics. Batched from the browser so a page view is not its own request,
// and answered before anything is written — the buffer is flushed on an interval (analytics.ts).
//
// Hardened on the three things that matter for a public write endpoint: names come from a
// server-side allowlist, props are sanitised to a handful of short scalars, and the path is reduced
// to a route pattern so a full URL with a token in it can never be stored. Always 200: an analytics
// endpoint that reports validation failures is an analytics endpoint that leaks what is valid.
router.post('/events', async (req: Request, res: Response) => {
  res.json({ ok: true });
  try {
    const list = (req.body as { events?: unknown })?.events;
    if (!Array.isArray(list)) return;
    const visit = visitKey(req.ip, req.get('user-agent'));
    const now = Date.now();

    // Resolve join codes to event ids ONCE for the batch, rather than a query per row.
    const codes = [...new Set(list
      .map((e) => (e as { joinCode?: unknown })?.joinCode)
      .filter((c): c is string => typeof c === 'string' && !!c)
      .map((c) => c.toUpperCase().slice(0, 40)))].slice(0, 10);
    const idByCode = new Map<string, string>();
    if (codes.length) {
      const rows = await db.select({ id: events.id, joinCode: events.joinCode })
        .from(events).where(inArray(events.joinCode, codes));
      for (const r of rows) idByCode.set(r.joinCode, r.id);
    }

    for (const raw of list.slice(0, 50)) {          // one page cannot post a thousand events
      const e = (raw || {}) as { name?: unknown; path?: unknown; props?: unknown; joinCode?: unknown };
      if (!isEventName(e.name)) continue;           // allowlist, silently
      const code = typeof e.joinCode === 'string' ? e.joinCode.toUpperCase().slice(0, 40) : '';
      record({
        name: e.name,
        path: cleanPath(e.path),
        visit,
        eventId: idByCode.get(code) ?? null,
        props: cleanProps(e.props),
        createdAt: now,
      });
    }
  } catch { /* analytics must never surface as an error to a visitor */ }
});

export default router;
