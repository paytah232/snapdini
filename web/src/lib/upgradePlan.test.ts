// What the Upgrade panel's retention control lands on as the host shops for a bigger guest tier.
//
// The config below is written by hand, unlike featureUpsell.test.ts, which parses the server's tier
// table so its PRICES can never go stale. Nothing here asserts a price: these tests are about which
// number is selected and which direction it may move, and that answer is the same whatever the
// allowances happen to be — so the fixture only has to be a free allowance and a longer paid one.
// What a month costs on a free event is asserted where it is decided, in the pricing tests.
import { describe, it, expect } from 'vitest';
import { retentionFloorFor, upgradeRetentionFor } from './upgradePlan';
import type { BillingConfig } from './types';

const FREE = 7, PAID = 31, SMALL = 10;
const billing = {
  billingEnabled: true, currency: 'aud', freeAllGuests: SMALL, paidTiers: [{ maxGuests: 60, amountCents: 1500 }],
  shotsFree: 12, shotsTiers: [], framePackCents: 500, videoAddons: [], durationFreeHours: 24, durationTiers: [],
  retentionFreeDays: FREE, retentionPaidDays: PAID,
  retentionTiers: [{ maxDays: FREE, amountCents: 0 }, { maxDays: PAID, amountCents: 300 }, { maxDays: 365, amountCents: 2000 }],
} as unknown as BillingConfig;

describe('the retention floor on an existing event', () => {
  it('never offers less than the event already has — the server will not downgrade it', () => {
    // A host who bought a year and is now buying more guests must not be shown "1 week": the
    // upgrade route clamps every field up, so that quote could never be the charge.
    expect(retentionFloorFor(billing, 365, SMALL)).toBe(365);
    expect(retentionFloorFor(billing, 365, 60)).toBe(365);
  });

  it('rises to what the tier being bought includes', () => {
    expect(retentionFloorFor(billing, FREE, SMALL)).toBe(FREE);
    expect(retentionFloorFor(billing, FREE, 60)).toBe(PAID);   // a paid tier includes the month
  });
});

// ── Shopping and changing your mind ──────────────────────────────────────────
//
// The guest dropdown only lists tiers at or above the event's own, so this looked unreachable. It
// is not: the SELECTION moves freely within that list. Open the paid tier, look at the price, go
// back — and the old ratchet left the paid tier's month selected on a free event, where a month is
// a chargeable add-on. The panel quoted for it and the upgrade button would have collected it.
describe('retention while the host shops for a bigger guest tier', () => {
  it('goes back down with the tier when the host never picked a length', () => {
    const owned = FREE;
    let days = owned;
    days = upgradeRetentionFor(billing, days, owned, 60, false);     // look at the paid tier
    expect(days).toBe(PAID);                                         // …which includes a month
    days = upgradeRetentionFor(billing, days, owned, SMALL, false);  // change your mind
    expect(days).toBe(FREE);                                         // the bug, in one line
  });

  it('keeps a length the host actually picked', () => {
    expect(upgradeRetentionFor(billing, 365, FREE, SMALL, true)).toBe(365);
    expect(upgradeRetentionFor(billing, 365, FREE, 60, true)).toBe(365);
  });

  it('still lifts a picked length that the tier has overtaken', () => {
    expect(upgradeRetentionFor(billing, FREE, FREE, 60, true)).toBe(PAID);
  });

  it('never drops below what the event has already paid for', () => {
    for (const touched of [true, false]) {
      for (const guests of [SMALL, 60]) {
        expect(upgradeRetentionFor(billing, 365, 365, guests, touched)).toBe(365);
        expect(upgradeRetentionFor(billing, FREE, PAID, guests, touched)).toBeGreaterThanOrEqual(PAID);
      }
    }
  });

  it('is settled: applying it twice changes nothing', () => {
    for (const touched of [true, false]) {
      for (const guests of [SMALL, 60]) {
        for (const current of [FREE, PAID, 365]) {
          const once = upgradeRetentionFor(billing, current, FREE, guests, touched);
          expect(upgradeRetentionFor(billing, once, FREE, guests, touched)).toBe(once);
        }
      }
    }
  });

  it('falls back to the free allowance when the config has not arrived yet', () => {
    // A panel rendered before /api/config answers must not select a length it cannot price.
    expect(upgradeRetentionFor(null, FREE, FREE, 60, false)).toBe(FREE);
  });
});
