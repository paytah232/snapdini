import { describe, it, expect } from 'vitest';
import { carouselStep, wrapReal } from './carousel';

const N = 4;                 // four real posters
const LAST = N + 1;          // the trailing clone
const onTrack = (p: number) => p >= 0 && p <= LAST;

describe('the carousel cannot be clicked off the end of its own track', () => {
  // THE REPORTED BUG. Every press before the previous transition lands means the seam handler —
  // which only runs on transitionend, and only corrects at exactly 0 or LAST — never gets to fire.
  // The old code added to the position regardless, so the track walked to LAST+1, LAST+2 … where
  // there is no slide, and stayed there. On screen: black, no image, for good.
  it('spam-pressing next never leaves the track', () => {
    let pos = 1;
    const seen: number[] = [];
    for (let i = 0; i < 50; i++) {           // 50 presses, seam handler never runs
      pos = carouselStep(pos, 1, N).pos;
      seen.push(pos);
      expect(onTrack(pos), `press ${i + 1} left the track at ${pos}`).toBe(true);
    }
    // And it is still moving — a guard that just pinned the position would "pass" while the
    // carousel sat frozen on one slide.
    expect(new Set(seen).size).toBeGreaterThan(1);
  });

  it('spam-pressing prev never leaves the track', () => {
    let pos = 1;
    for (let i = 0; i < 50; i++) {
      pos = carouselStep(pos, -1, N).pos;
      expect(onTrack(pos), `press ${i + 1} left the track at ${pos}`).toBe(true);
    }
  });

  it('a step that stays on the track still animates, and lands where you expect', () => {
    expect(carouselStep(1, 1, N)).toEqual({ pos: 2, animate: true });
    expect(carouselStep(2, -1, N)).toEqual({ pos: 1, animate: true });
    // Stepping ONTO a clone is normal and must animate — that is how the seam works at all.
    expect(carouselStep(N, 1, N)).toEqual({ pos: LAST, animate: true });
    expect(carouselStep(1, -1, N)).toEqual({ pos: 0, animate: true });
  });

  it('a step that would leave the track wraps to the right real slide instead', () => {
    // Sitting on the trailing clone (showing poster 1) and pressed again: the next poster is 2.
    expect(carouselStep(LAST, 1, N)).toEqual({ pos: 2, animate: false });
    // Sitting on the leading clone (showing poster N) and pressed back: the previous is N-1.
    expect(carouselStep(0, -1, N)).toEqual({ pos: N - 1, animate: false });
  });

  it('wrapReal stays within the real slides for any number of steps, either way', () => {
    for (let d = -20; d <= 20; d++) {
      for (let start = 1; start <= N; start++) {
        const p = wrapReal(start, d, N);
        expect(p >= 1 && p <= N, `wrapReal(${start}, ${d}) = ${p}`).toBe(true);
      }
    }
  });
});
