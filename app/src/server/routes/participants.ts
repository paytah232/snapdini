import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { eq, or, and, count, sql } from 'drizzle-orm';
import { db } from '../db';
import { events, participants, photos } from '../schema';
import * as email from '../email';
import { baseUrl, escapeHtml } from '../lib';
import { billingEnabled } from '../billing';

const router = Router();

const isEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// ── POST /api/participants — join an event ─────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  const { joinCode, name, email: participantEmail } = req.body;
  if (!joinCode || !name) return res.status(400).json({ error: 'joinCode and name are required' });

  const cleanEmail = participantEmail ? participantEmail.trim().slice(0, 200) : null;
  if (cleanEmail && !isEmail(cleanEmail))
    return res.status(400).json({ error: 'Enter a valid email address (or leave it blank)' });

  const [event] = await db.select().from(events).where(
    or(eq(events.joinCode, joinCode.toUpperCase().trim()), eq(events.slug, joinCode.toLowerCase().trim())),
  );
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const now = Date.now();
  if (event.startsAt && now < event.startsAt)
    return res.status(403).json({ error: "Event hasn't started yet", startsAt: event.startsAt });
  if (event.isLocked)
    return res.status(403).json({ error: 'This event is locked' });
  if (now > event.expiresAt)
    return res.status(410).json({ error: 'This event has ended' });

  const newToken = () => uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');

  // Recovery: if this email already joined this event (e.g. they got logged out, or are on a new
  // device), reuse that participant — issue a fresh session and keep their remaining shot count.
  // Done before the cap check so a returning guest is never turned away as "full".
  if (cleanEmail) {
    const [existing] = await db.select().from(participants)
      .where(and(eq(participants.eventId, event.id), eq(participants.email, cleanEmail)));
    if (existing) {
      const sessionToken = newToken();
      const newName = name.trim().slice(0, 40) || existing.name;
      await db.update(participants).set({ sessionToken, name: newName }).where(eq(participants.id, existing.id));
      return res.json({
        participant:     { id: existing.id, name: newName, photosTaken: existing.photosTaken },
        sessionToken,
        joinCode:        event.joinCode,
        photosRemaining: Math.max(0, event.maxPhotos - existing.photosTaken),
        eventName:       event.name,
        noFlash:         !!event.noFlash,
        recovered:       true,
      });
    }
  }

  // Billing entitlement (only enforced when billing is enabled; self-host has no caps).
  if (billingEnabled) {
    if (!event.paid)
      return res.status(402).json({ error: "This event isn't active yet — the organizer needs to finish setting it up." });
    const [{ c: joined }] = await db.select({ c: count() }).from(participants).where(eq(participants.eventId, event.id));
    if (Number(joined) >= event.guestCap)
      return res.status(403).json({ error: `This event is full (max ${event.guestCap} guests).` });
  }

  const sessionToken = newToken();

  const participant = {
    id:            uuidv4(),
    eventId:       event.id,
    name:          name.trim().slice(0, 40),
    email:         cleanEmail,
    sessionToken:  sessionToken,
    photosTaken:   0,
    joinedAt:      now,
  };

  await db.insert(participants).values(participant);

  res.json({
    participant:     { id: participant.id, name: participant.name, photosTaken: 0 },
    sessionToken,
    joinCode:        event.joinCode,
    photosRemaining: event.maxPhotos,
    eventName:       event.name,
    noFlash:         !!event.noFlash,
  });
});

// ── GET /api/participants/me ───────────────────────────────────────────────────

router.get('/me', async (req: Request, res: Response) => {
  const sessionToken = req.get('x-session-token') || req.query.sessionToken;
  if (!sessionToken) return res.status(400).json({ error: 'sessionToken required' });

  const [p] = await db
    .select({
      id:             participants.id,
      name:           participants.name,
      email:          participants.email,
      photosTaken:    participants.photosTaken,
      maxPhotos:      events.maxPhotos,
      eventName:      events.name,
      joinCode:       events.joinCode,
      slug:           events.slug,
      startsAt:       events.startsAt,
      expiresAt:      events.expiresAt,
      isLocked:       events.isLocked,
      revealMode:     events.revealMode,
      revealedAt:     events.revealedAt,
      allowDownloads: events.allowDownloads,
      noFlash:        events.noFlash,
    })
    .from(participants)
    .innerJoin(events, eq(events.id, participants.eventId))
    .where(eq(participants.sessionToken, String(sessionToken)));

  if (!p) return res.status(404).json({ error: 'Session not found' });

  res.json({
    participant:     { id: p.id, name: p.name, photosTaken: p.photosTaken, email: p.email },
    photosRemaining: Math.max(0, p.maxPhotos - p.photosTaken),
    eventName:       p.eventName,
    joinCode:        p.joinCode,
    slug:            p.slug || null,
    startsAt:        p.startsAt,
    expiresAt:       p.expiresAt,
    isLocked:        !!p.isLocked,
    maxPhotos:       p.maxPhotos,
    allowDownloads:  !!p.allowDownloads,
    noFlash:         !!p.noFlash,
  });
});

// ── POST /api/participants/email-my-photos ────────────────────────────────────

router.post('/email-my-photos', async (req: Request, res: Response) => {
  const { sessionToken, emailOverride } = req.body;
  if (!sessionToken) return res.status(400).json({ error: 'sessionToken required' });
  if (!email.enabled) return res.status(503).json({ error: 'Email not configured on this server' });

  const [p] = await db
    .select({
      id:        participants.id,
      name:      participants.name,
      email:     participants.email,
      eventName: events.name,
      joinCode:  events.joinCode,
      slug:      events.slug,
    })
    .from(participants)
    .innerJoin(events, eq(events.id, participants.eventId))
    .where(eq(participants.sessionToken, String(sessionToken)));
  if (!p) return res.status(404).json({ error: 'Session not found' });

  const toAddr = (emailOverride || p.email || '').trim();
  if (!toAddr) return res.status(400).json({ error: 'No email address — enter one first' });
  if (toAddr.length > 200 || !isEmail(toAddr))
    return res.status(400).json({ error: 'Enter a valid email address' });

  // If they provided a new address, save it
  if (emailOverride && emailOverride !== p.email) {
    await db.update(participants).set({ email: toAddr }).where(eq(participants.id, p.id));
  }

  const [{ c: photoCount }] = await db
    .select({ c: count() })
    .from(photos)
    .where(eq(photos.participantId, p.id));
  const galPath    = p.slug ? `/gallery/${p.slug}` : `/gallery/${p.joinCode}`;
  const galUrl     = baseUrl(req) + galPath;

  try {
    await email.sendMail({
      to:      toAddr,
      subject: `Your photos from ${p.eventName} 📷`,
      html: email.htmlEmail(`Your photos from ${p.eventName}`, `
        <p>Hi ${escapeHtml(p.name)},</p>
        <p>You took <strong>${photoCount} photo${photoCount !== 1 ? 's' : ''}</strong> at <strong>${escapeHtml(p.eventName)}</strong>.</p>
        <p style="margin:24px 0"><a href="${galUrl}" class="btn">View Gallery →</a></p>
        <p style="color:#888;font-size:0.85em">Your photos appear under your name <strong>${escapeHtml(p.name)}</strong> in the gallery.</p>
      `),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
