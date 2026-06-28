import crypto from 'crypto';
import fs from 'fs';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { eq, and, or, sql, inArray, count, desc } from 'drizzle-orm';
import { db } from '../db';
import { events, participants, photos, shares, eventCohosts, users, type Event } from '../schema';
import * as email from '../email';
import * as auth from '../auth';
import * as cleanup from '../cleanup';
import { isRevealed, baseUrl, escapeHtml } from '../lib';
import { startSlideshow, slideshowInfo, toggleSlideshowFavourite, deleteSlideshow, slideshowFile, streamSlideshow1080 } from '../slideshow';
import { billingEnabled, quote, FREE_ALL_GUESTS, brandingRemovable } from '../billing';
import options from '../options';

const router = Router();

// Photos + event are auto-deleted this many days after the event ends (retention).
// Plan-scaled windows arrive with billing; this is the self-host/free default.
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '7');
const DEMO_NAME = 'Demo Roll 🎞️'; // marks the public "see what it looks like" demo events
const DAY_MS = 24 * 60 * 60 * 1000;
// Global video length (self-host / billing-off default; per-event entitlement when billing on).
const GLOBAL_VIDEO_SECONDS = parseInt(process.env.VIDEO_MAX_SECONDS || '0');

// Allowed capture aspect ratios validated against the single options source.
const VALID_ASPECTS = options.aspectRatios.map((a) => a.value);
const VALID_MODES = options.themeModes.map((m) => m.value);
const VALID_FONTS = options.fonts.map((f) => f.stack);
function sanitizeAspects(arr: unknown): string[] {
  const a = Array.isArray(arr) ? arr.filter((v) => VALID_ASPECTS.includes(v)) : [];
  return a.length ? Array.from(new Set(a)) : ['1:1'];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
          revealDelayHours, moderationEnabled, timezone, maxGuests, videoSeconds } = req.body as {
    name?: string; blurb?: string; durationHours?: number | string; maxPhotos?: number | string;
    revealMode?: string; slug?: string; startDate?: string; startTime?: string;
    startsAt?: number; allowDownloads?: boolean; noFlash?: boolean; revealDelayHours?: number | string;
    moderationEnabled?: boolean; timezone?: string; maxGuests?: number | string; videoSeconds?: number | string;
  };
  const blurb = typeof rawBlurb === 'string' && rawBlurb.trim() ? rawBlurb.trim().slice(0, 280) : null;

  if (!name || !durationHours || !maxPhotos)
    return res.status(400).json({ error: 'name, durationHours, and maxPhotos are required' });

  const validModes = ['instant', 'at_end', 'manual'];
  const mode = validModes.includes(revealMode as string) ? (revealMode as string) : 'instant';
  // Reveal delay only applies to 'at_end'; clamp to 0..168h (one week).
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
  const reqRetention = Math.min(Math.max(parseInt((req.body as { retentionDays?: unknown }).retentionDays as string, 10) || RETENTION_DAYS, 1), 366);
  const q = quote({ maxGuests: reqGuests, maxPhotos: reqShots, aspectRatios: reqAspects, videoSeconds: reqVideo, durationHours: reqDuration, retentionDays: reqRetention });
  // When billing is on, store the entitled config from the quote (≤10 = free with everything; 11+ paid).
  const entGuestCap = reqGuests;
  const entVideoSeconds = billingEnabled ? q.videoSeconds : reqVideo;
  const entMaxPhotos = billingEnabled ? q.maxPhotos : reqShots;
  const entAspects = billingEnabled ? q.aspectRatios : reqAspects;
  const entRetentionDays = billingEnabled ? q.retentionDays : reqRetention;
  const entPaid = billingEnabled ? !q.requiresPayment : true;

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
    joinCode,
    slug:            slug || null,
    organizerCode:   uuidv4().replace(/-/g, ''),
    maxPhotos:       entMaxPhotos,
    revealMode:      mode,
    revealDelayHours: revealDelay,
    // Moderation only applies when photos aren't shown instantly.
    moderationEnabled: moderationEnabled === true && mode !== 'instant',
    startsAt,
    expiresAt,
    revealedAt:      null,
    isLocked:        false,
    allowDownloads:  allowDownloads !== false,
    noFlash:         noFlash === true,
    theme:           null,
    timezone:        (typeof timezone === 'string' && timezone) ? timezone.slice(0, 64) : null,
    aspectRatios:    JSON.stringify(entAspects),
    guestCap:        entGuestCap,
    videoSeconds:    entVideoSeconds,
    retentionDays:   entRetentionDays,
    paid:            entPaid,
    purgeAt:         expiresAt + entRetentionDays * DAY_MS,
    createdAt:       Date.now(),
  };

  await db.insert(events).values(event);

  res.json({
    joinCode:      event.joinCode,
    slug:          event.slug,
    organizerCode: event.organizerCode,
    event: {
      id: event.id, name: event.name, maxPhotos: event.maxPhotos,
      revealMode: mode, startsAt, expiresAt,
    },
  });
});

// ── POST /api/events/demo — throwaway event + auto-join for the landing demo ───
// Lets a visitor try the real camera/gallery without signing up. Short-lived (purges
// in ~3h via the retention sweeper). MUST be before the /:joinCode wildcard.

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
  const expiresAt = now + 3 * 3_600_000; // 3h window
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
    revealDelayHours: 0,
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
    videoSeconds: GLOBAL_VIDEO_SECONDS,
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

  res.json({
    id:             event.id,
    name:           event.name,
    blurb:          event.blurb || null,
    joinCode:       event.joinCode,
    slug:           event.slug || null,
    maxPhotos:      event.maxPhotos,
    revealMode:     event.revealMode,
    revealDelayHours: event.revealDelayHours,
    timezone:       event.timezone || null,
    aspectRatios:   event.aspectRatios ? JSON.parse(event.aspectRatios) : ['1:1'],
    // Per-event video length when billing is on; otherwise the global (self-host) setting.
    videoSeconds:   billingEnabled ? event.videoSeconds : GLOBAL_VIDEO_SECONDS,
    startsAt:       event.startsAt,
    expiresAt:      event.expiresAt,
    isDemo:         !event.ownerUserId && event.name === DEMO_NAME,
    isUpcoming:     now < event.startsAt,
    isExpired:      now > event.expiresAt,
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
  const joinUrl  = base + joinPath;

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
    moderationEnabled: !!ev.moderationEnabled,
    ratingMode:     ev.ratingMode || 'favourite',
    timezone:       ev.timezone || null,
    aspectRatios:   ev.aspectRatios ? JSON.parse(ev.aspectRatios) : ['1:1'],
    startsAt:       ev.startsAt,
    expiresAt:      ev.expiresAt,
    isUpcoming:     now < ev.startsAt,
    isExpired:      now > ev.expiresAt,
    isLocked:       !!ev.isLocked,
    isRevealed:     isRevealed(ev),
    revealedAt:     ev.revealedAt,
    allowDownloads: !!ev.allowDownloads,
    noFlash:        !!ev.noFlash,
    theme:          ev.theme ? JSON.parse(ev.theme) : null,
    // entitlement (for the upgrades section; only meaningful when billing is on)
    guestCap:       ev.guestCap,
    videoSeconds:   ev.videoSeconds,
    retentionDays:  ev.retentionDays,
    paid:           !!ev.paid,
    amountPaidCents: ev.amountPaidCents,
    posterConfig:   ev.posterConfig ? JSON.parse(ev.posterConfig) : null,
    purged:         !!ev.purgedAt,
    participantCount: participantRows.length,
    photoCount,
    pendingCount,
    participants:   participantRows.map((p) => ({
      id: p.id, name: p.name, email: p.email,
      photosTaken: p.photosTaken, joinedAt: p.joinedAt,
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

// ── PUT /api/events/:joinCode/poster — save the poster designer customisation ──
router.put('/:joinCode/poster', requireOrganizer, async (req: Request, res: Response) => {
  const config = (req.body as { config?: unknown }).config;
  // store a bounded JSON blob (poster text/colours/toggles — no untrusted execution)
  const json = config && typeof config === 'object' ? JSON.stringify(config).slice(0, 4000) : null;
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
  // Removing the Snapdini intro/outro is a paid add-on — only honour branding=false when entitled.
  const wantNoBranding = b.branding === false;
  if (wantNoBranding && !brandingRemovable(req.event!))
    return res.status(402).json({ error: 'Removing the Snapdini frames needs the add-on — purchase it first' });
  const branding = !wantNoBranding;
  const job = startSlideshow(req.event!.id, { favouritesOnly, track, tracks, loopMusic, secondsPer, includeVideos, keepVideoAudio, quality, resolution, branding });
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

// ── POST /api/events/:joinCode/email-gallery ──────────────────────────────────

router.post('/:joinCode/email-gallery', requireOrganizer, async (req: Request, res: Response) => {
  if (!email.enabled) return res.status(503).json({ error: 'Email not configured on this server' });
  const reqEmails = (req.body as { emails?: unknown }).emails;
  const list = (Array.isArray(reqEmails) ? reqEmails : [])
    .map((e) => String(e).trim()).filter(isEmail);
  if (list.length === 0) return res.status(400).json({ error: 'No valid email addresses provided' });

  const ev       = req.event!;
  const base     = baseUrl(req);
  const galPath  = ev.slug ? `/gallery/${ev.slug}` : `/gallery/${ev.joinCode}`;
  const galUrl   = base + galPath;
  const joinPath = ev.slug ? `/e/${ev.slug}` : `/join/${ev.joinCode}`;
  const joinUrl  = base + joinPath;
  const safeName = escapeHtml(ev.name);   // organizer-controlled → escape in outbound HTML

  let sent = 0, errors = 0;
  for (const addr of list.slice(0, 200)) {
    try {
      await email.sendMail({
        to: addr,
        subject: `Gallery from ${ev.name} 📷`,
        html: email.htmlEmail(`Gallery from ${safeName}`, `
          <p>The event gallery is ready to view.</p>
          <p style="margin:24px 0"><a href="${galUrl}" class="btn">View Gallery →</a></p>
          <p>Or share the event and join code <strong>${escapeHtml(ev.joinCode)}</strong> at:<br>
          <a href="${joinUrl}">${joinUrl}</a></p>
        `),
      });
      sent++;
    } catch { errors++; }
  }
  res.json({ sent, errors });
});

// ── PUT /api/events/:joinCode/settings — edit schedule / reveal / moderation ───

router.put('/:joinCode/settings', requireOrganizer, async (req: Request, res: Response) => {
  const ev = req.event!;
  const { name, blurb, startDate, startTime, revealMode,
          revealDelayHours, moderationEnabled, allowDownloads, noFlash, timezone, ratingMode, slug } = req.body as {
    name?: string; blurb?: string; startDate?: string; startTime?: string;
    revealMode?: string; revealDelayHours?: number | string; moderationEnabled?: boolean;
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
  // Once the event has started it can NO LONGER be rescheduled — the start time is locked.
  const alreadyStarted = Date.now() >= ev.startsAt;
  let startsAt = ev.startsAt;
  if (!alreadyStarted) {
    const bodyStartsAt = (req.body as { startsAt?: number }).startsAt;
    if (typeof bodyStartsAt === 'number' && bodyStartsAt > 0) {
      startsAt = bodyStartsAt;
    } else if (startDate) {
      const parsed = new Date(`${startDate}T${startTime || '00:00'}`).getTime();
      if (!isNaN(parsed)) startsAt = parsed;
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
  const tz       = (timezone === undefined) ? ev.timezone : ((typeof timezone === 'string' && timezone) ? timezone.slice(0, 64) : null);
  // Frame sizes are a PAID entitlement (the frame pack). Settings must NOT let an organizer add
  // non-square shapes without paying — that's what the Upgrades flow (Stripe) is for. We accept a
  // requested set only if: billing is off (self-host), OR it's a subset of what the event already
  // has (toggling/removing entitled shapes, incl. promo-unlocked), OR re-quoting shows it costs no
  // more than already paid (free tiers quote to $0, so they can freely pick any shape).
  let aspects = ev.aspectRatios;
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
      aspects = q.amountCents <= (ev.amountPaidCents || 0) ? JSON.stringify(q.aspectRatios) : ev.aspectRatios;
    }
  }
  const rMode    = (ratingMode === 'favourite' || ratingMode === 'stars') ? ratingMode : (ev.ratingMode || 'favourite');
  // Use the event's OWN retention window (a paid extension may exceed the global default) so a
  // settings save doesn't silently shorten retention the organizer paid to extend.
  const purgeAt  = expiresAt + (ev.retentionDays || RETENTION_DAYS) * DAY_MS;

  await db.update(events).set({
    name: newName, blurb: newBlurb, startsAt, expiresAt, revealMode: mode,
    revealDelayHours: revealDelay, moderationEnabled: moderation, allowDownloads: allowDl,
    noFlash: noFlashV, timezone: tz, slug: newSlug, aspectRatios: aspects, ratingMode: rMode, purgeAt,
  }).where(eq(events.id, ev.id));

  res.json({
    success: true, name: newName, startsAt, expiresAt, revealMode: mode,
    revealDelayHours: revealDelay, moderationEnabled: moderation, allowDownloads: allowDl,
    noFlash: noFlashV, timezone: tz, slug: newSlug, aspectRatios: aspects ? JSON.parse(aspects) : ['1:1'], ratingMode: rMode,
  });
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

export default router;
