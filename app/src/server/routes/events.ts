import crypto from 'crypto';
import fs from 'fs';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { eq, and, or, sql, inArray, count, desc, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../db';
import { parseChallengeSets, readSets, readTick, parseTick, serialiseSets, parseEventType, MAX_CHALLENGES, MAX_SETS } from '../challenges';
import { events, participants, photos, shares, shareSends, eventCohosts, users, type Event } from '../schema';
import { faceMatchingAvailable } from '../faces';
import * as email from '../email';
import * as auth from '../auth';
import * as cleanup from '../cleanup';
import { DEMO_NAME, RESCHEDULE_WINDOW_MS, baseUrl, escapeHtml, isRevealed } from '../lib';
import { referrerFromCookie, isSelfReferral } from '../referrals';
import { startSlideshow, slideshowInfo, toggleSlideshowFavourite, deleteSlideshow, slideshowFile, streamSlideshow1080 } from '../slideshow';
import { billingEnabled, quote, FREE_ALL_GUESTS, brandingRemovable, RETENTION_PAID_DAYS } from '../billing';
import { sendWelcome } from '../lifecycle';
import options from '../options';
import { REVEAL_CUSTOM, ceilToRevealTick, zonedWallTimeToMs } from '../../../../shared/reveal';
import { parseGuestDelivery, parseGuestSendScope, effectiveGuestScope, revealOpensAt,
         clampGuestSendAt, sendGuestLink, type GuestTiming } from '../guest-delivery';

const router = Router();

// Photos + event are auto-deleted this many days after the event ends (retention).
// Plan-scaled windows arrive with billing; this is the self-host/free default.
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '7');
// DEMO_NAME lives in ../lib so the admin listing can filter on the same definition.
const DAY_MS = 24 * 60 * 60 * 1000;
// Global video length (self-host / billing-off default; per-event entitlement when billing on).
const GLOBAL_VIDEO_SECONDS = parseInt(process.env.VIDEO_MAX_SECONDS || '0');
// A demo's own clip limit, deliberately NOT the global one.
//
// The global is a self-hoster's setting for their real events; a demo is a throwaway a stranger
// mints with one unauthenticated POST, and it is purged about three hours later. At the global's
// dev value of 60s that is a 4K minute of upload per tyre-kicker, on the path that is the
// documented capacity ceiling — and there are already 424 demo events in dev alone.
//
// Ten seconds is enough to show that clips work, which is the only job the demo has.
const DEMO_VIDEO_SECONDS = 10;

// Allowed capture aspect ratios validated against the single options source.
const VALID_ASPECTS = options.aspectRatios.map((a) => a.value);
const VALID_MODES = options.themeModes.map((m) => m.value);
const VALID_FONTS = options.fonts.map((f) => f.stack);
function sanitizeAspects(arr: unknown): string[] {
  const a = Array.isArray(arr) ? arr.filter((v) => VALID_ASPECTS.includes(v)) : [];
  return a.length ? Array.from(new Set(a)) : ['1:1'];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Turn the host's custom reveal choice into the instant to store, or into the reason it cannot be.
 *
 *  Resolved HERE from the wall-clock strings and the event's OWN timezone, deliberately not taken
 *  as an epoch from the client the way starts_at is. The browser's zone is wherever the host
 *  happens to be standing: a planner in Sydney setting the reveal for a Perth event would book it
 *  two hours out, and nothing on either side would notice.
 *
 *  Returning an error rather than falling back to the delay is the point — a silent fallback saves
 *  a reveal at a time the host did not choose and reports it as saved. */
function resolveCustomReveal(date: unknown, time: unknown, timezone: string | null, purgeAt: number):
  { at: number } | { error: string } {
  const at = zonedWallTimeToMs(String(date ?? ''), String(time ?? ''), timezone || 'UTC');
  if (at === null) return { error: 'Pick the date and time you want the photos revealed.' };
  // Rounded before it is stored, never on the way out, so the instant the host was shown when they
  // picked it is the instant every countdown and every gate reads back afterwards.
  const rounded = ceilToRevealTick(at);
  // Retention deletes the photos. A reveal booked past that unlocks an empty gallery — the one
  // outcome worse than refusing to save.
  if (rounded > purgeAt)
    return { error: 'That is after the photos are deleted at the end of retention. Pick an earlier reveal, or extend retention first.' };
  return { at: rounded };
}

/** Turn the host's "send the guests the link at…" choice into the instant to store.
 *
 *  Mirrors resolveCustomReveal above, and for the same reason: the wall time is resolved against
 *  the EVENT'S timezone, not the browser's, so a planner in Sydney booking a Perth event does not
 *  quietly move the send two hours. An explicit epoch is accepted too, for a caller that has
 *  already done that work.
 *
 *  Then the one invariant this feature cannot bend: the send is CLAMPED UP to the reveal. A gallery
 *  link that lands before the gallery opens sends a guest to a locked page, and a guest who gets
 *  there once does not come back. Clamping rather than refusing is deliberate — refusing would
 *  throw away the rest of a settings save over minutes the host can only have mistyped, and "as
 *  early as you can" is the only thing an earlier time can mean. The caller reports the clamp so
 *  the host is told, rather than shown a different time back without explanation.
 */
function resolveGuestSendAt(body: Record<string, unknown>, timezone: string | null, timing: GuestTiming):
  { at: number; clamped: boolean } | { error: string } {
  let at: number | null = null;
  const raw = body.guestSendAt;
  if (typeof raw === 'number' && raw > 0) at = raw;
  else if (body.guestSendDate !== undefined || body.guestSendTime !== undefined)
    at = zonedWallTimeToMs(String(body.guestSendDate ?? ''), String(body.guestSendTime ?? ''), timezone || 'UTC');
  if (at === null) return { error: 'Pick the date and time you want your guests sent the link.' };
  return clampGuestSendAt(ceilToRevealTick(at), revealOpensAt(timing));
}

function generateJoinCode(): string {
  // Cryptographically random (not Math.random) + 8 chars over a 32-symbol alphabet (~2^40)
  // so join codes can't be predicted or feasibly enumerated.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[bytes[i] & 31];
  return code;
}

function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}

async function isSlugAvailable(slug: string): Promise<boolean> {
  const [row] = await db.select({ id: events.id }).from(events).where(eq(events.slug, slug));
  return !row;
}

// Resolve an event by its URL identifier. Join codes are stored uppercase and slugs lowercase,
// each on its own index — so two targeted equality lookups (the common join-code case resolves in
// the first) beat an OR across both columns, which can't always use both indexes.
export async function eventByIdentifier(raw: string): Promise<Event | undefined> {
  const [byCode] = await db.select().from(events).where(eq(events.joinCode, raw.toUpperCase()));
  if (byCode) return byCode;
  const [bySlug] = await db.select().from(events).where(eq(events.slug, raw.toLowerCase()));
  return bySlug;
}

// Theme values are organizer-supplied and injected into the public gallery's CSS, so
// validate them server-side (CSP is the primary guard; this is defense-in-depth).
const COLOR_KEYS = ['bg', 'surface', 'surface2', 'border', 'text', 'textMuted', 'accent', 'accentDark'];
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$|^(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$|^[a-zA-Z]{3,24}$/;
const UPLOADS_PATH_RE = /^\/uploads\/[A-Za-z0-9._/-]+$/; // same-origin upload path, no quotes/parens/spaces
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isEmail = (e: unknown): boolean =>
  typeof e === 'string' && e.length <= 200 && EMAIL_RE.test(e.trim());

function sanitizeCustomCss(css: unknown): string {
  return String(css)
    .slice(0, 50_000)
    .replace(/@import[^;]*;?/gi, '')                              // no @import
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, _q, u) =>       // no off-origin url() fetches
      /:\/\/|^\s*\/\//.test(u) ? 'none' : m);
}

function sanitizeTheme(theme: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof theme.preset === 'string') out.preset = theme.preset.slice(0, 40);
  for (const k of COLOR_KEYS) {
    if (theme[k] !== undefined) {
      const v = String(theme[k]).trim().slice(0, 64);
      if (COLOR_RE.test(v)) out[k] = v;            // silently drop anything that isn't a color
    }
  }
  if (theme.customCss !== undefined) out.customCss = sanitizeCustomCss(theme.customCss);
  if (theme.headerImage !== undefined) {
    const v = String(theme.headerImage).trim();
    if (UPLOADS_PATH_RE.test(v)) out.headerImage = v; // only same-origin uploads paths
  }
  if (typeof theme.mode === 'string' && VALID_MODES.includes(theme.mode)) out.mode = theme.mode;
  if (typeof theme.font === 'string' && VALID_FONTS.includes(theme.font)) out.font = theme.font; // must match a known stack
  return out;
}

// ── POST /api/events — create ─────────────────────────────────────────────────

router.post('/', auth.requireAuth, async (req: Request, res: Response) => {
  // Creating a real event requires a signed-in, email-verified account.
  if (!req.user!.emailVerifiedAt)
    return res.status(403).json({ error: 'Please verify your email before creating an event', needsVerification: true });

  const { name, blurb: rawBlurb, durationHours, maxPhotos, revealMode, slug: rawSlug,
          startDate, startTime, startsAt: startsAtMs, allowDownloads, noFlash,
          revealDelayHours, revealDate, revealTime, moderationEnabled, timezone, maxGuests, videoSeconds, eventType } = req.body as {
    name?: string; blurb?: string; durationHours?: number | string; maxPhotos?: number | string;
    revealMode?: string; slug?: string; startDate?: string; startTime?: string;
    startsAt?: number; allowDownloads?: boolean; noFlash?: boolean; revealDelayHours?: number | string;
    revealDate?: string; revealTime?: string;
    moderationEnabled?: boolean; timezone?: string; maxGuests?: number | string; videoSeconds?: number | string;
    eventType?: string;
  };
  const blurb = typeof rawBlurb === 'string' && rawBlurb.trim() ? rawBlurb.trim().slice(0, 280) : null;

  if (!name || !durationHours || !maxPhotos)
    return res.status(400).json({ error: 'name, durationHours, and maxPhotos are required' });

  const validModes = ['instant', 'at_end', 'manual'];
  const mode = validModes.includes(revealMode as string) ? (revealMode as string) : 'instant';
  // Reveal delay only applies to 'at_end'; clamp to 0..168h (one week). REVEAL_CUSTOM parses to
  // NaN here and so lands on 0 — correct, because the absolute instant resolved below wins anyway.
  const revealDelay = mode === 'at_end' ? Math.min(Math.max(parseInt(revealDelayHours as string, 10) || 0, 0), 168) : 0;

  let slug: string | null = null;
  if (rawSlug) {
    slug = slugify(rawSlug);
    if (slug.length < 2) return res.status(400).json({ error: 'Custom URL must be at least 2 characters' });
    if (!(await isSlugAvailable(slug))) return res.status(409).json({ error: 'That custom URL is already taken' });
  }

  // Resolve starts_at. Prefer an explicit epoch from the client (computed in the user's
  // own timezone) so we don't reparse a bare date/time string in the server's TZ (UTC).
  let startsAt = Date.now();
  if (typeof startsAtMs === 'number' && startsAtMs > 0) {
    startsAt = startsAtMs;
  } else if (startDate) {
    const parsed = new Date(`${startDate}T${startTime || '00:00'}`).getTime();
    if (!isNaN(parsed)) startsAt = parsed;
  }

  const expiresAt = startsAt + parseFloat(durationHours as string) * 3_600_000;

  // ── Billing entitlement (only constrains when billing is enabled; self-host = no limits) ──
  const reqGuests = Math.min(Math.max(parseInt(maxGuests as string, 10) || FREE_ALL_GUESTS, 1), 1000);
  const reqVideo = parseInt(videoSeconds as string, 10) || 0;
  const reqShots = Math.min(Math.max(parseInt(maxPhotos as string, 10) || 12, 1), 100);
  const reqAspects = sanitizeAspects((req.body as { aspectRatios?: unknown }).aspectRatios);
  const reqDuration = Math.max(1, parseFloat(durationHours as string) || 24);
  // Paid events DEFAULT to the full-month allowance rather than the 7-day free-tier floor. Anyone who
  // never touches the retention control still gets a month, so a customer cannot silently lose
  // their photos a week after the event — the failure mode that matters most on a memories product.
  const wantsPaidTier = reqGuests > FREE_ALL_GUESTS;
  const retentionDefault = wantsPaidTier ? Math.max(RETENTION_PAID_DAYS, RETENTION_DAYS) : RETENTION_DAYS;
  const reqRetention = Math.min(Math.max(parseInt((req.body as { retentionDays?: unknown }).retentionDays as string, 10) || retentionDefault, 1), 366);
  const q = quote({ maxGuests: reqGuests, maxPhotos: reqShots, aspectRatios: reqAspects, videoSeconds: reqVideo, durationHours: reqDuration, retentionDays: reqRetention });
  // When billing is on, store the entitled config from the quote (≤10 = free with everything; 11+ paid).
  const entGuestCap = reqGuests;
  const entVideoSeconds = billingEnabled ? q.videoSeconds : reqVideo;
  const entMaxPhotos = billingEnabled ? q.maxPhotos : reqShots;
  const entAspects = billingEnabled ? q.aspectRatios : reqAspects;
  const entRetentionDays = Math.max(
    billingEnabled ? q.retentionDays : reqRetention,
    q.tier === 'paid' ? RETENTION_PAID_DAYS : 0,   // the allowance is a floor, not just free headroom
  );
  const entPaid = billingEnabled ? !q.requiresPayment : true;

  const eventTz = (typeof timezone === 'string' && timezone) ? timezone.slice(0, 64) : null;
  const purgeAt = expiresAt + entRetentionDays * DAY_MS;

  // Resolved down here rather than beside the mode, because the ceiling it is checked against is
  // the purge, and the purge is not known until the retention entitlement above is.
  let revealAt: number | null = null;
  if (mode === 'at_end' && String(revealDelayHours) === REVEAL_CUSTOM) {
    const r = resolveCustomReveal(revealDate, revealTime, eventTz, purgeAt);
    if ('error' in r) return res.status(400).json({ error: r.error });
    revealAt = r.at;
  }

  // ── Guest delivery (0046) ──────────────────────────────────────────────────
  // Every field is optional and every default is what a new event should do. Nothing here can mail
  // anybody on its own: participants.wantsPhotos is the consent gate, and it starts false.
  const gBody = req.body as Record<string, unknown>;
  const guestDelivery  = gBody.guestDelivery  === undefined ? 'all_on_reveal' : parseGuestDelivery(gBody.guestDelivery);
  const guestSendScope = gBody.guestSendScope === undefined ? 'all'           : parseGuestSendScope(gBody.guestSendScope);
  let guestSendAt: number | null = null;
  let guestSendAtClamped = false;
  if (guestDelivery === 'scheduled') {
    const g = resolveGuestSendAt(gBody, eventTz, {
      revealMode: mode, revealedAt: null, revealHidden: false, revealAt, revealDelayHours: revealDelay,
      startsAt, expiresAt, guestDelivery, guestSendAt: null, guestSendScope,
    });
    if ('error' in g) return res.status(400).json({ error: g.error });
    guestSendAt = g.at;
    guestSendAtClamped = g.clamped;
  }
  const guestMailThanks   = gBody.guestMailThanks   === undefined ? true  : gBody.guestMailThanks   === true;
  const guestMailReminder = gBody.guestMailReminder === undefined ? false : gBody.guestMailReminder === true;
  const guestMailLive     = gBody.guestMailLive     === undefined ? true  : gBody.guestMailLive     === true;

  let joinCode: string;
  let attempts = 0;
  do {
    joinCode = generateJoinCode();
    attempts++;
  } while (
    (await db.select({ id: events.id }).from(events).where(eq(events.joinCode, joinCode)))[0] &&
    attempts < 10
  );

  const event = {
    id:              uuidv4(),
    ownerUserId:     req.user ? req.user.id : null,
    name:            name.trim().slice(0, 80),
    blurb,
    // What kind of event this is. It has existed in the schema since the mission packs landed, but
    // nothing ever set it at creation — it could only be filled in as a side effect of opening the
    // missions editor, so a brand-new event was always "unstated" and every default keyed off it
    // (card decoration, tick glyph, mission pack) quietly fell back to the generic one.
    eventType:       parseEventType(eventType),
    joinCode,
    slug:            slug || null,
    organizerCode:   uuidv4().replace(/-/g, ''),
    maxPhotos:       entMaxPhotos,
    revealMode:      mode,
    revealDelayHours: revealDelay,
    revealAt,
    // Moderation only applies when photos aren't shown instantly.
    moderationEnabled: moderationEnabled === true && mode !== 'instant',
    startsAt,
    originalStartsAt: startsAt,   // anchors the 6-month reschedule window
    referredByEventId: await (async () => {
      // A host's own next event is not a referral, so ignore the cookie when it points at an event
      // they own themselves.
      const srcId = await referrerFromCookie(req);
      if (!srcId) return null;
      const [src] = await db.select({ ownerUserId: events.ownerUserId }).from(events).where(eq(events.id, srcId));
      return isSelfReferral(src?.ownerUserId ?? null, req.user?.id ?? null) ? null : srcId;
    })(),
    expiresAt,
    revealedAt:      null,
    isLocked:        false,
    allowDownloads:  allowDownloads !== false,
    noFlash:         noFlash === true,
    theme:           null,
    timezone:        eventTz,
    aspectRatios:    JSON.stringify(entAspects),
    guestCap:        entGuestCap,
    videoSeconds:    entVideoSeconds,
    retentionDays:   entRetentionDays,
    paid:            entPaid,
    purgeAt,
    guestDelivery,
    guestSendScope,
    guestSendAt,
    guestMailThanks,
    guestMailReminder,
    guestMailLive,
    createdAt:       Date.now(),
  };

  await db.insert(events).values(event);

  // Free events are live the moment they're created → send the event welcome now. Paid events get
  // it from the Stripe webhook once payment settles. Idempotent + best-effort (never blocks create).
  if (entPaid && event.ownerUserId) sendWelcome(event.id).catch((e) => console.error('[lifecycle] event welcome:', (e as Error).message));

  res.json({
    joinCode:      event.joinCode,
    slug:          event.slug,
    organizerCode: event.organizerCode,
    event: {
      id: event.id, name: event.name, maxPhotos: event.maxPhotos,
      revealMode: mode, startsAt, expiresAt,
      guestDelivery, guestSendScope, guestSendAt,
      guestMailThanks, guestMailReminder, guestMailLive,
    },
    // True when the host asked for a send before the photos are revealed and we moved it to the
    // reveal. The UI has to say so — showing a different time back without a word is how a host
    // stops trusting what the form tells them.
    guestSendAtClamped,
  });
});

// ── POST /api/events/demo — throwaway event + auto-join for the landing demo ───
// Lets a visitor try the real camera/gallery without signing up. Short-lived (purges
// in ~3h via the retention sweeper). MUST be before the /:joinCode wildcard.

// Three missions on the demo roll.
//
// The demo is how most people actually meet this product — there are far more demo rolls than real
// events — and a mechanic you can feel in thirty seconds beats one you read about. The demo reveals
// instantly, so a visitor shoots a mission and immediately sees their own photo captioned with it,
// which is the annotated-album payoff the whole feature is for.
//
// Written specifically for a visitor sitting ALONE, wherever they happen to be: the shipped packs
// assume a party ("Everyone you came with") and would hand a solo visitor three impossible tasks.
// Three of twelve shots, so it reads as an invitation rather than homework.
//
// Their own ids, so a demo can never skew which missions hosts are seen to pick.
const DEMO_SET_KEY = 'a';   // the demo's single card; the auto-joined guest must be handed it
const DEMO_MISSIONS = [
  { id: 'demo-close', text: 'Whatever’s closest to you, up close' },
  { id: 'demo-far', text: 'The room from as far as you can get' },
  { id: 'demo-keep', text: 'Something you’d actually keep' },
];


router.post('/demo', async (_req: Request, res: Response) => {
  const now = Date.now();
  let joinCode: string;
  let attempts = 0;
  do {
    joinCode = generateJoinCode();
    attempts++;
  } while (
    (await db.select({ id: events.id }).from(events).where(eq(events.joinCode, joinCode)))[0] &&
    attempts < 10
  );

  const eventId = uuidv4();
  const organizerCode = uuidv4().replace(/-/g, '');
  // 4h — the shortest length the form itself offers. It was 3h, a value no host could pick, so
  // every demo on production sat at a duration the product does not otherwise admit to. A demo is a
  // try-before-you-buy and wants to be short: long enough to shoot a few frames and see the gallery
  // reveal, not long enough to accumulate a day of strangers' photos awaiting purge.
  const expiresAt = now + 4 * 3_600_000;
  // Demo unlocks all aspect ratios so visitors can try them (free events default to 1:1).
  await db.insert(events).values({
    id: eventId,
    ownerUserId: null,
    name: DEMO_NAME,
    joinCode,
    slug: null,
    organizerCode,
    maxPhotos: 12,
    revealMode: 'instant',
    challenges: JSON.stringify({ sets: [{ key: DEMO_SET_KEY, label: 'Demo card', items: DEMO_MISSIONS }] }),
    revealDelayHours: 0,
    revealAt: null,
    moderationEnabled: false,
    startsAt: now,
    expiresAt,
    revealedAt: null,
    isLocked: false,
    allowDownloads: true,
    theme: null,
    aspectRatios: JSON.stringify(VALID_ASPECTS),
    // Demo is fully entitled (free showcase) so it works regardless of billing. guestCap is kept
    // tiny (creator + one more, e.g. a phone scanning the QR) to limit drive-by spam — the event
    // also purges ~3h after creation (purgeAt below) via the retention sweeper.
    guestCap: 2,
    videoSeconds: DEMO_VIDEO_SECONDS,
    paid: true,
    purgeAt: expiresAt,
    createdAt: now,
  });

  const sessionToken = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  await db.insert(participants).values({
    id: uuidv4(),
    eventId,
    name: 'You',
    email: null,
    sessionToken,
    photosTaken: 0,
    joinedAt: now,
    // The demo writes a single set 'a' above, and missionsFor() returns an EMPTY list when a
    // participant has no set — so without this the demo shipped a trick list nobody could see,
    // which is the one place the feature most needs to be seen.
    challengeSet: DEMO_SET_KEY,
  });

  // organizerCode is returned so the demo can showcase the manager + share views (it's a
  // throwaway 3h event, so exposing it here is fine — real events never leak it).
  res.json({ joinCode, sessionToken, organizerCode });
});

// ── GET /api/events/check-slug/:slug ─────────────────────────────────────────
// MUST be before /:joinCode wildcard

router.get('/check-slug/:slug', async (req: Request, res: Response) => {
  const slug = slugify(String(req.params.slug));
  if (slug.length < 2) return res.json({ available: false, reason: 'Too short' });
  res.json({ available: await isSlugAvailable(slug), slug });
});

// ── GET /api/events/mine — events owned by the signed-in user ─────────────────
// MUST be before the /:joinCode wildcard.

router.get('/mine', auth.requireAuth, async (req: Request, res: Response) => {
  const cols = {
    id: events.id,
    name: events.name,
    joinCode: events.joinCode,
    slug: events.slug,
    organizerCode: events.organizerCode,
    revealMode: events.revealMode,
    startsAt: events.startsAt,
    expiresAt: events.expiresAt,
    isLocked: events.isLocked,
    createdAt: events.createdAt,
  };
  const owned = await db.select(cols).from(events)
    .where(eq(events.ownerUserId, req.user!.id))
    .orderBy(sql`${events.createdAt} DESC`);
  // Events this user co-hosts (accepted) but doesn't own — managed like their own, badged "co-host".
  const cohosted = await db.select(cols).from(events)
    .innerJoin(eventCohosts, eq(eventCohosts.eventId, events.id))
    .where(and(eq(eventCohosts.userId, req.user!.id), eq(eventCohosts.status, 'accepted')))
    .orderBy(sql`${events.createdAt} DESC`);
  const ownedSet = new Set(owned.map((e) => e.id));
  const coOnly = cohosted.filter((e) => !ownedSet.has(e.id));
  const coSet = new Set(coOnly.map((e) => e.id));
  const rows = [...owned, ...coOnly];

  // Counts via grouped aggregates over just these events (a correlated sql`` subquery here
  // returned 0 — Drizzle didn't correlate the outer row; grouped queries are unambiguous).
  const ids = rows.map((e) => e.id);
  const pCounts = new Map<string, number>();
  const phCounts = new Map<string, number>();
  if (ids.length) {
    for (const r of await db.select({ id: participants.eventId, c: count() }).from(participants).where(inArray(participants.eventId, ids)).groupBy(participants.eventId))
      pCounts.set(r.id, Number(r.c));
    for (const r of await db.select({ id: photos.eventId, c: count() }).from(photos).where(inArray(photos.eventId, ids)).groupBy(photos.eventId))
      phCounts.set(r.id, Number(r.c));
  }

  const now = Date.now();
  res.json({
    events: rows.map((e) => ({
      id: e.id, name: e.name, joinCode: e.joinCode, slug: e.slug || null,
      organizerCode: e.organizerCode, revealMode: e.revealMode,
      startsAt: e.startsAt, expiresAt: e.expiresAt,
      isLocked: !!e.isLocked, isUpcoming: now < e.startsAt, isExpired: now > e.expiresAt,
      participantCount: pCounts.get(e.id) ?? 0, photoCount: phCounts.get(e.id) ?? 0,
      coHost: coSet.has(e.id),
    })),
  });
});

// ── GET /api/events/:identifier — public info ─────────────────────────────────

router.get('/:joinCode', async (req: Request, res: Response) => {
  const event = await eventByIdentifier(String(req.params.joinCode));
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const now = Date.now();
  const [{ c: participantCount }] = await db.select({ c: count() }).from(participants).where(eq(participants.eventId, event.id));
  const [{ c: photoCount }] = await db.select({ c: count() }).from(photos).where(eq(photos.eventId, event.id));

  const isDemoEvent = !event.ownerUserId && event.name === DEMO_NAME;
  res.json({
    id:             event.id,
    name:           event.name,
    blurb:          event.blurb || null,
    joinCode:       event.joinCode,
    slug:           event.slug || null,
    maxPhotos:      event.maxPhotos,
    revealMode:     event.revealMode,
    revealDelayHours: event.revealDelayHours,
    revealAt:       event.revealAt,
    timezone:       event.timezone || null,
    aspectRatios:   event.aspectRatios ? JSON.parse(event.aspectRatios) : ['1:1'],
    // Per-event video length when billing is on; otherwise the global (self-host) setting.
    videoSeconds:   billingEnabled ? event.videoSeconds : GLOBAL_VIDEO_SECONDS,
    startsAt:       event.startsAt,
    expiresAt:      event.expiresAt,
    // How MANY tricks are on a card, never which ones. A guest deciding whether to join wants to
    // know the game exists and roughly how big it is; the tricks themselves are the surprise, and
    // this endpoint is public — anyone with a join code could otherwise read the whole list before
    // the event. Sets can differ in length, so this is the first card's count, which is
    // representative rather than a promise.
    challengeCount: readSets(event.challenges)[0]?.items.length ?? 0,
    isDemo:         isDemoEvent,
    // A DEMO hands out its own organizer code, and only a demo ever does.
    //
    // The demo is a tour of three surfaces, and the link between them died on the one route people
    // actually take: start it on a laptop, which shows a QR because the camera wants a phone, and
    // the code was written into the LAPTOP's localStorage. The phone that scans has never seen it,
    // so the visitor lands in the camera with no way to the host's view — the half of the product
    // that is being sold.
    //
    // Safe because a demo is a throwaway: no owner, a two-guest cap, purged about three hours
    // later, and anyone can mint one with a single unauthenticated POST to /demo — which already
    // returns this code for exactly this reason. So it grants nothing that was not already a
    // request away. It is gated on the SAME expression as isDemo, not a second reading of the
    // conditions, so the two cannot drift apart and start leaking a real event's code.
    organizerCode:  isDemoEvent ? event.organizerCode : undefined,
    isUpcoming:     now < event.startsAt,
    isExpired:      now > event.expiresAt,
    // Reschedule eligibility: an event no guest ever used can be moved, even after it has
    // ended, up to 6 months from its ORIGINAL start (see PUT /:joinCode/settings).
    canReschedule:   now < event.startsAt || (Number(participantCount) === 0 && Number(photoCount) === 0),
    rescheduleUntil: (event.originalStartsAt ?? event.startsAt) + RESCHEDULE_WINDOW_MS,
    isLocked:       !!event.isLocked,
    isRevealed:     isRevealed(event),
    allowDownloads: !!event.allowDownloads,
    noFlash:        !!event.noFlash,
    theme:          event.theme ? JSON.parse(event.theme) : null,
    participantCount,
    photoCount,
  });
});

// The Snapdini brand mark for the centre of a QR — a white safety ring (keeps the code scannable),
// the gold chip, and a black top-hat. Matches the <Logo> component and the poster's drawn chip, so
// every QR looks identical. Returns an SVG sized to the chip's bounding box (≈23% of the QR width)
// plus that box size, so the caller can centre it over the QR.
function brandChip(qrWidth: number): { svg: Buffer; box: number } {
  const size = Math.round(qrWidth * 0.2);
  const box = Math.round(size * 1.16);              // white safety ring = full SVG canvas
  const c = box / 2, cw = size * 0.36, ch = size * 0.4, top = c - size * 0.17, bw = size * 0.64, bh = size * 0.11;
  const svg = `<svg width="${box}" height="${box}" xmlns="http://www.w3.org/2000/svg">`
    + `<rect x="0" y="0" width="${box}" height="${box}" rx="${box * 0.26}" fill="#ffffff"/>`
    + `<rect x="${c - size / 2}" y="${c - size / 2}" width="${size}" height="${size}" rx="${size * 0.24}" fill="#f5c518"/>`
    + `<rect x="${c - cw / 2}" y="${top}" width="${cw}" height="${ch}" rx="${size * 0.04}" fill="#111111"/>`
    + `<rect x="${c - bw / 2}" y="${top + ch - bh * 0.35}" width="${bw}" height="${bh}" rx="${bh * 0.5}" fill="#111111"/>`
    + `</svg>`;
  return { svg: Buffer.from(svg), box };
}

// A QR is fully determined by its (joinUrl, print) pair and the static brand chip, so caching the
// rendered data URL avoids re-running QRCode + sharp on every request. Bounded so it can't grow
// without limit (oldest entry evicted — Map preserves insertion order).
const qrCache = new Map<string, string>();
const QR_CACHE_MAX = 500;
async function renderQrDataUrl(joinUrl: string, print: boolean): Promise<string> {
  const key = `${print ? 'p' : 'i'}|${joinUrl}`;
  const hit = qrCache.get(key);
  if (hit) return hit;
  const width = print ? 1024 : 512;
  const qrBuf = await QRCode.toBuffer(joinUrl, { margin: 4, width, errorCorrectionLevel: 'H', color: { dark: '#000000', light: '#ffffff' } });
  const chip = brandChip(width);
  const off = Math.round((width - chip.box) / 2);
  const withLogo = await sharp(qrBuf).composite([{ input: chip.svg, top: off, left: off }]).png().toBuffer();
  const dataUrl = `data:image/png;base64,${withLogo.toString('base64')}`;
  if (qrCache.size >= QR_CACHE_MAX) qrCache.delete(qrCache.keys().next().value as string);
  qrCache.set(key, dataUrl);
  return dataUrl;
}

// ── GET /api/events/:joinCode/qr ─────────────────────────────────────────────

router.get('/:joinCode/qr', async (req: Request, res: Response) => {
  const event = await eventByIdentifier(String(req.params.joinCode));
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const base     = baseUrl(req);
  const joinPath = event.slug ? `/e/${event.slug}` : `/join/${event.joinCode}`;
  // A printed mission card can name the set it belongs to, so the guest who scans THAT card is
  // handed THAT card's list. Without it the join falls back to round-robin and the card in
  // someone's hand can disagree with the app, which defeats the point of printing several.
  //
  // Validated against the event's own sets rather than echoed: this ends up in a QR that gets
  // printed hundreds of times, so a typo must fail here and not at the table.
  const wantSet = typeof req.query.set === 'string' ? req.query.set.trim().toLowerCase() : '';
  const setKey  = wantSet && readSets(event.challenges).some((s) => s.key === wantSet) ? wantSet : '';
  const joinUrl  = base + joinPath + (setKey ? `?set=${encodeURIComponent(setKey)}` : '');

  // Every QR is rendered the SAME way — black-on-white, high error-correction ('H', ~30%
  // recoverable) with the Snapdini brand mark punched into the centre — so the in-app, saved and
  // poster QR codes all look identical. ?print=1 just bumps the resolution for clean printing.
  const print = req.query.print === '1' || req.query.print === 'true';
  res.json({ qrCode: await renderQrDataUrl(joinUrl, print), joinUrl });
});

// ── requireOrganizer middleware ───────────────────────────────────────────────

// Is this user an ACCEPTED co-host of the event? (Co-hosts manage by identity like the owner.)
async function isAcceptedCohost(eventId: string, userId: string): Promise<boolean> {
  const [r] = await db.select({ id: eventCohosts.id }).from(eventCohosts)
    .where(and(eq(eventCohosts.eventId, eventId), eq(eventCohosts.userId, userId), eq(eventCohosts.status, 'accepted')));
  return !!r;
}

export async function requireOrganizer(req: Request, res: Response, next: NextFunction): Promise<void> {
  const event = await eventByIdentifier(String(req.params.joinCode));
  if (!event) { res.status(404).json({ error: 'Event not found' }); return; }

  // Tenant authorization: the authenticated owner manages their own event by identity —
  // no organizer code needed. (Event existence is already public via the join flow, so
  // the 404 above leaks nothing new.)
  const user = await auth.currentUser(req);
  if (user && event.ownerUserId && user.id === event.ownerUserId) {
    req.event = event;
    return next();
  }

  // Accepted co-hosts manage the event by identity, exactly like the owner (no organizer code).
  if (user && await isAcceptedCohost(event.id, user.id)) {
    req.event = event;
    return next();
  }

  // Fallback: the organizer-code capability. Required for anonymous (unowned) events, and
  // still accepted for owned events so shared admin links / co-organizers keep working.
  // Header or JSON body only — never the query string (keeps the long-lived organizer secret out
  // of access logs / browser history). The frontend sends it via the x-organizer-code header.
  const organizerCode = req.get('x-organizer-code') || req.body?.organizerCode;
  if (!organizerCode) { res.status(401).json({ error: 'Organizer code required' }); return; }
  if (organizerCode !== event.organizerCode) { res.status(403).json({ error: 'Invalid organizer code' }); return; }

  req.event = event;
  next();
}

// ── GET /api/events/:joinCode/admin ──────────────────────────────────────────

router.get('/:joinCode/admin', requireOrganizer, async (req: Request, res: Response) => {
  const ev = req.event!;
  const now = Date.now();
  const participantRows = await db.select({
    id: participants.id,
    name: participants.name,
    email: participants.email,
    photosTaken: participants.photosTaken,
    joinedAt: participants.joinedAt,
    requestedMoreAt: participants.requestedMoreAt,
    challengeSet: participants.challengeSet,
    wantsPhotos: participants.wantsPhotos,
  }).from(participants).where(eq(participants.eventId, ev.id)).orderBy(participants.joinedAt);
  const [{ c: photoCount }] = await db.select({ c: count() }).from(photos).where(eq(photos.eventId, ev.id));
  // "Pending" only means "needs action" when moderation is ON. With it off, pending photos are
  // already live, so there's nothing awaiting approval — report 0 so the UI doesn't nag.
  const [{ c: pendingRows }] = await db.select({ c: count() }).from(photos)
    .where(and(eq(photos.eventId, ev.id), eq(photos.status, 'pending')));
  const pendingCount = ev.moderationEnabled ? pendingRows : 0;

  const base     = baseUrl(req);
  const joinPath = ev.slug ? `/e/${ev.slug}` : `/join/${ev.joinCode}`;

  // Flat shape consumed directly by admin.js (no nested `event`).
  // How many tricks each guest has actually pulled off, for the participants list.
  //
  // ONE grouped query, not one per guest: a 150-guest event would otherwise be 150 round trips to
  // render a single card, which is exactly the kind of thing that makes an admin page feel broken
  // at the size where it matters most.
  //
  // Scoped to the card the guest is HOLDING, the same way the camera scopes their progress. A host
  // can move somebody to a different card, and shots taken against the old card's tricks must not
  // keep counting — otherwise the number here disagrees with the number in their camera.
  const tricksByParticipant = new Map<string, number>();
  if (readSets(ev.challenges).length) {
    const offeredBySet = new Map<string, Set<string>>();
    for (const set of readSets(ev.challenges)) offeredBySet.set(set.key, new Set(set.items.map((i) => i.id)));
    const firstSet = readSets(ev.challenges)[0];
    const doneRows = await db
      .select({ participantId: photos.participantId, challengeId: photos.challengeId })
      .from(photos)
      .where(and(eq(photos.eventId, ev.id), isNotNull(photos.challengeId)));
    const seen = new Map<string, Set<string>>();   // participant → distinct challenge ids
    for (const r of doneRows) {
      if (!r.challengeId) continue;
      let set = seen.get(r.participantId);
      if (!set) { set = new Set(); seen.set(r.participantId, set); }
      set.add(r.challengeId);
    }
    for (const p of participantRows) {
      const offered = offeredBySet.get(p.challengeSet || '') ?? offeredBySet.get(firstSet?.key ?? '') ?? new Set<string>();
      const done = seen.get(p.id);
      if (!done) continue;
      let n = 0;
      for (const id of done) if (offered.has(id)) n++;
      if (n) tricksByParticipant.set(p.id, n);
    }
  }

  res.json({
    id:             ev.id,
    name:           ev.name,
    blurb:          ev.blurb || null,
    joinCode:       ev.joinCode,
    slug:           ev.slug || null,
    joinUrl:        base + joinPath,
    galleryUrl:     `${base}/gallery/${ev.slug || ev.joinCode}`,
    maxPhotos:      ev.maxPhotos,
    revealMode:     ev.revealMode,
    revealDelayHours: ev.revealDelayHours,
    revealAt:       ev.revealAt,
    moderationEnabled: !!ev.moderationEnabled,
    ratingMode:     ev.ratingMode || 'favourite',
    timezone:       ev.timezone || null,
    aspectRatios:   ev.aspectRatios ? JSON.parse(ev.aspectRatios) : ['1:1'],
    startsAt:       ev.startsAt,
    expiresAt:      ev.expiresAt,
    isUpcoming:     now < ev.startsAt,
    isExpired:      now > ev.expiresAt,
    // Reschedule eligibility, same rule the PUT /settings guard enforces: an event nobody ever
    // joined can be moved even after it has ended. The admin UI needs this to decide whether to
    // enable the start date/time fields.
    canReschedule:   now < ev.startsAt || (participantRows.length === 0 && Number(photoCount) === 0),
    rescheduleUntil: (ev.originalStartsAt ?? ev.startsAt) + RESCHEDULE_WINDOW_MS,
    isLocked:       !!ev.isLocked,
    isRevealed:     isRevealed(ev),
    revealedAt:     ev.revealedAt,
    allowDownloads: !!ev.allowDownloads,
    // Host-only settings: these must never appear on the public event GET, which guests read.
    guestMayBuyShots:  !!ev.guestMayBuyShots,
    guestMayBuyVideo:  !!ev.guestMayBuyVideo,
    guestMayBuyFrames: !!ev.guestMayBuyFrames,
    guestMayRequest:   !!ev.guestMayRequest,
    // Reported against the server switch so the host UI can hide the control entirely
    // rather than offering a toggle that does nothing.
    faceMatchingEnabled:   faceMatchingAvailable() && !!ev.faceMatchingEnabled,
    faceMatchingAvailable: faceMatchingAvailable(),
    // Guests who asked for more. Shown on the host's own pages, never pushed at them mid-event.
    upgradeRequests:   participantRows.filter((r) => !!(r as { requestedMoreAt?: number | null }).requestedMoreAt).length,
    noFlash:        !!ev.noFlash,
    theme:          ev.theme ? JSON.parse(ev.theme) : null,
    // entitlement (for the upgrades section; only meaningful when billing is on)
    guestCap:       ev.guestCap,
    videoSeconds:   ev.videoSeconds,
    retentionDays:  ev.retentionDays,
    paid:           !!ev.paid,
    amountPaidCents: ev.amountPaidCents,
    // ── Guest delivery (0046) — current state, for the settings screen ──────
    guestDelivery:      ev.guestDelivery,
    // The scope a send would ACTUALLY use: 'favourites_manual' is a scope as much as a mode, and a
    // stale guest_send_scope of 'all' must not be shown as though it would widen it.
    guestSendScope:     effectiveGuestScope(ev),
    guestSendAt:        ev.guestSendAt ?? null,
    guestMailThanks:    !!ev.guestMailThanks,
    guestMailReminder:  !!ev.guestMailReminder,
    guestMailLive:      !!ev.guestMailLive,
    // When the gallery opens to everyone, or null when only the host can open it. The same value
    // the guest emails are keyed to, so the screen and the mail cannot disagree about the date.
    guestReleaseAt:     revealOpensAt(ev),
    // Non-null once each message has gone. The host's UI reads these as "sent", not as settings.
    guestsSentAt:         ev.guestsSentAt ?? null,
    guestThanksSentAt:    ev.guestThanksSentAt ?? null,
    guestReminderSentAt:  ev.guestReminderSentAt ?? null,
    // How many guests would actually be mailed: they asked AND we have somewhere to send it.
    guestsWantingPhotos: participantRows.filter((r) => r.wantsPhotos && !!r.email).length,
    posterConfig:   readPosterConfig(ev.posterConfig),
    eventType:      ev.eventType ?? null,
    challengeSets:  readSets(ev.challenges),
    challengeTick:  readTick(ev.challenges),
    purged:         !!ev.purgedAt,
    participantCount: participantRows.length,
    photoCount,
    pendingCount,
    participants:   participantRows.map((p) => ({
      id: p.id, name: p.name, email: p.email,
      photosTaken: p.photosTaken, joinedAt: p.joinedAt,
      challengeSet: p.challengeSet,
      wantsPhotos: !!p.wantsPhotos,
      tricksDone: tricksByParticipant.get(p.id) ?? 0,
    })),
    emailEnabled:   email.enabled,
  });
});

// ── POST /api/events/:joinCode/highlights — set/unset highlight on photo ids ───

router.post('/:joinCode/highlights', requireOrganizer, async (req: Request, res: Response) => {
  const { photoIds: rawIds, highlight } = req.body as { photoIds?: unknown; highlight?: unknown };
  if (!Array.isArray(rawIds) || rawIds.length === 0)
    return res.status(400).json({ error: 'photoIds must be a non-empty array' });
  // Cap the array so a huge id list can't blow up the IN(...) query (param limit / DoS).
  const photoIds = rawIds.map(String).slice(0, 5000);

  // Favourite == rating 5; keep both in sync so the two curation surfaces never disagree.
  // NOTE: featuring does NOT change moderation status — approve is a separate, explicit action.
  await db.update(photos)
    .set({ isHighlighted: !!highlight, rating: highlight ? 5 : 0 })
    .where(and(inArray(photos.id, photoIds), eq(photos.eventId, req.event!.id)));
  res.json({ success: true, highlightCount: photoIds.length, highlight: !!highlight });
});

// ── PUT /api/events/:joinCode/challenges — save the photo missions + event type ──
// Mirrors the poster endpoint: a small bounded blob owned by the organizer.
//
// This used to be the ONLY way event type was ever set — the reasoning being that asking at
// creation would add a question to the flow we most want frictionless. The cost of that was
// invisible and total: every event was created "unstated", so the mission packs, the tick glyphs
// and the card decorations all fell back to generic unless a host happened to open the missions
// editor. Nine packs and nine decorations, unreachable by default. Creation asks now; this endpoint
// still updates it, because changing the type later must still retheme the cards.
router.put('/:joinCode/challenges', requireOrganizer, async (req: Request, res: Response) => {
  const body = req.body as { eventType?: unknown; challenges?: unknown; tick?: unknown };
  const sets = parseChallengeSets(body.challenges);
  if (sets === null) return res.status(400).json({ error: 'challenges must be a list, or {sets:[…]}' });
  const tick = parseTick(body.tick);
  const blob = serialiseSets(sets, tick);
  await db.update(events)
    .set({ eventType: parseEventType(body.eventType), challenges: blob })
    .where(eq(events.id, req.event!.id));
  // Echo what was STORED, so a host whose malformed entry was dropped finds out now rather than on
  // the printed card. serialiseSets returns null when there are no usable sets, and the tick lives
  // INSIDE that blob — so echoing the parsed tick there would report a glyph that was never saved.
  res.json({ success: true, sets, tick: blob ? tick : null, max: MAX_CHALLENGES, maxSets: MAX_SETS });
});

// The poster designer's saved settings. This is NOT a budget the host spends — every text field in
// the designer is maxlength-capped, so a design with all of them full is about 2kB and a real one is
// nearer 1kB. The ceiling exists only so a client bug cannot turn a settings column into a document
// store that the organizer payload then parses on every load. express.json() caps the request at
// 100kB anyway; staying under that means an oversized design gets OUR error instead of an opaque
// body-parser rejection. If a host should be able to put MORE on a poster, the lever is the
// maxlength on the inputs and whether the layout can fit it — not this number.
const MAX_POSTER_CONFIG = 64000;

// Never let a bad row take the event page down with it. Anything unparseable — a blob truncated by
// the old .slice(), a hand-edited row — reads as "no saved design", which is recoverable: the host
// opens the designer and saves again. A throw here is not.
function readPosterConfig(raw: string | null): unknown {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// ── PUT /api/events/:joinCode/poster — save the poster designer customisation ──
router.put('/:joinCode/poster', requireOrganizer, async (req: Request, res: Response) => {
  const config = (req.body as { config?: unknown }).config;
  // A bounded JSON blob (poster text/colours/toggles — no untrusted execution). This used to be
  // truncated with .slice(), which is the one thing you must never do to JSON: a blob cut mid-string
  // is unparseable, and the organizer payload below parses it on every load, so one oversized design
  // would have locked the host out of their own event page. Refuse it instead — a design that big is
  // a bug on our side, and the host gets told rather than silently losing their work.
  const json = config && typeof config === 'object' ? JSON.stringify(config) : null;
  if (json && json.length > MAX_POSTER_CONFIG) {
    res.status(413).json({ error: 'That design is too detailed to save. Simplify it and try again.' });
    return;
  }
  await db.update(events).set({ posterConfig: json }).where(eq(events.id, req.event!.id));
  res.json({ success: true });
});

// ── Slideshow (experimental) — generate an MP4 from the event's photos ─────────
router.post('/:joinCode/slideshow', requireOrganizer, async (req: Request, res: Response) => {
  const b = req.body as { favouritesOnly?: boolean; track?: string; tracks?: unknown; loopMusic?: boolean; secondsPer?: number; includeVideos?: boolean; keepVideoAudio?: boolean; quality?: string; branding?: boolean };
  const favouritesOnly = b.favouritesOnly === true;
  const includeVideos = b.includeVideos === true;
  const keepVideoAudio = b.keepVideoAudio === true;
  const track = typeof b.track === 'string' ? b.track : undefined;
  const tracks = Array.isArray(b.tracks) ? b.tracks.filter((t): t is string => typeof t === 'string').slice(0, 10) : undefined;
  const loopMusic = b.loopMusic !== false;
  const secondsPer = Number.isFinite(b.secondsPer) ? Number(b.secondsPer) : undefined;
  const quality = typeof b.quality === 'string' ? b.quality : undefined;
  const resolution = typeof (b as { resolution?: string }).resolution === 'string' ? (b as { resolution?: string }).resolution : undefined;
  const order = typeof (b as { order?: string }).order === 'string' ? (b as { order?: string }).order : undefined;
  // Removing the Snapdini intro/outro is a paid add-on — only honour branding=false when entitled.
  const wantNoBranding = b.branding === false;
  if (wantNoBranding && !brandingRemovable(req.event!))
    return res.status(402).json({ error: 'Removing the Snapdini frames needs the add-on — purchase it first' });
  const branding = !wantNoBranding;
  const job = startSlideshow(req.event!.id, { favouritesOnly, track, tracks, loopMusic, secondsPer, includeVideos, keepVideoAudio, quality, resolution, branding, order });
  res.json(job);
});
router.get('/:joinCode/slideshow', requireOrganizer, async (req: Request, res: Response) => {
  res.json(await slideshowInfo(req.event!.id));
});
// Favourite a render → kept for the event's full retention window (others auto-purge after a day).
router.post('/:joinCode/slideshow/:id/favourite', requireOrganizer, async (req: Request, res: Response) => {
  const favourite = await toggleSlideshowFavourite(req.event!.id, String(req.params.id));
  res.json({ ok: true, favourite });
});
router.delete('/:joinCode/slideshow/:id', requireOrganizer, async (req: Request, res: Response) => {
  const ok = await deleteSlideshow(req.event!.id, String(req.params.id));
  res.status(ok ? 200 : 404).json({ ok });
});
// Download a render with a friendly filename (<event>-<date>-snapdini.mp4). ?res=1080p on a 4K
// render transcodes it down live and streams it; otherwise the stored file is sent as-is.
router.get('/:joinCode/slideshow/:id/download', requireOrganizer, async (req: Request, res: Response) => {
  const info = await slideshowFile(req.event!.id, String(req.params.id));
  if (!info) return res.status(404).json({ error: 'Slideshow not found' });

  const safe = (req.event!.name || 'snapdini').replace(/[^a-z0-9\-_]+/gi, '_').slice(0, 40) || 'snapdini';
  const date = new Date(req.event!.startsAt).toISOString().slice(0, 10);   // YYYY-MM-DD, no breaking chars
  const want1080 = (req.query.res === '1080p') && info.resolution === '4k';
  const fname = `${safe}-${date}-snapdini${want1080 ? '-1080p' : ''}.mp4`;
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);

  if (want1080) {
    const job = streamSlideshow1080(info.path, res);
    res.on('close', () => job.kill());   // client aborted → stop the encode
  } else {
    fs.createReadStream(info.path).pipe(res);
  }
});

// ── POST /api/events/:joinCode/rate — set a 0–5 rating on one photo ────────────
// rating 5 == favourite (kept in sync with is_highlighted); 0 clears it.

router.post('/:joinCode/rate', requireOrganizer, async (req: Request, res: Response) => {
  const { photoId } = req.body as { photoId?: string };
  const rating = Math.min(Math.max(parseInt((req.body as { rating?: unknown }).rating as string, 10) || 0, 0), 5);
  if (!photoId) return res.status(400).json({ error: 'photoId required' });

  // Favourite (★, rating ≥ 5) just marks the highlight — it does NOT approve. Approval is a
  // separate, explicit moderation action (so favouriting a pending photo doesn't publish it).
  const fav = rating >= 5;
  const result = await db.update(photos)
    .set({ rating, isHighlighted: fav })
    .where(and(eq(photos.id, photoId), eq(photos.eventId, req.event!.id)));
  if (!result.rowCount) return res.status(404).json({ error: 'Photo not found' });
  res.json({ success: true, photoId, rating, isHighlighted: fav });
});

// ── Share links ───────────────────────────────────────────────────────────────
// kind 'all' = the whole (visible) gallery · 'favourites' = the favourite-starred subset ·
// 'selected' = a hand-picked subset (photoIds). Each gets a pretty, editable /s/<slug> URL.
// Friendly default name for a share — leads with the event name so link previews read well
// (e.g. "Sam & Riley's wedding — 4 photos"). The owner can rename it in the share modal.
const shareDefaultLabel = (eventName: string, kind: string, n: number) => {
  const base = (eventName || '').trim() || 'Event';
  if (kind === 'favourites') return `${base} — favourites`;
  if (kind === 'selected') return `${base} — ${n} photo${n === 1 ? '' : 's'}`;
  return `${base} — gallery`;
};
const sharePhotoCount = (photoIds: string | null): number | null => {
  if (!photoIds) return null;
  try { const p = JSON.parse(photoIds); return Array.isArray(p) ? p.length : null; } catch { return null; }
};

router.post('/:joinCode/shares', requireOrganizer, async (req: Request, res: Response) => {
  const body = req.body as { kind?: string; photoIds?: unknown; label?: string };
  const kind = body.kind === 'favourites' ? 'favourites' : body.kind === 'selected' ? 'selected' : 'all';
  const ids = kind === 'selected' && Array.isArray(body.photoIds) ? body.photoIds.map(String).filter(Boolean).slice(0, 2000) : null;
  if (kind === 'selected' && (!ids || !ids.length)) return res.status(400).json({ error: 'Select at least one photo to share' });
  // Normalise the photo set (sorted) so the SAME selection always produces the same stored value —
  // lets us reuse one "smart link" per identical content instead of minting a new one each time.
  const photoIds = ids ? JSON.stringify([...ids].sort()) : null;
  const ret = (s: { id: string; slug: string | null; label: string | null; kind: string }) =>
    res.json({ token: s.id, slug: s.slug, label: s.label, kind: s.kind, url: `${baseUrl(req)}/s/${s.slug || s.id}` });

  // Reuse an existing share for the same content (whole gallery / favourites / this exact selection).
  const existing = (await db.select().from(shares).where(and(eq(shares.eventId, req.event!.id), eq(shares.kind, kind))))
    .find((s) => kind !== 'selected' || (s.photoIds || null) === photoIds);
  if (existing) return ret(existing);

  // No pretty slug by default — the link uses the unique token (/s/<token>). The owner can claim a
  // named /s/<custom> URL later from the share modal; this avoids burning nice slugs nobody asked for.
  const label = (typeof body.label === 'string' && body.label.trim()) ? body.label.trim().slice(0, 80) : shareDefaultLabel(req.event!.name, kind, ids?.length || 0);
  const token = uuidv4().replace(/-/g, '');
  await db.insert(shares).values({ id: token, eventId: req.event!.id, kind, photoIds, label, slug: null, createdAt: Date.now() });
  ret({ id: token, slug: null, label, kind });
});

// List every share for the event (so the owner can copy / rename / delete them).
router.get('/:joinCode/shares', requireOrganizer, async (req: Request, res: Response) => {
  const rows = await db.select().from(shares).where(eq(shares.eventId, req.event!.id)).orderBy(desc(shares.createdAt));
  res.json({ shares: rows.map((s) => ({
    id: s.id, kind: s.kind, slug: s.slug,
    label: s.label || shareDefaultLabel(req.event!.name, s.kind, sharePhotoCount(s.photoIds) || 0),
    count: sharePhotoCount(s.photoIds),
    url: `${baseUrl(req)}/s/${s.slug || s.id}`, createdAt: s.createdAt,
  })) });
});

// Rename a share (label) and/or change its custom URL (slug) — so the same link keeps working.
router.patch('/:joinCode/shares/:id', requireOrganizer, async (req: Request, res: Response) => {
  const { label, slug } = req.body as { label?: string; slug?: string };
  const [row] = await db.select().from(shares).where(and(eq(shares.id, String(req.params.id)), eq(shares.eventId, req.event!.id)));
  if (!row) return res.status(404).json({ error: 'Share not found' });
  const patch: { label?: string; slug?: string } = {};
  if (typeof label === 'string' && label.trim()) patch.label = label.trim().slice(0, 80);
  if (typeof slug === 'string' && slug.trim()) {
    const desired = slugify(slug).slice(0, 60);
    if (desired.length < 2) return res.status(400).json({ error: 'Custom URL must be at least 2 characters' });
    if (desired !== row.slug) {
      const [clash] = await db.select({ id: shares.id }).from(shares).where(eq(shares.slug, desired));
      if (clash && clash.id !== row.id) return res.status(409).json({ error: 'That custom URL is already taken' });
      patch.slug = desired;
    }
  }
  if (Object.keys(patch).length) await db.update(shares).set(patch).where(eq(shares.id, row.id));
  const finalSlug = patch.slug ?? row.slug;
  res.json({ ok: true, slug: finalSlug, label: patch.label ?? row.label, url: `${baseUrl(req)}/s/${finalSlug || row.id}` });
});

router.delete('/:joinCode/shares/:id', requireOrganizer, async (req: Request, res: Response) => {
  await db.delete(shares).where(and(eq(shares.id, String(req.params.id)), eq(shares.eventId, req.event!.id)));
  res.json({ ok: true });
});

// ── PUT /api/events/:joinCode/theme ──────────────────────────────────────────

router.put('/:joinCode/theme', requireOrganizer, async (req: Request, res: Response) => {
  const { theme } = req.body as { theme?: unknown };
  if (!theme || typeof theme !== 'object') return res.status(400).json({ error: 'Invalid theme' });

  const sanitized = sanitizeTheme(theme as Record<string, unknown>);

  await db.update(events).set({ theme: JSON.stringify(sanitized) }).where(eq(events.id, req.event!.id));
  res.json({ success: true, theme: sanitized });
});

// ── POST /api/events/:joinCode/allow-downloads ────────────────────────────────

router.post('/:joinCode/allow-downloads', requireOrganizer, async (req: Request, res: Response) => {
  const allow = (req.body as { allowDownloads?: boolean }).allowDownloads !== false;
  await db.update(events).set({ allowDownloads: allow }).where(eq(events.id, req.event!.id));
  res.json({ success: true, allowDownloads: allow });
});

// ── Emailing a link, and remembering that you did ─────────────────────────────
//
// One route for both kinds of link, because they differ only in which URL goes in the button:
// omit shareId and it is the event's standing gallery link; pass one and it is a curated share the
// host made. Two routes would have meant two copies of the address parsing, the send loop, the
// rate cap and the recording, to serve one nullable field.
//
// Every attempt is written to share_sends, successes and failures alike. Before this the route
// sent and forgot, so "have I already sent this to Mum?" had no answer and a bounce left no trace.

/** Parse, validate and de-duplicate a submitted address list. Case-insensitive on the duplicate
 *  check, since Mum@example.com and mum@example.com are one person and two rows would say
 *  otherwise. */
function parseAddresses(raw: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of Array.isArray(raw) ? raw : []) {
    const addr = String(e).trim();
    if (!isEmail(addr)) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

router.post('/:joinCode/email-link', requireOrganizer, async (req: Request, res: Response) => {
  if (!email.enabled) return res.status(503).json({ error: 'Email not configured on this server' });
  const body = req.body as { emails?: unknown; shareId?: unknown };
  const list = parseAddresses(body.emails);
  if (list.length === 0) return res.status(400).json({ error: 'No valid email addresses provided' });

  const ev      = req.event!;
  const base    = baseUrl(req);
  const wantedShare = typeof body.shareId === 'string' && body.shareId ? body.shareId : null;

  // Look the share up rather than trusting the id: it scopes the query to THIS event, so an
  // organizer code for one event cannot be used to mail out another event's share link.
  let share: typeof shares.$inferSelect | null = null;
  if (wantedShare) {
    const [row] = await db.select().from(shares)
      .where(and(eq(shares.id, wantedShare), eq(shares.eventId, ev.id)));
    if (!row) return res.status(404).json({ error: 'That shared link no longer exists' });
    share = row;
  }

  const galPath  = ev.slug ? `/gallery/${ev.slug}` : `/gallery/${ev.joinCode}`;
  const linkUrl  = share ? `${base}/s/${share.slug || share.id}` : base + galPath;
  const joinPath = ev.slug ? `/e/${ev.slug}` : `/join/${ev.joinCode}`;
  const joinUrl  = base + joinPath;
  const safeName = escapeHtml(ev.name);   // organizer-controlled → escape in outbound HTML
  // The host's own name for the share, when they gave it one. It is their words in an email that
  // carries our branding, so it is escaped like any other organizer-controlled string.
  const shareLabel = share?.label ? escapeHtml(share.label) : '';

  const subject = share
    ? `${share.label || 'Photos'} from ${ev.name} 📷`
    : `Gallery from ${ev.name} 📷`;

  // A curated share is a selection someone chose to send, so the email says so and does NOT carry
  // the join code — that invites people into the event itself, which is the opposite of the point
  // of handing out a narrowed link.
  const body_html = share
    ? `
      <p>${shareLabel ? `<strong>${shareLabel}</strong> from ` : 'Photos from '}${safeName} are ready to view.</p>
      <p style="margin:24px 0"><a href="${linkUrl}" class="btn">View photos →</a></p>`
    : `
      <p>The event gallery is ready to view.</p>
      <p style="margin:24px 0"><a href="${linkUrl}" class="btn">View Gallery →</a></p>
      <p>Or share the event and join code <strong>${escapeHtml(ev.joinCode)}</strong> at:<br>
      <a href="${joinUrl}">${joinUrl}</a></p>`;

  // Two presses of Send used to be two identical emails to everyone: the address list was deduped
  // within the request and nothing looked at what had already gone out. share_sends is that record,
  // so read it — and it also holds the guest sends (guest-delivery.ts), so a host who types in an
  // address their guest was already sent this link at does not send them a second copy of it.
  //
  // `resend: true` is the host saying they meant it — a bounce, or someone who deleted the mail —
  // and is the only way an address that already has a delivered send for THIS link gets another.
  //
  // A ledger we cannot READ must not block a send the host asked for: the worst case there is the
  // duplicate this guard exists to avoid, which is a smaller failure than a link nobody gets.
  const resend = (req.body as { resend?: unknown }).resend === true;
  let alreadySent = new Set<string>();
  if (!resend) {
    try {
      const prior = await db.select({ email: shareSends.email }).from(shareSends).where(and(
        eq(shareSends.eventId, ev.id),
        share ? eq(shareSends.shareId, share.id) : isNull(shareSends.shareId),
        eq(shareSends.ok, true),
      ));
      alreadySent = new Set(prior.map((r) => (r.email || '').trim().toLowerCase()));
    } catch (e) { console.error('[email-link] could not read prior sends', e); }
  }

  const now = Date.now();
  const rows: (typeof shareSends.$inferInsert)[] = [];
  let sent = 0, errors = 0, skipped = 0;
  for (const addr of list.slice(0, 200)) {
    if (alreadySent.has(addr.toLowerCase())) { skipped++; continue; }
    let ok = true;
    try {
      await email.sendMail({
        to: addr,
        subject,
        html: email.htmlEmail(share ? `${share.label || 'Photos'} from ${safeName}` : `Gallery from ${safeName}`, body_html),
      });
      sent++;
    } catch { ok = false; errors++; }
    rows.push({ id: uuidv4(), eventId: ev.id, shareId: share?.id ?? null, email: addr, ok, sentAt: now });
  }
  // One insert rather than one per address: a 200-address send is a single round trip, and the
  // whole batch either lands or does not. A failed WRITE must not fail the response — the mail has
  // genuinely gone out by this point, and reporting an error would invite a re-send of all of it.
  try { if (rows.length) await db.insert(shareSends).values(rows); }
  catch (e) { console.error('[email-link] could not record sends', e); }

  // `skipped` is addresses that already had this exact link. Reported rather than folded into
  // `sent`, so the host can see that Mum was not emailed twice AND that she was emailed.
  res.json({ sent, errors, skipped });
});

// Who this event's links have been emailed to. One query for the lot — the admin page groups them
// by share client-side, which is cheaper than a request per link and keeps the ordering consistent.
router.get('/:joinCode/link-sends', requireOrganizer, async (req: Request, res: Response) => {
  const ev = req.event!;
  const rows = await db.select().from(shareSends)
    .where(eq(shareSends.eventId, ev.id))
    .orderBy(desc(shareSends.sentAt))
    .limit(1000);
  res.json({
    sends: rows.map((r) => ({ shareId: r.shareId, email: r.email, ok: r.ok, sentAt: r.sentAt })),
  });
});

// ── PUT /api/events/:joinCode/settings — edit schedule / reveal / moderation ───

router.put('/:joinCode/settings', requireOrganizer, async (req: Request, res: Response) => {
  const ev = req.event!;
  const { name, blurb, startDate, startTime, revealMode,
          revealDelayHours, revealDate, revealTime, moderationEnabled, allowDownloads, noFlash, timezone, ratingMode, slug,
                  guestMayBuyShots, guestMayBuyVideo, guestMayBuyFrames, guestMayRequest, faceMatchingEnabled } = req.body as {
              guestMayBuyShots?: boolean; guestMayBuyVideo?: boolean; guestMayBuyFrames?: boolean;
    guestMayRequest?: boolean; faceMatchingEnabled?: boolean;
    name?: string; blurb?: string; startDate?: string; startTime?: string;
    revealMode?: string; revealDelayHours?: number | string; revealDate?: string; revealTime?: string;
    moderationEnabled?: boolean;
    allowDownloads?: boolean; noFlash?: boolean; timezone?: string; ratingMode?: string; slug?: string;
  };

  // Custom event URL (slug): settable / changeable / clearable after creation.
  // undefined → leave as-is · '' → clear · a value → slugify, validate length + availability.
  let newSlug = ev.slug;
  if (slug !== undefined) {
    const trimmed = typeof slug === 'string' ? slug.trim() : '';
    if (!trimmed) {
      newSlug = null;
    } else {
      const desired = slugify(trimmed);
      if (desired.length < 2) return res.status(400).json({ error: 'Custom URL must be at least 2 characters' });
      if (desired !== ev.slug) {
        if (!(await isSlugAvailable(desired))) return res.status(409).json({ error: 'That custom URL is already taken' });
        newSlug = desired;
      }
    }
  }

  const newName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 80) : ev.name;
  // Blurb: explicit string updates it (trimmed/capped; empty string clears it); undefined leaves as-is.
  const newBlurb = blurb === undefined ? ev.blurb : (typeof blurb === 'string' && blurb.trim() ? blurb.trim().slice(0, 280) : null);

  // Start: prefer a client-computed epoch (user's TZ); else parse date/time; else keep current.
  // Reschedule policy: the gate is USAGE, not time. An event that no guest ever joined can be
  // moved even after it has ended — the common support case is an organizer who bought, never got
  // the QR in front of anyone, and watched the window lapse unused. The moment one guest joins or
  // one photo exists the start locks for good, so a live event can never shift under its guests.
  // `originalStartsAt` anchors the ceiling, otherwise repeated moves walk the event forward forever.
  const anchorStart = ev.originalStartsAt ?? ev.startsAt;
  const [pCount] = await db.select({ n: count() }).from(participants).where(eq(participants.eventId, ev.id));
  const [phCount] = await db.select({ n: count() }).from(photos).where(eq(photos.eventId, ev.id));
  const everUsed = Number(pCount?.n || 0) > 0 || Number(phCount?.n || 0) > 0;
  const alreadyStarted = Date.now() >= ev.startsAt;
  const canReschedule = !alreadyStarted || !everUsed;

  let startsAt = ev.startsAt;
  const bodyStartsAt = (req.body as { startsAt?: number }).startsAt;
  let requestedStart: number | null = null;
  if (typeof bodyStartsAt === 'number' && bodyStartsAt > 0) requestedStart = bodyStartsAt;
  else if (startDate) {
    const parsed = new Date(`${startDate}T${startTime || '00:00'}`).getTime();
    if (!isNaN(parsed)) requestedStart = parsed;
  }
  // Tolerance: the client recomputes the epoch on every save, so only treat a real move as a move.
  if (requestedStart !== null && Math.abs(requestedStart - ev.startsAt) > 60_000) {
    if (!canReschedule) {
      return res.status(409).json({ error: 'This event has already started and guests have joined, so the start time is locked.' });
    }
    if (requestedStart < Date.now()) {
      return res.status(400).json({ error: 'Pick a start time in the future.' });
    }
    if (requestedStart > anchorStart + RESCHEDULE_WINDOW_MS) {
      return res.status(400).json({ error: 'An event can be moved up to 6 months from its original start date.' });
    }
    startsAt = requestedStart;
  }
  // Duration is a PAID entitlement — only the Upgrades flow changes it. Settings may reschedule
  // the start, but the event's LENGTH is preserved (shift expiry to keep the same paid span);
  // this also closes a free-extend hole where Settings could lengthen an event without paying.
  const curHours = (ev.expiresAt - ev.startsAt) / 3_600_000;
  const expiresAt = startsAt + curHours * 3_600_000;

  const validModes = ['instant', 'at_end', 'manual'];
  const mode = validModes.includes(revealMode as string) ? (revealMode as string) : ev.revealMode;
  let revealDelay = 0;
  if (mode === 'at_end') {
    if (revealDelayHours !== undefined) revealDelay = Math.min(Math.max(parseInt(revealDelayHours as string, 10) || 0, 0), 168);
    else revealDelay = ev.revealMode === 'at_end' ? ev.revealDelayHours : 0;
  }
  // Moderation only applies to non-instant reveal; instant always shows everything.
  let moderation = (moderationEnabled === undefined) ? ev.moderationEnabled : (moderationEnabled === true);
  if (mode === 'instant') moderation = false;
  const allowDl  = (allowDownloads === undefined) ? ev.allowDownloads : (allowDownloads !== false);
  const noFlashV = (noFlash === undefined) ? ev.noFlash : (noFlash === true);
  const tz       = (timezone === undefined) ? ev.timezone : ((typeof timezone === 'string' && timezone) ? timezone.slice(0, 64) : null);
  // Frame sizes are a PAID entitlement (the frame pack). Settings must NOT let an organizer add
  // non-square shapes without paying — that's what the Upgrades flow (Stripe) is for. We accept a
  // requested set only if: billing is off (self-host), OR it's a subset of what the event already
  // has (toggling/removing entitled shapes, incl. promo-unlocked), OR re-quoting shows it costs no
  // more than already paid (free tiers quote to $0, so they can freely pick any shape).
  let aspects = ev.aspectRatios;
  let aspectsRefused = false;
  const reqAspectsRaw = (req.body as { aspectRatios?: unknown }).aspectRatios;
  if (reqAspectsRaw !== undefined) {
    const reqA = sanitizeAspects(reqAspectsRaw);
    const cur: string[] = (() => { try { const p = JSON.parse(ev.aspectRatios || '["1:1"]'); return Array.isArray(p) ? p : ['1:1']; } catch { return ['1:1']; } })();
    const isSubset = reqA.every((a) => cur.includes(a));
    if (!billingEnabled || isSubset) {
      aspects = JSON.stringify(reqA);
    } else {
      const q = quote({ maxGuests: ev.guestCap, maxPhotos: ev.maxPhotos, aspectRatios: reqA,
        videoSeconds: ev.videoSeconds, durationHours: curHours, retentionDays: ev.retentionDays });
      if (q.amountCents <= (ev.amountPaidCents || 0)) {
        aspects = JSON.stringify(q.aspectRatios);
      } else {
        // Keep saving the rest of the settings, but do NOT pretend this part happened. The client
        // used to get a bare 200 and a "Settings saved" toast while the shapes went back.
        aspects = ev.aspectRatios;
        aspectsRefused = true;
      }
    }
  }
  const rMode    = (ratingMode === 'favourite' || ratingMode === 'stars') ? ratingMode : (ev.ratingMode || 'favourite');
  // Use the event's OWN retention window (a paid extension may exceed the global default) so a
  // settings save doesn't silently shorten retention the organizer paid to extend.
  const purgeAt  = expiresAt + (ev.retentionDays || RETENTION_DAYS) * DAY_MS;

  // The custom reveal instant. Three cases, and the middle one is the one that has to be right:
  //   · the key is absent — an older client, or a save that only touched the name, must not clear a
  //     reveal the host set on another screen;
  //   · a preset rung was chosen — that is the host asking for the delay rule back, so the absolute
  //     instant goes;
  //   · REVEAL_CUSTOM — re-resolved against the zone and end this save is writing, because moving
  //     the event or its timezone changes what the host's own wall time means.
  // Anything but 'at_end' has no schedule at all.
  let revealAt: number | null = null;
  if (mode === 'at_end') {
    if (revealDelayHours === undefined) revealAt = ev.revealMode === 'at_end' ? ev.revealAt : null;
    else if (String(revealDelayHours) === REVEAL_CUSTOM) {
      const r = resolveCustomReveal(revealDate, revealTime, tz, purgeAt);
      if ('error' in r) return res.status(400).json({ error: r.error });
      revealAt = r.at;
    }
  }

  // ── Guest delivery (0046) ──────────────────────────────────────────────────
  // Every field is written only when its key is present, the same rule the guest-purchase toggles
  // follow: a save from an older client, or one that only touched the name, must not switch a
  // host's guest delivery to something they never chose.
  const gBody = req.body as Record<string, unknown>;
  const guestDelivery  = parseGuestDelivery(gBody.guestDelivery === undefined ? ev.guestDelivery : gBody.guestDelivery);
  const guestSendScope = parseGuestSendScope(gBody.guestSendScope === undefined ? ev.guestSendScope : gBody.guestSendScope);
  // Clamped against the reveal THIS SAVE is writing, not the one on the row. Moving the event, its
  // timezone or its reveal moves the floor, and checking the old one would store a send the new
  // reveal has just put in the past — which is the single failure this invariant exists to stop.
  const guestTiming: GuestTiming = {
    revealMode: mode, revealedAt: ev.revealedAt, revealHidden: ev.revealHidden,
    revealAt, revealDelayHours: revealDelay, startsAt, expiresAt,
    guestDelivery, guestSendAt: ev.guestSendAt, guestSendScope,
  };
  let guestSendAt: number | null = null;
  let guestSendAtClamped = false;
  if (guestDelivery === 'scheduled') {
    const said = gBody.guestSendAt !== undefined || gBody.guestSendDate !== undefined || gBody.guestSendTime !== undefined;
    if (!said) {
      // Nothing new was said about the moment. Keep the stored one — but re-clamp it, because the
      // reveal may have just moved past it.
      if (ev.guestSendAt === null)
        return res.status(400).json({ error: 'Pick the date and time you want your guests sent the link.' });
      const c = clampGuestSendAt(ev.guestSendAt, revealOpensAt(guestTiming));
      guestSendAt = c.at; guestSendAtClamped = c.clamped;
    } else {
      const g = resolveGuestSendAt(gBody, tz, guestTiming);
      if ('error' in g) return res.status(400).json({ error: g.error });
      guestSendAt = g.at; guestSendAtClamped = g.clamped;
    }
  }
  // Any other mode has no scheduled moment at all, so a stored one is cleared rather than left to
  // fire if the host ever switches back.

  // A rescheduled event is live again, so clear any archive marker. Retention can purge an unused
  // event's (empty) media before the organizer gets round to moving it; without this the event
  // would come back carrying purgedAt and read as archived forever. Safe because reschedule is only
  // permitted while the event has no participants and no photos — there is nothing to un-delete.
  const clearedPurgedAt = startsAt !== ev.startsAt ? { purgedAt: null } : {};

  await db.update(events).set({
    ...clearedPurgedAt,
    name: newName, blurb: newBlurb, startsAt, expiresAt, revealMode: mode,
    revealDelayHours: revealDelay, revealAt, moderationEnabled: moderation, allowDownloads: allowDl,
    noFlash: noFlashV,
    // Only written when the key is present: a settings save from an older client, or one that only
    // touches the name, must not silently switch guest top-ups off.
    ...(typeof guestMayBuyShots  === 'boolean' ? { guestMayBuyShots }  : {}),
    ...(typeof guestMayBuyVideo  === 'boolean' ? { guestMayBuyVideo }  : {}),
    ...(typeof guestMayBuyFrames === 'boolean' ? { guestMayBuyFrames } : {}),
    ...(typeof guestMayRequest   === 'boolean' ? { guestMayRequest }   : {}),
    ...(typeof faceMatchingEnabled === 'boolean' && faceMatchingAvailable() ? { faceMatchingEnabled } : {}), timezone: tz, slug: newSlug, aspectRatios: aspects, ratingMode: rMode, purgeAt,
    guestDelivery, guestSendScope, guestSendAt,
    ...(typeof gBody.guestMailThanks   === 'boolean' ? { guestMailThanks:   gBody.guestMailThanks }   : {}),
    ...(typeof gBody.guestMailReminder === 'boolean' ? { guestMailReminder: gBody.guestMailReminder } : {}),
    ...(typeof gBody.guestMailLive     === 'boolean' ? { guestMailLive:     gBody.guestMailLive }     : {}),
  }).where(eq(events.id, ev.id));

  res.json({
    success: true, name: newName, startsAt, expiresAt, revealMode: mode,
    revealDelayHours: revealDelay, revealAt, moderationEnabled: moderation, allowDownloads: allowDl,
    noFlash: noFlashV, timezone: tz, slug: newSlug, aspectRatios: aspects ? JSON.parse(aspects) : ['1:1'], ratingMode: rMode,
    aspectsRefused,
    guestDelivery, guestSendScope, guestSendAt,
    guestMailThanks:   typeof gBody.guestMailThanks   === 'boolean' ? gBody.guestMailThanks   : !!ev.guestMailThanks,
    guestMailReminder: typeof gBody.guestMailReminder === 'boolean' ? gBody.guestMailReminder : !!ev.guestMailReminder,
    guestMailLive:     typeof gBody.guestMailLive     === 'boolean' ? gBody.guestMailLive     : !!ev.guestMailLive,
    guestReleaseAt:    revealOpensAt(guestTiming),
    // True when the moment the host asked for was before the reveal and we moved it up to it. The
    // UI must say so: showing a different time back with no explanation is how a host learns to
    // distrust the form.
    guestSendAtClamped,
  });
});

// ── POST /api/events/:joinCode/send-guest-link — send the gallery link now ────
//
// The host's own button, and the only way the two manual delivery modes ever send anything. It
// shares every rule with the sweep (guest-delivery.ts sendGuestLink) — the same recipients, the
// same reveal check, the same empty-scope refusal — because a manual send that could reach a guest
// the automatic one would not is a second set of rules to keep in step.
//
// One difference, deliberate: an empty scope is REPORTED here rather than emailed to the host. They
// are looking at the answer. The sweep has no one in front of it, so it writes to them instead.
router.post('/:joinCode/send-guest-link', requireOrganizer, async (req: Request, res: Response) => {
  if (!email.enabled) return res.status(503).json({ error: 'Email not configured on this server' });
  const ev = req.event!;
  const scope = req.body?.scope === undefined ? effectiveGuestScope(ev) : parseGuestSendScope(req.body.scope);
  const r = await sendGuestLink(ev, { scope, base: baseUrl(req) });

  if (r.refused === 'read_failed')
    return res.status(503).json({ error: 'Could not check who to send to — nothing was sent. Try again in a moment.', reason: r.refused });
  if (r.refused === 'email_disabled')
    return res.status(503).json({ error: 'Email not configured on this server', reason: r.refused });
  if (r.refused === 'not_revealed')
    return res.status(409).json({ error: 'The photos are not revealed yet, so the link would open on a locked page. Reveal them first.', reason: r.refused, recipients: r.recipients });
  if (r.refused === 'empty_scope')
    return res.status(409).json({
      error: scope === 'favourites'
        ? 'Nothing is starred yet, so the favourites link would be empty. Star some photos first.'
        : 'There are no visible photos yet, so the link would be empty.',
      reason: r.refused, scope, recipients: r.recipients, photoCount: 0,
    });

  // Not faults: nobody asked, or everybody already has it. Both are "there is nothing to do",
  // which the host should be told plainly rather than as an error.
  if (r.refused === 'no_recipients' || r.refused === 'already_sent')
    return res.json({ sent: 0, skipped: r.recipients, errors: 0, scope: r.scope, photoCount: r.photoCount, recipients: r.recipients, reason: r.refused });

  // Claim the send-once guard so the sweep does not follow this with a second copy. Only if it is
  // still NULL — a host sending by hand after the automatic send has gone must not overwrite when
  // that happened.
  try {
    await db.update(events).set({ guestsSentAt: Date.now() })
      .where(and(eq(events.id, ev.id), isNull(events.guestsSentAt)));
  } catch (e) { console.error('[send-guest-link] could not stamp guests_sent_at', e); }

  res.json({ sent: r.sent, skipped: r.skipped, errors: r.errors, scope: r.scope, photoCount: r.photoCount, recipients: r.recipients });
});

// ── POST /api/events/:joinCode/moderate — approve / reject pending photos ──────

router.post('/:joinCode/moderate', requireOrganizer, async (req: Request, res: Response) => {
  const { photoIds: rawIds, action } = req.body as { photoIds?: unknown; action?: string };
  if (!Array.isArray(rawIds) || rawIds.length === 0)
    return res.status(400).json({ error: 'photoIds must be a non-empty array' });
  if (!['approve', 'reject', 'restore'].includes(action as string))
    return res.status(400).json({ error: "action must be 'approve', 'reject' or 'restore'" });
  // Cap the array so a huge id list can't blow up the IN(...) query (param limit / DoS).
  const photoIds = rawIds.map(String).slice(0, 5000);

  // Reject = move to the "rejected" bin (NOT a hard delete). Rejected photos are excluded from
  // every shared/gallery/download view (those all require status='approved') but stay on disk so
  // the organizer can restore them. Restore returns a photo to 'pending' — so under moderation it
  // re-enters the approval queue (showing the Approve button again) rather than auto-publishing,
  // and with moderation off 'pending' is already visible. Final purge still removes everything.
  const status = action === 'approve' ? 'approved' : action === 'restore' ? 'pending' : 'rejected';
  await db.update(photos).set({ status })
    .where(and(inArray(photos.id, photoIds), eq(photos.eventId, req.event!.id)));
  res.json({ success: true, action, status, count: photoIds.length });
});

// ── POST /api/events/:joinCode/reveal ─────────────────────────────────────────

router.post('/:joinCode/reveal', requireOrganizer, async (req: Request, res: Response) => {
  // Reveal now + clear any hide override.
  await db.update(events).set({ revealedAt: Date.now(), revealHidden: false }).where(eq(events.id, req.event!.id));
  res.json({ success: true });
});

// ── POST /api/events/:joinCode/unreveal ───────────────────────────────────────

router.post('/:joinCode/unreveal', requireOrganizer, async (req: Request, res: Response) => {
  // Hide override (wins even over an ended at_end event) + clear any early-reveal timestamp.
  await db.update(events).set({ revealedAt: null, revealHidden: true }).where(eq(events.id, req.event!.id));
  res.json({ success: true });
});

// ── POST /api/events/:joinCode/lock ──────────────────────────────────────────

router.post('/:joinCode/lock', requireOrganizer, async (req: Request, res: Response) => {
  const newLocked = !req.event!.isLocked;
  await db.update(events).set({ isLocked: newLocked }).where(eq(events.id, req.event!.id));
  res.json({ success: true, isLocked: newLocked });
});

// ── DELETE /api/events/:joinCode ──────────────────────────────────────────────

router.delete('/:joinCode', requireOrganizer, async (req: Request, res: Response) => {
  // Deleting an OWNED event is reserved for the original creator — co-hosts (and the shared
  // organizer code) manage everything else but can't nuke someone else's event.
  const ev = req.event!;
  if (ev.ownerUserId) {
    const user = await auth.currentUser(req);
    if (!user || user.id !== ev.ownerUserId)
      return res.status(403).json({ error: 'Only the event owner can delete this event' });
  }
  await cleanup.deleteEventFiles(ev.id);            // remove photos + theme files from disk
  await db.delete(events).where(eq(events.id, ev.id)); // cascade clears participant/photo/cohost rows
  res.json({ success: true });
});

// ── Co-hosts ───────────────────────────────────────────────────────────────────
// Owner + co-hosts can list/invite/remove co-hosts. The original creator (ownerUserId) is never a
// co-host row, so this can never remove them.
router.get('/:joinCode/cohosts', requireOrganizer, async (req: Request, res: Response) => {
  const ev = req.event!;
  const me = await auth.currentUser(req);
  let owner: { id: string; email: string; displayName: string | null } | null = null;
  if (ev.ownerUserId) {
    const [o] = await db.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(eq(users.id, ev.ownerUserId));
    owner = o ?? null;
  }
  const rows = await db.select({
    id: eventCohosts.id, email: eventCohosts.email, status: eventCohosts.status,
    userId: eventCohosts.userId, token: eventCohosts.token, createdAt: eventCohosts.createdAt,
  }).from(eventCohosts).where(eq(eventCohosts.eventId, ev.id)).orderBy(eventCohosts.createdAt);
  res.json({
    owner: owner ? { email: owner.email, name: owner.displayName || owner.email } : null,
    youAreOwner: !!me && !!ev.ownerUserId && me.id === ev.ownerUserId,
    // The accept link is exposed only for still-pending invites so the host can copy/share it
    // directly (e.g. message it) without waiting on the email. Accepted co-hosts don't need it.
    cohosts: rows.map((r) => ({
      id: r.id, email: r.email, status: r.status, accepted: r.status === 'accepted',
      inviteUrl: r.status === 'accepted' ? null : `${baseUrl(req)}/cohost/${r.token}`,
      createdAt: r.createdAt,
    })),
  });
});

router.post('/:joinCode/cohosts', requireOrganizer, async (req: Request, res: Response) => {
  const ev = req.event!;
  const me = await auth.currentUser(req);
  const inviteEmail = String((req.body as { email?: string }).email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inviteEmail)) return res.status(400).json({ error: 'Enter a valid email address' });
  // Don't invite the owner, or anyone already invited/accepted on this event.
  if (ev.ownerUserId) {
    const [o] = await db.select({ email: users.email }).from(users).where(eq(users.id, ev.ownerUserId));
    if (o && o.email.toLowerCase() === inviteEmail) return res.status(400).json({ error: 'That person already owns this event' });
  }
  const [existing] = await db.select({ id: eventCohosts.id }).from(eventCohosts)
    .where(and(eq(eventCohosts.eventId, ev.id), eq(eventCohosts.email, inviteEmail)));
  if (existing) return res.status(409).json({ error: 'That email is already a co-host (or invited)' });

  const token = crypto.randomBytes(24).toString('hex');
  await db.insert(eventCohosts).values({
    id: uuidv4(), eventId: ev.id, email: inviteEmail, userId: null, status: 'invited',
    token, invitedByUserId: me?.id ?? null, createdAt: Date.now(), acceptedAt: null,
  });

  const link = `${baseUrl(req)}/cohost/${token}`;
  const inviter = me?.displayName || me?.email || 'A Snapdini host';
  if (email.enabled) {
    try {
      await email.sendMail({
        to: inviteEmail,
        subject: `You've been invited to co-host "${ev.name}" on Snapdini`,
        html: email.htmlEmail('Co-host invitation',
          `<p><strong>${escapeHtml(inviter)}</strong> invited you to co-host <strong>${escapeHtml(ev.name)}</strong> on Snapdini — you'll be able to manage the event just like they can.</p>
           <p><a href="${link}" style="display:inline-block;padding:11px 18px;background:#f5c518;color:#111;border-radius:8px;font-weight:700;text-decoration:none">Accept invitation →</a></p>
           <p style="color:#888;font-size:13px">If you don't have a Snapdini account yet, you'll be able to create one in a moment. If you didn't expect this, you can ignore this email.</p>`),
      });
    } catch { /* best-effort; dev link still returned below */ }
  }
  res.json({ ok: true, devLink: process.env.NODE_ENV !== 'production' ? link : undefined });
});

router.delete('/:joinCode/cohosts/:id', requireOrganizer, async (req: Request, res: Response) => {
  const ev = req.event!;
  await db.delete(eventCohosts).where(and(eq(eventCohosts.id, String(req.params.id)), eq(eventCohosts.eventId, ev.id)));
  res.json({ ok: true });
});

// ── DELETE /api/events/:joinCode/participants/:id — remove a participant (e.g. a duplicate join) ──
// Their photos go too: we delete the files here, and the photo ROWS cascade when the participant is
// removed (photos.participantId ON DELETE CASCADE). The UI warns about the photo count first.
router.delete('/:joinCode/participants/:id', requireOrganizer, async (req: Request, res: Response) => {
  const ev = req.event!;
  const [p] = await db.select().from(participants).where(and(eq(participants.id, String(req.params.id)), eq(participants.eventId, ev.id)));
  if (!p) return res.status(404).json({ error: 'Participant not found' });
  const rows = await db.select({ filename: photos.filename }).from(photos).where(eq(photos.participantId, p.id));
  for (const r of rows) cleanup.unlinkUpload(r.filename);   // remove files; rows cascade on delete
  await db.delete(participants).where(eq(participants.id, p.id));
  res.json({ ok: true, removedPhotos: rows.length });
});

// ── PUT /api/events/:joinCode/participants/:id/card — move a guest to a different trick card ──
//
// Cards are handed out round-robin at join, and a guest who scanned the wrong table's card was
// stuck with it: challenge_set was written once, at insert, and nothing could change it after.
// Scanning the right card later does not help either — a returning guest keeps the card they were
// given, which is deliberate (it is what stops them shopping around for easier tricks) but leaves a
// genuine mis-scan with no way out. So the HOST can move them, the same way they can already remove
// a guest who joined twice.
//
// Nothing is destroyed by moving. Progress is derived from photos.challenge_id and scoped to the
// card being held, so ticks for the old card stop counting and come back if they are moved back.
router.put('/:joinCode/participants/:id/card', requireOrganizer, async (req: Request, res: Response) => {
  const ev = req.event!;
  const [p] = await db.select().from(participants)
    .where(and(eq(participants.id, String(req.params.id)), eq(participants.eventId, ev.id)));
  if (!p) return res.status(404).json({ error: 'Participant not found' });

  // Only a card THIS event actually has. An arbitrary key would leave the guest holding a set that
  // does not exist, and missionsFor() would fall back to the first one — a silent wrong answer.
  const sets = readSets(ev.challenges);
  const want = String((req.body as { set?: unknown })?.set ?? '').trim().toLowerCase();
  if (!sets.some((x) => x.key === want))
    return res.status(400).json({ error: 'That card is not part of this event' });

  await db.update(participants).set({ challengeSet: want }).where(eq(participants.id, p.id));
  const set = sets.find((x) => x.key === want)!;
  res.json({ ok: true, challengeSet: want, label: set.label, tricks: set.items.length });
});

export default router;
