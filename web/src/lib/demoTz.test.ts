import { describe, expect, it } from 'vitest';
import EVENTS_API from './events?raw';
import DEMO_PAGE from '../routes/demo/+page.svelte?raw';
import LANDING from '../routes/+page.svelte?raw';
import UPGRADE from './components/UpgradePanel.svelte?raw';

const code = (s: string) =>
	s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

/* A demo with no timezone stores an ambiguous wall clock.
 *
 * Every demo ever created carried NULL — 59 of the 74 events on production, and every one of those
 * a demo. The admin settings form then read that start as UTC and wrote it back in the browser's
 * zone: ten hours apart from Brisbane. The server saw a reschedule nobody had asked for, refused,
 * and the refusal threw away the whole save — name, blurb, every toggle.
 *
 * Both sides of that are fixed, but the ambiguity was what made it possible, and the demo is the
 * surface where it mattered most: it is what somebody tries BEFORE they buy. */
describe('a demo is created with a real timezone', () => {
	it('every caller sends one — there are three, and two bypass the helper', () => {
		// createDemo() is the obvious one. The landing page and /demo both POST the endpoint
		// directly, so fixing only the helper would have left the two highest-traffic paths still
		// minting null-timezone demos.
		expect(code(EVENTS_API)).toMatch(/createDemo = \(\) =>[\s\S]{0,200}timezone: demoTimezone\(\)/);
		for (const [name, src] of [['/demo', DEMO_PAGE], ['the landing page', LANDING]] as const) {
			expect(code(src), `${name} must send a timezone`).toMatch(/\/api\/events\/demo['"],\s*\{\s*timezone: demoTimezone\(\)\s*\}/);
			expect(code(src), `${name} must import it`).toMatch(/import \{[^}]*demoTimezone[^}]*\} from '\$lib\/events'/);
		}
	});

	it('and never throws trying to read it', () => {
		// Intl can be absent or refuse in odd embedded browsers, and a demo that cannot start
		// because of a timezone lookup would be a worse bug than the one being fixed.
		const fn = code(EVENTS_API).slice(code(EVENTS_API).indexOf('demoTimezone = ()'));
		expect(fn.slice(0, 200)).toMatch(/try \{[\s\S]*?\} catch \{ return 'UTC'; \}/);
	});
});

describe('the frame pack is a switch, not a tick', () => {
	it('uses the shared Toggle', () => {
		// Toggle.svelte's own note says frame SHAPES stay checkboxes — that is the 1:1 / 4:5 list,
		// where each box is one answer to a single question. This is one feature, on or off, which
		// is what that component says a toggle is for. It was a checkbox only because the toggle
		// did not exist when this panel was written.
		expect(UPGRADE).toContain("import Toggle from '$lib/components/Toggle.svelte'");
		expect(code(UPGRADE)).toMatch(/<Toggle id="u-frames" bind:checked=\{uFrames\} \/>/);
		expect(code(UPGRADE), 'the old checkbox must be gone').not.toMatch(/type="checkbox"[^>]*bind:checked=\{uFrames\}/);
	});

	it('is still labelled, and the label still drives it', () => {
		// The toggle hides its own input, so the <label for> IS the second hit target. Losing the
		// association would leave a switch with no accessible name and a caption that does nothing.
		expect(code(UPGRADE)).toMatch(/<label for="u-frames">Unlock all frame sizes \(frame pack\)/);
	});
});
