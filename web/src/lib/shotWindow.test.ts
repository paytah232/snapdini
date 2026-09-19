import { describe, it, expect } from 'vitest';
import { shotWindowStart } from './shotWindow';

// The shipped ladder: 12 24 36 48 60 72, three at a time.
const LEN = 6, SIZE = 3;
/** Opening the step: the window comes to whatever is already chosen. */
const open = (sel: number) => shotWindowStart(LEN, sel, 0, SIZE);
/** Pressing a step button: no pull, just a clamp. */
const step = (want: number) => shotWindowStart(LEN, -1, want, SIZE);

describe('the shots window', () => {
  it('opens on the included rung when nothing bigger is chosen', () => {
    expect(open(0)).toBe(0);                // 12 selected → 12/24/36
  });

  it('opens where the host left it', () => {
    expect(open(5)).toBe(3);                // 72 selected → 48/60/72
    // The MINIMUM move that brings it on screen, not a jump to the end of the ladder: 60 arrives at
    // the right-hand edge and the two rungs below it stay in view, which is where a host comparing
    // 48 and 60 wants to be.
    expect(open(4)).toBe(2);                // 60 selected → 36/48/60
    expect(open(2)).toBe(0);                // 36 already visible from the bottom
  });

  // The failure this rule was rewritten for. Pulling the window back to the selection on EVERY
  // recomputation made "go bigger" inert: 12 is selected, the button asks for rung 1, and the pull
  // drags it straight back to 0. Nothing moves, and 48/60/72 cannot be reached at all.
  it('steps up even while the smallest rung is the chosen one', () => {
    expect(step(1)).toBe(1);                // 24/36/48
    expect(step(2)).toBe(2);                // 36/48/60
    expect(step(3)).toBe(3);                // 48/60/72
  });

  it('stops at both ends rather than running off them', () => {
    expect(step(9)).toBe(3);
    expect(step(-4)).toBe(0);
  });

  it('copes with a ladder shorter than the window', () => {
    expect(shotWindowStart(2, 1, 5, SIZE)).toBe(0);
    expect(shotWindowStart(0, -1, 2, SIZE)).toBe(0);
  });
});
