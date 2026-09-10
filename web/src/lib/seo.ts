// Which host is allowed to say "I am the original".
//
// Every SEO tag used to be built from the REQUEST host — the comment on robots.txt even called that
// a feature ("correct on any domain, dev or prod"). It is the opposite. It meant the dev deployment
// served `canonical: <itself>` and `robots: index, follow`, so Google saw two identical pages each
// declaring itself the master copy, picked the dev one, and demoted the real homepage to a
// duplicate. A preview host cannot be trusted to describe itself.
//
// So: the canonical origin comes from configuration (ORIGIN, i.e. BASE_URL), and indexability is an
// explicit opt-in. Default OFF, which is the whole point — the next preview host suppresses itself
// without anyone remembering to do anything.
//
// Pure and framework-free so it is unit-testable (seo.test.ts).

/** Only `1`/`true` opts a deployment in. Anything else — unset, empty, typo — stays out. */
export function isIndexable(flag: string | null | undefined): boolean {
  const v = (flag || '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * The origin every canonical/og:url on an indexable page must use. Falls back to the request
 * origin only when nothing is configured, so a misconfigured deployment still emits valid absolute
 * URLs rather than `undefined/pricing`.
 */
export function canonicalOrigin(configured: string | null | undefined, requestOrigin: string): string {
  const c = (configured || '').trim().replace(/\/+$/, '');
  if (!c) return requestOrigin;
  try {
    const u = new URL(c);
    return u.origin;                    // strips any path/query someone left on BASE_URL
  } catch {
    return requestOrigin;               // unparseable ⇒ don't emit a broken canonical
  }
}

/** The `<meta name="robots">` value. */
export const robotsMeta = (indexable: boolean): string =>
  indexable ? 'index, follow' : 'noindex, nofollow';

/** The `X-Robots-Tag` header value, or null when none should be sent. */
export const robotsHeader = (indexable: boolean): string | null =>
  indexable ? null : 'noindex, nofollow';

/**
 * robots.txt.
 *
 * The non-indexable case is deliberately still CRAWLABLE. A crawler has to fetch the page to see
 * the noindex, so `Disallow: /` here would strand a preview host in the index forever — the exact
 * trap that makes this bug hard to undo. What it does not do is advertise a sitemap, so nothing
 * invites discovery of URLs on a host that should not be in the index at all.
 */
export function robotsTxt(opts: { indexable: boolean; origin: string }): string {
  const blocked = ['/app', '/dashboard', '/admin', '/siteadmin', '/gallery', '/join', '/e/', '/login',
                   '/signup', '/contact', '/api/'];
  if (!opts.indexable) {
    return [
      '# This deployment is not the canonical site (SEO_INDEXABLE is not set).',
      '# Crawling is still allowed ON PURPOSE: every page here answers "noindex", and a crawler',
      '# must be able to fetch it to see that. Blocking it instead would leave this host stuck in',
      '# the index with no way to tell anyone to drop it.',
      'User-agent: *',
      'Allow: /',
      '',
    ].join('\n');
  }
  return ['User-agent: *', 'Allow: /$', ...blocked.map((p) => `Disallow: ${p}`), '',
          `Sitemap: ${opts.origin}/sitemap.xml`, ''].join('\n');
}

/** The sitemap body for an indexable deployment. Non-indexable ones must not serve one at all. */
export function sitemapXml(origin: string, pages: { path: string; priority: string }[]): string {
  const urls = pages
    .map(({ path, priority }) =>
      `  <url>\n    <loc>${origin}${path}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>${priority}</priority>\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
