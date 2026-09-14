import { Router, type Request, type Response } from 'express';
import { and, asc, count, desc, eq, inArray, ne, or } from 'drizzle-orm';
import { db } from '../db';
import { events, photos, participants, shares } from '../schema';
import { thumbName } from '../images';
import { isRevealed } from '../lib';
import { scheduledRevealAt } from '../../../../shared/reveal';
import { challengeCaptions, zipPhotosToResponse } from './photos';

const router = Router();

// The event's enabled frame shapes, stored as a JSON array in one TEXT column.
function parseAspects(raw: string | null): string[] {
  try {
    const a = JSON.parse(raw || '["1:1"]');
    return Array.isArray(a) && a.length ? a.map(String) : ['1:1'];
  } catch { return ['1:1']; }
}

// Resolve a share token OR pretty slug → its event + a ready-to-use photo WHERE condition (visible
// set, narrowed to the favourites or the hand-picked ids per the share's kind). Null → caller 404s.
async function resolveShare(tokenOrSlug: string) {
  const [share] = await db.select().from(shares).where(or(eq(shares.id, tokenOrSlug), eq(shares.slug, tokenOrSlug)));
  if (!share) return null;
  const [event] = await db.select().from(events).where(eq(events.id, share.eventId));
  if (!event || event.purgedAt) return null;
  const visible = event.moderationEnabled ? eq(photos.status, 'approved') : ne(photos.status, 'rejected');
  let ids: string[] | null = null;
  if (share.kind === 'selected') {
    try { const p = JSON.parse(share.photoIds || '[]'); ids = Array.isArray(p) ? p.map(String) : []; } catch { ids = []; }
  }
  const conds = [eq(photos.eventId, event.id), visible];
  if (ids) conds.push(inArray(photos.id, ids.length ? ids : ['']));
  if (share.kind === 'favourites') conds.push(eq(photos.isHighlighted, true));
  return { share, event, visible, ids, where: and(...conds) };
}

// ── GET /api/shares/:token — public view of a shared gallery (whole or hand-picked subset) ──
router.get('/:token', async (req: Request, res: Response) => {
  const r = await resolveShare(String(req.params.token));
  if (!r) return res.status(404).json({ error: 'This share link is invalid or has expired' });
  const { event, where } = r;

  // Respect the event's reveal timing — a share opened before the photos are revealed shows a
  // countdown, not the photos (just like the main gallery). We still report the count so far.
  const revealed = isRevealed(event);
  const rows = revealed ? await db
    .select({
      id: photos.id, filename: photos.filename, takenAt: photos.takenAt,
      mediaType: photos.mediaType, isHighlighted: photos.isHighlighted, challengeId: photos.challengeId,
      caption: photos.caption,
      sizeBytes: photos.sizeBytes, width: photos.width, height: photos.height, durationMs: photos.durationMs,
      participantName: participants.name,
    })
    .from(photos)
    .innerJoin(participants, eq(participants.id, photos.participantId))
    .where(where)
    .orderBy(desc(photos.takenAt)) : [];

  // Mission id → the host's wording, resolved once for the whole page. A shared gallery is the
  // copy that leaves the event, so it carries the captions too.
  const captions = challengeCaptions(event.challenges);

  // Count (always, even pre-reveal) so the wall can show "N photos so far".
  const [{ n: photoTotal }] = await db.select({ n: count() }).from(photos).where(where);

  res.json({
    event: {
      name: event.name,
      theme: event.theme ? JSON.parse(event.theme) : null,
      allowDownloads: !!event.allowDownloads,
      // The frame the event was shot in. The share grid draws every tile in ONE shape and takes it
      // from here, the same as the gallery does — without it a share had to assume square, which
      // is wrong for any event on the frame pack. Tolerant of a bad column: a share that cannot
      // parse its event's frames is still a share.
      aspectRatios: parseAspects(event.aspectRatios),
    },
    kind: r.share.kind,
    label: r.share.label || null,
    revealed,
    revealMode: event.revealMode,
    revealAt: scheduledRevealAt(event),   // for the public countdown; null unless it unlocks itself
    photoCount: Number(photoTotal),
    photos: rows.map((p) => ({
      id: p.id,
      url: `/uploads/${p.filename}`,
      thumbUrl: `/uploads/${thumbName(p.filename)}`,
      takenAt: p.takenAt,
      participantName: p.participantName,
      challenge: (p.challengeId && captions.get(p.challengeId)) || null,
      // A share is the copy that leaves the event, so the words under a photo travel with it —
      // alongside the mission, never instead of it.
      caption: p.caption ?? null,
      isHighlighted: !!p.isHighlighted,
      mediaType: p.mediaType || 'photo',
      sizeBytes: p.sizeBytes ?? undefined,
      width: p.width ?? undefined,
      height: p.height ?? undefined,
      durationMs: p.durationMs ?? undefined,
    })),
  });
});

// ── GET /api/shares/:token/download[?ids=…] — zip of the share's photos ──
// Gated by reveal + the event's allowDownloads. `ids` (if given) is intersected with the share's
// allowed set, so a recipient can never pull photos outside what was shared.
router.get('/:token/download', async (req: Request, res: Response) => {
  const r = await resolveShare(String(req.params.token));
  if (!r) return res.status(404).json({ error: 'This share link is invalid or has expired' });
  const { event, visible, ids: shareIds, share } = r;

  if (!isRevealed(event)) return res.status(403).json({ error: 'Photos are not revealed yet' });
  if (!event.allowDownloads) return res.status(403).json({ error: 'Downloads are disabled for this event' });

  const reqIds = (typeof req.query.ids === 'string' ? req.query.ids : '').split(',').map((s) => s.trim()).filter(Boolean);
  // Effective id filter: the share's own set, narrowed to the requested subset if one was given.
  let ids: string[] | null = shareIds;
  if (reqIds.length) ids = shareIds ? shareIds.filter((id) => reqIds.includes(id)) : reqIds;

  const conds = [eq(photos.eventId, event.id), visible];
  if (ids) conds.push(inArray(photos.id, ids.length ? ids : ['']));
  if (share.kind === 'favourites') conds.push(eq(photos.isHighlighted, true));
  const where = and(...conds);
  const rows = await db
    .select({ filename: photos.filename, mediaType: photos.mediaType, captureShape: photos.captureShape,
              participantId: photos.participantId, participantName: participants.name })
    .from(photos)
    .innerJoin(participants, eq(participants.id, photos.participantId))
    .where(where)
    .orderBy(asc(participants.name), asc(photos.takenAt));   // group by person, capture order
  if (!rows.length) return res.status(404).json({ error: 'No photos to download' });

  zipPhotosToResponse(res, event.name, rows);
});

export default router;
