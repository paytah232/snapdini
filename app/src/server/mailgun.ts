// Mailgun's half of delivery tracking: proving a webhook is really from Mailgun, and translating
// its vocabulary into ours.
//
// Everything provider-specific lives here. delivery.ts holds the policy (which state wins, which
// states suppress an address); this file holds only field names, signatures and enum values — the
// things that are true about Mailgun rather than true about the feature.
//
// Verified against Mailgun's live OpenAPI bundle and the securing-webhooks / webhook-payloads /
// tracking-failures docs, September 2026. Several shapes here are genuinely counter-intuitive and
// are commented where they are, because they are the kind of thing that gets "corrected" back into
// a bug by someone working from memory.
import crypto from 'crypto';
import type { DeliveryStatus } from './delivery';

/** The webhook signing key is NOT the API key.
 *
 *  It is a separate secret (Mailgun calls it the "HTTP webhook signing key"), and using the API key
 *  here fails every verification with no clue as to why — the webhook simply 406s forever and
 *  delivery state silently never updates. Worth the separate variable and the explicit name. */
export const signingKey = (): string => process.env.MAILGUN_WEBHOOK_SIGNING_KEY || '';

/** Can this deployment verify webhooks at all? Without a signing key the endpoint must refuse
 *  everything: an unverified webhook endpoint lets anyone on the internet mark an address as
 *  delivered — or, far worse, as bounced, which suppresses a real guest's address permanently. */
export const webhookConfigured = (): boolean => !!signingKey();

/** How old a signature may be.
 *
 *  Deliberately generous. Mailgun's retry ladder runs 5m, 10m, 15m, 1h, 2h, 4h and spans about
 *  EIGHT HOURS, and the docs explicitly warn against being aggressive here because delays are
 *  outside their control. A tight window (the 5-minute figure that Stripe-shaped code uses) would
 *  reject exactly the retries that exist to recover events we missed — so the replay defence is
 *  the token cache below, and this is only a backstop against an ancient captured request. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Tolerance for our clock running behind Mailgun's. A signature from the future is otherwise a
 *  hard reject, and a few seconds of NTP drift should not cost a delivery event. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface MailgunSignature { timestamp?: unknown; token?: unknown; signature?: unknown }

/** Verify the HMAC on a webhook.
 *
 *  The algorithm, exactly: HMAC-SHA256 over `timestamp + token` CONCATENATED WITH NO SEPARATOR,
 *  keyed with the webhook signing key, compared as a lower-case hex digest.
 *
 *  Three details that are easy to get wrong and impossible to notice:
 *    · The order is timestamp THEN token. Reversed, it fails uniformly and looks like a bad key.
 *    · `timestamp` arrives as a STRING in the JSON and is concatenated as one. Parsing it to a
 *      number first and re-stringifying is a no-op today but breaks the moment the representation
 *      differs at all.
 *    · The signature covers the timestamp and token ONLY — not the body. It proves the request came
 *      from Mailgun; it does NOT prove the event-data was not altered in transit. That is what the
 *      HTTPS requirement is carrying, and it is why nothing in this file treats event-data as
 *      trusted structure: every field is read defensively below.
 *
 *  The comparison is constant-time. A plain === leaks, through timing, how many leading hex
 *  characters of a guess were right, which turns forging a signature from impossible into a few
 *  thousand requests. */
export function verifySignature(
  sig: MailgunSignature,
  key: string = signingKey(),
  now: number = Date.now(),
): { ok: boolean; reason?: string } {
  if (!key) return { ok: false, reason: 'no signing key configured' };

  const timestamp = sig?.timestamp;
  const token = sig?.token;
  const signature = sig?.signature;
  if (typeof timestamp !== 'string' && typeof timestamp !== 'number') return { ok: false, reason: 'missing timestamp' };
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing token' };
  if (typeof signature !== 'string' || !signature) return { ok: false, reason: 'missing signature' };

  const ts = String(timestamp);
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: 'malformed timestamp' };

  // Age check BEFORE the HMAC. A valid old signature is still a replay, and rejecting it early
  // means a flood of captured requests costs no hashing.
  const at = Number(ts) * 1000;
  if (at > now + FUTURE_SKEW_MS) return { ok: false, reason: 'timestamp is in the future' };
  if (now - at > MAX_AGE_MS) return { ok: false, reason: 'timestamp too old' };

  const expected = crypto.createHmac('sha256', key).update(ts + token).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.toLowerCase(), 'utf8');
  // timingSafeEqual throws on a length mismatch, so the length is checked first. A hex SHA-256
  // digest is always 64 characters, so this leaks nothing an attacker did not already know.
  if (a.length !== b.length) return { ok: false, reason: 'bad signature' };
  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'bad signature' };
}

// ── Replay cache ─────────────────────────────────────────────────────────────

/** Tokens we have already processed successfully.
 *
 *  Mailgun's docs suggest caching the token and refusing a repeat, and that is a genuine defence
 *  against a captured request being replayed inside the 24-hour window. But note what it is NOT: a
 *  correctness mechanism. It lives in one process's memory, so it is empty after a restart and
 *  unshared across replicas.
 *
 *  Idempotency proper is handled where it belongs — in the state machine (delivery.shouldApply),
 *  which makes reprocessing the same event a no-op no matter how many times it arrives or which
 *  process it lands on. This cache is an optimisation and a hardening measure on top of that, and
 *  the system is correct without it.
 *
 *  Only SUCCESSFUL requests are remembered. If processing threw and we answered 5xx, Mailgun will
 *  retry with the same token — and that retry is the recovery path, so refusing it would turn a
 *  transient database blip into a permanently lost delivery event. */
const TOKEN_CACHE_MAX = 5000;
const seen = new Set<string>();
export function tokenSeen(token: string): boolean { return seen.has(token); }
export function rememberToken(token: string): void {
  // Bounded, oldest-first. An unbounded Set fed by a public endpoint is a memory-exhaustion vector,
  // and Set preserves insertion order so the oldest key is simply the first one iteration yields.
  if (seen.size >= TOKEN_CACHE_MAX) {
    const oldest = seen.values().next();
    if (!oldest.done) seen.delete(oldest.value);
  }
  seen.add(token);
}
/** Test seam. */
export function _resetTokenCache(): void { seen.clear(); }

// ── Event translation ────────────────────────────────────────────────────────

/** Our custom-variable name. Mailgun carries `v:`-prefixed fields through to the webhook as
 *  `user-variables`, which is how an event finds its way back to the row that sent it. */
export const INVITE_VAR = 'snapdini_invite';
/** Tag on every invite, so invites can be told apart from other Snapdini mail in Mailgun's own UI. */
export const INVITE_TAG = 'guest-invite';

export interface MailgunEvent {
  /** null when the event is one we do not act on (opens, clicks, accepted). */
  status: DeliveryStatus | null;
  /** Our correlation token, when the event carried it. The primary join key. */
  inviteToken: string | null;
  /** Mailgun's message id, already stripped of angle brackets — see below. */
  messageId: string | null;
  recipient: string | null;
  reason: string | null;
  severity: 'permanent' | 'temporary' | null;
  /** Epoch MILLISECONDS, converted from Mailgun's fractional epoch seconds. */
  at: number | null;
  /** The domain the message was SENT from, taken from the message-id's right-hand side.
   *
   *  A Mailgun account can hold several sending domains, and every one of them posts to the SAME
   *  configured webhook URL. So a bounce produced by a test send on a sandbox domain arrives at
   *  whichever deployment owns that URL — production — carrying a real person's address. That is
   *  not hypothetical: it suppressed the operator's own address on 2026-09-19, from a run of the
   *  email sampler against the sandbox domain. See the guard in mailgunWebhookHandler. */
  sendingDomain: string | null;
  /** Mailgun's own event id, for logging. */
  eventId: string | null;
  /** The raw event name, so an unrecognised one can be logged rather than vanishing. */
  name: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  // A trap worth the guard: when a message carried no custom variables, Mailgun serialises
  // `user-variables` as an empty ARRAY, not an empty object. `[]` is typeof 'object', so a naive
  // cast gives you something that answers undefined to every key — which reads as "no token" and
  // quietly sends every such event down the fallback path.
  (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};

/** Translate one `event-data` object into our vocabulary.
 *
 *  The mapping that matters, and the one thing memory gets wrong: you SUBSCRIBE to
 *  `permanent_fail` and `temporary_fail`, but both arrive with `"event": "failed"`. The hard/soft
 *  distinction is carried ONLY by the `severity` field. Branching on the event name — which is
 *  what the subscription names invite you to do — treats every soft deferral as a hard bounce and
 *  permanently suppresses guests whose mail server was merely busy. */
export function normaliseEvent(eventData: unknown): MailgunEvent | null {
  if (!eventData || typeof eventData !== 'object' || Array.isArray(eventData)) return null;
  const e = eventData as Record<string, unknown>;
  const name = str(e.event);
  if (!name) return null;

  const severityRaw = str(e.severity);
  const severity = severityRaw === 'permanent' || severityRaw === 'temporary' ? severityRaw : null;

  let status: DeliveryStatus | null = null;
  switch (name) {
    case 'delivered':    status = 'delivered'; break;
    case 'complained':   status = 'complained'; break;
    case 'unsubscribed': status = 'unsubscribed'; break;
    case 'failed':
      // The whole hard/soft decision, in one line. Anything that is not explicitly 'permanent' is
      // treated as temporary — the safe direction, because a temporary state does not suppress and
      // a later permanent event can still arrive and correct it. Guessing 'permanent' from missing
      // data would strike a live address off the list with no way back.
      status = severity === 'permanent' ? 'bounced' : 'failed';
      break;
    case 'rejected':
      // Mailgun declined to even attempt the send (an account limit, or the address already being
      // on Mailgun's own do-not-send list). Recorded as a failure so the host sees it, but
      // deliberately NOT mapped to 'bounced': it says nothing about whether the mailbox exists,
      // and suppressing on it would let a temporary account problem eat the guest list.
      status = 'failed';
      break;
    // accepted / opened / clicked / stored: nothing to record. Opens and clicks are not subscribed
    // to at all — tracking whether a guest opened an invite is surveillance this product does not
    // do, and 'accepted' only means Mailgun took the message from us, which we already knew.
    default: status = null;
  }

  const vars = obj(e['user-variables']);
  const message = obj(e.message);
  const headers = obj(message.headers);

  // The send API returns the message id WRAPPED IN ANGLE BRACKETS ("<2026...@mg.example.com>");
  // the webhook reports the SAME id with them stripped. Comparing the two as-is never matches, so
  // both sides are normalised to the bare form — here, and where the send result is stored.
  const messageId = stripBrackets(str(headers['message-id']));

  // Fractional epoch SECONDS (e.g. 1770146431.6585283), not milliseconds. Read as-is this lands in
  // January 1970, every event sorts before every other event, and the out-of-order protection in
  // delivery.ts silently stops working.
  const tsRaw = e.timestamp;
  const at = typeof tsRaw === 'number' && isFinite(tsRaw) ? Math.round(tsRaw * 1000) : null;

  const ds = obj(e['delivery-status']);
  // The host-facing explanation, best-first: the receiving server's own words, then Mailgun's
  // description, then the coarse reason code. "550 mailbox unavailable" and "mailbox full" call for
  // completely different actions from the host, and only the first of these carries that.
  const reason = str(ds.message) || str(ds.description) || str(e.reason)
    || str((obj(e.reject)).reason) || null;

  return {
    status,
    inviteToken: str(vars[INVITE_VAR]),
    messageId,
    // Everything after the LAST '@' — a message-id's local part may contain one.
    sendingDomain: messageId && messageId.includes('@')
      ? messageId.slice(messageId.lastIndexOf('@') + 1).toLowerCase() || null
      : null,
    recipient: str(e.recipient),
    reason: reason ? reason.slice(0, 500) : null,
    severity,
    at,
    eventId: str(e.id),
    name,
  };
}

/** `<id@domain>` → `id@domain`. Applied on BOTH sides of the join, so the send result and the
 *  webhook agree on what a message id looks like. */
export function stripBrackets(id: string | null): string | null {
  if (!id) return null;
  return id.replace(/^</, '').replace(/>$/, '') || null;
}
