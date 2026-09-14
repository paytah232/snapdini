// The pricing rules the wizard sells from, pinned against the server's own tier table.
//
// Every one of these fails silently and expensively. A waiver applied one guest too far gives a
// paid feature away; one applied a guest short charges for a gift we advertised. Retention runs
// backwards to the rest and has already been got wrong once. And a struck-through price that a
// screen reader announces as a charge is a false claim about money, not a styling slip.
import { describe, it, expect } from 'vitest';
import type { BillingConfig } from './types';
import {
  featuresFreeAt, framePackPrice, guestBaseCents, durationAddonCents, priceAria, priceTag,
  retentionChoices, retentionIncludedDays, retentionLabel, retentionPrice, shotsAddonCents,
  shotsPrice, videoAddonCents, videoPrice,
} from './featureUpsell';

// A copy of what /api/config serves when Stripe is configured, i.e. app/src/server/billing.ts.
const billing: BillingConfig = {
  billingEnabled: true,
  currency: 'aud',
  freeAllGuests: 10,
  paidTiers: [
    { maxGuests: 25, amountCents: 500 },
    { maxGuests: 60, amountCents: 1500 },
    { maxGuests: 150, amountCents: 2900 },
    { maxGuests: 400, amountCents: 5900 },
  ],
  shotsFree: 12,
  shotsTiers: [
    { maxShots: 12, amountCents: 0 },
    { maxShots: 24, amountCents: 300 },
    { maxShots: 36, amountCents: 500 },
    { maxShots: 48, amountCents: 800 },
  ],
  framePackCents: 500,
  videoAddons: [
    { seconds: 10, amountCents: 200 },
    { seconds: 30, amountCents: 500 },
    { seconds: 60, amountCents: 800 },
    { seconds: 90, amountCents: 1200 },
  ],
  durationFreeHours: 48,
  durationTiers: [
    { maxHours: 48, amountCents: 0 },
    { maxHours: 72, amountCents: 200 },
    { maxHours: 168, amountCents: 500 },
    { maxHours: 336, amountCents: 700 },
    { maxHours: 720, amountCents: 1000 },
    { maxHours: 2160, amountCents: 2500 },
  ],
  retentionFreeDays: 7,
  retentionPaidDays: 31,
  retentionTiers: [
    { maxDays: 7, amountCents: 0 },
    { maxDays: 31, amountCents: 300 },
    { maxDays: 92, amountCents: 800 },
    { maxDays: 182, amountCents: 1200 },
    { maxDays: 365, amountCents: 2000 },
  ],
};

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

describe('who the features are free for', () => {
  it('waives them at the threshold and charges one guest past it', () => {
    expect(featuresFreeAt(billing, 10)).toBe(true);
    expect(featuresFreeAt(billing, 11)).toBe(false);
  });

  it('reads the threshold from config rather than assuming ten', () => {
    expect(featuresFreeAt({ ...billing, freeAllGuests: 25 }, 25)).toBe(true);
  });

  it('falls back to the shipped threshold before the config has loaded', () => {
    expect(featuresFreeAt(null, 10)).toBe(true);
    expect(featuresFreeAt(null, 11)).toBe(false);
  });
});

describe('the event pass', () => {
  it('is free at or under the threshold', () => {
    expect(guestBaseCents(billing, 10)).toBe(0);
  });

  it('charges the smallest tier that still holds the guests', () => {
    expect(guestBaseCents(billing, 11)).toBe(500);
    expect(guestBaseCents(billing, 25)).toBe(500);
    expect(guestBaseCents(billing, 26)).toBe(1500);
    expect(guestBaseCents(billing, 400)).toBe(5900);
  });

  it('does not fall to zero past the largest tier', () => {
    // The server answers tier:'custom' there. A $0 shown while that is being arranged reads as
    // "your 1000-guest event is free".
    expect(guestBaseCents(billing, 1000)).toBe(5900);
  });
});

describe('extra shots', () => {
  it('charges nothing for the included allowance', () => {
    expect(shotsPrice(billing, 12, 60)).toEqual({ kind: 'included' });
  });

  it('gifts the add-on on a small event, at its real price', () => {
    expect(shotsPrice(billing, 24, 10)).toEqual({ kind: 'gift', wouldBeCents: 300 });
    expect(shotsPrice(billing, 48, 10)).toEqual({ kind: 'gift', wouldBeCents: 800 });
  });

  it('charges the same add-on once the event is bigger', () => {
    expect(shotsPrice(billing, 24, 11)).toEqual({ kind: 'paid', cents: 300 });
    expect(shotsPrice(billing, 36, 400)).toEqual({ kind: 'paid', cents: 500 });
  });

  it('prices by the smallest tier that covers the count', () => {
    expect(shotsAddonCents(billing, 13)).toBe(300);
    expect(shotsAddonCents(billing, 25)).toBe(500);
  });
});

describe('video clips', () => {
  it('treats no video as the absence of the feature, not as a gift', () => {
    // Otherwise the "Off" choice wears a struck-through price for a thing nobody is getting.
    expect(videoPrice(billing, 0, 10)).toEqual({ kind: 'included' });
  });

  it('gifts a clip length on a small event and charges it on a big one', () => {
    expect(videoPrice(billing, 30, 10)).toEqual({ kind: 'gift', wouldBeCents: 500 });
    expect(videoPrice(billing, 30, 60)).toEqual({ kind: 'paid', cents: 500 });
  });

  it('matches a clip length exactly rather than rounding up a ladder', () => {
    // The video add-ons are a menu of lengths, not caps: 45s is not "the 60s tier".
    expect(videoAddonCents(billing, 45)).toBe(0);
    expect(videoAddonCents(billing, 90)).toBe(1200);
  });
});

describe('frame shapes', () => {
  it('gifts the pack at or under the threshold and charges it above', () => {
    expect(framePackPrice(billing, 10)).toEqual({ kind: 'gift', wouldBeCents: 500 });
    expect(framePackPrice(billing, 11)).toEqual({ kind: 'paid', cents: 500 });
  });
});

describe('event length', () => {
  it('prices by the smallest window that still fits', () => {
    expect(durationAddonCents(billing, 48)).toBe(0);
    expect(durationAddonCents(billing, 72)).toBe(200);
    expect(durationAddonCents(billing, 336)).toBe(700);
    expect(durationAddonCents(billing, 2160)).toBe(2500);
  });
});

describe('keeping the photos', () => {
  it('runs the opposite way to the other add-ons', () => {
    // A free event gets a week; a paid one has a month included. The guest-count waiver does not
    // reach retention at all.
    expect(retentionIncludedDays(billing, 10)).toBe(7);
    expect(retentionIncludedDays(billing, 11)).toBe(31);
  });

  it('never offers a free event less than it already gets', () => {
    const free = retentionChoices(billing, 10);
    expect(free.map((c) => c.days)).toEqual([7, 31, 92, 182, 365]);
    expect(free[0]).toMatchObject({ days: 7, amountCents: 0, label: '1 week', included: false });
    expect(free[1]).toMatchObject({ days: 31, amountCents: 300, included: false });
  });

  it('drops the lengths a paid event has already paid to beat', () => {
    const paid = retentionChoices(billing, 60);
    expect(paid.map((c) => c.days)).toEqual([31, 92, 182, 365]);
    // The month has a real price and this event is not being charged it — that is "included",
    // which is a different claim from the week being free on a free event.
    expect(paid[0]).toMatchObject({ days: 31, amountCents: 0, included: true });
    expect(paid[1]).toMatchObject({ days: 92, amountCents: 800, included: false });
  });

  it('is never gifted, only charged or already covered', () => {
    expect(retentionPrice({ days: 92, amountCents: 800, label: '3 months', included: false }))
      .toEqual({ kind: 'paid', cents: 800 });
    expect(retentionPrice({ days: 31, amountCents: 0, label: '1 month', included: true }))
      .toEqual({ kind: 'included' });
  });

  it('speaks in months and weeks, not in days', () => {
    expect([7, 31, 92, 182, 365].map(retentionLabel))
      .toEqual(['1 week', '1 month', '3 months', '6 months', '1 year']);
  });
});

describe('the little price beside a choice', () => {
  it('strikes a gift through and states it plainly out loud', () => {
    const gift = { kind: 'gift', wouldBeCents: 500 } as const;
    expect(priceTag(gift, money)).toEqual({ text: '+$5.00', cls: 'was' });
    expect(priceAria(gift, money)).toBe('normally $5.00 — free on your event');
  });

  it('does not dress a real charge as anything else', () => {
    const paid = { kind: 'paid', cents: 300 } as const;
    expect(priceTag(paid, money)).toEqual({ text: '+$3.00', cls: 'add' });
    expect(priceAria(paid, money)).toBe('plus $3.00');
  });

  it('lets the caller say "included" where "free" would be the wrong word', () => {
    expect(priceTag({ kind: 'included' }, money)).toEqual({ text: 'free', cls: 'incl' });
    expect(priceTag({ kind: 'included' }, money, 'included').text).toBe('included');
    expect(priceAria({ kind: 'included' }, money, 'included')).toBe('included');
  });
});
