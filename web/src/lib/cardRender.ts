// ── Trick-card rendering ─────────────────────────────────────────────────────
// The card/sheet drawing code, lifted out of PosterModal.svelte for the reason posterRender.ts was
// lifted out before it: a renderer that lives inside a Svelte component cannot be bundled, so it
// cannot be RUN outside the app — and a drawing that cannot be run outside the app cannot be
// proved unchanged. Every change to the poster's renderer since it moved has been demonstrated
// byte-identical by bundling it with esbuild, drawing the matrix in a real headless Chromium with
// the real woff2 faces, and hashing canvas.toDataURL. The cards had no such evidence available to
// them; source-level tests that "every read goes through cardLookFor()" were the best that could be
// said. Now the same proof is available to both.
//
// Everything here is pure: no Svelte, no component state, no module-level mutable state. A call
// touches only the ctx it was handed and the opts it was given, so a sheet for Card B and a sheet
// for Card C can be painted onto different canvases at the same time without interfering. That is
// not a stylistic preference — it is the specific bug this shape rules out. A draw site left
// reading a reactive `cardInk` prints the WHOLE STACK in whatever card happened to be previewed,
// which is exactly what per-card designs invite and what has had to be fixed here once already.
//
// Deliberately NOT here: the state, the reactivity, and the two side effects the designer owns —
// loading images and resolving a set's QR. drawSheet takes the QR it is to print and a loader,
// the way drawPoster does.
import { CAMERA_TOP, cameraMargin, drawDecor, type DecorKind, type DecorPos, type Rect } from './cardDecor';
import {
  PAGE_H, PAGE_W, IMAGE_INK_BG, INK_BODY, readableOn, relLum,
  drawBrandChip, drawCover, drawUrl, fitText, readBox, roundRect, wrapToLines,
  type Box, type Space,
} from './posterRender';
import {
  applyFace, castFor, clearTracking, ensurePosterFonts, titleFaceOf, typeSet,
  type TypeSetKey, type TitleFace,
} from './posterFonts';
import { cardGrid, cardLookFor, type CardLook, type CardsPerSheet } from './posterFlow';

export type { CardsPerSheet };

const W = PAGE_W, H = PAGE_H;                // A4 portrait — the page space the poster draws in
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The two things on a card that can be picked up and moved. */
export type CardElKey = 'title' | 'qr' | 'list';
export type CardLayout = Record<CardElKey, Box>;
/** One card's own look: its four colour overrides and its arrangement. Blank colour = follow the
 *  poster, which is the whole point of the poster and the cards being one design. */
export type CardDesign = CardLook<CardLayout>;
/** One trick list. The shape the admin payload delivers; the renderer only reads it. */
export type CardSet = { key: string; label: string; items: { id: string; text: string }[] };

// A4 halves into two A5 and quarters into four A6, so 1, 2 and 4 cards all tile one sheet with
// nothing left over — which is why those are the three counts on offer and 3 is not. Everything
// below is laid out in the poster's own 1080×1527 design space — so px·0.194 ≈ mm still holds —
// and the canvas is scaled up by the transform on the way out.
export const CARD_SCALE = 2;         // 2× A4 out: at 1× a 12px mission line prints mushy
// 0: the card runs to the cut line, with no white gutter inside it.
//
// It was 10 (≈2mm a side) to give scissors somewhere to go, and that is the wrong way round. With a
// gutter, a cut a millimetre off centre takes a white sliver off one card and slices into the art of
// its neighbour — the error shows on both. Bleeding to the line means a slightly-off cut just moves
// where the border sits, and nothing looks like a mistake. It is also simply easier to aim at: the
// edge of the colour IS the line to follow, whether or not the guides are printed.
//
// CARD_PAD is untouched — that is the quiet space around the WORDS, which is a typographic
// decision and nothing to do with cutting.
export const CARD_GAP = 0;
export const CARD_PAD = 34;          // ≈6.6mm of quiet space inside the card's edge
// The card's QR. QR_MIN_PX (≈33mm) is the floor that keeps a code with our logo punched into its
// centre scannable, and this clears it at ≈39mm. QR_WARN_PX (≈45mm) is deliberately NOT applied
// here: that line sizes a code to be read across a room, and a card is held in the hand.
const CARD_QR_PX = 200;
export const CARD_QR_MAX = 420;
const CARD_MONO = 'ui-monospace, Menlo, Consolas, monospace';
/** The card identifier's default size, and how far a host may take it. */
export const CARD_LABEL_PX = 19, CARD_LABEL_MIN = 7, CARD_LABEL_MAX = 30;

/** The card's own free layout. Positions are fractions of the CARD (not the sheet), so a design
 *  survives switching between 4-up, 2-up and 1-up; sizes are in A6 px and are multiplied by the
 *  paper scale, so a card on a bigger sheet grows rather than floating in white space. */
export const DEFAULT_CARD_LAYOUT: CardLayout = {
  title: { x: 0.5, y: 0.17, size: 34 },
  qr:    { x: 0.5, y: 0.82, size: 200 },
  /* The trick list. `size` 0 means AUTO — the list fits itself to whatever the title and the join
     block leave, which is what makes a 5-trick card breathe and a 20-trick one pack in. A host who
     resizes it writes a real size here and that becomes the row text size instead, still clamped so
     it cannot outgrow the space or shrink past legible.
     `y` IS read, as a nudge. The list's REGION is still decided by the two blocks around it — that
     part was never negotiable, and a list dragged under the QR really would be a card nobody can
     print — but within that region the host can move it up or down, and listGeom clamps so it can
     never reach either block. Measured as a delta from the default, so every card saved before the
     list could move sits exactly where it always did.
     `x` is still not read, and there is nothing to read: the list spans the full printable width,
     so there is no room either side to move it into. Giving it a width first would be a different
     feature. See LIST_AUTO. */
  list:  { x: 0.5, y: 0.5, size: 0 },
};

/** `size: 0` on the list means "work it out", which is the state every card starts in. */
export const LIST_AUTO = 0;

export const cloneCardLayout = (l: CardLayout): CardLayout =>
  ({ title: { ...l.title }, qr: { ...l.qr }, list: { ...(l.list ?? DEFAULT_CARD_LAYOUT.list) } });

/** Per-card overrides out of a stored blob, element by element.
 *
 *  Same reasoning as the placed decorations' reader: this is a server-side blob and an unchecked
 *  entry reaches placeOnCard() as NaN, which draws nothing — indistinguishable from the card
 *  having lost its title. A bad entry is dropped rather than failing the whole restore, because
 *  losing one card's colours beats refusing to open the host's design. */
/** A stored card layout, element by element — the same validation readCardSets applies to a
 *  per-card override, available on its own because PosterModal restores the BASE card's layout
 *  from the same blob and was spreading it raw. The clamp itself is readBox() in posterRender,
 *  beside the Box type, so the poster and the cards cannot end up with two different ideas of
 *  what a drawable box is. */
export const readCardLayout = (raw: unknown): CardLayout => {
  const l = (raw && typeof raw === 'object' ? raw : {}) as Partial<CardLayout>;
  return {
    title: readBox(l.title, DEFAULT_CARD_LAYOUT.title),
    qr: readBox(l.qr, DEFAULT_CARD_LAYOUT.qr),
    // Absent in every design saved before the list became resizable, and readBox falls back for it.
    list: readBox(l.list, DEFAULT_CARD_LAYOUT.list),
  };
};

export function readCardSets(raw: unknown): Record<string, CardDesign> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const out: Record<string, CardDesign> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const d = v as Partial<CardDesign> | undefined;
    if (!d || typeof d !== 'object') continue;
    out[k] = {
      cTitle: str(d.cTitle), cBody: str(d.cBody), cCode: str(d.cCode), cBg: str(d.cBg),
      layout: readCardLayout(d.layout),
    };
  }
  return out;
}

// ── What one card is printed with ────────────────────────────────────────────

/** Everything the renderer needs that is NOT the canvas and NOT an image.
 *
 *  Flat and explicit on purpose. Every field here was a reactive variable the drawing code read
 *  straight out of the component, and the whole class of bug this refactor closes is a draw site
 *  reading one of them at the moment it happened to be the previewed card's. A parameter cannot
 *  do that. */
export type CardRenderOpts = {
  // ── Whose look each card gets ──
  /** One matching set, or a design per card. The default, and what every design saved before the
   *  toggle existed reads as. */
  oneDesign: boolean;
  /** Card A's design — the one the others follow. */
  base: CardDesign;
  /** The cards that have a look of their own, by set key. ABSENT MEANS INHERIT: the first card is
   *  the base and has no entry, and letting go of an override is spelled as deleting the entry. */
  overrides: Readonly<Record<string, CardDesign>>;
  /** The first card's key — the base. */
  baseKey: string | null;
  /** How many trick lists there are. Two or more is what makes the identifier worth printing at
   *  all: with one card there is nothing to confuse it with. */
  setCount: number;
  /** Print the dashed guides along the cuts. On by default — most people are cutting these out with
   *  scissors on a kitchen table and the line is the whole point. Off for a guillotine, where the
   *  card edge is guide enough and a dashed line that survives a millimetre of drift is a printed
   *  mistake on the finished card. Undefined reads as ON, so designs saved before this existed keep
   *  the guides they were drawn with. */
  cutLines?: boolean;

  // ── The poster's design, inherited ──
  /** The cards carry the poster's pairing: the BODY face for the list and the join details, the
   *  full title face for the heading. They were hardcoded to Helvetica in thirteen places, so
   *  choosing a typeface restyled the poster and left the cards unchanged. */
  typeSetKey?: TypeSetKey;
  titleFace?: TitleFace;
  /** The poster's three relevant inks. A card override wins; otherwise the card follows these —
   *  and either way every colour goes through readableOn against the CARD's ground. */
  posterInk: { headline: string; steps: string; code: string };
  /** The poster's plain paper colour. */
  posterBg: string;
  /** The poster's background photo, or null. A card colour of its own beats it. */
  posterBgSrc: string | null;

  // ── The card's own options ──
  heading: string;
  glyph: string;
  inkSaver: boolean;
  /** Square corners are an option because a rounded card cannot be cut with a guillotine. */
  round: boolean;
  ids: boolean;
  labelPos: 'above' | 'below';
  labelSize: number;
  showQr: boolean;
  showLink: boolean;
  caption: string;
  codeMode: 'code' | 'url';
  cardsPerSheet: CardsPerSheet;
  /** The SHEET's orientation, which is what reaches the printer. The control a host sees means the
   *  CARD; sheetLandscapeFor() in posterFlow is the table between the two. */
  sheetLandscape: boolean;

  // ── What the code says ──
  joinCode: string;
  cleanUrl: string;

  // ── Line art ──
  decorKind: DecorKind;
  decorPos: DecorPos;
  decorScale: number;
  decorColour: string;
};

/** The design a given card is actually PRINTED with.
 *
 *  Keyed off the set rather than off what is on screen, because drawSheet() paints a page per set
 *  and a design read from the preview would print every sheet in the previewed card's colours.
 *
 *  The rule itself — and the guarantee that "one design" resolves to the base OBJECT rather than
 *  to a copy of it — is cardLookFor() in posterFlow, where it is tested. */
export const cardDesignFor = (set: CardSet | null, o: CardRenderOpts): CardDesign =>
  cardLookFor({ oneDesign: o.oneDesign, base: o.base, sets: o.overrides, key: set?.key ?? null, baseKey: o.baseKey });

export type CardPaint = {
  design: CardDesign; bgHex: string; useImage: boolean; ground: string; dark: boolean;
  ink: { title: string; body: string; code: string; muted: string; rule: string };
  tickInk: string;
};

/** A FUNCTION of the set, never a value: drawSheet() paints a page per set and every one of these
 *  has to be that set's. The designer applies it to the card on screen, which is what its controls
 *  are editing — but that is one call among several, not the source of truth. */
export function cardPaintFor(set: CardSet | null, o: CardRenderOpts): CardPaint {
  const design = cardDesignFor(set, o);
  // What the card is actually printed on. A card colour of its own beats the poster's image:
  // asking for a colour is asking for a plain card.
  const bgHex = o.inkSaver ? '#ffffff' : (design.cBg || o.posterBg || '#ffffff');
  const useImage = !o.inkSaver && !design.cBg && !!o.posterBgSrc;
  const ground = useImage ? IMAGE_INK_BG : bgHex;
  const dark = relLum(ground) < 0.22;
  // The card inherits the poster's colours unless the host overrode one here — and either way
  // every colour goes through readableOn against the card's own ground, because a colour that is
  // right on the poster is not necessarily right on a card the host has since made white.
  const ink = {
    title: readableOn(design.cTitle || o.posterInk.headline, ground),
    body:  readableOn(design.cBody || o.posterInk.steps, ground, INK_BODY),
    code:  readableOn(design.cCode || o.posterInk.code, ground, INK_BODY),
    muted: dark ? 'rgba(255,255,255,0.72)' : '#6b6b6b',
    rule:  dark ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.16)',
  };
  // ── The tick's ink ───────────────────────────────────────────────────────
  // The tick is the one piece of event branding sitting inside the body text, so it follows the
  // design's accent-bearing ink — the card's title override, else the poster title, which itself
  // defaults to (and tracks) the event accent — instead of printing as flat body ink. A host who
  // has set the trick-list colour has said what that whole column should be, so that override
  // still wins over the theme. readableOn at the BODY bar rather than the large-type one, because
  // the tick is set at the trick line's own size and read in the hand: a pale accent on a white
  // card is walked down until it is legible rather than printed as a ghost.
  const tickInk = design.cBody ? ink.body : readableOn(design.cTitle || o.posterInk.headline, ground, INK_BODY);
  return { design, bgHex, useImage, ground, dark, ink, tickInk };
}

// ── The two faces a card is set in ──────────────────────────────────────────
// Derived from the opts rather than passed in, so there is no way to hand the geometry one face and
// the drawing another. The BODY face only for the list and the join details: a trick list is read
// at arm's length in low light, and the display face's tracking and casing are wrong for a column
// of short lines. The title takes the full face, because that is the one thing on the card doing
// the design's job — and it goes through applyFace, which is why it gets the tracking and the
// casing the pairing asks for while the body gets a plain ctx.font.
const titleFaceFor = (o: CardRenderOpts) => titleFaceOf(typeSet(o.typeSetKey), o.titleFace);
const bodyFamilyFor = (o: CardRenderOpts) => typeSet(o.typeSetKey).body.family;

// ── Sheet geometry ──────────────────────────────────────────────────────────

/** How the sheet is divided, and the paper scale that follows from it.
 *
 *  `unit` multiplies every measurement below, so a design keeps its proportions when the host
 *  changes how many cards go on a sheet. It follows the card's HEIGHT, not its area: a quarter-
 *  sheet A6 and a half-sheet A5 are both half an A4 tall, so the vertical space — the only thing a
 *  list down a card competes for — is identical, and only the full-page card is twice as tall.
 *  Scaling A5 by area instead would make its QR half again as tall for no gain and squeeze the
 *  trick list into the gap; this way the extra width of a half-sheet card goes where it is
 *  actually useful, into longer lines. */
export type SheetGeom = {
  sheetW: number; sheetH: number; cols: number; rows: number; slotW: number; slotH: number; unit: number;
};
export function sheetGeom(per: CardsPerSheet, sheetLandscape: boolean): SheetGeom {
  const sheetW = sheetLandscape ? H : W;
  const sheetH = sheetLandscape ? W : H;
  // The split follows the paper, and every size fills the sheet exactly either way — cardGrid() in
  // posterFlow, where all six combinations are pinned.
  const { cols, rows } = cardGrid(per, sheetLandscape);
  return { sheetW, sheetH, cols, rows, slotW: sheetW / cols, slotH: sheetH / rows, unit: per === 1 ? 2 : 1 };
}

// ── Card geometry ───────────────────────────────────────────────────────────
// One source of truth for where things sit on a card: the drawing code and the designer's drag
// outlines both read it, so an outline can never claim a size the printed card disagrees with.
export type CardBox = { x0: number; y0: number; cw: number; ch: number; u: number; pad: number; innerW: number; sp: Space };
/** The card occupying the slot whose top-left is (ox, oy). */
export function cardBoxAt(ox: number, oy: number, s: SheetGeom): CardBox {
  const u = s.unit, gap = CARD_GAP * u, pad = CARD_PAD * u;
  const x0 = ox + gap, y0 = oy + gap, cw = s.slotW - gap * 2, ch = s.slotH - gap * 2;
  return { x0, y0, cw, ch, u, pad, innerW: cw - pad * 2, sp: { w: cw, h: ch, ox: x0, oy: y0 } };
}
/** Put a block's CENTRE on the card, keeping its whole footprint inside the card's quiet margin.
 *
 *  A Box is a fraction of the card, but the thing it positions is sized in paper-scaled px — so
 *  the same fraction that sits an A6 card's QR neatly above its bottom margin hangs an A5 card's
 *  larger QR over the edge. Clamping here rather than at the defaults means it holds for a dragged
 *  position too, and the drag outline follows because it measures the same rects. */
export function placeOnCard(g: CardBox, box: Box, w: number, h: number): { x: number; y: number } {
  const lox = g.pad + w / 2, hix = g.cw - g.pad - w / 2;
  const loy = g.pad + h / 2, hiy = g.ch - g.pad - h / 2;
  return {
    x: g.sp.ox + (lox <= hix ? clamp(box.x * g.cw, lox, hix) : g.cw / 2),
    y: g.sp.oy + (loy <= hiy ? clamp(box.y * g.ch, loy, hiy) : g.ch / 2),
  };
}
/** The card identifier printed with the title — suppressed entirely when the host turns it off,
 *  and pointless when there is only one set to confuse it with. */
export const cardLabelFor = (set: CardSet | null, o: CardRenderOpts): string =>
  o.ids && o.setCount > 1 && set ? set.label.toUpperCase() : '';

// `px` and `lh` are the size the face ACTUALLY draws at and its own line height — a script sets
// much smaller than a sans for the same requested px, so measuring at one and drawing at the other
// is how a title ends up overlapping the rule under it.
export type TitleGeom = { rect: Rect; size: number; px: number; lh: number; lines: string[]; labelSize: number; label: string };
export function titleGeom(ctx: CanvasRenderingContext2D, g: CardBox, set: CardSet | null, o: CardRenderOpts): TitleGeom {
  const layout = cardDesignFor(set, o).layout;
  const face = titleFaceFor(o), family = bodyFamilyFor(o);
  const size = layout.title.size * g.u, labelSize = o.labelSize * g.u, label = cardLabelFor(set, o);
  const px = applyFace(ctx, face, size);
  const lh = px * face.lineHeight;
  // Two lines at most: past that there is no card left for the tricks.
  const lines = wrapToLines(ctx, castFor(face, o.heading), g.innerW).slice(0, 2);
  let w = 0;
  for (const ln of lines) w = Math.max(w, ctx.measureText(ln).width);
  clearTracking(ctx);
  if (label) { ctx.font = `700 ${labelSize}px ${family}`; w = Math.max(w, ctx.measureText(label).width); }
  w = Math.min(w, g.innerW);
  const h = lines.length * lh + (label ? labelSize * 1.5 : 0);
  const c = placeOnCard(g, layout.title, w, h);
  return { rect: { x: c.x - w / 2, y: c.y - h / 2, w, h }, size, px, lh, lines, labelSize, label };
}

// The join block — QR, "Scan to join" + the code/link, and the caption — moves and resizes as ONE
// thing, because a QR that drifts away from the link beside it is two orphans rather than a block.
/** The trick list's region, row height and text size.
 *
 *  Pulled out of drawCard so the designer can outline and resize the list the way it already can
 *  the title and the join block. Both callers run the SAME arithmetic: an outline measured one way
 *  and a list drawn another is how a block ends up being dragged somewhere it is not.
 *
 *  The region is still decided by what the title and the join block leave — the list is not
 *  positionable, because there is nowhere for it to go that is not through one of them. What IS
 *  the host's is the text size: `layout.list.size` overrides the fitted one, clamped so it can
 *  neither spill off the card nor shrink below legible.
 */
export type ListGeom = { rect: Rect; fs: number; rowH: number; n: number };
export function listGeom(
  ctx: CanvasRenderingContext2D, g: CardBox, set: CardSet | null, o: CardRenderOpts,
  t: TitleGeom, j: JoinGeom, ruleY: number,
): ListGeom {
  const { x0, y0, cw, ch, u, pad, innerW } = g;
  const family = bodyFamilyFor(o);
  const layout = cardDesignFor(set, o).layout;
  const items = set?.items ?? [];
  const n = items.length;
  let top = ruleY + 20 * u, bottom = y0 + ch - pad;
  if (j) {
    // The camera motif draws a body reaching ABOVE the QR, so the list has to stop that much
    // higher — otherwise the body is drawn straight through the last line of the list.
    const decorTop = o.decorKind === 'camera' && j.qr
      ? cameraMargin(j.qr, { x: x0, y: y0, w: cw, h: ch }, u, o.decorScale) * CAMERA_TOP : 0;
    // Normally the join block is below the title and caps the list; a host who drags it above the
    // title instead gets the list below BOTH rather than printed through the QR.
    if (j.rect.y >= t.rect.y + t.rect.h) bottom = Math.min(bottom, j.rect.y - 20 * u - decorTop);
    else top = Math.max(top, j.rect.y + j.rect.h + 20 * u);
  }
  if (bottom - top < 60 * u) bottom = top + 60 * u;
  // The cap only bites on a short list: it stops five tricks being squeezed into the top third of
  // the card, while leaving a generous row you can actually put a pen through.
  const rowH = clamp((bottom - top) / Math.max(n, 1), 17 * u, 56 * u);
  // ONE font size for every row — fitting each row on its own leaves the list visually ragged.
  // Text width scales linearly with font size for a given string, so the widest is measured once
  // at a reference size; the tick column is 1.5em and the gap after it 0.5em, hence innerW − 2em.
  ctx.font = `400 100px ${family}`;
  const perPx = Math.max(...items.map((it) => ctx.measureText(it.text).width), 1) / 100;
  // The widest this list can be set without a trick wrapping, and the tallest that still leaves
  // every row inside the region. Both are hard limits: past either, the card stops printing what
  // the host laid out.
  const fits = Math.floor(innerW / (perPx + 2));
  const roomy = n ? Math.floor((bottom - top) / n * 0.56) : fits;
  const auto = Math.max(11 * u, Math.min(Math.round(rowH * 0.56), 21 * u, fits));
  const wanted = layout.list.size > LIST_AUTO ? layout.list.size * u : auto;
  const fs = clamp(wanted, 11 * u, Math.max(11 * u, Math.min(fits, roomy)));
  const blockH = Math.min(rowH * n, bottom - top);
  // Centred in whatever the title and the join block have left — then moved by however far the host
  // has dragged it. The nudge is measured from the DEFAULT rather than read as an absolute position,
  // which is what keeps every card designed before the list could move where it has always been.
  // Clamped to the region at both ends: the whole reason this was refused for so long is that a
  // list free to go anywhere goes through the QR, and a card that cannot be printed is worse than
  // one that cannot be rearranged.
  const dy = (layout.list.y - DEFAULT_CARD_LAYOUT.list.y) * ch;
  const ry = clamp(top + Math.max(0, (bottom - top - blockH) / 2) + dy, top, Math.max(top, bottom - blockH));
  return { rect: { x: x0 + pad, y: ry, w: innerW, h: blockH }, fs, rowH, n };
}

export type JoinGeom = { rect: Rect; qr: Rect | null; tx: number; tw: number; ts: number; capLines: string[] } | null;
// Takes the SET for the same reason titleGeom does: the join block's size is part of a card's
// own layout once the cards stop being copies of each other.
export function joinGeom(ctx: CanvasRenderingContext2D, g: CardBox, set: CardSet | null, o: CardRenderOpts): JoinGeom {
  const layout = cardDesignFor(set, o).layout;
  const family = bodyFamilyFor(o);
  const qrPx = o.showQr ? layout.qr.size * g.u : 0;
  // Resizing the block scales its text with the QR, but only so far: the point of the block is the
  // code, and the caption beside it should not end up shouting over the trick list.
  const ts = clamp(layout.qr.size / CARD_QR_PX, 0.7, 1.6) * g.u;
  // The camera motif wraps a body round the QR, so the text beside it has to start outside that
  // body rather than on top of it. The desired margin is used rather than the fitted one because
  // the fitted one depends on where this block ends up, which is what we are working out.
  const camGap = o.decorKind === 'camera' && qrPx ? Math.max(13 * g.u, qrPx * 0.16) * Math.min(o.decorScale, 1.25) : 0;
  const gap = 24 * g.u + camGap;
  const showCode = o.showLink;
  const caption = o.caption.trim();
  const maxTextW = g.innerW - (qrPx ? qrPx + gap : 0);
  let tw = 0, th = 0;
  let capLines: string[] = [];
  if (o.showLink) { ctx.font = `700 ${20 * ts}px ${family}`; tw = Math.max(tw, ctx.measureText('Scan to join').width); th += 30 * ts; }
  if (showCode) {
    if (o.codeMode === 'code') { ctx.font = `800 ${34 * ts}px ${CARD_MONO}`; tw = Math.max(tw, ctx.measureText(o.joinCode).width); th += 48 * ts; }
    else { ctx.font = `700 ${21 * ts}px ${family}`; tw = Math.max(tw, ctx.measureText(o.cleanUrl).width); th += 58 * ts; }
  }
  if (caption) {
    ctx.font = `400 ${18 * ts}px ${family}`;
    capLines = wrapToLines(ctx, caption, Math.max(60, maxTextW));
    for (const ln of capLines) tw = Math.max(tw, ctx.measureText(ln).width);
    th += capLines.length * 23 * ts;
  }
  tw = Math.min(tw, Math.max(0, maxTextW));
  // Everything off is a card with no join block at all — a pure shot list, which is a legitimate
  // thing to print when the QR is already on the poster on the wall.
  if (!qrPx && !tw) return null;
  const w = Math.min(g.innerW, (qrPx ? qrPx + (tw ? gap : 0) : 0) + tw);
  const h = Math.max(qrPx, th + 8 * ts);
  const c = placeOnCard(g, layout.qr, w, h);
  const x = c.x - w / 2, y = c.y - h / 2;
  return {
    rect: { x, y, w, h },
    qr: qrPx ? { x, y: y + (h - qrPx) / 2, w: qrPx, h: qrPx } : null,
    tx: x + (qrPx ? qrPx + gap : 0), tw, ts, capLines,
  };
}

/** One card, top-left of its SLOT at (ox, oy). Every card on a sheet is identical — they go to
 *  different people. */
export function drawCard(
  ctx: CanvasRenderingContext2D,
  set: CardSet,
  a: { ox: number; oy: number; sheet: SheetGeom; qrImage: HTMLImageElement; bg: HTMLImageElement | null },
  o: CardRenderOpts,
) {
  const g = cardBoxAt(a.ox, a.oy, a.sheet);
  const { x0, y0, cw, ch, u, pad, innerW } = g;
  const family = bodyFamilyFor(o), face = titleFaceFor(o);
  // THIS card's colours, not the previewed card's. Every sheet is a page of one set, so reading a
  // reactive `cardInk` off the component here would print the whole stack in whatever was last on
  // screen — and there is no component to read one off any more, which is most of the point.
  const paint = cardPaintFor(set, o);
  const cardInk = paint.ink;
  // Square corners are an option because a rounded card cannot be cut with a guillotine: the edge
  // no longer matches the cut line, so a host trimming a stack has to round every corner by hand.
  const r = o.round ? 22 * u : 0;
  // Background inside the card's own edge. An image is covered into EACH card rather than across
  // the sheet, so the cards look the same instead of showing different crops of one photo.
  ctx.save();
  roundRect(ctx, x0, y0, cw, ch, r); ctx.clip();
  if (a.bg) { ctx.translate(x0, y0); drawCover(ctx, a.bg, cw, ch); ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, cw, ch); }
  else { ctx.fillStyle = paint.bgHex; ctx.fillRect(x0, y0, cw, ch); }
  ctx.restore();
  /* The card's own edge is a CUT MARK, so it answers to the cut-guide switch like the dashed
     guides do. Four-up, the borders of neighbouring cards meet along each tile boundary and read as
     one solid rule down the paper — so turning the guides off left the very lines they were turned
     off to remove, just solid instead of dashed.
     Except on a full-page card, where the switch is disabled (there is nothing to cut apart) and so
     carries whatever value it last held. There the edge is the only thing showing where the card
     stops, and it stays. */
  if (o.cutLines !== false || o.cardsPerSheet === 1) {
    roundRect(ctx, x0, y0, cw, ch, r); ctx.strokeStyle = cardInk.rule; ctx.lineWidth = 1.5 * u; ctx.stroke();
  }

  const t = titleGeom(ctx, g, set, o);
  const j = joinGeom(ctx, g, set, o);

  // Decoration first, so the card's own text always sits on top of the line art rather than
  // fighting it. The camera motif needs the QR square, which is why the geometry comes first.
  drawDecor(ctx, {
    // The decoration is one choice for the whole set — only the colours and the arrangement are
    // per card — but its INK still falls back to this card's title colour rather than the
    // previewed card's.
    kind: o.decorKind, pos: o.decorPos, scale: o.decorScale, colour: o.decorColour || cardInk.title, unit: u,
    card: { x: x0, y: y0, w: cw, h: ch }, qr: j?.qr ?? null,
  });

  // ── Title block (free position) ──
  let ty = t.rect.y;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const tcx = t.rect.x + t.rect.w / 2;
  // Above or below, never both, and the block is the same HEIGHT either way — titleGeom already
  // reserved labelSize * 1.5 for it, so the rule under the title and the trick list below do not
  // move when the side changes. Under the title the glyph is dropped 0.4 of its own size first,
  // which is the gap that stops it reading as a fourth line of the heading.
  const drawCardLabel = (yTop: number) => {
    ctx.fillStyle = cardInk.muted; ctx.font = `700 ${t.labelSize}px ${family}`;
    ctx.fillText(t.label, tcx, yTop);
  };
  if (t.label && o.labelPos === 'above') { drawCardLabel(ty); ty += t.labelSize * 1.5; }
  ctx.fillStyle = cardInk.title;
  applyFace(ctx, face, t.size);
  for (const ln of t.lines) { ctx.fillText(ln, tcx, ty); ty += t.lh; }
  clearTracking(ctx);
  if (t.label && o.labelPos === 'below') drawCardLabel(ty + t.labelSize * 0.4);
  const ruleY = t.rect.y + t.rect.h + 10 * u;
  ctx.fillStyle = cardInk.rule; ctx.fillRect(x0 + pad, ruleY, innerW, 1.5 * u);

  // ── Trick list ──
  const lg = listGeom(ctx, g, set, o, t, j, ruleY);
  const L = x0 + pad;
  const { fs, rowH, n } = lg;
  let ry = lg.rect.y;
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const cy = ry + rowH / 2;
    ctx.font = `400 ${fs}px ${family}`;
    // The tick carries the event's accent (paint.tickInk); the trick text stays plain body ink, so
    // the list still reads as a list. An emoji tick is painted in colour by the device's own font
    // and ignores the fill entirely — see tickIsEmoji in the designer, which warns the host up
    // front rather than letting them discover it at the printer.
    ctx.fillStyle = paint.tickInk;
    ctx.textAlign = 'center'; ctx.fillText(o.glyph, L + fs * 0.75, cy);
    ctx.fillStyle = cardInk.body;
    ctx.textAlign = 'left'; ctx.fillText(set.items[i].text, L + fs * 2, cy);
    // A dashed rule between rows, like the on-page card this stands in for.
    if (i < n - 1) {
      ctx.save(); ctx.setLineDash([4 * u, 5 * u]); ctx.strokeStyle = cardInk.rule; ctx.lineWidth = 1 * u;
      ctx.beginPath(); ctx.moveTo(L, ry + rowH); ctx.lineTo(L + innerW, ry + rowH); ctx.stroke(); ctx.restore();
    }
    ry += rowH;
  }

  // ── Join block (free position): QR on the left, details beside it. The white panel guarantees
  // the code stays black-on-white whatever the card sits on, and matches the poster's QR panel. ──
  if (!j) return;
  if (j.qr) {
    const q = j.qr, m = 9 * u;
    ctx.fillStyle = '#ffffff'; roundRect(ctx, q.x - m, q.y - m, q.w + m * 2, q.h + m * 2, 14 * u); ctx.fill();
    ctx.imageSmoothingEnabled = false; ctx.drawImage(a.qrImage, q.x, q.y, q.w, q.h); ctx.imageSmoothingEnabled = true;
    drawBrandChip(ctx, q.x + q.w / 2, q.y + q.h / 2, q.w * 0.20);
  }
  if (!j.tw) return;
  const ts = j.ts;
  let jy = j.rect.y + 4 * ts;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  if (o.showLink) {
    ctx.fillStyle = cardInk.muted; ctx.font = `700 ${20 * ts}px ${family}`;
    ctx.fillText('Scan to join', j.tx, jy); jy += 30 * ts;
    ctx.fillStyle = cardInk.code;
    if (o.codeMode === 'code') { fitText(ctx, o.joinCode, j.tx, jy, j.tw, 800, 34 * ts, CARD_MONO); jy += 48 * ts; }
    else { drawUrl(ctx, o.cleanUrl, j.tx, jy, j.tw, 700, 21 * ts, family, 26 * ts); jy += 58 * ts; }
  }
  // What the card is FOR. Without this a guest has a list and no idea it is tickable in the app.
  ctx.fillStyle = cardInk.muted; ctx.font = `400 ${18 * ts}px ${family}`;
  for (const ln of j.capLines) { ctx.fillText(ln, j.tx, jy); jy += 23 * ts; }
}

/** Paint one set's sheet at CARD_SCALE, however many cards the host wants on it.
 *
 *  Takes the QR it is to print rather than resolving one: a sheet must carry ITS OWN set's code, or
 *  every card in the house sends guests to the set that happened to be on screen — and deciding
 *  which code that is means an authenticated fetch, which is the designer's job, not a renderer's.
 *  Same reasoning as drawPoster's `qrSrc`/`loadImage`. */
export async function drawSheet(
  ctx: CanvasRenderingContext2D,
  set: CardSet,
  o: CardRenderOpts & { qrSrc: string; loadImage?: (src: string) => Promise<HTMLImageElement> },
): Promise<void> {
  // Same reason drawPoster awaits it: ctx.font falls back to Arial silently, and a card sheet is
  // exported straight to a printer. The poster's own await does not cover this path.
  await ensurePosterFonts(o.typeSetKey);
  const load = o.loadImage ?? decode;
  const s = sheetGeom(o.cardsPerSheet, o.sheetLandscape);
  ctx.setTransform(CARD_SCALE, 0, 0, CARD_SCALE, 0, 0);
  // The sheet is paper: white, always. Each card paints its own background inside its cut line,
  // so an ink-saver sheet leaves the gutters unprinted (and a JPG/PDF export never goes black
  // where the canvas would otherwise be transparent).
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  let bg: HTMLImageElement | null = null;
  if (cardPaintFor(set, o).useImage && o.posterBgSrc) {
    try { bg = await load(o.posterBgSrc); } catch { bg = null; }
  }
  const qr = await load(o.qrSrc);
  for (let i = 0; i < o.cardsPerSheet; i++) {
    drawCard(ctx, set, { ox: (i % s.cols) * s.slotW, oy: Math.floor(i / s.cols) * s.slotH, sheet: s, qrImage: qr, bg }, o);
  }
  // Cut guides along the tile boundaries — and only there. A full-page card has nothing to cut, so
  // it gets no guide rather than a decorative line through the paper. Always dark: they are drawn
  // on the white sheet, not on a card.
  if (o.cardsPerSheet > 1 && o.cutLines !== false) {
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.setLineDash([9, 9]);
    ctx.beginPath();
    if (s.cols > 1) { ctx.moveTo(s.slotW, 0); ctx.lineTo(s.slotW, H); }
    ctx.moveTo(0, s.slotH); ctx.lineTo(W, s.slotH);
    ctx.stroke();
    ctx.restore();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

const decode = (src: string): Promise<HTMLImageElement> =>
  new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
