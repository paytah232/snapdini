import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { useCaseSlugs } from '$lib/usecases';
import { isIndexable, sitemapXml, canonicalOrigin, SITEMAP_LASTMOD } from '$lib/seo';

// sitemap.xml — public marketing pages only, and ONLY on the canonical deployment. A preview host
// publishing a sitemap of its own URLs is how a dev clone got itself indexed in the first place, so
// a non-canonical deployment serves nothing here at all.
export const GET: RequestHandler = ({ url }) => {
  if (!isIndexable(env.SEO_INDEXABLE)) return new Response('Not found', { status: 404 });
  // `/privacy` and `/terms` are here because they are real, indexable, publicly linked pages that
  // robots.txt does not block — leaving them out of the sitemap while crawling them anyway was just
  // an inconsistency. Low priority: they should be findable, not competing with the landing pages.
  const pages = [
    { path: '/', priority: '1.0' },
    { path: '/pricing', priority: '0.9' },
    ...useCaseSlugs.map((slug) => ({ path: `/${slug}`, priority: '0.8' })),
    { path: '/privacy', priority: '0.3' },
    { path: '/terms', priority: '0.3' },
    // One date for all of them, stamped in one place. See SITEMAP_LASTMOD for why it is not `now`.
  ].map((p) => ({ ...p, lastmod: SITEMAP_LASTMOD }));
  const xml = sitemapXml(canonicalOrigin(env.ORIGIN, url.origin), pages);
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
};
