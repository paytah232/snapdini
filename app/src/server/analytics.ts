// First-party product analytics.
//
// Why this exists rather than a GA4 tag: the project's own pitch is "no GTAG_ID => zero
// third-party tracking", and the question it needs to answer — where do people give up — does not
// require handing anyone's browsing to a third party.
//
// Three properties hold this together, and they are the reason it is defensible:
//
//  1. NOTHING is stored on the visitor's device. No cookie, no localStorage. `visitKey` derives a
//     hash from a daily-rotating secret + IP + user-agent, so events can be grouped into a visit
//     for funnel maths and cannot be joined across days, sites, or back to a person. The raw IP is
//     never written anywhere.
//  2. Event names come from an ALLOWLIST. A public endpoint that writes arbitrary strings into a
//     table is a spam sink and a stored-XSS vector waiting for a careless admin panel.
//  3. Writes are buffered and flushed in batches, like counters.ts, because a page view must never
//     put a round-trip to Postgres on the request path.
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from './db';

/** Every event the product may record. Anything else is dropped, silently and deliberately. */
export const EVENT_NAMES = [
  // ── marketing funnel ──
  'page_view',
  'cta_click',              // props: { cta: 'hero' | 'pricing_tier' | 'contact_400' | ... }
  'pricing_tier_click',     // props: { tier: 'free' | '25' | '60' | '150' | '400' }
  'faq_open',               // props: { q }
  'signup_started',
  'signup_submitted',
  'verify_email_opened',    // the magic link was actually opened
  'login_submitted',
  // ── host funnel ──
  'event_create_started',
  'event_created',
  'checkout_started',       // props: { cents }
  'checkout_returned',      // props: { paid: boolean }
  'upgrade_panel_opened',
  'poster_opened',
  'slideshow_started',
  'share_link_created',
  // ── guest funnel ──
  'join_opened',
  'joined',
  'camera_permission_granted',
  'camera_permission_denied',
  'photo_captured',
  'roll_completed',
  'guest_gallery_opened',
  'guest_feedback_opened',
  'guest_feedback_sent',
  'referral_card_click',
  'face_finder_opened',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];
const ALLOWED = new Set<string>(EVENT_NAMES);
export const isEventName = (n: unknown): n is EventName => typeof n === 'string' && ALLOWED.has(n);

// ── the visit hash ────────────────────────────────────────────────────────────
// Rotates daily. The salt is random per process-day unless ANALYTICS_SALT is set, so even we
// cannot recompute yesterday's hashes after a restart — which is the point: the identifier is for
// grouping today's events, not for building a history of anyone.
const SALT_BASE = process.env.ANALYTICS_SALT || crypto.randomBytes(32).toString('hex');
const dayStamp = () => new Date().toISOString().slice(0, 10);
export function visitKey(ip: string | undefined, ua: string | undefined): string | null {
  if (!ip) return null;
  return crypto.createHash('sha256')
    .update(`${SALT_BASE}|${dayStamp()}|${ip}|${(ua || '').slice(0, 200)}`)
    .digest('hex')
    .slice(0, 32);   // 128 bits is ample for grouping and keeps the row small
}

// ── props sanitising ──────────────────────────────────────────────────────────
// A public endpoint must not be able to write anything it likes into a jsonb column. Scalars only,
// short keys, short values, few of them — enough for { tier: '60' }, not enough to smuggle a
// payload or a paragraph of someone's email address.
const MAX_PROPS = 8;
const MAX_KEY = 32;
const MAX_VAL = 120;
export function cleanProps(input: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_PROPS) break;
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(k) || k.length > MAX_KEY) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length) out[k] = v.slice(0, MAX_VAL);
  }
  return out;
}

/** Route PATTERN, not the visited URL: no query string, and ids collapsed to placeholders. */
export function cleanPath(input: unknown): string | null {
  if (typeof input !== 'string' || !input.startsWith('/')) return null;
  return input.split('?')[0].split('#')[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '/:id')      // uuids
    .replace(/\/[A-Z0-9]{8}(?=\/|$)/g, '/:code')            // join codes
    .replace(/\/[0-9a-f]{32}(?=\/|$)/gi, '/:token')         // organizer codes
    .slice(0, 160) || '/';
}

// ── write-behind buffer ───────────────────────────────────────────────────────
type Row = { name: string; path: string | null; visit: string | null; eventId: string | null;
             props: Record<string, string | number | boolean>; createdAt: number };
const FLUSH_MS = Number(process.env.ANALYTICS_FLUSH_MS || 5000);
const MAX_BUFFER = Number(process.env.ANALYTICS_MAX_BUFFER || 5000);
let buffer: Row[] = [];
let dropped = 0;

export function record(row: Row): void {
  if (buffer.length >= MAX_BUFFER) { dropped++; return; }   // shed load rather than balloon
  buffer.push(row);
}

export async function flushAnalytics(): Promise<void> {
  if (!buffer.length) return;
  const batch = buffer;
  buffer = [];                                 // take the batch before awaiting
  if (dropped) { console.warn(`[analytics] dropped ${dropped} event(s) over buffer cap`); dropped = 0; }
  try {
    const values = sql.join(
      batch.map((r) => sql`(${r.name}, ${r.path}, ${r.visit}, ${r.eventId}, ${JSON.stringify(r.props)}::jsonb, ${r.createdAt})`),
      sql`, `,
    );
    await db.execute(sql`
      INSERT INTO site_events (name, path, visit, event_id, props, created_at)
      VALUES ${values}
    `);
  } catch (e) {
    // Never retry: a retry storm on analytics is worse than a gap in analytics.
    console.warn('[analytics] flush failed:', (e as Error).message);
  }
}

let timer: NodeJS.Timeout | null = null;
export function startAnalytics(): void {
  if (timer) return;
  timer = setInterval(() => { void flushAnalytics(); }, FLUSH_MS);
  timer.unref?.();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => { void flushAnalytics(); });
  }
}

/** Retention. Raw rows are only needed while a funnel question is fresh. */
export async function pruneAnalytics(days = Number(process.env.ANALYTICS_RETENTION_DAYS || 90)): Promise<number> {
  const cutoff = Date.now() - days * 86_400_000;
  try {
    const r = await db.execute(sql`DELETE FROM site_events WHERE created_at < ${cutoff}`);
    return (r as unknown as { rowCount?: number }).rowCount || 0;
  } catch { return 0; }
}
