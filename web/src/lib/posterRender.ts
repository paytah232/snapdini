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
import { drawDecor, drawDecorAt, DECOR_KINDS, type DecorKind, type DecorPos, type DecorPlacement } from './cardDecor';
import {
  applyFace, castFor, clearTracking, ensurePosterFonts, titleFaceOf, typeSet,
  type Face, type TitleFace, type TypeSetKey,
} from './posterFonts';

export type Box = { x: number; y: number; size: number };
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
  brand:   { x: 0.5, y: 0.07,  size: 34 },   // the 🎩 Snapdini mark — slides left/right along the top only
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

/** One host-added line. `x`/`y` are the CENTRE as a fraction of the page, matching every other
 *  element; `size` is px in the 1080-wide space. */
export type PosterTextItem = { text: string; x: number; y: number; size: number };

export type PosterCodeDisplay = 'url' | 'code' | 'none';

/** The white panel's footprint — the QR plus its padding plus whatever is printed under it.
 *
 *  Exported because the designer needs the same rectangle for its drag outline, and it used to
 *  carry its own copy of these numbers. Two copies of a geometry is one geometry and one bug
 *  waiting for someone to change the padding in the place they happened to be looking at. */
export function qrPanelRect(box: Box, codeDisplay: PosterCodeDisplay): { x: number; y: number; w: number; h: number } {
  const w = box.size + 90;
  // The code and the URL both print below the QR and both need the taller panel. It is the thing
  // that makes the panel reach much further down the page than its box suggests — which is exactly
  // what the name lockup's default position has to clear.
  const h = box.size + (codeDisplay !== 'none' ? 195 : 90);
  return { x: box.x * PAGE_W - w / 2, y: box.y * PAGE_H - h / 2, w, h };
}
/** The colours the poster is DRAWN with — already made readable against the ground they land on.
 *  The renderer never second-guesses these; picking them is the designer's job (readableOn). */
export type PosterInk = { headline: string; message: string; steps: string; footer: string; code: string };

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

// Draw a single line, shrinking the font until it fits maxW — keeps long join URLs from
// spilling past the QR panel / page edge (no clean place to wrap a URL).
export function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, weight: number, sizePx: number, family: string): void {
  let size = sizePx;
  ctx.font = `${weight} ${size}px ${family}`;
  while (size > 14 && ctx.measureText(text).width > maxW) { size -= 2; ctx.font = `${weight} ${size}px ${family}`; }
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

/** A centred wrapped block in one face. Returns the total height drawn, so a caller stacking
 *  several blocks can lay them out without measuring twice. */
function drawFaced(ctx: CanvasRenderingContext2D, text: string, face: Face, colour: string, box: Box, maxW: number, sizePx = box.size): number {
  const lines = facedLines(ctx, face, sizePx, text, maxW);
  const px = applyFace(ctx, face, sizePx);
  const lh = px * face.lineHeight;
  ctx.fillStyle = colour; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  let y = box.y * PAGE_H - ((lines.length - 1) * lh) / 2;
  for (const ln of lines) { ctx.fillText(ln, box.x * PAGE_W, y); y += lh; }
  clearTracking(ctx);
  return lines.length * lh;
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
type TitleRow = { text: string; face: Face; px: number; lh: number; w: number };

function titleRows(ctx: CanvasRenderingContext2D, o: TitleSpec, box: Box): TitleRow[] {
  const set = typeSet(o.typeSet);
  const main = titleFaceOf(set, o.titleFace);
  const cap = set.body;
  const maxW = PAGE_W - 140;
  const capPx = Math.round(box.size * 0.30);
  const rows: TitleRow[] = [];
  const push = (text: string, face: Face, px: number) => {
    for (const ln of facedLines(ctx, face, px, text, maxW)) {
      const drawn = applyFace(ctx, face, px);
      rows.push({ text: ln, face, px, lh: drawn * face.lineHeight, w: ctx.measureText(ln).width });
    }
  };
  const top = (o.headlineTop ?? '').trim();
  const bottom = (o.headlineBottom ?? '').trim();
  if (top) push(top, cap, capPx);
  push(o.headline || 'Our Event', main, box.size);
  if (bottom) push(bottom, cap, capPx);
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
  ctx.fillStyle = o.ink.headline; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  let y = box.y * PAGE_H - total / 2;
  for (const r of rows) {
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

function nameRows(ctx: CanvasRenderingContext2D, o: TitleSpec & { names?: string }, box: Box): NameRow[] {
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

  const parts = splitNames(raw);
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
  const face = typeSet(o.typeSet).body;
  const lines = facedLines(ctx, face, t.size, t.text || ' ', PAGE_W - 120);
  const px = applyFace(ctx, face, t.size);
  let w = 0;
  for (const ln of lines) w = Math.max(w, ctx.measureText(ln).width);
  clearTracking(ctx);
  return { w, h: lines.length * px * face.lineHeight };
}

export function measureNames(ctx: CanvasRenderingContext2D, o: TitleSpec & { names?: string }, box: Box): { w: number; h: number } {
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
  ctx.fillStyle = o.ink.headline; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
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
      ctx.strokeStyle = o.ink.headline; ctx.lineWidth = Math.max(1, r.px * 0.035); ctx.lineCap = 'round';
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
  const qSize = box.size;
  const { x: px, y: py, w: panelW, h: panelH } = qrPanelRect(box, o.codeDisplay);
  if (o.qrPanel !== false) { ctx.fillStyle = '#ffffff'; roundRect(ctx, px, py, panelW, panelH, 36); ctx.fill(); }
  const qx = px + (panelW - qSize) / 2, qy = py + 45, ccx = px + panelW / 2;
  ctx.imageSmoothingEnabled = false;
  const art = o.qrPanel === false ? transparentQr(qr) : null;
  ctx.drawImage(art ?? qr, qx, qy, qSize, qSize);
  ctx.imageSmoothingEnabled = true;
  drawBrandChip(ctx, qx + qSize / 2, qy + qSize / 2, qSize * 0.20);
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  if (o.codeDisplay === 'code') {
    ctx.fillStyle = '#555'; ctx.font = '400 26px "Helvetica Neue", Arial, sans-serif'; ctx.fillText('Join code', ccx, qy + qSize + 52);
    ctx.fillStyle = o.ink.code; ctx.font = '800 58px ui-monospace, Menlo, Consolas, monospace'; ctx.fillText(o.joinCode, ccx, qy + qSize + 116);
  } else if (o.codeDisplay === 'url') {
    ctx.fillStyle = o.ink.code; drawUrl(ctx, o.cleanUrl, ccx, qy + qSize + 86, panelW - 70, 700, 36, '"Helvetica Neue", Arial, sans-serif', 44);
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
    ctx.fillStyle = ink.headline; ctx.font = `600 ${layout.brand.size}px "Helvetica Neue", Arial, sans-serif`;
    ctx.fillText('🎩 Snapdini', layout.brand.x * W, layout.brand.y * H + layout.brand.size * 0.34);
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
  const page = { x: 0, y: 0, w: W, h: H };
  for (const it of placed) {
    drawDecorAt(ctx, { ...it, colour: it.colour || opts.decorColour || ink.headline, unit: 2, card: page });
  }
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
    const brandBottom = brandOn ? layout.brand.y * H + layout.brand.size * 0.5 : 0;
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
  drawTitleBlock(ctx, opts, layout.title);
  if (opts.message.trim()) drawFaced(ctx, opts.message, set.body, ink.message, layout.message, W - 200);
  if (opts.stepsText.trim()) drawFaced(ctx, opts.stepsText, set.body, ink.steps, layout.steps, W - 120);
  drawNames(ctx, opts, layout.names);
  // Last, so a host-added line sits on top of everything else — they added it deliberately and it
  // should not end up behind a motif they chose earlier.
  for (const t of opts.textItems ?? []) {
    if (!t.text.trim()) continue;
    drawFaced(ctx, t.text, set.body, ink.message, { x: t.x, y: t.y, size: t.size }, W - 120, t.size);
  }
  if (opts.showFooterUrl) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = ink.footer;
    drawUrl(ctx, cleanUrl, layout.footer.x * W, layout.footer.y * H, W - 120, 400, layout.footer.size, 'ui-monospace, Menlo, Consolas, monospace', layout.footer.size * 1.25);
  }
  return { backgroundImage };
}
