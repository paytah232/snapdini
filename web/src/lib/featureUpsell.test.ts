// The pricing rules the wizard sells from, read at test time from the server's own tier table.
//
// app/src/server/billing.ts is parsed below for the very constants publicBillingConfig() hands to
// /api/config, and every expectation in this file is built from those. The previous version claimed
// exactly that in its first line and admitted in its fifteenth that the table was "a copy" — a
// hand-typed fixture that stayed green with stale numbers whatever billing.ts said, which is the one
// failure a pricing test exists to prevent. Parsing the source is not elegant; importing it is not
// available (billing.ts pulls in Stripe, which is the server's dependency and not the web app's),
// and a fixture that cannot go stale is worth more than a tidy import.
//
// Every one of these fails silently and expensively. A waiver applied one guest too far gives a paid
// feature away; one applied a guest short charges for a gift we advertised. Retention runs backwards
// to the rest and has already been got wrong once. And a struck-through price that a screen reader
// announces as a charge is a false claim about money, not a styling slip.
import { describe, it, expect } from 'vitest';
import type { BillingConfig } from './types';
// The server's pricing module, as TEXT. Vite's ?raw import is what makes that possible from the web
// package, which has no @types/node and so cannot reach node:fs at all; it also means the path is
// resolved at build time, so a billing.ts that moved fails the suite instead of silently reading
// nothing. Importing it for real is not an option — billing.ts pulls in Stripe, the server's
// dependency and not the web app's.
import BILLING_SRC from '../../../app/src/server/billing.ts?raw';
import {
  featuresFreeAt, framePackPrice, guestBaseCents, durationAddonCents, priceAria, priceTag,
  retentionChoices, retentionIncludedDays, retentionLabel, retentionPrice, shotsAddonCents,
  shotsPrice, videoAddonCents, videoPrice, retentionFor } from './featureUpsell';

/** One `export const NAME = <literal>;` out of billing.ts, evaluated. Scalars and array literals
 *  only — everything publicBillingConfig() serves is one or the other. */
function serverConst<T>(name: string): T {
  const head = `export const ${name} = `;
  const at = BILLING_SRC.indexOf(head);
  if (at < 0) throw new Error(`billing.ts no longer exports ${name} — the wizard is pricing from nothing`);
  let depth = 0, i = at + head.length, out = '';
  for (; i < BILLING_SRC.length; i++) {
    const c = BILLING_SRC[i];
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) break;
    out += c;
  }
  const literal = out.replace(/\/\/[^\n]*/g, '').replace(/\bas const\b/, '').trim();
  return Function(`"use strict"; return (${literal});`)() as T;
}

/** The field → constant mapping publicBillingConfig() itself uses, so the fixture is assembled the
 *  same way /api/config assembles its answer rather than by a second list kept in step by hand. */
function publicMapping(): Record<string, string> {
  const at = BILLING_SRC.indexOf('export function publicBillingConfig()');
  if (at < 0) throw new Error('billing.ts no longer has publicBillingConfig()');
  const body = BILLING_SRC.slice(at, BILLING_SRC.indexOf('\n}', at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s+(\w+): ([A-Z][A-Z0-9_]*),$/gm)) out[m[1]] = m[2];
  return out;
}

const MAPPING = publicMapping();
// billingEnabled and currency are runtime values rather than tier constants (a Stripe key and an
// env var); the wizard is being tested with billing switched on, in the currency the tiers are
// written in.
const billing: BillingConfig = {
  billingEnabled: true,
  currency: 'aud',
  ...Object.fromEntries(Object.entries(MAPPING).map(([field, konst]) => [field, serverConst(konst)])),
} as BillingConfig;

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const paid = billing.paidTiers;
const shots = billing.shotsTiers;
const durations = billing.durationTiers;
const retentions = billing.retentionTiers;
const SMALL = billing.freeAllGuests;       // an event small enough for the feature waiver
const BIG = SMALL + 1;                     // one guest past it

describe('the table these rules are tested against', () => {
  it('is the server’s, read through the same constants /api/config serves', () => {
    // The guard on every expectation below. If billing.ts stops exporting one of these, or
    // publicBillingConfig() stops serving it, the numbers under test are no longer the server's and
    // nothing else in this file means anything.
    for (const field of ['freeAllGuests', 'paidTiers', 'shotsFree', 'shotsTiers', 'framePackCents',
      'videoAddons', 'durationFreeHours', 'durationTiers', 'retentionFreeDays', 'retentionPaidDays',
      'retentionTiers'] as const) {
      expect(MAPPING[field], `/api/config no longer serves ${field} from a billing.ts constant`).toBeTruthy();
      expect(billing[field], `${field} came back empty`).toBeDefined();
    }
    for (const ladder of [paid, shots, durations, retentions, billing.videoAddons]) {
      expect(ladder.length).toBeGreaterThan(1);
    }
  });

  it('is a ladder that climbs, cap and price together', () => {
    // Every "smallest tier that still fits" rule below assumes this. A table that went backwards
    // would make those rules pass while pricing the wrong thing.
    const climbs = (caps: number[]) => caps.every((v, i) => i === 0 || v > caps[i - 1]);
    expect(climbs(paid.map((t) => t.maxGuests)) && climbs(paid.map((t) => t.amountCents))).toBe(true);
    expect(climbs(shots.map((t) => t.maxShots)) && climbs(shots.map((t) => t.amountCents))).toBe(true);
    expect(climbs(durations.map((t) => t.maxHours)) && climbs(durations.map((t) => t.amountCents))).toBe(true);
    expect(climbs(retentions.map((t) => t.maxDays)) && climbs(retentions.map((t) => t.amountCents))).toBe(true);
  });

  // Climbing is not enough. The shots ladder used to climb while SAGGING in the middle: the blocks
  // cost $3, then $2, then $3, so a dozen shots were cheapest in the middle of the range and there
  // was no reason anyone could state for it. Shots are the one thing with a genuine per-unit cost to
  // us — each is a file stored, thumbnailed and served for the whole retention window — so the price
  // of the next dozen must never be lower than the price of the last.
  it('never makes a later dozen shots cheaper than an earlier one', () => {
    const blocks = shots.slice(1).map((t, i) => {
      const prev = shots[i];
      return { to: t.maxShots, perShot: (t.amountCents - prev.amountCents) / (t.maxShots - prev.maxShots) };
    });
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].perShot, `the block ending at ${blocks[i].to} undercuts the one before it`)
        .toBeGreaterThanOrEqual(blocks[i - 1].perShot);
    }
  });

  // The counterpart, and deliberately the opposite direction: a bigger event is nearly free for us
  // to carry — the same event row, the same gallery — so guests get a volume discount.
  //
  // Asserted on the MARGINAL rate (what the next block of guests costs), not the average per head.
  // The average is a sawtooth in any tiered table — someone with 26 guests pays the 60-guest price —
  // so it is not a rule the ladder can be held to.
  it('keeps guests going the other way — each block cheaper per head than the last', () => {
    const blocks = paid.slice(1).map((t, i) => {
      const prev = paid[i];
      return { to: t.maxGuests, perGuest: (t.amountCents - prev.amountCents) / (t.maxGuests - prev.maxGuests) };
    });
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].perGuest, `the block ending at ${blocks[i].to} costs more per head than the one before`)
        .toBeLessThan(blocks[i - 1].perGuest);
    }
  });
});

describe('who the features are free for', () => {
  it('waives them at the threshold and charges one guest past it', () => {
    expect(featuresFreeAt(billing, SMALL)).toBe(true);
    expect(featuresFreeAt(billing, BIG)).toBe(false);
  });

  it('reads the threshold from config rather than assuming ten', () => {
    expect(featuresFreeAt({ ...billing, freeAllGuests: 25 }, 25)).toBe(true);
    expect(featuresFreeAt({ ...billing, freeAllGuests: 25 }, 26)).toBe(false);
  });

  it('falls back to the SHIPPED threshold before the config has loaded', () => {
    // featureUpsell carries its own copy of this number for the offline case. It has to be the
    // server's number: a wizard rendered before /api/config answers would otherwise advertise a
    // waiver at a guest count the server does not honour, which is a price quoted and not kept.
    expect(featuresFreeAt(null, SMALL)).toBe(true);
    expect(featuresFreeAt(null, BIG)).toBe(false);
    expect(retentionIncludedDays(null, BIG)).toBe(billing.retentionFreeDays);
  });
});

describe('the event pass', () => {
  it('is free at or under the threshold', () => {
    expect(guestBaseCents(billing, SMALL)).toBe(0);
  });

  it('charges the smallest tier that still holds the guests', () => {
    expect(guestBaseCents(billing, BIG)).toBe(paid[0].amountCents);
    expect(guestBaseCents(billing, paid[0].maxGuests)).toBe(paid[0].amountCents);
    expect(guestBaseCents(billing, paid[0].maxGuests + 1)).toBe(paid[1].amountCents);
    expect(guestBaseCents(billing, paid.at(-1)!.maxGuests)).toBe(paid.at(-1)!.amountCents);
  });

  it('costs more, never less, as the guest count climbs', () => {
    for (let i = 1; i < paid.length; i++) {
      expect(guestBaseCents(billing, paid[i].maxGuests))
        .toBeGreaterThan(guestBaseCents(billing, paid[i - 1].maxGuests));
    }
  });

  it('does not fall to zero past the largest tier', () => {
    // The server answers tier:'custom' there and the form says "contact us". A $0 shown while that
    // is being arranged reads as "your 1000-guest event is free". (The server's own quote() is a
    // separate matter and is not what this asserts — this pins what the WIZARD shows.)
    const top = paid.at(-1)!;
    expect(guestBaseCents(billing, top.maxGuests + 1)).toBe(top.amountCents);
    expect(guestBaseCents(billing, top.maxGuests * 10)).toBe(top.amountCents);
  });
});

describe('extra shots', () => {
  const firstPaid = () => shots.find((t) => t.amountCents > 0)!;

  it('charges nothing for the included allowance', () => {
    expect(shotsPrice(billing, billing.shotsFree, BIG)).toEqual({ kind: 'included' });
  });

  it('gifts the add-on on a small event, at its real price', () => {
    const first = firstPaid();
    expect(shotsPrice(billing, first.maxShots, SMALL))
      .toEqual({ kind: 'gift', wouldBeCents: first.amountCents });
    const top = shots.at(-1)!;
    expect(shotsPrice(billing, top.maxShots, SMALL)).toEqual({ kind: 'gift', wouldBeCents: top.amountCents });
  });

  it('charges the same add-on once the event is bigger', () => {
    const first = firstPaid();
    expect(shotsPrice(billing, first.maxShots, BIG))
      .toEqual({ kind: 'paid', cents: first.amountCents });
  });

  it('prices by the smallest tier that covers the count, and one shot past a cap costs more', () => {
    for (let i = 1; i < shots.length; i++) {
      expect(shotsAddonCents(billing, shots[i].maxShots)).toBe(shots[i].amountCents);
      expect(shotsAddonCents(billing, shots[i - 1].maxShots + 1)).toBe(shots[i].amountCents);
      expect(shotsAddonCents(billing, shots[i].maxShots))
        .toBeGreaterThan(shotsAddonCents(billing, shots[i - 1].maxShots));
    }
  });
});

describe('video clips', () => {
  const offered = billing.videoAddons ?? [];

  it('treats no video as the absence of the feature, not as a gift', () => {
    // Otherwise the "Off" choice wears a struck-through price for a thing nobody is getting.
    expect(videoPrice(billing, 0, SMALL)).toEqual({ kind: 'included' });
  });

  it('gifts a clip length on a small event and charges it on a big one', () => {
    const a = offered[1];
    expect(videoPrice(billing, a.seconds, SMALL)).toEqual({ kind: 'gift', wouldBeCents: a.amountCents });
    expect(videoPrice(billing, a.seconds, BIG)).toEqual({ kind: 'paid', cents: a.amountCents });
  });

  it('matches a clip length exactly rather than rounding up a ladder', () => {
    // The video add-ons are a menu of lengths, not caps: a length between two of them is not "the
    // next one up", it is simply not on sale.
    const between = Math.round((offered[1].seconds + offered[2].seconds) / 2);
    expect(offered.some((v) => v.seconds === between)).toBe(false);
    expect(videoAddonCents(billing, between)).toBe(0);
    for (const v of offered) expect(videoAddonCents(billing, v.seconds)).toBe(v.amountCents);
  });
});

describe('frame shapes', () => {
  it('gifts the pack at or under the threshold and charges it above', () => {
    expect(framePackPrice(billing, SMALL)).toEqual({ kind: 'gift', wouldBeCents: billing.framePackCents });
    expect(framePackPrice(billing, BIG)).toEqual({ kind: 'paid', cents: billing.framePackCents });
  });
});

describe('event length', () => {
  it('prices by the smallest window that still fits, and an hour past one costs more', () => {
    expect(durationAddonCents(billing, billing.durationFreeHours)).toBe(0);
    for (let i = 1; i < durations.length; i++) {
      expect(durationAddonCents(billing, durations[i].maxHours)).toBe(durations[i].amountCents);
      expect(durationAddonCents(billing, durations[i - 1].maxHours + 1)).toBe(durations[i].amountCents);
      expect(durationAddonCents(billing, durations[i].maxHours))
        .toBeGreaterThan(durationAddonCents(billing, durations[i - 1].maxHours));
    }
  });

  it('gives the free window away for nothing', () => {
    // The included window and the tier that covers it have to be the same length, or a host is
    // charged an add-on for an event they were told was inside the free allowance.
    const free = durations.find((t) => t.amountCents === 0)!;
    expect(free.maxHours).toBe(billing.durationFreeHours);
  });
});

describe('keeping the photos', () => {
  it('runs the opposite way to the other add-ons', () => {
    // A free event gets a week; a paid one has a month included. The guest-count waiver does not
    // reach retention at all — it inverts there.
    expect(retentionIncludedDays(billing, SMALL)).toBe(billing.retentionFreeDays);
    expect(retentionIncludedDays(billing, BIG)).toBe(billing.retentionPaidDays);
    expect(billing.retentionPaidDays).toBeGreaterThan(billing.retentionFreeDays);
  });

  it('has a tier of exactly the paid allowance, so "1 month" is never a charge for a day', () => {
    // billing.ts keeps the 31-day tier equal to RETENTION_PAID_DAYS on purpose: a paid event
    // picking the month must not be billed an add-on for a day or two past what it already has.
    expect(retentions.some((t) => t.maxDays === billing.retentionPaidDays)).toBe(true);
    expect(retentions.some((t) => t.maxDays === billing.retentionFreeDays)).toBe(true);
  });

  it('never offers a free event less than it already gets', () => {
    const free = retentionChoices(billing, SMALL);
    expect(free.map((c) => c.days)).toEqual(retentions.map((t) => t.maxDays));
    expect(free[0]).toMatchObject({ days: billing.retentionFreeDays, amountCents: 0, included: false });
    expect(free.every((c) => c.days >= billing.retentionFreeDays)).toBe(true);
  });

  it('drops the lengths a paid event has already paid to beat', () => {
    const bought = retentionChoices(billing, BIG);
    expect(bought.every((c) => c.days >= billing.retentionPaidDays)).toBe(true);
    expect(bought.map((c) => c.days))
      .toEqual(retentions.filter((t) => t.maxDays >= billing.retentionPaidDays).map((t) => t.maxDays));
    // The month has a real price and this event is not being charged it — that is "included",
    // which is a different claim from the week being free on a free event.
    expect(bought[0]).toMatchObject({ days: billing.retentionPaidDays, amountCents: 0, included: true });
    expect(bought[1].amountCents).toBe(retentions.find((t) => t.maxDays === bought[1].days)!.amountCents);
    expect(bought[1].included).toBe(false);
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
    // And whatever the server's table holds, no length reaches a host as a raw day count.
    for (const t of retentions) expect(retentionLabel(t.maxDays)).not.toMatch(/\bdays?\b/);
  });
});

describe('the little price beside a choice', () => {
  it('strikes a gift through and states it plainly out loud', () => {
    const gift = { kind: 'gift', wouldBeCents: 500 } as const;
    expect(priceTag(gift, money)).toEqual({ text: '+$5.00', cls: 'was' });
    expect(priceAria(gift, money)).toBe('normally $5.00 — free on your event');
  });

  it('does not dress a real charge as anything else', () => {
    const charge = { kind: 'paid', cents: 300 } as const;
    expect(priceTag(charge, money)).toEqual({ text: '+$3.00', cls: 'add' });
    expect(priceAria(charge, money)).toBe('plus $3.00');
  });

  it('lets the caller say "included" where "free" would be the wrong word', () => {
    expect(priceTag({ kind: 'included' }, money)).toEqual({ text: 'free', cls: 'incl' });
    expect(priceTag({ kind: 'included' }, money, 'included').text).toBe('included');
    expect(priceAria({ kind: 'included' }, money, 'included')).toBe('included');
  });
});

// ── Going back down ──────────────────────────────────────────────────────────
//
// The form carried a one-way ratchet: raise retention to whatever the tier includes, never lower
// it. That fixed the upgrade and broke the reverse. Free → paid → free left the paid tier's month
// selected, and a month on the FREE tier is a chargeable add-on — so a host who only looked at the
// paid option and changed their mind was quoted for an upgrade they never chose. The tier picked
// the number; the tier never put it back.
describe('retention when the guest count moves between tiers', () => {
  const FREE = 7, PAID = 31;

  it('follows the tier in both directions while the host has not chosen', () => {
    expect(retentionFor(FREE, PAID, false)).toBe(PAID);   // free → paid: they have paid for a month
    expect(retentionFor(PAID, FREE, false)).toBe(FREE);   // …and back: the bug, in one line
  });

  it('goes all the way back, so nothing is charged for', () => {
    // The exact reported path: start free, look at a paid tier, return to free.
    let days = FREE;
    days = retentionFor(days, PAID, false);
    days = retentionFor(days, FREE, false);
    expect(days).toBe(FREE);
  });

  it("keeps a length the host actually picked", () => {
    // Deliberately bought a year, then edited the guest count. It must survive.
    expect(retentionFor(365, FREE, true)).toBe(365);
    expect(retentionFor(365, PAID, true)).toBe(365);
    expect(retentionFor(92, FREE, true)).toBe(92);
  });

  it('still lifts a chosen length that a tier has overtaken', () => {
    // Chose a week on the free tier, then went paid, where a month is included. Leaving them on 7
    // would sell them a week they had already beaten — the fault the original ratchet existed for.
    expect(retentionFor(FREE, PAID, true)).toBe(PAID);
  });

  it('never returns less than the tier includes', () => {
    for (const touched of [true, false]) {
      for (const current of [1, 7, 31, 92, 182, 365]) {
        for (const included of [FREE, PAID]) {
          expect(retentionFor(current, included, touched)).toBeGreaterThanOrEqual(included);
        }
      }
    }
  });

  it('is settled: applying it twice changes nothing', () => {
    for (const touched of [true, false]) {
      for (const current of [7, 31, 365]) {
        const once = retentionFor(current, PAID, touched);
        expect(retentionFor(once, PAID, touched)).toBe(once);
      }
    }
  });
});

// ── Video is the one add-on priced by guests x seconds ───────────────────────────────────────
//
// The wizard quotes a clip before the server does. If the two ever round differently the host is
// shown one number and charged another, so this pins the client half against the same arithmetic
// videoCentsFor() uses on the server — multiplier by tier, then to the nearest dollar.
describe('what a clip costs on an event of this size', () => {
  const billing = {
    billingEnabled: true, currency: 'aud', freeAllGuests: 10,
    paidTiers: [
      { maxGuests: 25, amountCents: 500, videoMul: 1 },
      { maxGuests: 60, amountCents: 1500, videoMul: 1.25 },
      { maxGuests: 150, amountCents: 2900, videoMul: 1.75 },
      { maxGuests: 400, amountCents: 5900, videoMul: 2.25 },
    ],
    videoAddons: [
      { seconds: 10, amountCents: 200 }, { seconds: 30, amountCents: 600 },
      { seconds: 60, amountCents: 1400 }, { seconds: 90, amountCents: 2400 },
    ],
    shotsFree: 12, shotsTiers: [], framePackCents: 500,
    durationFreeHours: 48, durationTiers: [], retentionFreeDays: 7, retentionPaidDays: 31, retentionTiers: [],
  } as unknown as BillingConfig;

  it('charges the listed price on the smallest paid tier', () => {
    expect(videoAddonCents(billing, 60, 25)).toBe(1400);
    expect(videoAddonCents(billing, 90, 25)).toBe(2400);
  });

  it('scales it up with the guest tier, to the dollar', () => {
    expect(videoAddonCents(billing, 60, 60)).toBe(1800);    // 14 x 1.25 = 17.50 → $18
    expect(videoAddonCents(billing, 60, 150)).toBe(2500);   // 14 x 1.75 = 24.50 → $25 (half up)
    expect(videoAddonCents(billing, 90, 400)).toBe(5400);   // 24 x 2.25 = $54
  });

  it('never returns a part-dollar, whatever the multiplier does', () => {
    for (const g of [25, 60, 150, 400]) {
      for (const sec of [10, 30, 60, 90]) {
        expect(videoAddonCents(billing, sec, g) % 100, `${sec}s at ${g} guests`).toBe(0);
      }
    }
  });

  it('falls back to the list price when nobody has said how many guests', () => {
    expect(videoAddonCents(billing, 60)).toBe(1400);
  });

  it('is still free on an event small enough to be free', () => {
    expect(videoPrice(billing, 90, 10).kind).toBe('gift');
  });

  it('treats an unknown clip length as no charge rather than guessing', () => {
    expect(videoAddonCents(billing, 45, 150)).toBe(0);
  });
});
