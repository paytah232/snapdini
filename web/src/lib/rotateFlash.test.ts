import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROTATE_PRELOAD_TIMEOUT_MS, preloadStills } from './rotatePreview';
import REVIEW from '../routes/admin/[code]/review/+page.svelte?raw';
import LIGHTBOX from './components/Lightbox.svelte?raw';
import GALLERY from '../routes/gallery/[code]/+page.svelte?raw';

/* The flash when a rotation is saved.
 *
 * A turn is previewed as a CSS transform over the OLD file, and saving renames the file (it has
 * to — /uploads is immutable for a year). Both save paths then did two things on one tick: point
 * the element at the new name, and clear the transform. Pointing an <img> at a new src does not
 * change what is on screen, though — the old bitmap stays painted until the new one is fetched
 * and decoded — so the preview came off the OLD picture and the photo visibly snapped back to the
 * orientation that had just been corrected before snapping forward again.
 *
 * Both sites carried a comment saying the preview was dropped only once the corrected source was
 * "in hand". The URL was in hand. The bytes are what gets painted. */

/** A stand-in Image whose loads the test decides the timing of. */
function fakeImages() {
  const made: { src: string; onload?: () => void; onerror?: () => void; decode?: () => Promise<void> }[] = [];
  class FakeImage {
    src = '';
    onload?: () => void;
    onerror?: () => void;
    decode() { return Promise.resolve(); }
    constructor() { made.push(this as never); }
  }
  vi.stubGlobal('Image', FakeImage as never);
  return made;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('waiting for the turned bytes before the preview comes off', () => {
	it('does not resolve until every still has loaded', async () => {
		const made = fakeImages();
		let done = false;
		const p = preloadStills(['/uploads/a.jpg', '/uploads/a_thumb.webp']).then(() => { done = true; });
		expect(made.map((i) => i.src)).toEqual(['/uploads/a.jpg', '/uploads/a_thumb.webp']);
		made[0].onload?.();
		await Promise.resolve();
		expect(done, 'one of two is not enough').toBe(false);
		made[1].onload?.();
		await p;
		expect(done).toBe(true);
	});

	it('never downloads a clip to look at it', async () => {
		// An .mp4 handed to Image() is a full download that then fails to decode. On a long 4K clip
		// that is hundreds of megabytes spent on a cosmetic wait.
		const made = fakeImages();
		const p = preloadStills(['/uploads/a.mp4', '/uploads/a_play.mp4', '/uploads/a_thumb.webp']);
		expect(made.map((i) => i.src), 'the poster and nothing else').toEqual(['/uploads/a_thumb.webp']);
		made[0].onload?.();
		await expect(p).resolves.toBeUndefined();
		// Nothing but clips is nothing to wait for at all — no Image, and no timeout to sit out.
		await expect(preloadStills(['/uploads/b.mp4'])).resolves.toBeUndefined();
		expect(made).toHaveLength(1);
	});

	it('a missing file resolves like any other — the write already succeeded', async () => {
		const made = fakeImages();
		const p = preloadStills(['/uploads/gone.jpg']);
		made[0].onerror?.();
		await expect(p).resolves.toBeUndefined();
	});

	it('cannot hold the control hostage', async () => {
		// Worst case has to be the flash we started with, never a Save that never finishes.
		vi.useFakeTimers();
		fakeImages();                       // nothing ever loads
		let settled = false;
		void preloadStills(['/uploads/slow.jpg']).then(() => { settled = true; });
		await vi.advanceTimersByTimeAsync(ROTATE_PRELOAD_TIMEOUT_MS - 1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(2);
		expect(settled).toBe(true);
	});

	it('asks for each url once', async () => {
		// A photo whose thumbnail IS its original (or two equal urls in a reply) must not be two
		// loads and two decodes.
		const made = fakeImages();
		void preloadStills(['/uploads/a.jpg', '/uploads/a.jpg']);
		expect(made).toHaveLength(1);
	});
});

describe('both save paths wait for them', () => {
	/** saveTurn's body with the prose taken out.
	 *
	 *  Both functions EXPLAIN this ordering in comments that name the very lines being ordered, so
	 *  a plain indexOf finds the explanation rather than the code and reports the opposite of the
	 *  truth — which is exactly what the first version of this test did. */
	function saveTurnCode(src: string): string {
		const fn = src.slice(src.indexOf('async function saveTurn()'));
		return fn.slice(0, fn.indexOf('\n  }'))
			.replace(/\/\*[\s\S]*?\*\//g, ' ')
			.replace(/^[ \t]*\/\/.*$/gm, ' ');
	}

	it('the review screen preloads before it drops the preview', () => {
		const body = saveTurnCode(REVIEW);
		const preload = body.indexOf('await preloadStills(');
		const drop = body.indexOf('cancelTurn()');
		expect(preload, 'it preloads at all').toBeGreaterThan(-1);
		expect(drop, 'and the preview comes off after').toBeGreaterThan(preload);
	});

	it('the lightbox preloads before it drops the preview', () => {
		// From the write onwards. There is an earlier, legitimate `turn = 0` in this function — the
		// four-taps-is-a-full-circle early return, which never writes anything — and anchoring on
		// the first match measured that one instead.
		const whole = saveTurnCode(LIGHTBOX);
		const body = whole.slice(whole.indexOf('await rotatePhoto('));
		const preload = body.indexOf('await preloadStills(');
		const drop = body.indexOf('turn = 0;');
		expect(preload, 'it preloads at all').toBeGreaterThan(-1);
		expect(drop, 'and the preview comes off after').toBeGreaterThan(preload);
	});
});

describe('a rotate that outlives the page it happened on', () => {
	it('is remembered across a reload, and read back through the same window', () => {
		// Reloading to check is the first thing anyone does. That load can be answered by the 30s
		// shared copy, which still names the replaced file — and the browser has that file cached
		// immutable for a year, so it paints the old orientation from disk with no request and no
		// 404 for the self-heal to see.
		expect(GALLERY).toContain('sessionStorage.setItem(ROT_KEY');
		expect(GALLERY).toMatch(/sessionStorage\.getItem\(ROT_KEY\)/);
		// Same freshness window as the in-memory flag, or a tab reopened tomorrow skips the cache
		// on the strength of yesterday's rotation.
		// serverNow(), like every other instant on that page — the marker is compared against a
		// window measured in the same clock the countdown and the reveal crossing use.
		expect(GALLERY).toMatch(/serverNow\(\) - at < HEART_FRESH_MS/);
		// Both accesses have to survive private mode, where touching sessionStorage throws.
		const boot = GALLERY.slice(GALLERY.indexOf('const ROT_KEY'), GALLERY.indexOf('$: rotateDirty'));
		expect(boot).toContain('catch');
	});
});

describe('where there is no browser', () => {
	it('preloadStills does not reach for Image during SSR', async () => {
		// This runs inside a component's save path, and SvelteKit renders components on the server.
		// `new Image()` there is a ReferenceError, which would turn a rotation save into a 500 on
		// any path that ever executed server-side. The guard was previously unpinned — removing
		// `typeof Image === 'undefined'` left the whole file passing, because jsdom always provides
		// one and no test took it away.
		const saved = globalThis.Image;
		// @ts-expect-error — deleting a DOM global is the whole point of the test
		delete globalThis.Image;
		try {
			expect(typeof Image, 'the global really is gone').toBe('undefined');
			await expect(preloadStills(['/uploads/a.jpg'])).resolves.toBeUndefined();
		} finally {
			globalThis.Image = saved;
		}
	});
});

describe('private mode', () => {
	it('a rotation still works when sessionStorage refuses to be written', () => {
		// Safari in private browsing throws on setItem rather than returning quietly, and this
		// write sits inside applyRotation — the merge that puts the corrected photo on screen. An
		// unguarded throw there would abandon the merge halfway: the reply is in hand, the names
		// are known, and the tile stays broken because storing a timestamp failed.
		//
		// Only the READ side was asserted before, so the write's try/catch could be deleted with
		// every test still passing.
		const merge = GALLERY.slice(GALLERY.indexOf('function applyRotation'));
		const body = merge.slice(0, merge.indexOf('\n  }'));
		expect(body).toContain('sessionStorage.setItem(ROT_KEY');
		expect(body, 'the write must be guarded, not just the read').toMatch(
			/try \{ sessionStorage\.setItem\(ROT_KEY[^}]*\} catch \{/
		);
		// AND ordered after the merge, which is the half that does not rely on anyone remembering
		// the guard. With the write first, deleting that try/catch — a tidy-up that looks entirely
		// safe — abandons applyRotation halfway and leaves the tile pointing at a file that no
		// longer exists. Ordered last, the worst an unguarded throw costs is the marker.
		// Both operands anchored: -1 is less than any real index, so an unguarded left-hand side
		// would report "the merge comes first" as satisfied by the merge having been DELETED.
		const mergeAt = body.indexOf('photos = photos.map');
		const writeAt = body.indexOf('sessionStorage.setItem');
		expect(mergeAt, 'the merge itself must still be here').toBeGreaterThan(-1);
		expect(writeAt, 'and so must the write it is ordered against').toBeGreaterThan(-1);
		expect(mergeAt, 'the merge happens before anything that can throw').toBeLessThan(writeAt);
	});
});
