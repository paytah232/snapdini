import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { eq, or, and, count, sql, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { effectiveMaxPhotos, photosRemaining as remainingFor } from '../allowance';
import { events, guestFeedback, participants, photos } from '../schema';
import { readSets, setByKey, assignSet, readTick } from '../challenges';
import { faceMatchingAvailable } from '../faces';
import { billingEnabled } from '../billing';

const router = Router();

// The missions on THIS guest's card, plus the ids they have already captured.
//
// A guest sees one set and only one. Several sets exist so a host can hand out different cards, and
// showing a guest somebody else's list would defeat that and let them tick off a mission they were
// never given.
//
// Progress is DERIVED from the photos table, never stored beside it: delete the photo and the
// mission un-ticks on its own, so there is no second copy of the truth to drift. A photo held back
// by moderation still counts, which is the kinder reading — the guest did the thing.
// Exported because DELETE /api/photos/:id has to answer with this too: deleting a trick shot
// un-ticks its mission, and the client cannot work out WHICH one — the gallery payload carries
// the mission's text, not its id.
export async function missionsFor(eventChallenges: string | null, setKey: string | null, participantId: string) {
  const set = setByKey(readSets(eventChallenges), setKey);
  if (!set) return { challenges: [], challengesDone: [] as string[], challengeSet: null as string | null, challengeTick: null as string | null };
  const rows = await db.selectDistinct({ id: photos.challengeId }).from(photos)
    .where(and(eq(photos.participantId, participantId), isNotNull(photos.challengeId)));
  // Progress is only ever counted against the card the guest is HOLDING. A host who edits the list
  // mid-event leaves behind ticks for tricks that are no longer on it, and those were still being
  // returned — a guest who had done one of three saw "1/6" after the list was replaced, where that
  // 1 was not any of the 6. The photo keeps its challenge_id either way, so nothing is destroyed:
  // restore the trick and it counts again.
  const offered = new Set(set.items.map((i) => i.id));
  return {
    challenges: set.items,
    challengesDone: rows.map((r) => r.id).filter((x): x is string => !!x && offered.has(x)),
    challengeSet: set.key,
    challengeTick: readTick(eventChallenges),
  };
}

/**
 * Whether a photo is one the guest will actually SEE in the gallery.
 *
 * The same rule routes/photos.ts renders by: with moderation on, only approved; with it off,
 * anything not binned. Stated once, as a predicate, because the count we email a guest and the set
 * we then show them disagreeing is not a cosmetic difference — it reads as photos we lost.
 */
export const guestSeesPhoto = (status: string, moderationEnabled: boolean): boolean =>
  moderationEnabled ? status === 'approved' : status !== 'rejected';

const isEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/**
 * Whatever a stranger posted, as a string.
 *
 * POST /api/participants is the first thing every guest in the product touches and it is
 * unauthenticated, so nothing in its body is a string until we make it one. It used to call
 * `.trim()` straight on the parsed JSON, which means `{"joinCode":{"a":1}}` and `{"name":123}` both
 * threw TypeError out of the handler and came back as HTTP 500 — a server fault reported for a
 * malformed request, on the most public endpoint we have, and one that an error-rate alert cannot
 * tell from a real outage. The sibling routes below (PUT /email, POST /wants-photos) already coerce
 * exactly like this; this is that same coercion, named once so it cannot drift.
 *
 * Exported so the regression test exercises THIS function rather than a copy of it.
 */
export const asText = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try {
    return String(v);
  } catch {
    // String() is not total, which is the trap this helper exists to close and would otherwise
    // reopen: `{"joinCode":{"toString":null}}` is valid JSON, and it leaves an object with no
    // callable toString and a valueOf that returns itself, so ToPrimitive throws TypeError — the
    // same 500, reached by a slightly stranger body. Unconvertible means "no value given": '' is
    // falsy, so the required-fields guard answers 400 exactly as it does for a missing field.
    return '';
  }
};

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
  const body = (req.body ?? {}) as { joinCode?: unknown; name?: unknown; email?: unknown };
  const joinCode = asText(body.joinCode);
  const name = asText(body.name);
  const participantEmail = asText(body.email);
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
        ...(await missionsFor(event.challenges, existing.challengeSet, existing.id)),
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

  // Which mission card this guest gets. A printed card may name its own set (?set=b on the QR);
  // otherwise round-robin by how many have already joined, so the sets stay evenly spread.
  const sets = readSets(event.challenges);
  let challengeSet: string | null = null;
  if (sets.length) {
    const [{ c: soFar }] = await db.select({ c: count() }).from(participants).where(eq(participants.eventId, event.id));
    challengeSet = assignSet(sets, req.body?.set ?? req.query?.set, Number(soFar) || 0);
  }

  const participant = {
    id:            uuidv4(),
    eventId:       event.id,
    name:          name.trim().slice(0, 40),
    email:         cleanEmail,
    sessionToken:  sessionToken,
    photosTaken:   0,
    joinedAt:      now,
    challengeSet,
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
    ...(await missionsFor(event.challenges, challengeSet, participant.id)),
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
      challengeSet:     participants.challengeSet,
      challenges:       events.challenges,
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
      wantsPhotos:      participants.wantsPhotos,
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
      ...(await missionsFor(p.challenges, p.challengeSet, p.id)),
      // Asked once, on whichever surface they saw first. Both the camera and the shared gallery
      // offer the ask, and neither should re-ask someone who already answered on the other.
      feedbackGiven:   !!p.feedbackAskedAt,
      // Whether this guest has asked us to send them the photos. THE consent gate for every guest
      // email (guest-delivery.ts) — the camera renders the control from this rather than from
      // local state, so a guest who opted in on another device sees it already on.
      wantsPhotos:     !!p.wantsPhotos,
      // True when the address we hold arrived with their payment rather than at join — the guest
      // never typed it here, so it is worth telling them which one their photos are tied to.
      emailFromPayment: !!p.upgradeEmail && (p.email || '').toLowerCase() === p.upgradeEmail.toLowerCase(),
    allowDownloads:  !!p.allowDownloads,
    noFlash:         !!p.noFlash,
  });
});

// ── POST /api/participants/feedback — how it was to be a guest ────────────────────────────────
// Asked once, answered or dismissed. A rating alone is fine; the comment is optional, because most
// people will not write one and demanding it just loses the rating too.
// ── PUT /api/participants/email — attach an email to a roll already in progress ───────────────
//
// A guest's roll lives in the session token in THIS browser's localStorage. Open the same event in
// a different browser and there is no session, so they join again — a second participant, a fresh
// roll, and their photos stranded on an identity they can no longer reach.
//
// That is not a hypothetical. An in-app browser (Facebook's is the one people meet) forgets camera
// permission between uses, so we tell guests to open the link in their real browser — and following
// that advice is exactly what splits them in two. Reproduced by the product owner: photo taken in
// the Facebook browser, opened in Chrome, arrived as a different person.
//
// An email is the one thing that survives the move, because the join route already recovers by it.
// So a guest who has started shooting can attach one, and the switch becomes a resume.
router.put('/email', async (req: Request, res: Response) => {
  const sessionToken = String((req.body as { sessionToken?: unknown })?.sessionToken || '');
  // Trimmed and capped the same way the join route does it — the UNIQUE index is on lower(email),
  // and the two have to agree about what "the same address" means or recovery misses.
  const raw = (req.body as { email?: unknown })?.email;
  const cleanEmail = typeof raw === 'string' ? raw.trim().slice(0, 200) : '';
  if (!sessionToken) return res.status(400).json({ error: 'sessionToken required' });
  if (!isEmail(cleanEmail)) return res.status(400).json({ error: 'Enter a valid email address' });

  const [p] = await db.select().from(participants).where(eq(participants.sessionToken, sessionToken));
  if (!p) return res.status(404).json({ error: 'Session not found' });

  // Already theirs — nothing to do, and saying so beats an error for a guest who tapped twice.
  if ((p.email || '').toLowerCase() === cleanEmail.toLowerCase()) return res.json({ ok: true, email: p.email });

  try {
    await db.update(participants).set({ email: cleanEmail }).where(eq(participants.id, p.id));
    res.json({ ok: true, email: cleanEmail });
  } catch (e) {
    // (event_id, lower(email)) is UNIQUE — one address per event, so somebody else here is already
    // using it. Their own roll is untouched; they just cannot claim this address.
    if (isDuplicate(e)) {
      return res.status(409).json({ error: 'Someone else at this event is already using that email address.' });
    }
    throw e;
  }
});

// ── POST /api/participants/wants-photos — "send me the photos" ────────────────
//
// The ONE thing that lets us email a guest. Nothing else in the system creates that permission:
// not the host's toggles, not having an address on file from a top-up payment, not having joined.
// A guest who has not been here has wants_photos false and receives nothing, which is also why no
// event that predates 0046 can mail anybody.
//
// The address is optional here because it is often already on the row — the join screen asks for
// it, and a guest who paid for more shots has one from the payment. Passing one sets it the same
// way PUT /email does, and hits the same wall: (event_id, lower(email)) is UNIQUE, so an address
// somebody else at this event is already using cannot be attached to this roll.
//
// On that collision we proceed for this guest, do NOT store the address, and say so. The consent is real and is recorded; what cannot happen is the address
// moving off the roll it already identifies, because that roll is how the other guest gets back in
// on a new device. The flag is there so the UI can tell them plainly: that address is spoken for at
// this event, and the photos will go to whoever holds it.
router.post('/wants-photos', async (req: Request, res: Response) => {
  const body = req.body as { sessionToken?: unknown; wantsPhotos?: unknown; email?: unknown };
  const sessionToken = String(body?.sessionToken || '');
  if (!sessionToken) return res.status(400).json({ error: 'sessionToken required' });

  // Absent means yes: the only reason to call this is to ask. `false` is how a guest changes their
  // mind, and it is honoured for every message — the sweep reads this column, not a copy of it.
  const wantsPhotos = body.wantsPhotos === undefined ? true : body.wantsPhotos === true;

  const [p] = await db.select().from(participants).where(eq(participants.sessionToken, sessionToken));
  if (!p) return res.status(404).json({ error: 'Session not found' });

  // Trimmed and capped exactly as the join route does it — the UNIQUE index is on lower(email), and
  // the two have to agree about what "the same address" is or recovery misses.
  const raw = typeof body.email === 'string' ? body.email.trim().slice(0, 200) : '';
  if (raw && !isEmail(raw)) return res.status(400).json({ error: 'Enter a valid email address' });

  let storedEmail = p.email;
  let duplicateEmail = false;
  if (raw && raw.toLowerCase() !== (p.email || '').toLowerCase()) {
    try {
      await db.update(participants).set({ email: raw }).where(eq(participants.id, p.id));
      storedEmail = raw;
    } catch (e) {
      if (!isDuplicate(e)) throw e;
      duplicateEmail = true;
      console.warn(`[participants] ${p.id}: address in use by another guest — opting in without storing it`);
    }
  }

  await db.update(participants).set({ wantsPhotos }).where(eq(participants.id, p.id));

  res.json({
    ok: true,
    wantsPhotos,
    email: storedEmail,
    emailStored: !!storedEmail,
    duplicateEmail,
    // They said yes and we have nowhere to send it. The opt-in is kept — they may add an address
    // later, and the sweep simply skips a row with no address — but the UI has to ask for one now
    // or the guest will believe something is coming that cannot be.
    needsEmail: wantsPhotos && !storedEmail,
  });
});

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

// There is no "email me my photos" route any more, and this is where it was.
//
// It took a session token and an `emailOverride`, and mailed the address named in the override —
// ANY address, from our domain, with our branding. Joining an event is free and uncapped, so a
// session token is free, and the per-session cap of 5 sat behind a per-IP backstop of 200 per 15
// minutes: roughly 19,000 attacker-chosen recipients a day per address, which is a mail relay with
// our reputation on it. Nothing in the product called it: the SvelteKit frontend never did, and its
// only caller was the old src/public/js/event.js, unreachable behind nginx since the proxy split.
//
// The legitimate need it served is covered, and covered better, by the consent-gated path: a guest
// asks with POST /wants-photos and guest-delivery.ts sends to the address on their OWN row. If a
// "send it to me now" button is ever wanted again, it belongs there — sending to p.email only,
// never to an address supplied in the request.

export default router;
