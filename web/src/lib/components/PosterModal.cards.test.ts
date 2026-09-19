// The trick-card sheet's controls.
//
// Two facts that live only in PosterModal.svelte and so can only be read out of it: the card
// orientation control writes the SHEET rather than being one, and it does so from a click handler
// rather than a reactive statement — which is the whole of "a saved design still prints identically".
/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import SRC from './PosterModal.svelte?raw';
import { cardGrid, cardLandscapeOn, sheetLandscapeFor, type CardsPerSheet } from '$lib/posterFlow';
import { readCardSets, DEFAULT_CARD_LAYOUT } from '$lib/cardRender';

const SCRIPT = SRC.slice(0, SRC.indexOf('</script>'));
const MARKUP = SRC
  .slice(SRC.indexOf('</script>'), SRC.lastIndexOf('<style>'))
  .replace(/<!--[\s\S]*?-->/g, '');
const count = (needle: string) => MARKUP.split(needle).length - 1;
/** One function's body, brace-matched, comments stripped. */
function code(src: string, decl: string): string {
  const i = src.indexOf(decl);
  expect(i, decl).toBeGreaterThan(-1);
  const open = src.indexOf('{', i);
  let d = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) {
      return src.slice(i, k + 1).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    }
  }
  throw new Error(`unbalanced: ${decl}`);
}

describe('the orientation control means the CARD', () => {
  it('is labelled for the card, not for the paper', () => {
    // It said "Paper" and set the paper, while reading as though it set the card — which it does at
    // 4-up and 1-up and inverts at 2-up.
    expect(MARKUP).toContain('<div class="sub-h">Card shape</div>');
    expect(MARKUP).not.toContain('<div class="sub-h">Paper</div>');
  });

  it('shows and writes the derived value, never the stored field', () => {
    expect(MARKUP).toContain('class:on={!cardLandscape}');
    expect(MARKUP).toContain('class:on={cardLandscape}');
    expect(MARKUP).toContain('on:click={() => setCardLandscape(false)}');
    expect(MARKUP).toContain('on:click={() => setCardLandscape(true)}');
    // The raw field must not be set from a button any more: that is the inverted control.
    expect(count('(cardSheetLandscape = false)')).toBe(0);
    expect(count('(cardSheetLandscape = true)')).toBe(0);
  });

  it('keeps the card shape when the host changes how many go on a sheet', () => {
    const fn = code(SCRIPT, 'function setCardsPerSheet(');
    expect(fn).toContain('const want = cardLandscape;');
    expect(fn).toContain('cardSheetLandscape = sheetLandscapeFor(n, want);');
    expect(MARKUP).toContain('on:click={() => setCardsPerSheet(4)}');
    expect(MARKUP).toContain('on:click={() => setCardsPerSheet(2)}');
    expect(MARKUP).toContain('on:click={() => setCardsPerSheet(1)}');
  });

  it('does it from a CLICK, never from a reactive statement', () => {
    // THE compatibility rule for this item. A `$:` keyed on cardsPerSheet fires once on mount, so
    // it would rewrite the stored sheet orientation of every saved design the moment it opened —
    // and a host may already have printed from one.
    expect(SCRIPT).not.toMatch(/\$:\s*cardSheetLandscape\s*=/);
    // Five assignments and no more: the declaration, restore(), applyCfg() (undo/redo), and the two
    // setters — both of which are click handlers. A sixth would be the thing to look at.
    expect(SCRIPT.match(/cardSheetLandscape = /g) ?? []).toHaveLength(5);
    expect(code(SCRIPT, 'const setCardLandscape = ')).toContain('cardSheetLandscape = sheetLandscapeFor(cardsPerSheet, want)');
    for (const fn of ['function restore(', 'function applyCfg(']) {
      expect(code(SCRIPT, fn), fn).toContain('cardSheetLandscape = ');
    }
  });

  it('still sends the SHEET to the printer', () => {
    // `@page { size: A4 … }` and the jsPDF orientation take the paper, which is what the paper is.
    expect(SCRIPT).toContain("$: sheetOrientation = (cardSheetLandscape ? 'landscape' : 'portrait')");
    expect(SCRIPT).toContain('@page{size:A4 ${sheetOrientation};margin:0}');
    expect(SCRIPT).toContain('new jsPDF({ orientation: sheetOrientation');
    // ...and the sheet's own pixels still follow it, through the renderer that lays the cards out.
    // What those pixels COME TO — the grid, the paper and the scale, at all six combinations — is
    // sheetGeom(), tested by running it in cardRender.test.ts rather than by reading it here.
    expect(SCRIPT).toContain('$: cardSheet = sheetGeom(cardsPerSheet, cardSheetLandscape);');
    expect(SCRIPT).toContain('$: sheetW = cardSheet.sheetW;');
    expect(SCRIPT).toContain('$: sheetH = cardSheet.sheetH;');
  });

  it('asks the renderer for the grid rather than working one out of its own', () => {
    // Two copies of a geometry is one geometry and one bug waiting for someone to change the
    // gutter in the place they happened to be looking at.
    expect(SCRIPT).not.toMatch(/\$:\s*cardCols\s*=/);
    expect(SCRIPT).not.toMatch(/\$:\s*slot[WH]\s*=/);
    expect(SCRIPT).not.toMatch(/\$:\s*cardUnit\s*=/);
  });

  it('is the bug, stated once more in the numbers the sheet is laid out with', () => {
    // Two A5s side by side on a landscape A4 are each PORTRAIT. Pressing Landscape must still give
    // landscape cards, which means the sheet has to go the other way.
    const W = 1080, H = 1527;
    const shape = (per: CardsPerSheet, sheet: boolean) => {
      const { cols, rows } = cardGrid(per, sheet);
      return { w: (sheet ? H : W) / cols, h: (sheet ? W : H) / rows };
    };
    expect(cardLandscapeOn(2, true)).toBe(false);
    const wanted = shape(2, sheetLandscapeFor(2, true));
    expect(wanted.w).toBeGreaterThan(wanted.h);
    expect(sheetLandscapeFor(2, true)).toBe(false);      // portrait A4, cut across the middle
  });
});

// ── One design, or one per card ──────────────────────────────────────────────
//
// The rule itself is cardLookFor(), tested in posterFlow.test.ts. What lives only here is that
// every read and every write on this tab goes THROUGH it — a single control left reading the
// scalars would silently edit Card A while the host was looking at Card B, and a single draw site
// left reading the previewed card's colours would print the whole stack in them.
describe('one design, or one per card', () => {
  it('defaults to one design, and every saved design opens as one', () => {
    // `?? true` in both readers. A blob written before this existed carries neither field, and it
    // has to open as the matching set it was designed as — five real events have saved designs.
    expect(SCRIPT).toContain('let cardOneDesign = true;');
    expect(code(SCRIPT, 'function restore(')).toContain('cardOneDesign = (c.cardOneDesign as boolean) ?? cardOneDesign;');
    expect(code(SCRIPT, 'function applyCfg(')).toContain('cardOneDesign = c.cardOneDesign ?? true;');
    // ...and an absent override map reads as none rather than as undefined reaching the renderer.
    // readCardSets() itself is the renderer's now, and is tested by CALLING it — with a design
    // that has no map, with a map full of rubbish, and with one that shares its layout objects.
    expect(readCardSets(undefined)).toEqual({});
    expect(readCardSets({ b: { cTitle: '#abc' } }).b.layout).toEqual(DEFAULT_CARD_LAYOUT);
  });

  it('carries both new fields into the saved design', () => {
    const cfg = SCRIPT.slice(SCRIPT.indexOf('  $: cfg = {'), SCRIPT.indexOf('};', SCRIPT.indexOf('  $: cfg = {')));
    expect(cfg).toContain('cardOneDesign');
    expect(cfg).toContain('cardSets');
  });

  it('resolves a card’s look nowhere — it hands the renderer the inputs and lets it decide', () => {
    // The component used to carry cardDesignFor(), which meant the resolution happened once here
    // and once per draw site. Now there is one resolver, in the module, applied per SET — and it is
    // tested by running it (cardRender.test.ts, "absent means inherit") rather than by grepping.
    expect(SCRIPT).not.toContain('cardLookFor(');
    expect(SCRIPT).not.toContain('const cardDesignFor');
    const o = SCRIPT.slice(SCRIPT.indexOf('  $: cardOpts = {'));
    const lit = o.slice(0, o.indexOf('\n  };'));
    expect(lit).toContain('oneDesign: cardOneDesign');
    expect(lit).toContain('overrides: cardSets');
    expect(lit).toContain('baseKey: sheets[0]?.key ?? null');
  });

  it('writes through ONE writer, so every control agrees which card it is changing', () => {
    // The four colours, their two "follow the poster" resets, the clear-all and every layout drag.
    for (const w of ["patchCardDesign({ cTitle: hex })", "patchCardDesign({ cBody: hex })",
                     "patchCardDesign({ cCode: hex })", "patchCardDesign({ cBg: hex })"]) {
      expect(SCRIPT, w).toContain(w);
    }
    expect(code(SCRIPT, 'const clearCardColours = ')).toContain('patchCardDesign({');
    expect(code(SCRIPT, 'const patchCardLayout = ')).toContain('patchCardDesign({ layout:');
    expect(code(SCRIPT, 'function resetCardLayout(')).toContain('patchCardDesign({ layout: cloneCardLayout(DEFAULT_CARD_LAYOUT) })');
    expect(code(SCRIPT, 'const cardSurface: Surface = {')).toContain('move: (k, x, y) => patchCardLayout(k, { x, y })');
    expect(code(SCRIPT, 'const cardSurface: Surface = {')).toContain('size: (k, px) => patchCardLayout(k, { size: px })');
  });

  it('never writes a colour or a layout straight to the scalars from a control', () => {
    // The old direct assignments are what would edit Card A behind the host's back. They may only
    // survive inside patchCardDesign, restore() and applyCfg().
    const writer = code(SCRIPT, 'function patchCardDesign(');
    for (const field of ['cardCTitle', 'cardCBody', 'cardCCode', 'cardCBg', 'cardLayout']) {
      const all = SCRIPT.match(new RegExp(`${field} = `, 'g')) ?? [];
      const inWriter = writer.match(new RegExp(`${field} = `, 'g')) ?? [];
      const inRestore = code(SCRIPT, 'function restore(').match(new RegExp(`${field} = `, 'g')) ?? [];
      const inApply = code(SCRIPT, 'function applyCfg(').match(new RegExp(`${field} = `, 'g')) ?? [];
      // Plus the declaration, which for the four colours reads `cardCTitle = ''` and so counts —
      // while cardLayout's carries a type annotation between the name and the `=` and does not.
      const decl = field === 'cardLayout' ? 0 : 1;
      expect(all.length, field).toBe(inWriter.length + inRestore.length + inApply.length + decl);
    }
  });

  it('hands every draw the SET, so a sheet cannot print in the previewed card’s colours', () => {
    // THE bug per-card designs invite, and the one thing about it that still lives here: the
    // component has to pass the set. That a set's own ink then lands on that set's card — and on
    // no other — is now proved by drawing it (cardRender.test.ts, "a card is painted from its OWN
    // design"), and by 385 Chromium sheet hashes rather than by reading this file.
    expect(code(SCRIPT, 'async function sheetCanvas(')).toContain('await drawSheet(ctx, set, { ...cardOpts,');
    // ...with THIS set's code on it, not the previewed one's.
    expect(code(SCRIPT, 'async function sheetCanvas(')).toContain('qrSrc: await qrForSet(sheets.length > 1 ? set.key : null)');
    const preview = code(SCRIPT, 'async function drawCards(');
    expect(preview).toContain('drawCard(ctx, set, { ox: 0, oy: 0, sheet: cardSheet, qrImage: qr, bg }, cardOpts)');
    expect(preview).toContain('cardPaintFor(set, cardOpts).useImage');
    // Nothing on this tab may read a card's colours out of a reactive value to DRAW with; the
    // reactive ones exist for the panel. `cardInk` never reaches a renderer call.
    expect(SCRIPT).not.toMatch(/drawCard\([^)]*cardInk/);
  });

  it('measures the outlines from the card being edited', () => {
    const fn = code(SCRIPT, 'function measureCardBounds(');
    expect(fn).toContain('titleGeom(ctx, g, activeSheet, cardOpts)');
    expect(fn).toContain('joinGeom(ctx, g, activeSheet, cardOpts)');
    // ...and remeasures when the mode or the overrides change. `$:` cannot see state read inside a
    // called function, so the dependency has to be named syntactically — and it is now the whole
    // opts object, which carries cardOneDesign and cardSets by construction.
    const m = SCRIPT.slice(SCRIPT.indexOf('$: cardMeasure = JSON.stringify(['));
    expect(m.slice(0, m.indexOf(']'))).toContain('cardOpts');
  });

  it('names every dependency of the card, once, where the renderer is handed its options', () => {
    // There used to be a `void`-list per reactive value, because `$:` cannot see state read inside
    // a called function and the old cardPaintFor() read a dozen of them. There is one list now:
    // the object literal the renderer is given. Everything downstream reads THAT.
    const o = SCRIPT.slice(SCRIPT.indexOf('  $: cardOpts = {'));
    const lit = o.slice(0, o.indexOf('\n  };'));
    for (const dep of ['cardOneDesign', 'cardSets', 'cardCTitle', 'cardCBody', 'cardCCode', 'cardCBg',
                       'cardLayout', 'cardInkSaver', 'cBg', 'bgMode', 'customBgUrl', 'themeImageUrl',
                       'cHeadline', 'cSteps', 'cCode', 'sheets', 'cardHeading', 'cardGlyph',
                       'cardRound', 'cardIds', 'cardLabelPos', 'cardLabelSize', 'cardShowQr',
                       'cardShowLink', 'cardCaption', 'cardCodeMode', 'cardsPerSheet',
                       'cardSheetLandscape', 'decorUsed', 'decorPos', 'decorScale', 'decorColour',
                       'typeSetKey', 'titleFace']) {
      expect(lit, dep).toContain(dep);
    }
    // ...and the base design is spelled out rather than fetched by a call, which `$:` cannot see
    // through. cardBaseOf() takes its parts as arguments for exactly this reason.
    expect(lit).toContain('cardBaseOf(cardCTitle, cardCBody, cardCCode, cardCBg, cardLayout)');
    expect(lit).not.toContain('cardBase()');
    // The card on screen is that same function, applied to the previewed set.
    expect(SCRIPT).toContain('$: cardActive = cardPaintFor(activeSheet, cardOpts);');
  });

  it('offers the mode where the cards are chosen, and only when there is a choice', () => {
    expect(MARKUP).toContain('bind:checked={cardOneDesign}');
    expect(MARKUP).toContain('One design for every card');
    // Inside the `sheets.length > 1` block: with one card there is nothing for a second design to
    // be different from.
    const gated = MARKUP.slice(MARKUP.indexOf('{#if sheets.length > 1}'));
    expect(gated.indexOf('bind:checked={cardOneDesign}')).toBeGreaterThan(-1);
  });

  it('says which card the controls are changing, once, above them all', () => {
    expect(MARKUP).toContain('{#if !cardOneDesign && printSets.length > 1}');
    expect(MARKUP).toContain('Editing {activeSheet?.label');
    // The old "Previewing" picker only shows in one-design mode, so there is never a second picker
    // on the same screen.
    expect(MARKUP).toContain('{#if cardOneDesign && printSets.length > 1}');
  });

  it('offers sync-to-Card-A by LETTING GO, not by copying', () => {
    const fn = code(SCRIPT, 'function syncCardToBase(');
    expect(fn).toContain('const { [set!.key]: _gone, ...rest } = cardSets;');
    expect(fn).not.toContain('cardBase()');
    // Undo first, then the change — the rule every mutation on this surface keeps.
    expect(fn.indexOf('commitBurst()')).toBeLessThan(fn.indexOf('pushUndo('));
    expect(fn.indexOf('pushUndo(')).toBeLessThan(fn.indexOf('cardSets = rest'));
    // ...and it refuses when there is nothing to let go of, so it cannot mark a design edited.
    expect(fn.indexOf('if (!cardHasOwn(set)) return;')).toBeLessThan(fn.indexOf('pushUndo('));
    expect(MARKUP).toContain('on:click={syncCardToBase}');
  });
});
