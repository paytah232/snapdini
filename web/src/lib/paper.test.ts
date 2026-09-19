import { describe, it, expect } from 'vitest';
import {
  PAPER_SIZES, PAPER_MM, exportWidthPx, effectiveDpi, readPaperSize,
  MAX_EXPORT_PX, MAX_EXPORT_EDGE, PRINT_DPI, pdfFormat,
} from './paper';

// The poster's design space, and the reason one design serves every size.
const RATIO = 1527 / 1080;

describe('paper sizes', () => {
  it('are all the same shape, which is why the design never changes between them', () => {
    for (const s of PAPER_SIZES) {
      const r = PAPER_MM[s].h / PAPER_MM[s].w;
      expect(Math.abs(r - Math.SQRT2)).toBeLessThan(0.01);
    }
    expect(Math.abs(RATIO - Math.SQRT2)).toBeLessThan(0.01);
  });

  it('each step up doubles the area', () => {
    for (let i = 1; i < PAPER_SIZES.length; i++) {
      const small = PAPER_MM[PAPER_SIZES[i - 1]], big = PAPER_MM[PAPER_SIZES[i]];
      expect((big.w * big.h) / (small.w * small.h)).toBeCloseTo(2, 1);
    }
  });
});

describe('how many pixels an export needs', () => {
  it('never exceeds the canvas ceilings — an oversized canvas comes back BLANK on iOS', () => {
    for (const s of PAPER_SIZES) {
      const w = exportWidthPx(s, RATIO);
      expect(w).toBeLessThanOrEqual(MAX_EXPORT_EDGE);
      expect(w * w * RATIO).toBeLessThanOrEqual(MAX_EXPORT_PX + 1);
    }
  });

  it('clears the old 131dpi A4 export at every size, which is the bar', () => {
    for (const s of PAPER_SIZES) {
      expect(effectiveDpi(s, exportWidthPx(s, RATIO)), s).toBeGreaterThan(150);
    }
  });

  it('gives the small sizes the full 300dpi they ask for — no cap binds there', () => {
    for (const s of ['A6', 'A5', 'A4'] as const) {
      expect(effectiveDpi(s, exportWidthPx(s, RATIO))).toBe(PRINT_DPI);
    }
  });

  it('is monotonic: bigger paper never asks for fewer pixels', () => {
    const widths = PAPER_SIZES.map((s) => exportWidthPx(s, RATIO));
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
  });
});

describe('reading a stored size', () => {
  it('takes a known size and falls back for anything else', () => {
    expect(readPaperSize('A3')).toBe('A3');
    expect(readPaperSize('A9')).toBe('A4');
    expect(readPaperSize(undefined)).toBe('A4');
    expect(readPaperSize({ size: 'A3' })).toBe('A4');
  });
  it('hands jsPDF and @page the lower-case name they expect', () => {
    expect(pdfFormat('A3')).toBe('a3');
  });
});
