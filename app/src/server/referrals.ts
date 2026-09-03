// Guest referral funnel.
//
// Guests are the only warm audience this product has — they have just used it at someone else's
// event and watched it work. That is the opposite of the paid-ads traffic, which produced signups
// and no usage at all.
//
// Attribution is a cookie, not a query param carried through the flow: a guest may land from a
// gallery today and create their own event weeks later. It is stamped at BOTH signup and event
// creation, because either can happen first.
import type { Request, Response } from 'express';
import { eq, or } from 'drizzle-orm';
import { db } from './db';
import { events, shares } from './schema';
import { bumpReferralClick } from './counters';

export const REF_COOKIE = 'snapdini_ref';
const REF_TTL_MS = 60 * 24 * 60 * 60 * 1000;   // 60 days — long enough to cover "after the wedding"

/**
 * Record a referral click and set the attribution cookie.
 *
 * `ref` is either a source event's **join code**, or `s:<share token or slug>` for links shown on a
 * shared link page. The share form exists so `/s/<token>` never has to expose the event's join code:
 * a share is deliberately a view-only surface, and the join code is what lets someone join and shoot.
 */
export async function captureReferral(req: Request, res: Response, ref: string): Promise<boolean> {
  const raw = String(ref || '').trim().slice(0, 80);
  if (!raw) return false;

  let src: { id: string } | undefined;
  if (/^s:/i.test(raw)) {
    const tok = raw.slice(2);
    if (!tok) return false;
    [src] = await db.select({ id: shares.eventId }).from(shares)
      .where(or(eq(shares.id, tok), eq(shares.slug, tok)));
  } else {
    const code = raw.toUpperCase().slice(0, 40);
    [src] = await db.select({ id: events.id }).from(events).where(eq(events.joinCode, code));
  }
  if (!src) return false;   // unknown code — ignore rather than store junk

  // Write-behind: a referral click is a guest-facing hot path, so it is coalesced like every other
  // engagement counter rather than taking a row lock inline. See counters.ts.
  bumpReferralClick(src.id);

  res.cookie(REF_COOKIE, src.id, {
    maxAge: REF_TTL_MS,
    httpOnly: true,          // only the server ever needs it
    sameSite: 'lax',         // must survive the cross-site hop from an emailed link
    secure: (process.env.BASE_URL || '').startsWith('https://'),
    path: '/',
  });
  return true;
}

/** The referring event id, if the visitor carries a valid attribution cookie. */
export async function referrerFromCookie(req: Request): Promise<string | null> {
  const id = (req.cookies || {})[REF_COOKIE];
  if (!id || typeof id !== 'string') return null;
  const [src] = await db.select({ id: events.id }).from(events).where(eq(events.id, id));
  return src ? src.id : null;   // ignore a stale cookie pointing at a deleted event
}

/** Never let a host "refer" themselves — their own next event is not a referral. */
export function isSelfReferral(sourceOwnerId: string | null, newOwnerId: string | null): boolean {
  return !!sourceOwnerId && !!newOwnerId && sourceOwnerId === newOwnerId;
}
