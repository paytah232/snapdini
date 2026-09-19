// Per-account email preferences, and the no-login link that reaches them.
//
// Two rules shape everything here.
//
// 1. The opt-out is per ACCOUNT, never per event. An opt-out stored against an event would lapse
//    the moment the host ran their next one, so the person who asked us to stop would be asked
//    again — the request honoured in form and ignored in substance.
//
// 2. The link must work without signing in. An unsubscribe that first demands a password is not an
//    unsubscribe facility; most people would simply mark the message as spam instead, which is the
//    outcome the obligation exists to prevent. So the preference centre is reached by a token, the
//    same mechanism the sign-in link already uses (auth.ts / email_tokens) rather than a second
//    scheme of its own.
import { and, eq, notInArray } from 'drizzle-orm';
import { db } from './db';
import { emailPreferences, type User } from './schema';
import { createEmailToken, peekEmailToken } from './auth';

// ── What may be switched off, and what may not ───────────────────────────────
// The split is not a preference of ours: a message that is no more than factual information about
// something the host set up is a designated commercial electronic message (Spam Act Sch 1 cl 3),
// and carries no consent or unsubscribe obligation. These two are the ones that are promotional, or
// arguably so — a feedback request that carries a discount code, and a message whose entire purpose
// is to get someone to start using the product.

export const OPTIONAL_EMAIL_KINDS = [
  {
    key: 'surveyEmail',
    label: 'How did your event go?',
    description: 'One note a few days after an event ends, asking for two minutes of feedback. It sometimes carries a thank-you discount for your next event.',
  },
  {
    key: 'activationNudgeEmail',
    label: 'A nudge if you have not set up an event yet',
    description: 'Sent once, about a week after you sign up, and only if you have not created an event.',
  },
] as const;

export type OptionalEmailKind = typeof OPTIONAL_EMAIL_KINDS[number]['key'];

// What keeps coming regardless, and why. Lives beside the optional list rather than in the page so
// the whole classification can be read in one place — a message quietly moved from one list to the
// other is the mistake worth making impossible to miss.
export const SERVICE_EMAIL_KINDS = [
  { label: 'Signing in',            description: 'Email verification and sign-in links. Without these you cannot get into your account.' },
  { label: 'Your event is live',    description: 'The confirmation when an event is set up, with everything on your roll.' },
  { label: 'Just before the day',   description: 'A short check-in a few days before an event starts, while there is still time to fix anything.' },
  { label: 'Photos and deadlines',  description: 'Retention and expiry notices, so photos never disappear without warning.' },
  { label: 'Co-host invitations',   description: 'When someone asks you to help run their event.' },
] as const;

export const isOptionalKind = (k: unknown): k is OptionalEmailKind =>
  typeof k === 'string' && OPTIONAL_EMAIL_KINDS.some((m) => m.key === k);

/**
 * The opt-outs a save request is asking for.
 *
 * The whole desired set, not a delta: the page shows every optional kind with its current state, so
 * "these are the ones I do not want" is the complete answer and un-ticking one has to mean
 * re-subscribing. Unknown keys are dropped rather than rejected — a retired message kind still
 * sitting in someone's bookmarked page must not fail their save of the kinds that do exist.
 * Returns null only when the payload is not a list at all, which is a malformed request.
 */
export function parseOptOutRequest(body: unknown): OptionalEmailKind[] | null {
  const list = (body as { optOut?: unknown } | null | undefined)?.optOut;
  if (!Array.isArray(list)) return null;
  return [...new Set(list.filter(isOptionalKind))];
}

/**
 * Enough of an address to recognise, not enough to harvest.
 *
 * The preference page has to say which address it is about — someone with two accounts otherwise
 * cannot tell which one they are unsubscribing — but anyone holding the link is only presumed to be
 * the recipient, so the full address is never rendered back.
 */
export function maskEmail(addr: string): string {
  const at = addr.lastIndexOf('@');
  if (at < 1) return '•••';
  const local = addr.slice(0, at);
  // Fixed-width mask, not one dot per character: the length of someone's local part is a small
  // amount of the thing we are trying not to hand back.
  return `${local.slice(0, 1)}•••••${addr.slice(at)}`;
}

// ── The token ────────────────────────────────────────────────────────────────

const PREFS_PURPOSE = 'email_prefs';

// createEmailToken mints 32 random bytes as hex. Pinned here so a junk path segment is refused
// before it ever reaches the database.
export const PREFS_TOKEN_RE = /^[0-9a-f]{64}$/;

// Deliberately far longer than the 30 minutes a sign-in link gets. An unsubscribe link has to work
// when the person actually gets around to it, which is routinely weeks later — the Act requires the
// facility to remain usable for at least 30 days after the message was sent, and a link that
// answers "this has expired" is not a facility at all. Bounded rather than eternal only so the
// sweeper can still reclaim the row (cleanup.ts prunes past expiry).
export const PREFS_TOKEN_TTL_MS = 400 * 24 * 60 * 60 * 1000;

/** A preference-centre link for one account. The token identifies the user; the URL never carries
 *  their address, which would otherwise sit in plain text in logs, referrers and history. */
export async function prefsUrlFor(userId: string, base: string): Promise<string> {
  const raw = await createEmailToken(userId, PREFS_PURPOSE, PREFS_TOKEN_TTL_MS);
  return `${base.replace(/\/$/, '')}/email-preferences/${raw}`;
}

/**
 * The account a preference-centre token belongs to, or null.
 *
 * Peeked, never consumed. Someone who unsubscribes, then reopens the same link to check it stuck —
 * or to put one back — must not be told their link is invalid; a one-shot unsubscribe is a
 * half-working one.
 */
export async function accountFromPrefsToken(raw: string): Promise<User | null> {
  if (!PREFS_TOKEN_RE.test(raw)) return null;
  return peekEmailToken(raw, PREFS_PURPOSE);
}

// ── Reading and writing preferences ──────────────────────────────────────────

/** Every optional kind this account has switched off. Rows for kinds we no longer send are ignored. */
export async function optedOutKinds(userId: string): Promise<OptionalEmailKind[]> {
  const rows = await db.select({ kind: emailPreferences.kind }).from(emailPreferences)
    .where(eq(emailPreferences.userId, userId));
  return rows.map((r) => r.kind).filter(isOptionalKind);
}

/**
 * 'unknown' is not 'send'. A preference table we cannot read is not consent — treating a failed
 * read as permission would send the one message the recipient explicitly asked us not to, and
 * exactly when something is already wrong. The caller retries on the next sweep instead.
 */
export type SendDecision = 'send' | 'opted-out' | 'unknown';

export async function optionalSendDecision(userId: string, kind: OptionalEmailKind): Promise<SendDecision> {
  try {
    const [row] = await db.select({ kind: emailPreferences.kind }).from(emailPreferences)
      .where(and(eq(emailPreferences.userId, userId), eq(emailPreferences.kind, kind)));
    return row ? 'opted-out' : 'send';
  } catch (e) {
    console.error(`[email-prefs] preference read failed for ${userId} / ${kind}: ${(e as Error).message}`);
    return 'unknown';
  }
}

/**
 * Replace an account's whole opt-out set.
 *
 * ONE TRANSACTION, because the two statements are one edit. The insert-then-delete ORDER was
 * chosen so that a reader landing in the gap over-suppresses rather than under-suppresses, and
 * that reasoning is sound as far as it goes — but it only covers a reader. It does not cover a
 * second WRITER: two saves from the same account (two tabs, a double-submitted form, the page
 * re-saved while the first request is still in flight) interleave as
 * insert(A) · insert(B) · delete(not B) · delete(not A), and the last delete removes the opt-out
 * the last save asked for. The host is then shown their saved preferences and mailed anyway, which
 * is the one outcome this table exists to prevent.
 *
 * Statement order is kept inside the transaction all the same: it costs nothing, and it is still
 * the right order for anything reading with a weaker isolation level than the write.
 */
export async function setOptOuts(userId: string, kinds: OptionalEmailKind[]): Promise<void> {
  const wanted = [...new Set(kinds)];
  await db.transaction(async (tx) => {
    if (wanted.length) {
      await tx.insert(emailPreferences)
        .values(wanted.map((kind) => ({ userId, kind, optedOutAt: Date.now() })))
        // Re-saving an unchanged page must not move the date they said no — that date is the record
        // of when the request was made.
        .onConflictDoNothing();
    }
    await tx.delete(emailPreferences).where(and(
      eq(emailPreferences.userId, userId),
      wanted.length ? notInArray(emailPreferences.kind, wanted) : undefined,
    ));
  });
}
