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

/** Addresses are compared and stored lower-cased and trimmed, everywhere, without exception.
 *
 *  The local part of an address is technically case-sensitive, but no mail provider in practice
 *  treats it that way — and the cost of being pedantically correct here is that a suppressed
 *  `Mum@x.com` is re-mailed as `mum@x.com`, which is the precise failure suppression exists to
 *  prevent. Consistency beats correctness on this one. */
export const normaliseAddress = (s: string): string => s.trim().toLowerCase();

/** How the host should read a state, given that some transports never report back.
 *
 *  This is the whole reason `provider` is stored on the row. On Mailgun, 'sent' means "in flight,
 *  ask again in a minute". On plain SMTP there is no webhook and there never will be, so 'sent'
 *  is the final state — and presenting it as if an update were coming would be a lie the host
 *  waits on. Saying "we can't tell" is worth more than implying success. */
export function describe(status: DeliveryStatus, provider: string | null): { label: string; tone: 'good' | 'bad' | 'warn' | 'muted' } {
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
