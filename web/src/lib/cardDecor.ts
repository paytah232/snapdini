// ── Card decorations ────────────────────────────────────────────────────────
//
// The line art a real table card carries: a bow tie on a corporate place card, two swallows on a
// wedding one, a border, confetti, clinking glasses. It is what makes a printed card look made
// rather than generated, and it costs nothing but a few canvas paths.
//
// VECTOR, deliberately. An image asset would mean a second network fetch inside a canvas that is
// about to be exported and printed — a half-loaded PNG is a card with a hole in it — and it would
// taint the canvas for toBlob() the moment it came from anywhere but our own origin. Paths also
// scale to any paper size and print as line art rather than as a resampled bitmap.
//
// Everything here draws INTO A RECT it is handed and touches nothing else, so the same motifs work
// on an A6 card, an A5 one or an A4 sheet. Sizes are multiplied by `unit` (1 = A6) so a motif on a
// bigger card grows with the paper instead of shrinking into it.
//
// ── The house rules ─────────────────────────────────────────────────────────
// The first pass of these drew fine, and looked like clip art. Printed stationery has a small,
// unanimous set of rules for why one line drawing reads as engraved and the next reads as free
// vector art, and every motif below is drawn to them:
//
//   · TWO WEIGHTS, NEVER THREE. A hairline carries the structure and ONE heavier line carries the
//     shape the eye is meant to land on. That single contrast is what letterpress gets from a
//     debossed rule beside fine type, and it is most of the distance between "drawn" and "traced".
//   · MONOLINE. Within a weight the stroke never varies. The pen is set from the PAPER, not from
//     the motif's size, so the host's size slider makes a motif larger and finer rather than
//     larger and fatter — which is the whole reason enlarged clip art looks cheap.
//   · ONE FOCAL FLOURISH. Every stationery guide says the same thing: the busy illustrated border
//     is what cheapens a card. So each arrangement is one thing with accents — a large element and
//     two much smaller ones, widely spaced — never a row of equals.
//   · SYMMETRY, OR A DELIBERATE DIAGONAL. Never a sprinkle. The corner set is mirrored so the four
//     corners read as one frame; the scattered kinds are laid on a jittered grid so they cannot
//     clump into a blot or leave a bald patch.
//   · NEGATIVE SPACE IS THE DECORATION. Counts went down and gaps went up in every motif here.
//
// And one rule that is ours rather than the stationer's: STROKE ONLY, no solid fills. These are
// printed, often on a home inkjet, and a filled shape is both uglier and dearer than an outline.

export type DecorKind = 'none' | 'frame' | 'bows' | 'birds' | 'glasses' | 'confetti' | 'stars' | 'camera'
  | 'botanical' | 'deco' | 'rings' | 'cameraline' | 'wave' | 'hearts' | 'heartlens';
/** Where a motif sits. Only the scattered/repeatable kinds use it — a border is already everywhere
 *  and the camera is pinned to the QR. */
export type DecorPos = 'top' | 'corners' | 'both';

export type Rect = { x: number; y: number; w: number; h: number };

/** `positional` = the position control means something for this kind (see DecorPos). */
export const DECOR_KINDS: { key: DecorKind; label: string; positional: boolean }[] = [
  { key: 'none',      label: 'None',            positional: false },
  { key: 'frame',     label: 'Border',          positional: false },
  // The same job as 'frame' in a different hand. 'frame' is engraved — straight rules, mitred
  // corners, a lozenge — and half the signs this set is drawn from are not engraved at all, they
  // are drawn with a marker. A wobbly rule is what carries that, and nothing else here does.
  { key: 'wave',      label: 'Wavy border',     positional: false },
  // Relabelled, not redrawn: the drawing is a black-tie signal, and "Bow ties" made it sound like
  // an accessory rather than an occasion — which is why it was being used as the CORPORATE default,
  // where it says formal dinner rather than conference.
  { key: 'bows',      label: 'Black tie',       positional: true },
  { key: 'birds',     label: 'Birds',           positional: true },
  { key: 'glasses',   label: 'Glasses',         positional: true },
  { key: 'confetti',  label: 'Confetti',        positional: true },
  { key: 'stars',     label: 'Sparkles',        positional: true },
  // Added later, from a look at what real invitation suites actually carry: a botanical sprig is
  // the single most common minimalist motif in the category and we had nothing like it, deco is
  // the other whole vocabulary (geometry rather than nature), and rings is the mark every wedding
  // and engagement suite reaches for.
  { key: 'botanical', label: 'Sprig',           positional: true },
  { key: 'deco',      label: 'Art deco',        positional: true },
  { key: 'rings',     label: 'Rings',           positional: true },
  // Drawn as an open stroke, never as the filled glyph: a solid heart is the one mark that makes a
  // printed sign look typed rather than made, and it is also the most ink any motif here could
  // possibly ask an inkjet for.
  { key: 'hearts',    label: 'Hearts',          positional: true },
  { key: 'camera',    label: 'Camera (round the QR)', positional: false },
  // The same subject drawn the other way: not a frame around the QR but a single continuous line,
  // the way a one-line illustration is drawn. It is a motif rather than a surround, so unlike
  // 'camera' it takes a position.
  { key: 'cameraline', label: 'Camera (one line)',    positional: true },
  // A third camera, and it earns the slot: a heart cannot be drawn into 'cameraline' at all, since
  // that motif's lens IS the end of its single unbroken stroke, and 'camera' has no lens of its own
  // — the QR is its lens. So the one drawing every "scan for our photos" sign carries needed a
  // body of its own to sit in.
  { key: 'heartlens', label: 'Camera (heart lens)',  positional: true },
];

export const DECOR_POSITIONS: { key: DecorPos; label: string }[] = [
  { key: 'top', label: 'Top' },
  { key: 'corners', label: 'Corners' },
  { key: 'both', label: 'Both' },
];

/** The motif a host starts with for this event type — the same idea as the default tick glyph:
 *  the type only picks a sensible starting point, the host can change it or turn it off.
 *
 *  Deliberately unchanged when the new motifs landed: a host who never touched the control has a
 *  blank `decorKind` saved, so editing a value here would silently redecorate cards that are
 *  already printed and stuck to a wall. New motifs are offered, not imposed. */
export const DEFAULT_DECOR: Record<string, DecorKind> = {
  wedding: 'birds',
  engagement: 'glasses',
  hens: 'glasses',
  birthday: 'confetti',
  graduation: 'stars',
  christmas: 'stars',
  corporate: 'bows',
  'baby-shower': 'frame',
  general: 'frame',
};
export const decorFor = (eventType: string | null | undefined): DecorKind =>
  DEFAULT_DECOR[eventType ?? ''] ?? 'frame';

/** A motif the host has placed themselves. */
export type DecorPlacement = {
  kind: DecorKind;
  /** Centre, as a fraction of the rect (0–1). */
  x: number;
  y: number;
  scale: number;
  /** Radians. */
  rot: number;
  /** Blank = follow the design's decoration colour. */
  colour?: string;
};

export type DecorAtOpts = DecorPlacement & {
  colour: string;
  unit: number;
  card: { x: number; y: number; w: number; h: number };
};

export type DecorOpts = {
  kind: DecorKind;
  pos: DecorPos;
  /** Host multiplier, ~0.6–1.8. */
  scale: number;
  colour: string;
  /** Paper scale: 1 = A6, √2 = A5, 2 = A4 — so a motif keeps its physical size as the card grows. */
  unit: number;
  /** The card itself, in the current canvas space. */
  card: Rect;
  /** The QR square, for the camera motif. Null = no QR on this card, so the camera is skipped. */
  qr?: Rect | null;
};

// A fixed pseudo-random sequence. Confetti has to land in the same place on every redraw — it is
// re-drawn on every keystroke — or the preview would shimmer and the printed sheet would disagree
// with what the host approved.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── The pen ─────────────────────────────────────────────────────────────────
// Two weights and two tones, from one ink. `line()` is the motif's own contour; `hair()` is
// everything that supports it — inner rules, veins, bubbles, the far birds. Nothing gets a third
// weight, because the moment there are three the drawing stops reading as one hand.
//
// The width comes from `unit` (the paper) and only very weakly from `scale` (the host's slider):
// that exponent is what keeps the stroke monoline. At scale 1.8 the line is 22% heavier, not 80%
// heavier, so a big motif reads as a larger drawing rather than as a zoomed-in one.
type Pen = { hair(): void; line(): void };
/** The stroke widths, as numbers, so the two-weight rule can be TESTED rather than only described.
 *
 *  RESOLVED, with the numbers, because it has now been argued both ways:
 *
 *  A later review proposed clamping the stroke to a constant 1.4px instead of letting it grow with
 *  the host's size slider, on the grounds that one hand means one pen width. That is the right
 *  instinct and the wrong answer HERE, and the arithmetic says why. Line width as a fraction of the
 *  motif, across the slider's 0.6–1.8 range on an A6 card:
 *
 *      scale     0.6    0.8    1.0    1.4    1.8
 *      exponent  8.4%   7.0%   6.0%   4.9%   4.1%
 *      clamp     9.7%   7.3%   5.8%   4.2%   3.2%
 *
 *  The clamp is MORE extreme at both ends, and the end that matters is the small one: at scale 0.6
 *  the focal motif is about 9mm across on an A6 card, with internal detail already at the ~1.5mm
 *  floor where an inkjet gives up. Making the line 9.7% of the drawing there thickens exactly the
 *  case closest to blotting. The exponent is not a compromise on the monoline rule — it is what
 *  protects the fragile end while still giving "larger and finer" (8.4% down to 4.1%).
 *
 *  The genuine defect that review was reaching for was real, and was elsewhere: the two weights had
 *  collapsed from the designed 1.72:1 to 1.61:1 because of the hairline's absolute floor. That is
 *  fixed in hair() below. The exponent stays.
 *
 *  Note what DOES scale linearly and should: `unit`, the paper. An A4 poster is viewed from further
 *  away and its whole drawing is bigger, so it earns a heavier pen. The slider is the host's size
 *  preference within one sheet, which is a different thing.
 */
export function penWidths(unit: number, scale: number): { line: number; hair: number } {
  const base = Math.max(1, 1.45 * unit * Math.pow(scale, 0.35));
  return { line: base, hair: Math.max(0.72, base * 0.58) };
}

function makePen(ctx: CanvasRenderingContext2D, unit: number, scale: number): Pen {
  const base = penWidths(unit, scale).line;
  return {
    // The floor is 0.72, not 0.9, and the difference is the whole two-weight rule.
    //
    // At A6 and default scale `base` is 1.45, so the hairline WANTS 1.45 × 0.58 = 0.84. A 0.9 floor
    // overrode that and produced 1.45 : 0.90 = 1.61:1 — not the 1.72:1 the ratio was chosen to give
    // — and it got worse as the slider came down, reaching 1.35:1 at the bottom. Alpha still told
    // the two weights apart on screen, but ALPHA IS NOT WHAT SURVIVES AN INKJET; width is. So the
    // contrast this file's first house rule depends on was being quietly flattened exactly where it
    // is hardest to print: the smallest card at the smallest setting.
    //
    // 0.72 keeps the designed ratio from about scale 0.64 upward — the slider bottoms out at 0.6 —
    // so the floor now only bites at the very end of the range, which is what a floor is for.
    hair() { ctx.lineWidth = penWidths(unit, scale).hair; ctx.globalAlpha = 0.55; },
    line() { ctx.lineWidth = base; ctx.globalAlpha = 0.85; },
  };
}

// ── Small shared geometry ───────────────────────────────────────────────────

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath(); ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k); ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k); ctx.arcTo(x, y, x + w, y, k); ctx.closePath();
}

/** The lozenge that sits in a broken rule. Four points, not a circle: a dot is a full stop, a
 *  lozenge is punctuation. */
function diamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r * 0.62, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r * 0.62, cy);
  ctx.closePath();
}

/** Point on a cubic, one axis at a time. Leaves have to sit ON the stem rather than near it, and
 *  eyeballing their positions is exactly what makes a drawn branch look like scattered ticks. */
function cubicAt(a: number, b: number, c: number, d: number, t: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}
/** …and its tangent, so each leaf leans ALONG the stem instead of every leaf leaning the same way. */
function cubicTan(a: number, b: number, c: number, d: number, t: number): number {
  const u = 1 - t;
  return 3 * u * u * (b - a) + 6 * u * t * (c - b) + 3 * t * t * (d - c);
}

// ── Motifs. Each draws around (cx, cy) at nominal half-size `s`, stroke only. ──

/** A bow tie with the wings a real one has: swept top and bottom edges and a CONCAVE outer edge.
 *  The concave edge is the whole thing — two straight triangles either side of a box is the shape
 *  every clip-art bow tie has, and the pinched waist is what makes this one look tied. */
function bowTie(ctx: CanvasRenderingContext2D, p: Pen, cx: number, cy: number, s: number) {
  const kw = 0.155 * s, kh = 0.30 * s;
  p.line();
  for (const g of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + g * kw, cy - kh * 0.55);
    ctx.bezierCurveTo(cx + g * 0.44 * s, cy - 0.30 * s, cx + g * 0.80 * s, cy - 0.58 * s, cx + g * 1.00 * s, cy - 0.54 * s);
    ctx.quadraticCurveTo(cx + g * 0.84 * s, cy, cx + g * 1.00 * s, cy + 0.54 * s);
    ctx.bezierCurveTo(cx + g * 0.80 * s, cy + 0.58 * s, cx + g * 0.44 * s, cy + 0.30 * s, cx + g * kw, cy + kh * 0.55);
    ctx.closePath(); ctx.stroke();
  }
  rr(ctx, cx - kw, cy - kh, kw * 2, kh * 2, kw * 0.6); ctx.stroke();
  // The pleats: two hairlines gathering out of the knot into each wing. Silk, not cardboard.
  p.hair();
  for (const g of [-1, 1]) for (const d of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + g * kw * 1.05, cy + d * 0.10 * s);
    ctx.quadraticCurveTo(cx + g * 0.40 * s, cy + d * 0.24 * s, cx + g * 0.66 * s, cy + d * 0.40 * s);
    ctx.stroke();
  }
}

/** One bird. Each wing is a cubic whose SECOND control point sits ABOVE the tip, so the curve
 *  crests and settles into the tip instead of arriving straight — that little camber is the
 *  difference between a gull and a tick mark. The two wings are deliberately not mirror images
 *  either: a perfectly symmetric bird reads as a logo. */
function gull(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  ctx.beginPath();
  ctx.moveTo(cx - s, cy - 0.40 * s);
  ctx.bezierCurveTo(cx - 0.64 * s, cy - 0.54 * s, cx - 0.30 * s, cy - 0.30 * s, cx, cy + 0.04 * s);
  ctx.bezierCurveTo(cx + 0.24 * s, cy - 0.26 * s, cx + 0.56 * s, cy - 0.60 * s, cx + 0.86 * s, cy - 0.46 * s);
  ctx.stroke();
}
/** A flock: one bird the eye lands on and two smaller ones set well away from it on a rising
 *  diagonal, the far pair dropped to the hairline so they read as distance rather than as clutter. */
function birds(ctx: CanvasRenderingContext2D, p: Pen, cx: number, cy: number, s: number) {
  p.line(); gull(ctx, cx, cy, s);
  p.hair();
  ctx.save(); ctx.translate(cx - 1.85 * s, cy + 0.62 * s); ctx.rotate(0.16); gull(ctx, 0, 0, 0.58 * s); ctx.restore();
  ctx.save(); ctx.translate(cx + 1.70 * s, cy + 0.82 * s); ctx.rotate(-0.12); gull(ctx, 0, 0, 0.40 * s); ctx.restore();
}

/** One champagne flute, foot at (0,0), drawn upright then rotated by the caller.
 *  The rim and the foot are whole thin ELLIPSES rather than single arcs: an open arc reads flat,
 *  a closed ellipse reads as a glass seen slightly from above, which is how a glass is drawn. */
function flute(ctx: CanvasRenderingContext2D, p: Pen, s: number) {
  p.line();
  ctx.beginPath();                                              // bowl, both sides
  ctx.moveTo(-0.36 * s, -1.62 * s);
  ctx.bezierCurveTo(-0.30 * s, -1.10 * s, -0.12 * s, -0.82 * s, 0, -0.66 * s);
  ctx.bezierCurveTo(0.12 * s, -0.82 * s, 0.30 * s, -1.10 * s, 0.36 * s, -1.62 * s);
  ctx.stroke();
  ctx.beginPath(); ctx.ellipse(0, -1.62 * s, 0.36 * s, 0.085 * s, 0, 0, Math.PI * 2); ctx.stroke();
  p.hair();
  ctx.beginPath(); ctx.moveTo(0, -0.66 * s); ctx.lineTo(0, -0.09 * s); ctx.stroke();     // stem
  ctx.beginPath(); ctx.ellipse(0, -0.06 * s, 0.33 * s, 0.075 * s, 0, 0, Math.PI * 2); ctx.stroke();
  // The wine line, and three bubbles rising off it. Two marks that cost nothing and stop the bowl
  // reading as an empty glass outline.
  ctx.beginPath(); ctx.ellipse(0, -1.34 * s, 0.265 * s, 0.060 * s, 0, 0, Math.PI * 2); ctx.stroke();
  for (const [bx, by, br] of [[-0.09, -1.18, 0.030], [0.08, -1.04, 0.024], [-0.02, -0.90, 0.019]] as const) {
    ctx.beginPath(); ctx.arc(bx * s, by * s, br * s, 0, Math.PI * 2); ctx.stroke();
  }
}
/** Two flutes leaning in until the rims all but touch, with the clink above them. The feet stay a
 *  full glass apart and only the LEAN brings the rims together — any closer at the foot and the two
 *  bowls merge into one unreadable shape at card size. The rims are left a hair short of touching
 *  on purpose: two outlines crossing makes a muddle where a sliver of paper makes a clink. */
function glasses(ctx: CanvasRenderingContext2D, p: Pen, cx: number, cy: number, s: number) {
  const g = s * 0.86;
  for (const d of [-1, 1]) {
    ctx.save(); ctx.translate(cx + d * 0.86 * g, cy + 0.80 * g); ctx.rotate(-d * 0.27); flute(ctx, p, g); ctx.restore();
  }
  p.hair();
  for (const [a, l] of [[-Math.PI / 2, 0.40], [-Math.PI / 2 - 0.75, 0.26], [-Math.PI / 2 + 0.75, 0.26]] as const) {
    const x0 = cx + Math.cos(a) * g * 0.16, y0 = cy - 0.80 * g + Math.sin(a) * g * 0.16;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + Math.cos(a) * g * l, y0 + Math.sin(a) * g * l); ctx.stroke();
  }
}

/** The four-point sparkle. CUBICS with both control points pulled almost onto the centre lines —
 *  that is what pinches the waist hard enough to give needle points; the quadratic version of this
 *  shape is a rounded star, which is a different and much softer thing. */
function sparkle(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  const w = 0.10 * s;
  ctx.beginPath();
  ctx.moveTo(cx, cy - s);
  ctx.bezierCurveTo(cx, cy - w, cx + w, cy, cx + s, cy);
  ctx.bezierCurveTo(cx + w, cy, cx, cy + w, cx, cy + s);
  ctx.bezierCurveTo(cx, cy + w, cx - w, cy, cx - s, cy);
  ctx.bezierCurveTo(cx - w, cy, cx, cy - w, cx, cy - s);
  ctx.closePath(); ctx.stroke();
}
/** The smallest accent in the set: a bare cross of light, no outline at all. */
function twinkle(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  ctx.beginPath(); ctx.moveTo(cx - s, cy); ctx.lineTo(cx + s, cy);
  ctx.moveTo(cx, cy - s); ctx.lineTo(cx, cy + s); ctx.stroke();
}
function stars(ctx: CanvasRenderingContext2D, p: Pen, cx: number, cy: number, s: number) {
  p.line(); sparkle(ctx, cx, cy, s);
  p.hair();
  sparkle(ctx, cx - 1.62 * s, cy + 0.30 * s, 0.38 * s);
  sparkle(ctx, cx + 1.48 * s, cy + 0.52 * s, 0.26 * s);
  twinkle(ctx, cx + 0.98 * s, cy - 0.72 * s, 0.15 * s);
  twinkle(ctx, cx - 0.86 * s, cy + 0.86 * s, 0.11 * s);
}

/** Confetti scattered inside a band: short strokes, rings and open lozenges, never a solid fill —
 *  a card is printed, and a page of solid dots is a page of ink.
 *
 *  The pieces are placed on a JITTERED GRID rather than at free random points. Free random points
 *  clump: on a strip this small you reliably get two pieces touching and a bald patch beside them,
 *  and both read as a mistake. Stratifying the band into n cells and jittering inside each one
 *  keeps the spacing even while leaving it irregular, which is the whole trick — and it stays
 *  seeded, so the preview does not shimmer between redraws. */
function confetti(ctx: CanvasRenderingContext2D, p: Pen, r: Rect, s: number, seed: number, n: number) {
  const rand = rng(seed);
  // Cells as close to square as the band allows, so the jitter has room in both axes.
  const cols = Math.max(1, Math.round(Math.sqrt((n * r.w) / Math.max(r.h, 1))));
  const rows = Math.max(1, Math.ceil(n / cols));
  const cw = r.w / cols, chh = r.h / rows;
  let i = 0;
  for (let gy = 0; gy < rows && i < n; gy++) for (let gx = 0; gx < cols && i < n; gx++, i++) {
    const x = r.x + (gx + 0.18 + rand() * 0.64) * cw;
    const y = r.y + (gy + 0.18 + rand() * 0.64) * chh;
    // Pieces shrink down the band, so the drift has a near edge and a far one instead of reading
    // as a flat texture.
    const fade = 1 - 0.34 * ((y - r.y) / Math.max(r.h, 1));
    const a = rand() * Math.PI, k = i % 3, z = s * (0.21 + rand() * 0.19) * fade;
    // Half the pieces at the hairline: the tonal mix is what makes a scatter look like it has depth
    // instead of looking like a texture swatch.
    if (rand() < 0.5) p.hair(); else p.line();
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    ctx.beginPath();
    if (k === 0) { ctx.moveTo(-z, 0); ctx.lineTo(z, 0); }
    else if (k === 1) { ctx.arc(0, 0, z * 0.52, 0, Math.PI * 2); }
    else { diamond(ctx, 0, 0, z * 0.78); }
    ctx.stroke(); ctx.restore();
  }
}

/** One leaf: an almond drawn as two mirrored quadratics out to the tip and back. Both halves share
 *  one bulge, so the leaf stays symmetric about its own spine at whatever angle it is planted. */
function leaf(ctx: CanvasRenderingContext2D, x: number, y: number, a: number, len: number, wid: number) {
  const ca = Math.cos(a), sa = Math.sin(a);
  const mx = x + ca * len * 0.45, my = y + sa * len * 0.45;
  const px = -sa * wid, py = ca * wid;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(mx + px, my + py, x + ca * len, y + sa * len);
  ctx.quadraticCurveTo(mx - px, my - py, x, y);
  ctx.stroke();
}

/** An olive sprig: one stem in the heavier weight, everything growing off it at the hairline. Base
 *  at (x, y), arcing up and to the right over a span of `L`. Mirror it with a negative x scale. */
function sprig(ctx: CanvasRenderingContext2D, p: Pen, x: number, y: number, L: number) {
  const X = [x, x + 0.34 * L, x + 0.72 * L, x + 1.00 * L];
  const Y = [y, y - 0.05 * L, y - 0.26 * L, y - 0.60 * L];
  p.line();
  ctx.beginPath(); ctx.moveTo(X[0], Y[0]); ctx.bezierCurveTo(X[1], Y[1], X[2], Y[2], X[3], Y[3]); ctx.stroke();

  p.hair();
  const N = 7;
  for (let i = 0; i < N; i++) {
    const t = 0.10 + (i / (N - 1)) * 0.80;
    const px = cubicAt(X[0], X[1], X[2], X[3], t), py = cubicAt(Y[0], Y[1], Y[2], Y[3], t);
    const a = Math.atan2(cubicTan(Y[0], Y[1], Y[2], Y[3], t), cubicTan(X[0], X[1], X[2], X[3], t));
    // Alternating sides, shrinking toward the tip, every leaf leaning forward along the stem. All
    // three together are what stop a row of leaves reading as the teeth of a comb.
    const len = L * 0.30 * (1 - 0.42 * t);
    leaf(ctx, px, py, a + (i % 2 ? 1 : -1) * 0.82, len, len * 0.30);
  }
  const tipA = Math.atan2(cubicTan(Y[0], Y[1], Y[2], Y[3], 1), cubicTan(X[0], X[1], X[2], X[3], 1));
  leaf(ctx, X[3], Y[3], tipA, L * 0.20, L * 0.058);
  // Two olives low on the branch — the one spot of weight in the motif, and what keeps a sprig of
  // outlines from floating off the card.
  p.line();
  for (const [t, side] of [[0.24, 1], [0.42, -1]] as const) {
    const px = cubicAt(X[0], X[1], X[2], X[3], t), py = cubicAt(Y[0], Y[1], Y[2], Y[3], t);
    const a = Math.atan2(cubicTan(Y[0], Y[1], Y[2], Y[3], t), cubicTan(X[0], X[1], X[2], X[3], t)) + side * 1.4;
    const r = L * 0.050, ox = px + Math.cos(a) * L * 0.125, oy = py + Math.sin(a) * L * 0.125;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(ox - Math.cos(a) * r, oy - Math.sin(a) * r); ctx.stroke();
    ctx.beginPath(); ctx.arc(ox, oy, r, 0, Math.PI * 2); ctx.stroke();
  }
}
/** Two sprigs from one point, opening upward and outward — the open half-wreath that sits over a
 *  name on half the invitations ever printed. Open, not closed: the gap at the top is the point. */
function sprigPair(ctx: CanvasRenderingContext2D, p: Pen, cx: number, cy: number, s: number) {
  const L = s * 1.45;
  for (const d of [1, -1]) {
    ctx.save(); ctx.translate(cx, cy); ctx.scale(d, 1); sprig(ctx, p, 0.05 * L, 0, L); ctx.restore();
  }
}

/** The deco fan: a half rosette seated on one long hairline rule, with a small lozenge closing
 *  each end of it. Straight out of the 1925 vocabulary — radiating ribs, strict symmetry, nothing
 *  organic anywhere. The long thin rule IS the composition; the fan is the one heavy thing on it.
 *
 *  The ribs stop at an inner arc rather than running to the centre. A real fan's ribs disappear
 *  into its rivet, and nine lines converging on one point at card size is a blot, not a rosette. */
function decoFan(ctx: CanvasRenderingContext2D, p: Pen, cx: number, cy: number, s: number) {
  p.hair();
  ctx.beginPath(); ctx.moveTo(cx - 2.3 * s, cy); ctx.lineTo(cx + 2.3 * s, cy); ctx.stroke();
  for (const d of [-1, 1]) { diamond(ctx, cx + d * 2.3 * s, cy, s * 0.12); ctx.stroke(); }
  const inner = 0.46;
  ctx.beginPath(); ctx.arc(cx, cy, s * inner, Math.PI, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, s * 0.15, Math.PI, Math.PI * 2); ctx.stroke();   // the rivet
  const N = 9;
  for (let i = 1; i < N; i++) {
    const a = Math.PI + (Math.PI * i) / N, ca = Math.cos(a), sa = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(cx + ca * s * inner, cy + sa * s * inner);
    ctx.lineTo(cx + ca * s, cy + sa * s);
    ctx.stroke();
  }
  p.line();
  ctx.beginPath(); ctx.arc(cx, cy, s, Math.PI, Math.PI * 2); ctx.stroke();
}
/** The deco corner: three nested right angles stepping in from the corner. Drawn with the arms
 *  getting SHORTER as they step inward, which is what makes it read as a mitred corner rather than
 *  as three concentric boxes with their sides rubbed out. */
function decoCorner(ctx: CanvasRenderingContext2D, p: Pen, s: number) {
  const step = s * 0.22;
  for (let i = 0; i < 3; i++) {
    if (i === 1) p.line(); else p.hair();      // the middle rule is the heavy one, as a mitre is
    const o = i * step, arm = s * (1.55 - i * 0.34);
    ctx.beginPath();
    ctx.moveTo(o + arm, o); ctx.lineTo(o, o); ctx.lineTo(o, o + arm);
    ctx.stroke();
  }
}

/** Two interlocking bands.
 *
 *  The interlock is the trick: on a canvas we cannot rub a line out, so each ring is drawn with a
 *  small ANGULAR GAP at the one crossing where the other ring passes in front of it. The eye fills
 *  the gap in and reads the two as linked — the same device a line-art Olympic rings uses. The gap
 *  angles are computed, not eyeballed: for two circles of radius r whose centres are d apart, the
 *  crossings sit at ±acos(d/2r) from the line of centres. */
function rings(ctx: CanvasRenderingContext2D, p: Pen, cx: number, cy: number, s: number) {
  const r = s * 0.66, d = r * 1.18;
  const th = Math.acos(Math.min(1, d / (2 * r)));
  const g = 0.20;                              // half the gap, radians — wide enough to read at A6
  p.line();
  // Left ring: in front at the top crossing, so its gap is at the BOTTOM one (+th, canvas y down).
  ctx.beginPath(); ctx.arc(cx - d / 2, cy, r, th + g, th - g + Math.PI * 2); ctx.stroke();
  // Right ring: the mirror — behind at the top crossing, which from its own centre is at π+th.
  ctx.beginPath(); ctx.arc(cx + d / 2, cy, r, Math.PI + th + g, Math.PI + th - g + Math.PI * 2); ctx.stroke();
}

/** A rounded rect traced as ONE OPEN PATH with a gap left at the top and bottom centre, so a
 *  lozenge can sit in each break. An engraved invitation breaks its rule for the ornament rather
 *  than laying the ornament on top of it, and a rule drawn through a diamond looks like exactly
 *  what it is — two shapes that have not been introduced. */
function brokenRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, gap: number) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  const mx = x + w / 2, g = Math.min(gap, w * 0.4) / 2;
  ctx.beginPath();
  ctx.moveTo(mx + g, y);
  ctx.lineTo(x + w - k, y); ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.lineTo(x + w, y + h - k); ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.lineTo(mx + g, y + h);
  ctx.moveTo(mx - g, y + h);
  ctx.lineTo(x + k, y + h); ctx.arcTo(x, y + h, x, y, k);
  ctx.lineTo(x, y + k); ctx.arcTo(x, y, x + w, y, k);
  ctx.lineTo(mx - g, y);
}

/** The border: a hairline holding the paper's edge, one heavier rule inside it broken at the top
 *  and bottom centre for a lozenge, and a short bracket tucked into each corner. Three elements,
 *  two weights, and the rest of the card left alone. */
function frame(ctx: CanvasRenderingContext2D, p: Pen, card: Rect, unit: number, scale: number) {
  const span = Math.min(card.w, card.h);
  const m = Math.min(11 * unit * scale, span * 0.075);
  const g = Math.max(3.5 * unit, m * 0.42);
  p.hair();
  rr(ctx, card.x + m, card.y + m, card.w - m * 2, card.h - m * 2, 12 * unit); ctx.stroke();

  const x = card.x + m + g, y = card.y + m + g, w = card.w - (m + g) * 2, h = card.h - (m + g) * 2;
  const gap = Math.min(w * 0.11, 30 * unit * scale);
  // The lozenge straddles the rule, so half of it sticks out past the heavy rule toward the paper's
  // edge. Cap it against the margin it has to live in or a wide, short card prints half a diamond.
  const lz = Math.min(gap * 0.26, (m + g) * 0.55);
  p.line();
  brokenRect(ctx, x, y, w, h, 9 * unit, gap); ctx.stroke();
  for (const ly of [y, y + h]) { diamond(ctx, x + w / 2, ly, lz); ctx.stroke(); }

  // Corner brackets, inset from the heavy rule. Short — a sixteenth of the shorter side — because
  // a long one turns into a third border and the corners are meant to be a grace note.
  p.hair();
  const bi = g * 0.95, arm = span * 0.062;
  for (const [ox, oy, sx, sy] of [
    [x + bi, y + bi, 1, 1], [x + w - bi, y + bi, -1, 1],
    [x + bi, y + h - bi, 1, -1], [x + w - bi, y + h - bi, -1, -1],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(ox + sx * arm, oy); ctx.lineTo(ox, oy); ctx.lineTo(ox, oy + sy * arm);
    ctx.stroke();
  }
}

/** A point on a rounded rect addressed by DISTANCE travelled around its perimeter, plus the
 *  outward normal there.
 *
 *  A wobble is an offset along the normal, so it needs the path as one continuous parameter — not
 *  as four sides and four corners. Wobbling each side separately and then joining them leaves a
 *  kink at every corner where the two offsets disagree, which is the one artefact that reads as a
 *  bug rather than as a hand. Arc length also keeps the lobes the same LENGTH on a short edge as on
 *  a long one; parameterising by t-per-side would stretch them on the long sides of a portrait
 *  card. */
function rrAt(x: number, y: number, w: number, h: number, r: number, t: number):
  { x: number; y: number; nx: number; ny: number } {
  const sw = Math.max(0, w - 2 * r), sh = Math.max(0, h - 2 * r), arc = (Math.PI / 2) * r;
  const segs = [sw, arc, sh, arc, sw, arc, sh, arc];
  let u = t, i = 0;
  while (i < 7 && u > segs[i]) { u -= segs[i]; i++; }
  const a = (from: number) => from + u / Math.max(r, 1e-6);
  const on = (cx: number, cy: number, ang: number) =>
    ({ x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r, nx: Math.cos(ang), ny: Math.sin(ang) });
  switch (i) {
    case 0: return { x: x + r + u, y, nx: 0, ny: -1 };
    case 1: return on(x + w - r, y + r, a(-Math.PI / 2));
    case 2: return { x: x + w, y: y + r + u, nx: 1, ny: 0 };
    case 3: return on(x + w - r, y + h - r, a(0));
    case 4: return { x: x + w - r - u, y: y + h, nx: 0, ny: 1 };
    case 5: return on(x + r, y + h - r, a(Math.PI / 2));
    case 6: return { x, y: y + h - r - u, nx: -1, ny: 0 };
    default: return on(x + r, y + r, a(Math.PI));
  }
}

/** The drawn border: one continuous sinuous line round a rounded rect, four or five gentle lobes to
 *  an edge, no fill and nothing inside it.
 *
 *  THE WOBBLE IS ABSOLUTE, and that is the whole motif. Its amplitude comes from `unit` — the
 *  paper — and never from the rect, because a hand drawing a box round an A4 sheet wobbles by the
 *  same couple of millimetres it wobbles by on a card; only the number of wobbles goes up. Taking
 *  the amplitude from the rect instead would give the A4 sheet a wobble three times as deep, which
 *  is precisely what a scaled-up graphic looks like and precisely what this motif exists to avoid.
 *
 *  The lobe COUNT does come from the rect, and is then rounded to a whole number of cycles around
 *  the perimeter. The rounding is not cosmetic: a fractional count leaves the line arriving back at
 *  its start out of phase, so the one place a closed border must be seamless gets a visible step.
 *
 *  One weight, like the one-line camera and for the same reason — there is no supporting structure
 *  here for a hairline to carry, and a border that changed weight halfway round would stop reading
 *  as one pen. */
function waveBorder(ctx: CanvasRenderingContext2D, p: Pen, card: Rect, unit: number, scale: number) {
  const amp = 3.2 * unit;
  // The inset is capped tighter than frame()'s, and the CORNER is why. A border's deepest point
  // relative to the card's content box is not on the sides, where it is inset + amp, but on the
  // corner diagonal, where the rounding pulls it a further r(1 − 1/√2) inward. At the top of the
  // size slider that difference is worth about 9 units, which is the whole of the clearance left in
  // the card's 34-unit text padding — so sized by its sides alone this border prints through the
  // corner of the title block. Capped here, the diagonal lands at ~31 at every scale.
  const inset = Math.min(13 * unit * scale, Math.min(card.w, card.h) * 0.06) + amp;
  const x = card.x + inset, y = card.y + inset, w = card.w - inset * 2, h = card.h - inset * 2;
  if (w <= 4 * unit || h <= 4 * unit) return;

  const span = Math.min(w, h);
  const r = Math.min(22 * unit, span * 0.10);   // the card's own corner radius, near enough
  const P = 2 * Math.max(0, w - 2 * r) + 2 * Math.max(0, h - 2 * r) + 2 * Math.PI * r;
  // ~4.5 lobes to the short edge, two lobes to a cycle, then rounded so the line closes on itself.
  const cycles = Math.max(6, Math.round(P / (span / 2.25)));
  // Sampled as a polyline rather than as curves: the offset path is not a shape any curve primitive
  // has, and at this step a round-joined polyline is indistinguishable from one. Capped so an A4
  // sheet does not pay for thousands of segments on a path that is redrawn on every keystroke.
  const n = Math.max(64, Math.min(560, Math.ceil(P / Math.max(2.5 * unit, 1))));

  p.line();
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    // Phase from i/n, not from t/P: the two are the same number and only the first is exactly
    // periodic in floating point, which is what makes the seam at i = 0 disappear.
    const q = rrAt(x, y, w, h, r, (i / n) * P);
    const o = amp * Math.sin((2 * Math.PI * cycles * i) / n);
    const px = q.x + q.nx * o, py = q.y + q.ny * o;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.stroke();
}

/** One heart, as a single open stroke: up the left flank, over the notch, down the right and a
 *  little PAST the tip it started from.
 *
 *  The overshoot is deliberate and so is the asymmetry — the right lobe is a shade fuller than the
 *  left and its shoulder sits a shade lower, and the notch is off centre. A heart drawn symmetrically about its
 *  own axis and closed cleanly at the tip is the ♥ glyph, which every keyboard already has; the
 *  point of drawing one is that it looks drawn.
 *
 *  `s` is half-height-ish, `lean` a rotation about the heart's own centre, which is how two of them
 *  can sit near each other without reading as a pair of copies. */
function openHeart(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, lean: number) {
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(lean);
  ctx.beginPath();
  ctx.moveTo(0, 0.92 * s);
  ctx.bezierCurveTo(-0.38 * s, 0.46 * s, -0.94 * s, 0.10 * s, -0.86 * s, -0.38 * s);
  ctx.bezierCurveTo(-0.80 * s, -0.78 * s, -0.30 * s, -0.88 * s, -0.04 * s, -0.42 * s);
  ctx.bezierCurveTo(0.26 * s, -0.92 * s, 0.80 * s, -0.80 * s, 0.86 * s, -0.32 * s);
  ctx.bezierCurveTo(0.94 * s, 0.14 * s, 0.42 * s, 0.52 * s, -0.06 * s, 0.98 * s);
  ctx.stroke();
  ctx.restore();
}

/** Two or three hearts, thrown rather than arranged.
 *
 *  Every offset here is a fixed number, and it has to be: the same design is drawn into the preset
 *  gallery's thumbnails, into the live preview on every keystroke and into the printed sheet, and a
 *  scatter that moved between those three would not be a scatter, it would be a bug the host can
 *  see. The confetti motif solves the same problem with a seeded rng because it places thirteen
 *  pieces; three can simply be placed.
 *
 *  They are laid out to break the three things that make a scatter read as a row of stickers: no
 *  two the same size, no two on the same baseline, and no mirrored pair — the small ones both sit
 *  to the right of the large one rather than flanking it. (The corner SET is still mirrored left to
 *  right by the caller, as every motif here is; that is the frame reading, not this one.) */
function hearts(ctx: CanvasRenderingContext2D, p: Pen, cx: number, cy: number, s: number, n: number) {
  p.line();
  openHeart(ctx, cx - 0.26 * s, cy, 0.92 * s, -0.13);
  // The companions drop to the hairline for the same reason the far birds do: at this size a second
  // heavy outline stops being an accent and starts being a second subject.
  p.hair();
  openHeart(ctx, cx + 1.44 * s, cy - 0.62 * s, 0.40 * s, 0.24);
  // The third is skipped in a corner, where the same three marks in a quarter of the room are a
  // blot rather than a scatter.
  if (n > 2) openHeart(ctx, cx + 0.98 * s, cy + 0.88 * s, 0.25 * s, -0.31);
}

/**
 * How far a camera body reaches out from the QR square: `m` at the sides and the bottom, and
 * CAMERA_TOP × m above it for the control deck. Exported because the card has to leave that much
 * room above the QR block before it starts the trick list — a body drawn through the last line of
 * the list is worse than no camera at all.
 *
 * Returns 0 when the QR sits too close to the card's edge for a body to fit round it.
 */
export const CAMERA_TOP = 1.55;
export function cameraMargin(qr: Rect, card: Rect, unit: number, scale: number): number {
  const room = Math.min(qr.x - card.x, card.x + card.w - (qr.x + qr.w), card.y + card.h - (qr.y + qr.h));
  const want = Math.max(13 * unit, qr.w * 0.16) * Math.min(scale, 1.25);
  const m = Math.min(want, room - 5 * unit, (qr.y - card.y - 5 * unit) / CAMERA_TOP);
  return m >= 8 * unit ? m : 0;
}
/** A camera body drawn AROUND the QR, so the code reads as the lens.
 *
 *  Nothing is drawn inside the QR or its white panel: the mount sits a clear margin outside the
 *  square, which is the code's quiet zone plus room to spare. A QR with a line through it is a QR
 *  that does not scan, and this is the one decoration with the opportunity to do that. Every part
 *  is INSIDE the body outline too, so the camera's footprint is exactly what cameraMargin reports.
 *
 *  The body and the lens mount carry the weight; the deck rule, the viewfinder and the buttons are
 *  hairline, so the QR itself stays the darkest thing in the block — which is also the thing a
 *  phone camera has to find. */
function camera(ctx: CanvasRenderingContext2D, p: Pen, qr: Rect, card: Rect, unit: number, scale: number) {
  const m = cameraMargin(qr, card, unit, scale);
  if (!m) return;
  const bx = qr.x - m, by = qr.y - m * CAMERA_TOP, bw = qr.w + m * 2, bh = qr.h + m * (1 + CAMERA_TOP);
  p.line();
  rr(ctx, bx, by, bw, bh, m * 0.7); ctx.stroke();                                                       // body
  rr(ctx, qr.x - m * 0.45, qr.y - m * 0.45, qr.w + m * 0.90, qr.h + m * 0.90, m * 0.30); ctx.stroke();   // lens mount
  p.hair();
  // The deck rule: the line across the top plate that every camera drawn in outline has, and
  // without which the body is only a rounded rectangle round a square. It is placed in the band
  // BETWEEN the mount and the body's top edge — a second concentric rectangle there turns the whole
  // motif into a picture frame, which is the one thing it must not read as.
  ctx.beginPath(); ctx.moveTo(bx + m * 0.34, by + m * 0.95); ctx.lineTo(bx + bw - m * 0.34, by + m * 0.95); ctx.stroke();
  rr(ctx, bx + bw * 0.13, by + m * 0.22, bw * 0.22, m * 0.50, m * 0.22); ctx.stroke();                   // viewfinder
  ctx.beginPath(); ctx.arc(bx + bw - m * 0.66, by + m * 0.47, m * 0.20, 0, Math.PI * 2); ctx.stroke();   // shutter
  ctx.beginPath(); ctx.arc(bx + bw - m * 1.26, by + m * 0.47, m * 0.07, 0, Math.PI * 2); ctx.stroke();   // lamp
}

/**
 * Paint the chosen decoration into `card`. Stroke-only line art in one colour, drawn before the
 * card's own content so text always sits on top of it.
 */
/** A camera drawn WITHOUT LIFTING THE PEN.
 *
 *  This is the continuous-line style — the flowing single-stroke drawing you see on minimalist
 *  stationery — and the implementation is the literal thing rather than an impression of it: ONE
 *  beginPath, a chain of curves, ONE stroke. Nothing is drawn twice and the pen never jumps, which
 *  is exactly what gives it the handwritten, cursive quality. Drawing it as separate shapes that
 *  happen to touch produces visible joins at every seam and reads as assembled rather than drawn.
 *
 *  The route: in along the left of the body, up over the viewfinder bump, across the top, down the
 *  right, back along the bottom, then — still without lifting — inward on a spiral that becomes the
 *  lens. The spiral is what sells it. A closed circle for the lens would end the gesture; a coil
 *  keeps it moving and finishes the line somewhere deliberate.
 *
 *  One weight only, and that is on purpose. The two-weight rule elsewhere is about a hairline
 *  supporting a heavier contour — but a single unbroken line has no supporting structure to carry,
 *  and a stroke that changed weight mid-path would stop reading as one pen.
 */
function cameraLine(ctx: CanvasRenderingContext2D, p: Pen, cx: number, cy: number, s: number): void {
  p.line();
  const w = s * 1.30, h = s * 0.92;           // body half-extents
  const l = cx - w, r = cx + w, t = cy - h * 0.62, b = cy + h;
  const k = s * 0.30;                          // corner softness

  ctx.beginPath();
  // Start part-way down the left edge, so the opening and closing of the line are not at a corner.
  ctx.moveTo(l, cy + h * 0.22);
  ctx.quadraticCurveTo(l, t + k * 0.6, l + k, t + k * 0.35);        // up into the top-left
  // The viewfinder: a small rise in the top edge rather than a box sitting on it, so it stays part
  // of the same stroke.
  ctx.lineTo(cx - s * 0.44, t + k * 0.1);
  ctx.quadraticCurveTo(cx - s * 0.34, t - s * 0.34, cx - s * 0.04, t - s * 0.30);
  ctx.quadraticCurveTo(cx + s * 0.20, t - s * 0.26, cx + s * 0.22, t + k * 0.06);
  ctx.lineTo(r - k, t + k * 0.3);
  ctx.quadraticCurveTo(r, t + k * 0.55, r, cy - h * 0.10);          // down into the top-right
  ctx.quadraticCurveTo(r, b - k * 0.4, r - k, b);                   // right edge to bottom-right
  ctx.lineTo(l + k, b);
  ctx.quadraticCurveTo(l, b - k * 0.3, l, cy + h * 0.46);           // bottom-left, heading back up
  // …and straight on into the lens, without a break: a short sweep to the rim, then the coil.
  ctx.quadraticCurveTo(cx - s * 0.86, cy + s * 0.30, cx - s * 0.62, cy + s * 0.16);
  const turns = 1.85, steps = 74, r0 = s * 0.62, r1 = s * 0.17;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const a = Math.PI + f * turns * Math.PI * 2;
    const rad = r0 + (r1 - r0) * f;
    ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad * 0.98);
  }
  ctx.stroke();
}

/** The camera whose lens is a heart.
 *
 *  THE WEIGHTS ARE THE OTHER WAY ROUND HERE, and that is the design. Everywhere else the heavy line
 *  is the outer contour and the hairline is the detail inside it; here the body, the top plate, the
 *  shutter and the flash are all hairline, and the only heavy lines in the drawing are the lens
 *  ring and the heart inside it. The camera is the container and the heart is the subject — draw it
 *  the usual way round and the eye lands on a rounded rectangle, which is a picture of equipment.
 *  This motif is supposed to be fond of you.
 *
 *  The flash is three short rays with a GAP at their origin. Rays that meet at a point are a
 *  sparkle, which this set already has twice; light leaving a lamp is a burst, and the gap is the
 *  whole difference. */
function heartLens(ctx: CanvasRenderingContext2D, p: Pen, cx: number, cy: number, s: number): void {
  const bw = 1.18 * s, bh = 0.76 * s, top = cy - 0.62 * s;
  p.hair();
  rr(ctx, cx - bw, top, bw * 2, bh * 2, 0.26 * s); ctx.stroke();                       // body
  // Plate and button sit ON the top edge — their lower edge is the body's upper one — rather than
  // straddling it. Two outlines crossing at card size is a smudge, not a join.
  rr(ctx, cx - 0.78 * s, top - 0.24 * s, 0.80 * s, 0.24 * s, 0.09 * s); ctx.stroke();  // top plate
  rr(ctx, cx + 0.50 * s, top - 0.17 * s, 0.24 * s, 0.17 * s, 0.07 * s); ctx.stroke();  // shutter
  const fx = cx + 1.04 * s, fy = top - 0.08 * s;
  for (const [ang, len] of [[-1.98, 0.20], [-1.39, 0.26], [-0.80, 0.20]] as const) {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    ctx.beginPath();
    ctx.moveTo(fx + ca * 0.11 * s, fy + sa * 0.11 * s);
    ctx.lineTo(fx + ca * (0.11 + len) * s, fy + sa * (0.11 + len) * s);
    ctx.stroke();
  }
  p.line();
  const ly = top + bh;
  ctx.beginPath(); ctx.arc(cx, ly, 0.56 * s, 0, Math.PI * 2); ctx.stroke();
  // Lifted a hair: a heart's mass sits above its tip, so one centred in the ring by its bounding
  // box hangs visibly low in it.
  openHeart(ctx, cx, ly - 0.03 * s, 0.40 * s, 0);
}

/** One positional motif, drawn around the anchor (cx, cy) at half-size `s`.
 *
 *  Lifted out of drawDecor's `top` slot so the same drawing can be placed anywhere — a host who can
 *  drag a motif needs it drawn where they dragged it, not at one of three fixed positions.
 *
 *  The small per-motif vertical nudges are part of each drawing, not part of the slot: the glasses
 *  hang below their anchor and throw the clink above it, the sprig's mass is under its stem, the
 *  heart-lens carries its flash burst at the top. Anchoring them all flat centres the ink somewhere
 *  different for each one. */
function paintMotif(ctx: CanvasRenderingContext2D, p: Pen, kind: DecorKind, cx: number, cy: number, s: number): void {
  // cameraline and confetti are handled by their own early-return branches in drawDecor, so they
  // were never part of the block this function was lifted from — and a host who placed either got
  // a draggable box containing nothing. Any POSITIONAL kind must have a branch here; the test
  // "every positional motif draws something when placed" is what keeps the two lists in step.
  if (kind === 'cameraline') { cameraLine(ctx, p, cx, cy, s); return; }
  if (kind === 'confetti') {
    // Confetti scatters through a band rather than sitting at a point. Placed by hand it gets that
    // band centred on the anchor, so what the host drags is the middle of the scatter rather than
    // its top-left corner.
    const bw = s * 4.4, bh = s * 2.8;
    confetti(ctx, p, { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh }, s, 0x5eed, 13);
    return;
  }
  if (kind === 'bows') bowTie(ctx, p, cx, cy, s);
  else if (kind === 'birds') birds(ctx, p, cx, cy, s);
  else if (kind === 'glasses') glasses(ctx, p, cx, cy + s * 0.25, s);
  else if (kind === 'stars') stars(ctx, p, cx, cy, s);
  else if (kind === 'botanical') sprigPair(ctx, p, cx, cy + s * 0.62, s);
  else if (kind === 'deco') decoFan(ctx, p, cx, cy + s * 0.62, s * 1.18);
  else if (kind === 'rings') rings(ctx, p, cx, cy, s);
  else if (kind === 'hearts') hearts(ctx, p, cx, cy, s, 3);
  else if (kind === 'heartlens') heartLens(ctx, p, cx, cy + s * 0.12, s);
}

/** One motif, placed and rotated by the host rather than dropped into a slot.
 *
 *  `x`/`y` are FRACTIONS of the rect, so a placement survives the poster being rendered at a
 *  thumbnail size, at full page size, and into a PDF — all three happen to the same design.
 *
 *  Only positional kinds place: `frame`, `wave` and `camera` are defined by the edges
 *  of the paper or by the code, and "drag the border somewhere else" is not a thing anyone means. */
export function drawDecorAt(ctx: CanvasRenderingContext2D, o: DecorAtOpts): void {
  const kind = o.kind;
  if (kind === 'none') return;
  if (!(DECOR_KINDS.find((d) => d.key === kind)?.positional ?? false)) return;
  const scale = Math.max(0.4, Math.min(2.2, o.scale || 1));
  const span = Math.min(o.card.w, o.card.h);
  const s = Math.min(24 * o.unit * scale, span * 0.17);
  ctx.save();
  ctx.strokeStyle = o.colour;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const p = makePen(ctx, o.unit, scale);
  p.line();
  ctx.translate(o.card.x + o.x * o.card.w, o.card.y + o.y * o.card.h);
  if (o.rot) ctx.rotate(o.rot);
  paintMotif(ctx, p, kind, 0, 0, s);
  ctx.restore();
}

export function drawDecor(ctx: CanvasRenderingContext2D, o: DecorOpts): void {
  if (o.kind === 'none') return;
  const unit = o.unit, scale = Math.max(0.4, Math.min(2.2, o.scale || 1));
  ctx.save();
  ctx.strokeStyle = o.colour;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const p = makePen(ctx, unit, scale);
  p.line();

  if (o.kind === 'frame') { frame(ctx, p, o.card, unit, scale); ctx.restore(); return; }
  // A border is already everywhere on the card, so like 'frame' it takes the whole rect and ignores
  // the position control.
  if (o.kind === 'wave') { waveBorder(ctx, p, o.card, unit, scale); ctx.restore(); return; }
  if (o.kind === 'camera') { if (o.qr) camera(ctx, p, o.qr, o.card, unit, scale); ctx.restore(); return; }

  // Motif half-size. Paper-scaled first — a motif is meant to keep its physical size as the card
  // grows — but capped against the CARD so a short or narrow rect can never be handed a motif
  // wider than it is. The cap only bites on a rect far from the three real card shapes.
  const span = Math.min(o.card.w, o.card.h);
  const s = Math.min(24 * unit * scale, span * 0.17);
  const m = Math.min(15 * unit, span * 0.05);   // inset from the card edge
  const wantTop = o.pos === 'top' || o.pos === 'both';
  const wantCorners = o.pos === 'corners' || o.pos === 'both';
  const cx = o.card.x + o.card.w / 2;
  const topY = o.card.y + m + s * 0.95;

  if (o.kind === 'cameraline') {
    // One drawing, placed like any other positional motif — top, corners, or both.
    if (wantTop) cameraLine(ctx, p, cx, topY, s);
    if (wantCorners) {
      // Mirrored left-to-right only. Never vertically: an upside-down camera is not a decoration.
      const cs = s * 0.62;
      for (const gx of [-1, 1]) {
        ctx.save();
        ctx.translate(o.card.x + (gx < 0 ? m + cs : o.card.w - m - cs), o.card.y + o.card.h - m - cs * 0.9);
        ctx.scale(gx, 1);
        cameraLine(ctx, p, 0, 0, cs);
        ctx.restore();
      }
    }
    ctx.restore();
    return;
  }

  if (o.kind === 'confetti') {
    // Confetti scatters through a band rather than sitting at a point, so it gets its own
    // geometry: a drift over the middle two thirds rather than a line right across. A scatter that
    // runs wall to wall reads as spilled, and the card's own margins stop meaning anything.
    const bw = o.card.w * 0.66, bh = s * 2.8;
    if (wantTop) confetti(ctx, p, { x: cx - bw / 2, y: o.card.y + m, w: bw, h: bh }, s, 0x5eed, 13);
    if (wantCorners) {
      const q = s * 2.2;
      confetti(ctx, p, { x: o.card.x + m, y: o.card.y + m, w: q, h: q }, s, 0x11a1, 5);
      confetti(ctx, p, { x: o.card.x + o.card.w - m - q, y: o.card.y + m, w: q, h: q }, s, 0x22b2, 5);
      confetti(ctx, p, { x: o.card.x + m, y: o.card.y + o.card.h - m - q, w: q, h: q }, s, 0x33c3, 5);
      confetti(ctx, p, { x: o.card.x + o.card.w - m - q, y: o.card.y + o.card.h - m - q, w: q, h: q }, s, 0x44d4, 5);
    }
    ctx.restore(); return;
  }

  if (wantTop) paintMotif(ctx, p, o.kind, cx, topY, s);

  if (wantCorners) {
    // The corner set is MIRRORED left to right so the four together read as one frame rather than
    // as four copies of the same sticker. Only horizontally: a champagne flute standing on its rim
    // is not a decoration, and nor is a branch growing downward.
    const cs = s * 0.62;
    const inset = m + cs * 1.15;
    const at: [number, number, number, number][] = [
      [o.card.x + inset, o.card.y + inset, 1, 1],
      [o.card.x + o.card.w - inset, o.card.y + inset, -1, 1],
      [o.card.x + inset, o.card.y + o.card.h - inset, 1, -1],
      [o.card.x + o.card.w - inset, o.card.y + o.card.h - inset, -1, -1],
    ];
    if (o.kind === 'deco') {
      // Deco corners hug the actual corner and DO flip vertically — a mitre has no up or down, and
      // four of them pointing the same way would look like a printing error.
      for (const [x, y, sx, sy] of at) {
        ctx.save(); ctx.translate(x - sx * cs * 0.65, y - sy * cs * 0.65); ctx.scale(sx, sy);
        decoCorner(ctx, p, cs); ctx.restore();
      }
    } else {
      for (const [x, y, sx] of at) {
        ctx.save(); ctx.translate(x, y); ctx.scale(sx, 1);
        if (o.kind === 'bows') bowTie(ctx, p, 0, 0, cs);
        else if (o.kind === 'birds') { p.line(); gull(ctx, 0, 0, cs); }
        // The flute is drawn standing on its foot, so it is pushed down by most of its own height
        // to sit ON the corner anchor rather than hanging above it.
        else if (o.kind === 'glasses') { ctx.translate(0, cs * 0.76); ctx.rotate(0.22); flute(ctx, p, cs * 0.92); }
        else if (o.kind === 'stars') { p.line(); sparkle(ctx, 0, 0, cs * 0.80); p.hair(); twinkle(ctx, cs * 0.95, cs * 0.72, cs * 0.16); }
        // A corner sprig grows on the diagonal, the way a branch laid into a corner actually sits
        // — level with the edge it reads as a twig someone dropped there.
        else if (o.kind === 'botanical') { ctx.rotate(-0.34); sprig(ctx, p, -cs * 1.05, cs * 0.45, cs * 2.0); }
        else if (o.kind === 'rings') rings(ctx, p, 0, 0, cs * 0.86);
        else if (o.kind === 'hearts') hearts(ctx, p, 0, 0, cs, 2);
        else if (o.kind === 'heartlens') heartLens(ctx, p, 0, 0, cs);
        ctx.restore();
      }
    }
  }
  ctx.restore();
}
