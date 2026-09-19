// One control per colour, pinned where it cannot come back.
//
// The host's report was "why do we have a colour picked on the 5th page for the words when the
// words tab has a colour picker". Both were real: a swatch on each text field, AND a flat "Text
// colours" list of all eight on the Background step. Six of the eight were two controls for one
// setting — and in "show all controls", where every step's block renders at once, both copies were
// on screen side by side.
//
// The arrangement is a fact about the MARKUP — which dot is written where — so no test of the
// helpers can see it come back. This reads the component instead. Comments are stripped first: the
// notes left where the flat list was name the thing they deleted, and should go on naming it.
/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
// `?raw` rather than node:fs — the component's own source, resolved by vite the same way the app
// resolves it, and with no `@types/node` for a web package that has never needed one.
import SRC from './PosterModal.svelte?raw';
import { POSTER_COLOR_STEP, CARD_COLOR_STEP, type PosterColorTarget, type CardColorTarget } from '$lib/posterFlow';
/** Just the template, with comments gone. */
const MARKUP = SRC
  .slice(SRC.indexOf('</script>'), SRC.lastIndexOf('<style>'))
  .replace(/<!--[\s\S]*?-->/g, '');

const TARGETS = Object.keys(POSTER_COLOR_STEP) as PosterColorTarget[];
const count = (needle: string) => MARKUP.split(needle).length - 1;

describe('every poster colour has exactly one control', () => {
  it.each(TARGETS)('%s is written from one place and one place only', (key) => {
    // `onColorInput` is the single colour-writing handler in the modal, so counting its call sites
    // counts the controls — whatever they look like and whichever step they sit on.
    expect(count(`onColorInput(e, '${key}')`)).toBe(1);
  });

  it('aims the image swatches from each of those controls', () => {
    // The flat list worked the swatch strip because each of its rows pointed `activeTarget` at
    // itself on focus. The dots had no such handler, so deleting the list without this would have
    // taken the swatch flow with it. One shared handler, one call per control.
    for (const key of TARGETS) expect(count(`aimAt('${key}')`)).toBe(1);
  });

  it('knows a home for every colour the markup actually offers', () => {
    // The other direction: a colour added to the template with no entry in either step table would
    // be a control on no step — reachable in "show all controls" and nowhere in the flow.
    const homes = { ...POSTER_COLOR_STEP, ...CARD_COLOR_STEP } as Record<string, number>;
    const inMarkup = [...MARKUP.matchAll(/onColorInput\(e, '(\w+)'\)/g)].map((m) => m[1]);
    for (const k of inMarkup) expect(homes[k], k).toBeGreaterThan(0);
    // ...and every poster colour still has one, which is the half that was true before the cards
    // gained dots of their own.
    for (const k of TARGETS) expect(inMarkup, k).toContain(k);
  });
});

// ── The trick card's colours, the same way ───────────────────────────────────
//
// The poster puts a dot on the field. The cards used to be a flat list of four, deliberately — an
// earlier pass left it alone because two of the four have no field to sit beside. That reasoning
// was right about those two and wrong about the other two, so this is a HYBRID rather than a copy:
// dots where a field exists, and a control of their own for the pair that have none.
describe('the trick card colours', () => {
  const CARD_TARGETS = Object.keys(CARD_COLOR_STEP) as CardColorTarget[];

  it('puts the title and the code/link on the field that puts them on the card', () => {
    // Literally in the markup, beside a control, rather than reached through the list's `r.key`.
    for (const key of ['cardTitle', 'cardCode']) {
      expect(count(`onColorInput(e, '${key}')`), key).toBe(1);
      expect(count(`aimAt('${key}')`), key).toBe(1);
      expect(MARKUP).toContain(`onColorInput(e, '${key}')`);
    }
    // The SAME dot class, handler and focus-aim the poster's use — the cards gain the behaviour
    // rather than a parallel one.
    // `[\s\S]{0,400}?` rather than `[^>]*`: an arrow function in an attribute carries a `>`, so a
    // not-a-bracket class stops inside the tag it is trying to match.
    expect(MARKUP).toMatch(/class="fc-dot"[\s\S]{0,400}?onColorInput\(e, 'cardTitle'\)/);
    expect(MARKUP).toMatch(/class="fc-dot"[\s\S]{0,400}?onColorInput\(e, 'cardCode'\)/);
  });

  it('leaves the other two a control of their own, because they have no field', () => {
    // The trick list comes from the event's trick list and the background is a colour and nothing
    // else. A dot for either would have to sit beside a control invented to hold it.
    for (const key of ['cardBody', 'cardBg']) {
      expect(MARKUP, key).not.toContain(`onColorInput(e, '${key}')`);
    }
    // The two SHARE a step, and it is not one of the steps that has a field for a colour. That is
    // the rule; the number is not. This used to assert `5` literally and broke the moment the
    // colours moved onto the List step — which is a test describing the furniture rather than the
    // arrangement, and the arrangement is what matters.
    expect(CARD_COLOR_STEP.cardBody).toBe(CARD_COLOR_STEP.cardBg);
    expect([CARD_COLOR_STEP.cardTitle, CARD_COLOR_STEP.cardCode],
      'the fieldless pair must not share a step with a colour that has a field')
      .not.toContain(CARD_COLOR_STEP.cardBody);
  });

  // The coupling that made the move above risky, pinned so the next person finds it from the test
  // rather than from a swatch strip that aims at nothing.
  it('files the fieldless colours on the step the colour section actually renders on', () => {
    // SRC, not MARKUP: MARKUP is sliced to the template, and the constant lives in the script.
    const declared = SRC.match(/const C_COLOUR_STEP = (\d+)/);
    expect(declared, 'PosterModal should name the step in one place').not.toBeNull();
    expect(Number(declared![1]), 'C_COLOUR_STEP and CARD_COLOR_STEP must agree')
      .toBe(CARD_COLOR_STEP.cardBody);
    // …and the section is guarded on that same constant, not on a number typed twice.
    expect(MARKUP).toContain('cStep === C_COLOUR_STEP');
  });

  it('renders the list from the step table, not from a second hand-written pair', () => {
    // A colour moved onto a field and left in the list too is the duplicate swatch the poster's
    // flat list was removed for.
    expect(MARKUP).toContain('{#each CARD_LIST_ROWS as r (r.key)}');
    expect(count('VISIBLE_CARD_COLOR_ROWS')).toBe(0);
  });

  it('gives the two moved colours a way back to following the poster', () => {
    // The list's header carries one reset for all four. A dot that has been scattered onto another
    // step needs its own, or a host who tinted the title on Words has to find the Colour step to
    // undo it — which is the trip the dots exist to save.
    // Through patchCardDesign, like every other card colour write: with "one design" off it has to
    // clear the card being edited, not always Card A.
    expect(count("patchCardDesign({ cTitle: '' })")).toBe(1);
    expect(count("patchCardDesign({ cCode: '' })")).toBe(1);
  });

  it('keeps every card colour on a step, so the swatch strip can always aim', () => {
    for (const k of CARD_TARGETS) expect(CARD_COLOR_STEP[k], k).toBeGreaterThan(0);
  });
});

describe('the flat "Text colours" list stays retired', () => {
  it('renders no list of poster colour rows', () => {
    // VISIBLE_COLOR_ROWS is now read only by the script, to label the swatch strip. Rendering it
    // again — in either mode — is the defect, because every one of its rows already has a dot.
    expect(count('VISIBLE_COLOR_ROWS')).toBe(0);
    expect(MARKUP).not.toContain('Text colours');
  });

  it('leaves exactly one flat colour list in the modal, the trick card\'s own', () => {
    // The cards tab keeps its list and that is not the same defect: each of its four colours has
    // exactly one control, and two of them (the trick list's ink, the card's background) have no
    // field to sit beside at all.
    expect(count('class="colors"')).toBe(1);
    expect(count('Card colours')).toBe(1);
  });
});

describe('the image swatch strip is never on one screen twice', () => {
  it('is one component, used three times', () => {
    // Words and Join on the poster, plus the cards tab. Three call sites, one implementation — the
    // strip could not be moved off the flat list while it was inline markup inside it.
    expect(count('<PosterPalette')).toBe(3);
  });

  it('gates the second poster copy on guided mode', () => {
    // In "show all controls" both step blocks render, so the Join copy must not: the Words copy is
    // already on that screen. `{#if pGuided}` immediately before it is what guarantees that.
    expect(count('{#if pGuided}<PosterPalette')).toBe(1);
  });
});
