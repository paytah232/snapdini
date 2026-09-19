// The name lockup takes ONE typed line and decides whether it is two names or one. Getting that
// wrong is the kind of bug a host discovers on printed paper, so the split is pinned here.
import { describe, it, expect } from 'vitest';
import {
  splitNames, clonePosterLayout, qrPanelRect, symbolContrast, contrastGrade, panelOptional, reflectance,
  PANEL_OPTIONAL_MIN, inkOf, measureNames, type PosterInk,
  DEFAULT_POSTER_LAYOUT, PAGE_H, PAGE_W, FOOTER_MAX_W, footerMaxW, clonePosterLayout as cloneL,
  drawPoster, measureBodyBlock, measureFooterUrl, measureTextItem, BODY_MAX_W, wrapToLines, type Box,
  qrImageRect, qrKeepOut, rotatedRect, readBox, readPosterLayout, BOX_SIZE_MAX, BOX_SIZE_MIN,
} from './posterRender';
import { castFor, typeSet, type TypeSetKey } from './posterFonts';

describe('splitting a typed name line into a lockup', () => {
  it('splits on the separator the host actually typed, and keeps it', () => {
    // Whatever they wrote goes in the middle verbatim — someone who types "&" wants an ampersand,
    // not our idea of what they meant by it.
    expect(splitNames('Rachel and Ross')).toEqual({ left: 'Rachel', joiner: 'and', right: 'Ross' });
    expect(splitNames('Mia & Sam')).toEqual({ left: 'Mia', joiner: '&', right: 'Sam' });
    expect(splitNames('Jo + Alex')).toEqual({ left: 'Jo', joiner: '+', right: 'Alex' });
    expect(splitNames('OLIVIA AND MICHAEL')?.joiner).toBe('AND');
  });

  it('only splits on a whole word, not inside one', () => {
    // The obvious bug: "Alexander" contains "and", and splitting there would print "Alex" over a
    // script "and" over "er".
    expect(splitNames('Alexander')).toBeNull();
    expect(splitNames('Alexander and Sam')).toEqual({ left: 'Alexander', joiner: 'and', right: 'Sam' });
    expect(splitNames('Amanda')).toBeNull();
    expect(splitNames('Sandy')).toBeNull();
  });

  it('splits once, so a longer line stays a lockup rather than becoming a list', () => {
    expect(splitNames('Mia & Sam & the dog')).toEqual({ left: 'Mia', joiner: '&', right: 'Sam & the dog' });
  });

  it('treats a line with nothing on one side as a line, not a lockup', () => {
    // "and Ross" is something a host typed mid-thought. Drawing a hairline rule above it with
    // nothing to join to would look like a mistake, because it is one.
    expect(splitNames('and Ross')).toBeNull();
    expect(splitNames('Rachel and')).toBeNull();
    expect(splitNames('&')).toBeNull();
  });

  it('leaves a family name alone', () => {
    expect(splitNames('The Petersons')).toBeNull();
    expect(splitNames('')).toBeNull();
  });

  it('trims what it hands back, so spacing in the field never reaches the poster', () => {
    expect(splitNames('  Rachel   and   Ross  ')).toEqual({ left: 'Rachel', joiner: 'and', right: 'Ross' });
  });
});

describe('the poster layout', () => {
  it('carries a box for every element, names included', () => {
    // A missing box is not a missing element — it is `undefined.x` inside the renderer.
    for (const k of ['brand', 'title', 'message', 'steps', 'qr', 'footer', 'names'] as const) {
      expect(DEFAULT_POSTER_LAYOUT[k]).toBeDefined();
      expect(DEFAULT_POSTER_LAYOUT[k].size).toBeGreaterThan(0);
    }
  });

  it('clones every box rather than sharing one', () => {
    // A shallow copy here means dragging one design moves the element on every other design that
    // was cloned from the same default.
    const a = clonePosterLayout(DEFAULT_POSTER_LAYOUT);
    a.names.x = 0.1; a.title.y = 0.9;
    expect(DEFAULT_POSTER_LAYOUT.names.x).not.toBe(0.1);
    expect(DEFAULT_POSTER_LAYOUT.title.y).not.toBe(0.9);
    for (const k of Object.keys(DEFAULT_POSTER_LAYOUT) as (keyof typeof DEFAULT_POSTER_LAYOUT)[]) {
      expect(a[k]).not.toBe(DEFAULT_POSTER_LAYOUT[k]);
    }
  });

  it('stacks the foot of the page in the right order', () => {
    const l = DEFAULT_POSTER_LAYOUT;
    expect(l.title.y).toBeLessThan(l.message.y);
    expect(l.message.y).toBeLessThan(l.qr.y);
    expect(l.qr.y).toBeLessThan(l.names.y);
    expect(l.names.y).toBeLessThan(l.steps.y);
    expect(l.steps.y).toBeLessThan(l.footer.y);
    expect(l.footer.y).toBeLessThan(1);
  });

  it('starts the name lockup below the QR PANEL, not below the QR box', () => {
    // This is the bug the first proof render caught: the panel is `size + 195` tall whenever
    // anything prints under the code, so it reaches ~0.806 down the page while the QR box alone
    // suggests ~0.742. The names sat at 0.795 and printed straight through the join URL.
    const panel = qrPanelRect(DEFAULT_POSTER_LAYOUT.qr, 'url');
    const panelBottom = (panel.y + panel.h) / PAGE_H;
    // Half the lockup's own height has to clear it too — three rows at the default size is roughly
    // 110px, so 55px is 0.036 of the page.
    const halfBlock = 0.036;
    expect(DEFAULT_POSTER_LAYOUT.names.y - halfBlock).toBeGreaterThan(panelBottom);
  });

  it('leaves the how-to line clear of the lockup underneath it', () => {
    const gap = DEFAULT_POSTER_LAYOUT.steps.y - DEFAULT_POSTER_LAYOUT.names.y;
    expect(gap).toBeGreaterThan(0.05);
  });

  it('finishes the link inside any border motif, not across it', () => {
    // A border is drawn about 65px in from the paper's edge. The link used to sit 42px in, so
    // `frame` printed a rule straight through the join URL — on every poster that used it.
    const f = DEFAULT_POSTER_LAYOUT.footer;
    const bottomMargin = PAGE_H - (f.y * PAGE_H + f.size / 2);
    expect(bottomMargin).toBeGreaterThan(70);
  });
});

// ── Restoring a saved design ─────────────────────────────────────────────────
//
// A poster design is a blob stored server-side and spread back over the live state on every open,
// and PosterModal's restore() was the one reader here that spread it RAW — every sibling
// (readCardSets, readTextItems, the decoration reader) validates. Both consequences are
// organizer-scoped and permanent, because the bad value is restored again on the next open:
//
//   { layout: { footer: { size: 1e9 } } }  →  fitted() walks `size -= 2` from a billion with a
//                                             measureText on every step. The tab stops responding.
//                                             Infinity never terminates at all.
//   { layout: { qr: null } }               →  `layout.qr.size` is read in a Svelte reactive block,
//                                             outside any catch, so the designer throws on mount and
//                                             the host cannot open their own poster again.
//
// The clamp is the one readCardSets has always had, moved here beside the Box type so the poster,
// the cards and the per-card overrides cannot end up with three ideas of what is drawable.

describe('a stored box is clamped into something drawable', () => {
  const D: Box = { x: 0.5, y: 0.5, size: 100 };

  it('keeps a value that is already fine', () => {
    expect(readBox({ x: 0.25, y: 0.75, size: 42 }, D)).toEqual({ x: 0.25, y: 0.75, size: 42 });
  });

  it('bounds the size that hangs the tab', () => {
    expect(readBox({ size: 1e9 }, D).size).toBe(BOX_SIZE_MAX);
    expect(readBox({ size: Infinity }, D).size).toBe(D.size);
    expect(readBox({ size: NaN }, D).size).toBe(D.size);
    expect(readBox({ size: -5 }, D).size).toBe(BOX_SIZE_MIN);
  });

  it('survives the shapes that throw rather than draw wrong', () => {
    // null, a string, a number, an array — anything JSON can hold.
    for (const junk of [null, undefined, 'nope', 7, [], true]) expect(readBox(junk, D)).toEqual(D);
  });

  it('keeps positions on the page', () => {
    expect(readBox({ x: -3, y: 9 }, D)).toEqual({ x: 0, y: 1, size: D.size });
    expect(readBox({ x: 'left' }, D).x).toBe(D.x);
  });

  it('carries rotation through, and absent stays absent', () => {
    // The cfg blob is what undo compares and what is saved, so writing `rot: 0` onto an element
    // nobody rotated would make opening and closing the designer look like an edit.
    expect('rot' in readBox({ x: 0.5, y: 0.5, size: 10 }, D)).toBe(false);
    expect(readBox({ rot: 0.4 }, D).rot).toBeCloseTo(0.4);
    expect(readBox({ rot: 99 }, D).rot).toBeCloseTo(Math.PI);
    expect('rot' in readBox({ rot: 'sideways' }, D)).toBe(false);
  });
});

describe('a stored poster layout always comes back whole', () => {
  it('fills in every element, whatever the blob held', () => {
    // This is what makes `layout.qr.size` safe to read in a reactive block without a guard.
    for (const junk of [undefined, null, {}, [], 'nope', 7, { qr: null }])
      expect(Object.keys(readPosterLayout(junk)).sort()).toEqual(Object.keys(DEFAULT_POSTER_LAYOUT).sort());
    expect(readPosterLayout({ qr: null }).qr).toEqual(DEFAULT_POSTER_LAYOUT.qr);
  });

  it('keeps the elements the host actually moved', () => {
    const got = readPosterLayout({ title: { x: 0.2, y: 0.3, size: 50 } });
    expect(got.title).toEqual({ x: 0.2, y: 0.3, size: 50 });
    expect(got.footer).toEqual(DEFAULT_POSTER_LAYOUT.footer);
  });

  it('and hands fitted() a size it can finish shrinking', () => {
    // fitted() steps down by 2 from the size it is given and stops at 14. From 1e9 that is half a
    // billion measureText calls; from BOX_SIZE_MAX it is under a thousand.
    const steps = (readPosterLayout({ footer: { size: 1e9 } }).footer.size - 14) / 2;
    expect(steps).toBeLessThan(1000);
  });

  it('does not share structure with the defaults', () => {
    // A restore that handed back the module-level constant would let a drag mutate the default for
    // every poster drawn afterwards in the same tab.
    const got = readPosterLayout({});
    got.title.x = 0.99;
    expect(DEFAULT_POSTER_LAYOUT.title.x).not.toBe(0.99);
  });
});

describe('the QR panel footprint', () => {
  it('grows to make room for whatever prints under the code', () => {
    const box = DEFAULT_POSTER_LAYOUT.qr;
    const bare = qrPanelRect(box, 'none');
    expect(qrPanelRect(box, 'url').h).toBeGreaterThan(bare.h);
    expect(qrPanelRect(box, 'code').h).toBe(qrPanelRect(box, 'url').h);
    // Width never changes with it — only the space below the symbol does.
    expect(qrPanelRect(box, 'url').w).toBe(bare.w);
  });

  it('is centred on the box it was given', () => {
    const r = qrPanelRect({ x: 0.5, y: 0.5, size: 400 }, 'url');
    expect(r.x + r.w / 2).toBeCloseTo(1080 / 2);
    expect(r.y + r.h / 2).toBeCloseTo(PAGE_H / 2);
  });
});

// Dropping the white card behind the QR is the one setting here that can produce a poster which
// LOOKS finished and does not work — an unreadable code is only discovered by a guest, at the
// event, after fifty were printed. So the rule is measured, and the measurement is pinned.
describe('whether a code can sit on the paper without its panel', () => {
  it('measures reflectance difference, not a contrast ratio', () => {
    // Symbol Contrast is Rmax − Rmin per ISO 18004 — an absolute difference. Every "QR needs 4.5:1"
    // claim is WCAG text guidance misapplied to a symbology, and it gives the wrong answer here.
    expect(symbolContrast('#ffffff')).toBeCloseTo(100, 0);
    expect(symbolContrast('#000000')).toBe(0);
    expect(symbolContrast('#808080')).toBeCloseTo(50, 0);
  });

  it('grades the way a verifier does', () => {
    expect(contrastGrade(symbolContrast('#ffffff'))).toBe('A');
    expect(contrastGrade(symbolContrast('#000000'))).toBe('F');
    // The bands themselves, at their edges.
    expect(contrastGrade(70)).toBe('A');
    expect(contrastGrade(69.9)).toBe('B');
    expect(contrastGrade(40)).toBe('C');
    expect(contrastGrade(39.9)).toBe('D');
  });

  it('allows the panel off on real paper colours and refuses on dark stock', () => {
    for (const paper of ['#ffffff', '#faf7f1', '#f2efe9', '#fbf9f4']) {
      expect(panelOptional(paper), `${paper} should be safe`).toBe(true);
    }
    // The Art deco preset's near-black card, and a kraft brown — both exactly the cases the white
    // panel was introduced to survive. Kraft measures 43.7%, a passing grade C, and is refused
    // anyway: see PANEL_OPTIONAL_MIN for why C is not the bar for a sign that gets one attempt.
    for (const paper of ['#12100d', '#101010', '#8a6a45']) {
      expect(panelOptional(paper), `${paper} should be refused`).toBe(false);
    }
  });

  it('draws the line at grade B, and the line actually decides', () => {
    // A threshold nothing falls either side of is decorative. These two are ~2% apart across it.
    expect(PANEL_OPTIONAL_MIN).toBe(55);
    expect(panelOptional('#8c8c8c')).toBe(false);     // 54.9
    expect(panelOptional('#909090')).toBe(true);      // 56.5
    // Mid-grey passes a verifier at grade C and is still refused here, on purpose.
    expect(contrastGrade(symbolContrast('#808080'))).toBe('C');
    expect(panelOptional('#808080')).toBe(false);
  });

  it('treats an unreadable colour as paper rather than blocking the poster', () => {
    // A malformed stored colour must not make the designer refuse an option it cannot reason about;
    // the panel is on by default anyway, so the safe failure is "no change".
    expect(reflectance('not-a-colour')).toBe(100);
    expect(reflectance('')).toBe(100);
  });
});

describe('colours that follow the title', () => {
  // The whole compatibility guarantee of the per-element colours lives in this one fallback. A
  // design saved before they existed carries none of the optional keys, so every one of them has to
  // resolve to the title's colour — which is what the renderer used to hard-code.
  const base: PosterInk = { headline: '#112233', message: '#445566', steps: '#778899', footer: '#aabbcc', code: '#000000' };

  it('an absent key is the title\u2019s colour', () => {
    expect(inkOf(base, 'headlineTop')).toBe('#112233');
    expect(inkOf(base, 'headlineBottom')).toBe('#112233');
    expect(inkOf(base, 'names')).toBe('#112233');
  });

  it('a key that is set wins, and only for itself', () => {
    const ink: PosterInk = { ...base, names: '#ff0000' };
    expect(inkOf(ink, 'names')).toBe('#ff0000');
    expect(inkOf(ink, 'headlineTop')).toBe('#112233');
    expect(inkOf(ink, 'headlineBottom')).toBe('#112233');
  });

  it('follows the title when the title moves, because it is not a copy of it', () => {
    expect(inkOf({ ...base, headline: '#00ff00' }, 'names')).toBe('#00ff00');
  });
});

describe('the names stacker, and opting out of it', () => {
  // A stub context: nameRows only asks how wide a string measures and lets applyFace set a font on
  // it. The heights it returns are what decides whether the lockup is three rows or one.
  const ctx = () => {
    const c = { font: '', letterSpacing: '', measureText: (t: string) => ({ width: t.length * 10 }) };
    return c as unknown as CanvasRenderingContext2D;
  };
  const box = { x: 0.5, y: 0.8, size: 34 };

  it('stacks by default \u2014 exactly as it always has, with the field absent', () => {
    const stacked = measureNames(ctx(), { headline: 'Our Event', names: 'Rachel and Ross' }, box);
    const plain = measureNames(ctx(), { headline: 'Our Event', names: 'The Petersons' }, box);
    // Three rows against one: the lockup is taller than a single line of the same size.
    expect(stacked.h).toBeGreaterThan(plain.h);
  });

  it('true is the same as absent', () => {
    expect(measureNames(ctx(), { headline: 'Our Event', names: 'Rachel and Ross', stackNames: true }, box))
      .toEqual(measureNames(ctx(), { headline: 'Our Event', names: 'Rachel and Ross' }, box));
  });

  it('off sets the typed line verbatim, one row', () => {
    const off = measureNames(ctx(), { headline: 'Our Event', names: 'Rachel and Ross', stackNames: false }, box);
    // Exactly the single row an un-splittable line gets — no joiner, no hairlines, no extra height.
    // ('Rachel and Ross Smithson' would NOT do as the comparison: it splits too.)
    expect(off.h).toBe(measureNames(ctx(), { headline: 'Our Event', names: 'The Petersons' }, box).h);
    expect(off.h).toBeLessThan(measureNames(ctx(), { headline: 'Our Event', names: 'Rachel and Ross' }, box).h);
  });

  it('changes nothing when there was nothing to stack', () => {
    expect(measureNames(ctx(), { headline: 'Our Event', names: 'The Petersons', stackNames: false }, box))
      .toEqual(measureNames(ctx(), { headline: 'Our Event', names: 'The Petersons' }, box));
  });

  it('an empty line is still nothing at all', () => {
    expect(measureNames(ctx(), { headline: 'Our Event', names: '', stackNames: false }, box)).toEqual({ w: 0, h: 0 });
  });
});

describe('the footer URL making room for the mark', () => {
  // A stub context: the only thing footerMaxW asks of one is how wide the wordmark measures, and
  // the geometry it does with that answer is the part worth pinning.
  const ctx = (perChar = 14) => ({
    save() {}, restore() {}, font: '',
    measureText: (t: string) => ({ width: t.length * perChar }),
  }) as unknown as CanvasRenderingContext2D;

  it('gives the URL the whole width when the mark is switched off', () => {
    expect(footerMaxW(ctx(), DEFAULT_POSTER_LAYOUT, false)).toBe(FOOTER_MAX_W);
  });

  it('gives the URL the whole width when the mark is nowhere near the footer', () => {
    // Every design saved before the mark moved has it up at y=0.07 — a page away — and must keep
    // printing its footer exactly as it always has.
    const l = cloneL(DEFAULT_POSTER_LAYOUT);
    l.brand = { x: 0.5, y: 0.07, size: 34 };
    expect(footerMaxW(ctx(), l, true)).toBe(FOOTER_MAX_W);
  });

  it('narrows the URL when the two share the footer line', () => {
    const w = footerMaxW(ctx(), DEFAULT_POSTER_LAYOUT, true);
    expect(w).toBeLessThan(FOOTER_MAX_W);
    expect(w).toBeGreaterThan(260);
    // It is the space that is actually left: the URL is centred on the footer's x, so it may reach
    // as far as the mark's near edge in each direction and no further.
    const b = DEFAULT_POSTER_LAYOUT.brand, f = DEFAULT_POSTER_LAYOUT.footer;
    const bw = '\u{1F3A9} Snapdini'.length * 14;
    const expected = ((f.x * PAGE_W) - (b.x * PAGE_W + bw / 2 + 20)) * 2;
    expect(w).toBeCloseTo(expected, 5);
  });

  it('never squeezes the URL below a readable floor', () => {
    // A very wide mark would otherwise leave a smudge rather than an address. Better that the two
    // sit tight than that the thing guests are meant to type becomes unreadable.
    expect(footerMaxW(ctx(60), DEFAULT_POSTER_LAYOUT, true)).toBe(260);
  });

  it('gives the width back when the host drags the mark off the line', () => {
    const l = cloneL(DEFAULT_POSTER_LAYOUT);
    l.brand = { ...l.brand, y: 0.80 };
    expect(footerMaxW(ctx(), l, true)).toBe(FOOTER_MAX_W);
  });
});

// ── Do the drag outlines actually contain the text? ──────────────────────────
// The bug these pin was reported as "when I click on some of the text, the outline doesn't fit all
// the text in it". The designer measured the message and the how-to line ITSELF — in Helvetica, at
// the box's own size, with no tracking and no casing — while the renderer sets them in the host's
// chosen BODY face, which on the bundled sets is Jost tracked at 0.14em in caps, or Cormorant at
// 1.06 scale. Metrically nothing like Helvetica, so the outline clipped the glyphs on every set
// except `plain`, which is exactly why only SOME text looked wrong.
//
// The oracle here is the RENDERER ITSELF: drawPoster is run against a context that logs every
// fillText and measures it at the font and tracking that were live when it was drawn, and the
// measurement has to agree with that log. Nothing below re-derives the geometry, because a test
// that re-derived it would pass against the bug it is here to catch.
describe('the drag outlines the host taps on', () => {
  // A context with MODELLED metrics: it reads the font shorthand it is handed, charges a different
  // advance per family, and honours letterSpacing. The absolute numbers are invented; what is real
  // is that measuring and drawing ask the SAME context the same questions. (The figures from real
  // Chromium with the real woff2 files are in the assertions below as comments.)
  const ADVANCE: [string, number][] = [
    ['Helvetica Neue', 0.50], ['Playfair Display', 0.62], ['Cormorant Garamond', 0.44],
    ['Great Vibes', 0.40], ['Sacramento', 0.38], ['Jost', 0.56], ['ui-monospace', 0.62],
  ];
  type Drawn = { text: string; x: number; y: number; w: number };
  function modelCtx() {
    const st = { font: '400 10px Arial', letterSpacing: '0px' };
    const drawn: Drawn[] = [];
    const width = (t: string) => {
      const m = /(\d+(?:\.\d+)?)px\s+(.*)$/.exec(st.font);
      const size = m ? parseFloat(m[1]) : 10;
      const fam = m ? m[2] : '';
      const per = (ADVANCE.find(([k]) => fam.includes(k)) ?? ['', 0.5])[1] as number;
      const ls = st.letterSpacing;
      const track = parseFloat(ls) || 0;
      const extra = ls.endsWith('em') ? track * size : track;
      return t.length * (size * per + extra);
    };
    const noop = () => {};
    const ctx = {
      get font() { return st.font; }, set font(v: string) { st.font = v; },
      get letterSpacing() { return st.letterSpacing; }, set letterSpacing(v: string) { st.letterSpacing = v; },
      fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', textAlign: '', textBaseline: '',
      imageSmoothingEnabled: false,
      measureText: (t: string) => ({ width: width(t) }),
      fillText: (t: string, x: number, y: number) => { drawn.push({ text: t, x, y, w: width(t) }); },
      fillRect: noop, drawImage: noop, save: noop, restore: noop, beginPath: noop, closePath: noop,
      moveTo: noop, lineTo: noop, arcTo: noop, fill: noop, stroke: noop, translate: noop,
      rotate: noop, scale: noop, clip: noop, setLineDash: noop, arc: noop, quadraticCurveTo: noop,
      bezierCurveTo: noop, ellipse: noop, rect: noop, createLinearGradient: () => ({ addColorStop: noop }),
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn, measure: width };
  }

  const MSG = 'Scan the code to open the camera. Take as many photos as you like and they all land in one shared album.';
  const STEPS = '1. Scan  2. Snap  3. See them all after the party';
  const SHORT = 'Scan to join the album';
  const ink: PosterInk = { headline: '#111', message: '#222', steps: '#333', footer: '#444', code: '#000' };
  // A 1×1 stand-in: drawPoster only ever hands it to drawImage, and this is a text measurement.
  const loadImage = async () => ({} as HTMLImageElement);

  /** Run the real draw path, and hand back what it put on the page. */
  async function render(over: Partial<Parameters<typeof drawPoster>[1]>) {
    const m = modelCtx();
    await drawPoster(m.ctx, {
      // A headline made of letters the body text does not contain, so the two never get confused.
      headline: 'ZZZZ', headlineTop: '', headlineBottom: '', names: '',
      message: MSG, stepsText: STEPS,
      cleanUrl: 'snapdini.com/j/ABCD1234', joinCode: 'ABCD1234',
      showBrand: false, qrPanel: true, codeDisplay: 'none', showFooterUrl: false,
      layout: clonePosterLayout(DEFAULT_POSTER_LAYOUT), ink,
      qrSrc: 'x', bgSrc: null, plainBg: '#ffffff', loadImage,
      decorKind: '', textItems: [],
      ...over,
    });
    return m;
  }

  /** The lines the draw path actually laid down for one block, in order. */
  const linesOf = (drawn: Drawn[], set: TypeSetKey, source: string) => {
    const cast = castFor(typeSet(set).body, source).replace(/\s+/g, ' ');
    return drawn.filter((d) => d.text && cast.includes(d.text));
  };

  /** The old, buggy measurement, copied verbatim from PosterModal.textBounds() so the negative
   *  control is the real thing rather than a paraphrase of it. */
  function oldTextBounds(ctx: CanvasRenderingContext2D, text: string, weight: number, box: Box, maxW: number) {
    ctx.font = `${weight} ${box.size}px "Helvetica Neue", Arial, sans-serif`;
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
    const lines = wrapToLines(ctx, text, maxW);
    const lh = box.size * 1.18;
    let w = 0; for (const ln of lines) w = Math.max(w, ctx.measureText(ln).width);
    return { w, h: Math.max(lines.length, 1) * lh, lines: lines.length };
  }

  const SETS: TypeSetKey[] = ['plain', 'editorial', 'formal', 'garden', 'modern'];

  for (const set of SETS) {
    for (const [which, source] of [['message', MSG], ['steps', STEPS], ['message', SHORT]] as const) {
      it(`fits the ${which} in ${set}${source === SHORT ? ' (one short line)' : ''}`, async () => {
        const over = which === 'message' ? { typeSet: set, message: source } : { typeSet: set };
        const m = await render(over);
        const box = DEFAULT_POSTER_LAYOUT[which];
        const drawn = linesOf(m.drawn, set, source);
        expect(drawn.length).toBeGreaterThan(0);

        const got = measureBodyBlock(m.ctx, { typeSet: set }, which, source, box);

        // WIDTH: the outline is exactly as wide as the widest line the renderer drew. Not "close
        // enough" — the two now come from one measurement, so anything but equality is a second
        // guess creeping back in.
        const widest = drawn.reduce((a, d) => Math.max(a, d.w), 0);
        expect(got.w).toBeCloseTo(widest, 6);

        // ...and every line really is inside it. Centred text, so each line spreads either side of
        // the box's centre — this is the containment the host sees or does not see.
        const cx = box.x * PAGE_W, left = cx - got.w / 2, right = cx + got.w / 2;
        for (const d of drawn) {
          expect(d.x - d.w / 2).toBeGreaterThanOrEqual(left - 0.001);
          expect(d.x + d.w / 2).toBeLessThanOrEqual(right + 0.001);
        }

        // HEIGHT: derived from the baselines the renderer actually used, not from a line-height
        // constant kept here. One row per line, on the row's own line height.
        if (drawn.length > 1) {
          const lh = drawn[1].y - drawn[0].y;
          expect(got.h).toBeCloseTo(drawn.length * lh, 6);
          const top = box.y * PAGE_H - got.h / 2, bottom = top + got.h;
          expect(drawn[0].y - lh / 2).toBeGreaterThanOrEqual(top - 0.001);
          expect(drawn[drawn.length - 1].y + lh / 2).toBeLessThanOrEqual(bottom + 0.001);
        }
      });
    }
  }

  it('is the bug: the old Helvetica measurement clipped every set but plain', async () => {
    // The negative control. `plain` IS Helvetica, which is why the report was "some of the text" —
    // a host on the default pairing sees nothing wrong, and every other pairing is broken.
    const gaps: Record<string, { w: number; h: number }> = {};
    for (const set of SETS) {
      const m = await render({ typeSet: set });
      const box = DEFAULT_POSTER_LAYOUT.steps;
      const drawn = linesOf(m.drawn, set, STEPS);
      const widest = drawn.reduce((a, d) => Math.max(a, d.w), 0);
      const old = oldTextBounds(m.ctx, STEPS, 500, box, 1080 - 120);
      const got = measureBodyBlock(m.ctx, { typeSet: set }, 'steps', STEPS, box);
      gaps[set] = { w: widest - old.w, h: got.h - old.h };
      // The fix, on every set including plain.
      expect(got.w).toBeCloseTo(widest, 6);
    }
    expect(Math.abs(gaps.plain.w)).toBeLessThan(0.001);          // Helvetica measured as Helvetica
    // Every other set was measured as the wrong typeface. In real Chromium with the real woff2
    // files this is +220.9px on Editorial and +176.9px on Formal — the how-to line's outline was
    // 26% narrower than its own text.
    for (const set of ['editorial', 'formal', 'garden', 'modern']) {
      expect(Math.abs(gaps[set].w)).toBeGreaterThan(1);
    }
    // And the line height was wrong on all four too — 1.18 here against the face's own 1.30–1.45.
    for (const set of ['editorial', 'formal', 'garden', 'modern']) {
      expect(Math.abs(gaps[set].h)).toBeGreaterThan(1);
    }
  });

  it('counts the lines the renderer will draw, not the lines Helvetica would have', async () => {
    // The clearest version of the bug: a tracked upper-case body face needs THREE rows for the
    // default message where Helvetica needed two, so a third of the paragraph hung below its own
    // outline. Real Chromium: 3 rows at 42.05 = 126.1px drawn, against 75.5px measured.
    const m = await render({ typeSet: 'editorial' });
    const drawn = linesOf(m.drawn, 'editorial', MSG);
    const old = oldTextBounds(m.ctx, MSG, 400, DEFAULT_POSTER_LAYOUT.message, 1080 - 200);
    expect(drawn.length).toBeGreaterThan(old.lines);
    const got = measureBodyBlock(m.ctx, { typeSet: 'editorial' }, 'message', MSG, DEFAULT_POSTER_LAYOUT.message);
    expect(got.h).toBeGreaterThan(old.h);
  });

  it('wraps the outline to the same width the ink wraps to', async () => {
    // The message and the how-to line get different paper. Both numbers used to be written twice —
    // once in drawPoster and once in the designer — which is a line break waiting to disagree.
    expect(BODY_MAX_W.message).toBe(PAGE_W - 200);
    expect(BODY_MAX_W.steps).toBe(PAGE_W - 120);
    const m = await render({ typeSet: 'modern' });
    // Nothing the renderer drew is wider than the width it was told to wrap to.
    for (const d of linesOf(m.drawn, 'modern', MSG)) expect(d.w).toBeLessThanOrEqual(BODY_MAX_W.message + 0.001);
  });

  it('leaves no tracking behind on the context it measured with', async () => {
    // letterSpacing is sticky canvas state. A measure call that walked away with 0.14em still set
    // would silently space out the next thing measured OR drawn on that context — and the designer
    // measures seven elements in a row on one shared offscreen canvas.
    const m = modelCtx();
    const spaced = m.ctx as CanvasRenderingContext2D & { letterSpacing: string };
    measureBodyBlock(m.ctx, { typeSet: 'editorial' }, 'steps', STEPS, DEFAULT_POSTER_LAYOUT.steps);
    expect(spaced.letterSpacing).toBe('0px');
    measureTextItem(m.ctx, { typeSet: 'formal' }, { text: 'Table 4', x: 0.2, y: 0.5, size: 28 });
    expect(spaced.letterSpacing).toBe('0px');
  });
});

// The footer URL shrinks to fit, and splits a long one onto a second line at 0.82 of the size. The
// designer re-derived all of that and got two of the three details wrong.
describe('the footer URL outline', () => {
  const ink: PosterInk = { headline: '#111', message: '#222', steps: '#333', footer: '#444', code: '#000' };
  const loadImage = async () => ({} as HTMLImageElement);
  const MONO = 0.62;
  type Drawn = { text: string; x: number; y: number; w: number };
  function monoCtx() {
    const st = { font: '400 10px Arial', letterSpacing: '0px' };
    const drawn: Drawn[] = [];
    const width = (t: string) => {
      const m = /(\d+(?:\.\d+)?)px/.exec(st.font);
      return t.length * (m ? parseFloat(m[1]) : 10) * MONO;
    };
    const noop = () => {};
    const ctx = {
      get font() { return st.font; }, set font(v: string) { st.font = v; },
      get letterSpacing() { return st.letterSpacing; }, set letterSpacing(v: string) { st.letterSpacing = v; },
      fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', textAlign: '', textBaseline: '',
      imageSmoothingEnabled: false,
      measureText: (t: string) => ({ width: width(t) }),
      fillText: (t: string, x: number, y: number) => { drawn.push({ text: t, x, y, w: width(t) }); },
      fillRect: noop, drawImage: noop, save: noop, restore: noop, beginPath: noop, closePath: noop,
      moveTo: noop, lineTo: noop, arcTo: noop, fill: noop, stroke: noop,
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn };
  }

  // Long enough that the DOMAIN itself will not fit, so the shrink loop has to run.
  const LONG = 'sub.a-really-long-custom-domain-for-this-wedding.example.com/join/ABCD1234';

  async function renderFooter(url: string) {
    const m = monoCtx();
    await drawPoster(m.ctx, {
      headline: 'ZZZZ', names: '', message: '', stepsText: '',
      cleanUrl: url, joinCode: 'ABCD1234',
      showBrand: false, qrPanel: true, codeDisplay: 'none', showFooterUrl: true,
      layout: clonePosterLayout(DEFAULT_POSTER_LAYOUT), ink,
      qrSrc: 'x', bgSrc: null, plainBg: '#ffffff', loadImage, decorKind: '', textItems: [],
    });
    return m;
  }

  it('measures the URL at the size the shrink loop actually settled on', async () => {
    const m = await renderFooter(LONG);
    const layout = clonePosterLayout(DEFAULT_POSTER_LAYOUT);
    const drawn = m.drawn.filter((d) => LONG.includes(d.text));
    expect(drawn.length).toBe(2);                              // domain over path
    const widest = drawn.reduce((a, d) => Math.max(a, d.w), 0);
    const got = measureFooterUrl(m.ctx, LONG, layout, false);
    expect(got.w).toBeCloseTo(widest, 6);
    // The old measurement clamped to the wrap width instead, so the outline was wider than the
    // shrunken text inside it.
    expect(got.w).toBeLessThan(FOOTER_MAX_W);
  });

  it('is tall enough for the second line it just drew', async () => {
    const m = await renderFooter(LONG);
    const layout = clonePosterLayout(DEFAULT_POSTER_LAYOUT);
    const size = layout.footer.size;
    const drawn = m.drawn.filter((d) => LONG.includes(d.text));
    const got = measureFooterUrl(m.ctx, LONG, layout, false);
    // The rect is anchored half a size above the FIRST baseline (the URL is drawn on a middle
    // baseline), so its foot has to clear the second line's own half-height.
    const top = layout.footer.y * PAGE_H - size / 2;
    const secondHalf = Math.round(size * 0.82) / 2;
    expect(top + got.h).toBeGreaterThanOrEqual(drawn[1].y + secondHalf - 0.001);
    // The old height — size*1.25 + size*0.82 — stopped short of exactly that.
    expect(got.h).toBeGreaterThan(size * 1.25 + size * 0.82);
  });

  it('still reports a short URL as the one line it is', async () => {
    const short = 'snapdini.com/j/ABCD1234';
    const m = await renderFooter(short);
    const drawn = m.drawn.filter((d) => short.includes(d.text));
    expect(drawn.length).toBe(1);
    const got = measureFooterUrl(m.ctx, short, clonePosterLayout(DEFAULT_POSTER_LAYOUT), false);
    expect(got.w).toBeCloseTo(drawn[0].w, 6);
    expect(got.h).toBe(DEFAULT_POSTER_LAYOUT.footer.size);
  });
});

// ── Turning an element, and the code staying readable underneath one ──────────
//
// Two separate jobs that share one instrument: a context that keeps a real transform matrix, so a
// rotated draw can be checked by where the GLYPHS land rather than by which calls were made. A test
// that only asserted "rotate() was called" would pass a renderer that turned the canvas and forgot
// to turn it back.
describe('rotation, and what a placed motif may cover', () => {
  type Op = { op: string; args: number[]; fill?: string };
  type Mark = { text: string; x: number; y: number; i: number; mat: Mat };
  type Mat = [number, number, number, number, number, number];
  const mul = (m: Mat, n: Mat): Mat => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const apply = (m: Mat, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

  function matrixCtx() {
    let m: Mat = [1, 0, 0, 1, 0, 0];
    const stack: Mat[] = [];
    const ops: Op[] = [];
    const marks: Mark[] = [];
    // The QR PNG, the motifs and the text all land here; `i` is the draw ORDER, which is the whole
    // question for the motif-over-the-panel half.
    const images: { x: number; y: number; w: number; h: number; i: number }[] = [];
    const strokes: { x: number; y: number; i: number }[] = [];
    let path: { x: number; y: number; w: number; h: number }[] = [];
    const clips: { rects: typeof path; rule: string; i: number }[] = [];
    let n = 0;
    const st = { font: '400 10px Arial', letterSpacing: '0px' };
    const width = (t: string) => t.length * 8;
    const noop = () => {};
    const ctx = {
      get font() { return st.font; }, set font(v: string) { st.font = v; },
      get letterSpacing() { return st.letterSpacing; }, set letterSpacing(v: string) { st.letterSpacing = v; },
      fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '', textAlign: '', textBaseline: '',
      imageSmoothingEnabled: false,
      measureText: (t: string) => ({ width: width(t) }),
      fillText: (t: string, x: number, y: number) => { marks.push({ text: t, ...apply(m, x, y), i: n++, mat: [...m] as Mat }); },
      drawImage: (_i: unknown, x: number, y: number, w: number, h: number) => {
        images.push({ ...apply(m, x, y), w, h, i: n++ });
      },
      save: () => { stack.push([...m] as Mat); },
      restore: () => { m = stack.pop() ?? m; },
      translate: (x: number, y: number) => { m = mul(m, [1, 0, 0, 1, x, y]); ops.push({ op: 'translate', args: [x, y] }); },
      rotate: (a: number) => { m = mul(m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); ops.push({ op: 'rotate', args: [a] }); },
      scale: (x: number, y: number) => { m = mul(m, [x, 0, 0, y, 0, 0]); },
      beginPath: () => { path = []; },
      rect: (x: number, y: number, w: number, h: number) => { path.push({ x, y, w, h }); },
      clip: (rule: string) => { clips.push({ rects: path, rule, i: n }); },
      // A motif is strokes. Recording where they land is what proves one is not inside the code.
      //
      // moveTo is deliberately NOT recorded: roundRect() starts every panel and every brand chip
      // with one, so counting them made the QR panel itself look like motif ink drawn after the
      // panel — and the "motif on top" assertion passed under the old draw order it was written to
      // catch. A motif is the segments, not the pen-ups.
      moveTo: noop,
      lineTo: (x: number, y: number) => { strokes.push({ ...apply(m, x, y), i: n }); },
      quadraticCurveTo: (x1: number, y1: number, x: number, y: number) => {
        strokes.push({ ...apply(m, x1, y1), i: n }); strokes.push({ ...apply(m, x, y), i: n });
      },
      bezierCurveTo: (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
        strokes.push({ ...apply(m, x1, y1), i: n }); strokes.push({ ...apply(m, x2, y2), i: n }); strokes.push({ ...apply(m, x, y), i: n });
      },
      arc: (x: number, y: number) => { strokes.push({ ...apply(m, x, y), i: n }); },
      ellipse: (x: number, y: number) => { strokes.push({ ...apply(m, x, y), i: n }); },
      stroke: () => { n++; },
      fillRect: noop, closePath: noop, arcTo: noop, fill: noop, setLineDash: noop,
      createLinearGradient: () => ({ addColorStop: noop }),
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, marks, images, strokes, clips, ops };
  }

  const ink: PosterInk = { headline: '#111', message: '#222', steps: '#333', footer: '#444', code: '#000' };
  const loadImage = async () => ({} as HTMLImageElement);
  async function render(over: Partial<Parameters<typeof drawPoster>[1]>) {
    const m = matrixCtx();
    await drawPoster(m.ctx, {
      headline: 'ZZZZ', names: '', message: 'Scan to join', stepsText: 'Scan · Snap · See',
      cleanUrl: 'snapdini.com/j/ABCD1234', joinCode: 'ABCD1234',
      showBrand: false, qrPanel: true, codeDisplay: 'code', showFooterUrl: true,
      layout: clonePosterLayout(DEFAULT_POSTER_LAYOUT), ink,
      qrSrc: 'x', bgSrc: null, plainBg: '#ffffff', loadImage, decorKind: '', textItems: [],
      ...over,
    });
    return m;
  }
  const at = (marks: Mark[], text: string) => marks.find((d) => d.text === text);

  it('leaves an upright poster drawing exactly what it always drew', async () => {
    // The compatibility guarantee, and it is the FIRST assertion on purpose: `rot` is optional and
    // absent everywhere until a host turns something, so every design ever saved has to come out of
    // the new code identical to the old. Same marks, same coordinates, same order.
    const plain = await render({});
    const alsoPlain = await render({ layout: clonePosterLayout(DEFAULT_POSTER_LAYOUT) });
    expect(alsoPlain.marks).toEqual(plain.marks);
    // ...and nothing turned the canvas at all. A poster with no rotation must not even enter the
    // rotate path, which is what makes "identical" something the code guarantees rather than
    // something the arithmetic happens to round to.
    expect(plain.ops.filter((o) => o.op === 'rotate')).toHaveLength(0);
  });

  it('turns the headline about its own anchor', async () => {
    // A small caps line ABOVE and nothing below, so the headline row sits OFF the anchor and a
    // missing rotation shows up as a point that did not move. Neither a one-row headline nor a
    // symmetrical three-row one would do: both draw the main row exactly on the anchor, and a point
    // on the centre of rotation stays put whether or not anything turned — which is precisely the
    // test that would pass a renderer that had forgotten to rotate at all.
    const parts = { headlineTop: 'CAPTURE THE' };
    const l = clonePosterLayout(DEFAULT_POSTER_LAYOUT);
    const up = await render({ ...parts, layout: clonePosterLayout(l) });
    l.title = { ...l.title, rot: Math.PI / 2 };
    const over = await render({ ...parts, layout: l });
    const a = at(up.marks, 'ZZZZ')!, b = at(over.marks, 'ZZZZ')!;
    expect(a).toBeTruthy(); expect(b).toBeTruthy();
    const ax = DEFAULT_POSTER_LAYOUT.title.x * PAGE_W, ay = DEFAULT_POSTER_LAYOUT.title.y * PAGE_H;
    // The row really is off the anchor, or the rest of this proves nothing.
    expect(Math.abs(a.y - ay)).toBeGreaterThan(1);
    // A quarter turn about (title.x, title.y): the offset from the anchor rotates, the anchor does
    // not move. Checked as geometry rather than as "rotate() was called", so a renderer that turned
    // the canvas and forgot to put it back would fail here rather than pass.
    expect(b.x).toBeCloseTo(ax - (a.y - ay), 6);
    expect(b.y).toBeCloseTo(ay + (a.x - ax), 6);
    // ...and the transform really was in force for the glyphs, not merely for their origin.
    expect(b.mat[1]).toBeCloseTo(1, 6);
  });

  it('turns each element on its own, and leaves the transform clean behind it', async () => {
    // Every element is drawn into the SAME context one after another. A rotation that leaked would
    // turn everything below it on the page — so the proof is that every OTHER element was drawn on
    // an identity transform, and the turned one was not.
    //
    // The matrix rather than the drawn POINT, deliberately: a single centred line is drawn at its
    // own anchor, and turning about the anchor leaves that point exactly where it was. The glyphs
    // still come out at 23°, and the transform in force is the only thing that says so.
    const l = clonePosterLayout(DEFAULT_POSTER_LAYOUT);
    l.message = { ...l.message, rot: 0.4 };
    const one = await render({ layout: l });
    const msg = at(one.marks, 'Scan to join')!;
    expect(msg.mat[0]).toBeCloseTo(Math.cos(0.4), 6);
    expect(msg.mat[1]).toBeCloseTo(Math.sin(0.4), 6);
    for (const t of ['ZZZZ', 'ABCD1234', 'Join code', 'Scan · Snap · See']) {
      expect(at(one.marks, t)!.mat, t).toEqual([1, 0, 0, 1, 0, 0]);
    }
  });

  it('turns the host’s own lines too, each by its own angle', async () => {
    // Per LINE, like their colours: a list of additions where one turn applied to all of them would
    // be one choice wearing the costume of several.
    const m = await render({ textItems: [
      { text: 'Table four', x: 0.3, y: 0.5, size: 30, rot: Math.PI / 4 },
      { text: 'Bar closes at 11', x: 0.7, y: 0.5, size: 30 },
    ] });
    expect(at(m.marks, 'Table four')!.mat[1]).toBeCloseTo(Math.sin(Math.PI / 4), 6);
    expect(at(m.marks, 'Bar closes at 11')!.mat).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('never turns the QR, whatever is stored against it', async () => {
    // canRotate() refuses it at the control, and the renderer refuses it here too: a stored blob is
    // not to be trusted, and a code drawn on a diagonal takes the join code printed under it with
    // it — and puts the motif keep-out rect on a diagonal as well.
    const l = clonePosterLayout(DEFAULT_POSTER_LAYOUT);
    const up = await render({ layout: clonePosterLayout(l), showBrand: true });
    (l.qr as Box & { rot?: number }).rot = 1.2;
    (l.brand as Box & { rot?: number }).rot = 1.2;
    const m = await render({ layout: l, showBrand: true });
    expect(m.images).toEqual(up.images);
    expect(at(m.marks, 'ABCD1234')).toEqual(at(up.marks, 'ABCD1234'));
    // ...and the mark with it: it is our imprint on someone else's sign, and it has no resize grip
    // either. See ROTATABLE_ELEMENTS for the reasoning on both.
    expect(at(m.marks, '🎩 Snapdini')!.mat).toEqual([1, 0, 0, 1, 0, 0]);
  });

  // ── A host's own mark ──────────────────────────────────────────────────────────────────────
  //
  // A logo is a placement like any motif — same x/y/scale/rot, same drag surface, same bin — and is
  // the one kind this renderer draws from a FILE rather than from geometry. It is also the only
  // placement deliberately outside the QR keep-out: that clip exists to stop a decoration WE chose
  // from wandering over the code, and a logo is put exactly where the host put it.
  it('draws a placed logo from its own file, sized off the short edge', async () => {
    const m = await render({ decorItems: [{ kind: 'logo', url: '/uploads/e/logo.png', ar: 2, x: 0.5, y: 0.3, scale: 1, rot: 0 }] });
    // 0.22 of the short edge wide, and half that tall at 2:1 — the same rule the designer's hit box
    // uses, which is what keeps the handle on the picture instead of beside it.
    const want = Math.min(PAGE_W, PAGE_H) * 0.22;
    const logo = m.images.find((im) => Math.abs(im.w - want) < 0.5);
    expect(logo, 'the logo should be drawn').toBeTruthy();
    expect(logo!.h).toBeCloseTo(want / 2, 1);
  });

  it('puts the logo above everything, and outside the QR clip', async () => {
    const m = await render({ decorItems: [
      { kind: 'logo', url: '/uploads/e/logo.png', ar: 1, x: 0.5, y: 0.3, scale: 1, rot: 0 },
      { kind: 'botanical', x: 0.5, y: 0.585, scale: 1.6, rot: 0 },
    ] });
    const want = Math.min(PAGE_W, PAGE_H) * 0.22;
    const logo = m.images.find((im) => Math.abs(im.w - want) < 0.5)!;
    expect(logo).toBeTruthy();
    // After every stroke the motifs made, so a host's mark is never buried under decoration.
    expect(logo.i).toBeGreaterThan(Math.max(...m.strokes.map((st) => st.i)));
    // The keep-out clip is still exactly the one the motifs draw inside — the logo did not add
    // another and is not subject to it.
    expect(m.clips).toHaveLength(1);
  });

  it('skips a logo with no file rather than drawing a blank box', async () => {
    const before = (await render({ decorItems: [] })).images.length;
    const m = await render({ decorItems: [{ kind: 'logo', x: 0.5, y: 0.3, scale: 1, rot: 0 } as never] });
    expect(m.images.length, 'nothing extra drawn').toBe(before);
  });

  it('puts a placed motif ON TOP of the QR panel instead of under it', async () => {
    // The bug: drawDecorAt ran ~60 lines before drawQrPanel, so the white panel painted over any
    // motif the host dragged near the code and it simply vanished. The control worked; the paper
    // did not.
    const m = await render({ decorItems: [{ kind: 'botanical', x: 0.5, y: 0.585, scale: 1.6, rot: 0 }] });
    const panel = m.images.find((im) => im.w === DEFAULT_POSTER_LAYOUT.qr.size)!;
    expect(panel).toBeTruthy();
    const motif = m.strokes.filter((s) => s.i > 0);
    expect(motif.length).toBeGreaterThan(0);
    expect(Math.max(...motif.map((s) => s.i))).toBeGreaterThan(panel.i);
  });

  it('...and still under the join code, which is words a guest has to read', async () => {
    const m = await render({ decorItems: [{ kind: 'botanical', x: 0.5, y: 0.585, scale: 1.6, rot: 0 }] });
    const code = at(m.marks, 'ABCD1234')!;
    expect(code).toBeTruthy();
    expect(Math.max(...m.strokes.map((s) => s.i))).toBeLessThan(code.i);
  });

  it('clips the motifs out of the QR IMAGE’s square, not out of the whole panel', async () => {
    const box = DEFAULT_POSTER_LAYOUT.qr;
    const m = await render({ decorItems: [{ kind: 'botanical', x: 0.5, y: 0.585, scale: 1.6, rot: 0 }] });
    expect(m.clips).toHaveLength(1);
    const c = m.clips[0];
    expect(c.rule).toBe('evenodd');
    expect(c.rects).toHaveLength(2);
    expect(c.rects[0]).toEqual({ x: 0, y: 0, w: PAGE_W, h: PAGE_H });
    // The code's own square — box.size across — and NOT qrPanelRect, which is 90px wider and up to
    // 195px taller. The four-module quiet zone is baked into the PNG by the server, so the panel's
    // padding is additional margin rather than anything the symbology requires.
    expect(c.rects[1]).toEqual(qrKeepOut(box, 'code'));
    // Whole pixels, rounded OUTWARD from the image rect — a clip edge on a fractional coordinate is
    // antialiased, and measured in Chromium that let nine pixels of motif onto the bottom row of
    // the code. At most one pixel of margin either side is given away for it.
    for (const v of Object.values(c.rects[1])) expect(Number.isInteger(v)).toBe(true);
    expect(c.rects[1].w).toBeGreaterThanOrEqual(box.size);
    expect(c.rects[1].w).toBeLessThanOrEqual(box.size + 2);
    // ...and it is still the CODE, not the panel: 90px narrower and up to 195px shorter.
    expect(c.rects[1].w).toBeLessThan(qrPanelRect(box, 'code').w);
    expect(c.rects[1].h).toBeLessThan(qrPanelRect(box, 'code').h);
  });

  it('draws no clip at all when the host has placed nothing', async () => {
    // A poster with no placed motifs must not pick up a clip it does not need — that is the same
    // "identical output" promise as the first test, at the instruction level.
    expect((await render({})).clips).toHaveLength(0);
  });

  it('draws no clip when every motif is nowhere near the code', async () => {
    // A clip is not free even where it excludes nothing: it puts the strokes through a different
    // rasterisation, and measured in Chromium that moved 872 antialiased pixels of a motif at the
    // top of the page by up to 6/255. Invisible, and still a change to a design nobody edited — so
    // a poster whose motifs cannot reach the code is left on exactly the instructions it had.
    const m = await render({ decorItems: [
      { kind: 'stars', x: 0.18, y: 0.12, scale: 1.3, rot: 0.4 },
      { kind: 'rings', x: 0.82, y: 0.12, scale: 1.1, rot: -0.2 },
    ] });
    expect(m.clips).toHaveLength(0);
    // ...and they still drew, above the panel. "No clip" must not have become "no motif".
    expect(m.strokes.length).toBeGreaterThan(0);
    const panel = m.images.find((im) => im.w === DEFAULT_POSTER_LAYOUT.qr.size)!;
    expect(Math.max(...m.strokes.map((s) => s.i))).toBeGreaterThan(panel.i);
  });

  it('clips as soon as ONE motif could reach it, however many cannot', async () => {
    const q = qrImageRect(DEFAULT_POSTER_LAYOUT.qr, 'code');
    const m = await render({ decorItems: [
      { kind: 'stars', x: 0.18, y: 0.12, scale: 1.3, rot: 0 },
      { kind: 'botanical', x: q.x / PAGE_W, y: q.y / PAGE_H, scale: 2.2, rot: 0 },
    ] });
    expect(m.clips).toHaveLength(1);
  });

  it('keeps the keep-out square on the code even with the panel switched off', async () => {
    // With the panel off the light modules are knocked out to transparent and the PAPER becomes the
    // quiet zone, so a motif across that square is printing on the code itself.
    const m = await render({ qrPanel: false, decorItems: [{ kind: 'botanical', x: 0.5, y: 0.585, scale: 1.6, rot: 0 }] });
    expect(m.clips).toHaveLength(1);
    expect(m.clips[0].rects[1]).toEqual(qrKeepOut(DEFAULT_POSTER_LAYOUT.qr, 'code'));
  });
});

describe('the rect an element occupies once it is turned', () => {
  const r = { x: 100, y: 200, w: 60, h: 20 };

  it('hands back the very same rect when there is no rotation', () => {
    // Identity, not "an equivalent rect": absent rotation must not perturb a measurement by a
    // floating-point hair, because the outline is compared against the ink at six decimal places.
    expect(rotatedRect(r, undefined, 130, 210)).toBe(r);
    expect(rotatedRect(r, 0, 130, 210)).toBe(r);
  });

  it('swaps the extents on a quarter turn about the centre', () => {
    const got = rotatedRect(r, Math.PI / 2, 130, 210);
    expect(got.w).toBeCloseTo(20, 6);
    expect(got.h).toBeCloseTo(60, 6);
    expect(got.x + got.w / 2).toBeCloseTo(130, 6);
    expect(got.y + got.h / 2).toBeCloseTo(210, 6);
  });

  it('is a HULL: it contains every corner of the turned rect', () => {
    // Not "grows" — a long flat rect at 45° is NARROWER than it was — but containing. That is the
    // property a hit box and a selection outline actually need.
    const rot = Math.PI / 4, c = Math.cos(rot), sn = Math.sin(rot);
    const got = rotatedRect(r, rot, 130, 210);
    for (const [px, py] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
      const dx = px - 130, dy = py - 210;
      const x = 130 + dx * c - dy * sn, y = 210 + dx * sn + dy * c;
      expect(x).toBeGreaterThanOrEqual(got.x - 1e-9);
      expect(x).toBeLessThanOrEqual(got.x + got.w + 1e-9);
      expect(y).toBeGreaterThanOrEqual(got.y - 1e-9);
      expect(y).toBeLessThanOrEqual(got.y + got.h + 1e-9);
    }
    // Both halves of the diagonal, and no more: the hull is tight, not padded.
    expect(got.w).toBeCloseTo((60 + 20) / Math.SQRT2, 6);
    expect(got.h).toBeCloseTo((60 + 20) / Math.SQRT2, 6);
  });

  it('turns about the ANCHOR it is given, not about the rect’s own middle', () => {
    // The footer's rect is NOT centred on its anchor — it hangs from half a type size above the
    // first baseline — so an implementation that assumed the centre would put its outline beside
    // the URL rather than on it.
    const got = rotatedRect(r, Math.PI, 100, 200);
    expect(got.x).toBeCloseTo(40, 6);
    expect(got.y).toBeCloseTo(180, 6);
  });
});
