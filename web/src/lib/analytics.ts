// First-party product analytics, client side.
//
// Nothing is stored on the device — no cookie, no localStorage, not even sessionStorage. Grouping
// into a visit happens server-side from a daily-rotating hash, which is why this file has no
// notion of an id at all. That is deliberate: it keeps the feature outside the cookie-consent
// question entirely, which is the only reason it can be on by default.
//
// Events are queued and flushed together, because a page view must not cost a request, and
// `keepalive` is what lets the last batch survive the navigation that triggered it.
import { browser } from '$app/environment';

export type EventName =
  | 'page_view' | 'cta_click' | 'pricing_tier_click' | 'faq_open'
  | 'signup_started' | 'signup_submitted' | 'verify_email_opened' | 'login_submitted'
  | 'event_create_started' | 'event_created' | 'checkout_started' | 'checkout_returned'
  | 'upgrade_panel_opened' | 'poster_opened' | 'slideshow_started' | 'share_link_created'
  | 'join_opened' | 'joined' | 'camera_permission_granted' | 'camera_permission_denied'
  | 'photo_captured' | 'roll_completed' | 'guest_gallery_opened'
  | 'guest_feedback_opened' | 'guest_feedback_sent' | 'referral_card_click' | 'face_finder_opened';

type Queued = { name: EventName; path?: string; props?: Record<string, string | number | boolean>; joinCode?: string };

const FLUSH_MS = 2500;
const MAX_QUEUE = 40;
let queue: Queued[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

function send(batch: Queued[], viaBeacon = false): void {
  if (!batch.length) return;
  const body = JSON.stringify({ events: batch });
  try {
    // sendBeacon survives the page going away; fetch+keepalive is the fallback and is fine inline.
    if (viaBeacon && navigator.sendBeacon?.(
      '/api/track/events', new Blob([body], { type: 'application/json' }))) return;
    void fetch('/api/track/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body, keepalive: true, credentials: 'same-origin',
    }).catch(() => {});
  } catch { /* analytics must never break a page */ }
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = undefined; const b = queue; queue = []; send(b); }, FLUSH_MS);
}

/** Queue one event. Safe to call anywhere, including during SSR (it becomes a no-op). */
export function track(name: EventName, props?: Record<string, string | number | boolean>, joinCode?: string): void {
  if (!browser) return;
  if (queue.length >= MAX_QUEUE) return;                 // shed rather than grow
  queue.push({ name, path: location.pathname, props, joinCode });
  // Send the funnel-critical ones promptly: they are usually the last thing before a navigation
  // that would otherwise discard the batch.
  if (name === 'checkout_started' || name === 'signup_submitted' || name === 'cta_click') {
    if (timer) { clearTimeout(timer); timer = undefined; }
    const b = queue; queue = []; send(b, true);
    return;
  }
  schedule();
}

/** Flush whatever is queued — on tab hide and on unload, where a normal fetch would be dropped. */
export function flushAnalytics(): void {
  if (!browser || !queue.length) return;
  if (timer) { clearTimeout(timer); timer = undefined; }
  const b = queue; queue = [];
  send(b, true);
}

let wired = false;
/** Call once from the root layout. Records page views and flushes on the way out. */
export function initAnalytics(): void {
  if (!browser || wired) return;
  wired = true;
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAnalytics(); });
  addEventListener('pagehide', flushAnalytics);
}
