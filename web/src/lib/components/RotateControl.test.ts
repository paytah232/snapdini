// One slot, two faces — the control the host asked for after pressing the old one.
//
// The old Rotate button made Save and Cancel APPEAR beside it, which pushed Download, Share and
// Reject to new positions in the same moment the host was reaching for one of them. The rule this
// file exists to hold is therefore a LAYOUT rule, not a behaviour one: pressing the control must
// not change how many controls there are. That is invisible to a test that only clicks things —
// jsdom has no layout — so it is asserted directly: both faces are always in the DOM, and only one
// of them is ever reachable.
import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import RotateControl from './RotateControl.svelte';

/** What a person can actually reach. The face that is not in use stays in the layout — that is the
 *  whole mechanism — so a bare querySelector finds it as happily as the shown one. */
const live = (c: HTMLElement, label: string) => {
  // ALL of them, not the first: "Turn left" is on both faces, so a querySelector that stops at the
  // first match keeps finding the hidden one and reporting the control as absent.
  const all = [...c.querySelectorAll<HTMLButtonElement>(`[aria-label="${label}"]`)];
  return all.find((el) => !el.closest('[aria-hidden="true"]')) ?? null;
};
const CLOCKWISE = 'Rotate this photo a quarter turn clockwise';
const REST = ['Turn left', CLOCKWISE];
const WORKING = ['Turn left', 'Turn right', 'Save this rotation', 'Discard this rotation'];

describe('the slot', () => {
  it('holds both faces at once, whichever one is showing', () => {
    // The mechanism, stated plainly: the box is as wide as the wider of the two, so it cannot
    // change size when the face swaps. Rendering one at a time is what made the row jump.
    const idle = render(RotateControl, { pending: 0 });
    expect(idle.container.querySelectorAll('button')).toHaveLength(6);
    const turned = render(RotateControl, { pending: 90 });
    expect(turned.container.querySelectorAll('button')).toHaveLength(6);
  });

  it('offers exactly one face to a person at a time', async () => {
    const { container, component } = render(RotateControl, { pending: 0 });
    for (const l of REST) expect(live(container, l), `${l} at rest`).not.toBeNull();
    for (const l of ['Turn right', 'Save this rotation', 'Discard this rotation']) {
      expect(live(container, l), `${l} is not offered at rest`).toBeNull();
    }

    await component.$set({ pending: 90 });
    await tick();
    for (const l of WORKING) expect(live(container, l), `${l} once a turn is pending`).not.toBeNull();
    expect(live(container, CLOCKWISE), 'the resting face steps aside').toBeNull();
  });

  it('keeps the hidden face out of the tab order as well as out of sight', () => {
    // visibility:hidden already does this; the attribute says it again so that a stylesheet which
    // failed to arrive leaves an inert control rather than an invisible, tabbable one.
    const { container } = render(RotateControl, { pending: 0 });
    const hidden = container.querySelectorAll('[aria-hidden="true"] button');
    expect(hidden).toHaveLength(4);
    for (const b of hidden) expect(b.getAttribute('tabindex')).toBe('-1');
  });

  it('every icon-only segment says what it is — a glyph has no name', () => {
    const { container } = render(RotateControl, { pending: 90 });
    for (const l of WORKING) {
      const b = live(container, l)!;
      expect(b.tagName, `${l} is a real button, so Enter and Space already work`).toBe('BUTTON');
      expect(b.textContent!.trim().length, `${l} is icon-only`).toBeLessThanOrEqual(2);
    }
  });
});

describe('what it asks the page to do', () => {
  it('turns either way FROM REST, which is the whole reason for the left arrow', async () => {
    // Anticlockwise used to be three presses of ↻. A left arrow that only appeared once something
    // was pending would still be three — you would have to go the wrong way first to reveal it.
    const turns: number[] = [];
    const { container, component } = render(RotateControl, { pending: 0 });
    component.$on('turn', (e) => turns.push(e.detail));
    await fireEvent.click(live(container, 'Turn left')!);
    await fireEvent.click(live(container, CLOCKWISE)!);
    expect(turns).toEqual([-90, 90]);
  });

  it('and either way again while a turn is pending', async () => {
    const turns: number[] = [];
    const { container, component } = render(RotateControl, { pending: 90 });
    component.$on('turn', (e) => turns.push(e.detail));
    await fireEvent.click(live(container, 'Turn right')!);
    await fireEvent.click(live(container, 'Turn left')!);
    expect(turns).toEqual([90, -90]);
  });

  it('saves and discards', async () => {
    let saved = 0, cancelled = 0;
    const { container, component } = render(RotateControl, { pending: 180 });
    component.$on('save', () => saved++);
    component.$on('cancel', () => cancelled++);
    await fireEvent.click(live(container, 'Save this rotation')!);
    await fireEvent.click(live(container, 'Discard this rotation')!);
    expect([saved, cancelled]).toEqual([1, 1]);
  });

  it('goes inert while the write is in flight, and shows a moving mark rather than text', () => {
    // Nothing may resize mid-write — "Saving…" in place of a tick would widen the segment at the
    // exact moment somebody is watching it — so the indicator is a drawn element sized in em,
    // occupying the box the tick had. It has to MOVE: a clip rotation is a remux of the original
    // and of every derived copy, so on a long 4K clip this state lasts seconds to tens of seconds,
    // and something static for that long reads as a hang. A hang is when people press again.
    const { container } = render(RotateControl, { pending: 90, busy: true });
    for (const l of WORKING) expect(live(container, l)!.disabled, `${l} is disabled`).toBe(true);

    // The accessible NAME stays "Save this rotation" throughout. State is what aria-busy is for;
    // renaming a control to describe what it is doing makes it a different control to anything
    // looking it up by name, which is how this test found the mistake.
    const save = live(container, 'Save this rotation')!;
    expect(save.getAttribute('aria-busy')).toBe('true');
    // The mark itself, not a character in the text.
    expect(save.querySelector('.spin'), 'a drawn indicator is present').toBeTruthy();
    expect(save.textContent!.trim()).toBe('');
  });
});
