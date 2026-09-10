import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { eq, or, and, count, sql } from 'drizzle-orm';
import { db } from '../db';
import { effectiveMaxPhotos, photosRemaining as remainingFor } from '../allowance';
import { events, guestFeedback, participants, photos } from '../schema';
import { faceMatchingAvailable } from '../faces';
import * as email from '../email';
import { baseUrl, escapeHtml } from '../lib';
import { billingEnabled } from '../billing';

const router = Router();

const isEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// 23505 = unique_violation. The only unique constraint a guest can trip is
// (event_id, lower(email)) — one address per event, so an email can never point at two rolls (see
// 0031_guest_upgrades.sql). Two people sharing an inbox is entirely normal, so hitting it is not a
// server fault and must never surface as "Something went wrong". Drizzle wraps the driver error, so
// check both levels.
const isDuplicate = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
};

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
  //
  // Keyed on the EMAIL ALONE, deliberately — not email + name. An address identifies one roll for
  // the event, which is what makes recovery work at all when someone returns on a new device and
  // types their name slightly differently.
  //
  // The known consequence, accepted: two people sharing an inbox share a roll. The second to join
  // takes over the first one's participant — including the name on it, so earlier photos then show
  // under the new name, and the first person's session stops working. Matching on name as well
  // would avoid that, but it would break the common case it exists for, and the address could not
  // then be stored for the second person anyway (see the UNIQUE index below). If this is ever
  // revisited, specs/97-participant-email.mjs pins the current intent.
  if (cleanEmail) {
    // lower(), to match the UNIQUE INDEX exactly. It used to compare case-sensitively while the
    // constraint was on lower(email), so a returning guest whose phone had autocapitalised their
    // address missed recovery, fell through to the INSERT, and hit the index — HTTP 500, locked out
    // of the event. The guard and the constraint have to agree on what "the same address" means.
    const [existing] = await db.select().from(participants)
      .where(and(eq(participants.eventId, event.id),
                 sql`lower(${participants.email}) = lower(${cleanEmail})`));
    if (existing) {
      const sessionToken = newToken();
      const newName = name.trim().slice(0, 40) || existing.name;
      await db.update(participants).set({ sessionToken, name: newName }).where(eq(participants.id, existing.id));
      return res.json({
        participant:     { id: existing.id, name: newName, photosTaken: existing.photosTaken },
        sessionToken,
        joinCode:        event.joinCode,
        photosRemaining: remainingFor({ maxPhotos: event.maxPhotos, extraPhotos: existing.extraPhotos, photosTaken: existing.photosTaken }),
        canBuyShots: !!event.guestMayBuyShots,
        canAskHost: !!event.guestMayRequest,
        faceMatching: faceMatchingAvailable() && !!event.faceMatchingEnabled,
        faceEnrolled: !!(existing && existing.faceConsentAt),
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

  try {
    await db.insert(participants).values(participant);
  } catch (e) {
    if (!isDuplicate(e)) throw e;
    // Recovery above should have caught this, so we are in a race (two devices joining with the
    // same address at once) or a case the guard still cannot see. Either way, letting someone into
    // the event with their OWN roll matters more than storing their address, so drop the address
    // and keep going. They lose email-based recovery; they do not lose the event.
    console.warn(`[participants] ${event.joinCode}: address already used in this event — joining without it`);
    participant.email = null;
    await db.insert(participants).values(participant);
  }

  res.json({
    participant:     { id: participant.id, name: participant.name, photosTaken: 0 },
    sessionToken,
    joinCode:        event.joinCode,
    photosRemaining: remainingFor({ maxPhotos: event.maxPhotos, photosTaken: 0 }),
        canBuyShots: !!event.guestMayBuyShots,
        canAskHost: !!event.guestMayRequest,
        faceMatching: faceMatchingAvailable() && !!event.faceMatchingEnabled,
        faceEnrolled: false,
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
      extraPhotos:    participants.extraPhotos,
      guestMayBuyShots: events.guestMayBuyShots,
      guestMayRequest:  events.guestMayRequest,
      faceMatching:     events.faceMatchingEnabled,
      faceConsentAt:    participants.faceConsentAt,
      upgradeEmail:     participants.upgradeEmail,
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
      feedbackAskedAt: participants.feedbackAskedAt,
    })
    .from(participants)
    .innerJoin(events, eq(events.id, participants.eventId))
    .where(eq(participants.sessionToken, String(sessionToken)));

  if (!p) return res.status(404).json({ error: 'Session not found' });

  res.json({
    participant:     { id: p.id, name: p.name, photosTaken: p.photosTaken, email: p.email },
    photosRemaining: remainingFor(p),
    eventName:       p.eventName,
    joinCode:        p.joinCode,
    slug:            p.slug || null,
    startsAt:        p.startsAt,
    expiresAt:       p.expiresAt,
    isLocked:        !!p.isLocked,
    maxPhotos:       effectiveMaxPhotos(p),
      extraPhotos:     p.extraPhotos,
      canBuyShots:     !!p.guestMayBuyShots,
      canAskHost:      !!p.guestMayRequest,
      // ANDed with the server switch, never the host toggle alone: with no
      // MACHINE_LEARNING_URL a stale `true` in the events row would otherwise put the
      // whole face-matching UI in front of guests and 503 the moment they used it.
      faceMatching:    faceMatchingAvailable() && !!p.faceMatching,
      faceEnrolled:    !!p.faceConsentAt,
      // Asked once, on whichever surface they saw first. Both the camera and the shared gallery
      // offer the ask, and neither should re-ask someone who already answered on the other.
      feedbackGiven:   !!p.feedbackAskedAt,
      // True when the address we hold arrived with their payment rather than at join — the guest
      // never typed it here, so it is worth telling them which one their photos are tied to.
      emailFromPayment: !!p.upgradeEmail && (p.email || '').toLowerCase() === p.upgradeEmail.toLowerCase(),
    allowDownloads:  !!p.allowDownloads,
    noFlash:         !!p.noFlash,
  });
});

// ── POST /api/participants/email-my-photos ────────────────────────────────────

// ── POST /api/participants/feedback — how it was to be a guest ────────────────────────────────
// Asked once, answered or dismissed. A rating alone is fine; the comment is optional, because most
// people will not write one and demanding it just loses the rating too.
router.post('/feedback', async (req: Request, res: Response) => {
  const sessionToken = String(req.body?.sessionToken || '');
  if (!sessionToken) return res.status(400).json({ error: 'sessionToken required' });
  const [me] = await db.select({ id: participants.id, eventId: participants.eventId })
    .from(participants).where(eq(participants.sessionToken, sessionToken));
  if (!me) return res.status(403).json({ error: 'Invalid session' });

  // Mark as asked either way, so dismissing is respected and we never prompt twice.
  await db.update(participants).set({ feedbackAskedAt: Date.now() }).where(eq(participants.id, me.id));

  const dismissed = req.body?.dismissed === true || req.body?.dismissed === 'true';
  if (dismissed) return res.json({ success: true, recorded: false });

  const raw = Number(req.body?.rating);
  const rating = Number.isFinite(raw) && raw >= 1 && raw <= 5 ? Math.round(raw) : null;
  const comment = String(req.body?.comment || '').trim().slice(0, 2000) || null;
  if (rating === null && !comment) return res.status(400).json({ error: 'Give a rating or a comment' });

  await db.insert(guestFeedback)
    .values({ id: uuidv4(), eventId: me.eventId, participantId: me.id, rating, comment, createdAt: Date.now() })
    .onConflictDoNothing();   // one per guest; a double-submit is not two opinions
  res.json({ success: true, recorded: true });
});

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

  // If they provided a new address, save it — best effort, and case-insensitively compared so
  // retyping the same address differently is not a pointless write.
  //
  // Sending does not depend on storing: the email is built from THIS participant's row and links to
  // their own gallery. So an address already used by another guest at the event means "we cannot
  // attach it to your roll", not "you cannot have your photos" — which is what it used to mean,
  // because the failed UPDATE took the whole request down with it.
  if (emailOverride && emailOverride.toLowerCase() !== (p.email || '').toLowerCase()) {
    try {
      await db.update(participants).set({ email: toAddr }).where(eq(participants.id, p.id));
    } catch (e) {
      if (!isDuplicate(e)) throw e;
      console.warn(`[participants] ${p.id}: address in use by another guest — emailing photos anyway, not stored`);
    }
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
        <!-- Surface 2 of 3: a guest who asked for their photos has self-selected as engaged, which
             makes this the warmest referral moment we get. Leads with the free tier, not a discount:
             the barrier is not price, it is that a guest has no idea this is something they can run
             themselves — nothing in the guest flow ever told them. -->
        <hr style="border:none;border-top:1px solid #2a2418;margin:22px 0 16px" />
        <p style="font-size:0.9em;color:#b8ab8d">
          Hosting something yourself? Snapdini is <strong>free for up to 10 guests</strong> —
          <a href="${baseUrl(req)}/?ref=${encodeURIComponent(p.joinCode)}">start your own event</a>.
        </p>
      `),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
