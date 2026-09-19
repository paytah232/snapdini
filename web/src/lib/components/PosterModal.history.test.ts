// Opening a saved design must leave NOTHING to undo.
//
// The bug this guards was live data loss. prevCfg was seeded during init with the untouched default
// cfg; restore() then rewrote layout, colours, type and decoration in one batch; the history watcher
// read that as an edit and opened a burst whose "before" was a blank poster. One press of Undo
// applied that default AND persisted it over the host's saved work. Five real events on production
// have saved designs.
//
// The fix is an ORDER of three statements inside onMount, which no test of a helper can see, and
// which two separate pieces of later work (the font-loading re-measure, and the wizard nav) both
// edit within a few lines of. So it is pinned here, from the component's own source, the way the
// colour and nav tests are.
/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import SRC from './PosterModal.svelte?raw';

const SCRIPT = SRC.slice(0, SRC.indexOf('</script>'));
const ON_MOUNT = SCRIPT.slice(SCRIPT.indexOf('onMount(() => {'), SCRIPT.indexOf('onDestroy(('));
/** onMount with its comments gone: the order has to be in the code, not in the notes. */
const BODY = ON_MOUNT.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('mounting on a saved design', () => {
  it('suppresses the history watcher for the whole restore batch', () => {
    const raise = BODY.indexOf('applyingHistory = true;');
    const restore = BODY.indexOf('restore();');
    const clear = BODY.indexOf('void tick().then(() => { applyingHistory = false; });');
    expect(raise).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(raise);
    // A tick later, not immediately: cfg is a `$:` derivation and onMount runs before Svelte has
    // re-derived it from what restore() just wrote.
    expect(clear).toBeGreaterThan(restore);
  });

  it('does not try to re-seed prevCfg instead, which was the attempt that did not work', () => {
    // Setting prevCfg inside onMount captures the very default it means to exclude, for the same
    // reason: cfg has not been re-derived yet.
    expect(BODY).not.toContain('prevCfg');
  });

  it('keeps the watcher itself skipping only the burst, never the baseline', () => {
    // applyingHistory must gate the BURST and not the `prevCfg = cur` assignment — otherwise the
    // baseline never catches up with the restored design and the next real edit undoes to the
    // default anyway.
    const watcher = SCRIPT.slice(SCRIPT.indexOf('  $: {\n    const cur = JSON.stringify(cfg);'));
    const gate = watcher.indexOf('if (!applyingHistory && prevCfg && cur !== prevCfg)');
    const baseline = watcher.indexOf('prevCfg = cur;');
    expect(gate).toBeGreaterThan(-1);
    expect(baseline).toBeGreaterThan(gate);
    // ...and it is outside the gated block: the only `}` structure between them is the burst's.
    expect(watcher.slice(gate, baseline)).toContain('burstTimer = setTimeout');
  });

  it('never opens history from the font warm-up that runs after mount', () => {
    // The outlines are measured off a bare offscreen canvas, so they have to be recomputed once the
    // bundled faces land. That callback must flip a measurement flag and nothing else — touching
    // cfg from a post-mount async callback is exactly how the original bug got its "before" state.
    const warm = BODY.slice(BODY.indexOf('warmAllPosterFonts()'));
    const cb = warm.slice(0, warm.indexOf('\n', warm.indexOf('});')));
    expect(cb).toContain('fontsReady = true');
    for (const forbidden of ['pushUndo', 'prevCfg', 'applyingHistory', 'persist(']) {
      expect(cb, forbidden).not.toContain(forbidden);
    }
  });

  it('keeps the measurement flag out of the saved design', () => {
    // If fontsReady reached cfg, the warm-up would look like an edit to the watcher and undo would
    // be live on a design nobody touched — the original bug by another route.
    const cfgLine = SCRIPT.slice(SCRIPT.indexOf('  $: cfg = {'), SCRIPT.indexOf('};', SCRIPT.indexOf('  $: cfg = {')));
    expect(cfgLine).not.toContain('fontsReady');
    expect(cfgLine).not.toContain('bounds');
  });
});
