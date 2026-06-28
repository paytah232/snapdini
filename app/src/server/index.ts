import express, { type Request, type Response, type NextFunction } from 'express';
import 'express-async-errors'; // lets async route handlers throw to the error middleware
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import { and, eq, or } from 'drizzle-orm';
import { db, init } from './db';
import { events } from './schema';
import { stripImageMetadata, backfillThumbnails } from './images';
import { start as startCleanup } from './cleanup';
import options from './options';
import { publicBillingConfig } from './billing';
import * as email from './email';
import { UPLOADS_DIR } from './paths';
import { MUSIC_DIR, probeHasAudioStream } from './slideshow';
import authRoutes from './routes/auth';
import eventsRoutes, { requireOrganizer } from './routes/events';
import participantsRoutes from './routes/participants';
import photosRoutes from './routes/photos';
import billingRoutes, { stripeWebhookHandler } from './routes/billing';
import contactRoutes from './routes/contact';
import clientErrorRoutes from './routes/clienterror';
import adminRoutes from './routes/admin';
import sharesRoutes from './routes/shares';
import cohostsRoutes from './routes/cohosts';
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

app.use(express.json());
app.use(cookieParser());

// Rate limiting. Strict on auth (low-volume organizer actions). NOTE: event guests at a
// venue share one public IP, so join/upload/gallery are intentionally NOT IP-limited hard —
// only a generous DoS backstop covers the rest of the API.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many attempts — please wait a few minutes and try again.' },
  // Only throttle credential POSTs (login/register/magic-link). GET /api/auth/me runs on every
  // page load, so counting it tripped "too many attempts" during normal navigation.
  skip: (req) => req.method === 'GET',
});
const apiBackstop = rateLimit({
  windowMs: 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many requests — slow down.' },
});
// Tighter limit for endpoints that send email or create Stripe sessions (abuse-prone).
const emailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
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
  windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many attempts — please wait a few minutes and try again.' },
  skip: (req) => req.method === 'GET',
});
app.use('/api', apiBackstop);
app.use('/api/participants/email-my-photos', emailLimiter);
app.use('/api/billing/checkout', emailLimiter);
app.use('/api/billing/upgrade', emailLimiter);
app.use('/api/auth/login', loginLimiter);
// Demo events are public + unauthenticated and create real (throwaway) rows — cap creation per IP.
app.use('/api/events/demo', rateLimit({
  windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many demo events — please wait a few minutes.' },
}));
// Organizer-triggered outbound email (gallery blast + co-host invites) — throttle to prevent a
// leaked organizer code being used as a spam relay. Only the POSTs send mail.
app.use('/api/events/:joinCode/email-gallery', emailLimiter);
app.use('/api/events/:joinCode/cohosts', (req: Request, res: Response, next: NextFunction) => (req.method === 'POST' ? emailLimiter(req, res, next) : next()));

// Landing page is the front door at `/` — registered before the static middleware,
// which would otherwise serve index.html (now the quick create/join tool, at /app).
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '../public/landing.html')));
app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// Organizer-uploaded backing tracks live under /uploads but are NOT public media — they're only
// read server-side when building a slideshow. Block direct HTTP access (this must precede the
// static mount below; the slideshow builder reads them straight off disk, unaffected).
app.use('/uploads/slideshow-audio', (_req: Request, res: Response) => res.status(404).end());
// Uploaded media is content-addressed by UUID filename and never mutates → cache hard.
app.use('/uploads', express.static(UPLOADS_DIR, { immutable: true, maxAge: '365d' }));
app.use(express.static(path.join(__dirname, '../public')));

// ── Config endpoint ───────────────────────────────────────────────────────────

app.get('/api/config', (_req, res) => {
  res.json({
    version: pkg.version,
    videoMaxSeconds: parseInt(process.env.VIDEO_MAX_SECONDS || '0'),
    emailEnabled: email.enabled,
    supportEmail: process.env.SUPPORT_EMAIL || null,
    options, // single source for UI dropdowns (durations, shots, reveal modes/delays)
    billing: publicBillingConfig(), // billingEnabled=false when self-hosted → no Pro UI
  });
});

// ── Theme header-image upload ─────────────────────────────────────────────────

const themeStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(UPLOADS_DIR, 'themes');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, _file, cb) => cb(null, `${uuidv4()}.jpg`),
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
  res.json({ url: `/uploads/themes/${req.file.filename}` });
});

// ── Custom slideshow backing track upload (organizer's own mp3 / wav / mp4 audio) ─────────────
const audioStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(UPLOADS_DIR, 'slideshow-audio');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  // Prefixed with the event id so the slideshow builder can find it and the purge can clean it.
  filename: (req, file, cb) => {
    const ext = (file.originalname.split('.').pop() || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4) || 'mp3';
    cb(null, `${(req as Request).event!.id}-${uuidv4()}.${ext}`);
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
    const dir = path.join(UPLOADS_DIR, 'slideshow-audio');
    const prefix = req.event!.id + '-';
    for (const f of fs.readdirSync(dir)) if (f.startsWith(prefix) && f !== req.file.filename) fs.unlinkSync(path.join(dir, f));
  } catch { /* ignore */ }
  res.json({ ok: true, filename: req.file.filename });
});

// ── API routes ────────────────────────────────────────────────────────────────

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/participants', participantsRoutes);
app.use('/api/photos', photosRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/contact', authLimiter, contactRoutes);
app.use('/api/client-error', clientErrorLimiter, clientErrorRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/shares', sharesRoutes);
app.use('/api/cohosts', cohostsRoutes);
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

init()
  .then(async () => {
    await ensureAdminFromEnv(); // bootstrap a site admin from ADMIN_EMAIL/ADMIN_PASSWORD (no-op if unset)
    startCleanup(); // periodic retention sweep (deletes expired events + their files)
    const server = app.listen(PORT, '0.0.0.0', () => console.log(`Snapdini running on port ${PORT}`));
    // Multi-GB media uploads (e.g. a 90s 4K/8K clip) can take a long time on event Wi-Fi/mobile;
    // Node's default 5-min requestTimeout would abort them mid-transfer. Allow up to an hour.
    server.requestTimeout = 60 * 60 * 1000;
    server.headersTimeout = 2 * 60 * 1000; // but headers must still arrive promptly (slow-loris guard)
    // Best-effort: generate thumbnails for any pre-existing originals that lack one.
    backfillThumbnails(UPLOADS_DIR).catch(() => {});
  })
  .catch((err) => { console.error('Failed to initialize database:', err); process.exit(1); });
