// Turning an element on the poster.
//
// The renderer's half is pinned in posterRender.test.ts (the transform really is applied, and it is
// applied per element) and the rules are pinned in posterFlow.test.ts (which elements, and where a
// dragged angle lands). What is left — and what no test of a helper can see — is that the designer
// asks the RENDERER where a turned element now is instead of working it out again, that the handle
// exists and is wired, and that turning something goes through the same arm-then-push undo model
// every other mutation does.
//
// It reads the component's own source, the way the colour, nav, history and selection tests do.
/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import SRC from './PosterModal.svelte?raw';
import CTL from './PosterElControls.svelte?raw';
import { canRotate } from '$lib/posterFlow';

const SCRIPT = SRC.slice(0, SRC.indexOf('</script>'));
const MARKUP = SRC
  .slice(SRC.indexOf('</script>'), SRC.lastIndexOf('<style>'))
  .replace(/<!--[\s\S]*?-->/g, '');
const STYLE = SRC.slice(SRC.lastIndexOf('<style>')).replace(/\/\*[\s\S]*?\*\//g, '');
const CTL_MARKUP = CTL.slice(CTL.indexOf('</script>'), CTL.lastIndexOf('<style>')).replace(/<!--[\s\S]*?-->/g, '');

/** One function's body, brace-matched from its declaration, with its comments gone. */
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
/** The next `n` characters of source from a declaration. For the two one-liners below, whose first
 *  `{` belongs to a TYPE annotation rather than to a body — brace-matching those would stop inside
 *  the signature. */
function chunk(src: string, decl: string, n = 260): string {
  const i = src.indexOf(decl);
  expect(i, decl).toBeGreaterThan(-1);
  return src.slice(i, i + n).replace(/\/\/[^\n]*/g, '');
}

describe('the outline of a turned element comes from the renderer', () => {
  // THE rule this component keeps breaking. DEVELOPMENT.md: "the renderer owns glyph geometry,
  // never keep a second guess". It has been broken three times already — the title, the name
  // lockup, then the message and the how-to line, which came out 221px narrower than their own
  // text. A rotation derived here would be the fourth, and the most visible: the outline would sit
  // beside the words rather than merely be the wrong width.
  it('has exactly one place that turns a rect, and it is the imported one', () => {
    // The CALL, not the name. `toContain('rotatedRect')` was satisfied by the import line alone,
    // so the whole of this test's premise — that there is exactly one place turning a rect, and
    // it is the shared one — held with every call site deleted. "Exactly one" is also now
    // actually counted rather than asserted in the test's title and nowhere else.
    // Comments stripped BEFORE counting, because the doc comment above the call writes
    // "rotatedRect()" with parentheses and so matched the call pattern too. That is the same
    // shape of mistake this assertion was being repaired for, made inside the repair — which is
    // a fair measure of how easy it is in a file whose comments quote its own code.
    const code = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
    const calls = [...code.matchAll(/\brotatedRect\(/g)];
    expect(calls.length, 'exactly one place may turn a rect').toBe(1);
    const turned = chunk(SCRIPT, 'const turned = (');
    expect(turned).toContain('rotatedRect(r, a.rot, a.x * W, a.y * H)');
    // Nothing else in the component does rotation arithmetic of its own.
    expect(SCRIPT).not.toMatch(/Math\.cos\(/);
    expect(SCRIPT.match(/Math\.sin\(/g) ?? []).toHaveLength(0);
  });

  it('routes every measured footprint through it', () => {
    for (const fn of ['function titleBounds(', 'function bodyBounds(', 'function namesBounds(', 'function footerBounds(']) {
      expect(code(SCRIPT, fn), fn).toContain('turned(box, {');
    }
    // ...and the two that are not fixtures: a host's own line and a placed motif.
    expect(SCRIPT).toContain('turned(t, { x: t.x * W - w / 2');
    expect(SCRIPT).toContain('turned(it, { x: it.x * W - side / 2');
  });

  it('does not turn what cannot be turned', () => {
    // The QR panel and the mark have no rotation, so their rects must not pretend to ask about one
    // — a `turned()` there would be a control that exists in the geometry and nowhere else.
    expect(code(SCRIPT, 'function brandBounds(')).not.toContain('turned(');
    expect(SCRIPT).toContain('const qrBounds = (box: Box): Rect => qrPanelRect(box, codeDisplay);');
  });
});

describe('the handle', () => {
  it('is on the stage, on all three kinds of element, and only while one is selected', () => {
    const grips = MARKUP.match(/class="el-rot"/g) ?? [];
    expect(grips).toHaveLength(3);                       // fixtures, the host's lines, the motifs
    expect(MARKUP).toContain("startDrag(el.key, 'rotate', e)");
    expect(MARKUP).toContain("startDrag(`text:${i}`, 'rotate', e)");
    expect(MARKUP).toContain("startDrag(`decor:${i}`, 'rotate', e)");
    // Gated on canRotate for the fixtures: the QR and the mark are in `elements` too.
    expect(MARKUP).toContain('{#if canRotate(el.key) && selectedKey === el.key}');
  });

  it('sits diagonally opposite the resize corner, clear of the control cluster', () => {
    // ⤡ is pinned to the element's bottom-right and the cluster right-aligns to its top-right, so
    // top-left is the one corner where a third handle cannot be reached for by mistake.
    expect(MARKUP).toContain('<span class="el-rot"');
    // Just INSIDE the corner, not hanging outside it: the sheet clips what overflows (the same fact
    // that gives .el-name its `label-below` flip), and an element pushed to the top-left of the page
    // would have its grip cut off by the sheet's edge — a handle you cannot reach.
    expect(STYLE).toMatch(/\.el-rot \{[^}]*position: absolute;[^}]*transform: translate\(2px, 2px\)/);
  });

  it('carries a 44px target around its 22px chip', () => {
    // The hard rule for this designer. The chip cannot GROW to 44 — it would swallow the element it
    // is attached to on a 316px phone preview — so the hit area is expanded instead.
    expect(STYLE).toMatch(/\.el-rot::after \{[^}]*inset: -11px/);
    expect(STYLE).toMatch(/\.el-rot \{[^}]*width: 22px; height: 22px/);
    // touch-action: none, or the browser claims the drag as a page scroll.
    expect(STYLE).toMatch(/\.el-rot \{[^}]*touch-action: none/);
  });

  it('says what it does, for a reader who cannot see it', () => {
    for (const label of ['aria-label="Turn {el.label}"', 'aria-label="Turn your line"', 'aria-label="Turn decoration"']) {
      expect(MARKUP, label).toContain(label);
    }
  });
});

describe('turning something is an edit like any other', () => {
  const drag = code(SCRIPT, 'function dragOn(');

  it('pushes undo through armUndo, and only once the angle really changes', () => {
    // The bug this model exists to stop: a bare selection tap adding a no-op undo step AND setting
    // `designEdited`, the flag that unlocks persist() and every export. A rotate is the new way to
    // hit it — the 15° snap means a small drag can land back on the angle it started from.
    const branch = drag.slice(drag.indexOf("} else if (mode === 'rotate') {"), drag.indexOf("        } else {\n          "));
    expect(branch).toContain('if (rad === (surf.box(key).rot ?? 0)) return;');
    expect(branch.indexOf('if (rad ===')).toBeLessThan(branch.indexOf('armUndo()'));
    expect(branch.indexOf('armUndo()')).toBeLessThan(branch.indexOf('surf.rotate(key, rad)'));
  });

  it('is one undo step for the whole drag, like a move or a resize', () => {
    // armUndo() is idempotent within a gesture (`undoPushed`), so a drag emitting an angle per
    // frame is still exactly one step.
    expect(drag).toContain('if (undoPushed) return;');
  });

  it('respects the dead zone, so a tap on the handle turns nothing', () => {
    // The rotate branch sits INSIDE the same `live` gate the move and resize branches do — a 2px of
    // jitter in a tap must not become an angle.
    expect(drag.indexOf('if (!live) {')).toBeLessThan(drag.indexOf("} else if (mode === 'rotate') {"));
  });

  it('stores radians, and converts to degrees only to snap', () => {
    // One vocabulary. The placed decorations have stored radians since they were added; degrees
    // exist at the control and nowhere else.
    expect(drag).toContain('snapAngle(((rot0 + (a - angle0)) * 180) / Math.PI)');
    expect(drag).toContain('* Math.PI) / 180');
  });
});

describe('putting it back upright', () => {
  const up = code(SCRIPT, 'function putUpright(');

  it('is the same words AND the same glyph as every other "put it back"', () => {
    // 🔄 now, not ↺. Three controls mean the one thing — Reset layout in the header, this, and the
    // motif panel's own — and they were two vocabularies: a single curved arrow in two of them, the
    // recycle pair in the third. Changed together on purpose; one left behind is the whole problem,
    // so all three are asserted here rather than only the one that moved.
    expect(CTL_MARKUP).toContain('🔄');
    expect(CTL_MARKUP).toContain('Upright');
    expect(MARKUP).toContain('🔄 Upright');
    expect(MARKUP).toContain('🔄<span class="tog-w">');   // the header's Reset layout
    expect(CTL_MARKUP).not.toContain('↺');
  });

  it('only appears while there is something to reset', () => {
    expect(CTL_MARKUP).toContain('{#if rotatedBy}');
    expect(MARKUP).toContain('rotatedBy={selectedEl.rot}');
    expect(MARKUP).toContain('onUpright={() => putUpright(');
  });

  it('pushes undo before it changes anything, and refuses when there is nothing to change', () => {
    expect(up).toContain('if (!key || !canRotate(key) || !(posterSurface.box(key)?.rot)) return;');
    expect(up.indexOf('return;')).toBeLessThan(up.indexOf('pushUndo('));
    expect(up.indexOf('commitBurst()')).toBeLessThan(up.indexOf('pushUndo('));
    expect(up.indexOf('pushUndo(')).toBeLessThan(up.indexOf('posterSurface.rotate'));
  });

  it('remeasures and redraws, so the outline follows the ink back', () => {
    expect(up).toContain('bounds = measureBounds()');
    expect(up).toContain('scheduleRedraw()');
  });
});

describe('upright is spelled absent', () => {
  const w = chunk(SCRIPT, 'const withRot = <T extends { rot?: number }>');

  it('drops the key rather than writing rot: 0', () => {
    // `rot: 0` and no rot render the same and do NOT serialise the same, and cfg is what the
    // history watcher compares and what persist() saves. A design turned and put back must come out
    // the bytes it went in as.
    expect(w).toContain('const { rot: _was, ...rest } = o;');
    expect(w).toContain('return (rot ? { ...rest, rot } : rest) as T;');
  });

  it('is used for the optional ones and not for the motifs', () => {
    const rotate = code(SCRIPT, 'rotate: (k, rot) => {');
    // A placed motif's `rot` has been REQUIRED since motifs were added and every stored one has it;
    // making it optional now would be changing a saved shape for tidiness.
    expect(rotate).toContain('patchDecor(i, { rot })');
    expect(rotate).toContain('withRot(x, rot)');
    expect(rotate).toContain('withRot(layout[k as ElKey], rot)');
  });
});

describe('the surfaces disagree about rotation, on purpose', () => {
  it('the poster rotates and the card sheet does not', () => {
    // A card is cut to a rectangle and printed in a grid; there is no rotation to offer and the
    // Surface's two hooks are optional precisely so it can decline them.
    const card = code(SCRIPT, 'const cardSurface: Surface = {');
    expect(card).not.toContain('rotate:');
    expect(card).not.toContain('rotatable:');
    expect(code(SCRIPT, 'const posterSurface: Surface = {')).toContain('rotatable: canRotate,');
  });

  it('and the predicate is the shared one, not a copy', () => {
    expect(canRotate('title')).toBe(true);
    expect(canRotate('qr')).toBe(false);
    expect(SCRIPT).not.toMatch(/const ROTATABLE/);
  });
});
