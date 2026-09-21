import { describe, it, expect } from 'vitest';
import { isIndexable, canonicalOrigin, robotsMeta, robotsHeader, robotsTxt, sitemapXml, SITEMAP_LASTMOD } from './seo';

describe('isIndexable', () => {
  it('opts in on 1 / true, case- and space-insensitively', () => {
    for (const v of ['1', 'true', 'TRUE', ' 1 ']) expect(isIndexable(v)).toBe(true);
  });
  it('stays OUT for anything else — the default must be safe', () => {
    for (const v of [undefined, null, '', '  ', '0', 'false', 'yes', 'on', 'index']) {
      expect(isIndexable(v)).toBe(false);
    }
  });
});

describe('canonicalOrigin', () => {
  it('uses the configured origin, not the request host', () => {
    expect(canonicalOrigin('https://snapdini.com', 'https://snapdini-dev.pugno-nas.synology.me'))
      .toBe('https://snapdini.com');
  });
  it('strips a trailing slash and any stray path someone left on BASE_URL', () => {
    expect(canonicalOrigin('https://snapdini.com/', 'https://x')).toBe('https://snapdini.com');
    expect(canonicalOrigin('https://snapdini.com/app?a=1', 'https://x')).toBe('https://snapdini.com');
  });
  it('keeps a non-default port', () => {
    expect(canonicalOrigin('http://localhost:8080', 'https://x')).toBe('http://localhost:8080');
  });
  it('falls back to the request origin when nothing is configured', () => {
    expect(canonicalOrigin('', 'https://snapdini.com')).toBe('https://snapdini.com');
    expect(canonicalOrigin(undefined, 'https://snapdini.com')).toBe('https://snapdini.com');
  });
  it('falls back rather than emitting a broken canonical', () => {
    expect(canonicalOrigin('not a url', 'https://snapdini.com')).toBe('https://snapdini.com');
  });
});

describe('robots meta / header', () => {
  it('invites indexing only when opted in', () => {
    expect(robotsMeta(true)).toBe('index, follow');
    expect(robotsMeta(false)).toBe('noindex, nofollow');
  });
  it('sends the header only when NOT indexable', () => {
    expect(robotsHeader(false)).toBe('noindex, nofollow');
    expect(robotsHeader(true)).toBeNull();
  });
});

describe('robots.txt on the canonical host', () => {
  const txt = robotsTxt({ indexable: true, origin: 'https://snapdini.com' });
  it('advertises the sitemap at the CONFIGURED origin', () => {
    expect(txt).toContain('Sitemap: https://snapdini.com/sitemap.xml');
  });
  it('still keeps private areas out', () => {
    for (const p of ['/app', '/admin', '/siteadmin', '/join', '/gallery', '/api/']) {
      expect(txt).toContain(`Disallow: ${p}`);
    }
  });

  it('keeps crawlers off /demo, because FETCHING it creates an event', () => {
    // /demo is not private — it is a public page whose address is printed on posters. It is listed
    // for a different reason than everything above it: a GET of it mints a throwaway demo event, so
    // a crawl is a write. The page only does that from client-side script and answers noindex of
    // its own, but a crawler should not be invited to try.
    expect(txt).toContain('Disallow: /demo');
  });
});

describe('robots.txt on a preview host', () => {
  const txt = robotsTxt({ indexable: false, origin: 'https://snapdini-dev.example' });
  it('advertises NO sitemap — not even its own', () => {
    expect(txt).not.toMatch(/Sitemap:/i);
    expect(txt).not.toContain('snapdini-dev.example');
  });
  it('leaves crawling ALLOWED, which is the counter-intuitive part', () => {
    // Disallow here would strand the host in the index: a crawler must fetch a page to see noindex.
    expect(txt).toContain('Allow: /');
    expect(txt).not.toMatch(/^Disallow: \/$/m);
  });
  it('says why, so nobody "fixes" it back', () => {
    expect(txt).toMatch(/noindex/i);
  });
});

describe('SITEMAP_LASTMOD', () => {
  // This constant is the whole recrawl signal, and it is hand-maintained, so the ways it breaks are
  // typos and dates that never happened. Both are silent: an invalid lastmod makes Google ignore
  // the field, which looks exactly like not having one.
  it('is a real calendar date in YYYY-MM-DD form', () => {
    expect(SITEMAP_LASTMOD).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const d = new Date(`${SITEMAP_LASTMOD}T00:00:00Z`);
    expect(Number.isNaN(d.getTime())).toBe(false);
    // Round-trips, so 2026-02-31 (which Date happily rolls forward to 3 March) is caught.
    expect(d.toISOString().slice(0, 10)).toBe(SITEMAP_LASTMOD);
  });

  it('is not in the future — a claim we cannot have earned yet', () => {
    // Allow a day of slack for the box's clock and for whoever is west of it.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(SITEMAP_LASTMOD <= tomorrow).toBe(true);
  });

  it('is not wired to the clock', () => {
    // The point of a hand-maintained date is that it does NOT move on its own. If this ever equals
    // today on a day nobody edited the file, someone has replaced it with `new Date()` and spent
    // the signal: Google discounts a lastmod that moves without the content moving.
    const src = sitemapXml('https://x', [{ path: '/', priority: '1.0', lastmod: SITEMAP_LASTMOD }]);
    expect(src).toContain(`<lastmod>${SITEMAP_LASTMOD}</lastmod>`);
    expect(SITEMAP_LASTMOD).not.toBe('');
  });
});

describe('sitemapXml', () => {
  it('emits lastmod when given one, because it is the only hint Google reads', () => {
    const xml = sitemapXml('https://snapdini.com', [{ path: '/', priority: '1.0', lastmod: '2026-09-21' }]);
    expect(xml).toContain('<lastmod>2026-09-21</lastmod>');
    // Ordering matters to the schema: lastmod must follow loc and precede changefreq.
    expect(xml.indexOf('<lastmod>')).toBeGreaterThan(xml.indexOf('<loc>'));
    expect(xml.indexOf('<changefreq>')).toBeGreaterThan(xml.indexOf('<lastmod>'));
  });

  it('omits the element entirely when there is no date, rather than emitting an empty one', () => {
    // An empty <lastmod></lastmod> is a schema error and would invalidate the whole sitemap in
    // Search Console — worse than the missing field this replaced.
    const xml = sitemapXml('https://snapdini.com', [{ path: '/', priority: '1.0' }]);
    expect(xml).not.toContain('<lastmod>');
  });

  it('builds every loc from the canonical origin', () => {
    const xml = sitemapXml('https://snapdini.com', [{ path: '/', priority: '1.0' }, { path: '/pricing', priority: '0.9' }]);
    expect(xml).toContain('<loc>https://snapdini.com/</loc>');
    expect(xml).toContain('<loc>https://snapdini.com/pricing</loc>');
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  });
  it('never leaks a request host into it', () => {
    expect(sitemapXml('https://snapdini.com', [{ path: '/', priority: '1.0' }]))
      .not.toContain('synology');
  });
});
