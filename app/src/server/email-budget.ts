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
import { and, gte, lt, sql } from 'drizzle-orm';
import { db } from './db';
import { guestInvites, shareSends } from './schema';

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
      .where(and(gte(guestInvites.sentAt, w.from), lt(guestInvites.sentAt, w.to))),
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

/** One line of plain words for an operator. Pure, so what the digest says can be tested without a
 *  mail server or a database. */
export function describeUsage(u: MonthUsage): string {
  const head = `${u.total} of ${u.limit} recorded sends this month (${u.percent}%)`;
  if (u.level === 'over') return `${head} — the monthly allowance is spent. Sends are NOT being blocked, so anything past this is billable or will start failing.`;
  if (u.level === 'warn') return `${head} — ${u.remaining} left. Worth checking the plan before the end of the month.`;
  return `${head} — ${u.remaining} left.`;
}
