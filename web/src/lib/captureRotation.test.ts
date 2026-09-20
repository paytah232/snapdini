import { describe, it, expect } from 'vitest';
// Vite's ?raw, the same way readonlyClient.test.ts reads this component. Not node:fs — the web
// tsconfig carries no node types, so importing it passes tests and fails svelte-check.
import CAMERA from './components/Camera.svelte?raw';

/* A photo taken with the phone turned sideways used to be stored sideways, and nothing downstream
 * could fix it: canvas captures carry no EXIF, so there is no orientation tag for a viewer to
 * honour. The shutter now turns the frame itself. These guard the parts of that which fail
 * SILENTLY — no error, no crash, just crooked photos nobody notices until an event is over. */
describe('capture rotation', () => {
	it('only accepts extra keys the queue item actually has', () => {
		// The bug this was written for. enqueue() spreads `extra` straight onto the queue item, so a
		// key that is not also a QueueItem field type-checks at the call site, is stored under a name
		// nothing reads, and is dropped. `rotation` vs `captureRotation` did exactly that: it
		// compiled, it built, it uploaded — and the rotation never left the phone.
		const extra = CAMERA.match(/extra\?: \{([^}]*)\}/)?.[1];
		const item = CAMERA.match(/interface QueueItem \{([^}]*)\}/)?.[1];
		expect(extra).toBeTruthy();
		expect(item).toBeTruthy();
		const keys = [...extra!.matchAll(/(\w+)\?:/g)].map((m) => m[1]);
		expect(keys).toContain('captureRotation');
		for (const k of keys) expect(item).toMatch(new RegExp(`\\b${k}\\?:`));
	});

	it('turns the picture WITH the phone, not against it', () => {
		// glyphRotation() is expressed as the counter-rotation the HUD glyphs need, so the image takes
		// its negation. Losing the minus sign does not break anything visibly at the shutter — it just
		// lands every corrected photo a half-turn out.
		expect(CAMERA).toMatch(/const rot = -glyphRotation\(\);/);
	});

	it('swaps the canvas axes on a quarter turn', () => {
		// A no-op while every offered shape is square, which is precisely why it would go unnoticed
		// until the first non-square aspect cropped to a box of the wrong proportions.
		expect(CAMERA).toMatch(/canvas\.width = Math\.round\(turned \? sh : sw\)/);
		expect(CAMERA).toMatch(/canvas\.height = Math\.round\(turned \? sw : sh\)/);
	});

	it('mirrors the selfie in OUTPUT space — written before the turn, applied after it', () => {
		// This assertion was originally the wrong way round, and it pinned a real bug rather than
		// catching one: a sideways selfie was saved a half turn out, and this test defended it.
		//
		// Canvas transforms apply to the draw in the reverse of source order, so the mirror must be
		// written FIRST to be applied LAST. The reason it has to be applied last is that reflection
		// ANTI-commutes with rotation — R(t)·mirror = mirror·R(-t) — so mirroring in frame space and
		// then turning sends the picture the opposite way round the clock from the rear camera, for
		// the very same `rot`. Order here is a correctness property, not a style choice.
		const mirrorAt = CAMERA.indexOf("if (facing === 'user') ctx.scale(-1, 1);");
		const rotateAt = CAMERA.indexOf('if (rot !== 0) ctx.rotate(');
		expect(mirrorAt).toBeGreaterThan(-1);
		expect(rotateAt).toBeGreaterThan(mirrorAt);
	});

	it('swaps the canvas axes on a QUARTER turn only', () => {
		// A half turn keeps width and height; only a quarter exchanges them. `rot !== 0` was true for
		// 180 as well, which is unreachable while glyphRotation() returns 0 or ±90 but is wrong the
		// moment anything else can turn the frame.
		expect(CAMERA).toMatch(/const turned = rot === 90 \|\| rot === -90;/);
	});

	it('reports the turn on both upload paths', () => {
		// Two paths exist — single-shot POST and the chunked one for big files — and a clip or a photo
		// on a poor connection takes the second. Fixing only the first would correct small uploads and
		// quietly leave large ones crooked.
		expect(CAMERA).toMatch(/form\.append\('captureRotation'/);
		expect(CAMERA).toMatch(/captureRotation: item\.captureRotation/);
	});

	it('re-asks for tilt on a restored session, and only when nothing is known', () => {
		// iOS grants DeviceOrientation only from a user gesture, and the Join tap is where it is asked.
		// A remembered guest never taps Join, so their tilt stayed dead — which now costs the rotation
		// itself, not just the upright glyphs. Guarded on tiltKnown() so a phone already reporting is
		// never prompted.
		expect(CAMERA).toMatch(/tiltAsked \|\| tiltKnown\(\)/);
		expect(CAMERA).toMatch(/on:pointerdown=\{ensureTilt\}/);
	});
});
