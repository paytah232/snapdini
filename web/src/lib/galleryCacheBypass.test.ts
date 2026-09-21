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
    expect(src).toMatch(/\$: skipCache = heartsDirty \|\| rotateDirty \|\| knownLocked \|\| staleDirty;/);
    const calls = [...src.matchAll(/getGalleryPhotos\([^)]*\)/g)].map((m) => m[0]);
    // The initial/poll load, the sort reload, and the next-page load. If a fourth appears it has
    // to answer this too.
    expect(calls.length, 'three load paths').toBe(3);
    for (const c of calls) {
      expect(c, `${c} must decide with the shared flag`).toContain('skipCache');
    }
  });

  it('does not let a cached "still locked" answer the reveal moment', () => {
    // The third reason to skip, and the only one that is not about something THIS viewer did.
    //
    // A heart and a rotation invalidate the shared copy because the viewer changed it. The reveal
    // crossing invalidates it because the viewer is standing on the one answer in the reply that is
    // known to be about to change, in front of a cache that is holding the previous value for up to
    // 30s. Attempts spent against that copy learn nothing and the guest watches a lock for the
    // length of the TTL.
    //
    // Cheap because a locked reply is a single count. It also switches itself off at exactly the
    // right moment: `pastZero` requires `!revealed`, so the load that finally succeeds is the last
    // uncached one and everything after it is back on the shared copy.
    // `knownLocked` ITSELF, not a neighbouring variable. The first version of this test asserted
    // the `pastZero` regex — which is about a different thing and was already asserted in
    // revealArriving.test.ts — so `knownLocked` could be replaced with a literal `false`, deleting
    // the entire reveal-latency fix, and every test in the suite still passed. An assertion that
    // names the wrong variable is not a weaker test, it is not a test.
    expect(src).toMatch(/\$: knownLocked = everLoaded && !revealed;/);
    // Both halves matter. `everLoaded` is what keeps the FIRST load of a revealed gallery
    // cacheable — the single most valuable thing in that cache — because `!revealed` is also true
    // before any reply has arrived.
    expect(src).toMatch(/everLoaded = true;/);
    expect(src).toMatch(/\$: skipCache = heartsDirty \|\| rotateDirty \|\| knownLocked \|\| staleDirty;/);
  });

  it('still opens the window on a rotation, and holds it as long as a heart does', () => {
    // Same constant on purpose: 35s is a property of the shared ANSWER, not of what happened to be
    // changed in it.
    expect(src).toMatch(/\$: rotateDirty = rotatedAt > 0 && now - rotatedAt < HEART_FRESH_MS;/);
    // Set from the merge, not from the press, so a rotation that failed does not spend 35 seconds
    // of everybody's cache on nothing.
    const merge = src.slice(src.indexOf('function applyRotation'));
    // serverNow(), not Date.now(): every instant on this page is compared against server-supplied
    // ones, so a device clock four minutes out would open or close this window four minutes early.
    expect(merge.slice(0, merge.indexOf('\n  }'))).toContain('rotatedAt = serverNow()');
  });
});
