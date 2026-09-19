import { describe, it, expect } from 'vitest';
import { sizesFor, effectiveSize, GRID_FLUID_FROM, TILE_SIZES } from './tileSize';

describe('tile size stops', () => {
  it('offers every stop once the grid fits what it can', () => {
    expect(sizesFor(GRID_FLUID_FROM)).toEqual(['small', 'medium', 'large']);
    expect(sizesFor(1440)).toEqual(['small', 'medium', 'large']);
  });

  it('drops the stop that draws the same grid on a phone', () => {
    // Below the breakpoint only `cols` applies, and small/medium share it — so one has to go.
    expect(sizesFor(390)).toEqual(['medium', 'large']);
    expect(sizesFor(GRID_FLUID_FROM - 1)).toEqual(['medium', 'large']);
  });

  it('keeps the wider of two stops that collapse', () => {
    const kept = sizesFor(390);
    const dropped = TILE_SIZES.filter((t) => !kept.includes(t.key)).map((t) => t.key);
    expect(dropped).toEqual(['small']);
  });

  it('lights up the stop actually being rendered', () => {
    // A phone holding 'small' is looking at exactly the grid 'medium' would give it.
    expect(effectiveSize('small', 390)).toBe('medium');
    expect(effectiveSize('large', 390)).toBe('large');
    // Above the breakpoint the saved value is always on offer, so it is its own answer.
    expect(effectiveSize('small', 900)).toBe('small');
  });

  it('never answers with a stop it would not offer', () => {
    for (const w of [320, 390, 559, 560, 1024]) {
      for (const t of TILE_SIZES) expect(sizesFor(w)).toContain(effectiveSize(t.key, w));
    }
  });
});
