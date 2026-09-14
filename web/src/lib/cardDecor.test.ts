// The two-weight rule, as arithmetic rather than as a comment.
//
// This exists because the stroke model has now been argued both ways — grow it weakly with the
// host's size slider, or clamp it to a constant — and the decision turned on numbers that nobody
// could see from reading the code. Locking them here means the next person to have the idea gets a
// failing test that explains itself, instead of a plausible-sounding change that quietly thickens
// the smallest cards.
import { describe, it, expect } from 'vitest';
import { penWidths, drawDecor, drawDecorAt, DECOR_KINDS, type DecorKind, type DecorOpts } from './cardDecor';

const A6 = 1, A4 = 2;

describe('the pen', () => {
  it('keeps two distinct weights, never collapsing them into one', () => {
    // 1.72:1 is the designed contrast. It used to fall to 1.61:1 at default and 1.35:1 at the
    // bottom of the slider, because the hairline had an absolute floor that overrode the ratio —
    // and alpha, which still separated them on screen, is not what survives an inkjet.
    for (const scale of [0.6, 0.8, 1, 1.4, 1.8]) {
      const { line, hair } = penWidths(A6, scale);
      expect(line / hair).toBeGreaterThan(1.65);
    }
  });

  it('draws a LARGER motif with a FINER line, not a fatter one', () => {
    // The whole difference between a drawing and enlarged clip art. Motif size scales linearly with
    // the slider while the stroke scales by ^0.35, so the line must shrink as a fraction of it.
    const frac = (scale: number) => penWidths(A6, scale).line / (24 * scale);
    expect(frac(1.8)).toBeLessThan(frac(1.0));
    expect(frac(1.0)).toBeLessThan(frac(0.6));
  });

  it('does not thicken the small end, which is the end that blots', () => {
    // A constant 1.4px clamp was proposed. At scale 0.6 on an A6 card the motif is ~9mm with detail
    // already at the ~1.5mm floor, and the clamp would put the line at 9.7% of the drawing there.
    // The exponent keeps it under 9%.
    const { line } = penWidths(A6, 0.6);
    expect(line / (24 * 0.6)).toBeLessThan(0.09);
    expect(line).toBeLessThan(1.4);
  });

  it('gives bigger paper a heavier pen, because that part SHOULD scale', () => {
    // An A4 poster is seen from further away and its drawing is bigger, so it earns more ink. The
    // slider is a preference within one sheet; the paper is not.
    expect(penWidths(A4, 1).line).toBeCloseTo(penWidths(A6, 1).line * 2, 5);
  });

  it('still floors the hairline so it cannot vanish at the bottom of the slider', () => {
    expect(penWidths(A6, 0.6).hair).toBeGreaterThanOrEqual(0.72);
  });
});

// ── The motifs, as the calls they make ──────────────────────────────────────
//
// jsdom has no canvas, and none of these motifs care: they are pure geometry that happens to be
// expressed as context calls. So the context is a recorder, and the tests ask where the pen went
// rather than what it looked like when it got there — which is also how they catch the things that
// break silently: a kind that stops being reachable, a scatter that starts moving between redraws,
// a fill that creeps in.

type Call = { op: string; args: number[] };
function recorder() {
  const calls: Call[] = [];
  const props: Record<string, string> = {};
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    set(_t, k: string, v: unknown) { props[k] = String(v); return true; },
    get(_t, k: string) {
      return (...args: unknown[]) => {
        calls.push({ op: k, args: args.filter((a): a is number => typeof a === 'number') });
      };
    },
  });
  return { ctx, calls, props };
}

const CARD = { x: 0, y: 0, w: 300, h: 420 };
const QR = { x: 90, y: 250, w: 120, h: 120 };
function render(kind: DecorKind, over: Partial<DecorOpts> = {}) {
  const r = recorder();
  drawDecor(r.ctx, { kind, pos: 'top', scale: 1, colour: '#111', unit: 1, card: CARD, qr: QR, ...over });
  return r;
}

type Pt = { x: number; y: number };
/** The recorded calls replayed back into absolute coordinates, one entry per beginPath.
 *
 *  The transform stack has to be replayed rather than ignored: half the motifs here draw themselves
 *  at the origin and are placed by translate/rotate/scale, so a test that reads the raw arguments is
 *  reading a drawing that has not been put anywhere yet. Control points count as points — they are
 *  as deterministic as the curve and they bound it closely enough to compare one motif's parts
 *  against another's. */
function paths(calls: Call[]): { pts: Pt[]; ops: string[] }[] {
  let m = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const at = (x: number, y: number): Pt => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
  const out: { pts: Pt[]; ops: string[] }[] = [];
  let cur: { pts: Pt[]; ops: string[] } | null = null;
  for (const c of calls) {
    const a = c.args;
    if (c.op === 'save') stack.push([...m]);
    else if (c.op === 'restore') m = stack.pop() ?? m;
    else if (c.op === 'translate') m = [m[0], m[1], m[2], m[3], m[4] + m[0] * a[0] + m[2] * a[1], m[5] + m[1] * a[0] + m[3] * a[1]];
    else if (c.op === 'scale') m = [m[0] * a[0], m[1] * a[0], m[2] * a[1], m[3] * a[1], m[4], m[5]];
    else if (c.op === 'rotate') {
      const k = Math.cos(a[0]), s = Math.sin(a[0]);
      m = [m[0] * k + m[2] * s, m[1] * k + m[3] * s, m[0] * -s + m[2] * k, m[1] * -s + m[3] * k, m[4], m[5]];
    } else if (c.op === 'beginPath') { cur = { pts: [], ops: [] }; out.push(cur); }
    else if (cur) {
      cur.ops.push(c.op);
      if (c.op === 'moveTo' || c.op === 'lineTo' || c.op === 'bezierCurveTo' || c.op === 'quadraticCurveTo' || c.op === 'arcTo') {
        for (let i = 0; i + 1 < a.length; i += 2) cur.pts.push(at(a[i], a[i + 1]));
      } else if (c.op === 'arc') cur.pts.push(at(a[0], a[1]));
    }
  }
  return out.filter((s) => s.pts.length > 0);
}
const points = (calls: Call[]) => paths(calls).flatMap((s) => s.pts);
const box = (pts: Pt[]) => {
  const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
};

describe('the registry', () => {
  it('reaches every kind it offers, including the three drawn ones', () => {
    // The registry is what the designer builds its buttons from, so a kind can be listed, be
    // selectable, and draw absolutely nothing without anything failing. That is the failure this
    // catches: a key added to the list and never wired into drawDecor's branches.
    for (const { key } of DECOR_KINDS) {
      if (key === 'none') continue;
      const { calls } = render(key);
      expect(calls.filter((c) => c.op === 'stroke').length, key).toBeGreaterThan(0);
    }
    for (const key of ['wave', 'hearts', 'heartlens'] as const) {
      expect(DECOR_KINDS.some((d) => d.key === key), key).toBe(true);
    }
  });

  it('keeps the border out of the position control and the hearts in it', () => {
    const flag = (k: DecorKind) => DECOR_KINDS.find((d) => d.key === k)?.positional;
    // A border is already everywhere on the card; offering it "top" would be a control that does
    // nothing, which is worse than not offering it.
    expect(flag('wave')).toBe(false);
    expect(flag('hearts')).toBe(true);
    expect(flag('heartlens')).toBe(true);
  });
});

describe('the wobbly border', () => {
  // The wobble measured across the middle half of the top edge, away from the corners: half the
  // spread between its highest and lowest point there. That window is wider than one lobe at any
  // rect this is asked to draw, so it always contains a crest and a trough.
  const wobble = (over: Partial<DecorOpts>) => {
    const card = over.card ?? CARD;
    const ys = points(render('wave', over).calls)
      .filter((q) => q.y < card.y + card.h * 0.25 && q.x > card.x + card.w * 0.25 && q.x < card.x + card.w * 0.75)
      .map((q) => q.y);
    expect(ys.length).toBeGreaterThan(8);
    return (Math.max(...ys) - Math.min(...ys)) / 2;
  };

  it('wobbles by the same amount on a card and on a sheet three times the size', () => {
    // The entire difference between a drawn border and a scaled-up graphic. A hand wobbles by the
    // same couple of millimetres whatever it is drawing round; only the NUMBER of wobbles goes up
    // with the page. Derive the amplitude from the rect instead and the big sheet gets a wobble
    // three times as deep, which is exactly what enlarged clip art looks like.
    const small = wobble({ card: CARD });
    const big = wobble({ card: { x: 0, y: 0, w: 900, h: 1260 } });
    expect(big / small).toBeGreaterThan(0.85);
    expect(big / small).toBeLessThan(1.15);
  });

  it('takes its wobble from the paper, which is the thing that SHOULD change it', () => {
    // A6 to A4 is unit 1 to 2: the same physical wobble on bigger paper is twice as many pixels.
    const a6 = wobble({ card: CARD, unit: 1 });
    const a4 = wobble({ card: { x: 0, y: 0, w: 600, h: 840 }, unit: 2 });
    expect(a4 / a6).toBeGreaterThan(1.7);
    expect(a4 / a6).toBeLessThan(2.3);
  });

  it('closes the loop instead of stopping wherever the sampling ran out', () => {
    // The seam is the one place a border cannot be untidy, and it is invisible to every test that
    // only counts strokes.
    expect(render('wave').calls.some((c) => c.op === 'closePath')).toBe(true);
  });

  it('stays out of the band the card prints its text in, corners included', () => {
    // The card's own content padding is 34 units. A border that strays inside it crosses the trick
    // list or the QR's quiet zone, and a QR with a line through it does not scan.
    //
    // The corner is the case this is really for. A rounded border's deepest point is on the corner
    // diagonal, not on its sides, and sized by its sides alone this one cleared the padding
    // everywhere except there — where it sat 0.3 units inside the title block at the top of the
    // slider. The margin below is what the tightened cap buys back.
    for (const scale of [0.6, 1, 1.8]) {
      for (const q of points(render('wave', { scale }).calls)) {
        const near = Math.min(q.x - CARD.x, CARD.x + CARD.w - q.x, q.y - CARD.y, CARD.y + CARD.h - q.y);
        expect(near, `scale ${scale}`).toBeLessThan(32);
      }
    }
  });
});

describe('the hearts', () => {
  it('lands in exactly the same places on every redraw', () => {
    // The preview redraws on every keystroke and the preset gallery draws the same design again in
    // a thumbnail. A scatter placed with Math.random would shimmer in the first and disagree with
    // the second, and the host would be approving a sheet they had not actually seen.
    expect(JSON.stringify(render('hearts').calls)).toBe(JSON.stringify(render('hearts').calls));
  });

  it('throws three hearts rather than arranging them', () => {
    // The three rules that separate a scatter from a row of stickers, as arithmetic: no two the
    // same size, no two on one baseline, and the small pair not flanking the large one — a mirrored
    // pair is a composition, and this motif is meant to look tossed.
    const boxes = paths(render('hearts').calls).map((s) => box(s.pts));
    expect(boxes.length).toBe(3);
    const [big, ...rest] = [...boxes].sort((m, n) => n.w - m.w);
    for (const r of rest) expect(r.w).toBeLessThan(big.w * 0.75);
    expect(rest[0].w).not.toBeCloseTo(rest[1].w, 1);
    expect(rest[0].cy).not.toBeCloseTo(rest[1].cy, 1);
    // Both companions to the same side of the large one. Mirrored, they would sit either side of it
    // and their offsets would have opposite signs.
    expect(Math.sign(rest[0].cx - big.cx)).toBe(Math.sign(rest[1].cx - big.cx));
  });

  it('drops the third heart in a corner, where three would be a blot', () => {
    const n = (pos: DecorOpts['pos']) => paths(render('hearts', { pos }).calls).length;
    expect(n('top')).toBe(3);
    expect(n('corners')).toBe(2 * 4);
  });
});

describe('the heart lens', () => {
  it('puts the heart inside the lens, which is the whole motif', () => {
    // Not "a heart somewhere near a camera". The heart is the only curved path in the drawing and
    // the lens is the only arc, so the two can be picked out by shape and compared: if the heart
    // drifts out of the ring every other assertion here still passes and the motif is nonsense.
    const { calls } = render('heartlens');
    const ring = calls.filter((c) => c.op === 'arc');
    expect(ring.length).toBe(1);
    const [lx, ly, r] = ring[0].args;      // drawn untransformed at `top`, so these are page coords
    const heart = paths(calls).find((s) => s.ops.includes('bezierCurveTo'));
    expect(heart).toBeDefined();
    const b = box(heart!.pts);
    expect(Math.abs(b.cx - lx)).toBeLessThan(r * 0.3);
    expect(Math.abs(b.cy - ly)).toBeLessThan(r * 0.3);
    expect(b.h).toBeLessThan(r * 2);       // and it fits inside the ring rather than bursting it
    expect(b.h).toBeGreaterThan(r * 0.7);  // …but is big enough to read as a heart, not a speck
  });

  it('keeps the flash a burst rather than a star', () => {
    // Three short rays that do NOT meet at a point. Rays meeting at their origin are a sparkle,
    // which this set already has twice; light leaving a lamp has a gap at the lamp.
    const rays = paths(render('heartlens').calls).filter((s) => s.pts.length === 2 && s.ops.includes('lineTo'));
    expect(rays.length).toBe(3);
    const ends = rays.map((s) => s.pts[0]);
    expect(box(ends).w).toBeGreaterThan(0);
    expect(box(ends).h).toBeGreaterThan(0);
  });
});

describe('the ink', () => {
  it('never fills anything, on any kind, at any size', () => {
    // These print on home inkjets, where a filled shape is both uglier and dearer than an outline —
    // and it is the easiest thing in the world for a new motif to reach for, since closePath() then
    // fill() is one word away from closePath() then stroke().
    for (const { key } of DECOR_KINDS) {
      if (key === 'none') continue;
      for (const scale of [0.6, 1.8]) {
        const { calls, props } = render(key, { scale, pos: 'both' });
        expect(calls.filter((c) => c.op.startsWith('fill')).map((c) => c.op), key).toEqual([]);
        expect(props.fillStyle, key).toBeUndefined();
      }
    }
  });
});


// A motif a host can PLACE must actually draw. drawDecorAt dispatches through paintMotif, which was
// lifted out of drawDecor's `top` slot — and two kinds (cameraline, confetti) never lived in that
// block, because they have their own early-return branches. Placing either produced a draggable box
// containing nothing, and neither the type system nor any other test noticed.
//
// This is the guard: the registry is the list of what can be placed, so the registry is what gets
// iterated. A positional motif added later without a paintMotif branch fails here.
describe('every positional motif draws something when placed by hand', () => {
  const positional = DECOR_KINDS.filter((d) => d.positional);

  it('has motifs to check', () => {
    expect(positional.length).toBeGreaterThan(5);
  });

  for (const d of positional) {
    it(`${d.key} (${d.label}) puts ink on the page`, () => {
      const r = recorder();
      drawDecorAt(r.ctx, {
        kind: d.key as DecorKind, x: 0.5, y: 0.4, scale: 1, rot: 0,
        colour: '#111', unit: 1, card: CARD,
      });
      // A stroke is the only thing that marks paper here — the whole vocabulary is stroke-only.
      const strokes = r.calls.filter((c) => c.op === 'stroke').length;
      expect(strokes, `${d.key} drew nothing`).toBeGreaterThan(0);
    });
  }

  it('refuses the kinds that have no position to be placed at', () => {
    // A border is the edges of the paper and a camera wrap is defined by the code. "Drop one here"
    // is not something either can mean, so drawDecorAt must decline rather than draw them adrift.
    for (const kind of ['frame', 'wave', 'camera', 'none'] as DecorKind[]) {
      const r = recorder();
      drawDecorAt(r.ctx, { kind, x: 0.5, y: 0.5, scale: 1, rot: 0, colour: '#111', unit: 1, card: CARD });
      expect(r.calls.filter((c) => c.op === 'stroke').length, `${kind} should not place`).toBe(0);
    }
  });

  it('puts a placed motif where it was placed, not where the slot would have put it', () => {
    const near = (x: number, y: number) => {
      const r = recorder();
      drawDecorAt(r.ctx, { kind: 'hearts', x, y, scale: 1, rot: 0, colour: '#111', unit: 1, card: CARD });
      const t = r.calls.filter((c) => c.op === 'translate')[0];
      return t?.args ?? [];
    };
    expect(near(0.5, 0.4)).toEqual([CARD.x + 0.5 * CARD.w, CARD.y + 0.4 * CARD.h]);
    expect(near(0.2, 0.9)).toEqual([CARD.x + 0.2 * CARD.w, CARD.y + 0.9 * CARD.h]);
  });
});
