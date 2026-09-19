// How a guest stops the mail, and how the send path finds out.
//
// Two mechanisms, deliberately both, because they answer to different masters and neither replaces
// the other:
//
//   ONE-CLICK   List-Unsubscribe + List-Unsubscribe-Post (RFC 8058). The mail client POSTs the URL
//               itself; there is no page, no confirmation and no GET handler, because a "are you
//               sure?" step fails the standard outright. This is what Gmail's and Yahoo's
//               bulk-sender rules expect, and its entire value is being cheaper on screen than the
//               "report spam" button sitting next to it — a complaint costs the sending domain far
//               more than one lost guest. Its scope is everything, for that address: a mail client
//               offers no way to express anything narrower, so the press has to mean "stop".
//
//   THE PAGE    linked in the body, for the guest who wants to choose. Two options that mean
//               something to a person who has never heard of us: stop mail about this one event,
//               or never again from Snapdini.
//
// The invariant both share: the unsubscribe is APPLIED BEFORE anything else happens. The page asks
// for feedback afterwards, on a page that already says "you're unsubscribed", and a refusal to
// answer costs nothing. Feedback that gated the opt-out would stop it being low-cost, which is both
// a dark pattern and — for a facility the Spam Act requires to be simple and free — a compliance
// problem.
import crypto from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from './db';
import { emailSuppressions, eventGuests, events, guestInvites, guestUnsubscribes } from './schema';
import { normaliseAddress, shouldApply, type DeliveryStatus } from './delivery';

/** How far an unsubscribe reaches. */
export type UnsubScope = 'event' | 'all';
/** Which mechanism it arrived through. Kept apart because one-click vastly outnumbering the page
 *  would mean the body link is not being found, which is a thing to fix rather than guess about. */
export type UnsubSource = 'one-click' | 'page';

/** The invite tokens minted in routes/guests.ts are uuid v4. Pinned so a junk path segment is
 *  refused before it can reach the database at all. */
export const UNSUB_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUnsubToken = (v: unknown): v is string => typeof v === 'string' && UNSUB_TOKEN_RE.test(v);

export function parseScope(v: unknown): UnsubScope | null {
  return v === 'event' || v === 'all' ? v : null;
}

// ── The optional "why" ───────────────────────────────────────────────────────

/** The reasons a guest might give, in their words rather than ours.
 *
 *  A fixed list plus a free-text box, not free text alone: a list is one tap on a phone, which is
 *  the only reason anyone answers an optional question at all. 'never-signed-up' is on it because
 *  it is the answer we most need to hear — it is a host importing a spreadsheet of addresses that
 *  were never theirs to give us, and it is the one that predicts complaints. */
export const UNSUB_REASONS = [
  { key: 'too-many',        label: 'Too many emails' },
  { key: 'not-interested',  label: "I'm not going to this event" },
  { key: 'never-signed-up', label: "I didn't give anyone my address" },
  { key: 'not-me',          label: "This isn't my email address" },
  { key: 'other',           label: 'Something else' },
] as const;

export type UnsubReason = typeof UNSUB_REASONS[number]['key'];

export const isUnsubReason = (v: unknown): v is UnsubReason =>
  typeof v === 'string' && UNSUB_REASONS.some((r) => r.key === v);

/** How much free text is worth storing. Long enough for a real sentence of complaint, short enough
 *  that the box cannot be used as free storage on an unauthenticated endpoint. */
export const FEEDBACK_MAX = 500;

/**
 * Read a feedback submission. Returns null when there is nothing to record.
 *
 * Both fields are optional and either alone is a valid answer — someone who types a sentence
 * without picking a reason has still told us something, and refusing it because a radio button is
 * unset would discard the only part with any content in it.
 */
export function parseFeedback(body: unknown): { reason: UnsubReason | null; comment: string | null } | null {
  const b = (body ?? {}) as { reason?: unknown; comment?: unknown };
  const reason = isUnsubReason(b.reason) ? b.reason : null;
  const raw = typeof b.comment === 'string' ? b.comment.trim() : '';
  const comment = raw ? raw.slice(0, FEEDBACK_MAX) : null;
  return reason || comment ? { reason, comment } : null;
}

// ── The links that go in the email ───────────────────────────────────────────

const trimBase = (base: string): string => base.replace(/\/$/, '');

/** Where the mail client POSTs. Never a page: see the header comment. */
export const oneClickUrl = (base: string, token: string): string =>
  `${trimBase(base)}/api/guest-unsubscribe/${token}/one-click`;

/** Where the body link goes. A web page, with the choices and the feedback prompt. */
export const unsubscribePageUrl = (base: string, token: string): string =>
  `${trimBase(base)}/unsubscribe/${token}`;

/**
 * The RFC 8058 headers for one message.
 *
 * List-Unsubscribe-Post must be exactly `List-Unsubscribe=One-Click` — that literal string is the
 * protocol, not a description of it, and anything else means the receiving client falls back to
 * treating the URL as a link to open rather than a URL to POST.
 *
 * The URI goes in angle brackets: the header is an RFC 2369 list of `<uri>` entries, and a bare URL
 * is silently ignored by the clients that matter. Only the https URI is offered, no mailto — a
 * mailto alternative is permitted, but a client that picks it would be sending to a mailbox nothing
 * in this deployment reads, which is an unsubscribe facility in name only.
 */
export function unsubscribeHeaders(base: string, token: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${oneClickUrl(base, token)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

// ── What the send path must not mail ─────────────────────────────────────────

/** Why one address is not being mailed, and how far that reaches. */
export interface Block {
  /** 'bounced' | 'complained' | 'unsubscribed' | 'manual' — the same vocabulary as
   *  email_suppressions.reason, so a host-facing UI needs no second mapping. */
  reason: string;
  detail: string | null;
  since: number;
  scope: 'global' | 'event';
}

/**
 * Merge the two sources of "do not mail this person".
 *
 * A GLOBAL suppression always wins over an event-scoped opt-out, even when the event row is newer.
 * The two are not competing opinions: "never mail me again" and "not about this wedding" are both
 * satisfied by not sending, and the global row is the one that carries the real reason — a hard
 * bounce or a spam complaint says something about the address that a preference does not, and
 * showing the host "unsubscribed from this event" for an address that actually bounced would send
 * them off fixing the wrong problem.
 */
export function mergeBlocks(
  global: ReadonlyArray<{ email: string; reason: string; detail: string | null; createdAt: number }>,
  perEvent: ReadonlyArray<{ email: string; createdAt: number }>,
): Map<string, Block> {
  const out = new Map<string, Block>();
  for (const r of perEvent) {
    out.set(normaliseAddress(r.email), {
      reason: 'unsubscribed',
      detail: 'Asked not to be emailed about this event',
      since: r.createdAt,
      scope: 'event',
    });
  }
  for (const s of global) {
    out.set(normaliseAddress(s.email), {
      reason: s.reason, detail: s.detail, since: s.createdAt, scope: 'global',
    });
  }
  return out;
}

/**
 * Split a batch into who may be mailed and who may not.
 *
 * Pure, and separate from the query that builds the map, because this is the rule that must never
 * quietly stop being applied — a send path that forgets it does not throw, it mails someone who
 * asked us not to, and nobody finds out until a complaint arrives. Everything that sends to guests
 * goes through this one function.
 */
export function partitionRecipients<T extends { email: string | null }>(
  guests: readonly T[],
  blocked: ReadonlyMap<string, Block>,
): { mailable: T[]; skipped: Array<{ guest: T; block: Block }> } {
  const mailable: T[] = [];
  const skipped: Array<{ guest: T; block: Block }> = [];
  for (const g of guests) {
    // No address is not a block — it is simply nothing to send to, and the caller counts it
    // separately so "we sent 19 of 20" never goes unexplained.
    if (!g.email) continue;
    const block = blocked.get(normaliseAddress(g.email));
    if (block) skipped.push({ guest: g, block });
    else mailable.push(g);
  }
  return { mailable, skipped };
}

/**
 * Everything that must not be mailed, for one event and one batch of addresses.
 *
 * Two queries over the whole batch rather than a check per address: a per-address check is exactly
 * the kind of thing that gets skipped "just for the resend button", and the domain is quietly
 * un-protected from then on.
 *
 * A read that FAILS throws rather than returning an empty map. An unreadable suppression list is
 * not permission to send — the caller's send is refused and can be retried, which is recoverable;
 * mailing a suppressed address is not.
 */
export async function blocksFor(eventId: string, addresses: readonly string[]): Promise<Map<string, Block>> {
  const list = [...new Set(addresses.map(normaliseAddress).filter(Boolean))];
  if (!list.length) return new Map();
  const [global, perEvent] = await Promise.all([
    db.select().from(emailSuppressions).where(inArray(emailSuppressions.email, list)),
    db.select({ email: guestUnsubscribes.email, createdAt: guestUnsubscribes.createdAt })
      .from(guestUnsubscribes)
      .where(and(eq(guestUnsubscribes.eventId, eventId), inArray(guestUnsubscribes.email, list))),
  ]);
  return mergeBlocks(global, perEvent);
}

// ── The token, and what it points at ─────────────────────────────────────────

/** Who an unsubscribe link belongs to. The address is never taken from the URL — it comes from the
 *  invite row the token identifies, which is the only reason this works without asking anyone to
 *  "confirm your email address" (and the only reason an address never appears in a link). */
export interface UnsubTarget {
  token: string;
  email: string;
  eventId: string;
  eventName: string;
  guestName: string | null;
}

/**
 * Resolve an invite token.
 *
 * Peeked, never consumed. Someone who unsubscribes and then reopens the same link — to check it
 * stuck, or to widen it to everything, or to add the "why" they skipped the first time — must not
 * be told their link is invalid. A one-shot unsubscribe link is a half-working one, and the person
 * holding it has already demonstrated they will use the spam button if we make this hard.
 */
export async function targetFromToken(raw: string): Promise<UnsubTarget | null> {
  if (!isUnsubToken(raw)) return null;
  const [row] = await db
    .select({
      token: guestInvites.token,
      email: guestInvites.email,
      eventId: guestInvites.eventId,
      eventName: events.name,
      guestName: eventGuests.name,
    })
    .from(guestInvites)
    .innerJoin(events, eq(events.id, guestInvites.eventId))
    .leftJoin(eventGuests, eq(eventGuests.id, guestInvites.guestId))
    .where(eq(guestInvites.token, raw));
  return row ? { ...row, email: normaliseAddress(row.email) } : null;
}

// ── Applying it ──────────────────────────────────────────────────────────────

/** The detail recorded against a global suppression that came from a person rather than a bounce.
 *  Distinguishable on sight in the host's list, and — more usefully — distinguishable by the code
 *  below that is allowed to undo one. */
const REQUESTED_DETAIL = 'Unsubscribed from all Snapdini email';

/**
 * Record the opt-out and, for a global one, stop the address everywhere.
 *
 * Order matters. The global suppression is written FIRST, because it is the row every send path
 * actually consults; the guest_unsubscribes row is the provenance. A crash between the two leaves
 * an address stopped with no note of why, which is the harmless direction — the reverse would leave
 * a note saying we honoured a request we did not.
 *
 * Idempotent by construction: both writes are upserts keyed on what the caller already holds, so a
 * mail client that POSTs the one-click URL twice (they do) changes nothing the second time.
 */
export async function applyUnsubscribe(
  target: UnsubTarget,
  scope: UnsubScope,
  source: UnsubSource,
  now: number = Date.now(),
): Promise<void> {
  if (scope === 'all') {
    await db.insert(emailSuppressions)
      .values({ email: target.email, reason: 'unsubscribed', detail: REQUESTED_DETAIL, createdAt: now })
      // First one wins, as everywhere else this table is written: an address that already bounced
      // keeps "550 no such user", which is worth more to the host than the fact that the person
      // behind it also pressed unsubscribe.
      .onConflictDoNothing();
  } else {
    // Narrowing back from 'all' to 'event' — someone reopening their link and changing their mind —
    // removes the global row, but ONLY when we are the ones who put it there. A bounce or a
    // complaint is a fact about the mailbox, not a preference, and must not be erasable by anyone
    // holding an invite token.
    await db.delete(emailSuppressions).where(and(
      eq(emailSuppressions.email, target.email),
      eq(emailSuppressions.reason, 'unsubscribed'),
      eq(emailSuppressions.detail, REQUESTED_DETAIL),
    ));
  }

  await markInviteUnsubscribed(target.token, now);

  await db.insert(guestUnsubscribes)
    .values({
      eventId: target.eventId, email: target.email, scope, source,
      inviteToken: target.token, feedbackReason: null, feedbackComment: null,
      createdAt: now, updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [guestUnsubscribes.eventId, guestUnsubscribes.email],
      // created_at is deliberately absent: it is the record of when they FIRST asked, which is the
      // date that answers "did you honour it promptly". Feedback already given is left alone —
      // changing the scope is not a retraction of what they told us.
      set: { scope, source, inviteToken: target.token, updatedAt: now },
    });
}

/**
 * Mark the message they unsubscribed FROM.
 *
 * Before this existed, 'unsubscribed' was a state nothing could ever reach: it only arrives from
 * Mailgun's own unsubscribe tracking, which is off (o:tracking = no, email.ts) because it rewrites
 * every link in the message through a redirector. So the state machine handled a status that could
 * not occur, and a host looking at their list saw "Delivered" against someone who had asked us to
 * stop — true about the message, and exactly the wrong thing to take away from it.
 *
 * Routed through delivery.shouldApply rather than written straight in, for the one case that
 * matters: an address that has already BOUNCED or COMPLAINED must keep that status. Both outrank an
 * unsubscribe, and both are things the host needs to act on; overwriting a bounce with a preference
 * would hide a dead address behind a polite one.
 *
 * A failure here is logged, not thrown. The opt-out itself has already been recorded by the time
 * this runs, and failing the request over the cosmetic half would invite the person to press
 * unsubscribe again and get an error again.
 */
async function markInviteUnsubscribed(token: string, now: number): Promise<void> {
  try {
    const [row] = await db.select({ id: guestInvites.id, status: guestInvites.status, eventAt: guestInvites.eventAt })
      .from(guestInvites).where(eq(guestInvites.token, token));
    if (!row) return;
    if (!shouldApply(row.status as DeliveryStatus, 'unsubscribed', now, row.eventAt)) return;
    await db.update(guestInvites)
      .set({ status: 'unsubscribed', reason: null, severity: null, eventAt: now, updatedAt: now })
      .where(eq(guestInvites.id, row.id));
  } catch (e) {
    // The token, NOT logged: it is the bearer credential for this invite's unsubscribe, and a
    // log line is the one place a credential is copied, shipped and kept. The fingerprint is
    // enough to tell two failures apart and to match a report against a row.
    console.error(`[unsubscribe] could not mark invite ${tokenFingerprint(token)}: ${(e as Error).message}`);
  }
}

/** Attach the optional "why" to an unsubscribe that has already happened. A no-op when there is no
 *  row, which is the only state this can be called in that is not a bug: the page applies the
 *  unsubscribe on arrival and only then offers the question. */
export async function recordFeedback(
  target: UnsubTarget,
  feedback: { reason: UnsubReason | null; comment: string | null },
  now: number = Date.now(),
): Promise<boolean> {
  const r = await db.update(guestUnsubscribes)
    .set({ feedbackReason: feedback.reason, feedbackComment: feedback.comment, updatedAt: now })
    .where(and(eq(guestUnsubscribes.eventId, target.eventId), eq(guestUnsubscribes.email, target.email)))
    .returning({ email: guestUnsubscribes.email });
  return r.length > 0;
}

/** What the page shows on arrival: whether this address is already stopped, and how far. */
export interface UnsubState { scope: UnsubScope | null; feedbackGiven: boolean }

export async function unsubscribeState(target: UnsubTarget): Promise<UnsubState> {
  const [[row], [suppressed]] = await Promise.all([
    db.select({
      scope: guestUnsubscribes.scope,
      feedbackReason: guestUnsubscribes.feedbackReason,
      feedbackComment: guestUnsubscribes.feedbackComment,
    }).from(guestUnsubscribes)
      .where(and(eq(guestUnsubscribes.eventId, target.eventId), eq(guestUnsubscribes.email, target.email))),
    db.select({ email: emailSuppressions.email }).from(emailSuppressions)
      .where(eq(emailSuppressions.email, target.email)),
  ]);

  // Both, not just our own row. An address can be globally stopped by something that never touched
  // this event — a bounce, or a one-click on a DIFFERENT host's invite — and reporting "event" or
  // "not unsubscribed" on the strength of guest_unsubscribes alone would show someone a page
  // offering to do what has already been done. Worse, the page applies 'event' on arrival when it
  // sees no scope, which would then read as a request to NARROW them back.
  const scope: UnsubScope | null = suppressed ? 'all' : (row ? parseScope(row.scope) : null);
  return { scope, feedbackGiven: !!(row?.feedbackReason || row?.feedbackComment) };
}

/** Enough of an address to recognise, not enough to harvest — the same rule the account preference
 *  centre follows (email-prefs.maskEmail). Holding the link only makes someone the PRESUMED
 *  recipient, so the page names the address without handing it back in full. */
/**
 * A token reduced to something that can safely appear in a log: the first 8 hex of its SHA-256.
 *
 * Not reversible, not enough to replay, and stable — which is the whole job. Two log lines about
 * the same invite match; a fingerprint lifted out of a log grants nothing. Same shape as the short
 * user hash in auth.ts. If you find yourself wanting the raw value here, the answer is a database
 * lookup, not a longer log line.
 */
export function tokenFingerprint(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 8);
}

export function maskAddress(addr: string): string {
  const at = addr.lastIndexOf('@');
  if (at < 1) return '•••';
  // Fixed-width, so the mask does not give away how long the local part is.
  return `${addr.slice(0, 1)}•••••${addr.slice(at)}`;
}

/** Every address that has opted out of this event, for the host's list. One query, used by the
 *  guest-list read that already loads the global suppressions beside it. */
export async function eventUnsubscribes(eventId: string): Promise<Array<{ email: string; createdAt: number }>> {
  return db.select({ email: guestUnsubscribes.email, createdAt: guestUnsubscribes.createdAt })
    .from(guestUnsubscribes)
    .where(eq(guestUnsubscribes.eventId, eventId))
    .limit(5000);
}
