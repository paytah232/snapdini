// Guest delivery — the server half of "the guests get the photos, on the host's terms".
//
// Everything a guest is ever sent goes through this file. Three occasions, one gate:
//
//   1. the event ends          → ONE message (guest-emails.ts eventEndEmail)
//   2. the day before release  → "photos open tomorrow", only when the host asked and the gap is real
//   3. the release moment      → the gallery link
//
// ── The gate ─────────────────────────────────────────────────────────────────
//
// participants.wantsPhotos, and nothing else. A guest who did not ask receives nothing, whatever
// the host switched on; the host's three toggles shape the messages a guest already consented to,
// they do not create consent. That is also why no event that existed before 0046 can email anybody:
// every participant row predating the column says false, and there is no backfill.
//
// ── Why there is no fourth timer ─────────────────────────────────────────────
//
// guestSweep() is called from the existing 15-minute lifecycle sweep. Nothing here polls, and the
// reveal instant is quantised onto the same 15-minute grid (shared/reveal.ts), so the moment the
// host was shown is a moment this sweep can actually arrive at.
//
// ── What must never happen ───────────────────────────────────────────────────
//
//   · a link sent before the gallery opens — the guest lands on a locked page and does not return.
//     Clamped on write (routes/events.ts), and checked AGAIN here, because a reveal can move after
//     a send was scheduled.
//   · a link onto an empty page. If the chosen scope has nothing in it we tell the HOST and send
//     the guests nothing.
//   · two messages for one occasion. The event-end message is composed once, conditionally; the
//     other two are one-shot claims on their own columns.
//   · a send decided on data we failed to read. Every read that could say "do not send" is
//     treated as "do not send" when it throws, and retried on the next sweep.
import { and, eq, gt, isNotNull, isNull, lte, gte, or, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { events, participants, photos, shareSends, users, type Event } from './schema';
import * as email from './email';
import { isRevealed, DEMO_NAME } from './lib';
import { scheduledRevealAt } from '../../../shared/reveal';
import { guestReminderInstant } from '../../../shared/guest-reminder';
import { guestSeesPhoto } from './routes/participants';
import { eventEndEmail, releaseReminderEmail, photosLiveEmail } from './guest-emails';
import { emptyScopeEmail } from './inline-emails';
import { maskAddress } from './unsubscribe';

const DAY = 86_400_000;

/** Mirrors lifecycle.ts SWEEP_MS. Used only to keep two guest messages out of the same tick: the
 *  reminder waits a tick when the event-end message has only just gone, so "photos open tomorrow"
 *  never lands in the same breath as the message that already named the date. */
const GUEST_TICK_MS = 15 * 60 * 1000;

/** How far back the sweep looks for an event that has just ended.
 *
 *  Bounds the candidate set, and — the reason it exists — keeps the sweep off every event that was
 *  already over when 0046 landed. Those events have no opted-in guests and could only ever be
 *  stamped, but a query that walks the whole events table once a tick to prove that is a query
 *  that gets slower for the rest of time. */
const GUEST_END_LOOKBACK_MS = 7 * DAY;

const BASE = () => (process.env.BASE_URL || 'https://snapdini.com').replace(/\/$/, '');

// ── The host's choices, parsed ───────────────────────────────────────────────

export const GUEST_DELIVERY_MODES = ['all_on_reveal', 'favourites_manual', 'scheduled', 'manual'] as const;
export type GuestDelivery = typeof GUEST_DELIVERY_MODES[number];

export const GUEST_SEND_SCOPES = ['all', 'favourites'] as const;
export type GuestSendScope = typeof GUEST_SEND_SCOPES[number];

/** Unrecognised is the default, never a crash and never a send: a value left behind by a mode we
 *  retired should behave like a new event, not like a fault. */
export const parseGuestDelivery = (v: unknown): GuestDelivery =>
  (GUEST_DELIVERY_MODES as readonly string[]).includes(v as string) ? (v as GuestDelivery) : 'all_on_reveal';

export const parseGuestSendScope = (v: unknown): GuestSendScope =>
  (GUEST_SEND_SCOPES as readonly string[]).includes(v as string) ? (v as GuestSendScope) : 'all';

/** The event fields the timing rules read. A structural type rather than the whole row, so the
 *  rules can be exercised against a plain object. */
export type GuestTiming = Pick<Event,
  'revealMode' | 'revealedAt' | 'revealHidden' | 'revealAt' | 'revealDelayHours' |
  'startsAt' | 'expiresAt' | 'guestDelivery' | 'guestSendAt' | 'guestSendScope'>;

/** 'favourites_manual' IS a scope as much as a mode — a host who picked it has said which photos
 *  go, and a stale guest_send_scope of 'all' must not quietly widen it. */
export function effectiveGuestScope(ev: Pick<GuestTiming, 'guestDelivery' | 'guestSendScope'>): GuestSendScope {
  return parseGuestDelivery(ev.guestDelivery) === 'favourites_manual'
    ? 'favourites'
    : parseGuestSendScope(ev.guestSendScope);
}

/**
 * The instant the gallery opens to everyone, or null when nobody can name one.
 *
 * Null means "only the host can open this, and they have not" — an explicit "Hide photos", or a
 * manual reveal still waiting. Null is never treated as "now": a message that states a release
 * moment is not built at all rather than built around a guess.
 *
 * An instant-reveal event returns its START, which is in the past for anything the sweep looks at.
 * That is the honest answer — the photos were visible all along — and it is what keeps the release
 * line out of an email where it would be nonsense.
 */
export function revealOpensAt(ev: GuestTiming): number | null {
  if (ev.revealHidden) return null;
  if (ev.revealedAt) return ev.revealedAt;          // the host opened it early, in any mode
  if (ev.revealMode === 'instant') return ev.startsAt;
  return scheduledRevealAt(ev);                      // null for 'manual' until the host acts
}

/**
 * When the sweep sends the gallery link by itself, or null when it never does.
 *
 * The two manual modes return null on purpose: they exist so that nothing goes out until the host
 * presses the button, and a mode that sent anyway would be a mode that lied.
 *
 * 'all_on_reveal' is floored at the end of the event. On an instant-reveal event the gallery has
 * been open since the first shot, and "on reveal" plainly does not mean "while people are still
 * taking photos".
 */
export function guestLinkAt(ev: GuestTiming): number | null {
  const mode = parseGuestDelivery(ev.guestDelivery);
  const opens = revealOpensAt(ev);
  if (mode === 'scheduled') {
    if (ev.guestSendAt == null) return null;
    // The invariant a third time, and this is the one that catches the case the other two cannot:
    // the value was clamped when it was written, and then the host moved the reveal LATER. Nothing
    // rewrites a stored send when that happens, so the floor is applied again on every read.
    return opens === null ? ev.guestSendAt : Math.max(ev.guestSendAt, opens);
  }
  if (mode !== 'all_on_reveal') return null;
  return opens === null ? null : Math.max(opens, ev.expiresAt);
}

/**
 * The reveal is the floor for a scheduled send. ALWAYS.
 *
 * We CLAMP rather than refuse. Refusing would throw away the rest of a settings save over a field
 * the host can only have got wrong by minutes, and "as soon as you possibly can" is what a host who
 * types an earlier time means — there is no other reading of it. The clamped value is returned to
 * the caller so the UI can say what happened instead of silently showing a different time back.
 *
 * `opensAt` null means the reveal instant is unknown (a manual reveal nobody has triggered). There
 * is nothing to clamp to, so the value is kept and the send-time gate — which refuses to email a
 * link while isRevealed() is false — is what holds the line.
 */
export function clampGuestSendAt(requested: number, opensAt: number | null): { at: number; clamped: boolean } {
  if (opensAt !== null && requested < opensAt) return { at: opensAt, clamped: true };
  return { at: requested, clamped: false };
}

/**
 * When "photos open tomorrow" is due, or null when it should never be sent.
 *
 * The rule itself is in shared/guest-reminder.ts, not here, because the host's form asks the same
 * question before the event and has to show the same answer. It used to be written out in both
 * places, and the two copies disagreed by one character — `>` here, `>=` there — which meant a
 * 24-hour reveal delay was offered to the host with a fire time and then never sent. Both halves
 * had a test. Both passed. Neither could see the other.
 */
export function guestReminderAt(ev: GuestTiming): number | null {
  return guestReminderInstant(ev.expiresAt, revealOpensAt(ev));
}

// ── Recipients ───────────────────────────────────────────────────────────────

export interface GuestRecipient { participantId: string; name: string; email: string }

const isEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/**
 * Who may be emailed, from a set of participant rows. Two rules, and both of them are the whole
 * feature rather than plumbing:
 *
 * CONSENT. wantsPhotos false is not a recipient, full stop. It is re-checked here and not left to
 * the SQL alone because this is the rule the product turns on, and a rule that exists only inside a
 * WHERE clause is one a future query can quietly be written without.
 *
 * ONE MESSAGE PER ADDRESS, not per participant. participants already has a UNIQUE index on
 * (event_id, lower(email)), so in a healthy database this changes nothing — which is exactly why it
 * is here. Two people sharing an inbox is the ordinary case this product was built around, the join
 * route has a documented path that drops an address rather than a guest, and a duplicate arriving
 * through any of that must cost the shared inbox one email rather than two. Case-folded, because
 * Mum@ and mum@ are one person.
 */
export function dedupeRecipients(
  rows: Array<{ id: string; name: string | null; email: string | null; wantsPhotos?: boolean }>,
): GuestRecipient[] {
  const seen = new Set<string>();
  const out: GuestRecipient[] = [];
  for (const r of rows) {
    if (r.wantsPhotos === false) continue;
    const addr = (r.email || '').trim();
    if (!addr || addr.length > 200 || !isEmail(addr)) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ participantId: r.id, name: (r.name || '').trim(), email: addr });
  }
  return out;
}

/** First name only, and never derived from the address — "Hi gillian.kieran40" is a leak wearing a
 *  greeting. Same rule as lifecycle.ts. */
const firstName = (name: string): string => (name || '').trim().split(/\s+/)[0] || '';

/**
 * The guests at one event who asked for the photos and left us somewhere to send them.
 *
 * Returns null — NOT an empty list — when the read fails. An empty list means "we looked and nobody
 * asked", which is a fact the caller may act on by marking the event done. A failure means we do
 * not know, and a send decided on what we could not read is the one mistake with no way back.
 */
export async function guestRecipients(eventId: string): Promise<GuestRecipient[] | null> {
  try {
    const rows = await db.select({ id: participants.id, name: participants.name, email: participants.email, wantsPhotos: participants.wantsPhotos })
      .from(participants)
      .where(and(eq(participants.eventId, eventId), eq(participants.wantsPhotos, true), isNotNull(participants.email)))
      // joinedAt DELIBERATELY, not alphabetical: dedupeRecipients is first-wins, so this order
      // decides which participant's NAME represents a shared inbox — and the earliest joiner is the
      // one the shared-inbox design above is written around. `id` only breaks the tie, so the
      // choice is deterministic instead of depending on heap order.
      .orderBy(participants.joinedAt, participants.id);
    return dedupeRecipients(rows);
  } catch (e) {
    console.error(`[guest-delivery] could not read recipients for ${eventId}: ${(e as Error).message}`);
    return null;
  }
}

/**
 * The messages to send when an event ends: EXACTLY ONE per recipient, or none at all.
 *
 * This is the shape of the rule, not a guard on it. A guest who asked for their photos and whose
 * host also has thank-yous switched on cannot receive two emails, because there is one builder, one
 * entry in this array and one send — the second message does not exist to be suppressed. The host's
 * toggle chooses what is IN the message:
 *
 *   thanks on  → the thank-you, the release date if one is known and still ahead, and their photos
 *   thanks off → their photos
 *
 * and the guest's own opt-in chooses whether there is a message at all. That is the whole table.
 */
export function eventEndMessages(
  recipients: GuestRecipient[],
  v: {
    eventName: string; hostName: string; galleryUrl: string; timezone: string | null;
    thanks: boolean; releaseAt: number | null; ownPhotoCount: (participantId: string) => number;
  },
): Array<{ to: string; subject: string; html: string; text: string }> {
  return recipients.map((r) => {
    const mail = eventEndEmail({
      guestName: firstName(r.name), eventName: v.eventName, hostName: v.hostName,
      galleryUrl: v.galleryUrl, timezone: v.timezone,
      thanks: v.thanks, releaseAt: v.releaseAt, ownPhotoCount: v.ownPhotoCount(r.participantId),
    });
    return { to: r.email, subject: mail.subject, html: mail.html, text: mail.text };
  });
}

/**
 * Whether the "photos are live" send is due, and if not, why not.
 *
 *   'never'   — a manual mode. Nothing goes out until the host presses the button; a mode that sent
 *               anyway would be a mode that lied.
 *   'wait'    — the moment has not arrived.
 *   'covered' — the release landed at or before the end of the event, which means the event-end
 *               message ALREADY carried this gallery link to every one of these guests. A second
 *               email saying the same thing is the duplicate the whole design rules out, so the
 *               event is marked done rather than sent again.
 *   'send'    — go.
 */
export function liveSendDue(ev: GuestTiming, now: number): 'never' | 'wait' | 'covered' | 'send' {
  const at = guestLinkAt(ev);
  if (at === null) return 'never';
  if (now < at) return 'wait';
  if (at <= ev.expiresAt) return 'covered';
  return 'send';
}

// ── What the link would actually show ────────────────────────────────────────

/**
 * How many photos the chosen scope resolves to, through the SAME predicate the gallery renders by.
 *
 * routes/participants.ts owns that predicate; counting it a fifth way here is how the number in an
 * email and the page it links to start disagreeing, which a guest reads as photos we lost.
 */
export function scopedVisibleCount(
  rows: Array<{ status: string; isHighlighted: boolean }>,
  scope: GuestSendScope,
  moderationEnabled: boolean,
): number {
  return rows.filter((r) => guestSeesPhoto(r.status, moderationEnabled) && (scope === 'all' || r.isHighlighted)).length;
}

/** Every photo row the visibility rules need, once. Null on a failed read — see guestRecipients. */
async function photoRows(eventId: string): Promise<Array<{ participantId: string; status: string; isHighlighted: boolean }> | null> {
  try {
    return await db.select({ participantId: photos.participantId, status: photos.status, isHighlighted: photos.isHighlighted })
      .from(photos).where(eq(photos.eventId, eventId));
  } catch (e) {
    console.error(`[guest-delivery] could not read photos for ${eventId}: ${(e as Error).message}`);
    return null;
  }
}

// ── Writing down who we emailed ──────────────────────────────────────────────

/**
 * share_sends answers exactly one question — "who has been emailed this event's gallery link?" —
 * for the host's blast, the curated shares (0041) and now the guest send, all in one table with
 * share_id NULL for the standing link.
 *
 * The event-end message and the day-before reminder are deliberately NOT written here, even though
 * the first of them carries the same link. The table is READ to decide whether an address has
 * already had the link, by this function's own callers and by the host's blast in routes/events.ts;
 * a row per guest per thank-you would make every one of those reads answer "yes, already sent" and
 * suppress the very email the thank-you promised. Those two messages are one-shot per EVENT and
 * their record is guest_thanks_sent_at / guest_reminder_sent_at, which says everything a per-address
 * row would have said about whether they went out.
 *
 * Failures are rows too, not omissions: a bounced guest address is precisely what the host needs to
 * see, and a missing row would leave the list quietly claiming everything went out. A failed WRITE
 * here must never fail the send — the mail has already gone.
 *
 * ONE INSERT FOR THE BATCH, so `.onConflictDoNothing()` is not optional. 0052 made the ledger one
 * row per address per link, and this is a multi-row insert inside one statement: a single colliding
 * address raises a unique violation that rolls back the WHOLE statement, and the catch below then
 * swallows it. The mail has gone and nothing 500s — but every OTHER guest in the batch loses their
 * row too, and a missing row reads as "never sent them the link", which is how the ledger ends up
 * authorising the second copy it exists to prevent. Deferring to the index instead keeps the rows
 * that are not in conflict and drops only the address that already has one, which is the truth:
 * somebody else recorded that send first. Same treatment as routes/events.ts's claim.
 *
 * (Callers filter by priorLinkAddresses() first, so a conflict means a genuine race — the host's
 * blast landing mid-sweep, or two app replicas — not an everyday duplicate.)
 */
async function recordSends(eventId: string, sends: Array<{ email: string; ok: boolean }>, now: number): Promise<void> {
  if (!sends.length) return;
  try {
    await db.insert(shareSends).values(sends.map((s) => ({
      id: uuidv4(), eventId, shareId: null, email: s.email, ok: s.ok, sentAt: now,
    }))).onConflictDoNothing();
  } catch (e) {
    console.error(`[guest-delivery] could not record sends for ${eventId}:`, (e as Error).message);
  }
}

/**
 * Every address that has already been emailed THIS event's standing gallery link and had it
 * delivered. Null on a failed read — an unreadable ledger is not permission to send again.
 */
export async function priorLinkAddresses(eventId: string): Promise<Set<string> | null> {
  try {
    const rows = await db.select({ email: shareSends.email }).from(shareSends).where(and(
      eq(shareSends.eventId, eventId), isNull(shareSends.shareId), eq(shareSends.ok, true),
    ));
    return new Set(rows.map((r) => (r.email || '').trim().toLowerCase()));
  } catch (e) {
    console.error(`[guest-delivery] could not read prior sends for ${eventId}: ${(e as Error).message}`);
    return null;
  }
}

// ── The host, for the notices that go to them instead ────────────────────────

async function ownerOf(eventId: string): Promise<{ email: string; name: string } | null> {
  try {
    const [row] = await db.select({ email: users.email, name: users.displayName })
      .from(events).innerJoin(users, eq(users.id, events.ownerUserId)).where(eq(events.id, eventId));
    return row?.email ? { email: row.email, name: firstName(row.name || '') } : null;
  } catch (e) {
    console.error(`[guest-delivery] could not read owner of ${eventId}: ${(e as Error).message}`);
    return null;
  }
}

/**
 * The empty-scope notice.
 *
 * A host who set "send the favourites at reveal" and then starred nothing has not made a mistake we
 * should paper over by sending everything, and they have not made one we should answer with
 * silence either. Their guests get nothing and they get told why, with the page to fix it on.
 */
async function tellHostScopeIsEmpty(ev: Event, scope: GuestSendScope, waiting: number): Promise<void> {
  if (!email.enabled) return;
  const owner = await ownerOf(ev.id);
  if (!owner) return;
  // The copy moved to inline-emails.ts emptyScopeEmail(), which is also what the sampler renders,
  // so there is one definition instead of two that drift. The builder takes the RAW event name and
  // does all three encodings itself — the subject wants it raw, the <h2> escaped, the text part raw
  // again, and mixing those up is the bug that was commented here for years.
  const m = emptyScopeEmail({
    eventName: ev.name,
    scope: scope === 'favourites' ? 'favourites' : 'all',
    moderationEnabled: !!ev.moderationEnabled,
    waiting,
    reviewUrl: `${BASE()}/admin/${ev.joinCode}/review`,
  });
  try {
    await email.sendMail({
      to: owner.email,
      subject: m.subject,
      html: m.html,
      text: m.text,
      replyTo: 'support@snapdini.com',
    });
  } catch (e) {
    console.error(`[guest-delivery] empty-scope notice for ${ev.id} failed: ${(e as Error).message}`);
  }
}

/**
 * Send one guest message and say what actually happened.
 *
 * Three outcomes, because there are three, and they are not interchangeable. sendMail RETURNS
 * `suppressed` instead of throwing when the address has opted out — a deliberate design, so a
 * caller can stamp its guard and record the truth — and every loop here used to discard that and
 * count `sent++` on a message nobody received. The damage was quiet and threefold: the host was
 * shown a delivery that did not happen, share_sends recorded the guest as holding a link they were
 * never sent, and the monthly Mailgun allowance was charged for paper.
 *
 *   'sent'       went out.
 *   'suppressed' was withheld on purpose. Not an error — nothing here should retry it, and the
 *                unclaim-on-total-failure guards below must not read it as the transport being down.
 *   'failed'     is ours, and worth another sweep.
 */
export type GuestSendOutcome = 'sent' | 'suppressed' | 'failed';

/** Exported for the test that pins the three outcomes apart. Everything else in this file should
 *  call it, not sendMail — that is the whole point of it existing. */
export async function sendToGuest(
  /** The built message. An OBJECT rather than four positional strings because it gained a `text`
   *  part — the plain-text alternative every customer-facing email now carries — and
   *  `(to, subject, html, text, eventId, what)` is six strings in a row that a caller can silently
   *  transpose. The builders return this shape already. */
  m: { to: string; subject: string; html: string; text?: string },
  eventId: string, what: string,
  /** The transport, injectable so the three outcomes can be told apart in a test. It defaults to
   *  the real chokepoint and no caller passes it — tsx loads these as ES modules, whose namespace
   *  objects are frozen, so `email.sendMail` cannot be stubbed in place the way it could in CJS. */
  send: typeof email.sendMail = email.sendMail,
): Promise<GuestSendOutcome> {
  const { to, subject, html, text } = m;
  try {
    const r = await send({ to, subject, html, text, replyTo: 'support@snapdini.com', eventId });
    return r.suppressed ? 'suppressed' : 'sent';
  } catch (e) {
    // Masked, with the SAME helper the HTTP responses use (unsubscribe.maskAddress): a guest's
    // address is the one piece of personal data this product holds about someone who never signed
    // up, and logs are retained, shipped and read by more people than a response body is.
    console.error(`[guest-delivery] ${what} to ${maskAddress(to)} failed: ${(e as Error).message}`);
    return 'failed';
  }
}

// ── Sending the gallery link ─────────────────────────────────────────────────

export type GuestSendRefusal = 'not_revealed' | 'empty_scope' | 'no_recipients' | 'already_sent' | 'read_failed' | 'email_disabled';

export interface GuestSendResult {
  sent: number;
  skipped: number;
  errors: number;
  scope: GuestSendScope;
  photoCount: number;
  recipients: number;
  refused?: GuestSendRefusal;
}

export function galleryUrlFor(ev: Pick<Event, 'slug' | 'joinCode'>, base = BASE()): string {
  return `${base}/gallery/${ev.slug || ev.joinCode}`;
}

/**
 * Send the gallery link to the guests who asked for it. Used by the sweep AND by the host's own
 * "send now" button, so the refusals are identical either way — the only difference is who is told
 * about an empty scope, which the caller decides (the host pressing the button is already looking
 * at the answer; the sweep has to email them).
 */
export async function sendGuestLink(
  ev: Event,
  opts: { scope?: GuestSendScope; base?: string; now?: number } = {},
): Promise<GuestSendResult> {
  const now = opts.now ?? Date.now();
  const scope = opts.scope ?? effectiveGuestScope(ev);
  const empty = (refused: GuestSendRefusal, photoCount = 0, recipients = 0): GuestSendResult =>
    ({ sent: 0, skipped: recipients, errors: 0, scope, photoCount, recipients, refused });

  if (!email.enabled) return empty('email_disabled');

  // Recipients FIRST. An event with nobody waiting must not be able to reach the empty-scope notice
  // — that is how a host who never used this feature gets an email about it.
  const recipients = await guestRecipients(ev.id);
  if (recipients === null) return empty('read_failed');
  if (!recipients.length) return empty('no_recipients');

  // One gallery link per address per event, ever. Read, not assumed: the host may already have
  // typed a guest's address into the gallery blast, and an automatic send must not arrive as a
  // second copy of a link they are holding.
  const already = await priorLinkAddresses(ev.id);
  if (already === null) return empty('read_failed', 0, recipients.length);
  const targets = recipients.filter((r) => !already.has(r.email.toLowerCase()));
  if (!targets.length) return empty('already_sent', 0, recipients.length);

  // The invariant, checked at the moment of sending and not only at the moment of scheduling: a
  // reveal can be moved, or hidden, after a send was booked.
  if (!isRevealed(ev)) return empty('not_revealed', 0, recipients.length);

  const rows = await photoRows(ev.id);
  if (rows === null) return empty('read_failed', 0, recipients.length);
  const photoCount = scopedVisibleCount(rows, scope, ev.moderationEnabled);
  if (photoCount === 0) return empty('empty_scope', 0, recipients.length);

  const galleryUrl = galleryUrlFor(ev, opts.base ?? BASE());
  const owner = await ownerOf(ev.id);
  const sends: Array<{ email: string; ok: boolean }> = [];
  let sent = 0, errors = 0;
  for (const r of targets) {
    const mail = photosLiveEmail({
      guestName: firstName(r.name), eventName: ev.name, hostName: owner?.name || '',
      galleryUrl, timezone: ev.timezone, scope, photoCount,
    });
    const out = await sendToGuest({ to: r.email, subject: mail.subject, html: mail.html, text: mail.text }, ev.id, 'link');
    if (out === 'sent') sent++;
    else if (out === 'failed') errors++;
    // ok=false for a suppressed address too, and that is the point: priorLinkAddresses reads this
    // ledger to answer "does this person already hold the link?", and they do not.
    sends.push({ email: r.email, ok: out === 'sent' });
  }
  await recordSends(ev.id, sends, now);
  // `skipped` is everyone we did not mail: the addresses that already had the link, anyone who has
  // unsubscribed, and any whose send failed. The host's UI reports them, so none of the three
  // disappears into a success count.
  return { sent, skipped: recipients.length - sent, errors, scope, photoCount, recipients: recipients.length };
}

// ── The sweep ────────────────────────────────────────────────────────────────

/** Real host, photos still here, not a demo. Shared by all three passes. */
const liveEventScope = (now: number) => [
  isNotNull(events.ownerUserId),
  sql`${events.name} <> ${DEMO_NAME}`,
  isNull(events.purgedAt),
  or(isNull(events.purgeAt), gt(events.purgeAt, now)),
  lte(events.expiresAt, now),
];

type GuestGuard = 'guestThanksSentAt' | 'guestReminderSentAt' | 'guestsSentAt';

const guardColumn = (g: GuestGuard) =>
  g === 'guestThanksSentAt' ? events.guestThanksSentAt
  : g === 'guestReminderSentAt' ? events.guestReminderSentAt
  : events.guestsSentAt;

const guardSet = (g: GuestGuard, v: number | null) =>
  g === 'guestThanksSentAt' ? { guestThanksSentAt: v }
  : g === 'guestReminderSentAt' ? { guestReminderSentAt: v }
  : { guestsSentAt: v };

/** Claim a one-shot guard. Only the caller that flips it from NULL proceeds, so two sweeps — or two
 *  app replicas — cannot both send. Mirrors lifecycle.ts exactly. */
async function claim(eventId: string, guard: GuestGuard, now: number): Promise<boolean> {
  try {
    const claimed = await db.update(events).set(guardSet(guard, now))
      .where(and(eq(events.id, eventId), isNull(guardColumn(guard)))).returning({ id: events.id });
    return claimed.length > 0;
  } catch (e) {
    // A claim we could not write is a claim nobody holds. Not sending is the safe half of that.
    console.error(`[guest-delivery] could not claim ${guard} on ${eventId}: ${(e as Error).message}`);
    return false;
  }
}

/** Give a guard back after a send that got nothing through, so the next sweep retries. */
async function unclaim(eventId: string, guard: GuestGuard): Promise<void> {
  try { await db.update(events).set(guardSet(guard, null)).where(eq(events.id, eventId)); }
  catch { /* the next sweep is the retry either way */ }
}

// 1. The event has ended ──────────────────────────────────────────────────────
async function sweepEventEnd(now: number): Promise<void> {
  const candidates = await db.select().from(events).where(and(
    isNull(events.guestThanksSentAt),
    ...liveEventScope(now),
    gte(events.expiresAt, now - GUEST_END_LOOKBACK_MS),
  ));
  for (const ev of candidates) {
    const recipients = await guestRecipients(ev.id);
    if (recipients === null) continue;                       // unreadable is not consent — retry
    if (!recipients.length) { await claim(ev.id, 'guestThanksSentAt', now); continue; }

    const rows = await photoRows(ev.id);
    if (rows === null) continue;
    // An event where nobody shot anything has nothing to thank anybody for, and a link to an empty
    // page is the thing this feature must never send.
    if (!rows.length) { await claim(ev.id, 'guestThanksSentAt', now); continue; }

    if (!(await claim(ev.id, 'guestThanksSentAt', now))) continue;

    const own = new Map<string, number>();
    for (const r of rows) {
      if (!guestSeesPhoto(r.status, ev.moderationEnabled)) continue;
      own.set(r.participantId, (own.get(r.participantId) ?? 0) + 1);
    }
    const owner = await ownerOf(ev.id);
    // One message per recipient, composed here and sent below. There is no second code path that
    // could also fire — see eventEndMessages.
    const messages = eventEndMessages(recipients, {
      eventName: ev.name, hostName: owner?.name || '', galleryUrl: galleryUrlFor(ev), timezone: ev.timezone,
      thanks: !!ev.guestMailThanks, releaseAt: revealOpensAt(ev),
      ownPhotoCount: (id) => own.get(id) ?? 0,
    });
    let sent = 0, errors = 0;
    for (const m of messages) {
      const out = await sendToGuest(m, ev.id, 'event-end');
      if (out === 'sent') sent++;
      else if (out === 'failed') errors++;
    }
    // Nothing got through at all — the transport is down rather than one address being bad. Give
    // the guard back so the next sweep tries again; the recorded rows keep the failure visible.
    if (sent === 0 && errors > 0) await unclaim(ev.id, 'guestThanksSentAt');
  }
}

// 2. The day before the release ───────────────────────────────────────────────
async function sweepReminder(now: number): Promise<void> {
  const candidates = await db.select().from(events).where(and(
    isNull(events.guestReminderSentAt),
    eq(events.guestMailReminder, true),
    // Ordered behind the event-end message: it names the release date, and a reminder that arrives
    // before it — or in the same tick as it — is the duplicate this whole design exists to avoid.
    isNotNull(events.guestThanksSentAt),
    ...liveEventScope(now),
  ));
  for (const ev of candidates) {
    const at = guestReminderAt(ev);
    const opens = revealOpensAt(ev);
    if (at === null || opens === null) continue;             // no knowable release → nothing to remind about
    if (now < at) continue;                                   // not yet
    if (now >= opens) { await claim(ev.id, 'guestReminderSentAt', now); continue; }  // already open — the moment has passed
    // One tick of daylight after the event-end message, so the two cannot land together even on a
    // sweep that woke late and found both due.
    if (ev.guestThanksSentAt !== null && now - ev.guestThanksSentAt < GUEST_TICK_MS) continue;

    const recipients = await guestRecipients(ev.id);
    if (recipients === null) continue;
    if (!recipients.length) { await claim(ev.id, 'guestReminderSentAt', now); continue; }
    if (!(await claim(ev.id, 'guestReminderSentAt', now))) continue;

    const galleryUrl = galleryUrlFor(ev);
    const owner = await ownerOf(ev.id);
    let sent = 0, errors = 0;
    for (const r of recipients) {
      const mail = releaseReminderEmail({
        guestName: firstName(r.name), eventName: ev.name, hostName: owner?.name || '',
        galleryUrl, timezone: ev.timezone, releaseAt: opens,
      });
      const out = await sendToGuest({ to: r.email, subject: mail.subject, html: mail.html, text: mail.text }, ev.id, 'reminder');
      if (out === 'sent') sent++;
      else if (out === 'failed') errors++;
    }
    if (sent === 0 && errors > 0) await unclaim(ev.id, 'guestReminderSentAt');
  }
}

// 3. The photos are live ──────────────────────────────────────────────────────
async function sweepLive(now: number): Promise<void> {
  const candidates = await db.select().from(events).where(and(
    isNull(events.guestsSentAt),
    eq(events.guestMailLive, true),
    ...liveEventScope(now),
  ));
  for (const ev of candidates) {
    const due = liveSendDue(ev, now);
    if (due === 'never' || due === 'wait') continue;
    if (due === 'covered') { await claim(ev.id, 'guestsSentAt', now); continue; }

    const result = await sendGuestLink(ev, { now });
    if (result.refused === 'read_failed' || result.refused === 'not_revealed' || result.refused === 'email_disabled') continue;
    // Nobody waiting, or everybody already holding the link: either way there is nothing left to
    // do for this event and re-deciding that every fifteen minutes is the only thing left to get
    // wrong.
    if (result.refused === 'no_recipients' || result.refused === 'already_sent') { await claim(ev.id, 'guestsSentAt', now); continue; }
    if (result.refused === 'empty_scope') {
      // Claim first: the notice is about a decision the host has to make, not something to repeat
      // every fifteen minutes until they make it. They send the link themselves afterwards.
      if (await claim(ev.id, 'guestsSentAt', now)) await tellHostScopeIsEmpty(ev, result.scope, result.recipients);
      continue;
    }
    if (result.sent === 0 && result.errors > 0) continue;      // transport down — retry next sweep
    await claim(ev.id, 'guestsSentAt', now);
  }
}

/**
 * Called by the lifecycle sweep. Each pass is independent and each failure is local: one event that
 * cannot be read must not stop the rest of them being sent.
 */
export async function guestSweep(now = Date.now()): Promise<void> {
  if (!email.enabled) return;
  try { await sweepEventEnd(now); } catch (e) { console.error('[guest-delivery] event-end pass:', (e as Error).message); }
  try { await sweepReminder(now); } catch (e) { console.error('[guest-delivery] reminder pass:', (e as Error).message); }
  try { await sweepLive(now); } catch (e) { console.error('[guest-delivery] live pass:', (e as Error).message); }
}

