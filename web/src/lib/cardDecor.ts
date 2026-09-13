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
  | 'botanical' | 'deco' | 'rings';
/** Where a motif sits. Only the scattered/repeatable kinds use it — a border is already everywhere
 *  and the camera is pinned to the QR. */
export type DecorPos = 'top' | 'corners' | 'both';

export type Rect = { x: number; y: number; w: number; h: number };

/** `positional` = the position control means something for this kind (see DecorPos). */
export const DECOR_KINDS: { key: DecorKind; label: string; positional: boolean }[] = [
  { key: 'none',      label: 'None',            positional: false },
  { key: 'frame',     label: 'Border',          positional: false },
  { key: 'bows',      label: 'Bow ties',        positional: true },
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
  { key: 'camera',    label: 'Camera (round the QR)', positional: false },
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
function makePen(ctx: CanvasRenderingContext2D, unit: number, scale: number): Pen {
  const base = Math.max(1, 1.45 * unit * Math.pow(scale, 0.35));
  return {
    hair() { ctx.lineWidth = Math.max(0.9, base * 0.58); ctx.globalAlpha = 0.55; },
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
export function drawDecor(ctx: CanvasRenderingContext2D, o: DecorOpts): void {
  if (o.kind === 'none') return;
  const unit = o.unit, scale = Math.max(0.4, Math.min(2.2, o.scale || 1));
  ctx.save();
  ctx.strokeStyle = o.colour;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const p = makePen(ctx, unit, scale);
  p.line();

  if (o.kind === 'frame') { frame(ctx, p, o.card, unit, scale); ctx.restore(); return; }
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

  if (wantTop) {
    if (o.kind === 'bows') bowTie(ctx, p, cx, topY, s);
    else if (o.kind === 'birds') birds(ctx, p, cx, topY, s);
    // The glasses hang BELOW their anchor and throw the clink above it, so they are the one motif
    // dropped further in — anchored level with the rest they print their sparks off the paper.
    else if (o.kind === 'glasses') glasses(ctx, p, cx, topY + s * 0.25, s);
    else if (o.kind === 'stars') stars(ctx, p, cx, topY, s);
    else if (o.kind === 'botanical') sprigPair(ctx, p, cx, topY + s * 0.62, s);
    else if (o.kind === 'deco') decoFan(ctx, p, cx, topY + s * 0.62, s * 1.18);
    else if (o.kind === 'rings') rings(ctx, p, cx, topY, s);
  }

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
        ctx.restore();
      }
    }
  }
  ctx.restore();
}
