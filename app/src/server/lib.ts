// Small shared server-side helpers, deduped out of the route files.
import type { Request, Response, NextFunction } from 'express';
import type { Event } from './schema';
import { scheduledRevealAt } from '../../../shared/reveal';

type RevealFields = Pick<Event, 'revealMode' | 'revealedAt' | 'expiresAt' | 'revealDelayHours' | 'revealAt'> & { revealHidden?: boolean };

// Whether an event's photos are currently visible, per its reveal mode + organizer overrides.
export function isRevealed(event: RevealFields): boolean {
  // "Hide photos" is an explicit organizer override — it wins over everything, including an
  // at_end event that has already ended (otherwise time would force it back to revealed).
  if (event.revealHidden) return false;
  if (event.revealMode === 'instant') return true;
  // "Reveal all now" sets revealedAt and wins in any mode (e.g. reveal an at_end event early).
  if (event.revealedAt) return true;
  // Nothing schedules this — the instant is recomputed on every read, so the gate opens on its own
  // the moment it passes and there is no timer anywhere to fall behind or double-fire.
  const at = scheduledRevealAt(event);
  return at !== null && Date.now() >= at;
}

// Public base URL for building links (QR, emails, verify/redirects). Always prefer the
// configured BASE_URL. The request Host header is attacker-controllable, so we only fall
// back to it in development — never silently trust it for security-sensitive links in prod.
let warnedNoBaseUrl = false;
export function baseUrl(req: Request): string {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  if (process.env.NODE_ENV === 'production' && !warnedNoBaseUrl) {
    warnedNoBaseUrl = true;
    console.warn('[security] BASE_URL is not set in production — links could be host-header-poisoned. Set BASE_URL.');
  }
  return `${req.protocol}://${req.get('host')}`.replace(/\/$/, '');
}

// Escape a string for safe interpolation into HTML (e.g. email bodies).
export function escapeHtml(str: unknown): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str).replace(/[&<>"']/g, (c) => map[c]);
}


// ── Reschedule window ────────────────────────────────────────────────────────
// How far an UNUSED event may be moved from its ORIGINAL start. Defined once and imported by both
// the settings guard (routes/events.ts) and the retention sweeper (cleanup.ts) — they must agree,
// or an event gets purged while it is still advertised as reschedulable.
export const RESCHEDULE_WINDOW_MS = 183 * 24 * 60 * 60 * 1000;   // ~6 months

// Retention keeps an unused event a little BEYOND its own deadline. Without this the sweeper's
// cutoff and the reschedule cutoff are the same instant, so an hourly sweep can delete the event on
// the very last day the organizer is still entitled to move it.
export const RESCHEDULE_RETENTION_GRACE_MS = 24 * 60 * 60 * 1000;   // one day

/** Marks the public "see what it looks like" demo events. A demo is an event with this name and
 *  NO owner — there is no is_demo column, so anything filtering demos derives it from those two. */
export const DEMO_NAME = 'Demo Roll 🎞️';

/** THE discriminator, in one place, so nothing has to re-derive it and nothing can get it subtly
 *  different. Both halves are load-bearing and neither alone is enough:
 *    · the NAME alone would catch a real host who titled their event "Demo Roll 🎞️" — anyone may;
 *    · NO OWNER alone is not a demo either, it is just an un-owned event.
 *  Deliberately NOT keyed on guestCap === 2 or on the 4h duration: both are ordinary settings a
 *  host can choose, so either would hand a real event the demo's behaviour. routes/admin.ts and
 *  guest-delivery.ts already filter on exactly this pair in SQL; this is the TypeScript half. */
export const isDemoEvent = (e: { ownerUserId: string | null; name: string }): boolean =>
  !e.ownerUserId && e.name === DEMO_NAME;

// ── Retention ────────────────────────────────────────────────────────────────

/** The global retention floor, in days, for an event that holds no longer allowance of its own.
 *
 *  Read here rather than in each route because it was NOT read in each route: the Stripe webhook
 *  had `|| 7` written into it, so an operator who set RETENTION_DAYS=30 got thirty days everywhere
 *  except the one path a customer reaches by paying us. */
export const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '7', 10) || 7;

/**
 * When an event's photos are destroyed: its end, plus the retention the customer actually holds.
 *
 * This is the single most destructive number in the product — cleanup.ts deletes every photo of
 * every event whose purgeAt has passed, and there is no undo — so it is computed in one place and
 * defended here rather than at four call sites.
 *
 * `expiresAt` is required and must be a real instant. The bug this replaces read it as
 * `parseInt(metadata.expiresAt, 10) || 0`, which turned absent metadata into the epoch: purgeAt
 * landed on 8 January 1970, comfortably in the past, and the next sweep destroyed the photos of an
 * event whose owner had just paid to upgrade it. A missing expiry is not a zero, so it throws.
 */
export function purgeAtFor(expiresAt: number, retentionDays?: number | null): number {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0)
    throw new RangeError(`purgeAtFor: refusing to compute a purge from expiresAt=${expiresAt}`);
  const d = Number(retentionDays);
  // Anything unusable — absent, zero, negative, NaN — falls back to the floor rather than to a
  // shorter window. Every wrong answer here costs somebody their photos, so the failure leans long.
  const days = Number.isFinite(d) && d > 0 ? d : RETENTION_DAYS;
  return expiresAt + days * 86_400_000;
}

/** The purge instant for a WHOLE EVENT, which is not always purgeAtFor's answer.
 *
 *  A demo is created with purgeAt == expiresAt so it cleans itself up about three hours after
 *  somebody pokes at it. That short life is the entire reason an unowned, fully-entitled event is
 *  allowed to sit on the public site at all.
 *
 *  purgeAtFor's job is the opposite: it leans LONG on purpose, because for a real event every wrong
 *  answer costs somebody their photos. Handing it a demo therefore pushed the purge out by the full
 *  retention window, so ANY settings save — including one the demo's own guided setup makes —
 *  quietly promoted a throwaway into a month-long event. They then accumulated, because nothing
 *  else ever shortens a purge.
 *
 *  Kept out of purgeAtFor itself: that takes two numbers and knows nothing about owners or names,
 *  and teaching it would mean threading a whole event through a pure calculation to serve one
 *  caller. This is that caller's question, so it gets its own name.
 *
 *  A real event is untouched — same expiry, same retention, same answer — so rescheduling still
 *  moves the purge with the new date, and a paid retention extension is still honoured. */
export function purgeAtForEvent(
  ev: { ownerUserId: string | null; name: string; retentionDays?: number | null },
  expiresAt: number,
): number {
  return isDemoEvent(ev) ? expiresAt : purgeAtFor(expiresAt, ev.retentionDays);
}

// ── express 5: a body that was never parsed is `undefined`, not `{}` ─────────
//
// body-parser 2 — what express 5 brings with it — sets `req.body = undefined` where 1.x left an
// empty object behind (lib/read.js: `if (!('body' in req)) req.body = undefined`). So every
// handler in this app that reads a field the way a handler naturally does, `const { theme } =
// req.body`, stopped answering "400 Invalid theme" to a request that arrived without one and
// started throwing a TypeError instead — which express 5 dutifully forwards to the error
// middleware, where it becomes 500 "Something went wrong". Around forty call sites across the
// routers, every one of them correct when it was written, every one of them now reporting a
// server fault for a client mistake. And the trigger is not exotic: a POST with no Content-Type
// is what every scanner, every hand-rolled curl and every fetch() that forgot its header sends.
//
// ONE MIDDLEWARE, rather than forty `?? {}`s. The scattered version was considered and rejected
// twice over: it is forty chances to miss one — the audit that found this had itself only
// spotted eight — and it is forty places for the next handler to be written without it.
// Restoring, once and where the bodies are parsed, the property the whole codebase was written
// against leaves every one of those handlers taking exactly the branch and returning exactly the
// status code it did under express 4.
//
// IT CANNOT SWALLOW A REAL BODY. Only `undefined` is replaced. body-parser 2 decides whether to
// parse from the request STREAM (`onFinished.isFinished`, then `hasBody`) and not from the value
// of `req.body`, so a parser mounted further down the stack — the urlencoded one on
// /api/guest-unsubscribe, multer on the upload routes — still reads its body and still replaces
// this placeholder with it. The one body that must never be touched, Stripe's raw webhook
// payload, is read on a route mounted above this one.
export function bodyDefaultsToEmpty(req: Request, _res: Response, next: NextFunction): void {
  if (req.body === undefined) req.body = {};
  next();
}
