// One shape per grid, and the rule for picking it. The old rule took ratios[0], which is an
// arbitrary pick dressed up as an answer: with several shapes enabled the roll genuinely contains a
// mixture, and on the demo — which enables everything — that first entry is 'full', which is not a
// ratio at all.
import { describe, it, expect } from 'vitest';
import { tileAspect } from './ui';

describe('the shape every tile in a grid is drawn at', () => {
  it('uses the event shape when the host enabled exactly one', () => {
    // The tiles then match the photos exactly and nothing is cropped.
    expect(tileAspect(['1:1'])).toBe(1);
    expect(tileAspect(['4:3'])).toBeCloseTo(4 / 3);
    expect(tileAspect(['9:16'])).toBeCloseTo(9 / 16);
    expect(tileAspect(['4:5'])).toBeCloseTo(0.8);
  });

  it('commits to a square when the roll is a mixture', () => {
    // Nothing is lost by cropping: a grid is an index, and the lightbox shows the whole photo.
    expect(tileAspect(['1:1', '4:3'])).toBe(1);
    expect(tileAspect(['9:16', '4:5', '3:4'])).toBe(1);
  });

  it("treats 'full' as no shape at all, because that is what it means", () => {
    // 'full' is "don't crop" — it describes the sensor, not a shape we could draw a tile at.
    expect(tileAspect(['full'])).toBe(1);
    // …and it must not count towards "exactly one shape", or the demo's list would pick 9:16.
    expect(tileAspect(['full', '9:16'])).toBeCloseTo(9 / 16);
    expect(tileAspect(['full', '9:16', '4:5', '3:4', '1:1'])).toBe(1);
  });

  it('falls back to a square rather than dividing by nonsense', () => {
    expect(tileAspect(null)).toBe(1);
    expect(tileAspect(undefined)).toBe(1);
    expect(tileAspect([])).toBe(1);
    expect(tileAspect(['nonsense'])).toBe(1);
    expect(tileAspect(['0:0'])).toBe(1);
    expect(tileAspect(['4:0'])).toBe(1);
  });

  it('never returns something a CSS aspect-ratio cannot use', () => {
    for (const r of [null, [], ['full'], ['0:0'], ['x'], ['1:1', '16:9'], ['3:4']]) {
      const v = tileAspect(r as string[] | null);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });
});
