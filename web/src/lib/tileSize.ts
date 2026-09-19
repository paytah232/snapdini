/** How big the cards are, as a viewing preference rather than a setting.
 *
 *  It is per DEVICE and per person, not per event: the right size depends on the screen in your
 *  hand and how you are using the gallery at that moment — skimming two hundred shots, or looking
 *  properly at a dozen. So it lives in localStorage and never reaches the server.
 *
 *  The grid's own rules live in PhotoCard.svelte; all a page does is set these two variables on the
 *  `.pgrid` element. `cols` is the phone case, said outright — see the note there for why a bare
 *  `minmax()` cannot be trusted to give two columns on a 360px screen.
 */
export type TileSize = 'small' | 'medium' | 'large';

export const TILE_SIZES: { key: TileSize; label: string; min: number; cols: number }[] = [
  { key: 'small',  label: 'Small',  min: 150, cols: 2 },
  { key: 'medium', label: 'Medium', min: 230, cols: 2 },
  // One-up on a phone at this size, which is the point of it: the picture gets the whole screen.
  { key: 'large',  label: 'Large',  min: 340, cols: 1 },
];

export const DEFAULT_TILE_SIZE: TileSize = 'small';

const spec = (size: TileSize) =>
  TILE_SIZES.find((t) => t.key === size) ?? TILE_SIZES[0];

/** The inline style a page puts on its `.pgrid`. */
export function tileVars(size: TileSize): string {
  const t = spec(size);
  return `--tile-min:${t.min}px;--tile-cols:${t.cols}`;
}

const KEY = 'snapdini.tileSize';

/** Never throws and never returns junk: private mode can refuse storage outright, and a value left
 *  by an older build must not be able to produce a grid with no columns. */
export function loadTileSize(): TileSize {
  try {
    const v = localStorage.getItem(KEY);
    if (v && TILE_SIZES.some((t) => t.key === v)) return v as TileSize;
  } catch { /* private mode, or blocked site data */ }
  return DEFAULT_TILE_SIZE;
}

export function saveTileSize(size: TileSize): void {
  try { localStorage.setItem(KEY, size); } catch { /* the choice still holds for this session */ }
}

/** Where the grid stops being a fixed column count and starts fitting what it can.
 *  Mirrors the media query in PhotoCard.svelte — change one and change the other. */
export const GRID_FLUID_FROM = 560;

/** The stops worth offering at this width.
 *
 *  Below GRID_FLUID_FROM the grid is `repeat(var(--tile-cols), …)`, so `min` does nothing at all
 *  and Small and Medium draw the identical two-up grid. Offering both is offering a control that
 *  does nothing when pressed — and a control that does nothing is what looks broken, not the
 *  layout. Where two stops collapse, the WIDER one survives: it is the one that still means
 *  something the moment the phone is turned or the gallery is opened on a laptop.
 */
export function sizesFor(viewportWidth: number): TileSize[] {
  if (viewportWidth >= GRID_FLUID_FROM) return TILE_SIZES.map((t) => t.key);
  // Keyed by what the grid actually draws. Later entries overwrite earlier ones, and TILE_SIZES is
  // ordered small → large, so the survivor of a tie is the larger.
  const byCols = new Map<number, TileSize>();
  for (const t of TILE_SIZES) byCols.set(t.cols, t.key);
  return [...byCols.values()];
}

/** Which offered stop a saved preference is actually rendering as, so the control can mark the
 *  right segment when the saved one is not on offer here. A phone holding 'small' is looking at
 *  the same grid 'medium' would give it, so 'medium' is the honest thing to light up. */
export function effectiveSize(size: TileSize, viewportWidth: number): TileSize {
  const offered = sizesFor(viewportWidth);
  if (offered.includes(size)) return size;
  const cols = spec(size).cols;
  return offered.find((k) => spec(k).cols === cols) ?? offered[0];
}
