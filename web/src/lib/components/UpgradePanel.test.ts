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
import { postJson } from '$lib/api';

/** A server quote, for the tests that are about how one is PRESENTED.
 *
 *  Most tests here only drive the selects and are happy with the default empty reply — the prices
 *  are the server's business and are asserted where they are computed. These three are the
 *  exception: they are about the breakdown's own arithmetic, which needs numbers to show. */
const quoteOf = (over: Record<string, unknown> = {}) => ({
  tier: 'paid', amountCents: 1500, baseCents: 1500, maxGuests: 10, coveredCents: 0,
  maxPhotos: 24, videoSeconds: 0, durationHours: 24, retentionDays: 7,
  framePack: false, shotsCents: 0, frameCents: 0, videoCents: 0, durationCents: 0, retentionCents: 0,
  ...over,
});
/** Let the panel's quote promise settle — `tick()` alone only flushes Svelte, not the fetch. */
const settled = async () => { for (let i = 0; i < 4; i++) { await Promise.resolve(); await tick(); } };

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

  // The reported bug, in the shape it was reported in: an event already holding more retention than
  // its tier includes, so the "untouched" rule below resolves to the event's OWN number. The panel
  // carried two listeners on one change event — `bind:value` and an `on:change` that set the
  // touched flag — and the flush could run the rule while the flag was still false, which hands
  // back the tier's number and throws the host's pick away. The second pick then stuck, because by
  // then the flag was set. One handler now sets both, in order.
  //
  // NOTE: this passes against the two-listener version too — jsdom's fireEvent runs both listeners
  // before the flush, which is exactly why the bug reached a browser. It is here to pin the rule,
  // not to stand in for the browser check.
  it('takes the host’s FIRST pick on an event that already has more than its tier includes', async () => {
    const { container } = render(UpgradePanel, { props: { ...freeEvent, guestCap: 60, retentionDays: 31, amountPaidCents: 800 } });
    const keep = pick(container, 'Keep photos');
    expect(keep.value).toBe('31');
    await set(keep, '365');
    expect(pick(container, 'Keep photos').value, 'the first pick must stick').toBe('365');
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
  });

  // The note earns its place by explaining a CHARGE, and the charge only exists past the free
  // tier — that is the whole mechanism this group was written for. Below ten guests there is no
  // charged line to account for, so the note would be a bare "you already have this" on a panel
  // whose entire job is offering things you do not.
  it('still says the pack is yours inside the free tier — just does not price it', async () => {
    // This asserted SILENCE, and silence turned out to be the bug. Own the pack and sit inside the
    // free guest tier and both branches fell through: no note, because there was no charge to
    // explain, and no toggle either, because the toggle is for buying what you already have. The
    // panel simply went quiet about a paid-for feature — which does not read as "nothing to say",
    // it reads as the option having vanished, on the one screen where a host audits what they own.
    // Reported from a real event: frame sizes on, guest cap 10, free tier 10, nothing on screen.
    const { container } = render(UpgradePanel, { props: giftedEvent });
    await tick();
    expect(container.textContent).toContain('Frame sizes are already on your event');
    // The CHARGING half keeps its own gate — there is nothing to account for at this tier, and
    // pricing something that costs nothing is its own kind of wrong.
    expect(container.textContent).not.toContain('charged above');
    // And it must not offer to sell them what they have.
    expect(container.textContent).not.toContain('Unlock all frame sizes');
  });

  it('explains the pack the moment growing past the free tier starts charging for it', async () => {
    const { container } = render(UpgradePanel, { props: giftedEvent });
    await set(pick(container as HTMLElement, 'Guests'), '25');
    expect(container.textContent).toContain('Frame sizes are already on your event');
  });

  it('still offers it to an event that has no wide shape', async () => {
    const { container } = render(UpgradePanel, { props: freeEvent });
    await tick();
    // A switch now, not a tick — one feature, on or off. Found by the control it labels rather
    // than by the element type, so the next restyle does not red this for a reason that has
    // nothing to do with whether the offer is there.
    const toggle = container.querySelector('#u-frames') as HTMLInputElement | null;
    const label = container.querySelector('label[for="u-frames"]');
    expect(toggle, 'a host without the pack must still be able to buy it').toBeTruthy();
    expect(label?.textContent || '', 'and the offer must still say what it is')
      .toMatch(/Unlock all frame sizes/);
    expect(container.textContent).not.toContain('Frame sizes are already on your event');
  });

  // The event pass was the one line that could never say "already yours", so the biggest number in
  // the breakdown always read as a fresh charge — even for a host who had not touched the guest tier.
  it('says the event pass is already yours when the guest tier is untouched', async () => {
    vi.mocked(postJson).mockResolvedValue(quoteOf());
    const { container } = render(UpgradePanel, { props: giftedEvent });
    // Buy something ELSE, so the breakdown is up and the guest tier is still untouched — which is
    // the case this test is about. (The breakdown only renders once a change costs money.)
    await set(pick(container as HTMLElement, 'Video'), '10');
    await settled();
    const pass = [...container.querySelectorAll('.quote-lines li')]
      .find((l) => /Event pass/.test(l.textContent || ''));
    expect(pass, 'the breakdown should itemise the event pass').toBeDefined();
    expect(pass?.textContent).toContain('already yours');
  });

  // The list prices the WHOLE event, so on a paid event its lines sum to more than is owed. Without
  // the subtraction shown, a priced "already yours" line reads as being charged a second time.
  it('shows what has been paid and what is left, so the line prices add up to something', async () => {
    // coveredCents, not amountPaidCents: the subtraction is now "what your event already has, at
    // today's prices", which is the same sum the upgrade route bills.
    vi.mocked(postJson).mockResolvedValue(quoteOf({ coveredCents: 500 }));
    const { container } = render(UpgradePanel, { props: { ...giftedEvent, amountPaidCents: 500 } });
    await set(pick(container as HTMLElement, 'Video'), '10');
    await settled();
    const sum = container.querySelector('.quote-lines.sum');
    expect(sum, 'a paid event needs the subtraction spelled out').not.toBeNull();
    expect(sum?.textContent).toContain('Already on your event');
    expect(sum?.textContent).toContain('You pay now');
    // The headline stops calling itself "total" once it is no longer the amount due.
    expect(container.querySelector('.quote-price')?.textContent).toContain('new total');
  });

  it('does not spell out a subtraction when nothing has been paid', async () => {
    vi.mocked(postJson).mockResolvedValue(quoteOf());
    const { container } = render(UpgradePanel, { props: giftedEvent });
    // With the breakdown up — otherwise this passes for the wrong reason, there being no
    // breakdown at all to look in.
    await set(pick(container as HTMLElement, 'Video'), '10');
    await settled();
    expect(container.querySelector('.quote'), 'the breakdown should be showing').not.toBeNull();
    expect(container.querySelector('.quote-lines.sum'), 'minus $0 is noise').toBeNull();
    expect(container.querySelector('.quote-price')?.textContent).not.toContain('new total');
  });

  // Six items at one weight and one colour, and the host has to hunt for which one the upgrade is
  // even about. `class:owned` was already being set and nothing styled it.
  it('tells the changing line apart from the ones you already have', async () => {
    vi.mocked(postJson).mockResolvedValue(quoteOf({ maxGuests: 25 }));
    const { container } = render(UpgradePanel, { props: giftedEvent });
    await set(pick(container as HTMLElement, 'Guests'), '25');
    await settled();

    const line = (needle: RegExp) => [...container.querySelectorAll('.quote-lines li')]
      .find((l) => needle.test(l.textContent || ''));

    const pass = line(/Event pass/);
    expect(pass, 'the event pass should be itemised').toBeDefined();
    expect(pass?.classList.contains('owned'), 'a raised guest tier is NOT already yours').toBe(false);
    expect(pass?.querySelector('.prev')?.textContent, 'it should say what it was').toContain('10');

    // …and something untouched keeps the quieter treatment.
    const shots = line(/Extra shots/);
    if (shots) {
      expect(shots.classList.contains('owned'), 'untouched shots are already yours').toBe(true);
      expect(shots.querySelector('.prev'), 'an unchanged line has no "was"').toBeNull();
    }
  });

  // The breakdown answers "why that number", so it has no business on screen before there is a
  // number. Rendered at rest it was a priced list of everything the host already owns, sitting
  // under a heading that offers to sell them more — which is the reading that made an "already
  // yours" line look like a second charge in the first place.
  it('keeps the breakdown off the card until the host changes something', async () => {
    vi.mocked(postJson).mockResolvedValue(quoteOf());
    const { container } = render(UpgradePanel, { props: giftedEvent });
    await settled();
    expect(container.querySelector('.quote'), 'nothing has changed — there is nothing to explain').toBeNull();
    // What the card says at rest is the one line at the top, and it still says it.
    expect(container.querySelector('.cur')?.textContent).toContain('10');
  });

  it('brings it out as soon as a selection costs something', async () => {
    vi.mocked(postJson).mockResolvedValue(quoteOf({ videoSeconds: 10, videoCents: 500 }));
    const { container } = render(UpgradePanel, { props: giftedEvent });
    await set(pick(container as HTMLElement, 'Video'), '10');
    await settled();
    expect(container.querySelector('.quote'), 'a charge needs itemising').not.toBeNull();
  });

  // A change the event has already paid for charges nothing, and the button says so on its own.
  // An itemised list of a $0 bill is the noise this whole change is removing.
  it('stays away for a change that is already covered', async () => {
    vi.mocked(postJson).mockResolvedValue(quoteOf({ coveredCents: 1500 }));
    const { container } = render(UpgradePanel, { props: { ...giftedEvent, amountPaidCents: 1500 } });
    await set(pick(container as HTMLElement, 'Video'), '10');
    await settled();
    expect(container.querySelector('.quote'), 'nothing to pay, nothing to itemise').toBeNull();
    expect(container.textContent).toContain('already covered');
  });

  // Three places used to state one number: the "Now:" line, the subtraction, and a footnote. The
  // footnote is gone; the "Now:" line carries it whether the breakdown is up or not.
  it('states what has been paid exactly once, at the top', async () => {
    vi.mocked(postJson).mockResolvedValue(quoteOf());
    const { container } = render(UpgradePanel, { props: { ...giftedEvent, amountPaidCents: 500 } });
    await settled();
    expect(container.querySelector('.cur')?.textContent).toContain('$5.00');
    expect(container.textContent).not.toContain('Already paid');
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

