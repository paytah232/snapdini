// Host reward: a single-use discount issued to a host AFTER their event, valid ~90 days towards
// their next one.
//
// Minted at survey-email time rather than at event creation, so we never create Stripe objects for
// events that get cancelled, rescheduled or never happen. Stripe stays the authority on redemption;
// the columns on `events` exist only so we can display the code and avoid issuing twice.
import { eq } from 'drizzle-orm';
import { db } from './db';
import { events } from './schema';
// Reuse billing's client and currency rather than re-deriving them: a second CURRENCY default here
// silently disagreed with billing.ts (aud vs usd) whenever BILLING_CURRENCY was unset.
import { stripe, CURRENCY } from './billing';

const REWARD_PERCENT = Number(process.env.HOST_REWARD_PERCENT || 20);
const REWARD_DAYS    = Number(process.env.HOST_REWARD_DAYS || 90);

/** Unambiguous code: no O/0/I/1 so it survives being read off a screen or retyped from an email. */
function rewardCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `THANKS${out}`;
}

export interface HostReward { code: string; percentOff: number; expiresAt: number }

/**
 * Issue (or return the existing) reward for an event. Returns null when billing is off, the event
 * was never paid, or Stripe rejects — the caller must treat the reward as optional and never let a
 * failure here block the email it rides along with.
 */
export async function ensureHostReward(eventId: string): Promise<HostReward | null> {
  const [ev] = await db.select({
    id: events.id, amountPaidCents: events.amountPaidCents, refundedAt: events.refundedAt,
    hostRewardCode: events.hostRewardCode, hostRewardExpiresAt: events.hostRewardExpiresAt,
  }).from(events).where(eq(events.id, eventId));
  if (!ev) return null;

  // Already issued and still valid — reuse it rather than minting a second coupon.
  if (ev.hostRewardCode && Number(ev.hostRewardExpiresAt || 0) > Date.now()) {
    return { code: ev.hostRewardCode, percentOff: REWARD_PERCENT, expiresAt: Number(ev.hostRewardExpiresAt) };
  }
  // Only for events that actually took money and were not refunded — nothing to thank otherwise.
  if (!stripe || Number(ev.amountPaidCents || 0) <= 0 || ev.refundedAt) return null;

  const expiresAt = Date.now() + REWARD_DAYS * 24 * 60 * 60 * 1000;
  const code = rewardCode();
  try {
    const coupon = await stripe.coupons.create({
      percent_off: REWARD_PERCENT, duration: 'once', currency: CURRENCY,
      name: `Snapdini host thank-you ${code}`,
      metadata: { snapdini_kind: 'host_reward', snapdini_event_id: ev.id },
    });
    await stripe.promotionCodes.create({
      promotion: { type: 'coupon', coupon: coupon.id },
      code,
      max_redemptions: 1,                                  // single use — it is a thank-you, not a channel
      expires_at: Math.floor(expiresAt / 1000),
      metadata: { snapdini_kind: 'host_reward', snapdini_event_id: ev.id },
    });
  } catch (e) {
    console.warn('[host-reward] Stripe refused:', (e as Error).message);
    return null;
  }

  await db.update(events)
    .set({ hostRewardCode: code, hostRewardExpiresAt: expiresAt })
    .where(eq(events.id, ev.id));
  return { code, percentOff: REWARD_PERCENT, expiresAt };
}
