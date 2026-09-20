import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import * as email from '../email';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { contactMessages, events } from '../schema';
import { requireTurnstile } from '../turnstile';
import { escapeHtml } from '../lib';
import { UPLOADS_DIR } from '../paths';
import { stripImageMetadata } from '../images';

const router = Router();

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || '';
const isEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const KINDS = new Set(['contact', 'bug', 'feedback', 'suggestion', 'refund']);

// Human snapshot (Sydney time) frozen at request time so refund eligibility can't drift later.
function refundSnapshot(ev: { name: string; joinCode: string; startsAt: number; amountPaidCents: number }, now: number): string {
  const fmt = (ms: number) => new Intl.DateTimeFormat('en-AU', { timeZone: process.env.OPS_TZ || 'Australia/Brisbane', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
  const eligible = now < ev.startsAt;
  return [
    `REFUND / CANCELLATION REQUEST`,
    `Event: "${ev.name}" (${ev.joinCode})`,
    `Paid: A$${(ev.amountPaidCents / 100).toFixed(2)}`,
    `Requested: ${fmt(now)}`,
    `Event starts: ${fmt(ev.startsAt)}`,
    eligible ? `✅ BEFORE event start — full-refund eligible` : `⚠️ AFTER event start — fault-based/case-by-case only`,
  ].join('\n');
}

// Optional screenshot for bug reports / feedback → UPLOADS_DIR/feedback/<uuid>.jpg. Kept out of the
// public tree by the /uploads/feedback guard in index.ts; admins view it via an admin route.
const shotUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { const d = path.join(UPLOADS_DIR, 'feedback'); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename: (_req, _file, cb) => cb(null, `${uuidv4()}.jpg`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => { file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Screenshot must be an image')); },
});

const dropScreenshot = (req: Request): void => {
  if (req.file) { try { fs.unlinkSync(req.file.path); } catch { /* */ } }
};

/**
 * The bot check, plus the unlink it needs to not leak files.
 *
 * The gate cannot move ahead of multer the way index.ts's theme-image upload moves requireOrganizer
 * ahead of it. That one reads the organizer code from a HEADER, so it needs no body; Turnstile's
 * token arrives as the form field `cf-turnstile-response`, and on the multipart submissions — the
 * only ones that carry a file at all — that field does not exist until multer has parsed the body.
 * Checking first would find no token and 403 every in-app feedback report and every refund request
 * (web FeedbackModal.svelte and admin/[code]/+page.svelte both append it to the FormData).
 *
 * So the file is unavoidably on disk by the time we can judge the request. What was missing is what
 * happens next: requireTurnstile answers 403 itself and never calls next(), so the handler — which
 * owns every other unlink in this route — never runs, and the screenshot stays on disk forever.
 * There are orphans on the dev box from exactly this. Sweep it here instead.
 */
const turnstileGate = requireTurnstile('contact');
const requireTurnstileOrDropFile = (req: Request, res: Response, next: NextFunction): void => {
  let passed = false;
  void Promise.resolve(turnstileGate(req, res, () => { passed = true; next(); }))
    .then(() => { if (!passed) dropScreenshot(req); })
    .catch(() => { dropScreenshot(req); });
};

// POST /api/contact — public contact / feedback / bug-report form. ALWAYS stored in the DB (a durable
// mailbox) so nothing is lost if email is unconfigured or the send fails; forwarded to SUPPORT_EMAIL
// when email is configured. Accepts JSON (contact page) or multipart with an optional 'screenshot'.
/** The subject line of the support email, built from the parts that EXIST.
 *
 *  It used to read `Snapdini feedback report — someone` whenever nobody gave a name. "someone"
 *  carries no information, and in an inbox it reads as though the sender is being described rather
 *  than simply unnamed — an anonymous report is a normal thing, and the subject should be shorter
 *  for it rather than padded out.
 *
 *  The event code earns its place because it is the first question asked about any report, and it
 *  was previously only discoverable by opening the mail and reading the "Where" line.
 *
 *  Its own function so the shape can be pinned: a subject line is the most-read string this system
 *  produces and the least likely to be noticed when it regresses. */
export function supportSubject(label: string, name?: string | null, eventCode?: string | null): string {
  return ['Snapdini ' + label, name, eventCode].filter(Boolean).join(' — ');
}

router.post('/', shotUpload.single('screenshot'), requireTurnstileOrDropFile, async (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const from = String(req.body?.email || '').trim().slice(0, 200);
  const message = String(req.body?.message || '').trim().slice(0, 5000);
  const kind = KINDS.has(String(req.body?.kind)) ? String(req.body.kind) : 'contact';
  const context = String(req.body?.context || '').trim().slice(0, 300);   // e.g. the page/event it came from
  // Structured, rather than dug back out of `context`. The code was always arriving — inside a
  // sentence written for a human ("Camera (ABC123)") — which is no basis for a subject line or a
  // query. Upper-cased because that is how a join code is written everywhere else it appears.
  const eventCode = String(req.body?.eventCode || '').trim().slice(0, 20).toUpperCase();

  // Honeypot: a field real users never see and never fill (hidden + aria-hidden + tabindex=-1 in
  // the form). Accept SILENTLY with a 200 rather than erroring — a bot that gets a 400 learns to
  // adapt, one that gets a cheerful success does not, and a real user is never affected.
  if (String(req.body?.website || '').trim()) {
    dropScreenshot(req);
    return res.json({ success: true });
  }

  if (!message) { dropScreenshot(req); return res.status(400).json({ error: 'Please enter a message' }); }
  if (from && !isEmail(from)) { dropScreenshot(req); return res.status(400).json({ error: 'Enter a valid email (or leave it blank)' }); }

  let imageFilename: string | null = null;
  if (req.file) {
    try { await stripImageMetadata(req.file.path); imageFilename = `feedback/${req.file.filename}`; }
    catch { dropScreenshot(req); return res.status(400).json({ error: 'That screenshot could not be read' }); }
  }

  // Refund/cancellation requests: freeze an eligibility snapshot from the event's start time.
  let refundHeader = '';
  if (kind === 'refund') {
    if (eventCode) {
      const [ev] = await db.select({ name: events.name, joinCode: events.joinCode, startsAt: events.startsAt, amountPaidCents: events.amountPaidCents })
        .from(events).where(eq(events.joinCode, eventCode));
      if (ev) refundHeader = refundSnapshot(ev, Date.now()) + '\n\n';
    }
  }

  const fullMessage = refundHeader + (context ? `${message}\n\n— from: ${context}` : message);
  const label = kind === 'contact' ? 'contact message' : kind === 'refund' ? 'refund / cancellation request' : `${kind} report`;

  let emailed = false;
  if (email.enabled && SUPPORT_EMAIL) {
    try {
      await email.sendMail({
        // Our own inbox. Suppression is about people we mail; this is someone mailing US.
        always: true,
        to: SUPPORT_EMAIL,
        subject: supportSubject(label, name, eventCode),
        replyTo: from || undefined,
        html: email.htmlEmail(`New ${label}`, `
          <p><strong>From:</strong> ${escapeHtml(name || 'Anonymous')}${from ? ` &lt;${escapeHtml(from)}&gt;` : ''}</p>
          ${context ? `<p><strong>Where:</strong> ${escapeHtml(context)}</p>` : ''}
          ${refundHeader ? `<pre style="white-space:pre-wrap;background:#14110b;border-left:3px solid #f0b429;padding:10px 12px;border-radius:0 8px 8px 0;color:#e8e0cf;font-size:13px">${escapeHtml(refundHeader.trim())}</pre>` : ''}
          <p style="white-space:pre-wrap">${escapeHtml(message)}</p>
          ${imageFilename ? '<p><em>(screenshot attached — view it in Site admin)</em></p>' : ''}
        `),
      });
      emailed = true;
    } catch { /* fall back to the DB record below */ }
  }

  await db.insert(contactMessages).values({
    id: uuidv4(), name: name || null, email: from || null, message: fullMessage, kind, imageFilename,
    eventCode: eventCode || null, emailed, createdAt: Date.now(),
  });
  res.json({ success: true });
});

export default router;
