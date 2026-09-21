// The wizard row at the foot of the designer, pinned to the event wizard's.
//
// The host's report was "the back and next buttons in the poster wizard don't look like the event
// wizard". They did not: both were `class="seg"`, which is the segmented-control style the option
// rows in this panel use, so the way forward read as one choice among several and Back read as its
// equal. The event wizard had already settled this — Next is the primary action, Back is secondary,
// the refusal is `aria-disabled` rather than `disabled`, and the button says what is missing.
//
// This is a fact about the MARKUP and about rule ORDER in the stylesheet, so no test of a helper can
// see either come back. It reads the component's own source, the way the colour test does.
/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import SRC from './PosterModal.svelte?raw';

const SCRIPT = SRC.slice(0, SRC.indexOf('</script>'));
/** Just the template, with comments gone — a rule that only holds in a comment does not hold. */
const MARKUP = SRC
  .slice(SRC.indexOf('</script>'), SRC.lastIndexOf('<style>'))
  .replace(/<!--[\s\S]*?-->/g, '');
// Comments stripped here too: a rule named in a note is not a rule, and the note below about the
// selector that was REMOVED would otherwise read as the selector still being present.
const STYLE = SRC.slice(SRC.lastIndexOf('<style>')).replace(/\/\*[\s\S]*?\*\//g, '');

/** The two wizard rows: the poster's and the trick cards'. */
const ROWS = [...MARKUP.matchAll(/<div class="pnav">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
const poster = ROWS.find((r) => r.includes('pBack')) ?? '';
const cards = ROWS.find((r) => r.includes('cNav(-1)')) ?? '';

describe('the poster and cards wizard rows', () => {
  it('has exactly the two of them, and this test found both', () => {
    expect(ROWS).toHaveLength(2);
    expect(poster).not.toBe('');
    expect(cards).not.toBe('');
  });

  it('sets Next as the primary action and Back as secondary, on both tabs', () => {
    for (const [name, row] of [['poster', poster], ['cards', cards]] as const) {
      expect(row, `${name} Back`).toContain('class="btn ghost"');
      // Every forward button in the row, whatever it goes on to — Next, "Next: print", "Next: trick
      // cards". A row where one of them is styled differently is the inconsistency, one step later.
      const forward = [...row.matchAll(/<button class="([^"]*)"[^>]*>/g)].map((m) => m[1]);
      expect(forward.length, `${name} buttons`).toBeGreaterThanOrEqual(2);
      for (const cls of forward) {
        expect(cls === 'btn ghost' || cls === 'btn primary grow', `${name}: ${cls}`).toBe(true);
      }
    }
  });

  it('has no segmented-control button left in either row', () => {
    // `.seg` is what made Next look like an option rather than the way on.
    for (const row of ROWS) expect(row).not.toMatch(/class="seg/);
  });

  it('writes the two rows the same way, so the two surfaces match each other', () => {
    const classes = (row: string) =>
      [...new Set([...row.matchAll(/<button class="([^"]*)"/g)].map((m) => m[1]))].sort();
    expect(classes(poster)).toEqual(classes(cards));
  });
});

describe('the poster’s Next says what is blocking it', () => {
  it('refuses with aria-disabled, not disabled', () => {
    // A disabled button consumes no events: the tap falls through to the text underneath and the
    // phone browser throws its own Copy/Search menu over the app. The event wizard's note on this
    // is the reason it is written this way there too.
    expect(poster).toContain('aria-disabled={!pCanAdvance || undefined}');
    expect(poster).not.toMatch(/\sdisabled=/);
  });

  it('puts the missing thing in the LABEL, not only in a tooltip', () => {
    // The step strip already said it — in `title`, which does not exist on a phone, and the phone is
    // where this flow is used. The label is the version a host can actually read.
    expect(poster).toMatch(/pCanAdvance \? 'Next →' : '[^']*title[^']*'/);
  });

  it('lands the press on the field that is blocking it, through the machinery already there', () => {
    // Not a second mechanism: pNext delegates its refusal to goPStep, which is the same path the
    // step strip's refusal takes — step 1, focus the title, ring it.
    expect(SCRIPT).toContain("if (!pCanAdvance) { void goPStep(pStep + 1); return; }");
    expect(SCRIPT).toContain("getElementById('p-headline')");
    expect(SCRIPT).toContain('flashCard(el)');
  });
});

describe('the cards wizard has no invented gate', () => {
  it('states that there is nothing to require, rather than requiring something', () => {
    // The card title falls back to the poster's headline, then to the event name, then to a default
    // — the field's own placeholder IS the headline — and every other cards control has a default
    // that prints. So the strip's only gate is the high-water mark, which is what C_CAN_ADVANCE says.
    expect(SCRIPT).toContain('const C_CAN_ADVANCE = true;');
    expect(SCRIPT).toContain("cardHeading = cardTitle.trim() || headline.trim() || eventName || 'Our Event'");
    // ...and it really is wired into the jump guard, rather than the guard being absent.
    expect(SCRIPT).toContain('canAdvance: C_CAN_ADVANCE');
  });

  it('therefore carries no blocked label and no aria-disabled', () => {
    // A button that says "do X to continue" where there is no X is a dead end added for symmetry.
    expect(cards).not.toContain('aria-disabled');
    expect(cards).not.toContain('to continue');
  });
});

describe('the row’s own CSS', () => {
  it('gives Next twice the share — and in the order that makes that true', () => {
    // This was the live defect behind the "did the learnings get implemented" question: `.pnav .grow`
    // (flex 2) was written BEFORE `.pnav > .seg` (flex 1). Both are (0,2,0), so the later rule won
    // and Next got an equal share. The documented fix was in the file and dead.
    const basis = STYLE.indexOf('.pnav > .btn');
    const grow = STYLE.indexOf('.pnav > .grow');
    expect(basis).toBeGreaterThan(-1);
    expect(grow).toBeGreaterThan(basis);
    expect(STYLE).toContain('.pnav > .btn { flex: 1 1 0; min-width: 0; }');
    expect(STYLE).toContain('.pnav > .grow { flex: 2 1 0; }');
    // The selector the buttons no longer match must not be left behind as a dead rule.
    expect(STYLE).not.toContain('.pnav > .seg');
  });

  it('defines the whole .btn set locally, not just the colours', () => {
    // app.css explains why a global `.btn` cannot work here: Svelte emits a component's own `.btn`
    // at (0,4,0) by repeating the scoping class, so a global one loses in any component that
    // defines one. The failure mode is a button with the right colour and no padding, radius or
    // weight — right colour, wrong button. So this component carries the base shape as well.
    for (const rule of ['.btn {', '.btn.primary {', '.btn.ghost {', ".btn[aria-disabled='true'] {"]) {
      expect(STYLE, rule).toContain(rule);
    }
    const base = STYLE.slice(STYLE.indexOf('.btn {'), STYLE.indexOf('.btn.primary {'));
    for (const prop of ['font-weight', 'border-radius', 'padding', 'font-size', 'border', 'cursor']) {
      expect(base, prop).toContain(prop);
    }
  });

  it('puts near-black ink on the gold, never white', () => {
    // #ffffff on #f5c518 is about 1.6:1. --accent-fill is the token for a colour something sits ON,
    // and --accent-ink is what sits on it.
    expect(STYLE).toContain('.btn.primary { background: var(--accent-fill); color: var(--accent-ink, #111); }');
  });
});

describe('the modal header wraps instead of truncating its title', () => {
  const src = SRC;   // the ?raw import this file already uses

  it('gives the controls their own row below 560px', () => {
    const m = src.match(/@media \(max-width: 560px\) \{([\s\S]*?)\n  \}/);
    expect(m, 'no 560px header block').not.toBeNull();
    const block = m![1];
    expect(block).toMatch(/\.head\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(block).toMatch(/\.head-actions\s*\{[^}]*flex:\s*1 0 100%/);
  });

  // The ✕ must stay on the first row with the title. It only can if it is a child of .head rather
  // than of .head-actions, which is why the markup was changed as well as the CSS.
  it('keeps the close button out of .head-actions so it stays beside the title', () => {
    // Comments stripped, and every anchor checked before anything is ordered against it.
    //
    // Two faults, and the second is the nasty one. The region's right-hand bound was an HTML
    // COMMENT, so rewording an explanation silently moved the span this test reasons over. And
    // `actionsEnd` was computed as indexOf('</div>', actionsStart) with actionsStart unguarded:
    // remove `.head-actions` entirely and actionsStart is -1, indexOf then searches from 0, and
    // actionsEnd quietly becomes the first unrelated closing tag. The assertion goes on passing
    // while measuring a different element — which is worse than failing.
    const markup = src.replace(/<!--[\s\S]*?-->/g, ' ');
    const head = markup.slice(markup.indexOf('<div class="head">'));
    const actionsStart = head.indexOf('<div class="head-actions">');
    expect(actionsStart, '.head-actions must exist for this test to mean anything').toBeGreaterThan(-1);
    const actionsEnd = head.indexOf('</div>', actionsStart);
    expect(actionsEnd, '.head-actions must be closed').toBeGreaterThan(actionsStart);
    const closeAt = head.indexOf('class="x"');
    expect(closeAt, 'the close button must exist').toBeGreaterThan(-1);
    expect(closeAt, 'close button is inside .head-actions — it will land on row 2').toBeGreaterThan(actionsEnd);
  });

  // Ordering is what puts title+✕ on row 1 and the controls on row 2; without it the controls
  // would take the first row's slack and the title would wrap under them.
  it('orders title, close, then controls', () => {
    const block = src.match(/@media \(max-width: 560px\) \{([\s\S]*?)\n  \}/)![1];
    const o = (sel: string) => Number(block.match(new RegExp(`\\${sel}[^}]*order:\\s*(\\d)`))![1]);
    expect(o('.h-t')).toBeLessThan(o('.x'));
    expect(o('.x')).toBeLessThan(o('.head-actions'));
  });

  // Below 520px the word labels are still hidden, so row 2 is five icon buttons (~170px at 400px)
  // rather than five labelled ones (~400px). That rule is load-bearing for the narrowest phones.
  it('still drops the word labels on the narrowest screens', () => {
    expect(src).toMatch(/@media \(max-width: 520px\) \{ \.tog-w \{ display: none; \} \}/);
  });
});
