import { describe, expect, it } from 'vitest';
import src from '../routes/gallery/[code]/+page.svelte?raw';
import { REVEAL_MAX_ATTEMPTS, jitterMs, revealPadMs, revealRetryDelayMs } from './revealWatch';

/* What the wall says between the counter hitting zero and the photos landing.
 *
 * That gap is not a rounding error. Worst case it is the skew pad, plus up to 12s of anti-herd
 * jitter, plus a round trip, plus up to 30s of shared cache in front of the answer — approaching a
 * minute in which the page is working correctly and looks like it has hung. The old wall showed a
 * frozen 00:00:00 and the single word "Unlocking…", and a host testing it reasonably read that as
 * broken.
 *
 * These are source assertions because the thing under test is a state that only exists for about a
 * minute, on a timer, behind a cache. */
describe('the gap between zero and the photos', () => {
	it('has a name, and it is the locked side of the crossing', () => {
		// Every condition matters. `!revealed` is what makes it switch itself off; `at_end` keeps it
		// away from manual reveals, which have no zero to be past.
		expect(src).toMatch(
			/\$: pastZero = !revealed && !awaitingHost && revealMode === 'at_end' && !!revealAt && remaining === 0;/
		);
	});

	it('promises nothing while the host is holding the photos back', () => {
		// "Hide all photos" beats the clock — isRevealed() checks it first and says no even for an
		// at_end event that has already ended. The event keeps its mode and its instant either way,
		// so the payload says `at_end` with a live revealAt AND awaitingHost at the same time.
		//
		// Without `!awaitingHost` this page counted down to a moment that was going to do nothing,
		// and then put a spinner up promising a delivery nobody had authorised. A host hides photos
		// exactly when they do not want them seen, and telling their guests the photos are on the
		// way is worse than telling them nothing — there is a true thing to say instead, and the
		// wall already says it.
		expect(src).toMatch(/\$: pastZero = !revealed && !awaitingHost\b/);
		// The clock goes with it, or the wall carries two contradictory answers at once and the
		// bigger, more confident one is the false one.
		expect(src).toMatch(/\{:else if revealMode === 'at_end' && revealAt && !awaitingHost\}/);
	});

	it('swaps the padlock for something that moves', () => {
		// A padlock is a claim about state, and past zero it is the wrong claim: the gate is open and
		// this is a delivery. Motion is the only thing on the page distinguishing "fetching" from
		// "stuck", which is the entire complaint being fixed.
		const wall = src.slice(src.indexOf('<div class="reveal-wall">'));
		const body = wall.slice(0, wall.indexOf('</div>'));
		expect(body).toContain('{#if pastZero}');
		expect(body).toContain('<span class="spin"');
		expect(body).toContain('<span class="lock"');
		// The spin has to be an actual animation, not a styled circle.
		expect(src).toMatch(/\.spin\s*\{[^}]*animation:\s*spin/);
		expect(src).toMatch(/@keyframes spin/);
	});

	it('keeps saying something under reduced motion rather than going still', () => {
		// A motionless ring is worse than no ring: it says "stuck" more loudly than an empty wall.
		const rm = src.slice(src.indexOf('@media (prefers-reduced-motion: reduce)'));
		expect(rm.slice(0, 400)).toMatch(/\.spin\s*\{[^}]*animation:\s*pulse/);
	});

	it('tells the guest not to refresh, in both the quick and the slow case', () => {
		// Refreshing is what everyone does to a page that looks stuck, and on a shared-cached reply
		// it is the one action that can make it slower.
		const wall = src.slice(src.indexOf('{#if pastZero}'));
		const arriving = wall.slice(wall.indexOf('<p class="arriving">'), wall.indexOf('{:else if'));
		expect(arriving).toContain('slowArrival');
		expect((arriving.match(/No need to refresh\./g) ?? []).length, 'both branches say it').toBe(2);
	});

	it('stops promising "any second now" once the crossing watcher has given up', () => {
		// The threshold is not a round number picked for feel: it has to sit past the point where the
		// crossing watcher has spent every attempt and handed over to the 45s poll. Derived here from
		// the watcher's own constants so the two cannot drift apart — if someone adds an attempt or
		// lengthens the pad, this fails rather than quietly becoming a lie.
		const m = src.match(/\$: slowArrival = sinceZero > (\d+(?:_\d+)*);/);
		expect(m, 'slowArrival has a threshold').toBeTruthy();
		const threshold = Number(m![1].replace(/_/g, ''));

		// rand = 1 is the unluckiest client there is: the longest pad, and the longest roll on every
		// retry. Feeding the real functions rather than re-deriving their arithmetic is the whole
		// point — a change to the pad, the spread, the backoff or the attempt count lands here by
		// itself instead of quietly turning this threshold into a lie.
		let spent = revealPadMs(1);
		for (let n = 1; n < REVEAL_MAX_ATTEMPTS; n++) spent += jitterMs(revealRetryDelayMs(n), 1);
		expect(threshold, `watcher can still be trying at ${spent}ms`).toBeGreaterThanOrEqual(spent);
	});
});
