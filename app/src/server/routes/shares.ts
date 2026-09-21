import { Router, type Request, type Response } from 'express';
import { and, asc, count, desc, eq, inArray, ne, or } from 'drizzle-orm';
import { db } from '../db';
import { v4 as uuidv4 } from 'uuid';
import { clampComment, COMMENT_MAX_RAW } from '../../../../shared/comment';
import { events, photos, participants, shares, shareVisitors, photoHearts, photoComments, commentHearts } from '../schema';
import { thumbName } from '../images';
import { isRevealed } from '../lib';
import { scheduledRevealAt } from '../../../../shared/reveal';
import { challengeCaptions, perViewer, playFile, zipPhotosToResponse } from './photos';

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
  // ID FIRST, and deliberately not left to the planner. `or(id, slug)` with no ORDER BY returns
  // whichever row comes back first, and a share id is 32 lowercase hex — which survives slugify
  // unchanged, so one share could take another's token as its pretty name and the two would be
  // indistinguishable in this query. The claim check below refuses that at the point of setting it;
  // this makes the read deterministic regardless, the same way eventByIdentifier is.
  const rows = await db.select().from(shares)
    .where(or(eq(shares.id, tokenOrSlug), eq(shares.slug, tokenOrSlug))).limit(2);
  const share = rows.length < 2 ? rows[0] : (rows.find((r) => r.id === tokenOrSlug) ?? rows[0]);
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
      // Asked for because playFile() reads them — without these the crop ladder silently takes its
      // fallback on every row and a shaped clip plays uncropped.
      captureShape: photos.captureShape, captureOrientation: photos.captureOrientation,
      participantId: photos.participantId,
      participantName: participants.name,
    })
    .from(photos)
    .innerJoin(participants, eq(participants.id, photos.participantId))
    .where(where)
    // `photos.id` last: `taken_at` ties (a burst of shots) otherwise reorder a shared wall between
    // loads, and this is the copy of the gallery that leaves the event.
    .orderBy(desc(photos.takenAt), asc(photos.id)) : [];

  // Mission id → the host's wording, resolved once for the whole page. A shared gallery is the
  // copy that leaves the event, so it carries the captions too.
  const captions = challengeCaptions(event.challenges);

  // Count (always, even pre-reveal) so the wall can show "N photos so far".
  const [{ n: photoTotal }] = await db.select({ n: count() }).from(photos).where(where);

  // ── Link reactions ──
  // Counts ride with the grid rather than one request per tile: the share's photo set is already
  // bounded by `where`, so this is one grouped query for the whole wall.
  //
  // The totals are the PHOTO's totals — a heart left by a guest during the event counts here too.
  // A photo does not have one popularity inside the event and a different one outside it.
  const on = { hearts: !!r.share.heartsEnabled, comments: !!r.share.commentsEnabled };
  const me = (on.hearts || on.comments) ? await visitorFor(req, r.share.id) : null;
  if (on.hearts || on.comments) perViewer(res);   // `mine` and the visitor's name are per-viewer

  const heartRows = (on.hearts && revealed) ? await db
    .select({ photoId: photoHearts.photoId, n: count() })
    .from(photoHearts).innerJoin(photos, eq(photos.id, photoHearts.photoId))
    .where(where).groupBy(photoHearts.photoId) : [];
  const commentRows = (on.comments && revealed) ? await db
    .select({ photoId: photoComments.photoId, n: count() })
    .from(photoComments).innerJoin(photos, eq(photos.id, photoComments.photoId))
    .where(where).groupBy(photoComments.photoId) : [];
  // Only this visitor's own hearts — which tiles come back already filled in.
  const mine = (on.hearts && revealed && me) ? (await db
    .select({ photoId: photoHearts.photoId })
    .from(photoHearts).innerJoin(photos, eq(photos.id, photoHearts.photoId))
    .where(and(where, eq(photoHearts.visitorId, me.id)))).map((h) => h.photoId) : [];

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
    reactions: on,
    // Who the browser is on THIS link, echoed back so a returning visitor is greeted rather than
    // asked their name again. Null until they give one.
    visitor: me ? { name: me.name } : null,
    hearts: Object.fromEntries(heartRows.map((h) => [h.photoId, Number(h.n)])),
    comments: Object.fromEntries(commentRows.map((c) => [c.photoId, Number(c.n)])),
    myHearts: mine,
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
      // The transcoded, faststart H.264 copy — the same file the event gallery plays, resolved by
      // the same function. Without it a share played the ORIGINAL upload: a WebM original will not
      // play at all in Safari, and every original is the full-size file rather than the 1080p proxy.
      // A share is the copy that leaves the event; it should not be the one that plays worst.
      ...(playFile(p) ? { playUrl: `/uploads/${playFile(p)}` } : {}),
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
    // `id` is not decoration: zipPhotosToResponse re-resolves each filename from the database
    // just before it queues it, because a rotate landing mid-archive renames the file underneath a
    // download that is minutes long. The id is the only column in this select that cannot go stale.
    .select({ id: photos.id, filename: photos.filename, mediaType: photos.mediaType, captureShape: photos.captureShape,
              participantId: photos.participantId, participantName: participants.name })
    .from(photos)
    .innerJoin(participants, eq(participants.id, photos.participantId))
    .where(where)
    // Identical to the event zip in routes/photos.ts, and for the identical reason: this order
    // names the files. `participants.id` keeps each person's shots contiguous even when two guests
    // share a name; `photos.id` makes the order total so two downloads agree.
    .orderBy(asc(participants.name), asc(participants.id), asc(photos.takenAt), asc(photos.id));
  if (!rows.length) return res.status(404).json({ error: 'No photos to download' });

  await zipPhotosToResponse(res, event.name, rows);
});

// ══ Link reactions — hearts and comments for people who only have the link ═══════════════════════
//
// A link visitor is deliberately NOT a participant. Participants are the paid entitlement: they
// count against the guest cap, hold a roll, get a trick card and appear in the guest list. A
// gallery link forwarded to forty relatives must never eat that, so a visitor is its own small
// thing — a name and a token, nothing else.
//
// Both switches live on the SHARE rather than the event (see schema.ts): one event can have a
// family gallery that wants comments and a client gallery that must not. Both default off.

// The visitor behind `x-visitor-token`, or null. Scoped to the share: a token minted on one link is
// not an identity on another, even within the same event.
async function visitorFor(req: Request, shareId: string) {
  const token = String(req.get('x-visitor-token') || '');
  if (!token) return null;
  const [v] = await db.select().from(shareVisitors)
    .where(and(eq(shareVisitors.sessionToken, token), eq(shareVisitors.shareId, shareId)));
  return v ?? null;
}

type Share = NonNullable<Awaited<ReturnType<typeof resolveShare>>>;

// Everything that has to be true before a link visitor may write anything at all. Replies on the
// response itself and returns null, so each route reads as one `if (!r) return;`.
async function reactionGate(req: Request, res: Response, kind: 'hearts' | 'comments'): Promise<Share | null> {
  const r = await resolveShare(String(req.params.token));
  if (!r) { res.status(404).json({ error: 'This share link is invalid or has expired' }); return null; }
  if (!(kind === 'hearts' ? r.share.heartsEnabled : r.share.commentsEnabled)) {
    res.status(403).json({ error: `${kind === 'hearts' ? 'Hearts' : 'Comments'} are off for this link` });
    return null;
  }
  // Nothing to react to before the photos are out.
  if (!isRevealed(r.event)) { res.status(403).json({ error: 'Photos are not revealed yet' }); return null; }
  // The host's gates, honoured exactly as the guest side honours them in routes/photos.ts — and
  // ending is deliberately NOT one of them, for the same reason: the roll stops, looking does not,
  // and a shared gallery is read and talked about for weeks afterwards.
  if (r.event.isLocked) { res.status(423).json({ error: 'This event is locked' }); return null; }
  if (r.event.startsAt && Date.now() < r.event.startsAt) {
    res.status(403).json({ error: "This event hasn't started yet" }); return null;
  }
  return r;
}

// One photo, but only if the link actually exposes it — `r.where` is the same condition the grid is
// built from, so a hand-picked share can never be talked into hearting the photos it left out.
async function photoInShare(r: Share, id: string) {
  const [p] = await db.select({ id: photos.id }).from(photos).where(and(r.where, eq(photos.id, id)));
  return p ?? null;
}

// ── POST /api/shares/:token/visitor — "who's looking" ────────────────────────
//
// The name is OPTIONAL, and that distinction is the whole point of this endpoint.
//
// A heart needs a visitor but not a name: nothing anywhere shows who hearted a photo, so the only
// thing identity buys there is one-heart-per-person, and a token alone gives that. Asking somebody
// to introduce themselves before they can tap a heart is a toll gate on the smallest gesture in the
// product. A comment is the opposite — it puts words on someone's gallery under a name — so that
// path asks, and asks at the moment it is needed.
//
// So an anonymous visitor is a real visitor with an empty name. Posting a name later UPDATES that
// same row rather than minting a second one, which is what keeps the hearts you left before you
// said who you were.
router.post('/:token/visitor', async (req: Request, res: Response) => {
  const r = await resolveShare(String(req.params.token));
  if (!r) return res.status(404).json({ error: 'This share link is invalid or has expired' });
  if (!r.share.heartsEnabled && !r.share.commentsEnabled) {
    return res.status(403).json({ error: 'Reactions are off for this link' });
  }
  const name = String(req.body?.name ?? '').trim().slice(0, 40);

  perViewer(res);
  const existing = await visitorFor(req, r.share.id);
  if (existing) {
    // An empty name here means "just give me my token back" — never a rename to blank, which would
    // quietly strip the name off every comment they have already left.
    if (name && name !== existing.name) {
      await db.update(shareVisitors).set({ name }).where(eq(shareVisitors.id, existing.id));
    }
    return res.json({ token: existing.sessionToken, name: name || existing.name });
  }
  const token = uuidv4();
  await db.insert(shareVisitors)
    .values({ id: uuidv4(), shareId: r.share.id, name, sessionToken: token, createdAt: Date.now() });
  res.json({ token, name });
});

// ── POST /api/shares/:token/photos/:id/heart ─────────────────────────────────
//
// Takes an EXPLICIT `heart: true|false`, never a toggle — same reasoning as the guest endpoint: a
// request that times out and is retried would otherwise flip twice and land on the opposite of what
// the person asked for.
router.post('/:token/photos/:id/heart', async (req: Request, res: Response) => {
  const want = req.body?.heart;
  if (typeof want !== 'boolean') return res.status(400).json({ error: 'heart must be true or false' });

  const r = await reactionGate(req, res, 'hearts');
  if (!r) return;
  const me = await visitorFor(req, r.share.id);
  if (!me) return res.status(403).json({ error: 'Enter your name first' });

  const photo = await photoInShare(r, String(req.params.id));
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  perViewer(res);
  if (want) {
    // Leans on the PARTIAL unique index from 0061 (partial because Postgres treats NULLs as
    // distinct, so a plain composite over a nullable column would not deduplicate anything).
    await db.insert(photoHearts)
      .values({ id: uuidv4(), photoId: photo.id, eventId: r.event.id, visitorId: me.id, createdAt: Date.now() })
      .onConflictDoNothing();
  } else {
    await db.delete(photoHearts)
      .where(and(eq(photoHearts.photoId, photo.id), eq(photoHearts.visitorId, me.id)));
  }
  // Counted after the write so the client shows the real total rather than its optimistic guess.
  const [{ n }] = await db.select({ n: count() }).from(photoHearts).where(eq(photoHearts.photoId, photo.id));
  res.json({ hearted: want, hearts: Number(n) });
});

// ── GET /api/shares/:token/comments?ids=a,b — the threads on those photos ─────
//
// Scoped by ids for the same reason the guest endpoint is: a thread is only read when a photo is
// open, and a large event's every comment is not something to send on the off-chance.
router.get('/:token/comments', async (req: Request, res: Response) => {
  const r = await resolveShare(String(req.params.token));
  if (!r) return res.status(404).json({ error: 'This share link is invalid or has expired' });
  perViewer(res);                          // carries `canDelete`, which is per-viewer by definition
  if (!r.share.commentsEnabled || !isRevealed(r.event)) return res.json({ comments: {} });

  const idsParam = typeof req.query.ids === 'string' ? req.query.ids : '';
  const ids = idsParam ? idsParam.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 50) : [];
  if (!ids.length) return res.json({ comments: {} });

  const me = await visitorFor(req, r.share.id);
  const rows = await db
    .select({
      id: photoComments.id, photoId: photoComments.photoId, body: photoComments.body,
      createdAt: photoComments.createdAt, visitorId: photoComments.visitorId,
      author: participants.name, visitorName: shareVisitors.name,
    })
    .from(photoComments)
    .innerJoin(photos, eq(photos.id, photoComments.photoId))
    // LEFT joins, plural: a comment has exactly one author but two possible KINDS of author, and an
    // inner join on either would silently drop the other kind's messages.
    .leftJoin(participants, eq(participants.id, photoComments.participantId))
    .leftJoin(shareVisitors, eq(shareVisitors.id, photoComments.visitorId))
    .where(and(r.where, inArray(photoComments.photoId, ids)))
    .orderBy(asc(photoComments.createdAt), asc(photoComments.id));

  // One grouped query for every thread on the page, not one per comment.
  const cIds = rows.map((r) => r.id);
  const hearts = cIds.length ? await db
    .select({ commentId: commentHearts.commentId, n: count() })
    .from(commentHearts).where(inArray(commentHearts.commentId, cIds))
    .groupBy(commentHearts.commentId) : [];
  const heartBy = new Map(hearts.map((h) => [h.commentId, Number(h.n)]));
  const mineSet = (me && cIds.length) ? new Set((await db
    .select({ commentId: commentHearts.commentId }).from(commentHearts)
    .where(and(inArray(commentHearts.commentId, cIds), eq(commentHearts.visitorId, me.id))))
    .map((h) => h.commentId)) : new Set<string>();

  const comments: Record<string, unknown[]> = {};
  for (const row of rows) {
    (comments[row.photoId] ??= []).push({
      id: row.id, body: row.body, author: row.author || row.visitorName || 'Guest', createdAt: row.createdAt,
      // WHO this is, not just what they are called. `share_visitors.name` is forty characters of
      // anything, so without this a person holding a forwarded link can post under the bride's name
      // and the thread cannot tell the difference. The host's own moderation feed has carried this
      // since it was written; the public threads flattened both kinds into one `author` field.
      authorKind: row.author ? 'guest' : 'visitor',
      hearts: heartBy.get(row.id) ?? 0, hearted: mineSet.has(row.id),
      // A link visitor can take back their own words and nothing else. The host deletes from the
      // admin side, where they are actually authenticated.
      canDelete: !!me && row.visitorId === me.id,
    });
  }
  res.json({ comments });
});

// ── POST /api/shares/:token/photos/:id/comment ───────────────────────────────
router.post('/:token/photos/:id/comment', async (req: Request, res: Response) => {
  const raw = req.body?.body;
  if (typeof raw !== 'string') return res.status(400).json({ error: 'body required' });
  // Cut the oversized case before doing any work; clampComment does the real trim to COMMENT_MAX.
  const body = clampComment(raw.slice(0, COMMENT_MAX_RAW));
  if (!body) return res.status(400).json({ error: 'Write something first' });

  const r = await reactionGate(req, res, 'comments');
  if (!r) return;
  const me = await visitorFor(req, r.share.id);
  // A visitor with no name has only ever hearted. Words go under a name.
  if (!me || !me.name) return res.status(403).json({ error: 'Enter your name first' });

  const photo = await photoInShare(r, String(req.params.id));
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  perViewer(res);
  const [row] = await db.insert(photoComments)
    .values({ id: uuidv4(), photoId: photo.id, eventId: r.event.id,
              visitorId: me.id, body, createdAt: Date.now() })
    .returning({ id: photoComments.id, createdAt: photoComments.createdAt });
  res.json({ id: row.id, body, author: me.name, createdAt: row.createdAt, canDelete: true });
});

// ── POST /api/shares/:token/comments/:id/heart ───────────────────────────────
//
// Gated on the link's COMMENTS switch, not its hearts one: this is a reaction to a comment, and a
// link whose comments are off has nothing here to react to. Like a photo heart it needs a visitor
// but NOT a name — nothing shows who hearted what.
router.post('/:token/comments/:id/heart', async (req: Request, res: Response) => {
  const want = req.body?.heart;
  if (typeof want !== 'boolean') return res.status(400).json({ error: 'heart must be true or false' });

  const r = await reactionGate(req, res, 'comments');
  if (!r) return;
  const me = await visitorFor(req, r.share.id);
  if (!me) return res.status(403).json({ error: 'Reactions are off for this link' });

  const [row] = await db.select({ id: photoComments.id, photoId: photoComments.photoId })
    .from(photoComments).where(and(eq(photoComments.id, String(req.params.id)),
                                   eq(photoComments.eventId, r.event.id)));
  // The comment must be on a photo THIS link exposes — otherwise a hand-picked share would be a
  // way to reach the threads on the photos it deliberately left out.
  if (!row || !(await photoInShare(r, row.photoId))) {
    return res.status(404).json({ error: 'Comment not found' });
  }

  perViewer(res);
  if (want) {
    await db.insert(commentHearts)
      .values({ id: uuidv4(), commentId: row.id, eventId: r.event.id, visitorId: me.id, createdAt: Date.now() })
      .onConflictDoNothing();
  } else {
    await db.delete(commentHearts)
      .where(and(eq(commentHearts.commentId, row.id), eq(commentHearts.visitorId, me.id)));
  }
  const [{ n }] = await db.select({ n: count() }).from(commentHearts).where(eq(commentHearts.commentId, row.id));
  res.json({ hearted: want, hearts: Number(n) });
});

// ── DELETE /api/shares/:token/comments/:id — the writer takes it back ────────
//
// 404 for "not yours" as well as "not there": a distinct 403 would confirm a comment id exists.
router.delete('/:token/comments/:id', async (req: Request, res: Response) => {
  const r = await resolveShare(String(req.params.token));
  if (!r) return res.status(404).json({ error: 'This share link is invalid or has expired' });
  const me = await visitorFor(req, r.share.id);
  if (!me) return res.status(404).json({ error: 'Comment not found' });

  const [row] = await db.select({ id: photoComments.id, visitorId: photoComments.visitorId })
    .from(photoComments).where(eq(photoComments.id, String(req.params.id)));
  if (!row || row.visitorId !== me.id) return res.status(404).json({ error: 'Comment not found' });

  await db.delete(photoComments).where(eq(photoComments.id, row.id));
  res.json({ success: true });
});

export default router;
