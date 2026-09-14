// That the panel's keep-length control is actually wired to the rule it is supposed to obey.
//
// upgradePlan.test.ts pins the rule; this pins the wiring, and the wiring is the half that was
// wrong. The panel held its own one-way ratchet — raise retention to whatever the guest tier being
// shopped for includes, never lower it — and because the Guests dropdown only lists tiers at or
// above this event's, that read as unreachable. It is not: the SELECTION moves freely inside that
// list. A host on a free event who opens the paid tier to see the price and then goes back was
// left holding the paid tier's month, which on a free event is a $3 add-on, and the panel quoted
// it. Two things have to hold: the tier can take its own number back, and it can never take the
// host's.
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import UpgradePanel from './UpgradePanel.svelte';
import type { BillingConfig, AppOptions } from '$lib/types';

// The panel re-quotes on every change; the prices it shows are the server's business and are
// asserted where they are computed. Here it only has to not reach the network.
vi.mock('$lib/api', () => ({ postJson: vi.fn(async () => ({})) }));

const billing = {
  billingEnabled: true, currency: 'aud', freeAllGuests: 10,
  paidTiers: [{ maxGuests: 25, amountCents: 500 }, { maxGuests: 60, amountCents: 1500 }],
  shotsFree: 12, shotsTiers: [{ maxShots: 24, amountCents: 300 }], framePackCents: 500,
  videoAddons: [{ seconds: 10, amountCents: 500 }],
  durationFreeHours: 24, durationTiers: [{ maxHours: 24, amountCents: 0 }, { maxHours: 72, amountCents: 500 }],
  retentionFreeDays: 7, retentionPaidDays: 31,
  retentionTiers: [{ maxDays: 7, amountCents: 0 }, { maxDays: 31, amountCents: 300 }, { maxDays: 365, amountCents: 2000 }],
} as unknown as BillingConfig;

const options = {
  aspectRatios: [{ value: '1:1', label: 'Square' }, { value: '16:9', label: 'Wide' }],
  shotsPerPerson: [{ value: '12', label: '12' }, { value: '24', label: '24' }],
  durations: [{ value: '24', label: '1 day' }, { value: '72', label: '3 days' }],
} as unknown as AppOptions;

/** A free event: 10 guests, a week's keep, nothing paid. */
const freeEvent = {
  code: 'ABC123', orgCode: 'ORG', billing, options,
  guestCap: 10, maxPhotos: 12, videoSeconds: 0, retentionDays: 7,
  amountPaidCents: 0, aspectRatios: ['1:1'], durationHours: 24,
};

// The dropdowns carry no test ids; they are found the way a host finds them, by their label.
const pick = (c: HTMLElement, label: string): HTMLSelectElement => {
  const wrap = [...c.querySelectorAll('label.u')].find((l) => l.querySelector('span')?.textContent === label);
  if (!wrap) throw new Error(`no "${label}" control on the panel`);
  return wrap.querySelector('select') as HTMLSelectElement;
};
const set = async (el: HTMLSelectElement, value: string) => {
  await fireEvent.change(el, { target: { value } });
  await tick();
};

describe('the upgrade panel’s keep-photos control', () => {
  it('gives the tier’s month back when the host drops the guest tier again', async () => {
    const { container } = render(UpgradePanel, { props: freeEvent });
    expect(pick(container, 'Keep photos').value).toBe('7');

    await set(pick(container, 'Guests'), '60');          // a paid tier — a month is included
    expect(pick(container, 'Keep photos').value).toBe('31');

    await set(pick(container, 'Guests'), '10');          // …and think better of it
    expect(pick(container, 'Keep photos').value).toBe('7');
  });

  it('keeps a length the host chose themselves through the same trip', async () => {
    const { container } = render(UpgradePanel, { props: freeEvent });
    await set(pick(container, 'Keep photos'), '365');    // deliberately bought a year
    await set(pick(container, 'Guests'), '60');
    await set(pick(container, 'Guests'), '10');
    expect(pick(container, 'Keep photos').value).toBe('365');
  });

  it('never offers less than the event already has — the server refuses downgrades', async () => {
    // A year already paid for leaves nothing to sell, so the control goes away rather than
    // listing "1 week": /api/billing/upgrade clamps every field UP, so a shorter keep would be
    // quoted at one price and charged against a total the server never lowered.
    const { container } = render(UpgradePanel, { props: { ...freeEvent, retentionDays: 365, amountPaidCents: 2000 } });
    expect(() => pick(container, 'Keep photos')).toThrow();
    // The tier can still be raised, and doing so must not resurrect a shorter one.
    await set(pick(container, 'Guests'), '60');
    expect(() => pick(container, 'Keep photos')).toThrow();
  });
});

// ── What the breakdown SAYS, which is all that changed ─────────────────────────
//
// A ≤10-guest event is gifted every feature. Grow past ten and quote() re-prices the whole config,
// so those gifts become chargeable — correct under the pricing model, and it looked like a fault
// because nothing said so. Worst of all was the frame pack: pricing charges it for ANY non-square
// shape while the panel's checkbox asked about ALL of them, so a host holding one wide shape was
// shown an UNTICKED "Unlock all frame sizes" box above a $5 charge for the pack.
//
// The prices are deliberately untouched. These tests exist to keep it that way as much as to pin
// the new wording.

/** An event that used its free-tier gifts: a wide shape and more shots than the free allowance. */
const giftedEvent = {
  ...freeEvent, maxPhotos: 24, aspectRatios: ['1:1', '16:9'],
};

describe('the upgrade breakdown tells a host what they already have', () => {
  it('does not offer the frame pack as an opt-in once the event holds a wide shape', async () => {
    const { container } = render(UpgradePanel, { props: giftedEvent });
    await tick();
    const chk = [...container.querySelectorAll('label.chk')]
      .find((l) => /Unlock all frame sizes/.test(l.textContent || ''));
    expect(chk, 'an unticked "unlock" box beside a charge for the same thing').toBeUndefined();
    expect(container.textContent).toContain('Frame sizes are already on your event');
  });

  it('still offers it to an event that has no wide shape', async () => {
    const { container } = render(UpgradePanel, { props: freeEvent });
    await tick();
    const chk = [...container.querySelectorAll('label.chk')]
      .find((l) => /Unlock all frame sizes/.test(l.textContent || ''));
    expect(chk, 'a host without the pack must still be able to buy it').toBeDefined();
    expect(container.textContent).not.toContain('Frame sizes are already on your event');
  });

  it('changes nothing about what is charged', async () => {
    // The whole point: presentation only. The panel's own selections are untouched by any of this,
    // so the values it would send to /upgrade are the values it sent before.
    const { container } = render(UpgradePanel, { props: giftedEvent });
    await tick();
    // Only the controls that can still be RAISED are rendered, so this event (already at the top
    // shots tier) shows no shots control at all — which is itself the point: nothing here was
    // re-selected, so the values sent to /upgrade are the values sent before.
    expect(pick(container as HTMLElement, 'Guests').value).toBe('10');
    expect(pick(container as HTMLElement, 'Keep photos').value).toBe('7');
    // And the wide shape it already holds is not re-offered as something to buy.
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });
});

