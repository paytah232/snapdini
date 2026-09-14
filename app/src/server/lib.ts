// Small shared server-side helpers, deduped out of the route files.
import type { Request } from 'express';
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
