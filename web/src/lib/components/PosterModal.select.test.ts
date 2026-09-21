// The selected element's controls, and the selection model underneath them.
//
// The host's report was "the text edit box opening on the poster on click is annoying, I think
// clicking it you should see an edit pencil to open in" — plus exclusive selection, a ✕ per element
// to let go, and a bin whose meaning depends on the element.
//
// All of this is a fact about MARKUP and about the ORDER of statements in one 3900-line function, so
// no test of a helper can see any of it come back. It reads the component's own source, the way the
// colour, nav and history tests do.
/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import SRC from './PosterModal.svelte?raw';
import CTL from './PosterElControls.svelte?raw';
import { binActionFor, cardBinActionFor } from '$lib/posterFlow';

const SCRIPT = SRC.slice(0, SRC.indexOf('</script>'));
/** Just the template, with comments gone — a rule that only holds in a comment does not hold. */
const MARKUP = SRC
  .slice(SRC.indexOf('</script>'), SRC.lastIndexOf('<style>'))
  .replace(/<!--[\s\S]*?-->/g, '');
const STYLE = SRC.slice(SRC.lastIndexOf('<style>')).replace(/\/\*[\s\S]*?\*\//g, '');
const CTL_MARKUP = CTL.slice(CTL.indexOf('</script>'), CTL.lastIndexOf('<style>')).replace(/<!--[\s\S]*?-->/g, '');
const CTL_STYLE = CTL.slice(CTL.lastIndexOf('<style>')).replace(/\/\*[\s\S]*?\*\//g, '');

/** One function's body, brace-matched from its declaration. */
function body(src: string, decl: string): string {
  const i = src.indexOf(decl);
  expect(i, decl).toBeGreaterThan(-1);
  const open = src.indexOf('{', i);
  let d = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
  throw new Error(`unbalanced: ${decl}`);
}
/** ...with its comments gone. */
const code = (src: string, decl: string) =>
  body(src, decl).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('a tap selects; the pencil opens the editor', () => {
  const tap = code(SCRIPT, 'function tapElement(');

  it('no longer opens the editor on the first tap of an element', () => {
    // The whole complaint. Selection happens at pointerdown, so by the time this click runs the
    // element is already selected either way — `tapHeld` is what tells a FIRST tap from a second.
    expect(tap).toContain('tapHeld !== key');
  });

  it('still refuses after a drag, through the SAME `tapped` flag as before', () => {
    // Not a second tap detector: the click that arrives after a drag is the tail of the gesture
    // that just moved the element, and opening a keyboard then covers what was being positioned.
    expect(tap).toContain('!tapped');
    expect(SCRIPT).toContain('tapped = !live && !pinch;');
    expect(SCRIPT).toContain('tapHeld = wasSelected;');
  });

  it('opens the editor from the cluster’s pencil', () => {
    expect(MARKUP).toContain('onEdit={() => void openEditor(');
    expect(CTL_MARKUP).toMatch(/class="ec-b"[^>]*on:click\|stopPropagation=\{onEdit\}/);
  });

  it('does not snapshot undo merely for opening an editor', () => {
    // Opening a text box changes nothing. It used to push a step every time, so looking at a field
    // put a no-op on the stack; the typing that follows is coalesced by the history watcher, which
    // is what that is for.
    expect(code(SCRIPT, 'async function openEditor(')).not.toContain('pushUndo');
  });

  it('gives a host’s OWN line a pencil too', () => {
    // The one element they typed themselves would otherwise be the only one without one.
    expect(SCRIPT).toContain('function editSpecOf(');
    expect(code(SCRIPT, 'function editSpecOf(')).toContain('textIdx(key)');
    expect(MARKUP).toContain('on:click={() => tapElement(`text:${i}`)}');
  });

  it('still refuses the footer, the mark and the QR', () => {
    // The footer is the join URL (not the host's to write), the mark is fixed wording, the QR is an
    // image. None of them may acquire an editor by the back door.
    const spec = code(SCRIPT, 'function editSpecOf(');
    for (const k of ['footer', 'brand', "'qr'"]) expect(spec, k).not.toContain(k);
  });
});

describe('exclusive selection', () => {
  const drag = code(SCRIPT, 'function dragOn(');

  it('asks pressRole() rather than selecting whatever was pressed', () => {
    expect(drag).toContain('pressRole(wasSelected, key)');
    // One bypass, and it is not an exception to the rule so much as an instance of it: a stage
    // pinch is not claiming anything, so it takes the standing of a REFUSED press — the one path
    // already built to carry a second finger without selecting or moving what it landed on.
    expect(drag).toContain("const role = pinchOnly ? 'pinch' : pressRole(wasSelected, key);");
  });

  it('lets a SECOND tap on the refused element take the selection', () => {
    // The only thing allowed to overrule pressRole, and only for the element it just turned down,
    // within the window. Anything looser and exclusive selection is not exclusive.
    expect(drag).toMatch(/lastRefused\?\.key === key && Date\.now\(\) - lastRefused\.at < REFUSE_SWITCH_MS/);
    expect(drag).toContain('if (again) surf.select(key);');
  });

  it('decides the switch at the RELEASE, never at the press', () => {
    // Deciding at pointerdown broke pinching: the first finger of a pinch lands on whatever box is
    // under it, so the press after any refused tap swapped the selection mid-gesture and the wrong
    // element got scaled. pressRole's verdict must therefore be final for the whole press.
    expect(drag).toContain("const role = pinchOnly ? 'pinch' : pressRole(wasSelected, key);");
    const down = drag.slice(0, drag.indexOf('const onUp ='));
    expect(down).not.toContain("role = 'take'");
    expect(down).not.toContain('REFUSE_SWITCH_MS');
  });

  it('teaches that gesture from the UP of a refused TAP, never from the press', () => {
    // The first finger of a pinch routinely lands on some other element's box. Toasting at
    // pointerdown would fire on nearly every pinch; by pointerup we know it stayed a tap.
    // `!pinchOnly` matters as much as the rest: a stage pinch is refused by construction, and its
    // second finger starts a gesture that ends looking exactly like a refused tap — so finishing a
    // pinch fired the hint, offering a switch to the element already selected.
    expect(drag).toMatch(/role === 'pinch' && !pinchOnly && !live && !pinch/);
    // showHINT, not showToast: it is an instruction, it fires under the finger that caused it, and
    // it has to compete with the element still being held. See the `hint` kind in $lib/toast.
    expect(drag).toContain("showHint('Double-tap to switch to this one, or ✕ to clear the selection')");
  });

  it('only selects when the press is allowed to take the selection', () => {
    expect(drag).toContain("if (role === 'take') surf.select(key);");
    // ...and never unconditionally, which is what it used to do.
    expect(drag).not.toMatch(/surf\.dragging\(key\);\s*surf\.select\(key\);/);
  });

  it('refuses to MOVE an element the press may not take', () => {
    expect(drag).toContain("if (role !== 'take') return;");
  });

  it('still sets the drag flag regardless, so touch-action lands before the second finger', () => {
    // `.poster-stage.dragging` is what stops the browser claiming a pinch as a page zoom, and
    // preventDefault() on pointerdown does not — pointer events leave that to touch-action alone.
    // So it is still unconditional; what changed is WHICH key it names.
    expect(drag).toContain('surf.dragging(');
    expect(drag).not.toMatch(/if \([^)]*\)\s*surf\.dragging\(/);
  });

  it('names the HELD element on a refused press, so nothing else lights up', () => {
    // `.el-box.active` follows the drag key. Passing the pressed key highlighted an element the
    // press was never allowed to pick up — a promise the gesture could not keep.
    expect(drag).toContain("surf.dragging(role === 'take' ? key : wasSelected ?? key);");
  });

  it('a pinch scales without translating', () => {
    // Two fingers never land together; in the gap the first has usually dragged the element past
    // the dead zone. A pinch puts that back and stops the move for the rest of the gesture.
    expect(drag).toContain('surf.move(key, box0.x, box0.y)');
    expect(drag).toMatch(/live && pinchKey === key && mode === 'move'/);
  });

  it('hides the resize grip on a touch screen, where the pinch replaces it', () => {
    expect(STYLE).toMatch(/@media \(pointer: coarse\)\s*\{[^@]*\.el-rz\s*\{\s*display: none;/);
    // The ROTATE handle must survive: there is no two-finger rotate, so it is the only way to turn
    // anything on a phone.
    expect(STYLE).not.toMatch(/@media \(pointer: coarse\)\s*\{[^@]*\.el-rot\s*\{\s*display: none;/);
  });

  it('refuses a pinch that could only size a foreign element', () => {
    // Something is held but cannot be scaled. Falling through would pinch whatever the first finger
    // happened to land on. (The brand mark used to be the example; it is resizable now, so this
    // guards the rule rather than any particular element.)
    //
    // `!pinchOnly` is not a hole in it: a stage pinch passes the SELECTED key as `key`, so there is
    // no foreign element in the picture and nothing to fall through to. startStagePinch has already
    // checked the same resizable() this branch exists to enforce.
    expect(drag).toContain("} else if (role === 'pinch' && !pinchOnly) {");
  });

  it('lets a pinch start on blank stage, on the held element and nothing else', () => {
    // A pinch could only begin INSIDE the element it was scaling, because the gesture core is only
    // reachable from an element's own box. Fine for a title, useless for the trick list, where the
    // region you may start in is not the region you are trying to resize.
    const sp = code(SCRIPT, 'function startStagePinch(');
    expect(sp).toContain("if (e.pointerType !== 'touch') return;");   // a mouse has no second finger
    // Blank stage ONLY. The element controls (cog, bin, ✕, pencil) are children of the stage and do
    // not stop propagation, so without this a press on the cog started a pinch over the top of it:
    // dragOn's preventDefault() ate the click, so the cog no longer scrolled to its section, and the
    // gesture ended looking like a refused tap, so it fired the double-tap hint too.
    expect(sp).toContain("if (t !== surf.stage() && t?.tagName !== 'CANVAS') return;");
    expect(sp).toContain('const sel = selectedOn(surf);');
    // Never guesses a target, and never offers to scale something that cannot be scaled.
    expect(sp).toMatch(/if \(!sel \|\| !\(surf\.resizable\?\.\(sel\) \?\? true\)\) return;/);
    expect(sp).toContain("dragOn(surf, sel, 'move', e, true)");
    // And only one at a time — the second finger lands on blank stage too.
    expect(sp).toContain('!== null) return;');
    // Both stages carry it, and both go touch-action:none while something is held — the browser
    // decides a pinch is a page zoom before the second finger is reportable, so it cannot be set
    // in reaction to that finger.
    expect(MARKUP).toContain('startStagePinch(posterSurface, e)');
    expect(MARKUP).toContain('startStagePinch(cardSurface, e)');
    expect(MARKUP).toContain('class:holding={!!selectedKey}');
    expect(MARKUP).toContain('class:holding={!!cardSelectedKey}');
    expect(STYLE).toContain('.poster-stage.holding { touch-action: none; }');
  });

  it('lets a swipe that starts on an unselected element scroll the panel', () => {
    // Two halves, and BOTH are needed. The press handler stopped a swipe from dragging the element
    // (selectOnly), but the box still carried a permanent touch-action:none, so the browser had
    // already been told this box does not scroll — the finger dragged over a dead box instead.
    // touch-action is the only thing that decides this; preventDefault cannot hand scrolling back.
    expect(STYLE).toMatch(/\.el-box \{[^}]*touch-action: pan-y;/);
    expect(STYLE).toContain('.el-box.selected { touch-action: none; }');
    // The JS half: on touch, the first press only selects, and does it at the RELEASE so a swipe
    // that travelled is not also a selection.
    expect(drag).toContain("const selectOnly = e.pointerType === 'touch' && mode === 'move' && role === 'take' && !armed;");
    expect(drag).toContain('if (selectOnly && !movedFar) surf.select(key);');
    // ...and takes neither preventDefault nor the dragging state, which is what applies
    // touch-action: none to the stage.
    expect(drag).toMatch(/if \(!selectOnly\) \{\s*e\.preventDefault\(\);/);
  });

  it('gives the selected element a cog into its own controls', () => {
    expect(CTL_MARKUP).toContain('onSettings');
    expect(MARKUP).toContain('onSettings={posterElStep(selectedEl.key) === null');
    expect(MARKUP).toContain('onSettings={cardElStep(cardSelectedElControls.key) === null');
  });

  it('reads the step off the SAME table the colour dots use, not a second copy', () => {
    // A private map here would drift from the one deciding where a colour control is drawn, and the
    // cog would start landing on a step that does not hold the thing it promised.
    const step = code(SCRIPT, 'const posterElStep =');
    expect(step).toContain('POSTER_COLOR_STEP[key as PosterColorTarget]');
    expect(code(SCRIPT, 'const cardElStep =')).toContain('CARD_COLOR_STEP');
  });

  it('lets go of the element, then leaves the landing to the step functions', () => {
    const show = code(SCRIPT, 'async function showElSettings(');
    expect(show).toContain('releaseSelection()');
    // Nothing to go to means no cog at all, rather than one that leads somewhere unrelated.
    expect(show).toContain('if (step === null) return;');
    // FORCED, because a cog is a direct request for one element's settings and not a strip press
    // meaning "skip ahead". Gated, it was a control that ate the press and did nothing at all —
    // press the QR cog on step 1 of a fresh poster and the jump failed the maxReached check
    // silently. (An unfilled requirement still wins; goPStep returns on that branch first.)
    expect(show).toContain('goPStep(step, true, ring)');
    expect(show).toContain('goCStep(step, true, ring)');
    // And it says WHICH element, so the ring lands on that element's own group of controls rather
    // than on the step's question. A step holds several elements' worth: ringing the question
    // answers "where am I" and not "which of these is yours", which is what the cog was asked.
    expect(show).toContain('[data-el-settings=');
    expect(MARKUP).toContain('data-el-settings="steps"');   // the How-to line that reported it
    expect(MARKUP).toContain('data-el-settings="title"');
    // Falls back rather than ringing nothing when an element has no group of its own.
    const arrive = code(SCRIPT, 'async function arriveAtStep(');
    expect(arrive).toContain(".editor .p-ask");
    // And it must NOT land it a second time here. goPStep/goCStep already call arriveAtStep(true),
    // which puts the step strip at the top and rings the question. Doing it again broke both
    // halves: flashCard clears the previous ring by design, so the second call cancelled the useful
    // one — and what it ringed instead was `.editor`, the entire panel, which reads as nothing at
    // all. .pf-flash also carries z-index 2, so ringing the panel lifted the whole scrolling column
    // over the sticky header for as long as the animation ran.
    expect(show).not.toContain('flashCard(');
    expect(show).not.toContain(".querySelector('.editor')");
  });

  it('no longer lets a press on the stage background deselect', () => {
    // Both stages. The controls a host reaches for are mostly BELOW the preview, and a tap that
    // clipped the stage on the way would drop the selection they were about to use.
    expect(MARKUP).not.toContain('on:pointerdown|self={() => (selectedKey = null)}');
    expect(MARKUP).not.toContain('on:pointerdown|self={() => (cardSelectedKey = null)}');
  });

  it('leaves the modal’s backdrop dismissal exactly as it was', () => {
    // A selection is ephemeral view state on an auto-saved design, not work in flight — unlike the
    // open editor, whose blur fires on the press, which is why THAT blocks a dismiss. Making a
    // selection block it too would make the backdrop feel broken.
    expect(SCRIPT).toContain('blockedByEditor: downWithEditor,');
    expect(code(SCRIPT, 'function onBackClick(')).not.toContain('selectedKey');
  });

  it('releases only through the ✕ or Escape', () => {
    expect(SCRIPT).toContain('function releaseSelection()');
    const rel = code(SCRIPT, 'function releaseSelection()');
    expect(rel).toContain('selectedKey = null;');
    expect(rel).toContain('cardSelectedKey = null;');
    expect(MARKUP).toContain('onRelease={releaseSelection}');
  });
});

describe('Escape still peels one layer at a time', () => {
  const kd = code(SCRIPT, 'function onKeydown(');

  it('delegates the ORDER to escapeLayer(), where it can be tested', () => {
    // It was a ladder of early returns, which is fine until a layer has to be added in the middle —
    // which is exactly what a selected element is.
    expect(kd).toContain('switch (escapeLayer({');
  });

  it('feeds it every layer, including both surfaces’ selections', () => {
    for (const f of ['binArmed:', 'restyleArmed,', 'resetArmed,', 'editing:', 'selected:', 'fullScreen:']) {
      expect(kd, f).toContain(f);
    }
    expect(kd).toContain('selectedKey !== null || cardSelectedKey !== null');
  });

  it('handles every layer the helper can return, and closes only on the default', () => {
    for (const c of ['bin', 'restyle', 'reset', 'editor', 'selection', 'fullscreen']) {
      expect(kd, c).toContain(`case '${c}':`);
    }
    expect(kd).toContain("default: dispatch('close'); return;");
  });
});

describe('the bin', () => {
  const press = code(SCRIPT, 'function pressBin(');
  const applyP = code(SCRIPT, 'function applyPosterBin(');
  const applyC = code(SCRIPT, 'function applyCardBin(');

  it('arms, then confirms — it does not fire on one press', () => {
    expect(press).toContain('if (binArmed !== key) { binArmed = key; return; }');
  });

  it('disarms the header’s two confirms when it arms, as they do to each other', () => {
    expect(press).toContain('restyleArmed = false; resetArmed = false;');
  });

  it('disarms on a click anywhere else, like the other two', () => {
    expect(MARKUP).toContain('binArmed = null; }');
    expect(MARKUP).toMatch(/on:click=\{\(\) => \{ restyleArmed = false; resetArmed = false; binArmed = null; \}\}/);
  });

  it('stops its own arming press from immediately disarming it', () => {
    // The window handler above would otherwise see the press that armed it.
    expect(CTL_MARKUP).toMatch(/on:click\|stopPropagation=\{onBin\}/);
  });

  it('pushes undo BEFORE it mutates anything', () => {
    const undo = press.indexOf('pushUndo(JSON.stringify(cfg));');
    const mutate = Math.min(
      ...['applyCardBin(key)', 'applyPosterBin(key)'].map((s) => press.indexOf(s)).filter((n) => n > -1),
    );
    expect(undo).toBeGreaterThan(-1);
    expect(mutate).toBeGreaterThan(undo);
    // ...and closes any open typing burst first, so the bin is its own step rather than joining one.
    expect(press.indexOf('commitBurst();')).toBeLessThan(undo);
  });

  it('lets go of the selection afterwards, so nothing outlines empty space', () => {
    // A cleared fixture drops out of `elements`; its outline and its cluster would be left hanging
    // beside a blank line, which reads as a fault.
    //
    // Asserted as the LAST statement of the function, not merely as text appearing after the
    // mutation: an early `return` between the two would leave the call sitting there, unreachable,
    // and an ordering check reads that as a pass. This is the strongest thing a source-text test can
    // say about reachability — nothing may stand between the mutation and the release.
    const tail = press.slice(press.indexOf('applyPosterBin(key)'));
    expect(tail).toContain('releaseSelection();');
    expect(tail.slice(0, tail.indexOf('releaseSelection();'))).not.toContain('return');
    expect(press.trimEnd().endsWith('releaseSelection();\n  }')).toBe(true);
  });

  it('performs exactly the elements posterFlow says have a bin, and no others', () => {
    // The verb lives in $lib/posterFlow and the mutation lives here, which is what lets the two sit
    // in different files. This is the seam: a key added to one and forgotten in the other.
    const KEYS = ['brand', 'title', 'message', 'steps', 'qr', 'footer', 'names', 'text:0', 'decor:0'];
    for (const k of KEYS) {
      const has = binActionFor(k) !== null;
      if (k.startsWith('text:')) { expect(applyP, k).toContain('textIdx(key)'); continue; }
      if (k.startsWith('decor:')) { expect(applyP, k).toContain('decorIdx(key)'); continue; }
      expect(applyP.includes(`case '${k}':`), `${k} has=${has}`).toBe(has);
    }
    for (const k of ['title', 'qr', 'message']) {
      expect(applyC.includes(`case '${k}':`), `card ${k}`).toBe(cardBinActionFor(k) !== null);
    }
  });

  it('clears a fixture’s words without touching its position or its colour', () => {
    // Re-typing brings the design back rather than starting the element over.
    for (const s of ["case 'message': message = '';", "case 'steps': stepsText = '';", "case 'names': names = '';"]) {
      expect(applyP, s).toContain(s);
    }
    expect(applyP).not.toContain('layout');
    expect(applyP).not.toMatch(/cMessage|cSteps|cNames/);
  });

  it('toggles the two toggle-backed elements off rather than clearing anything', () => {
    expect(applyP).toContain("case 'brand': showBrand = false;");
    expect(applyP).toContain("case 'footer': showFooterUrl = false;");
  });

  it('takes the card’s whole join block, both switches', () => {
    expect(applyC).toContain('cardShowQr = false; cardShowLink = false;');
  });

  it('never wires itself to the QR panel switch', () => {
    // `qrPanel` governs the white card behind the code, and it is force-restored whenever contrast
    // is too low — a bin on it would visibly do nothing on every design over a photo.
    expect(applyP).not.toContain('qrPanel');
  });

  it('shows it is armed by COLOUR alone, so nothing moves between the two presses', () => {
    // The header's confirms stack two labels so the button cannot jump wider under the finger. A
    // 44px chip has no room for a word, so the armed state changes only paint.
    const armed = CTL_STYLE.slice(CTL_STYLE.indexOf('.ec-b.bin.armed .ec-i'));
    const rule = armed.slice(0, armed.indexOf('}') + 1);
    expect(rule).toMatch(/background|border-color|color/);
    for (const prop of ['width', 'height', 'padding', 'font-size', 'border-width']) {
      expect(rule, prop).not.toContain(`${prop}:`);
    }
    expect(rule).toContain('--danger');
  });
});

describe('the element’s ✕ is not the modal’s ✕', () => {
  it('lives on the canvas, not in the header', () => {
    // The modal's is a bare muted glyph in the sticky header; this one is a filled chip pinned to
    // the element and moving with it.
    expect(MARKUP).toContain('<button class="x" on:click={() => dispatch(\'close\')} aria-label="Close">✕</button>');
    expect(CTL_MARKUP).toContain('class="ec-b done"');
  });

  it('says what it closes, rather than "Close"', () => {
    expect(CTL_MARKUP).toContain('aria-label="Done with {label}"');
    expect(CTL_MARKUP).not.toContain('aria-label="Close"');
  });

  it('is a different size and a different ground', () => {
    const x = STYLE.slice(STYLE.indexOf('.x {'));
    expect(x.slice(0, x.indexOf('}'))).toContain('background: none');
    expect(CTL_STYLE).toContain('.ec-b.done .ec-i { background: var(--accent-fill)');
  });

  it('keeps every chip on a 44px target', () => {
    // Operated one-handed, at a party. The 30px is the chip that is DRAWN; the target is the button.
    const b = CTL_STYLE.slice(CTL_STYLE.indexOf('.ec-b {'));
    const rule = b.slice(0, b.indexOf('}'));
    expect(rule).toContain('width: 44px');
    expect(rule).toContain('height: 44px');
  });

  it('omits a control rather than disabling one', () => {
    // A disabled button consumes no events: the tap falls through to the poster behind it and a
    // phone answers with its own Copy/Search menu. Nothing here is ever disabled — the pencil and
    // the bin are simply absent on an element they do not apply to.
    expect(CTL_MARKUP).toMatch(/\{#if canEdit\}/);
    expect(CTL_MARKUP).toMatch(/\{#if binText\}/);
    expect(CTL_MARKUP).not.toMatch(/\sdisabled[=>\s]/);
    expect(CTL_MARKUP).not.toContain('aria-disabled');
  });
});

describe('one cluster, and it cannot outline nothing', () => {
  const sel = code(SCRIPT, '$: selectedEl =');

  it('is rendered ONCE per stage rather than per element', () => {
    // Exclusive selection is what makes that possible: three copies of a control cluster, one on
    // each element loop, would be two chances for one of them to drift.
    expect(MARKUP.split('<PosterElControls').length - 1).toBe(2);   // the poster stage and the card stage
  });

  it('refuses a key with no footprint', () => {
    expect(sel).toContain('if (!r || r.w <= 0 || r.h <= 0) return null;');
  });

  it('refuses a fixture that has been cleared out of `elements`', () => {
    // An empty message still MEASURES — bounds asks for `message || ' '`, a single space — so a
    // rect is not proof the element is on the poster.
    expect(sel).toContain('const el = elements.find((x) => x.key === k);');
    expect(sel).toContain('if (!el) return null;');
  });

  it('refuses a host’s line or a motif that has gone', () => {
    expect(sel).toContain('if (!textItems[t]) return null;');
    expect(sel).toContain('if (!it) return null;');
  });

  it('names every dependency syntactically', () => {
    // `$:` does not track state read inside a called function, and all of these are.
    expect(sel).toContain('dep(allRects, textItems, decorItems, elements, layout);');
  });

  it('does not let the poster’s editor map answer for the card’s title', () => {
    // Both surfaces have an element keyed 'title'. A cluster that asked editSpecOf() itself would
    // put a pencil on the card's title that typed into the poster's headline.
    expect(code(SCRIPT, '$: cardSelectedElControls =')).toContain('cardBinActionFor(k), false)');
  });

  it('gets out of the way of the editor and of a drag', () => {
    expect(MARKUP).toContain('{#if selectedEl && !editingKey && !dragKey}');
    expect(MARKUP).toContain('{#if cardSelectedElControls && !cardDragKey}');
  });
});

describe('undo is armed at pointerdown and pushed at the first change', () => {
  const drag = code(SCRIPT, 'function dragOn(');

  it('no longer snapshots merely because something was pressed', () => {
    // It used to push unconditionally at pointerdown, so a tap that only selected added a no-op
    // step AND set `designEdited` — the flag that unlocks persist() and every export on a poster
    // nobody had edited. Under tap-to-select that fires on every selection.
    expect(drag).not.toMatch(/commitBurst\(\);\s*pushUndo\(JSON\.stringify\(cfg\)\);\s*e\.preventDefault/);
    expect(drag).toContain('const snap0 = JSON.stringify(cfg);');
  });

  it('still commits the open burst before pushing, in that order', () => {
    const arm = code(drag, 'const armUndo = () =>');
    expect(arm.indexOf('commitBurst();')).toBeLessThan(arm.indexOf('pushUndo(snap0);'));
  });

  it('pushes once per gesture, so a whole drag is still ONE step', () => {
    const arm = code(drag, 'const armUndo = () =>');
    expect(arm).toContain('if (undoPushed) return;');
  });

  it('arms before every mutation the drag can make', () => {
    // A move, a grip resize, and a pinch. Miss one and that gesture is not undoable.
    for (const m of ['armUndo();\n          surf.move(', 'armUndo();\n          surf.size(key,', 'armUndo();\n        surf.size(pinchKey,']) {
      expect(drag.includes(m.replace(/\s+/g, ' ')) || drag.replace(/\s+/g, ' ').includes(m.replace(/\s+/g, ' ')), m).toBe(true);
    }
  });

  it('leaves the onMount history fix alone', () => {
    // Undo wiping a saved poster is live data loss; five production events have saved designs. This
    // duplicates PosterModal.history.test.ts on purpose — the file's own note says two separate
    // pieces of later work have edited within a few lines of it, and this is a third.
    const onMount = SCRIPT.slice(SCRIPT.indexOf('onMount(() => {'), SCRIPT.indexOf('onDestroy(('));
    const b = onMount.replace(/\/\/[^\n]*/g, '');
    // Anchored before being ordered. indexOf yields -1 on a miss and -1 precedes every real
    // index, so deleting the flag assignment satisfied "the flag is set before restore runs" —
    // the assertion passed precisely because the thing it is about had gone.
    const flagAt = b.indexOf('applyingHistory = true;');
    const restoreAt = b.indexOf('restore();');
    expect(flagAt, 'the guard flag must be set at all').toBeGreaterThan(-1);
    expect(restoreAt, 'and restore() must still be called').toBeGreaterThan(-1);
    expect(flagAt).toBeLessThan(restoreAt);
    expect(b.indexOf('restore();')).toBeLessThan(b.indexOf('void tick().then(() => { applyingHistory = false; });'));
    expect(b).not.toContain('prevCfg');
  });

  it('keeps the cluster’s session state out of the saved design', () => {
    // binArmed, tapHeld and the cluster itself are view state. In cfg they would look like an edit
    // to the history watcher and make undo live on a design nobody touched.
    const cfg = SCRIPT.slice(SCRIPT.indexOf('  $: cfg = {'), SCRIPT.indexOf('};', SCRIPT.indexOf('  $: cfg = {')));
    for (const k of ['binArmed', 'tapHeld', 'selectedEl', 'selectedKey', 'editingKey']) {
      expect(cfg, k).not.toContain(k);
    }
  });
});

describe('the Place step is gone, and its warning is not', () => {
  it('leaves the poster flow five steps', () => {
    expect(SCRIPT).toContain('const P_LAST = 5;');
    const titles = /const P_TITLES = \[([^\]]*)\]/.exec(SCRIPT)?.[1] ?? '';
    expect(titles.split(',').length).toBe(5);
    expect(titles).not.toContain('Place');
  });

  it('keeps P_TITLES and P_ASK the same length, so no step is asked a blank question', () => {
    const titles = (/const P_TITLES = \[([^\]]*)\]/.exec(SCRIPT)?.[1] ?? '').split(',').length;
    const askBlock = SCRIPT.slice(SCRIPT.indexOf('const P_ASK = ['), SCRIPT.indexOf('];', SCRIPT.indexOf('const P_ASK = [')));
    const asks = (askBlock.replace(/\/\/[^\n]*/g, '').match(/'/g) ?? []).length / 2;
    expect(asks).toBe(titles);
  });

  it('has no step block left that keys off P_LAST', () => {
    // The retired block was the only `pStep === P_LAST` gate; the last step is now 5 like the rest.
    expect(MARKUP).not.toContain('pStep === P_LAST');
  });

  it('drops the duplicate full-screen button and keeps the header’s', () => {
    // One setting, one control: ⛶ Arrange is in the header on this tab.
    expect(MARKUP).not.toContain('⛶ Full-screen arrange');
    expect(MARKUP).toContain('fsEdit = !fsEdit');
  });

  it('shows the QR-too-small warning on EVERY step, not one they can skip', () => {
    // The one unrecoverable failure in the product: fifty printed cards nobody can scan. The QR is
    // resized by dragging or pinching it, which a host can do from any step.
    const i = MARKUP.indexOf('{#if qrTooSmall}<p class="warn-note">');
    expect(i).toBeGreaterThan(-1);
    // It sits directly under the step question, which is outside every `pStep ===` gate.
    const before = MARKUP.slice(MARKUP.indexOf('{#if pGuided}<p class="p-ask">{P_ASK[pStep - 1]}</p>{/if}'), i);
    expect(before).not.toContain('pStep ===');
  });

  it('still latches pSeenLast at the new last step', () => {
    // It gates the Print tab. A step that no longer exists must not leave it permanently false.
    expect(SCRIPT).toContain('$: if (pStep >= P_LAST) pSeenLast = true;');
  });
});

describe('the copy says what happens', () => {
  it('has no trade jargon left in the names hint', () => {
    for (const j of ['lockup', 'hairline', 'joiner', 'in script', 'tracked caps']) {
      expect(MARKUP.toLowerCase(), j).not.toContain(j);
    }
  });

  it('dropped the orphaned hint about a title set as two parts', () => {
    // It sat under the host's own lines while the fields it described were 140 lines up, and it
    // explained why a designer likes an effect rather than saying what the control does.
    expect(MARKUP).not.toContain('read as designed rather than as typed');
  });

  it('names the web address rather than where it starts out', () => {
    // `footer` is draggable, so "along the bottom" was wrong the moment anyone moved it.
    expect(MARKUP).not.toContain('Show the link along the bottom');
    expect(MARKUP).toContain('Show the web address');
  });

  it('does not tell a host designing a QR poster what a QR code is for', () => {
    expect(SCRIPT).not.toContain('Guests scan it to join.');
  });

  it('says the same thing on every tab’s foot line', () => {
    const foot = code(SCRIPT, '$: footHint =');
    expect((foot.match(/Changes save automatically\./g) ?? []).length).toBe(4);
  });

  it('teaches the new gesture where the elements are, on both surfaces', () => {
    expect(MARKUP).not.toContain('Tapping it on the preview edits it too');
    expect((MARKUP.match(/to let go/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('the panel’s own rows line up', () => {
  it('gives the colour swatch on a host’s line the row’s height', () => {
    // A native input[type=color] brings its own intrinsic box from the UA stylesheet, which won
    // over the row's `align-items: stretch` and left it shorter than the field beside it.
    const r = STYLE.slice(STYLE.indexOf('.dlist li > input.d-col {'));
    const rule = r.slice(0, r.indexOf('}'));
    expect(rule).toContain('align-self: stretch');
    expect(rule).toContain('height: auto');
    // The SAME 44px the field takes from the shared rule, not a number picked to match it today.
    expect(rule).toContain('min-height: 44px');
  });

  it('keeps the selector shape that beats `.fld input`', () => {
    // One class loses to `.fld input`, and losing means inheriting its `width: 100%` — the
    // full-width colour bar that shipped once already.
    expect(STYLE).toContain('.dlist li > input.d-col {');
  });

  it('lays the decoration and motif TYPE rows out as an even grid', () => {
    expect(STYLE).toContain('.chip-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));');
    // All three of them: the cards tab's kinds, the poster's kinds, and the motif to place. Both
    // tabs render the same set, and two layouts of one list is the inconsistency.
    expect(MARKUP.split('class="chip-grid"').length - 1).toBe(3);
  });

  it('leaves the three-item position row as a flex row', () => {
    // Three short words are already even, and in a two-column grid the third sits alone by a gap.
    const pos = MARKUP.slice(MARKUP.indexOf('Where it sits'));
    expect(pos.slice(0, 200)).toContain('class="bg-row"');
  });
});
