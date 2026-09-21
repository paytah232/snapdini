import { describe, expect, it } from 'vitest';
import ADMIN from '../routes/admin/[code]/+page.svelte?raw';
import POSTER from './components/PosterModal.svelte?raw';

/** The script block with prose removed — these assertions are about code, and this file's
 *  comments quote the code they explain. Four source-shape tests in this repo have already been
 *  found matching an explanation rather than a statement. */
const code = (src: string) =>
	src.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

/** The balanced `{…}` block that follows `head`, so an assertion can be about what is INSIDE it
 *  rather than about text that merely appears somewhere after it.
 *
 *  Written because the first version of the cog test used a lazy regex spanning from the guard to
 *  the call, and a sabotage that put `return;` FIRST — restoring the exact bug — still matched it.
 *  A test that cannot tell the fixed form from the broken one is not a test, and this file was
 *  added to stop precisely that kind of regression coming back. */
function blockAfter(src: string, head: string): string {
	const at = src.indexOf(head);
	if (at < 0) return '';
	let i = src.indexOf('{', at), depth = 0;
	for (let k = i; k < src.length; k++) {
		if (src[k] === '{') depth++;
		else if (src[k] === '}' && --depth === 0) return src.slice(i + 1, k);
	}
	return '';
}

describe('saving event settings does not invent a reschedule', () => {
	const ADMIN_CODE = code(ADMIN);

	it('compares the start FIELDS, not a recomputed instant', () => {
		// The form loaded the start with `e.timezone || 'UTC'` and saved it with
		// `e.timezone || <the browser's zone>`. For the 59 of 74 events with no stored timezone
		// those disagree by the host's whole UTC offset — ten hours from Brisbane — so every save
		// told the server the start had moved ten hours. The server refused, and refusing meant
		// rejecting the WHOLE payload: name, blurb, every toggle.
		//
		// The fields are what the host actually touched and need no timezone to interpret.
		expect(ADMIN_CODE).toMatch(/\$: startFieldsUntouched = !!hydratedStart/);
		expect(ADMIN_CODE).toMatch(/sDate === hydratedStart\.date && sTime === hydratedStart\.time && sTimezone === hydratedStart\.tz/);
		expect(ADMIN_CODE).toMatch(/hydratedStart = \{ date: sDate, time: sTime, tz: sTimezone \}/);
	});

	it('sends no start at all when the host did not touch it', () => {
		// Both doors. The server falls back to parsing startDate/startTime when there is no epoch,
		// so omitting only `startsAt` would recreate the same phantom reschedule through the other.
		expect(ADMIN_CODE).toMatch(/const startsAt = \(startFieldsUntouched \|\| !sDate\)\s*\n?\s*\?\s*undefined/);
		expect(ADMIN_CODE).toMatch(/\.\.\.\(startFieldsUntouched \? \{\} : \{ startsAt, startDate: sDate, startTime: sTime \}\)/);
	});

	it('tells the host when only the start was refused, and puts the field back', () => {
		// The second half of the complaint: edits stayed on screen looking applied until a reload
		// silently took them back.
		expect(ADMIN_CODE).toMatch(/saved\?\.startRefused/);
		expect(ADMIN_CODE).toMatch(/hydratedStart = \{ date: sDate, time: sTime, tz: sTimezone \};[\s\S]{0,80}\}/);
	});
});

describe('a cog is answered even when its controls are already on screen', () => {
	const POSTER_CODE = code(POSTER);

	it('the poster wizard does not eat the press', () => {
		// `if (n === pStep) return;` made the answer depend on where the controls happened to live.
		// From step 1 the QR cog worked (controls on step 3) and the message cog did nothing
		// (controls on step 1) — so the feature looked randomly broken rather than broken in a
		// pattern. A cog is a request to be SHOWN something, and it had already been granted.
		const fn = POSTER_CODE.slice(POSTER_CODE.indexOf('async function goPStep'));
		const body = fn.slice(0, fn.indexOf('\n  async function'));
		const guard = blockAfter(body, 'if (n === pStep)');
		expect(guard, 'the already-here branch must exist').toContain('arriveAtStep(true, ring)');
		// ORDER, inside the branch: a `return` before the call is the original bug exactly, and a
		// lazy regex across the whole branch happily matched that too.
		const call = guard.indexOf('arriveAtStep(true, ring)');
		const ret = guard.indexOf('return;');
		expect(call).toBeGreaterThan(-1);
		expect(ret, 'the branch still returns').toBeGreaterThan(-1);
		expect(call, 'it must answer the cog BEFORE returning').toBeLessThan(ret);
		expect(guard, 'and only for a cog, not a bare strip press').toContain('if (force)');
	});

	it('and neither does the card wizard, by either route to "already there"', () => {
		// The card flow can arrive at the current step twice: asked for outright, or asked for a
		// skipped step that resolves back to it.
		const fn = POSTER_CODE.slice(POSTER_CODE.indexOf('async function goCStep'));
		const body = fn.slice(0, fn.indexOf('\n  function cNav'));
		for (const head of ['if (n === cStep)', 'if (target === cStep)']) {
			const guard = blockAfter(body, head);
			expect(guard, `${head} must answer a cog`).toContain('arriveAtStep(true, ring)');
			expect(guard.indexOf('arriveAtStep(true, ring)'),
				`${head} must answer before returning`).toBeLessThan(guard.indexOf('return;'));
			// A bare strip press on the current step stays a no-op — pressing the step you are on
			// is not a request to be shown anything.
			expect(guard).toContain('if (force)');
		}
	});
});
