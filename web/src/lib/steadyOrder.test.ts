import { describe, expect, it } from 'vitest';
import REVIEW from '../routes/admin/[code]/review/+page.svelte?raw';

/* A rule that has to beat `.btn` has to be written to beat `.btn`.
 *
 * The bug this came from: `.steady { display: grid }` sat ABOVE `.btn { display: inline-block }`
 * in the same component stylesheet. One class each, so specificity tied and source order decided
 * it — `.btn` won, the grid never existed, and the two stacked labels fell back to inline flow
 * side by side. `visibility: hidden` still reserves a box, so the visible word was pushed
 * off-centre by exactly the width of its hidden twin.
 *
 * It looked like a centring problem, so centring properties were added to it. Twice. To a rule
 * that was not applying. Nothing about the symptom pointed at the cascade.
 *
 * The rule below is narrow enough to be checkable and broad enough to be worth having: if a class
 * is only ever used ON a `.btn`, and it sets `display`, it must name `.btn` in its own selector.
 * Then it wins on specificity and no later edit can reorder it back into silence. */
function styleBlock(src: string): string {
	const m = src.match(/<style[^>]*>([\s\S]*)<\/style>/);
	expect(m, 'component has a <style> block').toBeTruthy();
	// Comments out FIRST. The rule scanner below anchors each rule on the previous `}`, and this
	// stylesheet explains nearly everything it does — a commented rule would simply not be seen,
	// which is how the first version of this test passed while the bug was reintroduced under it.
	return m![1].replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Every static class list in the markup, as arrays of class names. */
function classLists(src: string): string[][] {
	const out: string[][] = [];
	for (const m of src.matchAll(/class="([^"{}]+)"/g)) out.push(m[1].trim().split(/\s+/));
	return out;
}

describe('cascade: display overrides on button classes', () => {
	it('any class that sets display and only ever rides on a .btn must say .btn itself', () => {
		const css = styleBlock(REVIEW);
		const lists = classLists(REVIEW);

		// Bare single-class rules that set `display`, e.g. `.steady { display: grid; ... }`.
		const setsDisplay = new Set<string>();
		for (const m of css.matchAll(/(^|\})\s*\.([a-zA-Z][\w-]*)\s*\{([^}]*)\}/g)) {
			if (/(^|[;{\s])display\s*:/.test(m[3])) setsDisplay.add(m[2]);
		}

		const offenders: string[] = [];
		for (const cls of setsDisplay) {
			if (cls === 'btn') continue;
			const users = lists.filter((l) => l.includes(cls));
			if (!users.length) continue;
			// Only interested in classes that live exclusively on buttons.
			if (!users.every((l) => l.includes('btn'))) continue;
			if (!new RegExp(`\\.btn\\.${cls}\\b|\\.${cls}\\.btn\\b`).test(css)) offenders.push(cls);
		}

		expect(offenders, `write these as .btn.<class> so they beat .btn's own display`).toEqual([]);
	});

	it('the two labels of an armed button are stacked, not laid side by side', () => {
		const css = styleBlock(REVIEW);
		// Same cell, so the button keeps one label's width and the second tap lands where the first
		// one did. Without the grid above actually applying, this line is decoration.
		expect(css).toMatch(/\.steady\s+\.lbl\s*\{[^}]*grid-area:\s*1\s*\/\s*1/);
		expect(css).toMatch(/\.steady\s+\.lbl\.off\s*\{[^}]*visibility:\s*hidden/);
	});
});
