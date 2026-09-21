import crypto from 'crypto';
import { MAIL_BATCH_SIZE } from '../../../../shared/mail-batch';
import fs from 'fs';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { eq, and, or, sql, inArray, count, desc, isNotNull, isNull, asc } from 'drizzle-orm';
import { db } from '../db';
import { parseChallengeSets, readSets, readTick, parseTick, serialiseSets, parseEventType, nextEventType, reseatParticipant, MAX_CHALLENGES, MAX_SETS } from '../challenges';
import { events, participants, photos, photoComments, commentHearts, shareVisitors, shares, shareSends, eventCohosts, users, type Event } from '../schema';
import { thumbName } from '../images';
import { faceMatchingAvailable } from '../faces';
import * as email from '../email';
import * as auth from '../auth';
import { recordAdminAction } from '../admin-actions';
import * as cleanup from '../cleanup';
import { DEMO_NAME, RESCHEDULE_WINDOW_MS, RETENTION_DAYS, baseUrl, isDemoEvent, isRevealed, purgeAtFor, purgeAtForEvent } from '../lib';
import { normaliseAddress } from '../delivery';
import { referrerFromCookie, isSelfReferral } from '../referrals';
import { startSlideshow, slideshowInfo, toggleSlideshowFavourite, deleteSlideshow, slideshowFile, streamSlideshow1080 } from '../slideshow';
import { billingEnabled, quote, FREE_ALL_GUESTS, brandingRemovable, RETENTION_PAID_DAYS, customPlanError } from '../billing';
import { sendWelcome } from '../lifecycle';
import options from '../options';
import { REVEAL_CUSTOM, ceilToRevealTick, clampRevealAt, revealInstantRefusal, zonedWallTimeToMs } from '../../../../shared/reveal';
import { parseGuestDelivery, parseGuestSendScope, effectiveGuestScope, revealOpensAt,
         clampGuestSendAt, sendGuestLink, type GuestTiming } from '../guest-delivery';
import { isReservedSlug, RESERVED_SLUG_ERROR } from '../slugs';
import { galleryLinkEmail, cohostInviteEmail } from '../inline-emails';

const router = Router();

// Photos + event are auto-deleted this many days after the event ends (retention).
// Plan-scaled windows arrive with billing; this is the self-host/free default.
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
/** Just the instant the host's wall-clock choice means. Null when it is not a time at all.
 *
 *  Split out from the validation below because the settings route needs to know WHETHER this save
 *  is changing the reveal before it decides whether an old value is this save's to refuse. */
function customRevealInstant(date: unknown, time: unknown, timezone: string | null): number | null {
  const at = zonedWallTimeToMs(String(date ?? ''), String(time ?? ''), timezone || 'UTC');
  // Rounded before it is stored, never on the way out, so the instant the host was shown when they
  // picked it is the instant every countdown and every gate reads back afterwards.
  return at === null ? null : ceilToRevealTick(at);
}

const PICK_A_TIME = 'Pick the date and time you want the photos revealed.';

/** …and the whole answer: the instant, or the reason in the host's words that it cannot be one.
 *
 *  `expiresAt` is here because it was NOT here, and that is the defect: only the purge ceiling was
 *  ever checked, so a reveal in the past — or at any instant before the event ends — saved happily
 *  and opened the gallery to the public while the party was still running. See
 *  revealInstantRefusal() in shared/reveal.ts for what each bound costs when it is missing. */
function resolveCustomReveal(
  date: unknown, time: unknown, timezone: string | null,
  window: { expiresAt: number; purgeAt: number },
  now: number = Date.now(),
): { at: number } | { error: string } {
  const at = customRevealInstant(date, time, timezone);
  if (at === null) return { error: PICK_A_TIME };
  const why = revealInstantRefusal(at, window, now);
  return why ? { error: why } : { at };
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
  // Reserved words are folded in here rather than checked beside each call, so a call site added
  // later is safe by default — it just reports the less precise "already taken" wording. The three
  // callers that can produce a better message check isReservedSlug() first; see slugs.ts.
  if (isReservedSlug(slug)) return false;
  // A slug must not be able to BE another event's JOIN CODE. Every identifier lookup in the product
  // is `joinCode = upper(x) OR slug = lower(x)`, and slugify() can produce any string of
  // [a-z0-9-] — including the lowercase of a real join code, which is printed on a poster for
  // anybody to read. Without this check somebody could name their own event after a stranger's join
  // code and put two events behind one URL; what a guest scanning that poster then joined would
  // come down to which row the planner returned first.
  //
  // Checked against join codes as well as slugs, in one query. The resolvers also prefer the join
  // code on a tie, so neither half of this stands alone.
  const [row] = await db.select({ id: events.id }).from(events)
    .where(or(eq(events.slug, slug), eq(events.joinCode, slug.toUpperCase())));
  return !row;
}

// Resolve an event by its URL identifier. Join codes are stored uppercase and slugs lowercase,
// each on its own index — so two targeted equality lookups (the common join-code case resolves in
// the first) beat an OR across both columns, which can't always use both indexes.
export async function eventByIdentifier(raw: string): Promise<Event | undefined> {
  // ONE round trip, not two. Every pretty-slug URL — which is most of the links a host hands out —
  // used to pay a join-code lookup that could never match before it asked the question it meant.
  // `EXPLAIN` gives this a clean BitmapOr over `events_join_code_unique` + `idx_events_slug`.
  //
  // JOIN CODE STILL WINS. The two namespaces can collide (an event's slug may equal another's
  // lowercased join code), and a join code is the stronger claim, so the sort makes the choice
  // explicit rather than leaving it to whichever row the planner happens to return first.
  const rows = await db.select().from(events)
    .where(or(eq(events.joinCode, raw.toUpperCase()), eq(events.slug, raw.toLowerCase())))
    .limit(2);
  if (rows.length < 2) return rows[0];
  return rows.find((r) => r.joinCode === raw.toUpperCase()) ?? rows[0];
}

// Theme values are organizer-supplied and injected into the public gallery's CSS, so
// validate them server-side (CSP is the primary guard; this is defense-in-depth).
const COLOR_KEYS = ['bg', 'surface', 'surface2', 'border', 'text', 'textMuted', 'accent', 'accentDark'];
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$|^(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$|^[a-zA-Z]{3,24}$/;
// Same-origin upload path: no quotes/parens/spaces, and no ".." segment. The dot has to stay —
// file extensions need it — which is exactly what let "/uploads/../../etc/passwd" through the old
// pattern, so the traversal is excluded explicitly instead. The lookahead scans from index 0 on
// purpose: placed after the "/uploads/" prefix it has no preceding slash to anchor on, and
// "/uploads/.." walks straight past it. uploadDiskPath() re-checks containment on the way to
// disk and is the load-bearing guard; this one just keeps the bad value out of the database.
const UPLOADS_PATH_RE = /^(?!.*(?:^|\/)\.\.(?:\/|$))\/uploads\/[A-Za-z0-9._/-]+$/;
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

/** A crop rectangle in the source image's own 0–1 coordinates: "sx,sy,sw,sh".
 *
 *  A STRING rather than an object, so the theme column stays the flat string map it has always
 *  been — no widening of sanitizeTheme's return type, and one regex-ish check instead of a nested
 *  validator. Anything that is not four sane numbers is dropped, exactly like a bad colour:
 *  a missing crop means "not repositioned yet", which every reader already handles.
 *
 *  Width and height must be positive and the rectangle must start inside the image. It may run
 *  past the far edge — the cropper lets a host pull the frame off the picture and fills the
 *  overhang, and rejecting that here would silently discard a crop the editor allowed. */
function sanitizeCrop(raw: unknown): string | null {
  const parts = String(raw).split(',');
  if (parts.length !== 4) return null;
  const n = parts.map((x) => Number(x.trim()));
  if (!n.every((v) => Number.isFinite(v))) return null;
  const [sx, sy, sw, sh] = n;
  if (sw <= 0 || sh <= 0) return null;
  if (sx < -1 || sy < -1 || sx > 1 || sy > 1) return null;
  if (sw > 4 || sh > 4) return null;
  return n.map((v) => v.toFixed(5)).join(',');
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
  // headerImage is the RENDERED crop — what the join screen, gallery hero, OG card and slideshow
  // all read, and the only one of the three that existed before. imageOriginal is the untouched
  // upload it was cut from, kept so the host can reframe later without finding the file again;
  // imageCrop is where the cut was taken. All three are optional and independent: an event that
  // predates this has only the first, and still renders exactly as it did.
  for (const k of ['headerImage', 'imageOriginal'] as const) {
    if (theme[k] !== undefined) {
      const v = String(theme[k]).trim();
      if (UPLOADS_PATH_RE.test(v)) out[k] = v; // only same-origin uploads paths
    }
  }
  if (theme.imageCrop !== undefined) {
    const c = sanitizeCrop(theme.imageCrop);
    if (c) out.imageCrop = c;
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
          startDate, startTime, startsAt: startsAtMs, allowDownloads, noFlash, heartsEnabled, commentsEnabled,
          galleryHeartsEnabled, galleryCommentsEnabled,
          revealDelayHours, revealDate, revealTime, moderationEnabled, timezone, maxGuests, videoSeconds, eventType } = req.body as {
    name?: string; blurb?: string; durationHours?: number | string; maxPhotos?: number | string;
    revealMode?: string; slug?: string; startDate?: string; startTime?: string;
    startsAt?: number; allowDownloads?: boolean; noFlash?: boolean; heartsEnabled?: boolean; commentsEnabled?: boolean;
    galleryHeartsEnabled?: boolean; galleryCommentsEnabled?: boolean;
    revealDelayHours?: number | string;
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
    if (isReservedSlug(slug)) return res.status(409).json({ error: RESERVED_SLUG_ERROR });
    if (!(await isSlugAvailable(slug))) return res.status(409).json({ error: 'That custom URL is already taken' });
  }

  // The timezone is resolved BEFORE the start time, because the start time is parsed against it.
  // It used to be resolved after, so the fallback below had nothing to parse with and fell back to
  // the SERVER's zone — see the note there.
  const eventTz = (typeof timezone === 'string' && timezone) ? timezone.slice(0, 64) : null;

  // Resolve starts_at. Prefer an explicit epoch from the client (computed in the user's
  // own timezone) so we don't reparse a bare date/time string in the server's TZ (UTC).
  let startsAt = Date.now();
  if (typeof startsAtMs === 'number' && startsAtMs > 0) {
    startsAt = startsAtMs;
  } else if (startDate) {
    // zonedWallTimeToMs, not `new Date('YYYY-MM-DDTHH:mm')` — that parses in the SERVER's zone
    // (UTC in the container), so a Sydney planner setting a 6pm start on a Perth event got 6pm UTC:
    // two in the morning, local. The comment above already knew this was the hazard and the
    // fallback did it anyway. Every other wall-clock field in this file goes through this helper.
    const parsed = zonedWallTimeToMs(startDate, startTime || '00:00', eventTz || 'UTC');
    if (parsed !== null) startsAt = parsed;
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
  // A 'custom' quote is a referral, not a price — see MAX_QUOTABLE_GUESTS. Refused here rather than
  // clamped, because clamping would hand somebody who asked for 600 guests a 400-guest event and
  // tell them it worked. Self-hosters (billing off) are unaffected: there is no ladder to fall off.
  // Guests are no longer the only way to fall off: an off-the-ladder durationHours or retentionDays
  // lands here too, and the message names whichever limit it was.
  if (billingEnabled && q.tier === 'custom') return res.status(400).json({ error: customPlanError(q) });
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

  const purgeAt = purgeAtFor(expiresAt, entRetentionDays);

  // Resolved down here rather than beside the mode, because the ceiling it is checked against is
  // the purge, and the purge is not known until the retention entitlement above is.
  let revealAt: number | null = null;
  if (mode === 'at_end' && String(revealDelayHours) === REVEAL_CUSTOM) {
    const r = resolveCustomReveal(revealDate, revealTime, eventTz, { expiresAt, purgeAt });
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
    // Each defaults to the column default when the key is absent, so an older client — or any
    // caller that has never heard of these — creates an event with hearts on and comments off,
    // which is what the schema says and what the wizard offers.
    heartsEnabled:   heartsEnabled !== false,
    commentsEnabled: commentsEnabled === true,
    // Same defaults as the guest pair, and the same shape: absent means "leave it at the default",
    // which for a NEW event is hearts on and comments off.
    // INHERITED from the guest settings above unless the caller says otherwise. A host who has just
    // turned guest comments on has told us what they are comfortable with; starting their gallery
    // link at the opposite is a contradiction they then have to go and undo. Same the other way: a
    // host who turned hearts OFF for guests is unlikely to want them on for the link.
    //
    // Only the STARTING POINT is inherited. The link keeps its own pair from then on — changing the
    // guest settings later never reaches back and rewrites a link the host has already set.
    galleryHeartsEnabled:   galleryHeartsEnabled ?? (heartsEnabled !== false),
    galleryCommentsEnabled: galleryCommentsEnabled ?? (commentsEnabled === true),
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


/** A timezone we are willing to store, or null.
 *
 *  Anything stored here is later handed to Intl by BOTH sides to turn an instant into the wall
 *  clock a host reads, so a junk value does not degrade gracefully — it throws in the formatter
 *  and takes the page with it. `new Intl.DateTimeFormat` is the check because it is the same
 *  implementation that will be asked to use it later: if it accepts the zone here it will accept
 *  it there, which no allow-list of names can promise. */
export function usableTimezone(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 64) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: raw }); return raw; } catch { return null; }
}

router.post('/demo', async (req: Request, res: Response) => {
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
    /* A DEMO GETS A TIMEZONE TOO, and it is not cosmetic.
     *
     * This column was simply never set here, so every demo ever created carried NULL — 59 of the
     * 74 events on production, and every one of them a demo. A null zone makes the event's start
     * an ambiguous wall clock, and the admin settings form then read it as UTC while writing it
     * back in the browser's zone: ten hours apart for a host in Brisbane. The server saw a
     * reschedule nobody asked for and refused the save, taking the name, the blurb and every
     * toggle with it.
     *
     * That bug is fixed on both sides now, but the ambiguity was the thing that made it possible,
     * and a demo is the surface where it mattered most: it is what somebody tries BEFORE they buy.
     * Closing it at the source costs one field.
     *
     * The browser's own zone, because whoever pressed the button is the only person this demo is
     * for. 'UTC' when it is missing or unusable — a real zone, not a null — so the wall clock is
     * always interpretable even if it is occasionally not the visitor's own. */
    timezone: usableTimezone((req.body as { timezone?: unknown } | undefined)?.timezone) ?? 'UTC',
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
  if (isReservedSlug(slug)) return res.json({ available: false, reason: 'Reserved', slug });
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
  // `created_at` alone is not a total order — a host who creates two events in the same
  // millisecond (or from one script) gets a tie whose order is undefined and reshuffles whenever
  // either row is updated. `events.id` last pins it, here and in the co-host query below.
  const owned = await db.select(cols).from(events)
    .where(eq(events.ownerUserId, req.user!.id))
    .orderBy(sql`${events.createdAt} DESC`, events.id);
  // Events this user co-hosts (accepted) but doesn't own — managed like their own, badged "co-host".
  const cohosted = await db.select(cols).from(events)
    .innerJoin(eventCohosts, eq(eventCohosts.eventId, events.id))
    .where(and(eq(eventCohosts.userId, req.user!.id), eq(eventCohosts.status, 'accepted')))
    .orderBy(sql`${events.createdAt} DESC`, events.id);
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

  const isDemo = isDemoEvent(event);
  // Does the person asking MANAGE this event — by identity, not by holding the code? The admin API
  // has always authorised an owner or accepted co-host this way (see requireOrganizer); this simply
  // tells the guest-facing surfaces the same thing, so the camera can offer a host a way back to
  // their own dashboard. Identity is the whole point: being signed in as somebody ELSE must not
  // light this up, and it does not — the check is against THIS event's owner.
  const viewer = await auth.currentUser(req);
  const youManage = await auth.youManage(event, viewer?.id);
  res.json({
    // No organizer code travels with this — it does not need to. The host link it enables is just
    // /admin/<code>, which the server authorises off the session cookie.
    youManage,
    /** Does this event belong to an ACCOUNT at all? Not who — just whether there is one. That is
     *  the difference between "log in as the owner and you are through" and "there is no account
     *  on this event, so the organizer code is the only key that exists" — and without it the code
     *  wall has to give the same unhelpful answer to both. It identifies nobody: the join flow
     *  already makes an event's existence public. */
    hasOwner: !!event.ownerUserId,
    // The guest-facing surfaces need to know whether to draw hearts at all. Two pairs, because the
    // gallery LINK has its own (0064): the first pair is what a guest may do, the second what
    // somebody holding `/gallery/<code>` may do.
    heartsEnabled: !!event.heartsEnabled,
    commentsEnabled: !!event.commentsEnabled,
    galleryHeartsEnabled: !!event.galleryHeartsEnabled,
    galleryCommentsEnabled: !!event.galleryCommentsEnabled,
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
    isDemo:         isDemo,
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
    organizerCode:  isDemo ? event.organizerCode : undefined,
    isUpcoming:     now < event.startsAt,
    isExpired:      now > event.expiresAt,
    // Reschedule eligibility: an event no guest ever used can be moved, even after it has
    // ended, up to 6 months from its ORIGINAL start (see PUT /:joinCode/settings).
    canReschedule:   now < event.startsAt || (Number(participantCount) === 0 && Number(photoCount) === 0),
    rescheduleUntil: (event.originalStartsAt ?? event.startsAt) + RESCHEDULE_WINDOW_MS,
    isLocked:       !!event.isLocked,
    isRevealed:     isRevealed(event),
    /* Is the HOST the only thing standing between the guest and the photos?
     *
     *  True when the host must act: a manual event, or any event whose photos have been explicitly
     *  hidden. False for a timed reveal, where the answer is to wait and the page already shows a
     *  countdown — sending somebody to badger the host about a clock is worse than saying nothing.
     *
     *  Deliberately a derived boolean and not `revealHidden` itself. A guest needs to know whether
     *  asking would help; whether the host actively hid the photos or simply has not revealed them
     *  yet is the host's business, and that distinction stays in the manager. */
    awaitingHost:   !isRevealed(event) && (!!event.revealHidden || event.revealMode === 'manual'),
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

// isAcceptedCohost / youManage now live in ../auth, beside requireAuth and requireAdmin. They were
// moved rather than copied: admin-actions.ts became a third caller of the same rule (it records
// what a site admin does to an event they do NOT manage), and an authorisation test with three
// copies is one where two get fixed and the third quietly does not.

export async function requireOrganizer(req: Request, res: Response, next: NextFunction): Promise<void> {
  const event = await eventByIdentifier(String(req.params.joinCode));
  if (!event) { res.status(404).json({ error: 'Event not found' }); return; }

  // Tenant authorization: the authenticated owner manages their own event by identity —
  // no organizer code needed. (Event existence is already public via the join flow, so
  // the 404 above leaks nothing new.)
  const user = await auth.currentUser(req);
  if (user && event.ownerUserId && user.id === event.ownerUserId) {
    req.event = event;
    req.organizerVia = 'owner';
    return next();
  }

  // Accepted co-hosts manage the event by identity, exactly like the owner (no organizer code).
  if (user && await auth.isAcceptedCohost(event.id, user.id)) {
    req.event = event;
    req.organizerVia = 'cohost';
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
  req.organizerVia = 'code';
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
  // Alphabetical, matching the guest list, because this is read to FIND a person. `joinedAt` is a
  // non-unique bigint, so it was also unstable: a tie group reshuffles when any row in it is
  // updated (an UPDATE rewrites the tuple and a scan then returns it last). `id` last makes the
  // order total, which is the part that actually stops the reshuffle.
  }).from(participants).where(eq(participants.eventId, ev.id)).orderBy(
    sql`lower(${participants.name}) asc nulls last`,
    sql`lower(${participants.email}) asc nulls last`,
    participants.id,
  );
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
    // GROUPED, not row by row. This pulled EVERY photo in the event to JS to build a
    // Map<participant, Set<challenge>> — 14,000 rows over the wire, on a page that refreshes itself
    // every 30 seconds. The answer it builds is bounded by participants x challenges (say 400 x 20),
    // not by how many photos were taken, and `idx_photos_challenge` serves the group directly.
    const doneRows = await db
      .select({ participantId: photos.participantId, challengeId: photos.challengeId })
      .from(photos)
      .where(and(eq(photos.eventId, ev.id), isNotNull(photos.challengeId)))
      .groupBy(photos.participantId, photos.challengeId);
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
    // WHY they are not revealed, not merely that they are not.
    //
    // `isRevealed` collapses several causes into one false — waiting for a delay, waiting for the
    // host, and the explicit "Hide photos" override, which beats all of them. The manager could not
    // tell them apart, so an instant event with the override on still told its host "Instant —
    // photos visible as taken" while every guest saw an empty gallery. Host-only: a guest has no
    // business knowing whether photos exist and are hidden or simply do not exist yet.
    revealHidden:   !!ev.revealHidden,
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
    heartsEnabled:  !!ev.heartsEnabled,
    commentsEnabled: !!ev.commentsEnabled,
    galleryHeartsEnabled: !!ev.galleryHeartsEnabled,
    galleryCommentsEnabled: !!ev.galleryCommentsEnabled,
    /** The organizer code — returned to the OWNER only, so they can hand admin access to somebody
     *  without an account. Every real event has an owner (anonymous creation is demo-only), which
     *  means the code is a convenience rather than the key to anything: the owner always gets in by
     *  logging in. But it was unobtainable — minted at creation, dropped into one URL, and never
     *  shown again — so an owner who wanted to delegate had nothing to send.
     *
     *  NOT for a co-host. They already manage by identity, and this code outlives their removal: a
     *  co-host you take off the event would keep a working key. Withholding it costs them nothing
     *  and closes that. Somebody who authorised WITH the code obviously has it already. */
    organizerCode: (req.organizerVia === 'owner' || req.organizerVia === 'code')
      ? ev.organizerCode : undefined,
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
  //
  // REPORT THE WRITE, NOT THE REQUEST. `photoIds` is host input — ids from a gallery tab left open
  // since before a purge, ids belonging to a different event, ids of photos a guest has deleted.
  // The event-scoped WHERE drops every one of those silently, and echoing `photoIds.length` told
  // the host "3 starred" when the answer was 0. A host who is given the right number never looks
  // again, so a wrong one is not a cosmetic defect: it is the end of the investigation.
  //
  // `.returning()` rather than the driver's rowCount, for the reason routes/participants.ts gives:
  // it is the portable answer across drivers, and it cannot read `undefined` as zero.
  // Read before writing, because the audit log wants the value about to be overwritten and an
  // UPDATE ... RETURNING can only ever hand back the new one. It is one extra index lookup on ids
  // we are updating anyway, at host rates — a few dozen presses an event, against a guest upload
  // path that runs thousands of times. The alternative, asking admin-actions.ts "will this be
  // recorded?" before paying for the read, puts a second copy of that rule at every call site.
  const was = await db.select({ id: photos.id, isHighlighted: photos.isHighlighted, rating: photos.rating })
    .from(photos).where(and(inArray(photos.id, photoIds), eq(photos.eventId, req.event!.id)));
  const starred = await db.update(photos)
    .set({ isHighlighted: !!highlight, rating: highlight ? 5 : 0 })
    .where(and(inArray(photos.id, photoIds), eq(photos.eventId, req.event!.id)))
    .returning({ id: photos.id });
  // Keyed by PHOTO ID rather than by field name — the set-of-targets half of the before/after
  // contract (see 0068_admin_actions.sql). The ids come from `was`, i.e. the rows that actually
  // exist in this event, so a host input list full of stale ids does not pad the log.
  await recordAdminAction(req, {
    event: req.event!, action: 'photo.highlight', targetType: 'photo', targetId: null,
    before: Object.fromEntries(was.map((p) => [p.id, { isHighlighted: !!p.isHighlighted, rating: p.rating }])),
    after:  Object.fromEntries(was.map((p) => [p.id, { isHighlighted: !!highlight, rating: highlight ? 5 : 0 }])),
  });
  res.json({ success: true, highlightCount: starred.length, highlight: !!highlight });
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
  // serialiseSets returns null for TWO unrelated reasons: an empty list, which legitimately stores
  // null, and a list too large to store. Writing the second one wiped the host's trick list and
  // then answered `success: true` with the full list echoed back from what was PARSED — so the
  // screen showed the lists they had just lost, and nothing anywhere said so. Refused instead.
  if (sets.length && blob === null) {
    return res.status(413).json({
      error: 'That trick list is too long to save. Shorten a few of the lines, or remove some, and try again.',
    });
  }
  await db.update(events)
    // nextEventType, not parseEventType: an ABSENT key must leave the setting alone, and
    // parseEventType turns undefined into null — so a client that did not mention eventType wiped
    // it. PUT /settings was given this helper in this release for exactly that reason; this is the
    // other endpoint writing the same column, and it was still doing the old thing.
    .set({ eventType: nextEventType(body.eventType, req.event!.eventType), challenges: blob })
    .where(eq(events.id, req.event!.id));

  // ── Guests whose card this save just deleted ────────────────────────────────
  //
  // Without this the deletion is silent and total for them: every read falls through setByKey's
  // `?? sets[0]` to somebody else's card, their ticks read zero, the captions on photos they have
  // already taken resolve to nothing, and their source is 'self'/'qr' so the "which card are you?"
  // question never comes back. They are simply moved to card A and told nothing.
  //
  // Done here rather than in the read path on purpose. A read has to answer with SOMETHING and
  // cannot durably change anything; this is the one moment the set of valid keys actually changes,
  // and the one place a decision about it belongs. reseatParticipant() carries the rules.
  const holders = await db.select({ id: participants.id, challengeSet: participants.challengeSet })
    .from(participants).where(eq(participants.eventId, req.event!.id));
  // Grouped by the state they are moving TO, so a 200-guest event costs at most a couple of
  // statements rather than one per guest inside a request the host is waiting on. There are only
  // ever two distinct targets — the first remaining card, or no card at all.
  const moves = new Map<string, { key: string | null; source: string | null; ids: string[] }>();
  for (const h of holders) {
    const next = reseatParticipant(sets, { key: h.challengeSet });
    if (!next) continue;
    const k = `${next.key}|${next.source}`;
    const m = moves.get(k) ?? { key: next.key, source: next.source, ids: [] };
    m.ids.push(h.id);
    moves.set(k, m);
  }
  let reseated = 0;
  for (const m of moves.values()) {
    const movedGuests = await db.update(participants)
      .set({ challengeSet: m.key, challengeSetSource: m.source })
      .where(inArray(participants.id, m.ids))
      .returning({ id: participants.id });
    // The write's own answer, for the same reason as /moderate and /highlights: a guest removed
    // between the read above and this update is not a guest who was reseated.
    reseated += movedGuests.length;
  }

  // Echo what was STORED, so a host whose malformed entry was dropped finds out now rather than on
  // the printed card. serialiseSets returns null when there are no usable sets, and the tick lives
  // INSIDE that blob — so echoing the parsed tick there would report a glyph that was never saved.
  // `reseated` is how many guests will be asked which card they are holding when they next open the
  // camera — worth saying out loud to a host who has just deleted one.
  res.json({ success: true, sets, tick: blob ? tick : null, reseated, max: MAX_CHALLENGES, maxSets: MAX_SETS });
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
  const body = req.body as { kind?: string; photoIds?: unknown; label?: string;
                             heartsEnabled?: boolean; commentsEnabled?: boolean };
  // Only an explicit boolean counts as an instruction — `undefined` means "the caller didn't ask",
  // which must not quietly switch a link's reactions off.
  const flags: { heartsEnabled?: boolean; commentsEnabled?: boolean } = {};
  if (typeof body.heartsEnabled === 'boolean') flags.heartsEnabled = body.heartsEnabled;
  if (typeof body.commentsEnabled === 'boolean') flags.commentsEnabled = body.commentsEnabled;
  // Not told? Start where the EVENT is. A fixed default is a guess about a host we already know
  // something about: if they left guest comments off, a new link defaulting them on is the wrong
  // guess, and the same in reverse. The schema defaults stay as the backstop for any row written
  // without going through here.
  //
  // Read from the event as it is NOW, not as it was when it was created — the host may well have
  // changed their mind since, and the most recent decision is the better guess.
  if (flags.heartsEnabled === undefined) flags.heartsEnabled = !!req.event!.heartsEnabled;
  if (flags.commentsEnabled === undefined) flags.commentsEnabled = !!req.event!.commentsEnabled;
  const kind = body.kind === 'favourites' ? 'favourites' : body.kind === 'selected' ? 'selected' : 'all';
  const ids = kind === 'selected' && Array.isArray(body.photoIds) ? body.photoIds.map(String).filter(Boolean).slice(0, 2000) : null;
  if (kind === 'selected' && (!ids || !ids.length)) return res.status(400).json({ error: 'Select at least one photo to share' });
  // Normalise the photo set (sorted) so the SAME selection always produces the same stored value —
  // lets us reuse one "smart link" per identical content instead of minting a new one each time.
  const photoIds = ids ? JSON.stringify([...ids].sort()) : null;
  const ret = (s: { id: string; slug: string | null; label: string | null; kind: string;
                    heartsEnabled?: boolean; commentsEnabled?: boolean }) =>
    res.json({ token: s.id, slug: s.slug, label: s.label, kind: s.kind,
               heartsEnabled: !!s.heartsEnabled, commentsEnabled: !!s.commentsEnabled,
               url: `${baseUrl(req)}/s/${s.slug || s.id}` });

  // Reuse an existing share for the same content (whole gallery / favourites / this exact selection).
  const existing = (await db.select().from(shares).where(and(eq(shares.eventId, req.event!.id), eq(shares.kind, kind))))
    .find((s) => kind !== 'selected' || (s.photoIds || null) === photoIds);
  if (existing) {
    // Reuse hands back the SAME link, so the switches the host EXPLICITLY set have to land on it —
    // else the dialog would show hearts on and the link they copied would have them off. But an
    // INHERITED default must not: that would quietly rewrite a link the host had already tuned,
    // just because they pressed Share again.
    const asked: typeof flags = {};
    if (typeof body.heartsEnabled === 'boolean') asked.heartsEnabled = body.heartsEnabled;
    if (typeof body.commentsEnabled === 'boolean') asked.commentsEnabled = body.commentsEnabled;
    if (Object.keys(asked).length) {
      await db.update(shares).set(asked).where(eq(shares.id, existing.id));
      return ret({ ...existing, ...asked });
    }
    return ret(existing);
  }

  // No pretty slug by default — the link uses the unique token (/s/<token>). The owner can claim a
  // named /s/<custom> URL later from the share modal; this avoids burning nice slugs nobody asked for.
  const label = (typeof body.label === 'string' && body.label.trim()) ? body.label.trim().slice(0, 80) : shareDefaultLabel(req.event!.name, kind, ids?.length || 0);
  const token = uuidv4().replace(/-/g, '');
  await db.insert(shares).values({ id: token, eventId: req.event!.id, kind, photoIds, label, slug: null,
                                  ...flags, createdAt: Date.now() });
  ret({ id: token, slug: null, label, kind, ...flags });
});

// List every share for the event (so the owner can copy / rename / delete them).
router.get('/:joinCode/shares', requireOrganizer, async (req: Request, res: Response) => {
  // `shares.id` last: two shares created in the same millisecond otherwise swap places between
  // refreshes, which is a list of links the owner is copying out of.
  const rows = await db.select().from(shares).where(eq(shares.eventId, req.event!.id))
    .orderBy(desc(shares.createdAt), asc(shares.id));
  res.json({ shares: rows.map((s) => ({
    id: s.id, kind: s.kind, slug: s.slug,
    label: s.label || shareDefaultLabel(req.event!.name, s.kind, sharePhotoCount(s.photoIds) || 0),
    count: sharePhotoCount(s.photoIds),
    heartsEnabled: !!s.heartsEnabled, commentsEnabled: !!s.commentsEnabled,
    url: `${baseUrl(req)}/s/${s.slug || s.id}`, createdAt: s.createdAt,
  })) });
});

// Rename a share (label) and/or change its custom URL (slug) — so the same link keeps working.
// Is this custom URL free? The same three rules the PATCH below enforces, asked BEFORE saving.
//
// Without it the share modal could only find out by trying: you typed a name, pressed Save, and got
// a 409 back — while the event's own Custom URL field had said "✓ Available" as you typed since it
// was written. Two fields doing the same job on the same screen, answering at different moments.
//
// `?id=` is the share being edited, so its OWN slug reads as available rather than as taken by
// itself — the same trap the event field has a branch for.
/** A share id is 32 lowercase hex and slugify() leaves it untouched, so without this a host could
 *  name their share after somebody else's token — `/s/<their-token>` would then be ambiguous, and
 *  which one a visitor landed on would depend on row order. Refused at the point of claiming it;
 *  resolveShare() also prefers the id, so neither half stands alone. */
const LOOKS_LIKE_SHARE_ID = /^[0-9a-f]{32}$/;

router.get('/:joinCode/shares/check-slug/:slug', requireOrganizer, async (req: Request, res: Response) => {
  const desired = slugify(String(req.params.slug || '')).slice(0, 60);
  const exclude = typeof req.query.id === 'string' ? req.query.id : '';
  if (desired.length < 2) return res.json({ available: false, slug: desired, reason: 'Too short' });
  if (isReservedSlug(desired)) return res.json({ available: false, slug: desired, reason: 'Reserved' });
  if (LOOKS_LIKE_SHARE_ID.test(desired)) return res.json({ available: false, slug: desired, reason: 'Reserved' });
  const [clash] = await db.select({ id: shares.id }).from(shares).where(eq(shares.slug, desired));
  res.json({ available: !clash || clash.id === exclude, slug: desired });
});

router.patch('/:joinCode/shares/:id', requireOrganizer, async (req: Request, res: Response) => {
  const { label, slug, heartsEnabled, commentsEnabled } =
    req.body as { label?: string; slug?: string; heartsEnabled?: boolean; commentsEnabled?: boolean };
  const [row] = await db.select().from(shares).where(and(eq(shares.id, String(req.params.id)), eq(shares.eventId, req.event!.id)));
  if (!row) return res.status(404).json({ error: 'Share not found' });
  const patch: { label?: string; slug?: string; heartsEnabled?: boolean; commentsEnabled?: boolean } = {};
  // Switchable after the fact, and after the link has gone out: a host who finds a gallery filling
  // with comments they did not want needs one switch, not a new link and a round of apologies.
  // Existing hearts and comments are KEPT — turning the switch back on restores them rather than
  // making everybody type again.
  if (typeof heartsEnabled === 'boolean') patch.heartsEnabled = heartsEnabled;
  if (typeof commentsEnabled === 'boolean') patch.commentsEnabled = commentsEnabled;
  if (typeof label === 'string' && label.trim()) patch.label = label.trim().slice(0, 80);
  if (typeof slug === 'string' && slug.trim()) {
    const desired = slugify(slug).slice(0, 60);
    if (desired.length < 2) return res.status(400).json({ error: 'Custom URL must be at least 2 characters' });
    if (LOOKS_LIKE_SHARE_ID.test(desired)) return res.status(409).json({ error: 'That custom URL is already taken' });
    if (desired !== row.slug) {
      // /s/<slug> is a second slug namespace with its own uniqueness check, so it needs the
      // reserved list too — `snapdini.com/s/billing` borrows exactly as much authority as
      // `/e/billing`. This was nearly missed: share slugs never touch isSlugAvailable().
      if (isReservedSlug(desired)) return res.status(409).json({ error: RESERVED_SLUG_ERROR });
      const [clash] = await db.select({ id: shares.id }).from(shares).where(eq(shares.slug, desired));
      if (clash && clash.id !== row.id) return res.status(409).json({ error: 'That custom URL is already taken' });
      patch.slug = desired;
    }
  }
  if (Object.keys(patch).length) await db.update(shares).set(patch).where(eq(shares.id, row.id));
  const finalSlug = patch.slug ?? row.slug;
  res.json({ ok: true, slug: finalSlug, label: patch.label ?? row.label,
             heartsEnabled: patch.heartsEnabled ?? row.heartsEnabled,
             commentsEnabled: patch.commentsEnabled ?? row.commentsEnabled,
             url: `${baseUrl(req)}/s/${finalSlug || row.id}` });
});

// ── GET /api/events/:joinCode/words — everything anybody wrote, in one place ──
//
// Captions and comments are two different things with the same problem: once an event is running,
// the host has no single place to read what has been written on their photos. The caption editor
// only ever opened one photo at a time, and comments — which can now come from share-link visitors
// as well as guests — had no host-facing surface at all.
//
// So: one list, newest first, every written line in the event with the photo it sits on. Deleting
// is done through the endpoints that already own each kind (clear the caption, delete the comment),
// because both already take the organizer code and both already do the right thing.
//
// Capped rather than paged. This is a moderation feed, not an archive: a host is looking for the
// thing somebody just wrote, and a 14,000-line scroll is not where they will find it. The total is
// reported so a capped list says so.
const WORDS_MAX = 300;

// ── PATCH /api/events/:joinCode/gallery-link — what the gallery link lets people do ──
//
// Its own endpoint rather than two more fields on the settings form, and deliberately so: that one
// is a full-form PUT which reads a fixed set of keys and writes all of them, so a partial save
// there would quietly clear whatever it did not mention. This touches exactly two columns.
//
// They are NOT the event's `hearts_enabled` / `comments_enabled`. Those say what a GUEST may do;
// these say what somebody holding `/gallery/<code>` may do — a different audience, and a host is
// entitled to a different answer for each. See 0064.
router.patch('/:joinCode/gallery-link', requireOrganizer, async (req: Request, res: Response) => {
  const { galleryHeartsEnabled, galleryCommentsEnabled } =
    req.body as { galleryHeartsEnabled?: boolean; galleryCommentsEnabled?: boolean };
  const patch: { galleryHeartsEnabled?: boolean; galleryCommentsEnabled?: boolean } = {};
  // Only an explicit boolean counts as an instruction — `undefined` means the caller did not ask.
  if (typeof galleryHeartsEnabled === 'boolean') patch.galleryHeartsEnabled = galleryHeartsEnabled;
  if (typeof galleryCommentsEnabled === 'boolean') patch.galleryCommentsEnabled = galleryCommentsEnabled;
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });

  // Switching one off HIDES what is there rather than deleting it: turn it back on and the hearts
  // and words come back, instead of everybody having to start again.
  await db.update(events).set(patch).where(eq(events.id, req.event!.id));
  await recordAdminAction(req, {
    event: req.event!, action: 'event.gallery_link', targetType: 'event', targetId: req.event!.id,
    before: { galleryHeartsEnabled: !!req.event!.galleryHeartsEnabled,
              galleryCommentsEnabled: !!req.event!.galleryCommentsEnabled },
    after: patch,
  });
  const [row] = await db.select({
    h: events.galleryHeartsEnabled, c: events.galleryCommentsEnabled,
  }).from(events).where(eq(events.id, req.event!.id));
  res.json({ ok: true, galleryHeartsEnabled: !!row.h, galleryCommentsEnabled: !!row.c });
});

router.get('/:joinCode/words', requireOrganizer, async (req: Request, res: Response) => {
  const eventId = req.event!.id;
  const kind = req.query.kind === 'captions' ? 'captions' : req.query.kind === 'comments' ? 'comments' : 'all';

  type Word = {
    kind: 'caption' | 'comment'; id: string; photoId: string; thumbUrl: string;
    text: string; author: string; authorKind: 'guest' | 'visitor' | 'host'; createdAt: number;
    status: string;
    /** Hearts on the COMMENT itself — always 0 for a caption, which nobody can heart. */
    hearts: number;
  };
  const out: Word[] = [];
  let captionTotal = 0;
  let commentTotal = 0;

  if (kind !== 'comments') {
    // A caption belongs to the photo, so its "id" IS the photo id — clearing it is a caption save
    // with an empty string, which is exactly what the host's own caption editor already does.
    const [{ n }] = await db.select({ n: count() }).from(photos)
      .where(and(eq(photos.eventId, eventId), isNotNull(photos.caption), sql`${photos.caption} <> ''`));
    captionTotal = Number(n);
    const rows = await db
      .select({ id: photos.id, filename: photos.filename, caption: photos.caption,
                takenAt: photos.takenAt, status: photos.status, author: participants.name })
      .from(photos)
      .innerJoin(participants, eq(participants.id, photos.participantId))
      .where(and(eq(photos.eventId, eventId), isNotNull(photos.caption), sql`${photos.caption} <> ''`))
      .orderBy(desc(photos.takenAt), asc(photos.id))
      .limit(WORDS_MAX);
    for (const r of rows) {
      out.push({ kind: 'caption', id: r.id, photoId: r.id, thumbUrl: `/uploads/${thumbName(r.filename)}`,
                 text: r.caption || '', author: r.author, authorKind: 'guest',
                 createdAt: r.takenAt, status: r.status, hearts: 0 });
    }
  }

  if (kind !== 'captions') {
    const [{ n }] = await db.select({ n: count() }).from(photoComments)
      .where(eq(photoComments.eventId, eventId));
    commentTotal = Number(n);
    const rows = await db
      .select({ id: photoComments.id, photoId: photoComments.photoId, body: photoComments.body,
                createdAt: photoComments.createdAt, filename: photos.filename, status: photos.status,
                guest: participants.name, visitor: shareVisitors.name })
      .from(photoComments)
      .innerJoin(photos, eq(photos.id, photoComments.photoId))
      // LEFT joins, plural: a comment has one author but two possible KINDS of author since 0061 —
      // a participant, or somebody who only ever held a share link. An inner join on either would
      // silently hide the other kind from the host, which is the opposite of moderation.
      .leftJoin(participants, eq(participants.id, photoComments.participantId))
      .leftJoin(shareVisitors, eq(shareVisitors.id, photoComments.visitorId))
      .where(eq(photoComments.eventId, eventId))
      .orderBy(desc(photoComments.createdAt), asc(photoComments.id))
      .limit(WORDS_MAX);
    // One grouped query for the page, so the host can see what landed well.
    const cIds = rows.map((r) => r.id);
    const hearts = cIds.length ? await db
      .select({ commentId: commentHearts.commentId, n: count() })
      .from(commentHearts).where(inArray(commentHearts.commentId, cIds))
      .groupBy(commentHearts.commentId) : [];
    const heartBy = new Map(hearts.map((h) => [h.commentId, Number(h.n)]));
    for (const r of rows) {
      out.push({ kind: 'comment', id: r.id, photoId: r.photoId, thumbUrl: `/uploads/${thumbName(r.filename)}`,
                 hearts: heartBy.get(r.id) ?? 0,
                 text: r.body, author: r.guest || r.visitor || 'Someone',
                 // Said plainly, because it changes how a host reads the line: a name typed into a
                 // forwarded link is not the same claim as a guest who joined the event.
                 authorKind: r.guest ? 'guest' : 'visitor',
                 createdAt: r.createdAt, status: r.status });
    }
  }

  // One list in one order. Two lists side by side would make the host read both to find the thing
  // somebody wrote a minute ago.
  out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
  res.json({
    words: out.slice(0, WORDS_MAX),
    captionTotal, commentTotal,
    total: captionTotal + commentTotal,
    capped: out.length > WORDS_MAX || captionTotal + commentTotal > WORDS_MAX,
  });
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

  const stored = JSON.stringify(sanitized);
  await db.update(events).set({ theme: stored }).where(eq(events.id, req.event!.id));
  // The STORED strings, not the parsed objects: what the log shows is then exactly what would have
  // to go back into the column to undo this, with no re-serialisation in between to disagree about.
  await recordAdminAction(req, {
    event: req.event!, action: 'event.theme', targetType: 'event', targetId: req.event!.id,
    before: { theme: req.event!.theme }, after: { theme: stored },
  });
  res.json({ success: true, theme: sanitized });
});

// ── POST /api/events/:joinCode/allow-downloads ────────────────────────────────

router.post('/:joinCode/allow-downloads', requireOrganizer, async (req: Request, res: Response) => {
  const allow = (req.body as { allowDownloads?: boolean }).allowDownloads !== false;
  await db.update(events).set({ allowDownloads: allow }).where(eq(events.id, req.event!.id));
  await recordAdminAction(req, {
    event: req.event!, action: 'event.settings', targetType: 'event', targetId: req.event!.id,
    before: { allowDownloads: !!req.event!.allowDownloads }, after: { allowDownloads: allow },
  });
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
    // The trailing dot goes HERE, at the boundary, so nothing downstream has to know about it.
    //
    // normaliseAddress() strips one because a transport can report `user@x.com.` back in a webhook,
    // and 0052's unique index is on `lower(btrim(email))`, which does not. For an address a host
    // actually typed with a trailing dot the two therefore key it differently, and the resend DELETE
    // could not find the row it was trying to clear. Removing it on the way in means the stored
    // value, the index and every reader agree by construction — no second expression to keep in
    // step, and no migration. Case is left alone: the host still sees the address as they wrote it.
    const addr = String(e).trim().replace(/\.+$/, '');
    if (!isEmail(addr)) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

/** How many addresses ONE press of Send may mail. Named rather than a bare 200 in the middle of the
 *  handler, because the number has to appear in the response too — a cap the caller cannot see is a
 *  cap the caller silently violates. Matches MAX_PER_SEND in routes/guests.ts: the two blasts hold a
 *  connection open the same way and there is no reason for them to disagree. */
const MAX_PER_BLAST = MAIL_BATCH_SIZE;

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
  // The message itself is inline-emails.ts galleryLinkEmail() — the same builder the email sampler
  // renders, so the two cannot drift. It takes the RAW event name and the RAW share label: it needs
  // them raw for the Subject: header and the text part, and escaped for the <h2> and the body, and
  // it is the only place that knows which is which. A curated share is a selection someone chose to
  // send, so it does NOT carry the join code — that invites people into the event itself, which is
  // the opposite of the point of handing out a narrowed link.
  const message = galleryLinkEmail({
    eventName: ev.name,
    shareLabel: share?.label || null,
    isShare: !!share,
    linkUrl,
    joinUrl: share ? undefined : joinUrl,
    joinCode: share ? undefined : ev.joinCode,
  });
  const subject = message.subject;

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
  const scope = share ? eq(shareSends.shareId, share.id) : isNull(shareSends.shareId);
  let alreadySent = new Set<string>();
  if (!resend) {
    try {
      const prior = await db.select({ email: shareSends.email }).from(shareSends).where(and(
        eq(shareSends.eventId, ev.id), scope, eq(shareSends.ok, true),
      ));
      alreadySent = new Set(prior.map((r) => normaliseAddress(r.email || '')));
    } catch (e) { console.error('[email-link] could not read prior sends', e); }
  }

  const now = Date.now();
  let sent = 0, errors = 0, skipped = 0;
  const batch = list.slice(0, MAX_PER_BLAST);
  // WHAT WAS NOT EVEN TRIED. This slice has been here since 1.4.3 and nothing reported it: a host
  // pasting 250 addresses was answered `{ sent: 200, errors: 0, skipped: 0 }` — a response in which
  // every number is correct and the sum is a lie, because fifty people were never considered at
  // all. `skipped` cannot carry them: it means "not mailed, and here is why", and these have no why
  // — they were past the end of the batch. So they get their own number, and the host can press
  // again: the ledger read above means the ones that DID go are not sent twice, so a second press
  // reaches exactly the remainder.
  const notSent = list.length - batch.length;

  // A claim row is written `ok: true` BEFORE the send, so anything that is not a delivery has to
  // correct it. `ok: false` is the row the host most needs to see in their sends list: under 0052
  // that row is the address's ONE row, so a send that did not happen must not be left claiming it
  // did — both the guard above and guest-delivery's priorLinkAddresses count `ok` rows only, and
  // would otherwise treat a failure as delivered.
  //
  // It does NOT block a retry. The claim below reclaims a failed row rather than conflicting with
  // it — which it did not used to do, and a transient SMTP 4xx therefore locked the address out of
  // every future press.
  //
  // A failed correction is logged and nothing more: by here the mail has either gone or been
  // refused, and turning that into a 500 would lose the addresses that DID go out in the same press.
  const markNotSent = async (id: string | null) => {
    if (!id) return;
    try { await db.update(shareSends).set({ ok: false }).where(eq(shareSends.id, id)); }
    catch (e) { console.error('[email-link] could not record a send that did not go out', e); }
  };

  // A resend is the host asking to mail an address the ledger says has already had this link, and
  // the ledger now holds ONE row per address per link (0052) — so the old row has to go before the
  // new attempt can claim its place. Cleared in one statement for the whole batch rather than per
  // address: it is one round trip, and this is the only place the rows are ever removed.
  if (resend) {
    try {
      await db.delete(shareSends).where(and(
        eq(shareSends.eventId, ev.id), scope,
        inArray(sql`lower(btrim(${shareSends.email}))`, batch.map(normaliseAddress)),
      ));
    } catch (e) { console.error('[email-link] could not clear prior sends for a resend', e); }
  }

  for (const addr of batch) {
    if (alreadySent.has(normaliseAddress(addr))) { skipped++; continue; }

    // CLAIM THE ADDRESS BEFORE SENDING, so the ledger decides rather than a read taken moments
    // ago. The read above is a snapshot: two presses of Send both saw an empty set, both sent, and
    // both wrote a row — and the automatic guest delivery reads the same table, so a host pressing
    // Send while that sweep is running was the same race with nobody touching the button twice.
    // With the unique index in place, ON CONFLICT DO NOTHING means exactly one of the racers gets
    // a row back and only that one goes on to send.
    //
    // A claim that THROWS (as opposed to conflicting) is a broken database, not a prior send, and
    // must not silence the host's send — same judgement as the failed read above: the worst case is
    // the duplicate this guard exists to avoid, which is smaller than a link nobody gets.
    const row = { id: uuidv4(), eventId: ev.id, shareId: share?.id ?? null, email: addr, ok: true, sentAt: now };
    let claimId: string | null = row.id;
    try {
      // RECLAIM A FAILED ROW FIRST.
      //
      // markNotSent() leaves the row in place with ok:false, and the comment above this block used
      // to say that is "what keeps this address mailable: both readers count ok rows only". There
      // are THREE readers, not two — this claim is the third, and it did not filter on ok. 0052's
      // unique index is on (event_id, lower(btrim(email))) with no ok in it, so the failed row still
      // occupied the slot: the next press passed the alreadySent guard (ok-only), conflicted here,
      // and counted the address as skipped without ever calling sendMail. Permanently, for a
      // transient SMTP 4xx. The `resend: true` escape hatch does work but nothing in the client ever
      // sends it, so a host had no way out at all.
      const [reclaimed] = await db.update(shareSends)
        .set({ ok: true, sentAt: now, shareId: row.shareId })
        .where(and(
          eq(shareSends.eventId, ev.id), scope,
          sql`lower(btrim(${shareSends.email})) = ${normaliseAddress(addr)}`,
          eq(shareSends.ok, false),
        ))
        .returning({ id: shareSends.id });
      if (reclaimed) {
        claimId = reclaimed.id;
      } else {
        // No failed row to take over, so this is a fresh claim. ON CONFLICT DO NOTHING still settles
        // the race between two presses: exactly one gets a row back and only that one sends.
        const [claimed] = await db.insert(shareSends).values(row)
          .onConflictDoNothing().returning({ id: shareSends.id });
        if (!claimed) { skipped++; continue; }
      }
    } catch (e) {
      console.error('[email-link] could not claim a send; sending anyway', e);
      claimId = null;
    }

    try {
      const r = await email.sendMail({
        to: addr,
        subject,
        html: message.html,
        text: message.text,
        // Without this the suppression check runs as blocksFor('') and sees only the GLOBAL list,
        // so a guest who chose "stop emailing me about this event" on the preference centre still
        // got the gallery link — the narrower of the two opt-outs was the one that did nothing, and
        // this is the send that goes to 200 addresses at a press. The per-event scope only exists
        // if the send says which event it is.
        eventId: ev.id,
      });
      // WITHHELD IS NOT DELIVERED. sendMail RETURNS `{ suppressed: true }` rather than throwing
      // when the address has opted out — deliberately, so a caller can record the truth instead of
      // retrying a refusal for ever (email.ts SendResult). This loop discarded that return and ran
      // `sent++` anyway: the host was shown a delivery that never happened, and the claim row above
      // said `ok: true` about a link the guest does not hold. Under 0052 that is the address's only
      // row, so the false `ok: true` would go on to refuse them the real link once their
      // suppression is lifted — the exact failure guest-delivery.ts's sendToGuest() was written to
      // stop, on the path it was never carried across to.
      //
      // Counted as `skipped`, which is already "everyone we did not mail" — the same bucket
      // guest-delivery's sendGuestLink() puts an unsubscribed guest in, and the same choice
      // routes/guests.ts makes for an invite the chokepoint refused.
      if (r.suppressed) { skipped++; await markNotSent(claimId); }
      else sent++;
    } catch {
      errors++;
      await markNotSent(claimId);
    }
  }

  // `skipped` is every address that was not mailed and was not an error: the ones that already had
  // this exact link, and the ones the suppression chokepoint refused. Reported rather than folded
  // into `sent`, so the host can see that Mum was not emailed twice AND that she was emailed — and
  // so that `sent` only ever means "this many messages left the building".
  res.json({ sent, errors, skipped, notSent, perSend: MAX_PER_BLAST });
});

// Who this event's links have been emailed to. One query for the lot — the admin page groups them
// by share client-side, which is cheaper than a request per link and keeps the ordering consistent.
router.get('/:joinCode/link-sends', requireOrganizer, async (req: Request, res: Response) => {
  const ev = req.event!;
  // A truncating LIMIT over a non-unique key: `sent_at` is stamped per blast, so a 200-address
  // send is a 200-row tie group and WHICH of them survive the cut at 1000 is otherwise arbitrary.
  const rows = await db.select().from(shareSends)
    .where(eq(shareSends.eventId, ev.id))
    .orderBy(desc(shareSends.sentAt), asc(shareSends.id))
    .limit(1000);
  res.json({
    sends: rows.map((r) => ({ shareId: r.shareId, email: r.email, ok: r.ok, sentAt: r.sentAt })),
  });
});

// ── PUT /api/events/:joinCode/settings — edit schedule / reveal / moderation ───

router.put('/:joinCode/settings', requireOrganizer, async (req: Request, res: Response) => {
  const ev = req.event!;
  const { name, blurb, startDate, startTime, revealMode,
          revealDelayHours, revealDate, revealTime, moderationEnabled, allowDownloads, noFlash, heartsEnabled, commentsEnabled, timezone, ratingMode, slug,
                  guestMayBuyShots, guestMayBuyVideo, guestMayBuyFrames, guestMayRequest, faceMatchingEnabled } = req.body as {
              guestMayBuyShots?: boolean; guestMayBuyVideo?: boolean; guestMayBuyFrames?: boolean;
    guestMayRequest?: boolean; faceMatchingEnabled?: boolean;
    name?: string; blurb?: string; startDate?: string; startTime?: string;
    revealMode?: string; revealDelayHours?: number | string; revealDate?: string; revealTime?: string;
    moderationEnabled?: boolean;
    allowDownloads?: boolean; noFlash?: boolean; heartsEnabled?: boolean; commentsEnabled?: boolean;
    timezone?: string; ratingMode?: string; slug?: string;
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
        // Only a CHANGED slug is validated, so an event already holding a now-reserved word keeps
        // working and keeps its URL. Taking one away after the fact would break a printed poster.
        if (isReservedSlug(desired)) return res.status(409).json({ error: RESERVED_SLUG_ERROR });
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

  // The timezone is resolved BEFORE the start time, because the start time is parsed against it.
  // It used to be resolved after, so the fallback below had nothing to parse with and fell back to
  // the SERVER's zone — see the note there.
  const tz       = (timezone === undefined) ? ev.timezone : ((typeof timezone === 'string' && timezone) ? timezone.slice(0, 64) : null);

  let startsAt = ev.startsAt;
  const bodyStartsAt = (req.body as { startsAt?: number }).startsAt;
  let requestedStart: number | null = null;
  if (typeof bodyStartsAt === 'number' && bodyStartsAt > 0) requestedStart = bodyStartsAt;
  else if (startDate) {
    // zonedWallTimeToMs, not `new Date('YYYY-MM-DDTHH:mm')` — that parses in the SERVER's zone
    // (UTC in the container), so a Sydney planner setting a 6pm start on a Perth event got 6pm UTC:
    // two in the morning, local. The comment above already knew this was the hazard and the
    // fallback did it anyway. Every other wall-clock field in this file goes through this helper.
    const parsed = zonedWallTimeToMs(startDate, startTime || '00:00', tz || 'UTC');
    if (parsed !== null) requestedStart = parsed;
  }
  /** Why the start was left where it was, when the host asked to move it and could not.
   *
   *  REFUSED, NOT REJECTED — and the difference is the whole point. These three checks used to
   *  `return`, which threw away the ENTIRE save: the name, the blurb, every toggle, all of it,
   *  because one field out of twenty could not be honoured. A host who renamed their event and
   *  nudged a date that turned out to be locked lost the rename too, and the form went on showing
   *  the changes it had not saved until a reload quietly took them back.
   *
   *  So the start simply stays where it is, everything else saves, and the reason is echoed to the
   *  host — the same shape as `aspectsRefused` below, and for the same reason: they should find
   *  out here rather than discover it later.
   *
   *  Tolerance: only a real move counts as a move. (The client no longer sends a start it was not
   *  asked to change at all — see startFieldsUntouched in the admin page — but a server must not
   *  depend on a client behaving.) */
  let startRefused: string | null = null;
  if (requestedStart !== null && Math.abs(requestedStart - ev.startsAt) > 60_000) {
    if (!canReschedule) {
      startRefused = 'This event has already started and guests have joined, so the start time is locked.';
    } else if (requestedStart < Date.now()) {
      startRefused = 'Pick a start time in the future.';
    } else if (requestedStart > anchorStart + RESCHEDULE_WINDOW_MS) {
      startRefused = 'An event can be moved up to 6 months from its original start date.';
    } else {
      startsAt = requestedStart;
    }
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
  // undefined means "not sent", which must leave the setting alone — a client that does not know
  // about hearts yet must not be able to switch them off by omission.
  const heartsV = (heartsEnabled === undefined) ? ev.heartsEnabled : (heartsEnabled === true);
  const commentsV = (commentsEnabled === undefined) ? ev.commentsEnabled : (commentsEnabled === true);
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
      // A 'custom' quote carries no price at all (amountCents 0), so reading it as "this costs no
      // more than has already been paid" would hand the frame pack out for free on any event no
      // rung fits — a grandfathered over-cap guest count, or a retention window above the top rung.
      // No price, no entitlement: it is refused here exactly as the create and upgrade routes do.
      if (q.tier !== 'custom' && q.amountCents <= (ev.amountPaidCents || 0)) {
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
  // A demo is the exception and must not have its purge pushed out by a save — see
  // purgeAtForEvent, which carries the reasoning and the test.
  const purgeAt  = purgeAtForEvent(ev, expiresAt);

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
      const at = customRevealInstant(revealDate, revealTime, tz);
      if (at === null) return res.status(400).json({ error: PICK_A_TIME });
      // REFUSED ONLY WHEN THIS SAVE IS CHANGING IT. The real client re-sends the same wall-clock
      // strings on every settings save, whether or not the host touched the reveal control
      // (web/src/lib/eventEdit.ts) — so validating unconditionally would make "rename a finished
      // event" fail with "that reveal time has already passed", about a reveal that fired days ago
      // and that nobody is editing. A value that is not being changed is not this save's to refuse;
      // the clamp below still holds it to the window this save is writing, which is the half that
      // actually protects the photos.
      const why = at === ev.revealAt ? null : revealInstantRefusal(at, { expiresAt, purgeAt }, Date.now());
      if (why) return res.status(400).json({ error: why });
      revealAt = at;
    }
  }

  // ── The reschedule clamp ───────────────────────────────────────────────────
  //
  // Whatever the three branches above decided, the stored instant is held to the window THIS SAVE
  // is writing. All three needed it and none had it:
  //   · the carry-over branch (no reveal keys at all — a name-only save) kept ev.revealAt verbatim;
  //   · the custom branch re-resolved the same wall time, which does not move when the event does;
  //   · and a preset rung clears it, which is the only one that was safe.
  // Moving an event two weeks out therefore left reveal_at two weeks BEFORE the event — the gallery
  // public for the whole of it. Reproduced through both of the first two paths.
  //
  // Nothing here is reachable for 'instant' or 'manual': revealAt is null for both.
  let revealAtClamped = false;
  if (revealAt !== null) {
    const c = clampRevealAt(revealAt, { expiresAt, purgeAt });
    if ('error' in c) return res.status(400).json({ error: c.error });
    revealAt = c.at;
    revealAtClamped = c.clamped;
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

  // ── The kind of event ──────────────────────────────────────────────────────
  //
  // One column, and deliberately NOT routed through PUT /challenges. That endpoint writes
  // event_type and challenges in the SAME statement and 400s unless the body carries a parseable
  // list, so "change the type" through it always also means "and here is the whole trick list
  // again" — and a body whose list is empty clears the column outright (serialiseSets returns null)
  // and reseats every guest holding a card. That coupling, and nothing else, is why the wizard used
  // to show this field as read-only text.
  //
  // What it is NOT is a regeneration risk. Nothing on the server ever derives the trick list from
  // the type: the mission packs live in the front end (web/src/lib/challenges.ts) because a host can
  // write their own, and seeding a list from a pack is a client action taken once at creation. So
  // the type is safe to set by itself, on an event whose list the host has rewritten line by line —
  // which is what makes it a setting, and this is where a setting belongs.
  //
  // Present-key rule, the same one the toggles below follow: undefined leaves it alone, so an older
  // client or a save that only touched the name cannot wipe it. Anything unparseable — including ''
  // — is null, which is how a host un-says it after picking one by mistake.
  const eventTypeGiven = gBody.eventType !== undefined;
  const newEventType = nextEventType(gBody.eventType, ev.eventType);

  // Hoisted out of the .set() call so the audit log can be handed THE PATCH ITSELF rather than a
  // hand-copied list of field names beside it. changedOnly() compares only the keys present here
  // against the row as it was, which means a field added to this object starts being logged the day
  // it is added — not the day somebody remembers there are two places to add it.
  const patch = {
    ...clearedPurgedAt,
    name: newName, blurb: newBlurb, startsAt, expiresAt, revealMode: mode,
    revealDelayHours: revealDelay, revealAt, moderationEnabled: moderation, allowDownloads: allowDl,
    noFlash: noFlashV, heartsEnabled: heartsV, commentsEnabled: commentsV,
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
    ...(eventTypeGiven ? { eventType: newEventType } : {}),
  };
  await db.update(events).set(patch).where(eq(events.id, ev.id));

  // `ev` is the whole pre-save row and `patch` is what was just written, so this records exactly
  // what moved and nothing else. It is also how the guest-permission switches get covered: they
  // are not their own endpoint — each one PUTs this route with a single key (see setGuestFlag in
  // the host's admin page), so a one-switch toggle produces a one-field entry here for free.
  await recordAdminAction(req, {
    event: ev, action: 'event.settings', targetType: 'event', targetId: ev.id,
    before: ev, after: patch,
  });

  res.json({
    success: true, name: newName, startsAt, expiresAt, revealMode: mode,
    revealDelayHours: revealDelay, revealAt, moderationEnabled: moderation, allowDownloads: allowDl,
    noFlash: noFlashV, heartsEnabled: heartsV, commentsEnabled: commentsV, timezone: tz, slug: newSlug, aspectRatios: aspects ? JSON.parse(aspects) : ['1:1'], ratingMode: rMode,
    aspectsRefused,
    // Null when the start was fine or untouched. Non-null means everything else in this response
    // DID save and only the start did not — the host needs the sentence, not a failure.
    startRefused,
    // Echoed so a host whose value the validator dropped finds out here rather than on the
    // printed card, exactly as the challenges endpoint echoes the list it stored.
    eventType: newEventType,
    guestDelivery, guestSendScope, guestSendAt,
    guestMailThanks:   typeof gBody.guestMailThanks   === 'boolean' ? gBody.guestMailThanks   : !!ev.guestMailThanks,
    guestMailReminder: typeof gBody.guestMailReminder === 'boolean' ? gBody.guestMailReminder : !!ev.guestMailReminder,
    guestMailLive:     typeof gBody.guestMailLive     === 'boolean' ? gBody.guestMailLive     : !!ev.guestMailLive,
    guestReleaseAt:    revealOpensAt(guestTiming),
    // True when the moment the host asked for was before the reveal and we moved it up to it. The
    // UI must say so: showing a different time back with no explanation is how a host learns to
    // distrust the form.
    guestSendAtClamped,
    // Same contract, one level up: the reveal the host had chosen was before the end of the event
    // this save is writing — they rescheduled — and it has been moved to the new end.
    revealAtClamped,
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
  //
  // The same rule as /highlights, and the worst place to break it. Under moderation a photo that
  // was never approved is invisible to everyone FOR EVER — so the only thing standing between a
  // guest's photo and oblivion is the host coming back to the queue. `count: photoIds.length`
  // answered {"success":true,"count":2} to an approve of two ids that do not exist, having written
  // nothing at all. Report what the UPDATE actually moved.
  // The same read-before-write as /highlights, and here it is the point of the whole feature. A
  // rejected photo is restorable by hand — but only by somebody who knows which of the batch were
  // 'pending' and which were already 'approved' before an operator swept the queue. RETURNING
  // cannot say: it hands back the status we just set, which is the same for every row.
  const was = await db.select({ id: photos.id, status: photos.status })
    .from(photos).where(and(inArray(photos.id, photoIds), eq(photos.eventId, req.event!.id)));
  const moved = await db.update(photos).set({ status })
    .where(and(inArray(photos.id, photoIds), eq(photos.eventId, req.event!.id)))
    .returning({ id: photos.id });
  await recordAdminAction(req, {
    event: req.event!, action: 'photo.moderate', targetType: 'photo', targetId: null,
    before: Object.fromEntries(was.map((p) => [p.id, p.status])),
    after:  Object.fromEntries(was.map((p) => [p.id, status])),
  });
  res.json({ success: true, action, status, count: moved.length });
});

// ── POST /api/events/:joinCode/reveal ─────────────────────────────────────────

router.post('/:joinCode/reveal', requireOrganizer, async (req: Request, res: Response) => {
  // Reveal now + clear any hide override.
  const ev = req.event!;
  const at = Date.now();
  await db.update(events).set({ revealedAt: at, revealHidden: false }).where(eq(events.id, ev.id));
  // BOTH columns, not a derived isRevealed(): putting this back by hand means restoring the pair,
  // and an operator who revealed an at_end event early has to be able to see that revealedAt was
  // null — otherwise the restore leaves the gallery open on a schedule that has not arrived.
  await recordAdminAction(req, {
    event: ev, action: 'event.reveal', targetType: 'event', targetId: ev.id,
    before: { revealedAt: ev.revealedAt, revealHidden: !!ev.revealHidden },
    after:  { revealedAt: at, revealHidden: false },
  });
  res.json({ success: true });
});

// ── POST /api/events/:joinCode/unreveal ───────────────────────────────────────

router.post('/:joinCode/unreveal', requireOrganizer, async (req: Request, res: Response) => {
  // Hide override (wins even over an ended at_end event) + clear any early-reveal timestamp.
  const ev = req.event!;
  await db.update(events).set({ revealedAt: null, revealHidden: true }).where(eq(events.id, ev.id));
  await recordAdminAction(req, {
    event: ev, action: 'event.reveal', targetType: 'event', targetId: ev.id,
    before: { revealedAt: ev.revealedAt, revealHidden: !!ev.revealHidden },
    after:  { revealedAt: null, revealHidden: true },
  });
  res.json({ success: true });
});

// ── POST /api/events/:joinCode/lock ──────────────────────────────────────────

router.post('/:joinCode/lock', requireOrganizer, async (req: Request, res: Response) => {
  const newLocked = !req.event!.isLocked;
  await db.update(events).set({ isLocked: newLocked }).where(eq(events.id, req.event!.id));
  // A lock is the one toggle a guest feels immediately — the camera stops taking shots — so an
  // operator who flips it mid-event needs it in the log even though the value is trivially
  // inferable from the current state.
  await recordAdminAction(req, {
    event: req.event!, action: 'event.lock', targetType: 'event', targetId: req.event!.id,
    before: { isLocked: !!req.event!.isLocked }, after: { isLocked: newLocked },
  });
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
  // RECORDED BEFORE THE DELETE, and this is the one call site where the order is load-bearing: the
  // entry has to name the event, and once the row is gone there is nothing left to name it from.
  // The trade is a log line for a deletion that then failed, against a customer's event gone with
  // nothing at all to say who did it. (In practice an operator can only reach this on an UNOWNED
  // event — the guard above reserves an owned one for its creator — so this mostly covers demos
  // today and the day that guard changes.)
  await recordAdminAction(req, {
    event: ev, action: 'event.delete', targetType: 'event', targetId: ev.id,
    before: { name: ev.name, joinCode: ev.joinCode, slug: ev.slug, startsAt: ev.startsAt,
              expiresAt: ev.expiresAt, ownerUserId: ev.ownerUserId, amountPaidCents: ev.amountPaidCents },
    // Nothing to restore to, and no pretending otherwise. This half of the log exists to say WHAT
    // was destroyed, because after the cascade nothing else in the product can.
    after: null,
  });
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
    // `eventCohosts.id` last — two invites sent from one form submission share a created_at.
  }).from(eventCohosts).where(eq(eventCohosts.eventId, ev.id)).orderBy(eventCohosts.createdAt, eventCohosts.id);
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
      // inline-emails.ts cohostInviteEmail() — one definition, shared with the sampler, and it
      // takes the raw names for the same reason galleryLinkEmail does.
      const m = cohostInviteEmail({ inviter, eventName: ev.name, acceptUrl: link });
      await email.sendMail({
        to: inviteEmail,
        subject: m.subject,
        html: m.html,
        text: m.text,
        // Same reason as the gallery blast above: this is mail ABOUT one event, so the suppression
        // check has to be told which one or the per-event opt-out cannot apply to it.
        eventId: ev.id,
      });
    } catch { /* best-effort; dev link still returned below */ }
  }
  res.json({ ok: true, devLink: process.env.NODE_ENV !== 'production' ? link : undefined });
});

router.delete('/:joinCode/cohosts/:id', requireOrganizer, async (req: Request, res: Response) => {
  const ev = req.event!;
  // Read first, only so the log can say WHO was removed. A bare id in an audit entry is no use to
  // the person putting it back — they would have to re-invite an address they cannot recover.
  // `before` is null when nothing matched, and a null-to-null entry is not written at all.
  const [gone] = await db.select({ email: eventCohosts.email, status: eventCohosts.status })
    .from(eventCohosts).where(and(eq(eventCohosts.id, String(req.params.id)), eq(eventCohosts.eventId, ev.id)));
  await db.delete(eventCohosts).where(and(eq(eventCohosts.id, String(req.params.id)), eq(eventCohosts.eventId, ev.id)));
  await recordAdminAction(req, {
    event: ev, action: 'cohost.delete', targetType: 'cohost', targetId: String(req.params.id),
    before: gone ? { email: gone.email, status: gone.status } : null, after: null,
  });
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
  await recordAdminAction(req, {
    event: ev, action: 'participant.delete', targetType: 'participant', targetId: p.id,
    // The photo count is not decoration. The files are unlinked a few lines above and the rows
    // cascade with the guest, so this number is the only surviving measure of how much of somebody
    // else's event just went — there is nothing left to count afterwards.
    before: { name: p.name, email: p.email, photosTaken: p.photosTaken, joinedAt: p.joinedAt,
              photosDeleted: rows.length },
    after: null,
  });
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

  // Marked settled as well as moved. The guest's own "which card are you?" prompt only ever
  // appears while the source is 'pending', so a host correcting someone must close that question
  // too — otherwise the app would ask them to choose a card the host had just chosen for them.
  await db.update(participants).set({ challengeSet: want, challengeSetSource: 'self' }).where(eq(participants.id, p.id));
  // challengeSetSource travels with the card because the two are one decision here (see above),
  // and restoring only the card would leave the guest's "which card are you?" prompt suppressed.
  await recordAdminAction(req, {
    event: ev, action: 'participant.card', targetType: 'participant', targetId: p.id,
    before: { challengeSet: p.challengeSet, challengeSetSource: p.challengeSetSource },
    after:  { challengeSet: want, challengeSetSource: 'self' },
  });
  const set = sets.find((x) => x.key === want)!;
  res.json({ ok: true, challengeSet: want, label: set.label, tricks: set.items.length });
});

export default router;
