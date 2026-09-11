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

export type DecorKind = 'none' | 'frame' | 'bows' | 'birds' | 'glasses' | 'confetti' | 'stars' | 'camera';
/** Where a motif sits. Only the scattered/repeatable kinds use it — a border is already everywhere
 *  and the camera is pinned to the QR. */
export type DecorPos = 'top' | 'corners' | 'both';

export type Rect = { x: number; y: number; w: number; h: number };

/** `positional` = the position control means something for this kind (see DecorPos). */
export const DECOR_KINDS: { key: DecorKind; label: string; positional: boolean }[] = [
  { key: 'none',     label: 'None',            positional: false },
  { key: 'frame',    label: 'Border',          positional: false },
  { key: 'bows',     label: 'Bow ties',        positional: true },
  { key: 'birds',    label: 'Birds',           positional: true },
  { key: 'glasses',  label: 'Glasses',         positional: true },
  { key: 'confetti', label: 'Confetti',        positional: true },
  { key: 'stars',    label: 'Sparkles',        positional: true },
  { key: 'camera',   label: 'Camera (round the QR)', positional: false },
];

export const DECOR_POSITIONS: { key: DecorPos; label: string }[] = [
  { key: 'top', label: 'Top' },
  { key: 'corners', label: 'Corners' },
  { key: 'both', label: 'Both' },
];

/** The motif a host starts with for this event type — the same idea as the default tick glyph:
 *  the type only picks a sensible starting point, the host can change it or turn it off. */
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

// ── Motifs. Each draws around (cx, cy) at nominal half-size `s`, stroke only. ──

function bowTie(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  ctx.beginPath();
  ctx.moveTo(cx - 0.12 * s, cy);
  ctx.lineTo(cx - 1.00 * s, cy - 0.58 * s);
  ctx.lineTo(cx - 1.00 * s, cy + 0.58 * s);
  ctx.closePath(); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + 0.12 * s, cy);
  ctx.lineTo(cx + 1.00 * s, cy - 0.58 * s);
  ctx.lineTo(cx + 1.00 * s, cy + 0.58 * s);
  ctx.closePath(); ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(cx, cy, 0.17 * s, 0.30 * s, 0, 0, Math.PI * 2); ctx.stroke();
}

/** One gull — the two-stroke bird everyone draws. */
function gull(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  ctx.beginPath();
  ctx.moveTo(cx - s, cy);
  ctx.quadraticCurveTo(cx - 0.48 * s, cy - 0.66 * s, cx, cy - 0.04 * s);
  ctx.quadraticCurveTo(cx + 0.48 * s, cy - 0.66 * s, cx + s, cy);
  ctx.stroke();
}
/** A little flock, so "birds" reads as birds rather than as a stray tick. */
function birds(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  gull(ctx, cx, cy, s);
  gull(ctx, cx - 1.5 * s, cy + 0.62 * s, 0.62 * s);
  gull(ctx, cx + 1.45 * s, cy + 0.72 * s, 0.48 * s);
}

/** One champagne flute, foot at (0,0), drawn upright then rotated by the caller. */
function flute(ctx: CanvasRenderingContext2D, s: number) {
  ctx.beginPath();
  ctx.moveTo(-0.44 * s, -1.55 * s);
  ctx.lineTo(-0.15 * s, -0.62 * s);
  ctx.lineTo(0.15 * s, -0.62 * s);
  ctx.lineTo(0.44 * s, -1.55 * s);
  ctx.stroke();
  ctx.beginPath();                                   // rim
  ctx.moveTo(-0.44 * s, -1.55 * s); ctx.quadraticCurveTo(0, -1.40 * s, 0.44 * s, -1.55 * s); ctx.stroke();
  ctx.beginPath();                                   // stem
  ctx.moveTo(0, -0.62 * s); ctx.lineTo(0, -0.10 * s); ctx.stroke();
  ctx.beginPath();                                   // foot
  ctx.moveTo(-0.32 * s, -0.06 * s); ctx.quadraticCurveTo(0, -0.18 * s, 0.32 * s, -0.06 * s); ctx.stroke();
}
/** Two flutes meeting at the rim, with the little clink marks. The feet are set a full glass apart
 *  and the lean brings only the RIMS together — any closer and the two bowls merge into one
 *  unreadable shape at card size. */
function glasses(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  const g = s * 0.9;
  ctx.save(); ctx.translate(cx - 0.82 * g, cy + 0.80 * g); ctx.rotate(0.30); flute(ctx, g); ctx.restore();
  ctx.save(); ctx.translate(cx + 0.82 * g, cy + 0.80 * g); ctx.rotate(-0.30); flute(ctx, g); ctx.restore();
  for (const [dx, dy, l] of [[0, -0.90, 0.32], [-0.52, -0.72, 0.24], [0.52, -0.72, 0.24]] as const) {
    ctx.beginPath();
    ctx.moveTo(cx + dx * g, cy + dy * g);
    ctx.lineTo(cx + dx * g * 1.5, cy + (dy - l) * g);
    ctx.stroke();
  }
}
/** A single flute, for the corner positions where a clinking pair has no room. */
function oneGlass(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, lean: number) {
  ctx.save(); ctx.translate(cx, cy + 0.8 * s); ctx.rotate(lean); flute(ctx, s * 1.1); ctx.restore();
}

/** The four-point sparkle — a star with pinched waists, not a spiky polygon. */
function sparkle(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - s);
  ctx.quadraticCurveTo(cx + 0.14 * s, cy - 0.14 * s, cx + s, cy);
  ctx.quadraticCurveTo(cx + 0.14 * s, cy + 0.14 * s, cx, cy + s);
  ctx.quadraticCurveTo(cx - 0.14 * s, cy + 0.14 * s, cx - s, cy);
  ctx.quadraticCurveTo(cx - 0.14 * s, cy - 0.14 * s, cx, cy - s);
  ctx.closePath(); ctx.stroke();
}
function stars(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  sparkle(ctx, cx, cy, s);
  sparkle(ctx, cx - 1.35 * s, cy + 0.55 * s, 0.46 * s);
  sparkle(ctx, cx + 1.30 * s, cy + 0.62 * s, 0.34 * s);
}

/** Confetti scattered inside a band: short strokes, rings and open triangles, never a solid fill —
 *  a card is printed, and a page of solid dots is a page of ink. */
function confetti(ctx: CanvasRenderingContext2D, r: Rect, s: number, seed: number, n: number) {
  const rand = rng(seed);
  for (let i = 0; i < n; i++) {
    const x = r.x + rand() * r.w, y = r.y + rand() * r.h;
    const a = rand() * Math.PI, k = Math.floor(rand() * 3), z = s * (0.30 + rand() * 0.34);
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    ctx.beginPath();
    if (k === 0) { ctx.moveTo(-z, 0); ctx.lineTo(z, 0); }
    else if (k === 1) { ctx.arc(0, 0, z * 0.6, 0, Math.PI * 2); }
    else { ctx.moveTo(0, -z * 0.7); ctx.lineTo(z * 0.62, z * 0.5); ctx.lineTo(-z * 0.62, z * 0.5); ctx.closePath(); }
    ctx.stroke(); ctx.restore();
  }
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath(); ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k); ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k); ctx.arcTo(x, y, x + w, y, k); ctx.closePath();
}

/** A double hairline border with a small arc + dot flourish tucked into each corner. */
function frame(ctx: CanvasRenderingContext2D, card: Rect, unit: number, scale: number) {
  const m = 11 * unit * scale, g = 4.5 * unit;
  rr(ctx, card.x + m, card.y + m, card.w - m * 2, card.h - m * 2, 12 * unit); ctx.stroke();
  rr(ctx, card.x + m + g, card.y + m + g, card.w - (m + g) * 2, card.h - (m + g) * 2, 9 * unit); ctx.stroke();
  const a = 13 * unit * scale;
  const corners: [number, number, number][] = [
    [card.x + m + g, card.y + m + g, 0],
    [card.x + card.w - m - g, card.y + m + g, Math.PI / 2],
    [card.x + card.w - m - g, card.y + card.h - m - g, Math.PI],
    [card.x + m + g, card.y + card.h - m - g, -Math.PI / 2],
  ];
  for (const [x, y, rot] of corners) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.beginPath(); ctx.arc(a, a, a, Math.PI, Math.PI * 1.5); ctx.stroke();
    ctx.beginPath(); ctx.arc(a * 0.42, a * 0.42, 1.5 * unit, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
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
 *  is INSIDE the body outline too, so the camera's footprint is exactly what cameraMargin reports. */
function camera(ctx: CanvasRenderingContext2D, qr: Rect, card: Rect, unit: number, scale: number) {
  const m = cameraMargin(qr, card, unit, scale);
  if (!m) return;
  const bx = qr.x - m, by = qr.y - m * CAMERA_TOP, bw = qr.w + m * 2, bh = qr.h + m * (1 + CAMERA_TOP);
  rr(ctx, bx, by, bw, bh, m * 0.7); ctx.stroke();                                                       // body
  rr(ctx, qr.x - m * 0.46, qr.y - m * 0.46, qr.w + m * 0.92, qr.h + m * 0.92, m * 0.30); ctx.stroke();   // lens mount
  rr(ctx, bx + bw * 0.15, by + m * 0.26, bw * 0.24, m * 0.52, m * 0.22); ctx.stroke();                   // viewfinder
  ctx.beginPath(); ctx.arc(bx + bw - m * 0.62, by + m * 0.55, m * 0.19, 0, Math.PI * 2); ctx.stroke();   // shutter
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
  ctx.lineWidth = Math.max(0.8, 1.5 * unit);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // Slightly under full strength: a decoration that competes with the mission text is a decoration
  // that has stopped decorating.
  ctx.globalAlpha = 0.8;

  if (o.kind === 'frame') { frame(ctx, o.card, unit, scale); ctx.restore(); return; }
  if (o.kind === 'camera') { if (o.qr) camera(ctx, o.qr, o.card, unit, scale); ctx.restore(); return; }

  const s = 20 * unit * scale;           // motif half-size
  const m = 15 * unit;                   // inset from the card edge
  const wantTop = o.pos === 'top' || o.pos === 'both';
  const wantCorners = o.pos === 'corners' || o.pos === 'both';
  const cx = o.card.x + o.card.w / 2;
  const topY = o.card.y + m + s * 0.75;
  // Corner anchors, with the sign of the lean/mirroring that suits each corner.
  const corners: [number, number, number][] = [
    [o.card.x + m + s * 0.9, o.card.y + m + s * 0.9, 0.3],
    [o.card.x + o.card.w - m - s * 0.9, o.card.y + m + s * 0.9, -0.3],
    [o.card.x + m + s * 0.9, o.card.y + o.card.h - m - s * 0.9, 0.3],
    [o.card.x + o.card.w - m - s * 0.9, o.card.y + o.card.h - m - s * 0.9, -0.3],
  ];

  if (o.kind === 'confetti') {
    // Confetti scatters through a band rather than sitting at a point, so it gets its own geometry.
    const band = s * 2.2;
    if (wantTop) confetti(ctx, { x: o.card.x + m, y: o.card.y + m, w: o.card.w - m * 2, h: band }, s, 0x5eed, 14);
    if (wantCorners) {
      const q = s * 2.4;
      confetti(ctx, { x: o.card.x + m, y: o.card.y + m, w: q, h: q }, s, 0x11a1, 5);
      confetti(ctx, { x: o.card.x + o.card.w - m - q, y: o.card.y + m, w: q, h: q }, s, 0x22b2, 5);
      confetti(ctx, { x: o.card.x + m, y: o.card.y + o.card.h - m - q, w: q, h: q }, s, 0x33c3, 5);
      confetti(ctx, { x: o.card.x + o.card.w - m - q, y: o.card.y + o.card.h - m - q, w: q, h: q }, s, 0x44d4, 5);
    }
    ctx.restore(); return;
  }

  const one = (x: number, y: number, sz: number, lean: number) => {
    if (o.kind === 'bows') bowTie(ctx, x, y, sz);
    else if (o.kind === 'birds') gull(ctx, x, y, sz);
    else if (o.kind === 'glasses') oneGlass(ctx, x, y, sz * 0.8, lean);
    else if (o.kind === 'stars') sparkle(ctx, x, y, sz * 0.8);
  };
  if (wantTop) {
    if (o.kind === 'bows') bowTie(ctx, cx, topY, s);
    else if (o.kind === 'birds') birds(ctx, cx, topY, s);
    else if (o.kind === 'glasses') glasses(ctx, cx, topY - s * 0.3, s);
    else if (o.kind === 'stars') stars(ctx, cx, topY, s);
  }
  if (wantCorners) for (const [x, y, lean] of corners) one(x, y, s * 0.62, lean);
  ctx.restore();
}
