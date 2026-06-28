import type { RequestHandler } from './$types';
import { useCaseSlugs } from '$lib/usecases';

// sitemap.xml — public, indexable marketing pages only. Origin-aware.
export const GET: RequestHandler = ({ url }) => {
  // Homepage (priority 1.0) + the use-case landing pages (0.8).
  const pages: { path: string; priority: string }[] = [
    { path: '/', priority: '1.0' },
    ...useCaseSlugs.map((slug) => ({ path: `/${slug}`, priority: '0.8' })),
  ];
  const urls = pages
    .map(({ path, priority }) => `  <url>\n    <loc>${url.origin}${path}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>${priority}</priority>\n  </url>`)
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
};
