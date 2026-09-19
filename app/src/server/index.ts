import express, { type Request, type Response, type NextFunction } from 'express';
import 'express-async-errors'; // lets async route handlers throw to the error middleware
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { requireTurnstile, turnstileSiteKey, turnstileEnabled } from './turnstile';
import { v4 as uuidv4 } from 'uuid';
import { and, eq, or } from 'drizzle-orm';
import { db, init } from './db';
import { events, photos } from './schema';
import { stripImageMetadata, stripImageMetadataPng, backfillThumbnails, backfillPlaybackProxies } from './images';
import { start as startCleanup } from './cleanup';
import { startLifecycle } from './lifecycle';
import { startOps } from './ops-notify';
import { migrateUploadsToPerEvent } from './migrate-uploads';
import options from './options';
import { publicBillingConfig, billingEnabled } from './billing';
import * as email from './email';
import { UPLOADS_DIR, eventDir, eventRelPath } from './paths';
import { MUSIC_DIR, probeHasAudioStream } from './slideshow';
import authRoutes from './routes/auth';
import eventsRoutes, { requireOrganizer } from './routes/events';
import guestsRoutes, { mailgunWebhookHandler } from './routes/guests';
import participantsRoutes from './routes/participants';
import photosRoutes, { DELETE_WINDOW_SECONDS } from './routes/photos';
import facesRoutes from './routes/faces';
import billingRoutes, { stripeWebhookHandler } from './routes/billing';
import contactRoutes from './routes/contact';
import trackRoutes from './routes/track';
import { startCounters } from './counters';
import { startAnalytics } from './analytics';
import clientErrorRoutes from './routes/clienterror';
import adminRoutes from './routes/admin';
import sharesRoutes from './routes/shares';
import cohostsRoutes from './routes/cohosts';
import surveyRoutes from './routes/survey';
import emailPrefsRoutes from './routes/email-prefs';
import unsubscribeRoutes from './routes/unsubscribe';
import { ensureAdminFromEnv } from './auth';
import pkg from '../../package.json';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Behind nginx + Traefik, so trust one proxy hop for req.ip / rate limiting / secure cookies.
app.set('trust proxy', 1);

// Security headers. CSP keeps every resource same-origin — this is what contains the
// organizer-supplied theme `customCss` on the public gallery: it can't beacon out to a
// third party (connect/img/default are 'self'). Inline scripts/styles are allowed for
// now (pages use them); tighten to nonces later.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:', 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: { maxAge: 15552000, includeSubDomains: true }, // ~180d (only honored over HTTPS)
  crossOriginEmbedderPolicy: false,
}));

// Stripe webhook needs the RAW body for signature verification — mount before express.json.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

// The CSV import posts the file's TEXT as JSON, and a 2000-row guest list is comfortably past
// express.json's 100KB default — which would answer 413 on a perfectly ordinary spreadsheet. A
// bigger limit ONLY on these two paths: raising it globally would widen the body ceiling on every
// public endpoint in the product to buy one admin-only feature some room.
// Mounted before the global parser, which no-ops once a body has already been read.
app.use('/api/events/:joinCode/guests/import', express.json({ limit: '2mb' }));

app.use(express.json());

// Mailgun delivery webhooks. Unlike Stripe's, this one does NOT need the raw body: Mailgun signs
// the timestamp and token only, never the payload, so the ordinary JSON parser above is fine.
// (That is also why the handler treats event-data as untrusted input and reads every field
// defensively — the signature proves the SENDER, not the CONTENTS.)
//
// Registered HERE, above `app.use('/api', apiBackstop)`, on purpose rather than by accident: a
// large send produces a burst of events, and a 429 is a non-2xx, which puts Mailgun into an
// eight-hour retry ladder for traffic we simply rate-limited. The endpoint is not unprotected —
// every request must carry a valid HMAC before it touches the database, and a forged one is
// rejected at the top of the handler.
app.post('/api/webhooks/mailgun', mailgunWebhookHandler);
app.use(cookieParser());

// Rate limiting. Strict on auth (low-volume organizer actions). NOTE: event guests at a
// venue share one public IP, so join/upload/gallery are intentionally NOT IP-limited hard —
// only a generous DoS backstop covers the rest of the API.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: Number(process.env.AUTH_RATE_LIMIT || 40),
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many attempts — please wait a few minutes and try again.' },
  // Only throttle credential POSTs (login/register/magic-link). GET /api/auth/me runs on every
  // page load, so counting it tripped "too many attempts" during normal navigation.
  skip: (req) => req.method === 'GET',
});
// The guest reads a whole venue performs AT ONCE. This `skip` is what makes the note above
// ("event guests at a venue share one public IP, so join/upload/gallery are intentionally NOT
// IP-limited hard") actually TRUE — it was an intention, never an implementation: the backstop was
// mounted across all of /api with no exemption, and only the auth limiter ever got a skip.
//
// The arithmetic that matters: `trust proxy` resolves req.ip to the REAL client, which at a wedding
// is ONE NAT address shared by every guest. Opening the gallery costs ~6 /api requests, so 600/min
// divided by 6 is a cliff at roughly 100 guests inside one minute — and a reveal is exactly 150
// people tapping one link at the same moment. The whole venue would have been handed
// "Too many requests — slow down" at the precise moment the product is being judged.
//
// GETs only, and only the public read path — each already cheap and now edge-cacheable. Writes,
// auth, uploads, email and Stripe keep the backstop. Volumetric DoS belongs at Cloudflare, not in a
// 600/min per-IP counter in front of a surface whose whole design is "one link, every guest, now".
const GUEST_READ = [
  /^\/photos\/[^/]+$/,      // the event gallery and the guest's own roll
  /^\/events\/[^/]+$/,      // the event a guest has just scanned into
  /^\/participants\/me$/,   // "which roll am I?" — runs on every camera load
  // Live heart counts, polled by every open gallery. It has TWO path segments, so it did not match
  // the first pattern and was landing on the counted side — which quietly undid the arithmetic
  // above: at ~1.33 polls/min per viewer, 400 guests is ~533/min of a 600/min budget before a
  // single upload. Exactly the reveal-day outage this exemption list exists to prevent.
  /^\/photos\/[^/]+\/hearts$/,
];
const apiBackstop = rateLimit({
  windowMs: 60 * 1000, limit: Number(process.env.API_RATE_LIMIT || 600),
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many requests — slow down.' },
  skip: (req) => req.method === 'GET' && GUEST_READ.some((re) => re.test(req.path)),
});
// Tighter limit for endpoints that send email or create Stripe sessions (abuse-prone).
const emailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: Number(process.env.EMAIL_RATE_LIMIT || 20),
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many requests — please wait a few minutes.' },
});
// The CSV import. The ONLY two endpoints in the product that accept a 2 MB body (see the
// express.json mount above), and each one parses all of it: measured at 576 ms of CPU for 2 MB, and
// 1.42 s wall for five of them at once. Under the 600/min /api backstop alone that is ~345 s of CPU
// per minute available to one IP — a single-process Node server stops answering anyone else long
// before that. An organizer code is all it takes to reach them.
//
// 30/min rather than something tight: this is a DoS bound, not a product rule, and a host correcting
// a mapping and re-previewing four or five times in a row is ordinary use. 30 presses a minute is
// not, and even at 30 the worst case is ~17 s of CPU per minute per IP instead of 345.
//
// Env-tunable like every other limiter here, and for the same reason: the integration suite's
// import spec makes ~18 of these calls inside one run.
const importLimiter = rateLimit({
  windowMs: 60 * 1000, limit: Number(process.env.IMPORT_RATE_LIMIT || 30),
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many imports — please wait a minute and try again.' },
});
// Client error reports: allow bursts but cap a runaway client from flooding us.
const clientErrorLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many reports.' },
});
// Login gets a tighter cap than the general auth limiter to slow password guessing (argon2 already
// makes each attempt expensive). Register stays on authLimiter — it's gated by email verification.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: Number(process.env.LOGIN_RATE_LIMIT || 15),
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many attempts — please wait a few minutes and try again.' },
  skip: (req) => req.method === 'GET',
});
// Every /api response is uncacheable UNLESS it opts out. Cache-Control is currently set in exactly
// one file (routes/photos.ts), so /api/participants/me, /api/events/mine, /api/cohosts, /api/auth/me
// and /api/events/:code/admin all ship with none at all. That is safe only while nothing caches
// /api — and the obvious-but-wrong fix for "my gallery cache rule isn't working" is a Cloudflare
// "Cache Everything" rule on /api/*, which would publicly cache per-viewer replies. Cloudflare's
// default cache key is host+path+query and IGNORES request headers, so a cached
// GET /api/events/ABCD1234/admin — authorised by the x-organizer-code HEADER — would be served to
// anyone with the URL and no code at all.
//
// Defaulting closed makes photos.ts's cacheableFor() an explicit opt-OUT, so a mis-scoped edge rule
// cannot leak. Before the routers, so a route can still override it.
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
/* CSP violation reports.
 *
 * The page policy is Report-Only and, until this existed, reported to nowhere — so it blocked
 * nothing AND collected nothing, which is the worst of both: a header on every response buying
 * zero. This is the half that makes it worth having. Promote the policy to enforcing only once
 * this has been quiet for a while on real traffic.
 *
 * WHAT IS DELIBERATELY NOT LOGGED. A report carries `document-uri` and `blocked-uri` in full, and
 * on this app those URLs contain join codes, share slugs and recovery tokens — so logging a report
 * verbatim would copy live credentials into a log file that is not treated as secret. Only the
 * directive, the blocked ORIGIN and the document PATH are kept: enough to identify what to allow,
 * with the query string and any token in it dropped before anything is written.
 *
 * Unauthenticated because browsers send it with no credentials, so it is rate limited hard and
 * capped small: an endpoint anyone can POST to is an endpoint that will be POSTed to.
 */
const cspReportLimiter = rateLimit({
  windowMs: 60 * 1000, limit: Number(process.env.CSP_REPORT_RATE_LIMIT || 60),
  standardHeaders: false, legacyHeaders: false,
  // A browser does not read the response, so there is nothing to say; refuse quietly rather than
  // spend a body on it.
  handler: (_req, res) => res.status(204).end(),
});
/** Origin only — drops path, query and any token living in either. */
const originOf = (u: unknown): string => {
  const raw = String(u ?? '').trim();
  if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return raw.slice(0, 16);
  try { return new URL(raw).origin; } catch { return raw.slice(0, 40); }
};
app.post('/api/csp-report', cspReportLimiter,
  express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' }),
  (req, res) => {
    // Two shapes: the old `{"csp-report": {...}}` and the Reporting API's `[{ body: {...} }]`.
    const body = req.body as Record<string, unknown> | Array<Record<string, unknown>>;
    const reports = Array.isArray(body)
      ? body.map((r) => (r?.body ?? r) as Record<string, unknown>)
      : [((body?.['csp-report'] ?? body) as Record<string, unknown>)];
    for (const r of reports.slice(0, 5)) {
      if (!r) continue;
      const directive = String(r.effectiveDirective ?? r['effective-directive'] ??
                               r.violatedDirective ?? r['violated-directive'] ?? '?').slice(0, 40);
      const blocked = originOf(r.blockedURL ?? r['blocked-uri']);
      let docPath = '?';
      try { docPath = new URL(String(r.documentURL ?? r['document-uri'] ?? '')).pathname.slice(0, 60); }
      catch { /* leave it unknown rather than log a half-parsed URL */ }
      console.log(`[csp] ${directive} blocked=${blocked} on=${docPath}`);
    }
    res.status(204).end();
  });

app.use('/api', apiBackstop);
// Contact form: a real person files one enquiry, not five an hour. Only worth having now that
// req.ip resolves to the actual visitor — before the Cloudflare/Traefik real-IP fix this bucketed
// every submission on earth together and was therefore useless.
// Limit is env-tunable so the integration suite (which fires many submissions from one IP) can
// raise it; production leaves it at the default 5.
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: Number(process.env.CONTACT_RATE_LIMIT || 5),
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many messages — please wait a little while before sending another.' },
});
// Turnstile on the public write endpoints. POST only: GETs (e.g. /api/auth/me on every page load)
// carry no widget token and must not be challenged.
// `action` is bound per route: a token minted for the contact form must not be replayable
// against login. Matches the data-action set on each widget.
const onPost = (mw: ReturnType<typeof requireTurnstile>) =>
  (req: Request, res: Response, next: NextFunction) =>
    (req.method === 'POST' ? mw(req, res, next) : next());

app.use('/api/contact', contactLimiter);
// Public, best-effort counters + referral attribution. Under the /api backstop limiter.
app.use('/api/track', trackRoutes);
app.use('/api/auth/register', onPost(requireTurnstile('register')));
app.use('/api/auth/login', onPost(requireTurnstile('login')));
// Analytics ingest is public and batched, so the ceiling is per-network and deliberately high: a
// 60-guest party is one IP, and losing a page view matters far less than refusing a real guest.
app.use('/api/track/events', rateLimit({
  windowMs: 60 * 1000, limit: Number(process.env.ANALYTICS_RATE_LIMIT || 240),
  standardHeaders: false, legacyHeaders: false,
  message: { ok: true },     // never tell a browser its analytics were refused
}));
app.use('/api/billing/checkout', emailLimiter);
app.use('/api/billing/upgrade', emailLimiter);
// The comment above says this limiter covers "endpoints that send email or create Stripe sessions",
// and for a year it covered only the two above — the other two routes that call
// stripe.checkout.sessions.create were never mounted on it, so a Stripe session could be created at
// the 600/min backstop rate. Stripe rate-limits its own API and starts charging for the noise long
// before we notice, and /guest-upgrade needs nothing but a guest session token to reach.
app.use('/api/billing/guest-upgrade', emailLimiter);
app.use('/api/billing/branding-removal', emailLimiter);
// Enrolling a face is the cheapest request in the product to SEND and by far the most expensive to
// SERVE: routes/faces.ts backfills the whole event, one ML round trip per photo, in sequence. A
// 500-photo event is 500 detect calls for one unauthenticated POST, so it gets its own very tight
// bucket rather than the generic 600/min backstop, which would allow that 600 times a minute.
// POST only — DELETE on the same path is the withdrawal, and a withdrawal that gets refused is a
// withdrawal that did not happen.
// Posting a comment is user-generated content going onto somebody else's gallery under their own
// name. The 600/min backstop is a DoS bound, not an abuse one — this is the tighter limit that
// makes flooding a photo with messages tedious rather than free. Deliberately per IP and generous
// enough that a table of guests all talking at once is unaffected: a venue shares one NAT address,
// which is the whole reason the read path is exempted a few lines up.
// EVERY path that writes a comment, not just the first one that existed. A limiter pointed at one
// path while a second route does the same job elsewhere is the exact failure the /email-gallery note
// below describes: nothing fails loudly, the new route is simply unlimited. The share-link comment
// endpoint is the MORE exposed of the two — it is reached by a link that can be forwarded anywhere.
const commentLimiter = rateLimit({
  windowMs: 60 * 1000, limit: Number(process.env.COMMENT_RATE_LIMIT || 60),
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Slow down a moment.' },
  // POST only. Reading a thread is a guest read like any other and must not be counted — see the
  // GUEST_READ note above for why counting guest reads empties a venue's budget at the reveal.
  skip: (req) => req.method !== 'POST',
});
app.use('/api/photos/:id/comment', commentLimiter);
app.use('/api/shares/:token/photos/:id/comment', commentLimiter);

// Minting an IDENTITY is the thing worth limiting, not the heart that follows it. A visitor row is
// created by an unauthenticated POST with no name and no challenge, and the one-heart-per-visitor
// unique index is only as meaningful as the cost of becoming a new visitor — without this, that cost
// is one HTTP request, and a heart count on a shared gallery means nothing. Tighter than the comment
// limiter because a real person needs exactly one of these per link, ever.
const visitorLimiter = rateLimit({
  windowMs: 60 * 1000, limit: Number(process.env.VISITOR_RATE_LIMIT || 10),
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Slow down a moment.' },
  skip: (req) => req.method !== 'POST',
});
app.use('/api/shares/:token/visitor', visitorLimiter);
app.use('/api/photos/:joinCode/visitor', visitorLimiter);
app.use('/api/faces/enrol', rateLimit({
  windowMs: 15 * 60 * 1000, limit: Number(process.env.FACE_ENROL_RATE_LIMIT || 3),
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many face-matching attempts — please wait a few minutes and try again.' },
  skip: (req) => req.method !== 'POST',
}));
app.use('/api/auth/login', loginLimiter);
// Per-address cooldown lives in the route; this caps one IP hammering MANY addresses, which is
// the bulk-signup vector (magic-link creates an account for any new address).
app.use('/api/auth/magic-link', emailLimiter);
// Demo events are public + unauthenticated and create real (throwaway) rows — cap creation per IP.
app.use('/api/events/demo', rateLimit({
  // Env-tunable like every other limiter: the integration suite creates a demo event per run and
  // now finishes in ~30s, so a hardcoded 15/15min blocked repeat runs. Prod keeps the default.
  windowMs: 15 * 60 * 1000, limit: Number(process.env.DEMO_RATE_LIMIT || 15),
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many demo events — please wait a few minutes.' },
}));
// Organizer-triggered outbound email (gallery blast + co-host invites) — throttle to prevent a
// leaked organizer code being used as a spam relay. Only the POSTs send mail.
// The path here was `/email-gallery` for as long as the limiter has existed, and no such route
// does: the gallery blast is POST /api/events/:joinCode/email-link (routes/events.ts). So the one
// endpoint that sends up to 200 host-supplied addresses in a request was governed only by the
// generic 600/min /api backstop. Renaming a route is exactly how a limiter stops matching, and
// nothing fails loudly when it does.
app.use('/api/events/:joinCode/email-link', emailLimiter);
// Guest delivery's manual trigger sends to every guest who asked for their photos, on an
// organizer code, so it belongs under the same throttle.
app.use('/api/events/:joinCode/send-guest-link', emailLimiter);
// Firing invites at a guest list is the same abuse surface as the gallery blast — a leaked
// organizer code used as a spam relay — so it sits behind the same limiter.
app.use('/api/events/:joinCode/guests/invite', emailLimiter);
// Prefix match, so this covers BOTH /guests/import and /guests/import/preview — the same path the
// 2 MB body limit is mounted on, deliberately, so the endpoints that may accept a big body and the
// endpoints that are throttled for accepting one can never drift apart.
app.use('/api/events/:joinCode/guests/import', importLimiter);
app.use('/api/events/:joinCode/cohosts', (req: Request, res: Response, next: NextFunction) => (req.method === 'POST' ? emailLimiter(req, res, next) : next()));

// Organizer-uploaded backing tracks live under /uploads but are NOT public media — they're only
// read server-side when building a slideshow. Block direct HTTP access (this must precede the
// static mount below; the slideshow builder reads them straight off disk, unaffected). Covers both
// the per-event `audio-*` files and the legacy `slideshow-audio/` dir (pre-per-event layout).
app.use('/uploads', (req: Request, res: Response, next) => {
  // Private assets: backing audio (per-event audio-* + legacy slideshow-audio/) and feedback
  // screenshots (may contain sensitive info) — admins view those via an admin-gated route.
  if (req.path.startsWith('/slideshow-audio/') || req.path.startsWith('/feedback/') || /\/audio-[^/]*$/.test(req.path)) return res.status(404).end();
  next();
});
// Uploaded media is content-addressed by UUID filename and never mutates → cache hard.
app.use('/uploads', express.static(UPLOADS_DIR, { immutable: true, maxAge: '365d' }));

// NOTE there is no static mount and no page route below this line, and that is deliberate.
//
// nginx sends this service /api/ and /uploads/ and NOTHING else — everything that renders is the
// SvelteKit app (see nginx/default.conf). So the old src/public frontend that used to be mounted
// here was unreachable from the moment the proxy split the two, and stayed in the tree for months
// looking like live code. That is not a harmless leftover: /email-gallery, a path that only ever
// existed in it, kept a rate limiter pointed at a route that did not exist, so the gallery blast —
// 200 host-supplied addresses per press — ran under the generic backstop alone and nothing failed
// loudly. Anything served from this process must be under /api or /uploads, or nobody will ever
// reach it and the next reader will believe otherwise.

// ── Config endpoint ───────────────────────────────────────────────────────────

app.get('/api/config', (_req, res) => {
  res.json({
    // So the client never has to keep its own copy of this in step by hand — see Camera.svelte, where
    // it was a hardcoded 60_000 beside a comment saying the server is the authority.
    photoDeleteWindowSeconds: DELETE_WINDOW_SECONDS,
    version: pkg.version,
    videoMaxSeconds: parseInt(process.env.VIDEO_MAX_SECONDS || '0'),
    // Absolute ceiling for an uploaded clip. The event's own videoSeconds is a PRICE tier, not a
    // technical limit — over-length clips are kept (see photos.ts), so the client must not block on it.
    videoHardMaxSeconds: parseInt(process.env.VIDEO_HARD_MAX_SECONDS || '600'),
    // Whether this deployment can do face matching at all. A boolean, never the URL — the privacy
    // policy keys off it, because describing a feature a self-hoster does not run is simply untrue.
    faceMatchingAvailable: !!(process.env.MACHINE_LEARNING_URL || '').trim(),
    emailEnabled: email.enabled,
    supportEmail: process.env.SUPPORT_EMAIL || null,
    // Public site key so the frontend can render the Turnstile widget; null = feature off.
    turnstileSiteKey: turnstileEnabled() ? (turnstileSiteKey() || null) : null,
    options, // single source for UI dropdowns (durations, shots, reveal modes/delays)
    billing: publicBillingConfig(), // billingEnabled=false when self-hosted → no Pro UI
  });
});

// ── Theme header-image upload ─────────────────────────────────────────────────

const themeStorage = multer.diskStorage({
  // Into the event's own folder (requireOrganizer has already set req.event before multer runs).
  destination: (req, _file, cb) => {
    const dir = eventDir((req as Request).event!.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  // The extension follows the KIND, because one of them has to stay a PNG. Multer names the file
  // before the body is parsed, so `kind` is read off the query string rather than a form field.
  filename: (req, _file, cb) =>
    cb(null, `theme-${uuidv4()}.${(req as Request).query.kind === 'logo' ? 'png' : 'jpg'}`),
});
const themeUpload = multer({
  storage: themeStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only'));
  },
});

// Auth via the shared requireOrganizer gate (org-code OR authenticated owner) — same as every
// other organizer action. It runs before multer (it reads the org code from the header, no
// body needed), so an unauthorized request never writes a file.
// `?kind=` says what the file is FOR, and the only thing it changes is the encoder:
//   logo → PNG, alpha kept (a cut-out mark on a poster is nothing without its transparency)
//   anything else → JPEG, as every theme image always has been.
// Both re-encode, which is what strips the EXIF — the scrub is not optional for either.
app.post('/api/events/:joinCode/theme-image', requireOrganizer, themeUpload.single('headerImage'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const isLogo = req.query.kind === 'logo';
  try { await (isLogo ? stripImageMetadataPng : stripImageMetadata)(req.file.path); }
  catch { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Invalid or unsupported image file' }); }
  res.json({ url: `/uploads/${eventRelPath(req.event!.id, req.file.filename)}` });
});

// ── Custom slideshow backing track upload (organizer's own mp3 / wav / mp4 audio) ─────────────
const audioStorage = multer.diskStorage({
  // Into the event's own folder. Named `audio-*` so the static-mount guard keeps it private and the
  // slideshow builder can find it (it's the only `audio-` file per event).
  destination: (req, _file, cb) => {
    const dir = eventDir((req as Request).event!.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = (file.originalname.split('.').pop() || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4) || 'mp3';
    cb(null, `audio-${uuidv4()}.${ext}`);
  },
});
const audioUpload = multer({
  storage: audioStorage,
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^audio\//.test(file.mimetype) || file.mimetype === 'video/mp4'
      || /\.(mp3|wav|m4a|aac|ogg|mp4)$/i.test(file.originalname);
    ok ? cb(null, true) : cb(new Error('Audio only (mp3, wav, m4a, mp4)'));
  },
});
app.post('/api/events/:joinCode/slideshow-audio', requireOrganizer, audioUpload.single('audio'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // Validate it really is audio (the MIME/extension filter alone is spoofable); reject + remove otherwise.
  if (!(await probeHasAudioStream(req.file.path))) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'That file has no playable audio. Use an mp3, wav, m4a or mp4.' });
  }
  // Keep only the newest custom track per event.
  try {
    const dir = eventDir(req.event!.id);
    for (const f of fs.readdirSync(dir)) if (f.startsWith('audio-') && f !== req.file.filename) fs.unlinkSync(path.join(dir, f));
  } catch { /* ignore */ }
  res.json({ ok: true, filename: req.file.filename });
});

// ── API routes ────────────────────────────────────────────────────────────────

app.use('/api/auth', authLimiter, authRoutes);
// Before eventsRoutes: both are mounted on /api/events, and the specific paths here
// (/:joinCode/guests…) must be reached before any broader pattern can claim them.
app.use('/api/events', guestsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/participants', participantsRoutes);
app.use('/api/photos', photosRoutes);
app.use('/api/faces', facesRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/contact', authLimiter, contactRoutes);
app.use('/api/client-error', clientErrorLimiter, clientErrorRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/shares', sharesRoutes);
app.use('/api/cohosts', cohostsRoutes);
app.use('/api/survey', surveyRoutes);
// The preference centre. Deliberately NOT behind an auth gate or a tight limiter: it is reached
// from a link in an email, by someone who may never sign in again, and an unsubscribe that gets
// refused is an unsubscribe that did not happen. The token is 32 random bytes, so the /api backstop
// is the only ceiling it needs.
app.use('/api/email-prefs', emailPrefsRoutes);
// The guest unsubscribe, reached from an invite. Same reasoning as the preference centre above —
// an unsubscribe that gets refused is an unsubscribe that did not happen — plus one of its own: the
// one-click endpoint is posted to by a MAIL CLIENT (RFC 8058), and Gmail and Yahoo's bulk-sender
// rules judge the sender on whether it works. The token is a uuid v4 tied to one invite, so the
// /api backstop is the only ceiling it needs.
//
// The urlencoded parser is here rather than global: a one-click POST carries
// `List-Unsubscribe=One-Click` as a form body, and while the handler deliberately ignores it, an
// unparsed body left in the socket is a needless way for a client to hang. 1KB, because that is all
// the standard ever sends. Raising express.urlencoded across the whole product to serve one
// endpoint would widen the body ceiling everywhere for nothing.
app.use('/api/guest-unsubscribe', express.urlencoded({ extended: false, limit: '1kb' }), unsubscribeRoutes);
// Bundled royalty-free backing tracks — public + immutable, served for the slideshow track preview.
app.use('/api/music', express.static(MUSIC_DIR, { immutable: true, maxAge: '7d' }));

// ── Error handler (must be last) ──────────────────────────────────────────────

app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large' });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  if (err && err.status) return res.status(err.status).json({ error: err.message }); // e.g. fileFilter rejections
  if (err && /only$/.test(err.message || '')) return res.status(400).json({ error: err.message });
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong' });
});

// ── Start ─────────────────────────────────────────────────────────────────────

// A database that is briefly unavailable must not be able to kill this process for good.
//
// This bit us on devel: the DB crash-recovered, the app booted while it was still in "the database
// system is starting up", init() failed on its single attempt, and the container then sat there
// serving 502s for half an hour. Nothing recovered it — Docker does not restart a container merely
// because its healthcheck says unhealthy, and the process was still running, so the restart policy
// never came into play either.
//
// Recovery from that state took a human noticing. So instead of one attempt, keep trying: a
// recovering Postgres is usually back within seconds, and anything that looks transient is worth
// waiting out. Only a fault that persists past the whole window is worth giving up on, and then we
// exit non-zero so `restart: unless-stopped` cycles the process rather than leaving it half-alive.
const INIT_MAX_MS = Number(process.env.DB_INIT_MAX_WAIT_MS || 5 * 60 * 1000);
const INIT_STEP_MS = 2000;

// Postgres says which of these are worth retrying: 57P03 starting up, 57P01 shutting down,
// 08006/08001/08004 connection failures, plus the socket-level errors from a container that has not
// opened its port yet.
const TRANSIENT = /57P03|57P01|08006|08001|08004|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|starting up|not yet accepting/i;
const transient = (e: unknown): boolean => {
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  return TRANSIENT.test(`${err?.code ?? ''} ${err?.message ?? ''} ${err?.cause?.code ?? ''} ${err?.cause?.message ?? ''}`);
};

/** Say which billing mode we booted in, every time, in the log.
 *
 *  Billing is one environment variable from silently vanishing:
 *
 *      export const billingEnabled = !!process.env.STRIPE_SECRET_KEY;
 *
 *  and when it vanishes every cap goes with it — guest limits, video seconds, retention, the paid
 *  gate on joining — with no error anywhere, because "free self-host" is a legitimate mode that
 *  looks exactly the same. This project's recurring bug is an env var that never reached the
 *  container (compose passes them explicitly; see __tests__/compose-env.test.ts), and that failure
 *  would land here as a hosted deployment quietly giving everything away.
 *
 *  The second check is the worse one. With a secret key but no WEBHOOK secret, checkout still works
 *  and Stripe still takes the money — but the webhook that grants the entitlement cannot verify its
 *  signature, so nothing is ever granted. The customer pays and their event stays unpaid. That is
 *  money taken for nothing delivered, and it is invisible until someone complains. */
function reportBillingMode(): void {
  if (!billingEnabled) {
    console.warn('[billing] DISABLED — no STRIPE_SECRET_KEY. Every cap is off: unlimited guests, '
      + 'video, retention and shots, and no payment is required to use an event. This is correct for '
      + 'a self-host install and WRONG for a hosted one.');
    return;
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('[billing] MISCONFIGURED — STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not. '
      + 'Checkout will work and customers WILL be charged, but the webhook cannot verify its signature, '
      + 'so no entitlement is ever granted and every paid event stays unpaid. Fix before taking money.');
    return;
  }
  console.log('[billing] enabled (Stripe, webhook verified)');
}

/** Say, once at boot, whether a 'sent' on this deployment will ever become anything else.
 *
 *  Delivery tracking has the same shape of failure as billing above, and it is the reason this line
 *  exists rather than being left to the guest list: with MAILGUN_WEBHOOK_SIGNING_KEY missing,
 *  EVERYTHING STILL WORKS. Invites send, the host sees "sent", and nothing anywhere is red. The
 *  only symptom is that no invite ever moves off 'sent' and no bounce is ever recorded, which looks
 *  exactly like a run of good luck for as long as it takes to notice.
 *
 *  This project's recurring bug is an env var that never reached the container — compose passes
 *  them explicitly, see __tests__/compose-env.test.ts — and that failure lands here silently. One
 *  line in the log is what tells the two apart at a glance. */
function reportDeliveryTracking(): void {
  if (email.provider !== 'mailgun') return;   // nothing to say: no other transport can report back
  if (!process.env.MAILGUN_WEBHOOK_SIGNING_KEY) {
    console.warn('[mailgun] delivery tracking OFF — no MAILGUN_WEBHOOK_SIGNING_KEY. Invites still send, '
      + 'but every one stays at "sent, delivery unknown" and no bounce or spam complaint is ever recorded. '
      + 'The webhook endpoint answers 404 until a key is set. See docs/DELIVERY-TRACKING.md.');
    return;
  }
  console.log('[mailgun] delivery tracking enabled (webhook signature verification armed)');
}

async function initWithRetry(): Promise<void> {
  const deadline = Date.now() + INIT_MAX_MS;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      await init();
      if (attempt > 1) console.log(`[boot] database ready after ${attempt} attempts`);
      return;
    } catch (err) {
      // A schema/migration fault will never fix itself by waiting, so fail fast and loudly on it.
      if (!transient(err) || Date.now() > deadline) throw err;
      console.warn(`[boot] database not ready (attempt ${attempt}): ${(err as Error).message.split('\n')[0]} — retrying in ${INIT_STEP_MS}ms`);
      await new Promise((r) => setTimeout(r, INIT_STEP_MS));
    }
  }
}

initWithRetry()
  .then(async () => {
    await ensureAdminFromEnv(); // bootstrap a site admin from ADMIN_EMAIL/ADMIN_PASSWORD (no-op if unset)
    startCleanup(); // periodic retention sweep (deletes expired events + their files)
    startLifecycle(); // customer lifecycle emails (welcome/check-in/survey) — off unless LIFECYCLE_EMAILS=1
    startCounters();  // write-behind flush loop for gallery/referral counters
    startAnalytics();          // same write-behind shape as the counters above
    startOps();       // operator notifications (daily digest + instant alerts) — off unless OPS_NOTIFICATIONS=1
    reportBillingMode();
    reportDeliveryTracking();
    /* Face matching is held inert by MACHINE_LEARNING_URL being unset, and it is held there for a
       LEGAL reason, not a technical one. The risk in that arrangement is not the code — the kill
       switch is tested as an interlock — it is deployment: the variable IS set on devel, so one
       copied env file turns the feature on in production silently. A line in the boot log is what
       makes that loud instead, and it prints in both states so its absence is not the signal. */
    console.log(process.env.MACHINE_LEARNING_URL
      ? '[faces] FACE MATCHING IS LIVE — MACHINE_LEARNING_URL is set. This must NOT be a production boot until the privacy review is signed off (docs/PIA-face-matching.md).'
      : '[faces] face matching inert (MACHINE_LEARNING_URL unset) — the intended state for production');
    const server = app.listen(PORT, '0.0.0.0', () => console.log(`Snapdini running on port ${PORT}`));
    // Multi-GB media uploads (e.g. a 90s 4K/8K clip) can take a long time on event Wi-Fi/mobile;
    // Node's default 5-min requestTimeout would abort them mid-transfer. Allow up to an hour.
    server.requestTimeout = 60 * 60 * 1000;
    server.headersTimeout = 2 * 60 * 1000; // but headers must still arrive promptly (slow-loris guard)
    // One-off idempotent move of any pre-per-event assets into /uploads/<eventId>/, THEN backfill
    // thumbnails (which now scans the event subfolders too). Both best-effort, off the request path.
    migrateUploadsToPerEvent()
      .catch((e) => console.error('[migrate] failed:', (e as Error).message))
      .finally(() => {
        backfillThumbnails(UPLOADS_DIR)
          .catch(() => {})
          // After thumbnails, never alongside them — both are ffmpeg/sharp bound. Driven from the
          // photos table so it only ever touches guest uploads, not slideshow renders.
          .finally(async () => {
            try {
              const vids = await db.select({ filename: photos.filename })
                .from(photos).where(eq(photos.mediaType, 'video'));
              await backfillPlaybackProxies(UPLOADS_DIR, vids.map((v) => v.filename));
            } catch { /* best effort */ }
          });
      });
  })
  .catch((err) => {
    // Exit rather than linger: a running-but-uninitialised process answers 502s forever, and the
    // restart policy can only help if we actually stop.
    console.error('Failed to initialize database after retrying:', err);
    process.exit(1);
  });
