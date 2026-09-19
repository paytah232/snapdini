// The trick-card renderer, tested by RUNNING it.
//
// Everything here used to be checked by reading PosterModal.svelte as a string — that drawCard()
// contained `cardPaintFor(set)`, that titleGeom() contained `cardDesignFor(set).layout`. Those
// greps were the best evidence available while the renderer lived inside a component, and they
// check the shape of the source rather than what it paints: a grep passes just as happily when the
// function it is looking at is never called.
//
// Now the renderer is a module, so the rules can be pinned by drawing and looking at the ink.
import { describe, it, expect } from 'vitest';
import {
  cardDesignFor, cardPaintFor, cardLabelFor, cardBoxAt, sheetGeom, titleGeom, joinGeom,
  drawCard, drawSheet, listGeom, readCardSets, readCardLayout, cloneCardLayout, DEFAULT_CARD_LAYOUT,
  CARD_GAP, CARD_PAD,
  type CardDesign, type CardRenderOpts, type CardSet,
} from './cardRender';
import { PAGE_H, PAGE_W } from './posterRender';

// ── A context that remembers what was painted, and in what ─────────────────
// The same idiom posterRender.test.ts uses, plus the fill colour at the moment of each mark —
// which is the whole question here: WHOSE ink went onto this card?
type Mark = { kind: 'text' | 'rect'; text?: string; x: number; y: number; fill: string };
function recCtx() {
  const st = { font: '400 10px Arial', letterSpacing: '0px', fillStyle: '' };
  const marks: Mark[] = [];
  // Recorded, not a noop: the dash pattern is the only thing on a sheet that identifies a cut guide.
  const dashes: number[][] = [];
  const width = (t: string) => {
    const m = /(\d+(?:\.\d+)?)px/.exec(st.font);
    return t.length * (m ? parseFloat(m[1]) : 10) * 0.5;
  };
  const noop = () => {};
  const ctx = {
    get font() { return st.font; }, set font(v: string) { st.font = v; },
    get letterSpacing() { return st.letterSpacing; }, set letterSpacing(v: string) { st.letterSpacing = v; },
    get fillStyle() { return st.fillStyle; }, set fillStyle(v: string) { st.fillStyle = v; },
    strokeStyle: '', lineWidth: 0, lineCap: '', textAlign: '', textBaseline: '',
    imageSmoothingEnabled: false,
    measureText: (t: string) => ({ width: width(t) }),
    fillText: (t: string, x: number, y: number) => { marks.push({ kind: 'text', text: t, x, y, fill: st.fillStyle }); },
    fillRect: (x: number, y: number) => { marks.push({ kind: 'rect', x, y, fill: st.fillStyle }); },
    drawImage: noop, save: noop, restore: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, arcTo: noop, fill: noop, stroke: noop, translate: noop,
    rotate: noop, scale: noop, clip: noop, arc: noop, quadraticCurveTo: noop,
    setLineDash: (d: number[]) => { dashes.push(d); },
    bezierCurveTo: noop, ellipse: noop, rect: noop, setTransform: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, marks, dashes };
}

const SETS: CardSet[] = [
  { key: 'a', label: 'Card A', items: [{ id: 'a1', text: 'The cake' }, { id: 'a2', text: 'The first dance' }] },
  { key: 'b', label: 'Card B', items: [{ id: 'b1', text: 'The speeches' }, { id: 'b2', text: 'Grandma dancing' }] },
  { key: 'c', label: 'Card C', items: [{ id: 'c1', text: 'The bar' }] },
];
const [A, B, C] = SETS;

// Card B's own look: four colours nothing else uses, and an arrangement of its own.
const B_LOOK: CardDesign = {
  cTitle: '#7a1f3d', cBody: '#2b3a67', cCode: '#0a5c36', cBg: '#fdf3e7',
  layout: { title: { x: 0.30, y: 0.30, size: 40 }, qr: { x: 0.70, y: 0.70, size: 240 }, list: { x: 0.5, y: 0.5, size: 0 } },
};

const opts = (over: Partial<CardRenderOpts> = {}): CardRenderOpts => ({
  oneDesign: false,
  base: { cTitle: '', cBody: '', cCode: '', cBg: '', layout: cloneCardLayout(DEFAULT_CARD_LAYOUT) },
  overrides: { b: B_LOOK },
  baseKey: 'a', setCount: SETS.length,
  typeSetKey: 'plain', titleFace: 'display',
  // Three poster inks that read on white, so readableOn passes them through untouched and an
  // assertion about a colour is an assertion about which design was consulted, not about contrast.
  posterInk: { headline: '#5b2333', steps: '#333333', code: '#111111' },
  posterBg: '#ffffff', posterBgSrc: null,
  heading: 'Ana & Ben', glyph: '□', inkSaver: false, round: true, ids: true,
  labelPos: 'above', labelSize: 19,
  showQr: true, showLink: true, caption: 'Tick them off in the app', codeMode: 'url',
  cardsPerSheet: 4, sheetLandscape: false,
  joinCode: 'ABCD1234', cleanUrl: 'snapdini.com/j/ABCD1234',
  decorKind: 'none', decorPos: 'top', decorScale: 1, decorColour: '',
  ...over,
});

const IMG = {} as HTMLImageElement;
const sheetOf = (o: CardRenderOpts) => sheetGeom(o.cardsPerSheet, o.sheetLandscape);
function paintCard(set: CardSet, o: CardRenderOpts, ox = 0, oy = 0) {
  const m = recCtx();
  drawCard(m.ctx, set, { ox, oy, sheet: sheetOf(o), qrImage: IMG, bg: null }, o);
  return m.marks;
}
const fills = (marks: Mark[]) => new Set(marks.map((k) => k.fill));

// ── Whose look a card gets ──────────────────────────────────────────────────
// The rule is cardLookFor() in posterFlow, tested there on its own terms. What is tested HERE is
// that the renderer actually applies it, per set, on every path that reads a design.
describe('absent means inherit', () => {
  it('gives the base card the base design, always — it cannot have an entry of its own', () => {
    const o = opts({ overrides: { a: B_LOOK, b: B_LOOK } });
    // Even with an entry sitting under its key: the FIRST card is the design the others follow, so
    // an entry for it would make "↺ Same as Card A" mean nothing.
    expect(cardDesignFor(A, o)).toBe(o.base);
  });

  it('gives a card with no entry the base design — the same OBJECT, not a copy', () => {
    const o = opts();
    // Identity, not equality. A copy would look identical today and stop tracking the moment the
    // host changed Card A, which is the bug "follows Card A" is supposed to rule out.
    expect(cardDesignFor(C, o)).toBe(o.base);
    expect(cardDesignFor(B, o)).toBe(B_LOOK);
  });

  it('gives EVERY card the base design while one design is on', () => {
    const o = opts({ oneDesign: true });
    for (const s of SETS) expect(cardDesignFor(s, o)).toBe(o.base);
  });

  it('follows the base LIVE, so letting go of an override really is letting go', () => {
    // "↺ Same as Card A" deletes the entry rather than copying Card A's values into it. What that
    // has to mean afterwards is this: change Card A, and the card that let go changes with it.
    const o = opts({ overrides: {} });
    o.base.cTitle = '#123456';
    expect(cardPaintFor(B, o).ink.title).toBe('#123456');
  });

  it('falls back to the base for a card whose key is not in the map at all', () => {
    const o = opts();
    expect(cardDesignFor({ key: 'nope', label: 'X', items: [] }, o)).toBe(o.base);
    expect(cardDesignFor(null, o)).toBe(o.base);
  });
});

// ── Which card's ink actually goes on the paper ─────────────────────────────
describe('a card is painted from its OWN design', () => {
  it('resolves the four colours from the card, not from the base', () => {
    const o = opts();
    const b = cardPaintFor(B, o), a = cardPaintFor(A, o);
    expect(b.ink.title).toBe('#7a1f3d');
    expect(b.ink.body).toBe('#2b3a67');
    expect(b.ink.code).toBe('#0a5c36');
    expect(b.bgHex).toBe('#fdf3e7');
    // Card A has no overrides, so it inherits the poster's inks and the poster's paper.
    expect(a.ink.title).toBe('#5b2333');
    expect(a.ink.body).toBe('#333333');
    expect(a.ink.code).toBe('#111111');
    expect(a.bgHex).toBe('#ffffff');
  });

  it('puts Card B’s ink on Card B and Card A’s on Card A', () => {
    // THE bug this whole shape exists to rule out. A draw site reading the previewed card's
    // colours prints the entire stack in them, and nothing on screen says so — the sheet only
    // looks wrong once it is on paper.
    const o = opts();
    const onB = fills(paintCard(B, o));
    const onA = fills(paintCard(A, o));
    for (const c of ['#7a1f3d', '#2b3a67', '#fdf3e7']) {
      expect(onB.has(c), `${c} on Card B`).toBe(true);
      expect(onA.has(c), `${c} must not reach Card A`).toBe(false);
    }
    expect(onA.has('#5b2333')).toBe(true);
    expect(onB.has('#5b2333')).toBe(false);
  });

  it('lays the title out where the CARD says, not where the base does', () => {
    const o = opts();
    const g = cardBoxAt(0, 0, sheetOf(o));
    const m = recCtx();
    const tA = titleGeom(m.ctx, g, A, o), tB = titleGeom(m.ctx, g, B, o);
    // B's title box is at x 0.30 and A's at 0.50 — different cards, different places.
    expect(tB.rect.x).toBeLessThan(tA.rect.x);
    expect(tB.size).toBe(40);
    expect(tA.size).toBe(34);
    const jA = joinGeom(m.ctx, g, A, o), jB = joinGeom(m.ctx, g, B, o);
    expect(jB!.qr!.w).toBeGreaterThan(jA!.qr!.w);
  });

  it('is not disturbed by a card drawn just before it', () => {
    // The module holds no state, so "whatever was drawn last" cannot exist as a concept. Drawing
    // B and then A must give exactly the A that a fresh call gives.
    const o = opts();
    const fresh = JSON.stringify(paintCard(A, o));
    const m = recCtx();
    const s = sheetOf(o);
    drawCard(m.ctx, B, { ox: 0, oy: 0, sheet: s, qrImage: IMG, bg: null }, o);
    const after = m.marks.length;
    drawCard(m.ctx, A, { ox: 0, oy: 0, sheet: s, qrImage: IMG, bg: null }, o);
    expect(JSON.stringify(m.marks.slice(after))).toBe(fresh);
  });

  it('paints every card on a SHEET from the set that sheet is for', async () => {
    const o = opts();
    const m = recCtx();
    await drawSheet(m.ctx, B, { ...o, qrSrc: 'x', loadImage: async () => IMG });
    const seen = fills(m.marks);
    expect(seen.has('#7a1f3d')).toBe(true);
    expect(seen.has('#5b2333')).toBe(false);
    // Four to a sheet means four card grounds painted, not one.
    expect(m.marks.filter((k) => k.kind === 'rect' && k.fill === '#fdf3e7')).toHaveLength(4);
  });

  it('gives two sheets drawn from ONE opts object their own colours', async () => {
    // Two pages of the same stack, painted back to back off the same options — the case that goes
    // wrong the instant a renderer keeps state.
    const o = opts();
    const shot = async (set: CardSet) => {
      const m = recCtx();
      await drawSheet(m.ctx, set, { ...o, qrSrc: 'x', loadImage: async () => IMG });
      return fills(m.marks);
    };
    const [fb, fa] = [await shot(B), await shot(A)];
    expect(fb.has('#7a1f3d')).toBe(true);
    expect(fa.has('#7a1f3d')).toBe(false);
    expect(fa.has('#5b2333')).toBe(true);
  });

  it('prints one matching set while "one design" is on', async () => {
    const o = opts({ oneDesign: true });
    expect(fills(paintCard(B, o))).toEqual(fills(paintCard(A, o)));
  });
});

// ── The rest of the paint rule ──────────────────────────────────────────────
describe('what a card is printed on', () => {
  it('lets a card colour of its own beat the poster’s photo', () => {
    const o = opts({ posterBgSrc: 'photo.jpg' });
    expect(cardPaintFor(A, o).useImage).toBe(true);   // no colour of its own → the photo
    expect(cardPaintFor(B, o).useImage).toBe(false);  // asked for a colour → a plain card
    expect(cardPaintFor(B, o).bgHex).toBe('#fdf3e7');
  });

  it('forces white, and drops the photo, when the host asks for plain cards', () => {
    const o = opts({ posterBgSrc: 'photo.jpg', inkSaver: true });
    expect(cardPaintFor(B, o).bgHex).toBe('#ffffff');
    expect(cardPaintFor(A, o).useImage).toBe(false);
  });

  it('walks an ink that would vanish until it reads — against the CARD’s ground', () => {
    // A colour picked on the poster is not necessarily readable on a card the host has since made
    // dark. Same title ink, two grounds, two answers.
    const light = cardPaintFor(A, opts({ posterInk: { headline: '#f2f2f2', steps: '#f2f2f2', code: '#f2f2f2' } }));
    expect(light.ink.title).not.toBe('#f2f2f2');
    const dark = cardPaintFor(A, opts({
      posterBg: '#101010',
      posterInk: { headline: '#f2f2f2', steps: '#f2f2f2', code: '#f2f2f2' },
    }));
    expect(dark.ink.title).toBe('#f2f2f2');
    expect(dark.dark).toBe(true);
  });

  it('gives the tick the design’s accent, unless the trick list has a colour of its own', () => {
    const o = opts();
    // Card B set the list's colour, so the whole column is that colour, tick included.
    expect(cardPaintFor(B, o).tickInk).toBe(cardPaintFor(B, o).ink.body);
    // Card A did not, so the tick follows the title's accent rather than flat body ink.
    const a = cardPaintFor(A, o);
    expect(a.tickInk).toBe('#5b2333');
    expect(a.tickInk).not.toBe(a.ink.body);
  });
});

// ── The identifier ──────────────────────────────────────────────────────────
describe('the card identifier', () => {
  it('prints the set’s label in caps', () => {
    expect(cardLabelFor(B, opts())).toBe('CARD B');
  });
  it('is not printed when the host turns it off, or when there is nothing to confuse it with', () => {
    expect(cardLabelFor(B, opts({ ids: false }))).toBe('');
    expect(cardLabelFor(B, opts({ setCount: 1 }))).toBe('');
    expect(cardLabelFor(null, opts())).toBe('');
  });
  it('reserves the same height above the title as below it, so nothing under it moves', () => {
    // The rule under the title and the trick list below must not shift when the host changes the
    // side — the block is the same size either way.
    const o = opts();
    const g = cardBoxAt(0, 0, sheetOf(o));
    const m = recCtx();
    const above = titleGeom(m.ctx, g, A, o).rect;
    const below = titleGeom(m.ctx, g, A, opts({ labelPos: 'below' })).rect;
    expect(below.h).toBe(above.h);
    expect(below.y).toBe(above.y);
  });
});

// ── The sheet ───────────────────────────────────────────────────────────────
describe('how a sheet is divided', () => {
  // A4 halves into two A5 and quarters into four A6, so 1, 2 and 4 all tile a sheet with nothing
  // left over. All six combinations, in the numbers the cards are actually laid out with.
  const TABLE: [4 | 2 | 1, boolean, number, number, number][] = [
    // per, sheetLandscape, cols, rows, unit
    [4, false, 2, 2, 1],
    [4, true, 2, 2, 1],
    [2, false, 1, 2, 1],
    [2, true, 2, 1, 1],
    [1, false, 1, 1, 2],
    [1, true, 1, 1, 2],
  ];
  for (const [per, land, cols, rows, unit] of TABLE) {
    it(`${per}-up on ${land ? 'landscape' : 'portrait'} paper is ${cols}×${rows} at unit ${unit}`, () => {
      const g = sheetGeom(per, land);
      expect([g.cols, g.rows, g.unit]).toEqual([cols, rows, unit]);
      // The paper follows the orientation, and the tiles fill it exactly.
      expect([g.sheetW, g.sheetH]).toEqual(land ? [PAGE_H, PAGE_W] : [PAGE_W, PAGE_H]);
      expect(g.slotW * g.cols).toBeCloseTo(g.sheetW, 9);
      expect(g.slotH * g.rows).toBeCloseTo(g.sheetH, 9);
    });
  }

  it('scales by the card’s HEIGHT, so only the full-page card grows', () => {
    // A quarter-sheet A6 and a half-sheet A5 are both half an A4 tall, and the vertical space is
    // the only thing a list down a card competes for. Scaling A5 by area would make its QR half
    // again as tall for no gain.
    expect(sheetGeom(4, false).slotH).toBe(sheetGeom(2, false).slotH);
    expect(sheetGeom(4, false).unit).toBe(sheetGeom(2, false).unit);
    expect(sheetGeom(1, false).unit).toBe(2);
  });

  it('inset every card from its slot by the same gutter, whatever the size', () => {
    for (const per of [4, 2, 1] as const) {
      const s = sheetGeom(per, false);
      const g = cardBoxAt(0, 0, s);
      expect(g.x0).toBe(CARD_GAP * s.unit);
      expect(g.cw).toBe(s.slotW - CARD_GAP * s.unit * 2);
      expect(g.innerW).toBe(g.cw - CARD_PAD * s.unit * 2);
    }
  });

  it('lays a card in every slot on the sheet', async () => {
    for (const per of [4, 2, 1] as const) {
      const o = opts({ cardsPerSheet: per, oneDesign: true });
      const m = recCtx();
      await drawSheet(m.ctx, A, { ...o, qrSrc: 'x', loadImage: async () => IMG });
      // One card ground per card. (Card A has no colour of its own, so it is the poster's paper.)
      expect(m.marks.filter((k) => k.kind === 'rect' && k.fill === '#ffffff').length).toBeGreaterThanOrEqual(per);
    }
  });

  // On by default, and OFF has to actually reach the paper — a toggle that quietly keeps drawing is
  // worse than no toggle. `setLineDash` is the tell: nothing else on a sheet is dashed.
  it('draws cut guides unless they are turned off', async () => {
    const o = opts({ cardsPerSheet: 4, oneDesign: true });
    const dashed = async (cutLines?: boolean) => {
      const m = recCtx();
      await drawSheet(m.ctx, A, { ...o, cutLines, qrSrc: 'x', loadImage: async () => IMG });
      // [9,9] specifically. A card's own write-on rule is dashed too (drawCard uses [4u,5u]), so
      // "was anything dashed" cannot tell a cut guide from card furniture.
      return m.dashes.some((d) => d[0] === 9 && d[1] === 9);
    };
    expect(await dashed(undefined), 'a design saved before the toggle existed keeps its guides').toBe(true);
    expect(await dashed(true)).toBe(true);
    expect(await dashed(false)).toBe(false);
  });
});

// ── The stored blob ─────────────────────────────────────────────────────────
describe('reading per-card overrides out of a saved design', () => {
  it('reads none out of a design that has none — including a design saved before they existed', () => {
    for (const raw of [undefined, null, {}, [], 'nope', 7]) expect(readCardSets(raw)).toEqual({});
  });

  // The BASE card's layout is restored from the same blob by PosterModal, and that reader spread it
  // raw while the per-card overrides beside it were validated. One reader now, so the two cannot
  // disagree about what a drawable box is.
  it('and the base card layout gets exactly the same reader', () => {
    expect(readCardLayout(undefined)).toEqual(DEFAULT_CARD_LAYOUT);
    expect(readCardLayout({ qr: null }).qr).toEqual(DEFAULT_CARD_LAYOUT.qr);
    expect(readCardLayout({ title: { size: 1e9 } }).title.size).toBeLessThan(1e9);
    expect(readCardLayout({ title: { x: 0.2, y: 0.3, size: 20 } }).title).toEqual({ x: 0.2, y: 0.3, size: 20 });
    // Whole, always — placeOnCard() reads both keys and NaN draws nothing.
    expect(Object.keys(readCardLayout({}).title).sort()).toEqual(['size', 'x', 'y']);
  });

  it('drops a bad entry rather than refusing to open the design', () => {
    // A bad box reaches placeOnCard() as NaN, which draws nothing — indistinguishable from the card
    // having lost its title. Losing one card's colours beats refusing to open the host's design.
    const got = readCardSets({ b: null, c: { cTitle: '#fff', layout: { title: { x: 'x', y: 2, size: -3 } } } });
    expect(got.b).toBeUndefined();
    expect(got.c.cTitle).toBe('#fff');
    expect(got.c.layout.title.x).toBe(DEFAULT_CARD_LAYOUT.title.x);   // not a number → the default
    expect(got.c.layout.title.y).toBe(1);                              // out of range → clamped
    expect(got.c.layout.title.size).toBe(1);
    expect(got.c.layout.qr).toEqual(DEFAULT_CARD_LAYOUT.qr);           // absent → the default
  });

  it('never hands back a layout shared with the defaults', () => {
    // Two cards sharing one layout object would drag together.
    const got = readCardSets({ b: {}, c: {} });
    got.b.layout.title.x = 0.1;
    expect(got.c.layout.title.x).not.toBe(0.1);
    expect(DEFAULT_CARD_LAYOUT.title.x).not.toBe(0.1);
  });
});

// ── The join block ──────────────────────────────────────────────────────────
describe('the join block', () => {
  it('is absent entirely when nothing is switched on — a pure shot list', () => {
    const o = opts({ showQr: false, showLink: false, caption: '' });
    const m = recCtx();
    expect(joinGeom(m.ctx, cardBoxAt(0, 0, sheetOf(o)), A, o)).toBeNull();
  });

  it('keeps its text beside the QR rather than under it', () => {
    const o = opts();
    const m = recCtx();
    const j = joinGeom(m.ctx, cardBoxAt(0, 0, sheetOf(o)), A, o)!;
    expect(j.tx).toBeGreaterThanOrEqual(j.qr!.x + j.qr!.w);
  });

  it('keeps its whole footprint inside the card’s quiet margin, at every sheet size', () => {
    // A Box is a fraction of the card but the thing it positions is sized in paper-scaled px, so
    // the fraction that suits an A6 hangs an A5's bigger QR over the edge without the clamp.
    for (const per of [4, 2, 1] as const) {
      const o = opts({ cardsPerSheet: per, base: { ...opts().base, layout: { title: { x: 0.5, y: 0.17, size: 34 }, qr: { x: 0.99, y: 0.99, size: 200 }, list: { x: 0.5, y: 0.5, size: 0 } } } });
      const s = sheetOf(o);
      const g = cardBoxAt(0, 0, s);
      const m = recCtx();
      const j = joinGeom(m.ctx, g, A, o)!;
      expect(j.rect.x).toBeGreaterThanOrEqual(g.x0 + g.pad - 0.001);
      expect(j.rect.x + j.rect.w).toBeLessThanOrEqual(g.x0 + g.cw - g.pad + 0.001);
      expect(j.rect.y + j.rect.h).toBeLessThanOrEqual(g.y0 + g.ch - g.pad + 0.001);
    }
  });
});

// ── Moving the trick list ───────────────────────────────────────────────────
//
// The list could not be moved at all, on the stated grounds that "a list that could be dragged
// under the QR would be a card nobody can print". That reason is sound and these tests are what let
// the feature exist without breaking it: the list moves, and it still cannot reach either block.
//
// The nudge is measured from the DEFAULT rather than read as an absolute position, which is the
// part most likely to get "simplified" into `y * ch` by someone reading it later. That would move
// every card ever saved, silently, since they all carry the default y.
describe('moving the trick list', () => {
  // Five tricks, so the block is tall enough for the clamps to have something to bite on.
  const MANY: CardSet = { key: 'a', label: 'Card A', items:
    ['Someone laughing', 'The oldest guest', 'A bad dance move', 'The cake', 'Two strangers talking']
      .map((text, i) => ({ id: `t${i}`, text })) };

  function geom(listY: number) {
    const o = opts({ base: { cTitle: '', cBody: '', cCode: '', cBg: '',
      layout: { ...cloneCardLayout(DEFAULT_CARD_LAYOUT), list: { x: 0.5, y: listY, size: 0 } } } });
    const m = recCtx();
    const g = cardBoxAt(0, 0, sheetOf(o));
    const t = titleGeom(m.ctx, g, MANY, o);
    const j = joinGeom(m.ctx, g, MANY, o);
    // The same rule the editor uses — 10u below the title block.
    const ruleY = t.rect.y + t.rect.h + 10 * g.u;
    return { g, t, j, l: listGeom(m.ctx, g, MANY, o, t, j, ruleY), ruleY };
  }

  const D = DEFAULT_CARD_LAYOUT.list.y;

  /** The region listGeom lays the list out in: below the title rule, above the join block. */
  const region = (b: ReturnType<typeof geom>) =>
    ({ top: b.ruleY + 20 * b.g.u, bottom: b.j!.rect.y - 20 * b.g.u });

  it('moves by exactly what was dragged', () => {
    const base = geom(D);
    const { top, bottom } = region(base);
    // A nudge chosen to sit well INSIDE the clamp. Asking for a fixed 0.05 of the card first
    // asserted 38px of travel in a gap with 16px of slack — the clamp was right and the test was
    // wrong, which is worth leaving written down: on a full card there is very little room.
    const dy = (bottom - top - base.l.rect.h) / 4;
    expect(dy).toBeGreaterThan(1);
    expect(geom(D + dy / base.g.ch).l.rect.y - base.l.rect.y).toBeCloseTo(dy, 3);
    expect(geom(D - dy / base.g.ch).l.rect.y - base.l.rect.y).toBeCloseTo(-dy, 3);
  });

  it('leaves a card saved before it could move EXACTLY where it was', () => {
    // The delta is from the default, so the default is a no-op. Read as an absolute position this
    // would land the list at the card's midpoint instead of centred in the gap — a silent
    // relayout of every card in existence.
    const base = geom(D);
    const { top, bottom } = region(base);
    const centredInGap = top + Math.max(0, (bottom - top - base.l.rect.h) / 2);
    expect(base.l.rect.y).toBeCloseTo(centredInGap, 3);
  });

  it('CANNOT be pushed into the join block, however far it is dragged', () => {
    const far = geom(D + 5);
    expect(far.l.rect.y + far.l.rect.h).toBeLessThanOrEqual(far.j!.rect.y);
  });

  it('CANNOT be pushed up into the title', () => {
    const up = geom(D - 5);
    expect(up.l.rect.y).toBeGreaterThanOrEqual(region(up).top - 0.001);
    expect(up.l.rect.y).toBeGreaterThanOrEqual(up.t.rect.y + up.t.rect.h);
  });

  it('still spans the full printable width, which is why sideways is locked', () => {
    // If this ever stops being true there IS room to move it sideways, and PosterModal's
    // `lockX: (k) => k === 'list'` should be revisited rather than left as a mystery.
    const { g, l } = geom(D);
    expect(l.rect.x).toBeCloseTo(g.x0 + g.pad, 3);
    expect(l.rect.w).toBeCloseTo(g.innerW, 3);
  });
});
