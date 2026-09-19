// What an invite's delivery state is, and how it is allowed to change.
//
// Kept separate from the Mailgun code on purpose. This file is the POLICY — which state wins, and
// which states cost an address its place on the mailing list. mailgun.ts is the TRANSPORT — one
// provider's signatures and field names. Policy is the part that must be right regardless of who
// is carrying the mail, and the part worth testing exhaustively.
//
// The hard problem this solves is that webhooks arrive OUT OF ORDER and MORE THAN ONCE. Mailgun
// retries for hours, so the same 'delivered' can land three times, and a 'failed' generated before
// a 'delivered' can arrive after it. Applying whatever turned up last is therefore wrong, and it
// is wrong in the direction that matters: a host would see "delivered" on an address that
// permanently bounced, keep mailing it, and take the sending domain down with them.

/** Every state one invite can be in. */
export type DeliveryStatus =
  | 'sent'          // handed to the transport; nothing heard since
  | 'failed'        // a temporary failure, or an immediate transport error. NOT final.
  | 'delivered'     // the receiving server accepted it
  | 'unsubscribed'  // the recipient opted out
  | 'bounced'       // permanent failure — the address is dead
  | 'complained';   // reported as spam

/** How strongly a state should hold against another arriving.
 *
 *  Ordering rationale, from the bottom:
 *    sent(0)         we know nothing
 *    failed(1)       a temporary setback; Mailgun is still retrying, so this must NOT displace a
 *                    delivery that already happened
 *    delivered(2)    a fact about the past
 *    unsubscribed(3) a decision by the recipient — it outranks delivery because the mail DID
 *                    arrive and the answer was "stop"
 *    bounced(4)      permanent, and actionable
 *    complained(5)   the most expensive thing a recipient can do to a sending domain, and the one
 *                    a host most needs to see. Nothing displaces it.
 *
 *  Note what this ordering deliberately permits: delivered → complained and delivered → bounced.
 *  Both are real sequences (a message is accepted by the server and then rejected by the person,
 *  or accepted and then bounced back later by a forwarding rule), and both must be able to
 *  overwrite a delivery. */
const RANK: Record<DeliveryStatus, number> = {
  sent: 0, failed: 1, delivered: 2, unsubscribed: 3, bounced: 4, complained: 5,
};

export const rankOf = (s: DeliveryStatus): number => RANK[s] ?? 0;

/** Decide whether an arriving event should replace the state already recorded.
 *
 *  `at` / `currentAt` are the PROVIDER's timestamps, not ours — ours only record when we happened
 *  to receive something, which for an out-of-order redelivery is meaningless.
 *
 *  Two rules, in order:
 *    1. A higher-ranked state always wins, whenever it happened. A bounce is a bounce even if it
 *       is reported after a delivery.
 *    2. At EQUAL rank, only a strictly newer event wins. This is what makes redelivery idempotent:
 *       the same 'delivered' arriving three times changes nothing after the first, so the reason
 *       and timestamp shown to the host stay stable instead of flickering. */
export function shouldApply(
  current: DeliveryStatus,
  incoming: DeliveryStatus,
  at: number | null,
  currentAt: number | null,
): boolean {
  const a = rankOf(incoming), b = rankOf(current);
  if (a > b) return true;
  if (a < b) return false;
  if (at == null || currentAt == null) return false;   // can't order them; keep what we have
  return at > currentAt;
}

/** Whether reaching this state means the address must never be mailed from here again.
 *
 *  Three states, and the reasoning for each is different:
 *    bounced      — the mailbox does not exist. Every further send is a guaranteed bounce, and a
 *                   high bounce rate is exactly what mailbox providers use to decide a sender is
 *                   a spammer.
 *    complained   — a human pressed "this is spam". Mailing them again is both rude and the single
 *                   most damaging signal a domain can accumulate.
 *    unsubscribed — they asked to stop. Continuing is a legal problem as well as a reputational one.
 *
 *  'failed' is pointedly NOT here: it is the TEMPORARY bucket (a full mailbox, a greylisting, a
 *  server down for an hour). Suppressing on it would permanently blacklist people whose mail server
 *  was merely busy, and the host would never know why their guests stopped getting invited. */
export function suppresses(status: DeliveryStatus): boolean {
  return status === 'bounced' || status === 'complained' || status === 'unsubscribed';
}

/** The suppression-table reason for a status, or null when it does not suppress. */
export function suppressionReason(status: DeliveryStatus): 'bounced' | 'complained' | 'unsubscribed' | null {
  return suppresses(status) ? (status as 'bounced' | 'complained' | 'unsubscribed') : null;
}

/** THE canonical form of an address. Both sides of every suppression check run through here — the
 *  rows are written normalised (routes/guests.ts for the add form, csv.ts for the importer) and
 *  the lookup key is built the same way (unsubscribe.ts blocksFor) — so whatever this function
 *  collapses, a suppression covers, and whatever it leaves alone escapes one.
 *
 *  ONE definition, and "one" is load bearing. csv.ts spelled the rule as `rawEmail.toLowerCase()`
 *  and agreed with this on everything but the trailing dot, which was enough to put
 *  `mum@example.com.` and `mum@example.com` on one guest list as two rows for one person — past
 *  both dedupe checks, and past the unique index too, because the index keys on
 *  lower(btrim(email)) and therefore sees exactly the bytes a writer chose to store. A second
 *  spelling of this function is a second answer to "who is this", and the database cannot arbitrate
 *  between them: it can only compare what it was given.
 *
 *  WHY THE TRAILING-DOT STRIP STAYED, rather than being dropped to match the index literally. The
 *  index is a rule about what may coexist in one event, and it holds whatever this collapses,
 *  because every writer normalises FIRST: the stored string is already in canonical form, so
 *  lower(btrim(stored)) IS stored and the index key and the app's identity are the same value.
 *  Dropping the strip would also make the two sides agree — and would un-suppress a real bounce,
 *  since `x.com.` and `x.com` are one domain to every MTA and `isEmail` accepts both, so a host who
 *  typed the dot would mail an address we have a permanent failure on record for. Of the two ways
 *  to agree, only one of them also keeps the suppression list working.
 *
 *  Three things are collapsed, and the list is deliberately short:
 *
 *    trim         — a pasted address carries whitespace, and " a@x.com" is not a second person.
 *    lower-case   — the local part is technically case-sensitive, but no provider in practice
 *                   treats it that way, and the cost of being pedantically correct is that a
 *                   suppressed `Mum@x.com` is re-mailed as `mum@x.com`, which is the precise
 *                   failure suppression exists to prevent.
 *    trailing dot — `x.com.` is the fully-qualified spelling of `x.com`: the final dot is the DNS
 *                   root label, not part of the name. Every resolver and every MTA treats the two
 *                   as one domain, and `isEmail` accepts both (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
 *                   matches `a@x.com.`), so without this a host who typed the trailing dot mails
 *                   an address we have a bounce on record for. This is the only one of the three
 *                   that is a fact about DNS rather than a judgement about providers.
 *
 *  What is deliberately NOT collapsed, because over-normalising suppresses a DIFFERENT real person
 *  and does it silently:
 *
 *    `+tag` subaddressing — `a+shop@x.com` → `a@x.com` is a Gmail/Fastmail/Outlook convention, not
 *      a rule. RFC 5321 says the local part is opaque to everyone but the delivering host, and
 *      plenty of hosts (cPanel mailboxes, Exchange without plus-addressing, anything with a literal
 *      `+` in the account name) deliver `a+shop@` to a mailbox that has nothing to do with `a@`.
 *      Strip it and one person's spam complaint silently blocks a colleague's invitation.
 *    Gmail dot-insensitivity — `j.smith@` → `jsmith@`. Same objection, worse odds: dots are
 *      ordinary local-part characters at most providers and `j.smith` and `jsmith` are routinely
 *      two different employees.
 *    Provider tables generally — getting this right per provider means shipping and maintaining a
 *      list of MX patterns, and a wrong entry fails closed: mail that is never sent, to someone who
 *      never asked us to stop, with nothing anywhere saying why. An under-normalised address that
 *      slips a suppression is a visible, fixable mistake; an over-normalised one is not. */
export const normaliseAddress = (s: string): string => s.trim().toLowerCase().replace(/\.+$/, '');

// ── Quarantine: the delivery that is not really a delivery ───────────────────
//
// Mailgun reports a message Gmail QUARANTINED as `delivered`, with a 2xx code, and the only trace
// of what happened is a phrase inside `delivery-status.message`:
//
//     2.0.0 OK DMARC:Quarantine
//
// Confirmed on a real send from this deployment. The receiving server did accept the message — so
// `delivered` is not a lie, exactly — and then applied its DMARC policy and filed it where nobody
// will look. Reading only the status, delivery tracking puts a green tick beside mail that landed
// in spam, which is worse than no tracking at all: the host stops looking for the problem.
//
// Nothing extra has to be RECORDED to fix this. The webhook already stores the receiving server's
// own words in `guest_invites.reason` (routes/guests.ts writes `reason: ev.reason`, and mailgun.ts
// normaliseEvent reads `delivery-status.message` first, ahead of Mailgun's own description,
// precisely because the server's words are the useful ones). The signal was being stored and
// thrown away at the point of display. So this is a classifier over a string we already have, not
// a new column — which is also why it needs no migration and no change to the webhook.
//
// Deliberately narrow. It matches the DMARC quarantine phrase and nothing else: "spam" appears in
// plenty of benign 2xx greetings, and a false positive here tells a host their mail is being
// filtered when it is not, which sends them off tuning DNS for no reason.
const QUARANTINE_RE = /\bdmarc\s*[:=]?\s*quarantine\b/i;

/** Did the receiving server accept this and then quarantine it?
 *
 *  Only ever true of a `delivered`. On any other status the state already tells the host what
 *  happened, and a bounce or a complaint is not improved by also mentioning DMARC. */
export function quarantined(status: DeliveryStatus, reason: string | null | undefined): boolean {
  return status === 'delivered' && !!reason && QUARANTINE_RE.test(reason);
}

/** What to tell the host about it. One sentence: what happened, and where the message went.
 *
 *  Not diagnostic advice — that belongs in docs/DELIVERY-TRACKING.md, which the operator reads and
 *  the host does not. The host needs to know the guest probably has not seen it. */
export const QUARANTINE_NOTE =
  'The receiving server accepted this and then quarantined it — it most likely landed in spam, '
  + 'so treat it as not yet seen.';

/** How the host should read a state, given that some transports never report back.
 *
 *  This is the whole reason `provider` is stored on the row. On Mailgun, 'sent' means "in flight,
 *  ask again in a minute". On plain SMTP there is no webhook and there never will be, so 'sent'
 *  is the final state — and presenting it as if an update were coming would be a lie the host
 *  waits on. Saying "we can't tell" is worth more than implying success. */
export function describe(
  status: DeliveryStatus,
  provider: string | null,
  /** The receiving server's own words, when there were any. Read for one thing only: a `delivered`
   *  that says DMARC:Quarantine is not a green tick. */
  reason: string | null = null,
): { label: string; tone: 'good' | 'bad' | 'warn' | 'muted' } {
  if (quarantined(status, reason)) return { label: 'Delivered to spam', tone: 'warn' };
  switch (status) {
    case 'delivered':    return { label: 'Delivered', tone: 'good' };
    case 'bounced':      return { label: 'Bounced', tone: 'bad' };
    case 'complained':   return { label: 'Marked as spam', tone: 'bad' };
    case 'unsubscribed': return { label: 'Unsubscribed', tone: 'warn' };
    case 'failed':       return { label: 'Failed — retrying', tone: 'warn' };
    case 'sent':
    default:
      return provider === 'mailgun'
        ? { label: 'Sent — awaiting delivery', tone: 'muted' }
        : { label: 'Sent — delivery unknown', tone: 'muted' };
  }
}
