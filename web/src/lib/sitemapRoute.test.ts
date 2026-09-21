// What the sitemap ROUTE puts in the sitemap.
//
// seo.test.ts covers `sitemapXml` as a function: given pages, it emits correct XML. What it cannot
// see is the page list the route actually hands it, and that list is where this went wrong — the
// route built every entry without a `lastmod`, so the XML was valid, the unit tests passed, and
// Search Console had no reason to recrawl anything. The bug lived in the caller.
//
// The route cannot be imported here: it pulls in `$env/dynamic/private` and `./$types`, neither of
// which exists outside a SvelteKit build. So this reads the source, which is the same approach
// pricingParity.test.ts and the app's csp-report.test.ts take for the same reason.
import { describe, it, expect } from 'vitest';
import SRC from '../routes/sitemap.xml/+server.ts?raw';
import { SITEMAP_LASTMOD } from './seo';
import { useCaseSlugs } from './usecases';

describe('the sitemap route', () => {
	it('stamps a lastmod onto every entry', () => {
		// The `.map` that applies it is the load-bearing line. Asserting on the import alone would
		// pass while the constant sat unused, which is exactly the state this replaced.
		expect(SRC).toContain('SITEMAP_LASTMOD');
		expect(SRC).toMatch(/\.map\(\s*\(p\)\s*=>\s*\(\{\s*\.\.\.p,\s*lastmod:\s*SITEMAP_LASTMOD\s*\}\)\s*\)/);
	});

	it('lists the two legal pages, which robots.txt allows and the sitemap used to omit', () => {
		expect(SRC).toContain("path: '/privacy'");
		expect(SRC).toContain("path: '/terms'");
	});

	it('still lists the landing pages it always did', () => {
		expect(SRC).toContain("path: '/'");
		expect(SRC).toContain("path: '/pricing'");
		// The use-case pages come from `useCaseSlugs`, so the route must spread that rather than
		// hand-list slugs — a hand-list is how a new landing page silently stays out of the sitemap.
		expect(SRC).toContain('useCaseSlugs.map');
		expect(useCaseSlugs.length).toBeGreaterThan(5);
	});

	it('serves nothing at all on a non-canonical deployment', () => {
		// A preview host publishing a sitemap of its own URLs is how a dev clone got itself indexed.
		expect(SRC).toMatch(/if\s*\(!isIndexable\([^)]*\)\)\s*return new Response\([^)]*status:\s*404/);
	});

	it('uses a date that is a real past date', () => {
		// Duplicated deliberately from seo.test.ts: that suite proves the constant is sane, this one
		// proves the thing that ships uses it. Cheap, and it fails loudly if the constant is replaced
		// by an inline string here.
		expect(SITEMAP_LASTMOD).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(SITEMAP_LASTMOD <= new Date().toISOString().slice(0, 10)).toBe(true);
	});
});
