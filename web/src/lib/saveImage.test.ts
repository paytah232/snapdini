// Bulk save: what it is allowed to claim afterwards.
//
// WHY THIS FILE EXISTS. saveMany fetches one URL per photo, and those URLs were read off the
// gallery when the page loaded. The server renames a photo's file on every rotation — a fresh uuid,
// the old name unlinked — so a 404 partway through a bulk save is an ORDINARY outcome, not an
// exotic one. It was being swallowed: the fetch failure was caught, the item skipped, and the run
// returned only the successes. Every caller then printed that number as "N downloaded", so a roll
// of forty that handed over thirty-nine said forty, and the missing photo was never mentioned on
// any screen. The tick in the grid was marked from the same figure.
//
// The fix is not to stop on the first failure — carrying on is right, the rest of the roll should
// still arrive — it is to COUNT what did not arrive and say so. These tests pin the count and the
// copy, because the copy is the part a person actually sees.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { saveMany, saveManySummary, isIOS } from './saveImage';

// downloadBlob is the non-iOS route (jsdom is not an iPhone), and it needs the two object-URL
// methods jsdom does not implement. Nothing here asserts on them — they exist so the real code
// path runs rather than being mocked away.
const clicked: string[] = [];
beforeEach(() => {
  clicked.length = 0;
  URL.createObjectURL = vi.fn(() => 'blob:stub');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this.download);
  });
});
afterEach(() => { vi.restoreAllMocks(); });

/** A server that hands back bytes for some URLs and a 404 for others — which is exactly what it
 *  does to a page holding the name a photo had before it was rotated. */
function serve(behaviour: Record<string, 'ok' | 'gone' | 'throw'>) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const how = behaviour[String(url)] ?? 'ok';
    if (how === 'throw') throw new TypeError('Failed to fetch');
    if (how === 'gone') return { ok: false, status: 404 } as unknown as Response;
    return { ok: true, status: 200, blob: async () => new Blob(['pixels'], { type: 'image/jpeg' }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

const item = (n: number) => ({ id: `p${n}`, url: `/uploads/${n}.jpg`, filename: `snap-${n}.jpg` });

describe('saveMany', () => {
  it('counts a photo the server no longer has, instead of quietly skipping it', async () => {
    serve({ '/uploads/2.jpg': 'gone' });
    const r = await saveMany([item(1), item(2), item(3)]);
    expect(r.saved).toBe(2);
    expect(r.failed).toBe(1);
    // And the tick must not be put on the one that never arrived.
    expect(r.savedIds).toEqual(['p1', 'p3']);
  });

  it('counts a fetch that throws the same way', async () => {
    serve({ '/uploads/1.jpg': 'throw' });
    const r = await saveMany([item(1), item(2)]);
    expect(r.saved).toBe(1);
    expect(r.failed).toBe(1);
  });

  it('carries on with the rest of the roll rather than stopping at the first failure', async () => {
    serve({ '/uploads/1.jpg': 'gone', '/uploads/3.jpg': 'gone' });
    const r = await saveMany([item(1), item(2), item(3), item(4)]);
    expect(r.saved).toBe(2);
    expect(r.failed).toBe(2);
    expect(clicked).toEqual(['snap-2.jpg', 'snap-4.jpg']);
  });

  it('reports nothing failed when nothing did', async () => {
    serve({});
    const r = await saveMany([item(1), item(2)]);
    expect(r).toMatchObject({ saved: 2, failed: 0, cancelled: false });
  });
});

// The sentence somebody reads. The old one was assembled at each call site out of `saved` alone,
// which is why it could not say anything else.
describe('saveManySummary', () => {
  it('says plainly how many did not arrive, and what to do', () => {
    expect(saveManySummary({ saved: 39, failed: 1, cancelled: false }))
      .toBe('39 photos downloaded, 1 file failed — try again');
    expect(saveManySummary({ saved: 0, failed: 2, cancelled: false }))
      .toBe('2 files failed to download — try again');
  });

  it('does not invent a problem when there is not one', () => {
    expect(saveManySummary({ saved: 12, failed: 0, cancelled: false })).toBe('12 photos downloaded');
    expect(saveManySummary({ saved: 1, failed: 0, cancelled: false })).toBe('1 photo downloaded');
  });

  // Cancelling is the guest's own decision and is not a fault — but a failure that happened before
  // they cancelled is still a failure, and still theirs to know about.
  it('keeps a cancelled run distinct from a failed one', () => {
    expect(saveManySummary({ saved: 4, failed: 0, cancelled: true })).toBe('Stopped — 4 downloaded');
    expect(saveManySummary({ saved: 0, failed: 0, cancelled: true })).toBe('Stopped');
    expect(saveManySummary({ saved: 4, failed: 1, cancelled: true })).toBe('Stopped — 4 downloaded, 1 file failed');
  });
});

/* RESTORED. These five went missing when this file was rewritten around saveMany, and nothing
 * noticed, because deleting a test never fails a suite: the only signal is a number going down,
 * and it went down inside a commit that added more tests than it removed.
 *
 * isIOS() is still live in five places — three inside saveImage itself, plus Camera.svelte and
 * DownloadFormat.svelte. The similarly-named isIOS in pwa.ts is a DIFFERENT function answering a
 * different question (is this an iOS device we can offer an install prompt to), so it covers none
 * of this; Camera.svelte imports both and has a comment explaining the alias.
 *
 * The iPad case is the one most worth keeping. iPadOS reports "Macintosh" and only the touch
 * points give it away, so without it an iPad silently takes the Android path and a guest's photos
 * land in Files instead of Photos — which is invisible in review and shows up as somebody saying
 * "the share sheet has no way to save it". */

const ua = (s: string, touch = 0) =>
  vi.stubGlobal('navigator', { userAgent: s, maxTouchPoints: touch });

describe('knowing when the share sheet is the only way to Photos', () => {
  it('spots an iPhone', () => {
    ua('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1');
    expect(isIOS()).toBe(true);
  });

  it('spots an iPad that is pretending to be a Mac', () => {
    // iPadOS 13+ reports "Macintosh". The touch points are what give it away, and without this an
    // iPad would take the Android path and land its photos in Files.
    ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', 5);
    expect(isIOS()).toBe(true);
  });

  it('does not mistake a real Mac for one', () => {
    ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/127 Safari/537.36', 0);
    expect(isIOS()).toBe(false);
  });

  it('leaves Android alone — a download is better there', () => {
    // The share sheet on Android lists apps to send the photo TO. There is no "keep this" on it,
    // so a guest who wanted the photo got a list of ways to give it away.
    ua('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/127 Mobile Safari/537.36', 5);
    expect(isIOS()).toBe(false);
  });

  it('leaves desktop alone', () => {
    ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127 Safari/537.36', 0);
    expect(isIOS()).toBe(false);
  });

  it('does not throw where there is no navigator at all', () => {
    vi.stubGlobal('navigator', undefined);
    expect(() => isIOS()).not.toThrow();
  });
});

/* THE iOS BRANCH, which nothing had ever entered.
 *
 * On iPhone a download does not reach Photos — the share sheet is the only route — so saveMany
 * takes a completely different path there: it batches Files and hands them to navigator.share
 * instead of clicking an anchor per photo. jsdom is not an iPhone and provides neither `share`
 * nor `canShare`, so every test in this file was exercising the Android/desktop half and the
 * iOS half had no coverage at all, including its two most interesting outcomes.
 *
 * Those outcomes are where the counting rules differ, which is the entire subject of this file:
 *   · a DISMISSED share sheet is the one case where nothing reached the device, so the batch must
 *     NOT be counted — ticking it would be exactly the overstatement these tests exist to stop;
 *   · any OTHER share failure falls back to downloads, so the batch DOES count, because the files
 *     genuinely landed.
 * Getting those two the same way round is invisible in review and shows up as a guest whose
 * gallery says they saved forty photos they never received.
 */
describe('saving on an iPhone, where the share sheet is the only way to Photos', () => {
	/** Stub an iPhone that answers the share sheet however the test says. */
	function iphone(share: 'ok' | 'dismissed' | 'broken') {
		const shared: File[][] = [];
		vi.stubGlobal('navigator', {
			userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
			maxTouchPoints: 5,
			canShare: () => true,
			share: async (data: { files: File[] }) => {
				if (share === 'dismissed') throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
				if (share === 'broken') throw new Error('share unavailable');
				shared.push(data.files);
			},
		});
		return shared;
	}
	afterEach(() => vi.unstubAllGlobals());

	const roll = (n: number) =>
		Array.from({ length: n }, (_, i) => ({ url: `/uploads/p${i}.jpg`, filename: `p${i}.jpg`, id: `p${i}` }));

	it('hands the photos to the share sheet rather than downloading them', async () => {
		serve({});
		const shared = iphone('ok');
		const r = await saveMany(roll(3));
		expect(r.saved).toBe(3);
		expect(r.failed).toBe(0);
		expect(shared.flat().map((f) => f.name)).toEqual(['p0.jpg', 'p1.jpg', 'p2.jpg']);
		// And emphatically NOT the anchor route — that is the bug this branch exists to avoid.
		expect(clicked, 'a download on iOS does not reach Photos').toEqual([]);
	});

	it('claims nothing when the guest dismisses the sheet', async () => {
		serve({});
		iphone('dismissed');
		const r = await saveMany(roll(3));
		expect(r.cancelled).toBe(true);
		expect(r.saved, 'a dismissed sheet delivered nothing, so nothing may be ticked').toBe(0);
		expect(r.savedIds).toEqual([]);
	});

	it('falls back to downloads when the sheet itself fails, and counts them', async () => {
		// Not a dismissal: the guest did not decline, the platform did. Losing the batch here would
		// be the opposite error — refusing to record photos that really did land.
		serve({});
		iphone('broken');
		const r = await saveMany(roll(2));
		expect(r.cancelled).toBe(false);
		expect(r.saved).toBe(2);
		expect(clicked, 'the fallback really did write the files').toEqual(['p0.jpg', 'p1.jpg']);
	});

	it('still counts a 404 as failed on this path too', async () => {
		// The rotation race does not care which platform the guest is on, and the iOS branch takes
		// a different route to the same arithmetic.
		serve({ '/uploads/p1.jpg': 'gone' });
		const shared = iphone('ok');
		const r = await saveMany(roll(3));
		expect(r.failed).toBe(1);
		expect(r.saved).toBe(2);
		expect(shared.flat().map((f) => f.name)).toEqual(['p0.jpg', 'p2.jpg']);
		expect(saveManySummary(r)).toBe('2 photos downloaded, 1 file failed — try again');
	});
});
