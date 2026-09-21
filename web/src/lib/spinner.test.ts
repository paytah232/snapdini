import { describe, expect, it } from 'vitest';
import SPINNER from './components/Spinner.svelte?raw';
import ROTATE from './components/RotateControl.svelte?raw';
import CAMERA from './components/Camera.svelte?raw';
import GALLERY from '../routes/gallery/[code]/+page.svelte?raw';
import SHARE from '../routes/s/[token]/+page.svelte?raw';

/* One turning mark, everywhere something is being waited for.
 *
 * The argument was already written down in RotateControl, next to the only spinner that existed:
 * a static ellipsis sitting there for half a minute reads as a hang, and a hang is when somebody
 * presses the button again. Every bulk download had the ellipsis anyway — "Saving 3/12…" through
 * a save that runs for minutes on event wifi, which is exactly the duration that argument was
 * made about.
 *
 * These assertions are mostly about there being ONE of it. Copying six lines of CSS is quicker
 * than a component and is how two spinners drift apart: one picks up prefers-reduced-motion and
 * the other does not, one is sized in em and the other in pixels. */
const SURFACES: [string, string][] = [
	['the camera roll', CAMERA],
	['the event gallery', GALLERY],
	['a share link', SHARE],
];

describe('the wait indicator', () => {
	it('is a spinner on every bulk download, not an ellipsis', () => {
		for (const [name, src] of SURFACES) {
			expect(src, `${name} must import the shared spinner`)
				.toContain("import Spinner from '$lib/components/Spinner.svelte'");
			expect(src, `${name} still shows a turning mark while saving`)
				.toMatch(/\{#if bulkSaving\}<Spinner \/> Saving \{bulkProgress\}/);
			// The ellipsis is what is being removed, so its absence is the actual claim.
			expect(src, `${name} still has the old ellipsis`)
				.not.toMatch(/Saving \{bulkProgress\}…/);
		}
	});

	it('is defined exactly once', () => {
		// The rule lives in Spinner.svelte and nowhere else. RotateControl had the original and
		// kept a private copy until this change; a second definition anywhere is the drift.
		expect(SPINNER).toMatch(/animation:\s*spin/);
		expect(SPINNER).toMatch(/@keyframes spin/);
		expect(ROTATE, 'RotateControl must use the shared component').toContain('<Spinner />');
		expect(ROTATE, 'and must not keep its own copy of the rule').not.toMatch(/\.spin\s*\{/);
		expect(ROTATE).not.toContain('rotspin');
	});

	it('takes the colour and size of whatever it sits in', () => {
		// This is what lets one component work inside a ghost button, a primary button and a
		// danger button without any of them knowing about it. A hardcoded colour or a pixel size
		// would need a variant per caller, which is the other way two spinners appear.
		expect(SPINNER).toMatch(/border:\s*2px solid currentColor/);
		expect(SPINNER).toMatch(/width:\s*1em;\s*height:\s*1em/);
	});

	it('slows under reduced motion rather than stopping', () => {
		// A motionless ring says "stuck" more loudly than no ring at all, and the whole point of
		// the thing is to say work is happening.
		const rm = SPINNER.slice(SPINNER.indexOf('@media (prefers-reduced-motion'));
		expect(rm).toMatch(/animation-duration/);
		expect(rm).not.toMatch(/animation:\s*none/);
	});

	it('does not announce itself over and over', () => {
		// aria-hidden by default: the button already carries aria-busy, and a live region that
		// says "loading" on every frame is worse than silence.
		expect(SPINNER).toContain('aria-hidden={label ? undefined : true}');
		expect(GALLERY).toMatch(/aria-busy=\{bulkSaving \|\| undefined\}/);
	});
});
