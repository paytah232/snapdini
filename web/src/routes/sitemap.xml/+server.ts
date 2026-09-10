import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { useCaseSlugs } from '$lib/usecases';
import { isIndexable, sitemapXml, canonicalOrigin } from '$lib/seo';

// sitemap.xml — public marketing pages only, and ONLY on the canonical deployment. A preview host
// publishing a sitemap of its own URLs is how a dev clone got itself indexed in the first place, so
// a non-canonical deployment serves nothing here at all.
export const GET: RequestHandler = ({ url }) => {
  if (!isIndexable(env.SEO_INDEXABLE)) return new Response('Not found', { status: 404 });
  const pages = [
    { path: '/', priority: '1.0' },
    { path: '/pricing', priority: '0.9' },
    ...useCaseSlugs.map((slug) => ({ path: `/${slug}`, priority: '0.8' })),
  ];
  const xml = sitemapXml(canonicalOrigin(env.ORIGIN, url.origin), pages);
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
};
