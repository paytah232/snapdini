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
