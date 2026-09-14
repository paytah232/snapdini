// The rules the Upgrade panel resizes an EXISTING event by.
//
// Out here rather than inside UpgradePanel.svelte for the reason the create form's retention bug
// survived as long as it did: a rule that lives only in a component is a rule no test can reach.
// The panel keeps the dropdowns; the arithmetic that decides which number is selected lives here.
import { retentionFor, retentionIncludedDays } from './featureUpsell';
import type { BillingConfig } from './types';

/** The shortest retention this event may be offered: what it already has, or what the guest tier
 *  the host is looking at includes — whichever is longer.
 *
 *  Two floors, for two different reasons, and both are real:
 *
 *   · the event's own days, because /api/billing/upgrade clamps every field UP and will not
 *     downgrade. Offering "1 week" to an event that already keeps a year quotes a reduction the
 *     server refuses, so the host would be shown one price and charged against another.
 *   · the tier's allowance, because a paid tier includes a month. Leaving the host asking for the
 *     week they have just paid to beat is the fault the create form's ratchet existed to fix.
 */
export function retentionFloorFor(
  billing: BillingConfig | null,
  ownedDays: number,
  guests: number,
): number {
  return Math.max(ownedDays, retentionIncludedDays(billing, guests));
}

/** What the panel's "Keep photos" control should read once the guest tier being bought has moved.
 *
 *  The panel used to hold `if (uRet < floor) uRet = floor` — the same one-way ratchet the create
 *  form carried, with the same hole. The guest dropdown here only offers tiers at or above the
 *  event's current one, which is why this looked impossible; but the SELECTION moves freely inside
 *  that list, so a host on a free event who opens the paid tier to see what it costs and then goes
 *  back is exactly the reported path. Stepping up pushed retention to the month the paid tier
 *  includes, stepping back down left the month standing, and a month on a free event is a $3
 *  add-on. The panel then quoted, and the server would have charged, for an upgrade nobody picked.
 *
 *  So the tier's number is the tier's to take back (see retentionFor): untouched, it follows the
 *  allowance both ways; touched, the host's own choice stands and is only ever raised.
 */
export function upgradeRetentionFor(
  billing: BillingConfig | null,
  current: number,
  ownedDays: number,
  guests: number,
  touched: boolean,
): number {
  return retentionFor(current, retentionFloorFor(billing, ownedDays, guests), touched);
}
