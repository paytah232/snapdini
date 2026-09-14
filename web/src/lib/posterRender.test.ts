// The name lockup takes ONE typed line and decides whether it is two names or one. Getting that
// wrong is the kind of bug a host discovers on printed paper, so the split is pinned here.
import { describe, it, expect } from 'vitest';
import {
  splitNames, clonePosterLayout, qrPanelRect, symbolContrast, contrastGrade, panelOptional, reflectance,
  PANEL_OPTIONAL_MIN,
  DEFAULT_POSTER_LAYOUT, PAGE_H,
} from './posterRender';

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
