import { describe, it, expect } from 'vitest';
import { posterExportsReady, shouldDismissBackdrop, isSavedDesign, posterTabs, cardsTabState,
         printReady, resetTargetFor, canJumpToStep, inkSyncTargets, readTextItem, readTextItems, shouldPersistDesign, seedAfterMissions,
         colorRowsForStep, aimedColorTarget, binActionFor, cardBinActionFor, pressRole, escapeLayer,
         canRotate, snapAngle, ROTATABLE_ELEMENTS, ROT_SNAP_STEP, ROT_SNAP_WITHIN,
         cardGrid, cardLandscapeOn, sheetLandscapeFor, cardShapeNote, type CardsPerSheet,
         cardLookFor, isBaseCard, type CardLook,
         type PosterColorTarget } from './posterFlow';
import { POSTER_PRESETS } from './posterPresets';
import { DEFAULT_POSTER_LAYOUT } from './posterRender';

describe('when the export row appears', () => {
  const ready = (o: Partial<Parameters<typeof posterExportsReady>[0]>) =>
    posterExportsReady({ hasSavedDesign: false, guided: true, seenLastStep: false, ...o });

  it('is hidden for a brand-new design still on the first steps', () => {
    expect(ready({})).toBe(false);
  });

  it('appears once the host reaches the last step', () => {
    expect(ready({ seenLastStep: true })).toBe(true);
  });

  it('stays once they step BACK from the last step', () => {
    // Nipping back to change a colour must not take the buttons away again — a control that comes
    // and goes reads as a bug, and the design is finished either way.
    expect(ready({ guided: true, seenLastStep: true })).toBe(true);
  });

  it('appears for the host who asked for every control', () => {
    // "Skip — show me every control" is an explicit statement that they do not want the flow.
    expect(ready({ guided: false })).toBe(true);
  });

  it('appears immediately when an existing design is reopened', () => {
    // The one case that must never be gated: a finished poster being reprinted next week.
    expect(ready({ hasSavedDesign: true, guided: true, seenLastStep: false })).toBe(true);
  });
});

describe('dismissing a modal by its backdrop', () => {
  it('closes on a click that both started and ended on the backdrop', () => {
    expect(shouldDismissBackdrop({ downOnBackdrop: true, clickOnBackdrop: true })).toBe(true);
  });

  it('does NOT close when the gesture started inside the sheet', () => {
    // Drag-selecting text in the inline editor and releasing past the sheet's edge delivers a click
    // whose target is the backdrop. That used to close the designer and lose the edit.
    expect(shouldDismissBackdrop({ downOnBackdrop: false, clickOnBackdrop: true })).toBe(false);
  });

  it('does NOT close when the click landed inside the sheet', () => {
    expect(shouldDismissBackdrop({ downOnBackdrop: true, clickOnBackdrop: false })).toBe(false);
  });

  it('does NOT close while the inline editor is open', () => {
    // The first press outside an open editor ends the edit and nothing else.
    expect(shouldDismissBackdrop({ downOnBackdrop: true, clickOnBackdrop: true, blockedByEditor: true })).toBe(false);
  });
});

describe('telling a finished design from a starting point', () => {
  // All three of these reach the designer as `initialConfig` — the admin page passes
  // `posterSeed ?? ev.posterConfig` — and only one of them is work the host has already done.
  it('says no to every gallery preset', () => {
    for (const p of POSTER_PRESETS) {
      expect(isSavedDesign(p.cfg), `preset "${p.key}" read as a finished design`).toBe(false);
    }
  });

  it('says no to "start from scratch" and to nothing at all', () => {
    expect(isSavedDesign({})).toBe(false);
    expect(isSavedDesign(null)).toBe(false);
    expect(isSavedDesign(undefined)).toBe(false);
  });

  it('says yes to a design that carries a layout', () => {
    // Including one saved long before any of this existed: the designer has always serialised the
    // layout, so an old poster still reads as finished and its host is never re-gated.
    expect(isSavedDesign({ layout: DEFAULT_POSTER_LAYOUT })).toBe(true);
    expect(isSavedDesign({ headline: 'Ana & Ben', layout: { title: { x: 0.5, y: 0.2, size: 72 } } })).toBe(true);
  });
});

describe('the designer\'s tabs', () => {
  it('always offers all three, in order', () => {
    expect(posterTabs().map((t) => t.key)).toEqual(['poster', 'cards', 'print']);
  });

  it('never drops the trick-cards tab', () => {
    // The one thing this function exists to hold. Hiding the tab on an event with no trick list is
    // how a host never learns the feature exists, and it is the distinctive half of the product.
    expect(posterTabs().some((t) => t.key === 'cards')).toBe(true);
  });
});

describe('what the trick-cards tab has to say', () => {
  it('offers to make one when there is no trick list', () => {
    expect(cardsTabState({ setCount: 0, printableCount: 0 })).toBe('none');
  });

  it('tells a host who switched every card off, rather than telling them to start a list', () => {
    // Answering "you turned them all off" with "set one up" would send someone to build a list they
    // already have.
    expect(cardsTabState({ setCount: 3, printableCount: 0 })).toBe('all-off');
  });

  it('is ready with at least one card switched on', () => {
    expect(cardsTabState({ setCount: 1, printableCount: 1 })).toBe('ready');
    expect(cardsTabState({ setCount: 3, printableCount: 2 })).toBe('ready');
  });
});

describe('when the Print tab has anything in it', () => {
  const ready = (o: Partial<Parameters<typeof printReady>[0]>) =>
    printReady({ hasSavedDesign: false, posterGuided: true, posterSeenLast: false,
                 cardsGuided: true, cardsSeenLast: false, ...o });

  it('is empty for a brand-new design on the first steps', () => {
    expect(ready({})).toBe(false);
  });

  it('opens once the poster flow has been walked to the end', () => {
    expect(ready({ posterSeenLast: true })).toBe(true);
  });

  it('opens once the CARDS flow has been walked to the end', () => {
    // Card exports were never gated at all before printing moved in here. They are now — but on a
    // rule the cards flow can satisfy by itself, or finishing the cards would gate the very
    // buttons that used to be free.
    expect(ready({ cardsSeenLast: true })).toBe(true);
  });

  it('opens for the host who asked either tab for every control', () => {
    expect(ready({ posterGuided: false })).toBe(true);
    expect(ready({ cardsGuided: false })).toBe(true);
  });

  it('opens immediately when an existing design is reopened', () => {
    expect(ready({ hasSavedDesign: true })).toBe(true);
  });

  it('is the poster export rule read twice, not a second mechanism', () => {
    // With the cards flow untouched (guided, never finished), the Print tab must answer exactly
    // what the old poster export row answered — that is what makes this a reconciliation of the
    // existing gate rather than a new one bolted beside it.
    for (const saved of [false, true]) for (const guided of [false, true]) for (const seen of [false, true]) {
      expect(printReady({ hasSavedDesign: saved, posterGuided: guided, posterSeenLast: seen,
                          cardsGuided: true, cardsSeenLast: false }))
        .toBe(posterExportsReady({ hasSavedDesign: saved, guided, seenLastStep: seen }));
    }
  });
});

describe('which reset the header shows', () => {
  it('shows the poster one on the poster tab', () => {
    expect(resetTargetFor('poster')).toBe('poster');
  });

  it('shows the card one on the cards tab', () => {
    expect(resetTargetFor('cards')).toBe('cards');
  });

  it('shows neither on the Print tab — nothing there has a layout', () => {
    expect(resetTargetFor('print')).toBe(null);
  });

  it('never offers both at once', () => {
    // One button, not two: the header is already tight at 400px with undo, redo, Arrange and
    // Start again in it.
    for (const v of ['poster', 'cards', 'print'] as const) {
      expect(['poster', 'cards', null]).toContain(resetTargetFor(v));
    }
  });

  it('shows neither on a cards tab with no trick list', () => {
    // There is no card, so there is nothing that has been arranged — the button would act on a
    // layout the host has never seen.
    expect(resetTargetFor('cards', false, false)).toBe(null);
  });

  it('keeps the poster reset while arranging full screen', () => {
    // That mode exists to drag things around, so putting them back is the control it most wants —
    // and the header there is down to undo, redo and Done.
    expect(resetTargetFor('poster', true)).toBe('poster');
  });
});

describe('jumping about the step strip', () => {
  const jump = (o: Partial<Parameters<typeof canJumpToStep>[0]>) =>
    canJumpToStep({ to: 1, from: 1, maxReached: 1, last: 6, canAdvance: true, ...o });

  it('refuses a forward jump past the furthest step reached', () => {
    // The strip used to be `pStep = i + 1` with no guard, so it dropped a first-time host onto
    // step 5 of a flow they had answered one question of.
    expect(jump({ to: 5, from: 1, maxReached: 1 })).toBe(false);
  });

  it('allows a jump back to anything already seen', () => {
    expect(jump({ to: 2, from: 5, maxReached: 5 })).toBe(true);
  });

  it('allows a jump forward again to somewhere already seen', () => {
    // Stepping back to check a colour must not cost three presses of Next to undo.
    expect(jump({ to: 5, from: 2, maxReached: 5 })).toBe(true);
  });

  it('refuses a forward jump while the current step is incomplete', () => {
    expect(jump({ to: 4, from: 2, maxReached: 6, canAdvance: false })).toBe(false);
  });

  it('still allows going BACKWARDS from an incomplete step', () => {
    // The requirement is about leaving the step behind, not about looking at an earlier one.
    expect(jump({ to: 1, from: 2, maxReached: 6, canAdvance: false })).toBe(true);
  });

  it('refuses a step off either end', () => {
    expect(jump({ to: 0, from: 2, maxReached: 6 })).toBe(false);
    expect(jump({ to: 7, from: 2, maxReached: 6 })).toBe(false);
  });
});

describe('which colours have drifted from the title', () => {
  // The affordance this drives is deliberately quiet: it appears only where there is something to
  // reconcile. Which makes "nothing to reconcile" the case that matters most — get it wrong and a
  // permanent button appears on a panel with no room for one.
  it('says nothing when every colour follows the title', () => {
    expect(inkSyncTargets('#112233', { headTop: '', headBottom: '', names: '' })).toEqual([]);
    expect(inkSyncTargets('#112233', { headTop: undefined, names: undefined })).toEqual([]);
  });

  it('names the ones that are set and differ', () => {
    expect(inkSyncTargets('#112233', { headTop: '#ff0000', headBottom: '', names: '#00ff00' }))
      .toEqual(['headTop', 'names']);
  });

  it('an override that happens to match the title has nothing to sync', () => {
    // Offering "sync to title colour" for a colour that already IS the title colour is an
    // affordance for a no-op, and it would sit there permanently.
    expect(inkSyncTargets('#112233', { names: '#112233' })).toEqual([]);
    // <input type="color"> emits lower case; a preset may not.
    expect(inkSyncTargets('#AABBCC', { names: '#aabbcc' })).toEqual([]);
    expect(inkSyncTargets('#aabbcc', { names: '  #AABBCC  ' })).toEqual([]);
  });

  it('keeps the order it was given, so the caller decides what the list reads like', () => {
    expect(inkSyncTargets('#000000', { names: '#111111', headTop: '#222222' })).toEqual(['names', 'headTop']);
  });
});

// ── Reading a stored design back ───────────────────────────────────────────────
//
// The bug this exists for is a field that was simply NOT COPIED. `colour` is on the type, in the
// serialised cfg, in undo/redo and in the renderer — everywhere except the reader. Nothing threw,
// nothing logged: a host coloured a custom line, watched it work, saved, reopened, and found it
// black. "The reader forgot a field" is not a class of bug anyone finds by reading code.
describe('reading stored poster text items', () => {
  it('keeps a colour the host chose', () => {
    expect(readTextItem({ text: 'Hi', x: 0.2, y: 0.3, size: 40, colour: '#ff8800' }))
      .toEqual({ text: 'Hi', x: 0.2, y: 0.3, size: 40, colour: '#ff8800' });
  });

  it('absent means absent — NOT a key holding undefined', () => {
    // `colour: t.colour ?? undefined` would pass a toEqual check and still be wrong. Absent is how
    // "inherit the poster's ink" is spelled, and a key that is present-but-undefined makes two
    // identical designs compare as different, which pushes a phantom undo step.
    const r = readTextItem({ text: 'Hi' })!;
    expect('colour' in r).toBe(false);
    expect(Object.keys(r)).toEqual(['text', 'x', 'y', 'size']);
    // ...and the serialised forms of two colourless items are byte-identical.
    expect(JSON.stringify(readTextItem({ text: 'Hi' }))).toBe(JSON.stringify(readTextItem({ text: 'Hi', colour: 'red' })));
  });

  it('refuses anything ctx.fillStyle would silently ignore', () => {
    // fillStyle does not throw on junk — it keeps the PREVIOUS colour, so a bad value paints the
    // line in whatever was set last and looks like a bug somewhere else entirely.
    for (const bad of ['red', '#fff', '#ff88', 'rgb(1,2,3)', '#gggggg', '', '  ', 'javascript:x', 42, null, {}]) {
      const r = readTextItem({ text: 'Hi', colour: bad })!;
      expect('colour' in r).toBe(false);
    }
  });

  it('accepts either case and trims, because a preset and a colour input disagree', () => {
    expect(readTextItem({ text: 'Hi', colour: ' #AABBCC ' })!.colour).toBe('#AABBCC');
  });

  it('clamps the numbers rather than trusting them — NaN coordinates paint nothing', () => {
    const r = readTextItem({ text: 'Hi', x: 99, y: -4, size: 1e9 })!;
    expect(r.x).toBe(1); expect(r.y).toBe(0); expect(r.size).toBe(120);
    const d = readTextItem({ text: 'Hi', x: 'nope', y: undefined, size: NaN })!;
    expect(d.x).toBe(0.5); expect(d.y).toBe(0.7); expect(d.size).toBe(30);
  });

  it('drops a bad entry rather than refusing the whole poster', () => {
    expect(readTextItems([{ text: 'a' }, null, { size: 20 }, 'x', { text: 'b', colour: '#000000' }]))
      .toEqual([{ text: 'a', x: 0.5, y: 0.7, size: 30 }, { text: 'b', x: 0.5, y: 0.7, size: 30, colour: '#000000' }]);
    expect(readTextItems(undefined)).toEqual([]);
    expect(readTextItems({})).toEqual([]);
  });

  it('caps the text at the length the designer allows', () => {
    expect(readTextItem({ text: 'x'.repeat(500) })!.text.length).toBe(80);
  });

  it('round-trips: what the designer saves is what it reads back', () => {
    // The property the original bug broke. Anything the renderer can draw must survive
    // save → JSON → restore unchanged, or the host watches their work revert on reopen.
    const items = [
      { text: 'Ada & Bea', x: 0.31, y: 0.62, size: 44, colour: '#b08b08' },
      { text: 'plain', x: 0.5, y: 0.7, size: 30 },
    ];
    expect(readTextItems(JSON.parse(JSON.stringify(items)))).toEqual(items);
  });
});

// ── When a design is worth saving ──────────────────────────────────────────────

describe('the export gate does not unlock itself', () => {
  it('an untouched preset is not saved — which is what kept unlocking the exports', () => {
    // The whole failure in one line: the reactive block fires once on mount with no host edit, and
    // persist() wrote the full cfg (layout included) 800ms later. isSavedDesign() reads a present
    // layout as finished work, so the NEXT open of that preset had every export unlocked on a
    // poster still carrying the preset's words.
    expect(shouldPersistDesign({ hasSavedDesign: false, edited: false })).toBe(false);
  });

  it('saves from the first real edit', () => {
    expect(shouldPersistDesign({ hasSavedDesign: false, edited: true })).toBe(true);
  });

  it('a design that was ALREADY finished saves from the first moment', () => {
    // The other direction, and it matters: the first thing a returning host may do is press undo,
    // and an undo that does not persist is a change that comes back on reload.
    expect(shouldPersistDesign({ hasSavedDesign: true, edited: false })).toBe(true);
    expect(shouldPersistDesign({ hasSavedDesign: true, edited: true })).toBe(true);
  });

  it('lines up with isSavedDesign — the gate and the save agree about what a design is', () => {
    // A preset sets the LOOK only and carries no layout; "start from scratch" is literally {}.
    expect(isSavedDesign({ typeSetKey: 'x', cBg: '#fff' })).toBe(false);
    expect(isSavedDesign({})).toBe(false);
    expect(isSavedDesign({ layout: {} })).toBe(true);
    // So an unedited preset is neither saved nor savable, and cannot become one by sitting there.
    const preset = { typeSetKey: 'x' };
    expect(shouldPersistDesign({ hasSavedDesign: isSavedDesign(preset), edited: false })).toBe(false);
  });
});

// ── The designer, the trick-list editor, and back ─────────────────────────

describe('seedAfterMissions', () => {
  const preset = { typeSetKey: 'x', cBg: '#fff' };

  it('keeps a seed that was never written down', () => {
    // The bug: the parent dropped the seed unconditionally on the way back, on the grounds that the
    // designer auto-saves. shouldPersistDesign() says otherwise for an untouched preset, so the
    // pick existed nowhere else and the designer reopened on the previous design (or none).
    expect(seedAfterMissions({ seed: preset, persisted: false })).toBe(preset);
    // "Start from scratch" is a seed too, and an empty object must not be read as "no seed".
    const scratch = {};
    expect(seedAfterMissions({ seed: scratch, persisted: false })).toBe(scratch);
  });

  it('drops it once the event holds the newer copy', () => {
    // The other direction: a host who edited the preset before leaving has those edits saved, and
    // putting the seed back would show them the preset again with their work gone.
    expect(seedAfterMissions({ seed: preset, persisted: true })).toBeNull();
  });

  it('agrees with shouldPersistDesign about what "never written down" means', () => {
    const persisted = shouldPersistDesign({ hasSavedDesign: isSavedDesign(preset), edited: false });
    expect(persisted).toBe(false);
    expect(seedAfterMissions({ seed: preset, persisted })).toBe(preset);
  });

  it('has nothing to keep when there was no seed', () => {
    expect(seedAfterMissions({ seed: null, persisted: false })).toBeNull();
  });
});

// ── One home per colour ───────────────────────────────────────────────────
//
// The host's report: "why do we have a colour picked on the 5th page for the words when the words
// tab has a colour picker". Both were real controls for the same setting — the swatch on the field
// and a row in a flat "Text colours" list on the Background step — and in "show all controls",
// where every step's block renders at once, the two were on screen side by side.

describe('where each poster colour lives', () => {
  const ALL: { key: PosterColorTarget; label: string }[] = [
    { key: 'headline', label: 'Title' },
    { key: 'headTop', label: 'Small line above' },
    { key: 'headBottom', label: 'Small line below' },
    { key: 'names', label: 'Names' },
    { key: 'message', label: 'Message' },
    { key: 'steps', label: 'How-to' },
    { key: 'code', label: 'Code / URL' },
    { key: 'footer', label: 'Footer URL' },
  ];
  const keysOn = (step: number | null, rows = ALL) => colorRowsForStep(step, rows).map((r) => r.key);

  it('gives every colour exactly one step, so no setting has two controls', () => {
    // The invariant the defect broke. Summing the steps' contents has to reproduce the whole set
    // with nothing counted twice — which is the same statement as "one control per setting".
    const seen = [1, 2, 3, 4, 5, 6].flatMap((s) => keysOn(s));
    expect(seen.sort()).toEqual(ALL.map((r) => r.key).sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('puts the words on the Words step', () => {
    expect(keysOn(1)).toEqual(['headline', 'headTop', 'headBottom', 'names', 'message', 'steps']);
  });

  it('puts the join colours on the Join step, beside the switches that print them', () => {
    // The two that are NOT word colours, so the Words step could not take them when the flat list
    // was retired. Neither may go back to Words, and neither may be left with no home at all.
    expect(keysOn(3)).toEqual(['code', 'footer']);
  });

  it('leaves no colour control on the step the host was complaining about', () => {
    // Step 5 is the card stock: the background, and whether that colour prints. Nothing else.
    expect(keysOn(5)).toEqual([]);
  });

  it('shows every colour at once in "show all controls"', () => {
    // Not a fourth arrangement: in !pGuided every step's block renders, so every dot is on screen
    // — which is precisely why the flat list could not be kept "just for that mode".
    expect(keysOn(null)).toEqual(ALL.map((r) => r.key));
  });

  it('never offers a colour for something that is not being printed', () => {
    // The caller filters to the elements actually on the poster first (VISIBLE_COLOR_ROWS); this
    // must not hand any of them back. A host with no footer URL has no footer colour.
    const printed = ALL.filter((r) => r.key !== 'footer' && r.key !== 'names');
    expect(keysOn(3, printed)).toEqual(['code']);
    expect(keysOn(1, printed)).not.toContain('names');
  });
});

describe('what the image swatches are aimed at', () => {
  const row = (key: string) => ({ key });

  it('holds the aim while that control is still on screen', () => {
    expect(aimedColorTarget('message', [row('headline'), row('message')])).toBe('message');
  });

  it('re-aims when the host walks to another step', () => {
    // Words → Join. Left alone, the strip would say "Title" on a screen with no title field and
    // quietly recolour the title from a step that cannot show it happening.
    expect(aimedColorTarget('headline', [row('code'), row('footer')])).toBe('code');
  });

  it('re-aims when the element it pointed at is switched off', () => {
    // Turning the footer URL off takes its dot away with it; the aim cannot stay on it.
    expect(aimedColorTarget('footer', [row('code')])).toBe('code');
  });

  it('keeps the aim when the screen has no colour control at all', () => {
    // Join with both the code and the footer URL off. Nothing to aim at, so nothing is decided —
    // and the strip itself does not render. Clobbering the aim here would lose it in passing.
    expect(aimedColorTarget('headline', [])).toBe('headline');
  });

  it('agrees with colorRowsForStep about what is on screen', () => {
    // The two are always used as a pair: the rows decide what may be aimed at.
    const rows = colorRowsForStep(3, [{ key: 'headline' }, { key: 'code' }, { key: 'footer' }]);
    expect(aimedColorTarget('names', rows)).toBe('code');
  });
});

// ── The selected element's own controls ──────────────────────────────────────
// Tap-to-select replaced tap-to-open-the-text-box, which means every element now carries a pencil,
// a bin and a ✕. The bin is the part with a table behind it: "get rid of it" means three different
// things depending on the element, and one wrong entry strands the host who picked that element.
describe('what the bin does, per element', () => {
  it('deletes the things the host added', () => {
    // Their own line and their own placed motif: both can be un-added, and nothing depends on them.
    expect(binActionFor('text:0')).toBe('delete');
    expect(binActionFor('text:7')).toBe('delete');
    expect(binActionFor('decor:0')).toBe('delete');
  });

  it('CLEARS the fixtures rather than removing them', () => {
    // These carry a stored position, size and colour that are part of the design. Removing the slot
    // would be unrecoverable through this UI; emptying the words is not.
    for (const k of ['message', 'steps', 'names']) expect(binActionFor(k), k).toBe('clear');
  });

  it('toggles off the two elements a switch already governs', () => {
    // `showBrand` and `showFooterUrl`. The bin is a second way to reach a control that exists.
    expect(binActionFor('brand')).toBe('toggle-off');
    expect(binActionFor('footer')).toBe('toggle-off');
  });

  it('gives the title NO bin', () => {
    // It is the poster's one required field: the flow will not advance past step 1 without it and
    // the renderer falls back to 'Our Event' when it is blank. A bin here would look like it had
    // done nothing while quietly blocking the way forward.
    expect(binActionFor('title')).toBeNull();
  });

  it('gives the QR NO bin', () => {
    // The code IS how a guest joins, and nothing in the designer can remove it. The only switch
    // near it governs the white card BEHIND the code, and that switch is force-restored whenever
    // the paper's contrast is too low — so a bin wired to it would visibly do nothing on every
    // design over a photograph.
    expect(binActionFor('qr')).toBeNull();
  });

  it('refuses an element it has never heard of', () => {
    // A new ElKey has to be added here deliberately. Defaulting to "no bin" is the safe direction:
    // the control is absent until somebody decides what it should mean.
    expect(binActionFor('sparkles')).toBeNull();
    expect(binActionFor('')).toBeNull();
  });

  it('keeps the card’s two on their own table', () => {
    // The card's title falls back to the poster's headline, so clearing it cannot strand anyone.
    expect(cardBinActionFor('title')).toBe('clear');
    // One block, labelled "QR / join", governed by two switches — so the bin takes the block.
    expect(cardBinActionFor('qr')).toBe('toggle-off');
    expect(cardBinActionFor('message')).toBeNull();
  });

  it('does NOT let the poster’s table answer for the card, or the other way round', () => {
    // Both surfaces have an element keyed 'title' and they mean different things: the poster's is
    // required and unbinnable, the card's is an override that can be dropped.
    expect(binActionFor('title')).not.toBe(cardBinActionFor('title'));
  });
});

describe('exclusive selection', () => {
  it('lets a press take the selection when nothing is held', () => {
    expect(pressRole(null, 'title')).toBe('take');
  });

  it('lets the held element be pressed again — that is how it is dragged', () => {
    expect(pressRole('title', 'title')).toBe('take');
  });

  it('refuses to hand the selection to another element', () => {
    // The whole point: while one element is held, tapping another must not move the selection. The
    // ✕ and Escape are the two ways out.
    expect(pressRole('title', 'message')).toBe('pinch');
    expect(pressRole('text:0', 'qr')).toBe('pinch');
  });

  it('still calls a refused press a gesture, not a no-op', () => {
    // 'pinch', not 'none'. The stage is a 316px thumbnail almost entirely covered by element
    // boxes, so a two-finger pinch of the held element has nowhere else to start from — the press
    // has to stay alive even though it may not move what it landed on.
    expect(pressRole('title', 'message')).not.toBe('none');
  });
});

describe('what Escape peels off', () => {
  const layer = (o: Parameters<typeof escapeLayer>[0]) => escapeLayer(o);

  it('closes the designer when there is nothing else on', () => {
    expect(layer({})).toBe('close');
  });

  it('peels ONE layer at a time, innermost first', () => {
    // Everything on at once: each press must take exactly the innermost, in this order.
    const all = { binArmed: true, restyleArmed: true, resetArmed: true, editing: true, selected: true, fullScreen: true };
    expect(layer(all)).toBe('bin');
    expect(layer({ ...all, binArmed: false })).toBe('restyle');
    expect(layer({ ...all, binArmed: false, restyleArmed: false })).toBe('reset');
    expect(layer({ ...all, binArmed: false, restyleArmed: false, resetArmed: false })).toBe('editor');
    expect(layer({ selected: true, fullScreen: true })).toBe('selection');
    expect(layer({ fullScreen: true })).toBe('fullscreen');
  });

  it('puts a selected element INSIDE the full-screen stage', () => {
    // A selection lives ON that stage. Escaping the stage while still holding an element would skip
    // a layer, and leaving full screen with something selected is not what one press means.
    expect(layer({ selected: true, fullScreen: true })).toBe('selection');
  });

  it('never closes the designer while anything is open', () => {
    for (const k of ['binArmed', 'restyleArmed', 'resetArmed', 'editing', 'selected', 'fullScreen'] as const) {
      expect(layer({ [k]: true }), k).not.toBe('close');
    }
  });

  it('releases a selection before leaving full screen, and the editor before the selection', () => {
    // The two orderings this change introduced, stated on their own so a reordering cannot pass by
    // being buried in the all-on case above.
    expect(layer({ editing: true, selected: true })).toBe('editor');
    expect(layer({ selected: true, fullScreen: true })).toBe('selection');
  });
});

describe('which poster elements may be turned', () => {
  it('turns everything the host wrote', () => {
    for (const k of ['title', 'message', 'steps', 'names', 'footer']) expect(canRotate(k), k).toBe(true);
    // Their own lines and their own motifs, by prefix — the same key space the drag surface uses,
    // so neither needs a table of its own.
    expect(canRotate('text:0')).toBe(true);
    expect(canRotate('text:12')).toBe(true);
    expect(canRotate('decor:3')).toBe(true);
  });

  it('refuses the QR outright, rather than limiting it to quarter turns', () => {
    // A scanner finds a code's own orientation before it decodes it, so turning one buys nothing —
    // while the join code printed in the panel's lower strip would come out sideways on the wall,
    // and the keep-out rect the placed motifs are clipped against would go onto a diagonal. Quarter
    // turns have both of those problems and no upside either.
    expect(canRotate('qr')).toBe(false);
  });

  it('refuses our own mark', () => {
    // It is our imprint on somebody else's wedding sign. It already has no resize grip and is
    // locked to its own line; askew it reads as a fault in the product.
    expect(canRotate('brand')).toBe(false);
  });

  it('refuses anything it has never heard of', () => {
    for (const k of ['', 'qrpanel', 'title ', 'TITLE', 'decor', 'text', 'cardTitle']) {
      expect(canRotate(k), k).toBe(false);
    }
  });

  it('keeps the list and the predicate as one thing', () => {
    for (const k of ROTATABLE_ELEMENTS) expect(canRotate(k)).toBe(true);
  });
});

describe('where a dragged rotation lands', () => {
  it('snaps to the angles anybody actually means', () => {
    expect(ROT_SNAP_STEP).toBe(15);
    for (const [raw, want] of [[2, 0], [-3, 0], [43, 45], [47, 45], [88, 90], [178, -180], [-91, -90]] as const) {
      expect(snapAngle(raw), `${raw}`).toBe(want);
    }
  });

  it('leaves an angle alone once it is clear of one', () => {
    // No hysteresis and no magnetism beyond the window: past the threshold the element simply keeps
    // up with the finger. A snap you have to fight your way out of is worse than no snap — the same
    // rule snapAxis() states for the move drag.
    expect(ROT_SNAP_WITHIN).toBe(5);
    for (const raw of [8, 21, 37, 52, -68]) expect(snapAngle(raw), `${raw}`).toBe(raw);
  });

  it('rounds a free angle to the whole degree', () => {
    // What is STORED is radians; the rounding is here so a drag cannot write forty digits of
    // pointer noise into a blob that has a size limit.
    expect(snapAngle(37.4)).toBe(37);
    expect(snapAngle(-52.6)).toBe(-53);
  });

  it('gives zero one name too', () => {
    // Math.round(-3 / 15) is −0, and Object.is(−0, 0) is false — so a nudge anticlockwise back to
    // upright would serialise differently from one clockwise.
    expect(Object.is(snapAngle(-3), 0)).toBe(true);
    expect(Object.is(snapAngle(-0.4), 0)).toBe(true);
  });

  it('gives a half turn exactly one name', () => {
    // +180 and −180 are the same angle and must not serialise as two, or two identical designs
    // compare as different and push a phantom undo step.
    expect(snapAngle(180)).toBe(-180);
    expect(snapAngle(-180)).toBe(-180);
    expect(snapAngle(540)).toBe(-180);
  });

  it('wraps a drag that has been round more than once', () => {
    // A finger can circle the anchor as many times as it likes; the value stays in one turn.
    for (const raw of [0, 45, -45, 179, -179]) {
      expect(snapAngle(raw + 720), `${raw}`).toBe(snapAngle(raw));
      expect(snapAngle(raw - 360), `${raw}`).toBe(snapAngle(raw));
    }
  });
});

describe('a stored line’s rotation', () => {
  it('keeps one a host set', () => {
    expect(readTextItem({ text: 'Hi', rot: 0.7 })!.rot).toBeCloseTo(0.7, 9);
  });

  it('spells upright as ABSENT, never as rot: 0', () => {
    // The same rule the colour keeps, and it matters more here: upright is the default, so writing
    // `rot: 0` onto every restored line would make a poster that has never been turned serialise
    // differently from the one that was saved — which reads as an edit and unlocks every export.
    for (const v of [0, undefined, NaN, 'sideways', null]) {
      expect(readTextItem({ text: 'Hi', rot: v } as unknown), String(v)).not.toHaveProperty('rot');
    }
    expect(JSON.stringify(readTextItem({ text: 'Hi' }))).toBe(JSON.stringify(readTextItem({ text: 'Hi', rot: 0 })));
  });

  it('clamps a stored angle to one turn', () => {
    expect(readTextItem({ text: 'Hi', rot: 99 })!.rot).toBeCloseTo(Math.PI, 9);
    expect(readTextItem({ text: 'Hi', rot: -99 })!.rot).toBeCloseTo(-Math.PI, 9);
  });
});

describe('the card orientation control', () => {
  // The A4 design space the sheet is laid out in, so a card's real shape can be measured rather
  // than asserted. 1080 × 1527 portrait; landscape is the same numbers swapped.
  const W = 1080, H = 1527;
  const SIZES: CardsPerSheet[] = [4, 2, 1];
  const shapeOf = (per: CardsPerSheet, sheetLandscape: boolean) => {
    const sheetW = sheetLandscape ? H : W, sheetH = sheetLandscape ? W : H;
    const { cols, rows } = cardGrid(per, sheetLandscape);
    return { w: sheetW / cols, h: sheetH / rows, cols, rows, sheetW, sheetH };
  };

  it('is the defect: two A5s on a landscape sheet are PORTRAIT cards', () => {
    // The whole report, as geometry. Half a landscape A4 cut down the middle is a portrait A5 —
    // there is no arrangement in which it is not — so a toggle that means "card orientation" at
    // A6 and A4 meant its opposite here.
    const a5 = shapeOf(2, true);
    expect(a5.w).toBeLessThan(a5.h);
    expect(cardLandscapeOn(2, true)).toBe(false);
    // ...while the other two follow the sheet.
    expect(shapeOf(4, true).w).toBeGreaterThan(shapeOf(4, true).h);
    expect(shapeOf(1, true).w).toBeGreaterThan(shapeOf(1, true).h);
  });

  it('now gives the host the card shape they pressed, at every size', () => {
    for (const per of SIZES) {
      for (const want of [true, false]) {
        const sheet = sheetLandscapeFor(per, want);
        const card = shapeOf(per, sheet);
        expect(card.w > card.h, `${per}-up, landscape=${want}`).toBe(want);
      }
    }
  });

  it('still tiles the sheet exactly, all six ways', () => {
    // "A4 halves and quarters exactly, so every size fills the sheet" — with nothing left over and
    // nothing overlapping, which is what makes the cut guides meet the card edges.
    for (const per of SIZES) {
      for (const sheetLandscape of [true, false]) {
        const s = shapeOf(per, sheetLandscape);
        expect(s.cols * s.rows, `${per}/${sheetLandscape}`).toBe(per);
        expect(s.cols * s.w).toBeCloseTo(s.sheetW, 9);
        expect(s.rows * s.h).toBeCloseTo(s.sheetH, 9);
      }
    }
  });

  it('reproduces the grid the sheet used to be laid out with, exactly', () => {
    // The geometry was never the bug, so it must not move: this is the pair of ternaries that were
    // inline before, kept here as the thing cardGrid() has to agree with.
    for (const per of SIZES) {
      for (const L of [true, false]) {
        expect(cardGrid(per, L), `${per}/${L}`).toEqual({
          cols: per === 4 ? 2 : (per === 2 && L ? 2 : 1),
          rows: per === 1 ? 1 : (per === 2 && L ? 1 : 2),
        });
      }
    }
  });

  it('round-trips, so reading the control and writing it cannot disagree', () => {
    for (const per of SIZES) {
      for (const v of [true, false]) {
        expect(cardLandscapeOn(per, sheetLandscapeFor(per, v)), `${per}`).toBe(v);
        expect(sheetLandscapeFor(per, cardLandscapeOn(per, v)), `${per}`).toBe(v);
      }
    }
  });

  it('leaves what PRINTS alone — the sheet is still the stored value', () => {
    // A host may already have printed from a saved design. `cardSheetLandscape` is what reaches
    // `@page { size: A4 … }` and the jsPDF orientation, and a design that is not touched writes the
    // same value it always did: the default, false, is still a portrait sheet.
    expect(sheetLandscapeFor(4, cardLandscapeOn(4, false))).toBe(false);
    expect(sheetLandscapeFor(2, cardLandscapeOn(2, false))).toBe(false);
    expect(sheetLandscapeFor(1, cardLandscapeOn(1, false))).toBe(false);
  });

  it('says what you get in card shapes, and where the scissors go', () => {
    expect(cardShapeNote(2, true)).toBe('Two landscape A5 cards, cut across the middle.');
    expect(cardShapeNote(2, false)).toBe('Two portrait A5 cards, cut down the middle.');
    expect(cardShapeNote(4, true)).toBe('Four landscape A6 cards.');
    expect(cardShapeNote(4, false)).toBe('Four portrait A6 cards.');
    expect(cardShapeNote(1, true)).toBe('One landscape A4 card — the whole sheet.');
    expect(cardShapeNote(1, false)).toBe('One portrait A4 card — the whole sheet.');
  });

  it('describes the cut the sheet really makes', () => {
    // The note has to agree with cardGrid, or it is telling a host to cut the wrong way: two cards
    // side by side are separated by a vertical cut, two stacked by a horizontal one.
    for (const card of [true, false]) {
      const { cols } = cardGrid(2, sheetLandscapeFor(2, card));
      expect(cardShapeNote(2, card)).toContain(cols === 2 ? 'down the middle' : 'across the middle');
    }
  });
});

describe('one design, or one per card', () => {
  type L = { title: { x: number; y: number; size: number } };
  const look = (tag: string): CardLook<L> =>
    ({ cTitle: `#${tag}`, cBody: '', cCode: '', cBg: '', layout: { title: { x: 0.5, y: 0.17, size: 34 } } });
  const base = look('aaaaaa');
  const bOwn = look('bbbbbb');
  const of = (o: Partial<Parameters<typeof cardLookFor<L>>[0]>) =>
    cardLookFor<L>({ oneDesign: true, base, sets: {}, key: 'a', baseKey: 'a', ...o });

  it('is the compatibility guarantee: one design hands back the base ITSELF', () => {
    // `toBe`, not `toEqual`. Every design saved before per-card existed carries no overrides and no
    // toggle, so it reads as one design — and every card then resolves to the identical object the
    // renderer has always been handed, which is what makes "renders byte-identically" a property of
    // the code rather than a hope about the arithmetic.
    for (const key of ['a', 'b', 'c', null]) {
      expect(of({ oneDesign: true, sets: { b: bOwn }, key }), String(key)).toBe(base);
    }
  });

  it('the first card IS the base, and cannot have a look of its own', () => {
    // Otherwise "↺ Same as Card A" would be comparing A against an invisible fourth thing.
    expect(of({ oneDesign: false, sets: { a: look('cccccc') }, key: 'a', baseKey: 'a' })).toBe(base);
    expect(isBaseCard('a', 'a')).toBe(true);
    expect(isBaseCard('b', 'a')).toBe(false);
  });

  it('a card with no look of its own follows the base', () => {
    // Absent means inherit — the same convention the poster's optional inks use. Not "a copy of A
    // taken at the time", which would look identical and then stop tracking the moment A changed.
    expect(of({ oneDesign: false, sets: { c: look('dddddd') }, key: 'b', baseKey: 'a' })).toBe(base);
  });

  it('a card that HAS one gets it', () => {
    expect(of({ oneDesign: false, sets: { b: bOwn }, key: 'b', baseKey: 'a' })).toBe(bOwn);
  });

  it('one design overrules every override, without deleting any of them', () => {
    // Flipping the toggle back on must not throw the host's per-card work away: it is a mode, not a
    // migration, and flipping it off again has to bring the cards back as they were.
    const sets = { b: bOwn };
    expect(of({ oneDesign: true, sets, key: 'b', baseKey: 'a' })).toBe(base);
    expect(of({ oneDesign: false, sets, key: 'b', baseKey: 'a' })).toBe(bOwn);
    expect(sets.b).toBe(bOwn);
  });

  it('survives an event with no trick list at all', () => {
    // There is no card, so there is nothing for a per-card look to be about.
    expect(of({ oneDesign: false, sets: { b: bOwn }, key: null, baseKey: null })).toBe(base);
    expect(isBaseCard(null, null)).toBe(true);
  });

  it('falls back rather than failing on a key that no longer exists', () => {
    // The trick list is edited elsewhere: a set can be renamed or deleted while a design still
    // carries an override keyed to it. The card prints in the base look, which is the same thing it
    // printed before per-card existed.
    expect(of({ oneDesign: false, sets: { gone: bOwn }, key: 'b', baseKey: 'a' })).toBe(base);
  });
});
