import { describe, expect, it, vi } from 'vitest';
import {
	STALE_MAX_HEALS,
	createStaleHeal,
	onStaleMedia,
	reportStaleMedia,
} from './staleMedia';
import UI from './ui?raw';
import LIGHTBOX from './components/Lightbox.svelte?raw';
import GALLERY from '../routes/gallery/[code]/+page.svelte?raw';

/** A controllable clock and timer queue, so the debounce and the quiet period can be tested as
 *  the durations they are rather than by sleeping. */
function harness(over: Partial<Parameters<typeof createStaleHeal>[0]> = {}) {
	let t = 0;
	const queue: { at: number; fn: () => void; id: number }[] = [];
	let nextId = 1;
	const refetch = vi.fn(async () => {});
	const heal = createStaleHeal({
		refetch,
		now: () => t,
		setTimer: (fn, ms) => { const id = nextId++; queue.push({ at: t + ms, fn, id }); return id as never; },
		clearTimer: (h) => { const i = queue.findIndex((q) => q.id === (h as never as number)); if (i >= 0) queue.splice(i, 1); },
		...over,
	});
	/** How many timers have been armed. The debounce is a claim about this, not about the request
	 *  count — the quiet period already keeps the request count at one, so a test that only counts
	 *  requests passes with the burst guard deleted. */
	const armed = () => nextId - 1;
	async function advance(ms: number) {
		const until = t + ms;
		for (;;) {
			const due = queue.filter((q) => q.at <= until).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			queue.splice(queue.indexOf(due), 1);
			t = due.at;
			due.fn();
			await Promise.resolve();
			await Promise.resolve();
		}
		t = until;
	}
	return { heal, refetch, advance, armed };
}

describe('healing a grid whose files have been renamed', () => {
	it('turns a screenful of broken tiles into ONE request', async () => {
		// Thirty tiles scrolled into view together all fail together. Without the debounce that is
		// thirty identical cache-skipped requests for the same listing, fired by a guest who did
		// nothing but scroll.
		const { heal, refetch, advance, armed } = harness();
		for (let i = 0; i < 30; i++) heal.report();
		expect(refetch, 'nothing goes out during the burst').not.toHaveBeenCalled();
		// One timer for thirty tiles. Counting requests instead would prove nothing here: the quiet
		// period below would hold the count at one even with the burst collapsed into thirty armed
		// timers, twenty-nine of which exist only to find out they are not needed.
		expect(armed(), 'one timer for the whole burst').toBe(1);
		await advance(500);
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it('ignores the stragglers that keep failing while the heal is landing', async () => {
		// Tiles already mid-fetch against the old names go on failing for a moment after the
		// refetch. Each of those is a fresh report, and without the quiet period each would start
		// another burst — a refetch loop paced by the debounce.
		const { heal, refetch, advance } = harness();
		heal.report();
		await advance(500);
		expect(refetch).toHaveBeenCalledTimes(1);
		for (let i = 0; i < 10; i++) heal.report();
		await advance(2_000);
		expect(refetch, 'still just the one').toHaveBeenCalledTimes(1);
		// ...but a genuinely new rename, later, is still healed.
		await advance(10_000);
		heal.report();
		await advance(500);
		expect(refetch).toHaveBeenCalledTimes(2);
	});

	it('gives up rather than looping when the file is gone rather than renamed', async () => {
		// The unrecoverable case is indistinguishable from the recoverable one at the tile: a purged
		// photo and a rotated one both 404. The refetch returns the same name, the tile fails again,
		// and the only thing stopping that being a request loop for the life of the tab is the cap.
		// A LITERAL cap, not the exported one. Written against STALE_MAX_HEALS this test was
		// vacuous: the loop bound and the expectation both moved with the constant, so it passed
		// just as happily with the cap raised to 99 — or removed altogether — which is the one
		// thing it exists to catch.
		const { heal, refetch, advance } = harness({ maxHeals: 3 });
		for (let attempt = 0; attempt < 9; attempt++) {
			heal.report();
			await advance(500);
			await advance(10_000);   // outlast the quiet period every time
		}
		expect(refetch).toHaveBeenCalledTimes(3);
		expect(heal.spent).toBe(true);
	});

	it('ships with a cap low enough to be a cap', () => {
		// The mechanism working is half of it; the number being small is the other half. An
		// unrecoverable tile costs exactly this many requests before the page stops asking, and
		// "eventually stops" is not the same promise as "stops almost immediately".
		expect(STALE_MAX_HEALS).toBeGreaterThan(1);
		expect(STALE_MAX_HEALS).toBeLessThanOrEqual(5);
	});

	it('a refetch that throws does not wedge it', async () => {
		const { heal, refetch, advance } = harness({ refetch: vi.fn(async () => { throw new Error('offline'); }) });
		void refetch;
		heal.report();
		await advance(500);
		await advance(10_000);
		heal.report();
		await advance(500);
		expect(heal.heals, 'it kept trying, up to the cap').toBe(2);
	});

	it('stop() means stop', async () => {
		const { heal, refetch, advance } = harness();
		heal.report();
		heal.stop();
		await advance(5_000);
		expect(refetch).not.toHaveBeenCalled();
	});

	it('a listener that throws does not stop the others', () => {
		const good = vi.fn();
		const offBad = onStaleMedia(() => { throw new Error('boom'); });
		const offGood = onStaleMedia(good);
		expect(() => reportStaleMedia('/uploads/x.jpg')).not.toThrow();
		expect(good).toHaveBeenCalledWith('/uploads/x.jpg');
		offBad(); offGood();
	});
});

describe('everything that can show a renamed file says so', () => {
	it('the grid fallback reports as well as falling back', () => {
		// Falling back from a missing thumbnail to the original is right for a pre-backfill photo
		// and useless for a rotation, which moves both. The report is what covers the rotation.
		// Reports on the SECOND failure, not the first. A missing thumbnail alone is the ordinary
		// pre-backfill case — the photo is fine, only its derivative was never generated — and
		// reporting that spent the page's whole heal budget on an event where nothing had been
		// renamed and no refetch could help. Both the thumbnail and the original being gone is what
		// a rename looks like, and a missing derivative cannot explain it.
		const fb = UI.slice(UI.indexOf('export function imgFallback'));
		const body = fb.slice(0, fb.indexOf('\n}'));
		// BOTH operands anchored first. indexOf returns -1 for a miss, and -1 is less than every
		// real index, so an unguarded left-hand side turns "the fallback happens before the
		// report" into "the fallback is missing entirely" — and the assertion passes either way.
		// Delete the fallback assignment and this used to stay green while the behaviour it
		// exists for was gone.
		const fallbackAt = body.indexOf('t.src = fullUrl;');
		const reportAt = body.indexOf('reportStaleMedia(');
		expect(fallbackAt, 'the fallback assignment must exist').toBeGreaterThan(-1);
		expect(reportAt, 'the report must exist').toBeGreaterThan(-1);
		expect(fallbackAt).toBeLessThan(reportAt);
		expect(body).toContain('return;');
		expect(UI).toMatch(/export function hidePoster[\s\S]{0,300}?reportStaleMedia\(/);
	});

	it('the lightbox reports too — it used to have no error handling at all', () => {
		expect(LIGHTBOX).toMatch(/<video[\s\S]{0,400}?on:error=\{\(\) => reportStaleMedia\(clipSrc\)\}/);
		expect(LIGHTBOX).toMatch(/<img[\s\S]{0,400}?on:error=\{\(\) => reportStaleMedia\(stillSrc\)\}/);
	});

	it('the gallery listens, heals, and skips the cache while doing it', () => {
		expect(GALLERY).toContain('onStaleMedia(');
		expect(GALLERY).toMatch(/createStaleHeal\(\{ refetch: \(\) => loadPhotos\(\) \}\)/);
		// The whole point: a heal answered from the shared cache returns the same dead names.
		expect(GALLERY).toMatch(/\$: skipCache = heartsDirty \|\| rotateDirty \|\| knownLocked \|\| staleDirty;/);
		// And it must let go — a listener left in the set after the page is gone holds the
		// component alive and heals a gallery nobody is looking at.
		expect(GALLERY).toContain('stopStaleWatch?.();');
		expect(GALLERY).toContain('staleHeal.stop();');
	});
});
