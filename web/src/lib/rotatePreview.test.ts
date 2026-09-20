// The preview a rotation gets before anybody commits to it.
//
// Two lines of arithmetic, and the reason they are worth a test file is that BOTH ways of getting
// them wrong are silent. Forget the scale and a quarter-turned landscape photo hangs out of the box
// it was given and — a transform having made its own stacking context — paints over the buttons
// beneath it, which is the fault the host reported as the photo "appearing above the rest of the
// page". Apply the scale to a HALF turn and every 180° preview shrinks for no reason at all, which
// nobody reports because it merely looks a bit wrong.
import { describe, it, expect } from 'vitest';
import { fitScaleFor, previewTransform } from './rotatePreview';

describe('how far a quarter-turned picture has to shrink', () => {
  it('is the short side over the long one, whichever way round they are', () => {
    // Landscape 3:2 and portrait 2:3 are the same problem seen from either end, and they need the
    // same answer — the turned box is the original box with its sides swapped.
    expect(fitScaleFor(300, 200)).toBeCloseTo(2 / 3);
    expect(fitScaleFor(200, 300)).toBeCloseTo(2 / 3);
    // A square loses nothing: turned, it is the same shape it was.
    expect(fitScaleFor(400, 400)).toBe(1);
  });

  it('is 1 while there is nothing to measure', () => {
    // An image that has not loaded has no box. Guessing is worse than leaving the picture where it
    // is until `load` fires and asks again — and a zero would divide the photo out of existence.
    expect(fitScaleFor(0, 0)).toBe(1);
    expect(fitScaleFor(300, 0)).toBe(1);
    expect(fitScaleFor(0, 200)).toBe(1);
  });
});

describe('the transform a pending turn is previewed with', () => {
  it('is nothing at all at rest', () => {
    // `none` rather than null or '': the call sites bind this straight to style:transform, and a
    // helper that sometimes returns a string and sometimes does not pushes that decision back out
    // to both of them.
    expect(previewTransform(0)).toBe('none');
    expect(previewTransform(0, 0.5)).toBe('none');
  });

  it('rotates and fits, on a quarter turn either way', () => {
    expect(previewTransform(90, 0.5)).toBe('rotate(90deg) scale(0.5)');
    expect(previewTransform(-90, 0.5)).toBe('rotate(-90deg) scale(0.5)');
  });

  it('does NOT fit a half turn — the box is the same shape', () => {
    expect(previewTransform(180, 0.5)).toBe('rotate(180deg)');
  });
});
