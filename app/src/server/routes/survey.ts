import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { events, users, surveyResponses } from '../schema';
import { isUnhappy, notifyUnhappySurvey } from '../ops-notify';

// Post-event feedback survey. Token-gated (no login): the unguessable events.survey_token identifies
// the event — and therefore the customer — so responses are always attributable, and the page can be
// personalised (their name, their event, what it did/didn't include).
const router = Router();

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const clampInt = (v: unknown, lo: number, hi: number): number | null => {
  const n = parseInt(String(v), 10);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};
const firstName = (s?: string | null) => (s || '').trim().split(/\s+/)[0] || '';

// GET /api/survey/:token — personalisation context for the survey page (no answers).
router.get('/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token || '');
  if (!TOKEN_RE.test(token)) return res.status(404).json({ error: 'Survey not found' });

  const [row] = await db
    .select({
      id: events.id, name: events.name, expiresAt: events.expiresAt,
      videoSeconds: events.videoSeconds, revealMode: events.revealMode,
      guestCap: events.guestCap, aspectRatios: events.aspectRatios,
      ownerName: users.displayName, ownerEmail: users.email,
    })
    .from(events).leftJoin(users, eq(users.id, events.ownerUserId))
    .where(eq(events.surveyToken, token));

  if (!row) return res.status(404).json({ error: 'Survey not found' });

  let framesAll = false;
  try { framesAll = (JSON.parse(row.aspectRatios || '["1:1"]') as string[]).some((a) => a && a !== '1:1'); } catch { /* */ }
  const [existing] = await db.select({ id: surveyResponses.id }).from(surveyResponses).where(eq(surveyResponses.eventId, row.id)).limit(1);

  res.json({
    eventName: row.name,
    ownerName: firstName(row.ownerName),   // '' when no name → page greets "Hi there" (never the email prefix)
    hadVideo: row.videoSeconds > 0,
    revealMode: row.revealMode,
    largeEvent: row.guestCap >= 60,
    framesAll,
    ended: Date.now() >= row.expiresAt,
    alreadySubmitted: !!existing,
  });
});

// POST /api/survey/:token — store a response. Scores are optional/clamped; comments is a small JSON map.
router.post('/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token || '');
  if (!TOKEN_RE.test(token)) return res.status(404).json({ error: 'Survey not found' });

  const [ev] = await db.select({ id: events.id, name: events.name, joinCode: events.joinCode }).from(events).where(eq(events.surveyToken, token));
  if (!ev) return res.status(404).json({ error: 'Survey not found' });

  const b = req.body || {};
  // comments: an object of { key: "text" }; keep it small and stringify for storage.
  let comments: string | null = null;
  if (b.comments && typeof b.comments === 'object') {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.comments)) {
      if (typeof v === 'string' && v.trim()) clean[String(k).slice(0, 40)] = v.trim().slice(0, 2000);
    }
    if (Object.keys(clean).length) comments = JSON.stringify(clean);
  }

  const overall = clampInt(b.overall, 1, 5);
  const setup = clampInt(b.setup, 1, 5);
  const guestExperience = clampInt(b.guestExperience, 1, 5);
  const value = clampInt(b.value, 1, 5);
  const nps = clampInt(b.nps, 0, 10);

  // Require at least one signal so we don't store empty rows.
  if (overall === null && setup === null && guestExperience === null && value === null && nps === null && !comments) {
    return res.status(400).json({ error: 'Please answer at least one question' });
  }

  const contactOptIn = b.contactOptIn === true || b.contactOptIn === 'true';
  // Publish consent is only honoured alongside a genuinely positive score. Two reasons: we should
  // never quote an unhappy customer, and it stops a mis-set flag turning lukewarm feedback into
  // marketing copy. The client only shows the ask when the score is high; this enforces it.
  const positive = (overall ?? 0) >= 4 || (nps ?? -1) >= 8;
  const testimonialOk = positive && (b.testimonialOk === true || b.testimonialOk === 'true');
  const testimonialName = testimonialOk
    ? (String(b.testimonialName || '').trim().slice(0, 80) || null)
    : null;
  await db.insert(surveyResponses).values({
    id: uuidv4(), eventId: ev.id, overall, setup, guestExperience, value, nps, comments,
    contactOptIn, testimonialOk, testimonialName, createdAt: Date.now(),
  });

  // Instant operator alert on a low score (best-effort; never blocks the response).
  if (isUnhappy(overall, nps)) {
    notifyUnhappySurvey({ name: ev.name, joinCode: ev.joinCode }, { overall, setup, guestExperience, value, nps, comments, contactOptIn })
      .catch((e) => console.error('[ops] unhappy-survey alert:', (e as Error).message));
  }

  res.json({ ok: true });
});

export default router;
