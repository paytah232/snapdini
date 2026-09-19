// How much of the month's email allowance we have spent.
//
// Mailgun's free plan is 3000 messages per calendar month, and running out is a SILENT failure:
// sends start being refused, invites stop arriving, and nothing on any screen in this product says
// why. A host would only find out at the party. So this counts what we have sent and puts the
// number in front of an operator before the wall, not after it.
//
// It DERIVES the count from what is already recorded rather than adding a ledger of its own.
// guest_invites is one row per invite email and share_sends is one row per gallery/share email, so
// between them they already hold the recipient-level record of every bulk send this product makes.
// A counter table would be a second source of truth to keep in step with those two, for a number
// nobody bills us on.
//
// What that does NOT cover, stated plainly because a budget number nobody trusts is worse than no
// number: account mail (sign-in and verification links, the event-live confirmation, check-ins,
// retention notices, the survey) is not recorded per recipient anywhere, and neither is the
// guests' event-end message or release reminder — those are one-shot-per-EVENT guards, so the
// number of people they reached is not recoverable from them. The figure here is therefore a FLOOR
// on the real total. The default warning threshold leaves room for that tail, and the digest line
// says so rather than implying an exact count.
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db } from './db';
import { events, guestInvites, shareSends } from './schema';

/** The plan's monthly allowance. Env-configurable because a paid plan changes it, and a hardcoded
 *  3000 would then be a number that quietly lies about how much room there is. */
export const monthlyLimit = (): number => {
  const n = Number(process.env.MAILGUN_MONTHLY_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3000;
};

/** Where "getting close" starts, as a percentage of the allowance. Defaults to 80 rather than
 *  something tighter like 95: the count is a floor (see above), and a warning that arrives with
 *  5% of the month's headroom left is a warning that arrives too late to move a plan. */
export const warnPercent = (): number => {
  const n = Number(process.env.MAILGUN_BUDGET_WARN_PCT);
  return Number.isFinite(n) && n > 0 && n < 100 ? n : 80;
};

/** The calendar month `now` falls in, as a half-open [from, to) range of epoch milliseconds. */
export interface MonthWindow { from: number; to: number; label: string }

/**
 * The month boundary, in UTC.
 *
 * Deliberately not OPS_TZ, which the rest of ops-notify uses for "what day is it here". The
 * allowance is Mailgun's, reset on Mailgun's clock, and counting a Brisbane month would put our
 * number and their number in disagreement by up to ten hours at each boundary — which is precisely
 * when the number matters and precisely when a disagreement is hardest to explain.
 *
 * Half-open on purpose: a send at 23:59:59.999 on the last day belongs to that month, and one at
 * 00:00:00.000 on the 1st belongs to the next. An inclusive upper bound would count a midnight send
 * in both, and the overlap would only ever show up as a budget that reads high by a message or two.
 */
export function monthWindow(now: number): MonthWindow {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return {
    from: Date.UTC(y, m, 1),
    // Month 12 rolls the year over on its own — Date.UTC normalises it, so December needs no
    // special case and there is no branch here to get wrong.
    to: Date.UTC(y, m + 1, 1),
    label: `${y}-${String(m + 1).padStart(2, '0')}`,
  };
}

export interface MonthUsage {
  month: string;
  /** Invite emails recorded in guest_invites this month. */
  invites: number;
  /** Gallery-link and share emails recorded in share_sends this month. */
  shares: number;
  total: number;
  limit: number;
  remaining: number;
  /** 0–100+, rounded. Past 100 when the allowance has already been spent. */
  percent: number;
  level: BudgetLevel;
}

export type BudgetLevel = 'ok' | 'warn' | 'over';

/**
 * Pure: where a usage figure sits against the allowance.
 *
 * 'over' is reported, never enforced. Refusing to send at the limit would turn a billing problem
 * into a host's guests not being invited to their own wedding — a far worse outcome than an
 * overage, and one we would be choosing on their behalf.
 */
export function budgetLevel(used: number, limit: number, warnAt: number = warnPercent()): BudgetLevel {
  if (limit <= 0) return 'ok';
  if (used >= limit) return 'over';
  return (used / limit) * 100 >= warnAt ? 'warn' : 'ok';
}

/** Count one table's rows inside the window. Two counts rather than a UNION: they answer different
 *  questions for the operator ("the invites feature is busy" vs "hosts are blasting galleries"),
 *  and a single total hides which one moved. */
async function countBetween(w: MonthWindow): Promise<{ invites: number; shares: number }> {
  const [[inv], [sh]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(guestInvites)
      // `mailed` excludes the rows a demo event writes: it records the send so the visitor sees the
      // feature work, and hands nothing to a transport (0056, and the DEMO note in routes/guests.ts).
      // Those spend none of Mailgun's allowance, and demo rolls are the MAJORITY of events on a live
      // instance — counting them would make this figure useless in exactly the direction that hurts,
      // by crying wolf until the operator stops reading it.
      .where(and(eq(guestInvites.mailed, true), gte(guestInvites.sentAt, w.from), lt(guestInvites.sentAt, w.to))),
    db.select({ n: sql<number>`count(*)::int` }).from(shareSends)
      .where(and(gte(shareSends.sentAt, w.from), lt(shareSends.sentAt, w.to))),
  ]);
  return { invites: Number(inv?.n ?? 0), shares: Number(sh?.n ?? 0) };
}

/**
 * Month-to-date usage.
 *
 * Failed sends are counted too. A send the transport refused never reached Mailgun and does not
 * strictly spend the allowance, but excluding them means reading two more columns to guess which
 * failures were pre-flight and which were soft bounces of messages that WERE accepted — and
 * getting that wrong undercounts. Counting them errs toward warning early, which is the only
 * direction that is safe when the alternative is a host's invites silently not going out.
 *
 * So are WITHHELD ones — a row for someone who had unsubscribed, which the chokepoint stopped
 * before it reached a transport at all (share_sends.ok false, guest_invites.status 'unsubscribed').
 * Those definitely spent nothing, and they are still counted, for the same reason: ok=false carries
 * both "we tried and it failed" and "we deliberately did not try", and splitting them here to shave
 * a few off a number nobody bills us on would trade a safe over-count for a guess. It does mean the
 * total is no longer a pure floor — it is a floor on real sends plus a small tail of sends that
 * never happened — which only ever makes the warning arrive sooner.
 */
export async function monthUsage(now: number = Date.now()): Promise<MonthUsage> {
  const w = monthWindow(now);
  const { invites, shares } = await countBetween(w);
  const total = invites + shares;
  const limit = monthlyLimit();
  return {
    month: w.label,
    invites, shares, total, limit,
    remaining: Math.max(0, limit - total),
    percent: limit > 0 ? Math.round((total / limit) * 100) : 0,
    level: budgetLevel(total, limit),
  };
}

// ── Sending caps ─────────────────────────────────────────────────────────────
//
// The counts above are a REPORT. These two are ENFORCED, and they live here — beside the report —
// because they are the same question asked of the same rows: how much mail has this product put in
// other people's inboxes? A second module counting guest_invites its own way is a second answer to
// drift away from this one.
//
// They are the third and fourth lines of defence on POST /:joinCode/guests/invite, behind the
// identity gate and the demo exemption in routes/guests.ts. Neither is a product feature and no
// screen mentions either: they are the bound on what a host whose account or organizer code has
// been taken can do with our sending reputation before anyone notices.
//
// NOT env-tunable, deliberately, unlike monthlyLimit() above. That one is a fact about somebody's
// Mailgun plan and changes when they change plan. These are "past here it is not a party any more",
// which is a judgement this product makes and should make the same way everywhere.

/** How many times over a host may mail their whole list, ever.
 *
 *  THREE PASSES, because three is what a real host actually does: send the invitations, re-send to
 *  the people who did not open the first one, and mail the late additions. A fourth pass is already
 *  unusual; a tenth is not a wedding.
 *
 *  Measured against the list's CURRENT size, so it grows as the host adds people — a host who
 *  invites 40, then adds 60 more and invites again, is nowhere near it. */
export const INVITE_PASSES = 3;

/** …and the floor under that, so a small list is not governed by a tiny number.
 *
 *  3 x 4 guests = 12 would be a cap a real host with a tiny dinner party could hit by fiddling.
 *  100 cannot be reached by anyone using the feature as a feature, and still bounds the worst case
 *  on a small list to a hundred messages — two orders of magnitude below what a spam run needs to
 *  be worth doing. */
export const INVITE_FLOOR = 100;

/** The lifetime invite ceiling for ONE event. */
export const eventInviteCap = (guestCount: number): number =>
  Math.max(INVITE_FLOOR, guestCount * INVITE_PASSES);

/** Recipients one ACCOUNT may mail in a rolling 24 hours, across every event it owns.
 *
 *  The per-event cap is escapable by making more events, and making events is free. This is the
 *  backstop for that, and it is the number that actually bounds the damage.
 *
 *  2000 because of what it has to sit between. Above it: the biggest real day this product can
 *  have is a 2000-guest list (MAX_GUESTS_PER_EVENT) invited once, and even that host would have to
 *  ALSO re-send to everybody on the same day to reach here — while a host that size has been in
 *  touch with us long before their event. Below it: 2000 is already two thirds of Mailgun's entire
 *  free monthly allowance (3000) in a single day, so anything past it is a number an operator
 *  needs to have agreed to rather than discovered.
 *
 *  A ROLLING 24 hours rather than a calendar day, because a calendar day hands an attacker two full
 *  budgets either side of midnight and gives a legitimate host nothing in return. */
export const ACCOUNT_DAILY_RECIPIENTS = 2000;
export const ACCOUNT_DAY_MS = 24 * 60 * 60 * 1000;

/** How many invite recipients this event has ever had.
 *
 *  Derived from guest_invites rather than kept in a counter column, for the reason at the top of
 *  this file: that table is already one row per recipient per press, so a counter would be a second
 *  source of truth to keep in step with it. It is PERSISTED — those rows are the persistence — and
 *  it survives restarts, deploys and every path that has ever sent an invite.
 *
 *  Demo rows are counted. They cost no mail, but they are still presses of the button, and a cap
 *  whose job is "this is not what the feature is for any more" should not have a hole in it that is
 *  reachable by anyone with an organizer code. */
export async function eventInvitesEver(eventId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(guestInvites)
    .where(eq(guestInvites.eventId, eventId));
  return Number(r?.n ?? 0);
}

/** Recipients this account has mailed in the last 24 hours, across all of its events.
 *
 *  BOTH bulk paths, because both take a list of addresses from the host and both send from our
 *  domain: guest invites (guest_invites) and gallery/share links (share_sends). Capping one and not
 *  the other would just move the abuse to the other one.
 *
 *  `mailed` again: a demo has no owner, so demo rows cannot reach this query anyway — the filter is
 *  here so the two counts stay the same question, and so it keeps holding if a non-sending path is
 *  ever added to an owned event. */
export async function accountRecipientsInDay(ownerUserId: string, now: number = Date.now()): Promise<number> {
  const from = now - ACCOUNT_DAY_MS;
  const [[inv], [sh]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(guestInvites)
      .innerJoin(events, eq(events.id, guestInvites.eventId))
      .where(and(eq(events.ownerUserId, ownerUserId), eq(guestInvites.mailed, true), gte(guestInvites.sentAt, from))),
    db.select({ n: sql<number>`count(*)::int` }).from(shareSends)
      .innerJoin(events, eq(events.id, shareSends.eventId))
      .where(and(eq(events.ownerUserId, ownerUserId), gte(shareSends.sentAt, from))),
  ]);
  return Number(inv?.n ?? 0) + Number(sh?.n ?? 0);
}

/** One line of plain words for an operator. Pure, so what the digest says can be tested without a
 *  mail server or a database. */
export function describeUsage(u: MonthUsage): string {
  const head = `${u.total} of ${u.limit} recorded sends this month (${u.percent}%)`;
  if (u.level === 'over') return `${head} — the monthly allowance is spent. Sends are NOT being blocked, so anything past this is billable or will start failing.`;
  if (u.level === 'warn') return `${head} — ${u.remaining} left. Worth checking the plan before the end of the month.`;
  return `${head} — ${u.remaining} left.`;
}
