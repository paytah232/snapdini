// What size paper a design is printed on, and how many pixels that needs.
//
// Every ISO A size has the same 1:√2 proportions, and the poster's design space (1080×1527) is that
// ratio to within 0.02%. So a design does not change at all between A6 and A2 — only the number of
// pixels it is rasterised to on the way out. That is the whole reason this file is small.

export const PAPER_SIZES = ['A6', 'A5', 'A4', 'A3', 'A2'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

/** Short edge × long edge, in millimetres. */
export const PAPER_MM: Record<PaperSize, { w: number; h: number }> = {
  A6: { w: 105, h: 148 },
  A5: { w: 148, h: 210 },
  A4: { w: 210, h: 297 },
  A3: { w: 297, h: 420 },
  A2: { w: 420, h: 594 },
};

export const DEFAULT_PAPER: PaperSize = 'A4';

/** What a home printer resolves. Asking for more than this puts pixels on paper that no consumer
 *  printer can lay down, at four bytes each. */
export const PRINT_DPI = 300;

/** Canvas ceilings, not quality ones.
 *
 *  A2 at 300dpi is 4961×7016 — 35 megapixels, ~139MB of backing store. Safari on iOS refuses a
 *  canvas over roughly 16.7 megapixels outright and returns a BLANK one, which would turn "export
 *  an A2" into a silently empty PDF on every iPhone. So the area is capped below that line, and the
 *  width capped too for the engines that limit a single dimension.
 *
 *  What the cap actually costs: at the 16MP ceiling an A2 still resolves ~203dpi, A3 ~288 and A4
 *  ~407. The floor across every size is therefore well above the ~131dpi the old export produced at
 *  A4, which is the bar this had to clear. */
export const MAX_EXPORT_PX = 16_000_000;
export const MAX_EXPORT_EDGE = 4096;

const MM_PER_INCH = 25.4;

/** The pixel width to rasterise `size` at, honouring both caps. Height follows the design's own
 *  ratio, so this is the only number a caller needs. */
export function exportWidthPx(size: PaperSize, pageRatio: number, dpi = PRINT_DPI): number {
  const wanted = Math.round((PAPER_MM[size].w / MM_PER_INCH) * dpi);
  const byArea = Math.floor(Math.sqrt(MAX_EXPORT_PX / pageRatio));
  return Math.max(1, Math.min(wanted, byArea, MAX_EXPORT_EDGE));
}

/** What that width actually resolves to on the paper — the honest number, after the caps. */
export function effectiveDpi(size: PaperSize, widthPx: number): number {
  return Math.round(widthPx / (PAPER_MM[size].w / MM_PER_INCH));
}

/** jsPDF and `@page` both take the size by name, in lower case. */
export const pdfFormat = (size: PaperSize): string => size.toLowerCase();

export const readPaperSize = (raw: unknown): PaperSize =>
  (PAPER_SIZES as readonly string[]).includes(String(raw)) ? (raw as PaperSize) : DEFAULT_PAPER;
