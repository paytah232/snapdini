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
import { stripImageMetadata, backfillThumbnails, backfillPlaybackProxies } from './images';
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
import photosRoutes from './routes/photos';
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
const apiBackstop = rateLimit({
  windowMs: 60 * 1000, limit: Number(process.env.API_RATE_LIMIT || 600),
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many requests — slow down.' },
});
// Tighter limit for endpoints that send email or create Stripe sessions (abuse-prone).
const emailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: Number(process.env.EMAIL_RATE_LIMIT || 20),
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many requests — please wait a few minutes.' },
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
// A guest emailing themselves their own gallery link is a PER-PERSON action, but a whole party is
// behind one venue wifi — a single public IP. Sharing emailLimiter's 20/15min meant the 21st guest
// at a 60-guest event was simply refused; worse, guests could exhaust the budget that
// /api/billing/checkout and /api/billing/upgrade share, blocking the HOST from paying mid-event.
// So key it on the guest's own session instead, behind a generous per-IP backstop that still bounds
// how many distinct buckets one address can create (an unbounded key space is a memory vector).
const guestEmailIpBackstop = rateLimit({
  windowMs: 15 * 60 * 1000, limit: Number(process.env.GUEST_EMAIL_IP_LIMIT || 200),
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many requests from this network — try again in a few minutes.' },
});
const guestEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: Number(process.env.GUEST_EMAIL_RATE_LIMIT || 5),
  standardHeaders: 'draft-7', legacyHeaders: false,
  // express.json() runs above, so the body is parsed by the time this sees the request.
  keyGenerator: (req: Request) => {
    const t = (req.body as { sessionToken?: unknown } | undefined)?.sessionToken;
    return typeof t === 'string' && t ? `s:${t}` : `ip:${req.ip}`;
  },
  message: { error: "You've already emailed yourself a few times — check your inbox, including spam." },
});
app.use('/api/participants/email-my-photos', guestEmailIpBackstop, guestEmailLimiter);
// Analytics ingest is public and batched, so the ceiling is per-network and deliberately high: a
// 60-guest party is one IP, and losing a page view matters far less than refusing a real guest.
app.use('/api/track/events', rateLimit({
  windowMs: 60 * 1000, limit: Number(process.env.ANALYTICS_RATE_LIMIT || 240),
  standardHeaders: false, legacyHeaders: false,
  message: { ok: true },     // never tell a browser its analytics were refused
}));
app.use('/api/billing/checkout', emailLimiter);
app.use('/api/billing/upgrade', emailLimiter);
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
app.use('/api/events/:joinCode/cohosts', (req: Request, res: Response, next: NextFunction) => (req.method === 'POST' ? emailLimiter(req, res, next) : next()));

// Landing page is the front door at `/` — registered before the static middleware,
// which would otherwise serve index.html (now the quick create/join tool, at /app).
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '../public/landing.html')));
app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

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
app.use(express.static(path.join(__dirname, '../public')));

// ── Config endpoint ───────────────────────────────────────────────────────────

app.get('/api/config', (_req, res) => {
  res.json({
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
  filename: (_req, _file, cb) => cb(null, `theme-${uuidv4()}.jpg`),
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
app.post('/api/events/:joinCode/theme-image', requireOrganizer, themeUpload.single('headerImage'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try { await stripImageMetadata(req.file.path); }
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
// Bundled royalty-free backing tracks — public + immutable, served for the slideshow track preview.
app.use('/api/music', express.static(MUSIC_DIR, { immutable: true, maxAge: '7d' }));

// ── Page routes ───────────────────────────────────────────────────────────────

const pub = (p: string) => path.join(__dirname, '../public', p);

app.get('/join/:code', (_req, res) => res.sendFile(pub('event.html')));
app.get('/e/:slug', (_req, res) => res.sendFile(pub('event.html')));
app.get('/gallery/:code', (_req, res) => res.sendFile(pub('gallery.html')));
app.get('/admin/:code', (_req, res) => res.sendFile(pub('admin.html')));
app.get('/signup', (_req, res) => res.sendFile(pub('signup.html')));
app.get('/login', (_req, res) => res.sendFile(pub('login.html')));
app.get('/dashboard', (_req, res) => res.sendFile(pub('dashboard.html')));

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
