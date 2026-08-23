import { and, eq, isNull, isNotNull, lte, gte, ne, or, sql } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { db } from './db';
import { events, users } from './schema';
import * as email from './email';
import { welcomeEmail, checkinEmail, surveyEmail, accountWelcomeEmail, activationNudgeEmail, type LifecycleView } from './lifecycle-emails';

// Customer lifecycle emails, run in-process on a timer (same shape as the retention sweep). Welcome
// fires immediately from the Stripe webhook; check-in and survey are found by the sweep. Every send
// is gated by an ATOMIC CLAIM — `UPDATE … WHERE <col> IS NULL RETURNING id` — so even with multiple
// app replicas a given email can only ever be claimed once (and is un-claimed if the send throws, so
// it retries next tick). No global lock needed. Controlled by LIFECYCLE_EMAILS=1 (off by default).

const SWEEP_MS = 15 * 60 * 1000;               // 15-minute tick
const DAY = 86_400_000;
const CHECKIN_WINDOW_MS = 6 * DAY;             // start sending check-ins from ~6 days out
const CHECKIN_CUTOFF_MS = 12 * 60 * 60 * 1000; // …but not inside the last 12h before the event
const CHECKIN_MIN_LEAD_MS = 3 * DAY;           // only if booked ≥3 days before the event (else the welcome covered it)
const MIN_SINCE_CREATE_MS = 36 * 60 * 60 * 1000; // never email within 36h of the booking (no barrage)
const SURVEY_DELAY_MS = 3 * DAY;               // survey goes 3 days after the event ends

const enabled = () => process.env.LIFECYCLE_EMAILS === '1';
const BASE = () => (process.env.BASE_URL || 'https://snapdini.com').replace(/\/$/, '');
const excludeList = () => (process.env.ANALYTICS_EXCLUDE_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// First name for greetings. Deliberately does NOT fall back to the email prefix — a missing name
// yields '' so emails say "Hi there" rather than leaking something like "Hi gillian.kieran40".
const firstName = (name?: string | null, _emailAddr?: string | null) =>
  (name || '').trim().split(/\s+/)[0] || '';

const newToken = () => randomBytes(24).toString('base64url');

// Format the event window in the event's own timezone: "Sat 24 Oct 2026" or "Sat 24 – Mon 26 Oct 2026".
function datesLabel(startMs: number, endMs: number, tz?: string | null): string {
  const z = tz || 'Australia/Brisbane';
  const f = (ms: number, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-AU', { timeZone: z, ...opts }).format(new Date(ms));
  const wd = (ms: number) => f(ms, { weekday: 'short' });
  const day = (ms: number) => f(ms, { day: 'numeric' });
  const my = (ms: number) => f(ms, { month: 'short', year: 'numeric' });
  const sameDay = f(startMs, { year: 'numeric', month: 'short', day: 'numeric' }) === f(endMs, { year: 'numeric', month: 'short', day: 'numeric' });
  return sameDay ? `${wd(startMs)} ${day(startMs)} ${my(startMs)}`
                 : `${wd(startMs)} ${day(startMs)} – ${wd(endMs)} ${day(endMs)} ${my(endMs)}`;
}

type EventRow = typeof events.$inferSelect;

function buildView(ev: EventRow, ownerName: string, extra?: { surveyUrl?: string; startsSoon?: boolean }): LifecycleView {
  let framesAll = false;
  try { framesAll = (JSON.parse(ev.aspectRatios || '["1:1"]') as string[]).some((a) => a && a !== '1:1'); } catch { /* */ }
  return {
    ownerName,
    eventName: ev.name,
    guestCap: ev.guestCap,
    shotsPerGuest: ev.maxPhotos,
    framesAll,
    hasVideo: ev.videoSeconds > 0,
    videoSeconds: ev.videoSeconds,
    revealMode: ev.revealMode as LifecycleView['revealMode'],
    retentionDays: ev.retentionDays,
    datesLabel: datesLabel(ev.startsAt, ev.expiresAt, ev.timezone),
    manageUrl: `${BASE()}/dashboard`,
    unsubUrl: `mailto:support@snapdini.com?subject=${encodeURIComponent('Unsubscribe ' + ev.joinCode)}`,
    ...extra,
  };
}

// Load the event + its owner, returning null unless the owner is a real, non-internal customer.
async function eventWithOwner(eventId: string): Promise<{ ev: EventRow; ownerName: string; ownerEmail: string } | null> {
  const [row] = await db.select({ ev: events, email: users.email, name: users.displayName, isAdmin: users.isAdmin })
    .from(events).innerJoin(users, eq(users.id, events.ownerUserId)).where(eq(events.id, eventId));
  if (!row || !row.email) return null;
  if (row.isAdmin || excludeList().includes(row.email.toLowerCase())) return null;
  return { ev: row.ev, ownerName: firstName(row.name, row.email), ownerEmail: row.email };
}

// ── Welcome (called from the Stripe webhook on first payment) ─────────────────
export async function sendWelcome(eventId: string): Promise<void> {
  if (!enabled() || !email.enabled) return;
  const info = await eventWithOwner(eventId);
  if (!info) return;
  // Atomic claim: only the first caller to flip welcome_sent_at from NULL proceeds.
  const claimed = await db.update(events).set({ welcomeSentAt: Date.now() })
    .where(and(eq(events.id, eventId), isNull(events.welcomeSentAt))).returning({ id: events.id });
  if (!claimed.length) return;
  const startsSoon = info.ev.startsAt - Date.now() < CHECKIN_MIN_LEAD_MS;
  const mail = welcomeEmail(buildView(info.ev, info.ownerName, { startsSoon }));
  try {
    await email.sendMail({ to: info.ownerEmail, subject: mail.subject, html: mail.html, replyTo: 'support@snapdini.com' });
  } catch (e) {
    await db.update(events).set({ welcomeSentAt: null }).where(eq(events.id, eventId)); // un-claim → retry not applicable, but don't lie
    console.error(`[lifecycle] welcome ${eventId} failed: ${(e as Error).message}`);
  }
}

// ── The sweep: account welcome + activation nudge + check-in + survey ─────────
async function sweep(): Promise<void> {
  if (!enabled() || !email.enabled) return;
  const now = Date.now();
  const excl = excludeList();

  // ACCOUNT WELCOME — recently-verified accounts (covers email/magic/Google signups uniformly).
  const welcomeCandidates = await db.select({ id: users.id, email: users.email, name: users.displayName }).from(users).where(and(
    isNull(users.accountWelcomeSentAt),
    eq(users.isAdmin, false),
    isNotNull(users.emailVerifiedAt),
    gte(users.createdAt, now - 2 * DAY),   // recent only; backfill marks pre-existing accounts
  ));
  for (const u of welcomeCandidates) {
    if (!u.email || excl.includes(u.email.toLowerCase())) { await db.update(users).set({ accountWelcomeSentAt: now }).where(eq(users.id, u.id)); continue; }
    const claimed = await db.update(users).set({ accountWelcomeSentAt: now })
      .where(and(eq(users.id, u.id), isNull(users.accountWelcomeSentAt))).returning({ id: users.id });
    if (!claimed.length) continue;
    const mail = accountWelcomeEmail({ ownerName: firstName(u.name, u.email), createUrl: `${BASE()}/app`,
      unsubUrl: `mailto:support@snapdini.com?subject=${encodeURIComponent('Unsubscribe')}` });
    try { await email.sendMail({ to: u.email, subject: mail.subject, html: mail.html, replyTo: 'support@snapdini.com' }); }
    catch (e) { await db.update(users).set({ accountWelcomeSentAt: null }).where(eq(users.id, u.id)); console.error(`[lifecycle] account welcome ${u.id} failed: ${(e as Error).message}`); }
  }

  // ACTIVATION NUDGE — verified accounts that signed up 7–30 days ago, still have no event.
  const nudgeCandidates = await db.select({ id: users.id, email: users.email, name: users.displayName }).from(users).where(and(
    isNull(users.activationNudgeSentAt),
    eq(users.isAdmin, false),
    isNotNull(users.emailVerifiedAt),
    lte(users.createdAt, now - 7 * DAY),
    gte(users.createdAt, now - 30 * DAY),
    sql`NOT EXISTS (SELECT 1 FROM events WHERE events.owner_user_id = ${users.id})`,
  ));
  for (const u of nudgeCandidates) {
    if (!u.email || excl.includes(u.email.toLowerCase())) { await db.update(users).set({ activationNudgeSentAt: now }).where(eq(users.id, u.id)); continue; }
    const claimed = await db.update(users).set({ activationNudgeSentAt: now })
      .where(and(eq(users.id, u.id), isNull(users.activationNudgeSentAt))).returning({ id: users.id });
    if (!claimed.length) continue;
    const mail = activationNudgeEmail({ ownerName: firstName(u.name, u.email), createUrl: `${BASE()}/app`,
      unsubUrl: `mailto:support@snapdini.com?subject=${encodeURIComponent('Unsubscribe')}` });
    try { await email.sendMail({ to: u.email, subject: mail.subject, html: mail.html, replyTo: 'support@snapdini.com' }); }
    catch (e) { await db.update(users).set({ activationNudgeSentAt: null }).where(eq(users.id, u.id)); console.error(`[lifecycle] nudge ${u.id} failed: ${(e as Error).message}`); }
  }

  // CHECK-IN — real-owner events, in the [start-6d, start-12h] window, booked with ≥3d lead and
  // created ≥36h ago, not already sent.
  const checkinCandidates = await db.select().from(events).where(and(
    isNotNull(events.ownerUserId),
    isNull(events.checkinSentAt),
    gte(events.startsAt, now + CHECKIN_CUTOFF_MS),
    lte(events.startsAt, now + CHECKIN_WINDOW_MS),
    lte(events.createdAt, now - MIN_SINCE_CREATE_MS),
    sql`${events.startsAt} - ${events.createdAt} >= ${CHECKIN_MIN_LEAD_MS}`,
  ));
  for (const ev of checkinCandidates) {
    const info = await eventWithOwner(ev.id);
    if (!info) { await db.update(events).set({ checkinSentAt: now }).where(eq(events.id, ev.id)); continue; } // internal/demo → mark to skip forever
    const claimed = await db.update(events).set({ checkinSentAt: now })
      .where(and(eq(events.id, ev.id), isNull(events.checkinSentAt))).returning({ id: events.id });
    if (!claimed.length) continue;
    const mail = checkinEmail(buildView(info.ev, info.ownerName));
    try { await email.sendMail({ to: info.ownerEmail, subject: mail.subject, html: mail.html, replyTo: 'support@snapdini.com' }); }
    catch (e) { await db.update(events).set({ checkinSentAt: null }).where(eq(events.id, ev.id)); console.error(`[lifecycle] checkin ${ev.id} failed: ${(e as Error).message}`); }
  }

  // SURVEY — 3 days after the event ended, not already sent.
  const surveyCandidates = await db.select().from(events).where(and(
    isNotNull(events.ownerUserId),
    isNull(events.feedbackSentAt),
    lte(events.expiresAt, now - SURVEY_DELAY_MS),
  ));
  for (const ev of surveyCandidates) {
    const info = await eventWithOwner(ev.id);
    if (!info) { await db.update(events).set({ feedbackSentAt: now }).where(eq(events.id, ev.id)); continue; }
    const claimed = await db.update(events).set({ feedbackSentAt: now })
      .where(and(eq(events.id, ev.id), isNull(events.feedbackSentAt))).returning({ id: events.id });
    if (!claimed.length) continue;
    // Mint a survey token if the event doesn't have one yet.
    let token = info.ev.surveyToken;
    if (!token) { token = newToken(); await db.update(events).set({ surveyToken: token }).where(eq(events.id, ev.id)); }
    const mail = surveyEmail(buildView(info.ev, info.ownerName, { surveyUrl: `${BASE()}/survey/${token}` }));
    try { await email.sendMail({ to: info.ownerEmail, subject: mail.subject, html: mail.html, replyTo: 'support@snapdini.com' }); }
    catch (e) { await db.update(events).set({ feedbackSentAt: null }).where(eq(events.id, ev.id)); console.error(`[lifecycle] survey ${ev.id} failed: ${(e as Error).message}`); }
  }
}

export function startLifecycle(): void {
  if (!enabled()) { console.log('[lifecycle] disabled (set LIFECYCLE_EMAILS=1 to enable)'); return; }
  if (!email.enabled) { console.warn('[lifecycle] no email transport configured — sweep will no-op'); }
  sweep().catch((e) => console.error('[lifecycle] sweep error:', (e as Error).message));
  const timer = setInterval(() => sweep().catch((e) => console.error('[lifecycle] sweep error:', (e as Error).message)), SWEEP_MS);
  timer.unref?.();
  console.log('[lifecycle] customer lifecycle emails ENABLED (15-min sweep)');
}
