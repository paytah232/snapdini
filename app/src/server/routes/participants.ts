import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import { eq, or, and, count, sql, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { effectiveMaxPhotos, photosRemaining as remainingFor } from '../allowance';
import { events, guestFeedback, participants, photos } from '../schema';
import {
  readSets, setByKey, assignSetWithSource, readTick,
  readSetSource, publicSetSource, shouldAskWhichSet, setChoices, resolveSetChoice, cardDesignHasQr,
} from '../challenges';
import { faceMatchingAvailable } from '../faces';
import { billingEnabled } from '../billing';
import { isRiskyRecovery, notifyRiskyRecovery } from '../ops-notify';

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

/** Everything the camera needs to know about the guest's card BEYOND which one it is.
 *
 *  Three fields rather than one because they answer three different questions, and a client that
 *  had to derive any of them would be deriving it from state it cannot see:
 *
 *   · `setSource` — where the card came from. Only interesting for the nudge below.
 *   · `setPending` — is there still a question open for this guest? THE gate on the prompt, and the
 *     reason no event already running is disturbed: their participants have no stored source, an
 *     absent source reads as 'auto', and 'auto' is settled.
 *   · `setChoices` — the cards, as something recognisable rather than as keys. Sent only while the
 *     question is open, so the ordinary case ships nothing extra.
 *
 *  `cardsHaveQr` rides along on the same condition: if the cards at THIS event each carry their own
 *  code, the better suggestion is to go and scan the one in their hand rather than to pick from a
 *  list, and the client cannot know that on its own.
 */
export function setStatusFor(o: {
  challenges: string | null;
  posterConfig: string | null;
  challengeSet: string | null;
  challengeSetSource: string | null;
}) {
  const sets = readSets(o.challenges);
  const source = readSetSource(o.challengeSetSource);
  const ask = shouldAskWhichSet(sets, source);
  return {
    setSource: publicSetSource(source),
    setPending: ask,
    // undefined, not [] / false: JSON drops the key entirely, so a guest with nothing to answer
    // gets the payload they have always got.
    setChoices: ask ? setChoices(sets) : undefined,
    cardsHaveQr: ask ? cardDesignHasQr(o.posterConfig) : undefined,
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

// ── Throttling email recovery (the branch inside the join below) ──────────────
//
// Recovery is keyed on the address alone, on purpose (the note on the branch itself explains why,
// and specs/97-participant-email.mjs pins it). The cost of that is an oracle-and-takeover pair: an
// event's join code is printed on a venue sign, so code + a guest's address mints a fresh session
// on that guest's roll. This limiter does not close that — it makes walking a guest list SLOW, and
// ops-notify.notifyRiskyRecovery makes the takeover NOISY. Nothing a real guest does changes.
//
// KEYED ON (event id + lower(address)). NOT on the IP, and this is the whole design decision:
//   · a whole venue is ONE NAT address — the GUEST_READ note in index.ts spells out what an
//     IP-keyed limiter does to a wedding, and a prior audit found `trust proxy` resolving to the
//     venue NAT. An IP bucket on a guest write path throttles the party, not the attacker.
//   · the event ROW, not the join code the client sent: joinCode AND slug both resolve to the same
//     event (see the lookup above), so keying on the client's string would hand out two budgets.
//   · lower(), to agree with the recovery lookup and the UNIQUE index on (event_id, lower(email)) —
//     otherwise flipping one letter's case is a fresh bucket.
//
// COUNTS EVERY ATTEMPT, including the ones that succeed. Skipping successes would leave this
// limiter with nothing to count: an attacker who has the address gets a SUCCESSFUL recovery every
// single time, so failures are not the abuse signal — volume is. A real returning guest makes one
// attempt, or two if they fat-fingered the address; 5 per 15 minutes per address leaves them a wide
// margin (specs/97-participant-email.mjs legitimately makes 5 and is unaffected), while an
// enumerator gets 5 tries per address per quarter of an hour.
//
// Not in index.ts with its siblings — where a reader will look first — because it CANNOT be mounted
// as middleware: the key needs the resolved event row, and whether a request is a recovery at all
// is only known after the lookup below. So it is built here and CALLED mid-handler, on the recovery
// path only. A first-time join never reaches it.
const RECOVERY_BLOCKED = Symbol('recovery-rate-limited');

/** The bucket a recovery attempt counts against. Exported for the unit test. */
export const recoveryKey = (eventId: string, email: string) => `${eventId}:${email.trim().toLowerCase()}`;

export const recoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: Number(process.env.RECOVERY_RATE_LIMIT || 5),
  standardHeaders: 'draft-7', legacyHeaders: false,
  // res.locals, set by recoveryAllowed() immediately before it calls this. The default generator
  // is req.ip, which is the one thing this must not be.
  keyGenerator: (_req: Request, res: Response) => String(res.locals.recoveryKey || ''),
  // Running inside the route, the limiter must not answer the request itself — the handler is
  // still holding it. next(sentinel) hands the decision back to recoveryAllowed().
  handler: (_req, _res, next) => next(RECOVERY_BLOCKED),
});

/** false = over budget; the caller answers 429. Throws on a real store failure rather than
 *  quietly failing open. Exported so the unit test can drive the REAL gate rather than a copy of
 *  it — the keyGenerator/sentinel handshake is the part worth testing. */
export function recoveryAllowed(req: Request, res: Response, key: string): Promise<boolean> {
  res.locals.recoveryKey = key;
  return new Promise<boolean>((resolve, reject) => {
    recoveryLimiter(req, res, (err?: unknown) => {
      if (!err) return resolve(true);
      if (err === RECOVERY_BLOCKED) return resolve(false);
      reject(err);
    });
  });
}

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

  // JOIN CODE WINS on a tie — the same rule eventByIdentifier applies, written here because this
  // lookup does not go through it. The two namespaces can collide (see isSlugAvailable), and a join
  // code is the stronger claim; without the sort, which event this resolves to is whichever row the
  // planner happens to return first.
  const evRows = await db.select().from(events).where(
    or(eq(events.joinCode, joinCode.toUpperCase().trim()), eq(events.slug, joinCode.toLowerCase().trim())),
  ).limit(2);
  const event = evRows.length < 2 ? evRows[0]
    : (evRows.find((e) => e.joinCode === joinCode.toUpperCase().trim()) ?? evRows[0]);
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
      // Before anything is written, and only on this branch: over budget for this address at this
      // event means no new session token, so the roll is not handed over. See recoveryLimiter.
      if (!await recoveryAllowed(req, res, recoveryKey(event.id, cleanEmail)))
        return res.status(429).json({ error: 'Too many attempts to rejoin with that email — please wait a few minutes and try again.' });
      const sessionToken = newToken();
      const newName = name.trim().slice(0, 40) || existing.name;
      await db.update(participants).set({ sessionToken, name: newName }).where(eq(participants.id, existing.id));
      // A rename of a roll that already has photos on it is the takeover shape — alert ops.
      // Best-effort and never blocks the guest's response, exactly like the unhappy-survey alert
      // in routes/survey.ts. The address is masked inside the helper.
      if (isRiskyRecovery(existing, newName)) {
        notifyRiskyRecovery({ name: event.name, joinCode: event.joinCode },
          { email: cleanEmail, previousName: existing.name, newName, photosTaken: existing.photosTaken })
          .catch((e) => console.error('[ops] risky-recovery alert:', (e as Error).message));
      }
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
        // Read off the row they already had, so a guest coming back on a new device is told
        // exactly what they were told before — including "settled", which is what every
        // participant who predates the column reads as.
        ...setStatusFor({ challenges: event.challenges, posterConfig: event.posterConfig,
                          challengeSet: existing.challengeSet, challengeSetSource: existing.challengeSetSource }),
        recovered:       true,
      });
    }
  }

  // Billing entitlement (only enforced when billing is enabled; self-host has no caps).
  //
  // Unpaid is refused up front: it does not depend on how many others have joined, so it does not
  // belong inside the lock below.
  if (billingEnabled && !event.paid)
    return res.status(402).json({ error: "This event isn't active yet — the organizer needs to finish setting it up." });

  const sessionToken = newToken();

  // The mission cards this event hands out, and the one this guest's printed card asked for
  // (?set=b on the QR). Parsed out here; USED inside the transaction, where the join count the
  // round-robin needs is the one we are actually seating against.
  const sets = readSets(event.challenges);
  const requestedSet: unknown = req.body?.set ?? req.query?.set;

  const participant = {
    id:            uuidv4(),
    eventId:       event.id,
    name:          name.trim().slice(0, 40),
    email:         cleanEmail,
    sessionToken:  sessionToken,
    photosTaken:   0,
    joinedAt:      now,
    // Which mission card this guest gets, and whether that was their card or our guess — a guess
    // at an event with several cards is written down as a question still open (source 'pending')
    // and the camera then asks. Both filled in below. See assignSetWithSource.
    challengeSet:       null as string | null,
    challengeSetSource: null as string | null,
  };

  // ── Seating the guest: count, cap, INSERT — one step, not three ─────────────
  //
  // `guestCap` is a PAID entitlement, and "count the guests, then insert one" is check-then-act.
  // A QR code on a venue sign is scanned by a whole table at the same moment, which is the normal
  // case and not an edge one: every request in the burst read the same count before any of them
  // had inserted, so every one of them passed. Measured on dev before this change: twenty-five
  // simultaneous joins at a cap of TEN admitted seventeen, and twelve joins at a cap with one free
  // seat admitted all twelve. Guests beyond the tier the host paid for were getting in free, which
  // is a revenue bug as much as a correctness one. testsuite/specs/16-guest-cap-race.mjs fires that
  // burst for real rather than reasoning about it.
  //
  // So the count and the insert happen inside one transaction that first takes a row lock on the
  // EVENT. Joins to the same event then queue behind each other, and each one counts the rows the
  // one before it wrote. Joins to OTHER events are untouched — the lock is per event row.
  //
  //  · `for no key update`, not `for update`. It conflicts with itself, which is the entire point
  //    (that is what serialises the joins), but it does NOT conflict with the `for key share` lock
  //    that every INSERT into participants takes on this event row for its foreign key. With
  //    `for update`, any other writer inserting a participant for this event would have queued
  //    behind us for no reason.
  //  · NOT `INSERT … SELECT … WHERE (SELECT count(*) …) < cap`. That looks atomic and is not: under
  //    READ COMMITTED each statement's subquery reads a snapshot taken before the others committed,
  //    so the whole burst still passes and the overshoot survives unchanged.
  //  · NOT an advisory lock. It would work, but it needs the event's uuid hashed down to a bigint
  //    (two unrelated events can then collide and serialise each other), and it is a lock with no
  //    visible relationship to the row whose capacity it protects.
  //
  // The lock spans three statements against Postgres and NOTHING else. `missionsFor()` and the rest
  // of the response are built after the commit, below, deliberately: none of it affects who gets a
  // seat, and holding a row lock across unrelated work would turn one slow query into a queue of
  // guests staring at a spinner.
  //
  // The cap is re-read from the LOCKED row rather than trusted from `event`, which was read before
  // the lock existed: a host who buys a bigger tier mid-rush should be believed immediately.
  const seat = await db.transaction(async (tx) => {
    let cap: number | null = null;
    if (billingEnabled) {
      const [locked] = await tx.select({ guestCap: events.guestCap })
        .from(events).where(eq(events.id, event.id)).for('no key update');
      // Deleted while this join waited for the lock. The foreign key below would refuse the insert
      // anyway; answering the same 404 the lookup above would have is the honest version of that.
      if (!locked) return { gone: true } as const;
      cap = locked.guestCap;
    }

    // ONE count, shared by the cap and the round-robin. They were two identical queries; inside
    // the lock they could not disagree even if they wanted to.
    if (cap !== null || sets.length) {
      const [{ c: joined }] = await tx.select({ c: count() })
        .from(participants).where(eq(participants.eventId, event.id));
      if (cap !== null && Number(joined) >= cap) return { full: cap } as const;
      if (sets.length)
        ({ key: participant.challengeSet, source: participant.challengeSetSource } =
          assignSetWithSource(sets, requestedSet, Number(joined) || 0));
    }

    try {
      // A SAVEPOINT — which is what a nested Drizzle transaction compiles to — and it is load
      // bearing, not decoration. In Postgres a failed statement poisons the whole transaction, so
      // without it the catch below would fire its second INSERT into an aborted transaction, get
      // 25P02 back, and hand the guest exactly the HTTP 500 that specs/97-participant-email.mjs
      // exists to keep out of this route. The savepoint contains the failure to the one statement
      // that caused it.
      await tx.transaction(async (sp) => { await sp.insert(participants).values(participant); });
    } catch (e) {
      if (!isDuplicate(e)) throw e;
      // Recovery above should have caught this, so we are in a race (two devices joining with the
      // same address at once) or a case the guard still cannot see. Either way, letting someone into
      // the event with their OWN roll matters more than storing their address, so drop the address
      // and keep going. They lose email-based recovery; they do not lose the event.
      console.warn(`[participants] ${event.joinCode}: address already used in this event — joining without it`);
      participant.email = null;
      // This one cannot trip the same index: it is partial (WHERE email IS NOT NULL), so a row with
      // no address is not in it at all.
      await tx.insert(participants).values(participant);
    }
    return { seated: true } as const;
  });

  // Answered out here, after the commit — a response written inside the transaction would hold the
  // lock for as long as it took to build.
  if ('gone' in seat) return res.status(404).json({ error: 'Event not found' });
  if ('full' in seat) return res.status(403).json({ error: `This event is full (max ${seat.full} guests).` });

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
    ...(await missionsFor(event.challenges, participant.challengeSet, participant.id)),
    ...setStatusFor({ challenges: event.challenges, posterConfig: event.posterConfig,
                      challengeSet: participant.challengeSet, challengeSetSource: participant.challengeSetSource }),
  });
});

// ── GET /api/participants/me ───────────────────────────────────────────────────

router.get('/me', async (req: Request, res: Response) => {
  // Header (or body) only — never the query string. nginx logs "$request", so a token in a
  // URL is written into the access log, the browser history and every proxy between. The zip
  // route is the ONE justified exception and says so: it is reached by navigating, and a
  // navigation cannot carry a header. Everything here is a fetch.
  const sessionToken = req.get('x-session-token');
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
      challengeSetSource: participants.challengeSetSource,
      challenges:       events.challenges,
      // Only for cardDesignHasQr(): whether the printed cards at this event carry their own code,
      // which decides whether "go and scan yours" is better advice than "pick one".
      posterConfig:     events.posterConfig,
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
      ...setStatusFor({ challenges: p.challenges, posterConfig: p.posterConfig,
                        challengeSet: p.challengeSet, challengeSetSource: p.challengeSetSource }),
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

// ── POST /api/participants/card — the guest says which trick card they are holding ────────
//
// Trick cards print without a QR by default now: most sets are deliberately minimal, and the guests
// this exists for joined off the main event sign, which names no set at all. The round-robin then
// hands out cards nobody is looking at — the app saying "card B" to someone with card A on the
// table in front of them, which is the exact failure printing several cards is meant to avoid.
//
// So we ask. This is the only place that answer can be given, and all three rules are enforced HERE
// rather than in the client, because the client is a phone at a party:
//
//  · only while the question is open (source 'pending'). A second attempt is refused: the guest was
//    warned they cannot change it, and one who could would be free to shop around for the easier
//    list. A printed ?set= card and a host's move are final for the same reason.
//  · only a card this event HAS. An arbitrary key leaves them holding a set that does not exist, and
//    missionsFor() would fall back to the first one — a silent wrong answer.
//  · "I don't have a card" keeps the round-robin's answer, and is not a lesser option. For someone
//    who never had a card in their hand, even coverage is a better answer than a guess; without it
//    every such guest taps the first button and the coverage several cards exist for is gone.
router.post('/card', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { set?: unknown; sessionToken?: unknown };
  const sessionToken = req.get('x-session-token') || (typeof body.sessionToken === 'string' ? body.sessionToken : '');
  if (!sessionToken) return res.status(400).json({ error: 'sessionToken required' });

  const [p] = await db.select().from(participants).where(eq(participants.sessionToken, String(sessionToken)));
  if (!p) return res.status(404).json({ error: 'Session not found' });
  const [event] = await db.select().from(events).where(eq(events.id, p.eventId));
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const sets = readSets(event.challenges);

  /** "You already have a card" — the answer whether we found that out by READING the row or by
   *  losing the race to write it. Built from whatever the column says NOW, not from the copy read
   *  at the top of the handler, because in the second case that copy is exactly what was stale. */
  const alreadySettled = async (setKey: string | null, source: string | null) =>
    res.status(409).json({
      error: "You've already got your card for tonight.",
      ...(await missionsFor(event.challenges, setKey, p.id)),
      ...setStatusFor({ challenges: event.challenges, posterConfig: event.posterConfig,
                        challengeSet: setKey, challengeSetSource: source }),
    });

  const out = resolveSetChoice(sets, { key: p.challengeSet, source: readSetSource(p.challengeSetSource) }, body.set);
  if (!out.ok) {
    // 409 rather than 403 for 'locked': nothing is forbidden, the question is already answered —
    // two taps on a slow connection is the ordinary way to reach this. The card they actually have
    // comes back with it, so the camera can show that instead of an error.
    if (out.reason === 'locked') return alreadySettled(p.challengeSet, p.challengeSetSource);
    return res.status(400).json({ error: 'That card is not part of this event' });
  }

  // ── The lock is this WHERE clause, and nothing above it ──────────────────────
  //
  // resolveSetChoice() reads the source and then, several awaits later, we write. Between those two
  // moments a second request can do the same thing, and both would win: two taps on a phone at a
  // party, a double-fire from a flaky connection, a guest with the camera open on two devices. The
  // promise made to the guest before the tap is "you cannot change this" — and a promise kept by
  // reading a value you then overwrite unconditionally is not kept at all. The first writer takes
  // the row; the second changes nothing and is told the same thing it would have been told had it
  // arrived a moment later.
  //
  // `= 'pending'` and NOT `IS NULL OR = 'pending'`, deliberately. NULL is every participant who
  // joined before any of this existed: readSetSource() reads it as 'auto', which is SETTLED, and
  // resolveSetChoice() refuses it. Making NULL lockable here would open a door the branch above has
  // always kept shut — and would reassign the card of someone who was never asked.
  //
  // `returning()` rather than a rowCount: it is the portable answer across drivers, and it hands
  // back the row we just wrote instead of a number we would have to trust.
  const won = await db.update(participants)
    .set({ challengeSet: out.key, challengeSetSource: out.source })
    .where(and(eq(participants.id, p.id), eq(participants.challengeSetSource, 'pending')))
    .returning({ challengeSet: participants.challengeSet, challengeSetSource: participants.challengeSetSource });

  if (!won.length) {
    // Lost the race. Re-read rather than echo `out`: the card the guest actually holds is whatever
    // the winner wrote, and telling them about the one they did not get is the bug wearing a 409.
    const [now] = await db.select({ challengeSet: participants.challengeSet, challengeSetSource: participants.challengeSetSource })
      .from(participants).where(eq(participants.id, p.id));
    return alreadySettled(now?.challengeSet ?? p.challengeSet, now?.challengeSetSource ?? p.challengeSetSource);
  }

  res.json({
    ok: true,
    ...(await missionsFor(event.challenges, out.key, p.id)),
    ...setStatusFor({ challenges: event.challenges, posterConfig: event.posterConfig,
                      challengeSet: out.key, challengeSetSource: out.source }),
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
