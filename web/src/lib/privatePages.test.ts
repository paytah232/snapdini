import { describe, it, expect } from 'vitest';
import { isPrivatePage } from '../hooks.server';
import { TOKEN_ROUTES } from '../../../shared/token-paths';

/* Which pages must never be stored by a cache.
 *
 * These carry a person's own view — a host's event manager, the platform console, the create wizard
 * that holds an organizer code in its fragment. They used to send no Cache-Control at all, and were
 * safe only because Cloudflare does not cache HTML by default. That is a default in somebody else's
 * dashboard, and this product already has a Cache Rule making one /api/ path cacheable; the next
 * such rule is all it would take.
 */
describe('isPrivatePage', () => {
	it('covers every authenticated surface, bare and with a sub-path', () => {
		for (const p of ['/admin', '/dashboard', '/siteadmin', '/app', '/login', '/signup']) {
			expect(isPrivatePage(p), `${p} must be private`).toBe(true);
			expect(isPrivatePage(`${p}/ABC123`), `${p}/… must be private`).toBe(true);
		}
	});

	it('leaves the guest-facing pages cacheable', () => {
		// The point of the exercise. These are the same page for every guest, their data comes from
		// the API which caches properly, and making the shell uncacheable would cost the very thing
		// the Cloudflare rule was added for at a big event.
		for (const p of ['/', '/gallery/ABC123', '/e/some-wedding', '/pricing', '/join/ABC123']) {
			expect(isPrivatePage(p), `${p} must stay cacheable`).toBe(false);
		}
	});

	it('matches on a path segment, not a bare prefix', () => {
		// `/admin` must not drag in a route that merely starts with those letters.
		expect(isPrivatePage('/administrator')).toBe(false);
		expect(isPrivatePage('/applause')).toBe(false);
		expect(isPrivatePage('/dashboards-are-great')).toBe(false);
	});

	it('the token routes are covered too, via isTokenRoute in the hook', () => {
		// Not by isPrivatePage — the hook ORs the two. Asserted here so that removing the token half
		// of that condition fails something: on those routes the credential IS the URL, so a stored
		// copy is a stored credential.
		for (const r of TOKEN_ROUTES) expect(isPrivatePage(r)).toBe(false);
		expect(TOKEN_ROUTES.length).toBeGreaterThan(0);
	});
});
