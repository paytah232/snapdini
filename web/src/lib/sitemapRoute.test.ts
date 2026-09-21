// The sitemap.xml route — asserted against the XML it actually emits.
//
// seo.test.ts covers `sitemapXml` as a function: given pages, correct XML. What it cannot see is
// the page list the route hands it, and that is where this went wrong — the route built every entry
// without a `lastmod`, so the XML was valid, the unit tests passed, and Search Console had no
// reason to recrawl anything. The bug lived in the caller, so the caller is what this renders.
//
// `$env/dynamic/private` is mocked the way hooks.server.test.ts mocks it; `./$types` is a
// type-only import and erases, so the route loads with nothing else stubbed.
import { describe, it, expect, vi } from 'vitest';
import { SITEMAP_LASTMOD } from './seo';
import { useCaseSlugs } from './usecases';

vi.mock('$env/dynamic/private', () => ({
  env: { SEO_INDEXABLE: '1', ORIGIN: 'https://snapdini.com' },
}));

/** Render the route exactly as SvelteKit would, and hand back the body. */
async function render(): Promise<{ status: number; xml: string }> {
  const { GET } = await import('../routes/sitemap.xml/+server');
  const res = (await (GET as (e: unknown) => Promise<Response>)({
    url: new URL('https://snapdini.com/sitemap.xml'),
  })) as Response;
  return { status: res.status, xml: await res.text() };
}

describe('the sitemap route, rendered', () => {
  it('puts a lastmod on EVERY url, not just some', async () => {
    const { xml } = await render();
    const locs = (xml.match(/<loc>/g) ?? []).length;
    const mods = (xml.match(/<lastmod>/g) ?? []).length;
    expect(locs).toBeGreaterThan(0);
    expect(mods).toBe(locs);                     // the actual bug: locs > 0, mods === 0
    expect(xml).toContain(`<lastmod>${SITEMAP_LASTMOD}</lastmod>`);
  });

  it('lists the landing pages, the use-case pages, and the two legal pages', async () => {
    const { xml } = await render();
    for (const p of ['/', '/pricing', '/privacy', '/terms']) {
      expect(xml).toContain(`<loc>https://snapdini.com${p}</loc>`);
    }
    for (const slug of useCaseSlugs) {
      expect(xml).toContain(`<loc>https://snapdini.com/${slug}</loc>`);
    }
    // Count, so a page silently dropped from the list is caught even if the ones checked survive.
    expect((xml.match(/<loc>/g) ?? []).length).toBe(useCaseSlugs.length + 4);
  });

  it('builds every loc from ORIGIN, never the request host', async () => {
    // A preview host describing itself as canonical is what got a dev clone indexed over the real
    // site. The request URL above is deliberately the same host; what matters is that nothing in
    // the output comes from it.
    const { xml } = await render();
    expect(xml).not.toMatch(/<loc>(?!https:\/\/snapdini\.com)/);
  });

  it('is well-formed XML with lastmod in schema order', async () => {
    const { xml } = await render();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
    // Sitemaps 0.9 fixes the order: loc, lastmod, changefreq, priority. Check it INSIDE one <url>
    // rather than across the document, where indexOf would compare different entries.
    const first = xml.slice(xml.indexOf('<url>'), xml.indexOf('</url>'));
    expect(first.indexOf('<loc>')).toBeLessThan(first.indexOf('<lastmod>'));
    expect(first.indexOf('<lastmod>')).toBeLessThan(first.indexOf('<changefreq>'));
    expect(first.indexOf('<changefreq>')).toBeLessThan(first.indexOf('<priority>'));
    // No empty elements — an empty <lastmod/> invalidates the whole sitemap in Search Console.
    expect(xml).not.toMatch(/<(loc|lastmod|changefreq|priority)>\s*<\//);
  });

  it('parses as XML rather than merely looking like it', async () => {
    // jsdom gives us a real parser. Concatenating strings by hand is exactly the kind of code that
    // produces something that greps fine and fails to parse.
    const { xml } = await render();
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    expect(doc.getElementsByTagName('parsererror').length).toBe(0);
    const urls = doc.getElementsByTagName('url');
    expect(urls.length).toBe(useCaseSlugs.length + 4);
    for (const u of Array.from(urls)) {
      expect(u.getElementsByTagName('lastmod')[0]?.textContent).toBe(SITEMAP_LASTMOD);
    }
  });
});

describe('the sitemap route on a non-canonical deployment', () => {
  it('serves nothing at all', async () => {
    // A preview host publishing a sitemap of its own URLs is how the dev clone got discovered.
    // Re-mocked and re-imported in isolation so the module-level env above does not leak in.
    vi.resetModules();
    vi.doMock('$env/dynamic/private', () => ({ env: { SEO_INDEXABLE: '', ORIGIN: 'https://dev.example' } }));
    const { GET } = await import('../routes/sitemap.xml/+server');
    const res = (await (GET as (e: unknown) => Promise<Response>)({
      url: new URL('https://dev.example/sitemap.xml'),
    })) as Response;
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('<urlset');
    vi.doUnmock('$env/dynamic/private');
    vi.resetModules();
  });
});
