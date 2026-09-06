// Small shared server-side helpers, deduped out of the route files.
import type { Request } from 'express';
import type { Event } from './schema';

type RevealFields = Pick<Event, 'revealMode' | 'revealedAt' | 'expiresAt' | 'revealDelayHours'> & { revealHidden?: boolean };

// Whether an event's photos are currently visible, per its reveal mode + organizer overrides.
export function isRevealed(event: RevealFields): boolean {
  // "Hide photos" is an explicit organizer override — it wins over everything, including an
  // at_end event that has already ended (otherwise time would force it back to revealed).
  if (event.revealHidden) return false;
  if (event.revealMode === 'instant') return true;
  // "Reveal all now" sets revealedAt and wins in any mode (e.g. reveal an at_end event early).
  if (event.revealedAt) return true;
  if (event.revealMode === 'at_end')
    return Date.now() >= event.expiresAt + (event.revealDelayHours || 0) * 3600000;
  return false;
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
