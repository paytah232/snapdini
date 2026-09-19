// ── Poster rendering ─────────────────────────────────────────────────────────
// The poster's drawing code, lifted out of PosterModal.svelte so there is exactly ONE implementation
// behind both the designer's live preview and the design wizard's preset thumbnails. A thumbnail
// painted by a second copy of this would drift from the designer, and a gallery that drifts is
// lying to the host about what they are going to get.
//
// Everything here is pure: no Svelte, no component state, no module-level mutable state. A call
// touches only the ctx it was handed and the opts it was given, so any number of designs can be
// rendered onto different canvases at the same time without interfering.
//
// Deliberately NOT here: the trick-card / sheet rendering, which is a second coordinate space; and
// the designer's two side effects — sampling the background image for the swatch strip, and
// clearing the "building poster" spinner. drawPoster hands the loaded background back instead, so
// the caller can do those itself.

/** x/y are the element CENTRE as a fraction of its space (0–1); `size` is px in the 1080-wide
 *  canvas space (font size for text; the QR square's width for `qr`). */
import { drawDecor, drawDecorAt, decorReach, DECOR_KINDS, type DecorKind, type DecorPos, type DecorPlacement } from './cardDecor';
import {
  applyFace, castFor, clearTracking, ensurePosterFonts, titleFaceOf, typeSet,
  type Face, type TitleFace, type TypeSetKey,
} from './posterFonts';

/** `rot` turns the element about its own anchor, in RADIANS, and it is OPTIONAL: absent means
 *  upright, which is what every design saved before it existed carries — and absent has to stay
 *  absent rather than becoming `rot: 0`, because the cfg blob is what undo compares and what is
 *  saved (the same rule readTextItem() keeps for a line's colour).
 *
 *  Radians, not degrees, and `rot`, not `angle`: the placed decorations have stored exactly this
 *  since they were added (cardDecor's DecorPlacement), and one vocabulary for "how far round is it"
 *  beats two. The degrees a host sees are a presentation of this, made at the control. */
export type Box = { x: number; y: number; size: number; rot?: number };
// The coordinate space a Box's x/y fractions are measured against. The poster is the whole page;
// a card is a rect inside the sheet — same helpers, same drag code, two spaces.
export type Space = { w: number; h: number; ox: number; oy: number };

export const PAGE_W = 1080, PAGE_H = 1527;                 // A4 portrait
export const PAGE: Space = { w: PAGE_W, h: PAGE_H, ox: 0, oy: 0 };

// ── Free layout: every element is independently draggable + resizable, so the organizer can
// place text off faces. ──
export type PosterElKey = 'brand' | 'title' | 'message' | 'steps' | 'qr' | 'footer' | 'names';
export type PosterLayout = Record<PosterElKey, Box>;
/** What the QR panel prints under the code: the join URL, the 8-char join code, or nothing. */
/** Where every poster element starts before anyone drags it.
 *
 *  Lives here rather than in the editor because it is part of what a poster IS, not of how one is
 *  edited — the preset gallery has to lay a poster out without opening the editor at all. */
export const DEFAULT_POSTER_LAYOUT: PosterLayout = {
  // The 🎩 Snapdini mark sits at the FOOT, on the footer line, and slides left/right along it.
  //
  // It used to run across the top centre, which is the one band a poster cannot spare: a `top`
  // decoration draws at the page centre too, and a border's top edge runs through the same strip.
  // Rather than let the two collide, drawPoster used to hand positional motifs a rect that started
  // BELOW the mark — so switching our wordmark on visibly pushed the host's own decoration down the
  // page and away from the edge it was drawn to touch. We were charging the host's design for our
  // credit line.
  //
  // At the foot it reads as an imprint, which is what it is, and it is out of the way of everything
  // that wants the top: `top` motifs, the frame, and the wavy border all reach the paper's edge
  // again. Set at the footer URL's own size and on its line, so the two read as one printed
  // footer rather than as a heading that slid down. x is left of centre so a centred join URL sits
  // beside it rather than under it.
  //
  // Changing this default does NOT move any poster already saved: a stored design carries its own
  // `layout.brand`, and restore() spreads the saved layout OVER these defaults. See the corridor in
  // drawPoster, which keys off where the mark actually is rather than off this constant, so a design
  // saved with the mark still at the top keeps the clearance it was laid out with.
  brand:   { x: 0.185, y: 0.94, size: 26 },
  // Low enough that adding the small caps line above it does not push that line into a `top`
  // decoration — the headline block is centred on this point and grows in BOTH directions.
  title:   { x: 0.5, y: 0.225, size: 72 },
  message: { x: 0.5, y: 0.295, size: 32 },
  qr:      { x: 0.5, y: 0.585, size: 480 },
  // The foot of the page in order, and the order matters — these were pitched by eye and the first
  // render put the name lockup straight through the join URL inside the QR panel. The panel is
  // `size + 195` tall when anything prints under the code, so its bottom edge sits near 0.806, not
  // near the 0.742 the QR box on its own suggests. Everything below is measured from there.
  names:   { x: 0.5, y: 0.845, size: 34 },   // empty by default, so it collides with nothing
  steps:   { x: 0.5, y: 0.900, size: 30 },
  // 0.972 put the link about 42px from the paper's edge, which is INSIDE every border motif we
  // draw — the frame has been printing through the join URL since it was added, and the new wavy
  // border made it obvious. A border sits ~65px in, so the link has to finish above that.
  footer:  { x: 0.5, y: 0.940, size: 26 },
};

export const clonePosterLayout = (l: PosterLayout): PosterLayout =>
  ({ brand: { ...l.brand }, title: { ...l.title }, message: { ...l.message },
     steps: { ...l.steps }, qr: { ...l.qr }, footer: { ...l.footer }, names: { ...l.names } });

/** ONE box, out of a stored blob, clamped to something drawable.
 *
 *  This is the clamp readCardSets() has always had, lifted to where the Box type lives so the
 *  poster's layout, the cards' layout and the per-card overrides are all validated by the SAME
 *  code. The poster's own layout was the one reader that spread the blob raw, and a poster design
 *  is stored server-side and restored on every open, so a bad value is permanent for that event:
 *    · `{"footer":{"size":1e9}}` reaches fitted(), which walks `size -= 2` from a billion with a
 *      measureText on every step — the tab stops responding. Infinity never terminates at all.
 *    · `{"qr":null}` reaches `layout.qr.size` inside a reactive block, which throws outside any
 *      catch, so the designer fails on mount and the host cannot open their own poster again.
 *  Both are organizer-scoped, and neither has a way back out without a database edit.
 *
 *  A BAD FIELD FALLS BACK TO THE DEFAULT rather than dropping the element, matching the readers
 *  next to it: losing where the title sits beats refusing to open the design.
 *
 *  `rot` is carried through and ABSENT STAYS ABSENT — upright is what every design saved before
 *  rotation existed carries, and the cfg blob is what undo compares and what is saved, so writing
 *  `rot: 0` onto an untouched element would make an open-and-close look like an edit. Clamped to
 *  one turn either way, the range the placed-decoration reader already uses. */
const clampNum = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
/** px, in the 1080-wide page space. 1 rather than 0 so nothing divides by it; 2000 is wider than
 *  the page, so it bounds the work without bounding what a host can actually want. */
export const BOX_SIZE_MIN = 1, BOX_SIZE_MAX = 2000;
export function readBox(v: unknown, d: Box): Box {
  const b = (v && typeof v === 'object' ? v : {}) as Partial<Box>;
  const out: Box = {
    x: clampNum(b.x, 0, 1, d.x),
    y: clampNum(b.y, 0, 1, d.y),
    size: clampNum(b.size, BOX_SIZE_MIN, BOX_SIZE_MAX, d.size),
  };
  const rot = typeof b.rot === 'number' && Number.isFinite(b.rot)
    ? clampNum(b.rot, -Math.PI, Math.PI, 0)
    : d.rot;
  if (rot !== undefined) out.rot = rot;
  return out;
}

/** A stored poster layout, element by element. Every key is present on the way out, whatever the
 *  blob held — which is what lets `layout.qr.size` be read without a guard. */
export function readPosterLayout(raw: unknown): PosterLayout {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = {} as PosterLayout;
  for (const k of Object.keys(DEFAULT_POSTER_LAYOUT) as PosterElKey[]) out[k] = readBox(o[k], DEFAULT_POSTER_LAYOUT[k]);
  return out;
}

/** One host-added line. `x`/`y` are the CENTRE as a fraction of the page, matching every other
 *  element; `size` is px in the 1080-wide space.
 *
 *  `colour` follows the same shape the placed decorations already use (`it.colour || …`): optional,
 *  per item, falling back to the group's colour — here the message ink. It is per LINE rather than
 *  per group because a single swatch for all of them is a control for a thing that does not exist
 *  yet when it is offered, and behaves like one choice while looking like several. */
export type PosterTextItem = { text: string; x: number; y: number; size: number; colour?: string; rot?: number };

export type PosterCodeDisplay = 'url' | 'code' | 'none';

/** The white panel's footprint — the QR plus its padding plus whatever is printed under it.
 *
 *  Exported because the designer needs the same rectangle for its drag outline, and it used to
 *  carry its own copy of these numbers. Two copies of a geometry is one geometry and one bug
 *  waiting for someone to change the padding in the place they happened to be looking at. */
/** The wordmark, in one place. It is measured in three (the renderer, the designer's drag outline,
 *  and the footer's width) and three copies of a string is two chances to measure one thing and
 *  draw another. */
export const BRAND_TEXT = '🎩 Snapdini';

/** Set the wordmark's font on `ctx` and report how wide the mark comes out.
 *
 *  It was measured in three places — here, the footer's width calculation, and the designer's drag
 *  outline — each with its own copy of the shorthand. Three copies of a font is two chances to
 *  measure one thing and draw another. */
export function brandFont(ctx: CanvasRenderingContext2D, sizePx: number): number {
  ctx.font = `600 ${sizePx}px "Helvetica Neue", Arial, sans-serif`;
  return ctx.measureText(BRAND_TEXT).width;
}

/** The footer join URL's full width, when it has the line to itself. */
export const FOOTER_MAX_W = PAGE_W - 120;

/** How much width the footer URL may actually occupy.
 *
 *  The mark defaults to the SAME line at the foot now, so a long join address centred across the
 *  whole page runs straight through it — seen, not predicted: a custom domain rendered the two on
 *  top of each other. The mark's width is measured rather than assumed, and the URL is given the
 *  paper that is left; drawUrl already knows how to shrink, and to split domain from path, when what
 *  it is given is not enough.
 *
 *  Narrowed ONLY when the two really are on one line. A host who has dragged either of them
 *  elsewhere gets the whole width back, and so does every design saved before the mark moved — its
 *  mark is still up at y=0.07, a page away from the footer. */
export function footerMaxW(ctx: CanvasRenderingContext2D, layout: PosterLayout, showBrand?: boolean): number {
  if (showBrand === false) return FOOTER_MAX_W;
  const b = layout.brand, f = layout.footer;
  // Their ink bands overlapping is what "on the same line" means; a gap bigger than the two type
  // sizes together is two different places on the page.
  if (Math.abs(b.y * PAGE_H - f.y * PAGE_H) > (b.size + f.size) * 0.7) return FOOTER_MAX_W;
  ctx.save();
  const bw = brandFont(ctx, b.size);
  ctx.restore();
  const bx = b.x * PAGE_W, fx = f.x * PAGE_W;
  const GAP = 20;
  // The mark's nearest edge plus a gap. The URL is centred on fx, so it may reach that far in
  // EACH direction — hence the doubling.
  const edge = bx < fx ? bx + bw / 2 + GAP : bx - bw / 2 - GAP;
  // A floor, because a URL squeezed below this is unreadable either way and the honest failure is
  // for the two to be tight rather than for the address to become a smudge.
  return Math.max(260, Math.min(FOOTER_MAX_W, Math.abs(fx - edge) * 2));
}

export function qrPanelRect(box: Box, codeDisplay: PosterCodeDisplay): { x: number; y: number; w: number; h: number } {
  const w = box.size + 90;
  // The code and the URL both print below the QR and both need the taller panel. It is the thing
  // that makes the panel reach much further down the page than its box suggests — which is exactly
  // what the name lockup's default position has to clear.
  const h = box.size + (codeDisplay !== 'none' ? 195 : 90);
  return { x: box.x * PAGE_W - w / 2, y: box.y * PAGE_H - h / 2, w, h };
}

/** The QR IMAGE's own square inside the panel — the picture, not the paper it is mounted on.
 *
 *  THE keep-out rect for anything drawn over the panel, and the reason it is this and not
 *  qrPanelRect: the server generates the code with `{ margin: 4, errorCorrectionLevel: 'H' }`
 *  (app/src/server/routes/events.ts), so the four-module quiet zone ISO 18004 asks for is baked
 *  INTO the PNG and travels with the image. Everything qrPanelRect adds on top of this — 45px above,
 *  45px each side, and the strip under the code where the join code or the URL prints — is
 *  ADDITIONAL margin, not quiet zone. Claiming the whole panel as untouchable would be refusing the
 *  host most of a decoration for a reason that is already paid for.
 *
 *  Exported so drawPoster clips to exactly the rect drawQrPanel draws the image into, rather than a
 *  second copy of the same arithmetic drifting away from it. */
export function qrImageRect(box: Box, codeDisplay: PosterCodeDisplay): { x: number; y: number; w: number; h: number } {
  const p = qrPanelRect(box, codeDisplay);
  return { x: p.x + (p.w - box.size) / 2, y: p.y + 45, w: box.size, h: box.size };
}

/** The same square, rounded OUTWARD to whole pixels — what a clip has to use.
 *
 *  The QR's rect lands on fractional coordinates (its centre is a fraction of the page and its size
 *  is a dragged number), and a clip edge falling mid-pixel is ANTIALIASED: the excluded region only
 *  covers part of that pixel, so ink still reaches the rest of it. Measured in headless Chromium
 *  before this existed — a motif straddling the code's corner put nine pixels of green on the
 *  bottom row of the symbol. A keep-out that keeps out 99% of a pixel is not a keep-out.
 *
 *  Outward rather than nearest: at most one pixel of extra margin is given away, and the thing
 *  being protected is the only part of the poster nobody can fix after it is printed. */
export function qrKeepOut(box: Box, codeDisplay: PosterCodeDisplay): { x: number; y: number; w: number; h: number } {
  const r = qrImageRect(box, codeDisplay);
  const x = Math.floor(r.x), y = Math.floor(r.y);
  return { x, y, w: Math.ceil(r.x + r.w) - x, h: Math.ceil(r.y + r.h) - y };
}
// ── Readable ink ─────────────────────────────────────────────────────────────
// Lives here, with the poster's other colour arithmetic, because BOTH renderers need exactly this
// rule and a second copy of it is a second answer. It used to sit in PosterModal.svelte, which is
// why the card renderer could not be lifted out without either duplicating it or dragging the
// component along.
// ONE rule, used by both outputs. The poster and the card both let a host pick a background and
// pick text colours, and nothing stopped the two colliding: white text on a white background is
// an empty poster, and the near-black join code vanished on a dark card. Rather than overriding
// the host's choice with flat black or white, a colour that would disappear is walked along its
// OWN lightness until it clears a readable contrast — a gold title on white becomes a darker
// gold, not black, so the design still looks like the one they chose.
export const rgbOf = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
// WCAG relative luminance (0–1) — the gamma-corrected one, not the flat 0.299/0.587/0.114
// weighting the designer sorts a palette by, because this is what the contrast ratio is defined
// against.
export const relLum = (hex: string): number => {
  const [r, g, b] = rgbOf(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string): number => {
  const x = relLum(a), y = relLum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const toHex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
/** Blend a colour toward black or white by `t` (0–1) — keeps the hue, moves the lightness. */
const shade = (hex: string, t: number, toWhite: boolean): string => {
  const [r, g, b] = rgbOf(hex), e = toWhite ? 255 : 0;
  return toHex(r + (e - r) * t, g + (e - g) * t, b + (e - b) * t);
};
/**
 * `hex` made readable on `bg`. Returns the colour untouched when it already reads; otherwise the
 * nearest version of itself that clears `min` contrast, darkening on a light background and
 * lightening on a dark one.
 *
 * `min` is per role, not one number: 3.0 is WCAG's bar for large display type (a poster headline,
 * a card title) and 4.5 the bar for body text — and a trick list read in the hand at 21px is body
 * text, so holding it to the headline's bar would leave it printing pale grey.
 */
export const INK_LARGE = 3.0, INK_BODY = 4.5;
export function readableOn(hex: string, bg: string, min = INK_LARGE): string {
  if (!/^#?[0-9a-f]{6}$/i.test((hex || '').trim())) return hex;
  if (contrast(hex, bg) >= min) return hex;
  const toWhite = relLum(bg) < 0.22;              // dark ground → lighten the ink, and vice versa
  // A grey — or a cream, or an off-black — has no hue worth preserving, so "the nearest version of
  // itself" is not worth having: white text on a white card would land on the palest grey that
  // scrapes past the bar. Go to ink. A properly coloured choice (gold, coral, teal) is far above
  // this threshold and keeps its hue.
  const [r, g, b] = rgbOf(hex);
  if (Math.max(r, g, b) - Math.min(r, g, b) < 40) return toWhite ? '#f5f5f5' : '#1a1a1a';
  for (let t = 0.08; t <= 1.0001; t += 0.08) {
    const c = shade(hex, t, toWhite);
    if (contrast(c, bg) >= min) return c;
  }
  return toWhite ? '#ffffff' : '#111111';         // fully blended and still short: go all the way
}
// What a text colour is actually sitting on. An image background is painted then darkened by 55%
// black, so whatever the photo is, the ink lands on something dark — matching what the eye sees
// and what the old cardDark flag assumed.
export const IMAGE_INK_BG = '#2b2b2b';

/** The colours the poster is DRAWN with — already made readable against the ground they land on.
 *  The renderer never second-guesses these; picking them is the designer's job (readableOn). */
/** The poster's colours.
 *
 *  The five required ones are the poster's palette. The three optional ones are exceptions to it:
 *  the small lines bracketing the title and the name lockup are drawn in the TITLE's colour, which
 *  is the right default — they are parts of one piece of typography — but it had been welded, so a
 *  host who wanted the names in a second colour had no way to say so at all.
 *
 *  Absent means "the title's", which is what every design saved before this reads as and why none
 *  of them change. Nothing here is a migration; see inkOf(), the one place the fallback happens. */
export type PosterInk = {
  headline: string; message: string; steps: string; footer: string; code: string;
  /** The small caps line above the title. Absent = the title's own colour. */
  headlineTop?: string;
  /** ...and the one below it. */
  headlineBottom?: string;
  /** The name lockup, hairlines and all. Absent = the title's own colour. */
  names?: string;
};

/** The colour an optional ink resolves to.
 *
 *  ONE function rather than three `??` at three call sites, because the rule it states — "same as
 *  the title unless somebody said otherwise" — is the whole compatibility guarantee, and a fourth
 *  optional ink added later has to inherit it rather than re-derive it. */
export const inkOf = (ink: PosterInk, key: 'headlineTop' | 'headlineBottom' | 'names'): string =>
  ink[key] ?? ink.headline;

export type PosterRenderOpts = {
  // ── Text ──
  headline: string;
  /** Optional small-caps lines bracketing the headline. Every reference sign sets its title as two
   *  or three parts in different faces — "CAPTURE THE" over a script "love" — and that stacking is
   *  most of why they read as designed rather than as typed. Blank = not drawn. */
  headlineTop?: string;
  headlineBottom?: string;
  /** Whose event it is, set as a lockup at the foot — "Rachel and Ross", "Mia & Sam", "The Wus".
   *
   *  Blank = not drawn, which is the default. See drawNames for how a separator in the middle turns
   *  one typed line into the stacked three-row lockup. */
  names?: string;
  /** Does a separator in `names` build the stacked lockup, or is the line set verbatim?
   *
   *  Undefined = true, which is what every design saved before this has and how the lockup has
   *  always behaved. The opt-out exists because "One & Two" is sometimes exactly what the host
   *  wants ON one line — a host who typed a line and got a three-row monogram had no way to say
   *  "no, like that". */
  stackNames?: boolean;
  message: string;                 // blank = not drawn at all
  stepsText: string;               // blank = not drawn at all
  cleanUrl: string;                // the join URL with the scheme stripped
  joinCode: string;                // the 8-char code, printed when codeDisplay === 'code'
  // ── Type ──
  /** Which bundled pairing sets the poster. Undefined = 'plain', so a design saved before this
   *  existed renders exactly as it did. */
  typeSet?: TypeSetKey;
  /** Whether the headline leads with the structural face or the script one. */
  titleFace?: TitleFace;

  // ── What is shown ──
  /** The "🎩 Snapdini" wordmark across the top. Undefined = shown, so nothing changes for a design
   *  saved before this existed.
   *
   *  Turning it off does NOT remove our mark from the poster — the chip stays punched into the
   *  middle of the QR, where it is part of the code rather than a line of someone else's branding
   *  across the top of their wedding sign. That is the honest trade: the host gets a poster that
   *  looks like theirs, and every guest who scans it still sees whose it is. */
  showBrand?: boolean;
  /** Drop the white panel and let the paper show through the code's quiet zone.
   *
   *  Off by default, and it stays a deliberate choice rather than a look: see drawQrPanel for why
   *  the panel exists and `symbolContrast` for the measurement that decides whether omitting it is
   *  safe on THIS poster. */
  qrPanel?: boolean;
  codeDisplay: PosterCodeDisplay;
  showFooterUrl: boolean;
  // ── Where it sits, and in what colour ──
  layout: PosterLayout;
  ink: PosterInk;
  // ── Images ──
  qrSrc: string;                   // data: or http URL of the QR to print
  bgSrc: string | null;            // background image, or null for a plain colour
  plainBg: string;                 // the colour painted when there is no background image
  /** How to turn a src into a decoded image. The designer passes its own cache — a redraw must not
   *  re-decode or the preview flickers mid-drag — and a one-shot caller can leave it out. */
  loadImage?: (src: string) => Promise<HTMLImageElement>;

  /** Line art on the poster, the same vocabulary the trick cards use.
   *
   *  The poster had none — drawDecor was only ever called from the card renderer — so a design
   *  preset could change the paper and the ink and nothing else, and two presets on white paper
   *  came out as the same poster. Decoration is most of what makes one design read as different
   *  from another. */
  decorKind?: DecorKind | '';
  decorPos?: DecorPos;
  decorScale?: number;
  decorColour?: string;

  /** Motifs the host has placed by hand: any number of them, each with its own position, size and
   *  rotation.
   *
   *  When this is present and non-empty it REPLACES the slot-based decoration above, rather than
   *  drawing on top of it — a host who has arranged three sprigs has said where they want them, and
   *  a fourth appearing at the top because `decorPos` still says 'top' is the design fighting them.
   *  Absent or empty means the slot behaviour, unchanged, which is what every design saved before
   *  this existed has. */
  decorItems?: DecorPlacement[];

  /** Lines the host added themselves — a table number, a hashtag, "bar closes at 11".
   *
   *  A list rather than one extra field, for the same reason the decorations are: a poster that
   *  allows exactly one addition is a poster that will need a second one. Each carries its own
   *  position and size, set by dragging, so they need no layout entry of their own. */
  textItems?: PosterTextItem[];
};

export type PosterRenderResult = {
  /** The decoded background image, or null when the poster is a plain colour (or the image failed
   *  to load). Handed back because the designer samples it for the swatch palette — which is not
   *  part of painting a poster, and must not fire when a wizard thumbnail renders. */
  backgroundImage: HTMLImageElement | null;
};

const decode = (src: string): Promise<HTMLImageElement> =>
  new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

export function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number) {
  const s = Math.max(w / img.width, h / img.height); const dw = img.width * s, dh = img.height * s;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

// ── Turning things ───────────────────────────────────────────────────────────
// The placed decorations have rotated since they were added: `rot`, in radians, applied by
// drawDecorAt as translate → rotate → draw. These two extend that ONE vocabulary to the text, which
// is all the poster's other elements are. There is deliberately no second scheme and no degrees.

/** Paint with the canvas turned by `rot` about (cx, cy).
 *
 *  translate → rotate → translate back, so everything inside still draws in PAGE coordinates and no
 *  draw site has to be rewritten to work relative to its own anchor — which is what keeps the
 *  measuring path and the drawing path the same code as before.
 *
 *  `rot` absent or 0 costs one branch and paints exactly what it painted before. That is not an
 *  optimisation: an upright design must come out byte-identical, and the surest way to guarantee
 *  that is for it to run the same instructions. */
export function rotated(ctx: CanvasRenderingContext2D, cx: number, cy: number, rot: number | undefined, paint: () => void): void {
  if (!rot) { paint(); return; }
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(rot); ctx.translate(-cx, -cy);
  paint();
  ctx.restore();
}

/** The axis-aligned box a rect occupies once it is turned by `rot` about (ax, ay).
 *
 *  THE renderer's answer to "and where is it now". Exported for exactly the reason
 *  measureTitleBlock() and measureFooterUrl() are: the designer's hit-test and its selection
 *  outline must not keep a second guess at geometry the renderer owns. That class of bug has been
 *  found four times in PosterModal.svelte — the last one left an outline 221px narrower than its
 *  own text — and a rotation derived in the component would be the fifth.
 *
 *  An axis-aligned hull rather than the turned quad, deliberately: the drag code speaks in rects
 *  (its snapping lines, its print-margin clamp, the element's own `left/top/width/height` box), a
 *  hull is honest about what it is — the rect the element is inside — and the alternative is a
 *  second geometry for every one of those to learn. */
export function rotatedRect(
  r: { x: number; y: number; w: number; h: number },
  rot: number | undefined,
  ax: number, ay: number,
): { x: number; y: number; w: number; h: number } {
  if (!rot) return r;
  const c = Math.cos(rot), s = Math.sin(rot);
  const xs: number[] = [], ys: number[] = [];
  for (const [px, py] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
    const dx = px - ax, dy = py - ay;
    xs.push(ax + dx * c - dy * s);
    ys.push(ay + dx * s + dy * c);
  }
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

/** Shrink the font until `text` fits `maxW`, and report what that came to: the width the glyphs
 *  really occupy and the size they ended up set at. Leaves that font applied.
 *
 *  Split out of fitText so an outline can ask the same question the ink answers. Anything that
 *  re-derived "and how wide did that end up" would be a second guess at glyph geometry, and this
 *  file has been bitten by one of those already — see measureUrlBlock. */
function fitted(ctx: CanvasRenderingContext2D, text: string, maxW: number, weight: number, sizePx: number, family: string): { w: number; px: number } {
  let size = sizePx;
  ctx.font = `${weight} ${size}px ${family}`;
  while (size > 14 && ctx.measureText(text).width > maxW) { size -= 2; ctx.font = `${weight} ${size}px ${family}`; }
  return { w: ctx.measureText(text).width, px: size };
}

// Draw a single line, shrinking the font until it fits maxW — keeps long join URLs from
// spilling past the QR panel / page edge (no clean place to wrap a URL).
export function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, weight: number, sizePx: number, family: string): void {
  fitted(ctx, text, maxW, weight, sizePx, family);
  ctx.fillText(text, x, y);
}

// Draw a URL, splitting a long one onto two lines — domain on top, the /path below — rather
// than shrinking it to nothing. Each line still fits-to-width as a safety net.
export function drawUrl(ctx: CanvasRenderingContext2D, url: string, x: number, y: number, maxW: number, weight: number, sizePx: number, family: string, lineH: number): void {
  ctx.font = `${weight} ${sizePx}px ${family}`;
  if (ctx.measureText(url).width <= maxW) { ctx.fillText(url, x, y); return; }
  const i = url.indexOf('/');
  const domain = i === -1 ? url : url.slice(0, i);
  const path = i === -1 ? '' : url.slice(i);
  fitText(ctx, domain, x, y, maxW, weight, sizePx, family);
  if (path) fitText(ctx, path, x, y + lineH, maxW, weight, Math.round(sizePx * 0.82), family);
}

/** How the footer join URL is set. One place, because drawPoster draws it and the designer's drag
 *  outline has to measure the same thing. */
export const FOOTER_FONT = { weight: 400, family: 'ui-monospace, Menlo, Consolas, monospace', lineHeight: 1.25 } as const;

/** The footer URL's footprint, exactly as drawPoster sets it — including the width the mark leaves
 *  it when the two share the footer line. */
export function measureFooterUrl(ctx: CanvasRenderingContext2D, url: string, layout: PosterLayout, showBrand?: boolean): { w: number; h: number } {
  const size = layout.footer.size;
  return measureUrlBlock(ctx, url, footerMaxW(ctx, layout, showBrand), FOOTER_FONT.weight, size, FOOTER_FONT.family, size * FOOTER_FONT.lineHeight);
}

/** The footprint of a URL drawn by drawUrl: one line, or a domain over its path, each already
 *  shrunk to whatever the loop above settled on. `h` is measured from the TOP of the first line,
 *  which is where the caller anchors its rect — the URL is drawn on a middle baseline, so the
 *  first line reaches half a size above it and the last reaches half its own size below.
 *
 *  The designer kept its own copy of this and got three details wrong: it measured the path line at
 *  the full size the path is NOT drawn at, it clamped the width to maxW rather than to what the
 *  shrink loop produced, and its height stopped short of the second line's descenders. */
export function measureUrlBlock(ctx: CanvasRenderingContext2D, url: string, maxW: number, weight: number, sizePx: number, family: string, lineH: number): { w: number; h: number } {
  ctx.font = `${weight} ${sizePx}px ${family}`;
  const full = ctx.measureText(url).width;
  if (full <= maxW) return { w: full, h: sizePx };
  const i = url.indexOf('/');
  const domain = i === -1 ? url : url.slice(0, i);
  const path = i === -1 ? '' : url.slice(i);
  const d = fitted(ctx, domain, maxW, weight, sizePx, family);
  if (!path) return { w: d.w, h: sizePx };
  const p = fitted(ctx, path, maxW, weight, Math.round(sizePx * 0.82), family);
  return { w: Math.max(d.w, p.w), h: sizePx / 2 + lineH + p.px / 2 };
}

// The Snapdini brand mark punched into the centre of the QR: a white safety ring (so the QR stays
// readable), the gold chip, and a black top-hat — matching the <Logo> component. Safe because the
// poster QR is generated at high error-correction (≈30% recoverable).
export function drawBrandChip(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  const ring = size * 1.16;
  ctx.fillStyle = '#ffffff'; roundRect(ctx, cx - ring / 2, cy - ring / 2, ring, ring, ring * 0.26); ctx.fill();
  ctx.fillStyle = '#f5c518'; roundRect(ctx, cx - size / 2, cy - size / 2, size, size, size * 0.24); ctx.fill();
  ctx.fillStyle = '#111111';
  const cw = size * 0.36, ch = size * 0.40, top = cy - size * 0.17;
  roundRect(ctx, cx - cw / 2, top, cw, ch, size * 0.04); ctx.fill();                       // hat crown
  const bw = size * 0.64, bh = size * 0.11;
  roundRect(ctx, cx - bw / 2, top + ch - bh * 0.35, bw, bh, bh * 0.5); ctx.fill();          // hat brim
}

// Wrap text to maxW at the current font, returning the lines.
export function wrapToLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/); const lines: string[] = []; let line = '';
  for (const w of words) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; }
  if (line) lines.push(line); return lines;
}

// Centred (horizontally + vertically) wrapped text block at the box's centre.
export function drawTextBox(ctx: CanvasRenderingContext2D, text: string, weight: number, color: string, box: Box, maxW: number, sp: Space = PAGE, sizePx = box.size) {
  const family = '"Helvetica Neue", Arial, sans-serif';
  ctx.font = `${weight} ${sizePx}px ${family}`; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lines = wrapToLines(ctx, text, maxW); const lh = sizePx * 1.18;
  let y = sp.oy + box.y * sp.h - ((lines.length - 1) * lh) / 2;
  for (const ln of lines) { ctx.fillText(ln, sp.ox + box.x * sp.w, y); y += lh; }
}

// ── Faced text ───────────────────────────────────────────────────────────────
// The same jobs drawTextBox does, but honouring a Face — its family, weight, tracking, casing and
// its own size and line-height multipliers. drawTextBox is left alone because the trick-card sheet
// still calls it and card typography is a separate decision from poster typography.

/** Wrap `text` to `maxW` as `face` would set it at `sizePx`. Leaves the face applied. */
function facedLines(ctx: CanvasRenderingContext2D, face: Face, sizePx: number, text: string, maxW: number): string[] {
  applyFace(ctx, face, sizePx);
  return wrapToLines(ctx, castFor(face, text), maxW);
}

/** One faced block, wrapped and measured: the rows, the size they are actually set at, the line
 *  height that follows from it, and the footprint the whole block occupies.
 *
 *  THE one place that turns a string, a face and a wrap width into geometry. drawFaced paints from
 *  it and measureFaced reports it, so the ink and the drag outline cannot disagree about where the
 *  glyphs are — which they did, for every set except `plain`, while the designer kept its own
 *  Helvetica-shaped guess. Leaves the face applied and its tracking set; callers clear it. */
function facedBlock(ctx: CanvasRenderingContext2D, text: string, face: Face, sizePx: number, maxW: number): { lines: string[]; px: number; lh: number; w: number; h: number } {
  const lines = facedLines(ctx, face, sizePx, text, maxW);
  const px = applyFace(ctx, face, sizePx);
  const lh = px * face.lineHeight;
  let w = 0;
  for (const ln of lines) w = Math.max(w, ctx.measureText(ln).width);
  return { lines, px, lh, w, h: lines.length * lh };
}

/** A centred wrapped block in one face. Returns the total height drawn, so a caller stacking
 *  several blocks can lay them out without measuring twice. */
function drawFaced(ctx: CanvasRenderingContext2D, text: string, face: Face, colour: string, box: Box, maxW: number, sizePx = box.size): number {
  const { lines, lh, h } = facedBlock(ctx, text, face, sizePx, maxW);
  ctx.fillStyle = colour; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  let y = box.y * PAGE_H - ((lines.length - 1) * lh) / 2;
  for (const ln of lines) { ctx.fillText(ln, box.x * PAGE_W, y); y += lh; }
  clearTracking(ctx);
  return h;
}

/** What drawFaced would occupy, without painting it. */
function measureFaced(ctx: CanvasRenderingContext2D, text: string, face: Face, sizePx: number, maxW: number): { w: number; h: number } {
  const { w, h } = facedBlock(ctx, text, face, sizePx, maxW);
  // Tracking is sticky canvas state. A measure call that left 0.14em behind would silently space
  // out whatever was measured or drawn next.
  clearTracking(ctx);
  return { w, h };
}

/** How much paper each of the poster's wrapped body blocks gets — the message is inset further
 *  than the how-to line. Here rather than at the call sites because the outline has to wrap to the
 *  SAME width the ink does: two copies of a wrap width is two sets of line breaks. */
export const BODY_MAX_W = { message: PAGE_W - 200, steps: PAGE_W - 120 } as const;
export type BodyBlockKey = keyof typeof BODY_MAX_W;

/** A host-added line gets the same paper the how-to line does. */
export const TEXT_ITEM_MAX_W = PAGE_W - 120;

/** The footprint of the message or the how-to block, exactly as drawPoster sets it.
 *
 *  The designer used to measure these two itself, in Helvetica at the requested size with no
 *  tracking and no casing, while the renderer set them in the host's chosen body face — which is
 *  tracked, often upper-cased, and scaled. Measured on the bundled faces, the how-to outline came
 *  out 221px narrower than the text it was meant to contain in Editorial, and the message outline
 *  a whole line and a half too short. Hence: ask the renderer. */
export function measureBodyBlock(ctx: CanvasRenderingContext2D, o: { typeSet?: TypeSetKey }, which: BodyBlockKey, text: string, box: Box): { w: number; h: number } {
  return measureFaced(ctx, text, typeSet(o.typeSet).body, box.size, BODY_MAX_W[which]);
}

/** The headline, as up to three stacked parts in two faces, centred on the title box as one block.
 *
 *  One box, not three, on purpose: the host drags the title as a unit, and three independently
 *  draggable fragments would let them pull a headline apart into something that is no longer a
 *  headline. */
/** What the headline block is made of, already measured. Shared by the renderer and by the
 *  designer's drag-handle maths — a handle sized from a different measurement than the one that
 *  drew the text is a handle that does not sit on the text. */
export type TitleSpec = Pick<PosterRenderOpts, 'headline' | 'headlineTop' | 'headlineBottom' | 'typeSet' | 'titleFace'>;
type TitlePart = 'top' | 'main' | 'bottom';
type TitleRow = { text: string; face: Face; px: number; lh: number; w: number; part: TitlePart };

function titleRows(ctx: CanvasRenderingContext2D, o: TitleSpec, box: Box): TitleRow[] {
  const set = typeSet(o.typeSet);
  const main = titleFaceOf(set, o.titleFace);
  const cap = set.body;
  const maxW = PAGE_W - 140;
  const capPx = Math.round(box.size * 0.30);
  const rows: TitleRow[] = [];
  const push = (text: string, face: Face, px: number, part: TitlePart) => {
    for (const ln of facedLines(ctx, face, px, text, maxW)) {
      const drawn = applyFace(ctx, face, px);
      rows.push({ text: ln, face, px, lh: drawn * face.lineHeight, w: ctx.measureText(ln).width, part });
    }
  };
  const top = (o.headlineTop ?? '').trim();
  const bottom = (o.headlineBottom ?? '').trim();
  if (top) push(top, cap, capPx, 'top');
  push(o.headline || 'Our Event', main, box.size, 'main');
  if (bottom) push(bottom, cap, capPx, 'bottom');
  clearTracking(ctx);
  return rows;
}

/** The block's footprint, for hit-testing and the resize handle. */
export function measureTitleBlock(ctx: CanvasRenderingContext2D, o: TitleSpec, box: Box): { w: number; h: number } {
  const rows = titleRows(ctx, o, box);
  return { w: rows.reduce((a, r) => Math.max(a, r.w), 0), h: rows.reduce((a, r) => a + r.lh, 0) };
}

/** The headline, as up to three stacked parts in two faces, centred on the title box as one block.
 *
 *  One box, not three, on purpose: the host drags the title as a unit, and three independently
 *  draggable fragments would let them pull a headline apart into something that is no longer a
 *  headline. */
function drawTitleBlock(ctx: CanvasRenderingContext2D, o: PosterRenderOpts, box: Box) {
  const rows = titleRows(ctx, o, box);
  const total = rows.reduce((a, r) => a + r.lh, 0);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  let y = box.y * PAGE_H - total / 2;
  for (const r of rows) {
    // Per row, not per block. The three rows are still ONE draggable thing — pulling a headline
    // into fragments is not on offer — but they no longer have to share a colour, and with no
    // override set they all resolve to the same one they always did.
    ctx.fillStyle = r.part === 'main' ? o.ink.headline
      : inkOf(o.ink, r.part === 'top' ? 'headlineTop' : 'headlineBottom');
    applyFace(ctx, r.face, r.px);
    ctx.fillText(r.text, box.x * PAGE_W, y + r.lh / 2);
    y += r.lh;
  }
  clearTracking(ctx);
}

// ── The name lockup ──────────────────────────────────────────────────────────
// The most reused component across every printed reference: two names stacked in the structural
// face with a small script joiner between them, flanked by short hairlines.
//
//        RACHEL
//     ──  and  ──
//         ROSS
//
// It is one text field, not three, because a host types "Rachel and Ross" without being asked to
// decompose it. The separator they typed is kept VERBATIM as the joiner — someone who writes "&"
// gets an ampersand, not our idea of what they meant.

/** Split a typed line into [left, joiner, right], or null when there is nothing to split on.
 *
 *  Only the FIRST separator splits, so "Mia & Sam & the dog" stays sensible instead of becoming
 *  three rows. `and` has to be a whole word or "Alexander" would split down the middle. */
export function splitNames(raw: string): { left: string; joiner: string; right: string } | null {
  const m = raw.match(/^(.*?)\s*([&+]|\band\b|\bAND\b)\s*(.*)$/);
  if (!m) return null;
  const [, left, joiner, right] = m;
  if (!left.trim() || !right.trim()) return null;   // "and Ross" is a line, not a lockup
  return { left: left.trim(), joiner, right: right.trim() };
}

type NameRow = { text: string; face: Face; px: number; lh: number; w: number; rule: boolean };

type NameSpec = TitleSpec & { names?: string; stackNames?: boolean };

function nameRows(ctx: CanvasRenderingContext2D, o: NameSpec, box: Box): NameRow[] {
  const raw = (o.names ?? '').trim();
  if (!raw) return [];
  const set = typeSet(o.typeSet);
  const name = set.display;
  // The joiner is the one script word on the card. A set with no script face sets it in the body
  // face instead — smaller and tracked, which still reads as a joiner rather than as a third name.
  const join = set.script ?? set.body;
  const maxW = PAGE_W - 200;
  const row = (text: string, face: Face, px: number, rule: boolean): NameRow => {
    const drawn = applyFace(ctx, face, px);
    return { text: castFor(face, text), face, px, lh: drawn * face.lineHeight, w: 0, rule };
  };
  const measure = (r: NameRow): NameRow => {
    applyFace(ctx, r.face, r.px);
    return { ...r, w: Math.min(ctx.measureText(r.text).width, maxW) };
  };

  // Off means the line is set exactly as it was typed — "One & Two", one row, no joiner, no
  // hairlines. splitNames is not even asked, so nothing about the typed text can change the answer.
  const parts = o.stackNames === false ? null : splitNames(raw);
  const rows = parts
    ? [row(parts.left, name, box.size, false),
       row(parts.joiner, join, Math.round(box.size * 0.62), true),
       row(parts.right, name, box.size, false)]
    : [row(raw, name, box.size, false)];
  const out = rows.map(measure);
  clearTracking(ctx);
  return out;
}

/** A host-added line's footprint, so it can be dragged and resized like anything else. */
export function measureTextItem(ctx: CanvasRenderingContext2D, o: { typeSet?: TypeSetKey }, t: PosterTextItem): { w: number; h: number } {
  return measureFaced(ctx, t.text || ' ', typeSet(o.typeSet).body, t.size, TEXT_ITEM_MAX_W);
}

export function measureNames(ctx: CanvasRenderingContext2D, o: NameSpec, box: Box): { w: number; h: number } {
  const rows = nameRows(ctx, o, box);
  if (!rows.length) return { w: 0, h: 0 };
  // The hairlines stick out past the joiner, so the block is at least as wide as the widest name
  // plus them — otherwise the drag outline would cut through the rules it is supposed to contain.
  const widest = rows.reduce((a, r) => Math.max(a, r.w), 0);
  const joiner = rows.find((r) => r.rule);
  const ruled = joiner ? joiner.w + 2 * (ruleLen(joiner.px) + ruleGap(joiner.px)) : 0;
  return { w: Math.max(widest, ruled), h: rows.reduce((a, r) => a + r.lh, 0) };
}

const ruleLen = (px: number) => px * 1.4;
const ruleGap = (px: number) => px * 0.55;

function drawNames(ctx: CanvasRenderingContext2D, o: PosterRenderOpts, box: Box) {
  const rows = nameRows(ctx, o, box);
  if (!rows.length) return;
  const total = rows.reduce((a, r) => a + r.lh, 0);
  const cx = box.x * PAGE_W;
  const colour = inkOf(o.ink, 'names');
  ctx.fillStyle = colour; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  let y = box.y * PAGE_H - total / 2;
  for (const r of rows) {
    const mid = y + r.lh / 2;
    applyFace(ctx, r.face, r.px);
    ctx.fillText(r.text, cx, mid);
    if (r.rule) {
      // A hairline, not a rule — the whole point of the letterpress look is one very fine weight
      // against the heavy names. It scales with the joiner so it never out-weighs the script.
      const half = r.w / 2 + ruleGap(r.px);
      ctx.save();
      ctx.strokeStyle = colour; ctx.lineWidth = Math.max(1, r.px * 0.035); ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - half - ruleLen(r.px), mid); ctx.lineTo(cx - half, mid);
      ctx.moveTo(cx + half, mid); ctx.lineTo(cx + half + ruleLen(r.px), mid);
      ctx.stroke();
      ctx.restore();
    }
    y += r.lh;
  }
  clearTracking(ctx);
}

// Plain background = a solid colour (default white; the organizer can recolour it or match the theme).
function paintPlain(ctx: CanvasRenderingContext2D, colour: string) {
  ctx.fillStyle = colour || '#ffffff';
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
}

// White QR panel (QR + centre brand chip + optional code/URL), centred on its box.
// ── Symbol contrast ──────────────────────────────────────────────────────────
// The measurement that decides whether a code can safely sit on the paper instead of on a panel.

/** Reflectance 0–100 of a flat colour, the way a verifier reads it off paper. Perceptual weights,
 *  because a mid-green and a mid-blue of the same sRGB value do not reflect the same amount of the
 *  red-ish light most scanners illuminate with — and green is the one that flatters. */
export function reflectance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return 100;                                   // unknown = assume paper, and let the caller's default panel stand
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return ((0.299 * r + 0.587 * g + 0.114 * b) / 255) * 100;
}

/** ISO 18004 Symbol Contrast: Rmax − Rmin, an absolute difference in reflectance, NOT a ratio. */
export const symbolContrast = (bgHex: string, moduleHex = '#000000'): number =>
  Math.max(0, reflectance(bgHex) - reflectance(moduleHex));

/** The verifier grade bands. */
export const contrastGrade = (sc: number): 'A' | 'B' | 'C' | 'D' | 'F' =>
  sc >= 70 ? 'A' : sc >= 55 ? 'B' : sc >= 40 ? 'C' : sc >= 20 ? 'D' : 'F';

/** The bar for dropping the panel: grade B, not the grade C a verifier calls a pass.
 *
 *  C exists for a code scanned under controlled conditions — good light, square on, retried until it
 *  reads. This one gets ONE attempt, in a dim venue, by a stranger holding a phone at an angle, and
 *  there is no fixing it after fifty are printed.
 *
 *  A test is what moved this: at 40 the bar admitted kraft brown at 43.7%, which is the exact stock
 *  this panel was introduced to survive. The number was picked from the grade table rather than from
 *  what the poster is for. */
export const PANEL_OPTIONAL_MIN = 55;
export const panelOptional = (bgHex: string): boolean => symbolContrast(bgHex) >= PANEL_OPTIONAL_MIN;

// A QR PNG carries its own opaque white background, so drawing it without the panel would paint a
// white square on the paper and change nothing. This knocks the light pixels out to transparent so
// the paper itself becomes the quiet zone — which is the whole point, and is also why the contrast
// check above is against the PAPER rather than against white.
const knockedOut = new WeakMap<HTMLImageElement, HTMLCanvasElement | null>();
function transparentQr(img: HTMLImageElement): HTMLCanvasElement | null {
  const hit = knockedOut.get(img);
  if (hit !== undefined) return hit;
  let out: HTMLCanvasElement | null = null;
  try {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d', { willReadFrequently: true });
    if (cx) {
      cx.imageSmoothingEnabled = false;
      cx.drawImage(img, 0, 0, w, h);
      const d = cx.getImageData(0, 0, w, h);            // throws if the image ever became cross-origin
      const px = d.data;
      // A generated QR has no anti-aliasing, so a hard threshold is exact rather than approximate —
      // there are no in-between pixels to make a judgement call about.
      for (let i = 0; i < px.length; i += 4) {
        if (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] > 128) px[i + 3] = 0;
      }
      cx.putImageData(d, 0, 0);
      out = c;
    }
  } catch { out = null; }                               // tainted or unavailable: draw it as it came
  knockedOut.set(img, out);
  return out;
}

/** The QR sits on a WHITE panel by default, whatever the poster's paper.
 *
 *  ISO 18004 §6.3.8 requires the quiet zone to have the same reflectance as the light modules, and
 *  the grading measure is Symbol Contrast — Rmax − Rmin, an absolute difference, NOT a ratio. (Every
 *  "QR needs 4.5:1" claim online is WCAG text guidance misapplied to a symbology.) A white panel
 *  grades A at about 80%; the same code printed straight onto kraft grades D at about 35%.
 *
 *  The panel can now be turned OFF — but the rule it enforced has not been relaxed, it has been
 *  MEASURED instead. `symbolContrast()` below computes the real figure for the paper the code will
 *  actually land on, and the designer refuses to hide the panel when that figure is too low. "Dark
 *  modules on a light quiet zone, measured" was always the honest version of this rule; "black on
 *  white" was a proxy for it.
 *
 *  What is still absolute: never INVERT it. An iPhone will read a light-on-dark code, Android's ML
 *  Kit will not — so an inverted code works for whoever tests it and fails for half the guests. */
function drawQrPanel(ctx: CanvasRenderingContext2D, box: Box, qr: HTMLImageElement, o: PosterRenderOpts) {
  const { x: px, y: py, w: panelW, h: panelH } = qrPanelRect(box, o.codeDisplay);
  if (o.qrPanel !== false) { ctx.fillStyle = '#ffffff'; roundRect(ctx, px, py, panelW, panelH, 36); ctx.fill(); }
  const q = qrImageRect(box, o.codeDisplay);
  ctx.imageSmoothingEnabled = false;
  const art = o.qrPanel === false ? transparentQr(qr) : null;
  ctx.drawImage(art ?? qr, q.x, q.y, q.w, q.h);
  ctx.imageSmoothingEnabled = true;
  drawBrandChip(ctx, q.x + q.w / 2, q.y + q.h / 2, q.w * 0.20);
}

/** What prints UNDER the code, in the panel's lower strip.
 *
 *  Split out of drawQrPanel so a host-placed motif can be drawn BETWEEN the two. The panel is paper
 *  and the code is a picture, but the join code and the URL are words a guest has to read off a
 *  wall — and this poster's standing rule, stated where the slot decoration is drawn, is that the
 *  words sit on top of the line art rather than fight it. That strip is not quiet zone, so a motif
 *  is allowed to reach it; it is simply not allowed to be on top when it does.
 *
 *  Nothing inside moved: the baselines are still measured from the bottom of the QR image. */
function drawQrCaption(ctx: CanvasRenderingContext2D, box: Box, o: PosterRenderOpts) {
  const { x: px, w: panelW } = qrPanelRect(box, o.codeDisplay);
  const q = qrImageRect(box, o.codeDisplay);
  const ccx = px + panelW / 2, qBottom = q.y + q.h;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  if (o.codeDisplay === 'code') {
    ctx.fillStyle = '#555'; ctx.font = '400 26px "Helvetica Neue", Arial, sans-serif'; ctx.fillText('Join code', ccx, qBottom + 52);
    ctx.fillStyle = o.ink.code; ctx.font = '800 58px ui-monospace, Menlo, Consolas, monospace'; ctx.fillText(o.joinCode, ccx, qBottom + 116);
  } else if (o.codeDisplay === 'url') {
    ctx.fillStyle = o.ink.code; drawUrl(ctx, o.cleanUrl, ccx, qBottom + 86, panelW - 70, 700, 36, '"Helvetica Neue", Arial, sans-serif', 44);
  }
}

/**
 * Paint one poster onto `ctx`, in the 1080×1527 page space.
 *
 * The caller owns the canvas — its size, and clearing it. The designer paints a full-size page; a
 * wizard thumbnail scales the same drawing down with a ctx transform, which is only possible if
 * nothing in here resets the canvas out from under it.
 *
 * Rejects if the QR fails to decode, which is what keeps the designer's spinner up: a poster with
 * no code on it is not a poster.
 */
export async function drawPoster(ctx: CanvasRenderingContext2D, opts: PosterRenderOpts): Promise<PosterRenderResult> {
  const { layout, ink, cleanUrl } = opts;
  const load = opts.loadImage ?? decode;
  // Before anything paints. ctx.font falls back silently, so a poster drawn a frame early is a
  // poster exported in Arial — and the export is the artefact the host prints.
  await ensurePosterFonts(opts.typeSet);
  const set = typeSet(opts.typeSet);
  const W = PAGE_W, H = PAGE_H;

  let backgroundImage: HTMLImageElement | null = null;
  const src = opts.bgSrc;
  if (src) {
    try { const bg = await load(src); drawCover(ctx, bg, W, H); ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, H); backgroundImage = bg; }
    catch { paintPlain(ctx, opts.plainBg); }
  } else paintPlain(ctx, opts.plainBg);

  // Brand badge along the top — slides left/right (fixed height, never resized).
  const brandOn = opts.showBrand !== false;
  if (brandOn) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = ink.headline; brandFont(ctx, layout.brand.size);
    ctx.fillText(BRAND_TEXT, layout.brand.x * W, layout.brand.y * H + layout.brand.size * 0.34);
  }

  // Line art BEFORE the text and the QR panel, for the same reason the card renderer draws it
  // first: the words must sit on top of the decoration rather than fight it. The camera motif is
  // handed the QR square so it can wrap it, which is why that geometry is worked out up here.
  //
  // unit 2 because a motif is sized from the PAPER and 1 means A6 — an A4 poster is twice A6 on
  // each edge, so the same motif keeps its physical size rather than shrinking into the bigger
  // sheet. Skipped entirely for '' / 'none', which is the default and costs nothing.
  const qrBox = layout.qr;
  const qrPx = { x: qrBox.x * W - qrBox.size / 2, y: qrBox.y * H - qrBox.size / 2, w: qrBox.size, h: qrBox.size };
  const placed = opts.decorItems ?? [];

  /** A host's own image, placed like a motif.
   *
   *  Drawn here rather than in cardDecor because that file is pure vector geometry shared with the
   *  card renderer, and an image needs a loader and an await. Same placement maths as a motif so
   *  the two cannot drift: centre at (x, y) of the page, rotation about that centre, and a size
   *  taken from the shorter page edge so the mark keeps its physical size whether this is an A6
   *  card or an A2 sheet.
   *
   *  Transparency is the point — a crest on a coloured poster is nothing in a white box — which is
   *  why the upload is re-encoded to PNG rather than the JPEG every other theme image becomes. */
  const drawLogos = async () => {
    for (const it of placed) {
      if (it.kind !== 'logo' || !it.url) continue;
      let img: HTMLImageElement;
      try { img = await load(it.url); } catch { continue; }   // a missing file leaves a gap, not a crash
      const ar = it.ar && Number.isFinite(it.ar) && it.ar > 0 ? it.ar : (img.width / img.height || 1);
      const scale = Math.max(0.4, Math.min(2.2, it.scale || 1));
      const w = Math.min(W, H) * 0.22 * scale;
      const h = w / ar;
      ctx.save();
      ctx.translate(it.x * W, it.y * H);
      if (it.rot) ctx.rotate(it.rot);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();
    }
  };
  const page = { x: 0, y: 0, w: W, h: H };
  // The design's own decoration draws WHATEVER is placed by hand. The two are additive.
  //
  // This used to suppress the slot motif as soon as anything was placed, on the theory that a host
  // who had arranged three sprigs would not want a fourth appearing at the top. That was reasoning
  // about intent instead of doing what the controls say: adding a motif silently deleted the
  // decoration the design already had, and nothing on screen explained where it went. There is
  // already a control that means "no decoration" — it is the None button — and it is the only
  // thing that should turn one off.
  const slotKind = opts.decorKind;
  const slotIsPositional = DECOR_KINDS.find((d) => d.key === slotKind)?.positional ?? false;
  // Written as one narrowing condition rather than a precomputed boolean: `decorKind` is
  // `DecorKind | '' | undefined`, and only the inline check tells the compiler which it is here.
  if (slotKind && slotKind !== 'none') {
    // A POSITIONAL motif's `top` slot is measured from the top of the rect it is given, which on a
    // card is the card edge. Handed the whole page it landed at about y=76 — straight through the
    // "🎩 Snapdini" mark at y≈107. The text draws afterwards so it won the z-order, but the two
    // were occupying one band, which reads as a collision rather than as layering.
    //
    // So positional motifs get a rect that starts BELOW the brand line. That puts `top` in the open
    // space between the brand and the title (≈107 to ≈305) instead of on top of the brand, and
    // leaves the bottom edge alone so corner sets are unaffected.
    //
    // Non-positional kinds keep the full page: `frame` IS the page border and `camera` wraps the
    // QR, and insetting either would draw it in the wrong place entirely.
    const positional = slotIsPositional;
    // Half the type size, not the whole box. The brand is drawn from a baseline, so its ink ends
    // about half a size below layout.brand.y — using the full size put the corridor's floor 17px
    // lower than the actual mark and pushed the motif down with it, leaving ~60px of air above and
    // ~12px below. Measured: brand ink ends at 124, the title starts at 272, so this centres the
    // motif in that gap instead of crowding the headline.
    // With the mark switched off there is no ink to stay clear of, so the corridor is the whole
    // page — otherwise a `top` motif would hang below an empty band, visibly avoiding nothing.
    // ...and only when the mark is actually IN that band. The mark now defaults to the foot (see
    // DEFAULT_POSTER_LAYOUT.brand), where it is nowhere near a `top` motif, so insetting the whole
    // page for it would cost every new poster the top edge to avoid a collision that cannot happen.
    //
    // Keyed off the mark's POSITION, not off `showBrand`, because both states have to be right: a
    // design saved before this change still has the mark at 0.07 and still needs the corridor, and
    // a host who drags it back up there needs it too. The threshold is the top fifth of the page —
    // a `top` motif reaches about y=240 at its largest, and the title's own default centre is
    // 0.225, so anything below this is not in the motif's way.
    const brandInTopBand = brandOn && layout.brand.y < 0.20;
    const brandBottom = brandInTopBand ? layout.brand.y * H + layout.brand.size * 0.5 : 0;
    const card = positional
      ? { x: 0, y: brandBottom, w: W, h: H - brandBottom }
      : { x: 0, y: 0, w: W, h: H };
    drawDecor(ctx, {
      kind: slotKind, pos: opts.decorPos ?? 'top',
      scale: opts.decorScale ?? 1,
      // Falls back to the headline ink, so a preset that names no colour still draws in something
      // that belongs to the design rather than in canvas-default black.
      colour: opts.decorColour || ink.headline,
      unit: 2,
      card,
      qr: qrPx,
    });
  }

  // Everything else is drawn at its free layout position (the organizer drags/resizes these).
  const qr = await load(opts.qrSrc);
  drawQrPanel(ctx, layout.qr, qr, opts);

  // ── Motifs the host placed by hand, OVER the panel ──────────────────────────
  //
  // These used to be drawn before the panel, which is why a motif dragged anywhere near the code
  // simply vanished: the white rect painted straight over it, and nothing on screen said so. It was
  // never a placement restriction — the host could put a motif there, it just could not be seen —
  // which is the worst version of the bug, because the control worked and the paper did not.
  //
  // What it costs, and what it does not: the code keeps every module and every bit of the quiet
  // zone it was generated with, because the clip below cuts the QR IMAGE's square out of the region
  // these are allowed to paint in. See qrImageRect for why that square, and not the panel, is the
  // honest keep-out — the quiet zone is inside the PNG.
  //
  // Even-odd on two rects: the page, then the code's square. Applied whether or not the panel is
  // shown, because with the panel off the light modules are knocked out to transparent and the
  // PAPER is the quiet zone — a motif drawn across it would be printing on the code itself.
  //
  // They now also sit ABOVE the slot decoration rather than below it. Same reasoning the host's own
  // text lines are drawn last with: a thing the host put in a particular place by hand outranks a
  // thing the design dropped into a slot.
  if (placed.length) {
    const keepOut = qrKeepOut(layout.qr, opts.codeDisplay);
    // ...and only when one of them could actually REACH the code.
    //
    // A clip is not free of consequence even where it excludes nothing: it puts the strokes through
    // a different rasterisation, and measured in Chromium that moved 872 antialiased pixels of a
    // motif at the top of the page by up to 6/255 — invisible, and still a change to a design
    // nobody edited. decorReach() is cardDecor's own answer to how far a motif's ink goes, so this
    // is not a second guess at its size.
    const reaches = placed.some((it) => {
      const r = decorReach({ scale: it.scale, unit: 2, card: page });
      const cx = it.x * W, cy = it.y * H;
      return cx + r > keepOut.x && cx - r < keepOut.x + keepOut.w
          && cy + r > keepOut.y && cy - r < keepOut.y + keepOut.h;
    });
    ctx.save();
    if (reaches) {
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.rect(keepOut.x, keepOut.y, keepOut.w, keepOut.h);
      ctx.clip('evenodd');
    }
    for (const it of placed) {
      drawDecorAt(ctx, { ...it, colour: it.colour || opts.decorColour || ink.headline, unit: 2, card: page });
    }
    ctx.restore();
  }
  // ...and the words under the code go on top of them, like every other word on the poster.
  drawQrCaption(ctx, layout.qr, opts);

  // Each of these is turned about its own anchor when the host has turned it, and draws exactly as
  // it always did when they have not — see rotated(). The QR is NOT in this list and neither is the
  // mark; canRotate() in $lib/posterFlow says why.
  rotated(ctx, layout.title.x * W, layout.title.y * H, layout.title.rot, () => drawTitleBlock(ctx, opts, layout.title));
  if (opts.message.trim()) rotated(ctx, layout.message.x * W, layout.message.y * H, layout.message.rot,
    () => drawFaced(ctx, opts.message, set.body, ink.message, layout.message, BODY_MAX_W.message));
  if (opts.stepsText.trim()) rotated(ctx, layout.steps.x * W, layout.steps.y * H, layout.steps.rot,
    () => drawFaced(ctx, opts.stepsText, set.body, ink.steps, layout.steps, BODY_MAX_W.steps));
  rotated(ctx, layout.names.x * W, layout.names.y * H, layout.names.rot, () => drawNames(ctx, opts, layout.names));
  // Last, so a host-added line sits on top of everything else — they added it deliberately and it
  // should not end up behind a motif they chose earlier.
  for (const t of opts.textItems ?? []) {
    if (!t.text.trim()) continue;
    // `t.colour || ink.message` — the same fallback chain the placed decorations use. A line saved
    // before this existed has no colour and still draws in the message ink.
    rotated(ctx, t.x * W, t.y * H, t.rot,
      () => drawFaced(ctx, t.text, set.body, t.colour || ink.message, { x: t.x, y: t.y, size: t.size }, TEXT_ITEM_MAX_W, t.size));
  }
  if (opts.showFooterUrl) {
    rotated(ctx, layout.footer.x * W, layout.footer.y * H, layout.footer.rot, () => {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = ink.footer;
      drawUrl(ctx, cleanUrl, layout.footer.x * W, layout.footer.y * H, footerMaxW(ctx, layout, opts.showBrand), FOOTER_FONT.weight, layout.footer.size, FOOTER_FONT.family, layout.footer.size * FOOTER_FONT.lineHeight);
    });
  }
  // A host's own image goes on last and OUTSIDE the QR keep-out that the motifs draw inside.
  // The keep-out exists to stop a decoration we placed for them wandering over the code; a logo is
  // put exactly where they put it, and is theirs to move if it lands somewhere it should not.
  await drawLogos();
  return { backgroundImage };
}
