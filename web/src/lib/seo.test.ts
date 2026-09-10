import { describe, it, expect } from 'vitest';
import { isIndexable, canonicalOrigin, robotsMeta, robotsHeader, robotsTxt, sitemapXml } from './seo';

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

describe('sitemapXml', () => {
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
