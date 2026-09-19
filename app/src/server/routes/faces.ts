// Guest-facing face matching: enrol with a selfie, then "the photos I'm in".
//
// Two gates, both required, both server-enforced: the HOST must switch the feature on for the event,
// and the GUEST must explicitly consent. Neither implies the other. A guest can withdraw at any
// time, which deletes their template and every link derived from it.
import { Router, type Request, type Response } from 'express';
import { and, count, eq, inArray } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { db } from '../db';
import { events, participants, photoFaces, photos } from '../schema';
import { detectFaces, embedSelfie, faceMatchingAvailable, matchAgainstEnrolled, MATCH_THRESHOLD, similarity } from '../faces';

const router = Router();
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
// The selfie never lands in the gallery, so it goes to a temp path and is unlinked in a finally.
const selfieUpload = multer({ dest: '/tmp', limits: { fileSize: 12 * 1024 * 1024 } });

const thumbFor = (filename: string) => path.join(UPLOADS_DIR, filename.replace(/\.[^.]+$/, '_thumb.webp'));

/** How alike two selfie embeddings have to be before we call them the same photo of the same face.
 *
 *  Far above MATCH_THRESHOLD (0.42, "this is probably the same person in a crowd") because it is
 *  answering a much narrower question: did this guest just send us the selfie they already sent?
 *  Embeddings are unit vectors, so this is a cosine — a re-upload of the same shot sits at ~1.0 and
 *  even a second selfie taken moments later usually does not reach 0.98. Setting it too HIGH only
 *  costs a redundant backfill; setting it too low would skip a genuine re-enrolment. */
const SAME_SELFIE = Number(process.env.FACE_REENROL_SAME_THRESHOLD || 0.98);

async function guestFor(sessionToken: string) {
  const [row] = await db.select({
      id: participants.id, eventId: participants.eventId,
      faceConsentAt: participants.faceConsentAt,
      // The stored template, so enrol can tell a repeat submission from a new face before it spends
      // an ML call per photo in the event on it.
      faceEmbedding: participants.faceEmbedding,
      enabled: events.faceMatchingEnabled,
    }).from(participants).innerJoin(events, eq(events.id, participants.eventId))
    .where(eq(participants.sessionToken, sessionToken));
  return row;
}

/** The stored template, or null when there isn't one / the column cannot be read as one. A corrupt
 *  value must not fail the enrolment — the worst it should cost is the backfill running again. */
function storedEmbedding(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) && v.every((n) => typeof n === 'number') ? (v as number[]) : null;
  } catch { return null; }
}

// ── POST /api/faces/enrol — a guest opts in and supplies a selfie ─────────────────────────────
router.post('/enrol', selfieUpload.single('selfie'), async (req: Request, res: Response) => {
  const cleanup = () => { if (req.file) { try { fs.unlinkSync(req.file.path); } catch { /* */ } } };
  try {
    if (!faceMatchingAvailable()) return res.status(503).json({ error: 'Face matching is not enabled on this server' });
    const sessionToken = String(req.body?.sessionToken || '');
    if (!sessionToken) return res.status(400).json({ error: 'sessionToken required' });
    // Consent must be explicit and current. No default, no inference from having uploaded a selfie.
    if (req.body?.consent !== 'true' && req.body?.consent !== true) {
      return res.status(400).json({ error: 'Consent is required to use face matching' });
    }
    if (!req.file) return res.status(400).json({ error: 'A selfie is required' });

    const me = await guestFor(sessionToken);
    if (!me) return res.status(403).json({ error: 'Invalid session' });
    if (!me.enabled) return res.status(403).json({ error: 'The host has not enabled face matching for this event' });

    const embedding = await embedSelfie(req.file.path);
    if (!embedding) return res.status(422).json({ error: "We couldn't find a face in that photo — try a clearer one" });

    // Already enrolled, with this same selfie? Stop before the backfill.
    //
    // The loop below is the expensive half — one detectFaces call per photo in the event, in
    // sequence — and on an unchanged selfie it cannot produce a different answer: the links the
    // first enrolment wrote are still there, and every photo uploaded since was matched on arrival
    // (matchNewPhoto). So a guest who taps the button twice, or reopens the camera on a second
    // device and is offered the control again, used to re-scan the whole gallery for nothing. That
    // is also the shape of the abuse: re-posting one selfie is how you turn a single request into
    // hundreds of ML round trips.
    const prior = storedEmbedding(me.faceEmbedding);
    if (me.faceConsentAt && prior && similarity(embedding, prior) >= SAME_SELFIE) {
      const [tally] = await db.select({ n: count() }).from(photoFaces)
        .where(eq(photoFaces.participantId, me.id));
      // `scanned: 0` is the honest answer — nothing was looked at — and the client only ever shows
      // `matched`, which is still the true number of photos this guest is linked to.
      return res.json({ success: true, matched: Number(tally?.n ?? 0), scanned: 0, unchanged: true });
    }

    await db.update(participants)
      .set({ faceEmbedding: JSON.stringify(embedding), faceConsentAt: Date.now() })
      .where(eq(participants.id, me.id));

    // Backfill against photos already in this event. Their face vectors exist only inside this
    // loop; only the resulting links are written.
    const existing = await db.select({ id: photos.id, filename: photos.filename })
      .from(photos).where(eq(photos.eventId, me.eventId));
    let matched = 0;
    for (const ph of existing) {
      const faces = await detectFaces(thumbFor(ph.filename));
      let best = -1;
      for (const f of faces) { const s = similarity(embedding, f.embedding); if (s > best) best = s; }
      if (best >= MATCH_THRESHOLD) {
        await db.insert(photoFaces)
          .values({ photoId: ph.id, participantId: me.id, score: best, createdAt: Date.now() })
          .onConflictDoNothing();
        matched++;
      }
    }
    res.json({ success: true, matched, scanned: existing.length });
  } catch (e) {
    // The caller here holds nothing but a guest session token, and the messages that reach this
    // point are internal: the ML service's URL and HTTP status, a sharp decode failure, a Postgres
    // constraint name. Log the real one, answer with the fixed string every other catch in the
    // codebase answers with.
    console.error('[faces] enrol failed:', (e as Error).message);
    res.status(500).json({ error: 'Something went wrong' });
  } finally {
    cleanup();   // the selfie and its template never outlive the request
  }
});

// ── GET /api/faces/mine — the photos this guest appears in ────────────────────────────────────
router.get('/mine', async (req: Request, res: Response) => {
  if (!faceMatchingAvailable()) return res.status(503).json({ error: 'Face matching is not enabled on this server' });
  // Header (or body) only — never the query string. nginx logs "$request", so a token in a
  // URL is written into the access log, the browser history and every proxy between. The zip
  // route is the ONE justified exception and says so: it is reached by navigating, and a
  // navigation cannot carry a header. Everything here is a fetch.
  const sessionToken = String(req.header('X-Session-Token') || '');
  if (!sessionToken) return res.status(400).json({ error: 'sessionToken required' });
  const me = await guestFor(sessionToken);
  if (!me) return res.status(403).json({ error: 'Invalid session' });
  if (!me.faceConsentAt) return res.json({ enrolled: false, photoIds: [] });
  const rows = await db.select({ photoId: photoFaces.photoId })
    .from(photoFaces).where(eq(photoFaces.participantId, me.id));
  res.json({ enrolled: true, photoIds: rows.map((r) => r.photoId) });
});

// ── DELETE /api/faces/enrol — withdraw ─
// Deliberately NOT gated on faceMatchingAvailable(): if the operator switches the ML server off
// after guests enrolled, withdrawal must still work on whatever templates are already stored.───────────────────────────────────────────────────────
// Deletes the template AND every link derived from it. Withdrawal has to actually undo the thing,
// or consent was never meaningful.
router.delete('/enrol', async (req: Request, res: Response) => {
  // Header (or body) only — never the query string. nginx logs "$request", so a token in a
  // URL is written into the access log, the browser history and every proxy between. The zip
  // route is the ONE justified exception and says so: it is reached by navigating, and a
  // navigation cannot carry a header. Everything here is a fetch.
  const sessionToken = String(req.body?.sessionToken || '');
  if (!sessionToken) return res.status(400).json({ error: 'sessionToken required' });
  const me = await guestFor(sessionToken);
  if (!me) return res.status(403).json({ error: 'Invalid session' });
  await db.delete(photoFaces).where(eq(photoFaces.participantId, me.id));
  await db.update(participants).set({ faceEmbedding: null, faceConsentAt: null }).where(eq(participants.id, me.id));
  res.json({ success: true });
});

export default router;

// Called after a photo's thumbnail exists. Non-enrolled faces are embedded, compared and dropped
// inside this call; only links are written. Never allowed to break an upload.
export async function matchNewPhoto(eventId: string, photoId: string, filename: string): Promise<void> {
  try {
    if (!faceMatchingAvailable()) return;
    const [ev] = await db.select({ enabled: events.faceMatchingEnabled }).from(events).where(eq(events.id, eventId));
    if (!ev?.enabled) return;
    const enrolledRows = await db.select({ id: participants.id, emb: participants.faceEmbedding })
      .from(participants).where(eq(participants.eventId, eventId));
    const enrolled = enrolledRows
      .filter((r) => !!r.emb)
      .map((r) => ({ participantId: r.id, embedding: JSON.parse(r.emb as string) as number[] }));
    if (!enrolled.length) return;
    const hits = await matchAgainstEnrolled(thumbFor(filename), enrolled);
    for (const h of hits) {
      await db.insert(photoFaces)
        .values({ photoId, participantId: h.participantId, score: h.score, createdAt: Date.now() })
        .onConflictDoNothing();
    }
  } catch (e) {
    console.warn('[faces] match on upload failed:', (e as Error).message);
  }
}
void and; void inArray;
