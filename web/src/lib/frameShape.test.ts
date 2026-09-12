// The crop geometry is shared by two paths that crop in different places — a canvas for photos, the
// camera itself for clips — so these tests are about the two agreeing, and about the one rule that
// keeps the viewfinder honest: a shape counts as delivered only when the frame says so.
import { describe, it, expect } from 'vitest';
import { aspectValue, cropRect, shapeDelivered, SHAPE_TOLERANCE } from './frameShape';

describe('reading a shape', () => {
  it('turns the shapes a host can enable into ratios', () => {
    expect(aspectValue('1:1')).toBe(1);
    expect(aspectValue('4:5')).toBe(0.8);
    expect(aspectValue('3:4')).toBe(0.75);
    expect(aspectValue('9:16')).toBeCloseTo(0.5625, 6);
  });

  it("treats 'full' as no shape at all, not as some ratio", () => {
    // The distinction is load-bearing: 'full' must never be compared against a frame, because
    // there is nothing it could fail to match.
    expect(aspectValue('full')).toBeNull();
  });
});

describe('cropping a frame to a shape', () => {
  it('takes the sides off a frame wider than the shape', () => {
    expect(cropRect(1920, 1080, 1)).toEqual({ sx: 420, sy: 0, sw: 1080, sh: 1080 });
  });

  it('takes top and bottom off a frame taller than the shape', () => {
    expect(cropRect(1080, 1920, 1)).toEqual({ sx: 0, sy: 420, sw: 1080, sh: 1080 });
  });

  it('centres the crop, so nothing is shaved off one side only', () => {
    const r = cropRect(1920, 1080, 9 / 16);
    expect(r.sx).toBeCloseTo(1920 / 2 - r.sw / 2, 6);
    expect(r.sy).toBe(0);
    expect(r.sw / r.sh).toBeCloseTo(9 / 16, 6);
  });

  it("keeps the whole frame for 'full'", () => {
    expect(cropRect(1920, 1080, aspectValue('full'))).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 });
  });

  it('never asks for pixels outside the frame', () => {
    for (const [vw, vh] of [[1920, 1080], [1080, 1920], [3840, 2160], [1440, 1440]]) {
      for (const a of ['1:1', '4:5', '3:4', '9:16']) {
        const r = cropRect(vw, vh, aspectValue(a));
        expect(r.sx).toBeGreaterThanOrEqual(0);
        expect(r.sy).toBeGreaterThanOrEqual(0);
        expect(r.sx + r.sw).toBeLessThanOrEqual(vw + 1e-9);
        expect(r.sy + r.sh).toBeLessThanOrEqual(vh + 1e-9);
      }
    }
  });
});

describe('deciding whether the camera really delivered the shape', () => {
  it('accepts the exact sizes a camera actually returns', () => {
    // Measured off a live track: a 1920×1080 stream asked for these shapes came back at exactly
    // these sizes. 9:16 is the awkward one — 607.5px does not exist, so the camera rounds to 608.
    expect(shapeDelivered(1080, 1080, aspectValue('1:1'))).toBe(true);
    expect(shapeDelivered(864, 1080, aspectValue('4:5'))).toBe(true);
    expect(shapeDelivered(608, 1080, aspectValue('9:16'))).toBe(true);
    expect(608 / 1080).not.toBe(9 / 16);   // …and it is genuinely not the exact ratio
  });

  it('rejects a camera that ignored the ask and handed back the full frame', () => {
    // The case the whole mechanism exists for: the constraint resolved without error and nothing
    // was cropped. Framing the viewfinder here is the original bug.
    expect(shapeDelivered(1920, 1080, aspectValue('1:1'))).toBe(false);
    expect(shapeDelivered(1920, 1080, aspectValue('9:16'))).toBe(false);
  });

  it('rejects a near miss that is still the wrong shape', () => {
    expect(shapeDelivered(1080, 1350, aspectValue('1:1'))).toBe(false);   // 4:5 sent when 1:1 was asked
    expect(shapeDelivered(1080, 1440, aspectValue('4:5'))).toBe(false);   // 3:4 sent when 4:5 was asked
  });

  it('holds the tolerance to rounding, not to a different shape', () => {
    const r = aspectValue('1:1')!;
    expect(shapeDelivered(1000, Math.round(1000 * (1 + SHAPE_TOLERANCE / 2)), r)).toBe(true);
    expect(shapeDelivered(1000, Math.round(1000 * (1 + SHAPE_TOLERANCE * 2)), r)).toBe(false);
  });

  it("never counts 'full' as a delivered shape", () => {
    // Nothing was asked for, so nothing can have been delivered — and there is no shape to frame.
    expect(shapeDelivered(1920, 1080, aspectValue('full'))).toBe(false);
  });

  it('treats an unreadable frame as not delivered', () => {
    // A track that has not produced a frame yet reports no size. Assuming success there would
    // frame the viewfinder before a single cropped frame had arrived.
    expect(shapeDelivered(undefined, undefined, 1)).toBe(false);
    expect(shapeDelivered(0, 0, 1)).toBe(false);
  });
});
