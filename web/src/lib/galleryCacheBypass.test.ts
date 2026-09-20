// Every gallery load has to agree about when the shared cache may be trusted.
//
// The gallery reply is cacheable for 30s because the ORDER is everyone's. Two things a viewer does
// themselves make that copy wrong for THEM: a heart, which reorders it, and a rotation — which is
// the sharp one, because rotating RENAMES the stored file and unlinks the old name. A cached reply
// from before it does not show a stale picture; it names a file that 404s, and the guest sees
// broken tiles until the cache expires.
//
// The first version of that fix covered `loadPhotos` and left `reloadForSort` and `loadMore` still
// asking only about hearts — so changing the sort, or scrolling one page further in, inside the
// window went straight back to the cache and broke the grid. Nothing threw; the tiles were just
// empty. A source check, because reproducing it needs a real HTTP cache.
import { describe, it, expect } from 'vitest';
import src from '../routes/gallery/[code]/+page.svelte?raw';

describe('bypassing the shared gallery cache', () => {
  it('is one decision, and every load reads it', () => {
    expect(src).toMatch(/\$: skipCache = heartsDirty \|\| rotateDirty;/);
    const calls = [...src.matchAll(/getGalleryPhotos\([^)]*\)/g)].map((m) => m[0]);
    // The initial/poll load, the sort reload, and the next-page load. If a fourth appears it has
    // to answer this too.
    expect(calls.length, 'three load paths').toBe(3);
    for (const c of calls) {
      expect(c, `${c} must decide with the shared flag`).toContain('skipCache');
    }
  });

  it('still opens the window on a rotation, and holds it as long as a heart does', () => {
    // Same constant on purpose: 35s is a property of the shared ANSWER, not of what happened to be
    // changed in it.
    expect(src).toMatch(/\$: rotateDirty = rotatedAt > 0 && now - rotatedAt < HEART_FRESH_MS;/);
    // Set from the merge, not from the press, so a rotation that failed does not spend 35 seconds
    // of everybody's cache on nothing.
    const merge = src.slice(src.indexOf('function applyRotation'));
    expect(merge.slice(0, merge.indexOf('\n  }'))).toContain('rotatedAt = Date.now()');
  });
});
