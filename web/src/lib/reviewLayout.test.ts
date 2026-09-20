// The review screen's single view, as a set of layout rules that fail SILENTLY.
//
// Every one of these shipped once and was found by a person holding a phone, because none of them
// throws, logs or fails a render: a photo painted over the buttons beneath it, a picture that grew
// when you scrolled, a full-screen overlay showing the un-turned original. A component test cannot
// see any of it — jsdom has no layout — so these are assertions about the SOURCE, the same call
// reviewSingleView.test.ts and readonlyClient.test.ts make and for the same reason.
//
// `?raw` via Vite, never node:fs: the web tsconfig carries no node types, so fs/path typecheck
// clean under vitest and then fail svelte-check.
import { describe, it, expect } from 'vitest';
import src from '../routes/admin/[code]/review/+page.svelte?raw';

/** One CSS rule, by the opening of its declaration. None of the rules below contains a nested
 *  block, so the first closing brace is the end of it. */
function rule(open: string): string {
  const at = src.indexOf(open);
  expect(at, `${open} should still exist`).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf('}', at) + 1);
}

describe('a turned photo stays inside the box it was given', () => {
  it('previews through the shared fit, rather than a bare rotate', () => {
    // A rotation leaves the layout box where it was, so a quarter-turned landscape shot is taller
    // than `.big` is allowed to be — and a transform creates a stacking context, so the overflow
    // painted OVER the action row rather than behind it. The lightbox had already solved this;
    // the answer is shared now instead of being invented a second time.
    expect(src).toContain("from '$lib/rotatePreview'");
    expect(src).toMatch(/\$: bigTransform = previewTransform\(pendingFor, bigFit\)/);
    // The thing that was there before, and must not come back.
    expect(src, 'no hand-rolled rotate() — it has no fit in it')
      .not.toMatch(/style:transform=\{pendingFor \?/);
  });

  it('measures the element, and re-measures it when the media loads', () => {
    // offsetWidth/offsetHeight of an image that has not loaded are 0, which measures as "no fit".
    // Without the load handler the very first turn of a freshly opened photo is the one that
    // escapes.
    expect(src).toMatch(/on:load=\{measureBig\}/);
    expect(src).toMatch(/on:loadedmetadata=\{measureBig\}/);
    expect(src).toMatch(/on:load=\{measureFs\}/);
    expect(src).toMatch(/on:loadedmetadata=\{measureFs\}/);
  });

  it('clips the stage, in case the measurement was not there in time', () => {
    expect(rule('.stage { position')).toContain('overflow: hidden');
    expect(rule('.fs { position')).toContain('overflow: hidden');
  });

  it('shows the pending turn in the full-screen overlay too — it is the same photograph', () => {
    // The overlay used to show the ORIGINAL while a turn was waiting to be saved, which is the one
    // place a host would go to check that the turn was right.
    expect(src).toMatch(/\$: fsTransform = previewTransform\(pendingFor, fsFit\)/);
    expect((src.match(/style:transform=\{fsTransform\}/g) ?? []).length,
      'the still and the clip both').toBe(2);
  });
});

describe('the media does not resize itself when a phone scrolls', () => {
  it('sizes the single view in svh, not dvh', () => {
    // `dvh` tracks the DYNAMIC viewport: scroll a few pixels on a phone, the URL bar collapses,
    // every dvh gets bigger and the picture grows to the screen edges under the reader's thumb.
    // It never showed on a desktop, where the two are the same number.
    for (const r of ['.stage { position', '.big { max-width', '.fs-media { max-width']) {
      expect(rule(r), `${r} must not be sized in dvh`).not.toContain('dvh');
    }
    expect(rule('.big { max-width')).toContain('svh');
  });
});

describe('the rotate control keeps its place in the action row', () => {
  it('is the shared one, and adds no buttons when it is pressed', () => {
    // Save and Cancel used to appear BESIDE Rotate, which moved Download, Share and Reject in the
    // same moment the host was reaching for one of them.
    expect(src).toContain('<RotateControl');
    expect(src, 'Save and Cancel live inside the slot now')
      .not.toContain('aria-label="Save this rotation"');
    expect(src, 'and nothing is conditionally added to the row')
      .not.toMatch(/\{#if pendingFor\}/);
  });
});

describe('the header degrades instead of overlapping', () => {
  it('leaves the side tracks their automatic minimum', () => {
    // `1fr` is `minmax(auto, 1fr)`. `min-width: 0` on the item overrides that auto minimum and
    // tells the track it may shrink to nothing — while the controls inside, every one of them
    // flex-shrink:0 and nowrap, refused to shrink with it. With `justify-content: flex-end` the
    // overflow runs LEFTWARD, which is how a row of buttons came to be printed over the event
    // name. Grid tracks never overlap; content spilling out of one of them does.
    expect(rule('.hd-side { display'), 'min-width:0 here is what let the controls spill')
      .not.toContain('min-width');
    // The name is still the thing that yields, and it yields by truncating.
    expect(rule('.hd-name { font-weight')).toContain('text-overflow: ellipsis');
  });
});
