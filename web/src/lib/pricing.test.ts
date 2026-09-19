// The pricing page must not quote a price we do not charge.
//
// It did, for a whole release: "36 (+A$5) or 48 (+A$8)" stayed on the live page after those rungs
// became $6 and $9, because the copy was a hand-kept mirror of billing.ts with a comment asking the
// next person to remember. This pins the replacement — the two volatile lines are built from the
// config, and the static fallback states no figure it could be wrong about.
import { describe, it, expect } from 'vitest';
import { addOns, addOnsFor } from './pricing';
import type { BillingConfig } from './types';

const billing = {
  shotsFree: 12,
  shotsTiers: [
    { maxShots: 12, amountCents: 0 }, { maxShots: 24, amountCents: 300 },
    { maxShots: 60, amountCents: 1300 }, { maxShots: 120, amountCents: 4800 },
  ],
  videoAddons: [
    { seconds: 10, amountCents: 200 }, { seconds: 30, amountCents: 600 },
    { seconds: 90, amountCents: 2400 },
  ],
} as unknown as BillingConfig;

const detail = (list: ReturnType<typeof addOnsFor>, name: string) =>
  list.find((a) => a.name === name)!.detail;

describe('the pricing page quotes what we actually charge', () => {
  it('builds the shots line from the ladder, top rung and all', () => {
    const d = detail(addOnsFor(billing), 'More shots per guest');
    expect(d).toContain('12 included');
    expect(d).toContain('120 each');       // the top of the ladder, not a number frozen in prose
    expect(d).toContain('+A$3');           // the next dozen
    expect(d).toContain('+A$48');          // the lot
  });

  it('builds the video line from the addons, and says it scales', () => {
    const d = detail(addOnsFor(billing), 'Video clips');
    expect(d).toContain('10s to 90s');
    expect(d).toContain('+A$2');
    expect(d).toMatch(/scales with your guest count/);
  });

  // The important half. If the config never arrives the page still renders, and what it renders
  // has to be true forever — which it is only if it states no price at all.
  it('states no figure at all when there is no config to state one from', () => {
    for (const list of [addOns, addOnsFor(null), addOnsFor(undefined), addOnsFor({} as BillingConfig)]) {
      for (const name of ['More shots per guest', 'Video clips']) {
        const d = list.find((a) => a.name === name)!.detail;
        expect(d, `${name} fallback must quote no price`).not.toMatch(/A\$\d/);
      }
    }
  });

  it('leaves the prose lines alone', () => {
    const before = addOns.find((a) => a.name === 'Longer event window')!.detail;
    expect(detail(addOnsFor(billing), 'Longer event window')).toBe(before);
  });

  // A ladder of one rung is "nothing to sell", not "sell the free tier" — the line must stay
  // unpriced rather than announce "+A$0".
  it('does not invent an offer from a ladder with nothing above the free rung', () => {
    const thin = { ...billing, shotsTiers: [{ maxShots: 12, amountCents: 0 }] } as unknown as BillingConfig;
    expect(detail(addOnsFor(thin), 'More shots per guest')).not.toMatch(/A\$\d/);
  });
});
