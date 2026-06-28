import type { RequestHandler } from './$types';

// sitemap.xml — public, indexable marketing pages only. Origin-aware.
export const GET: RequestHandler = ({ url }) => {
  const pages = ['/'];
  const urls = pages
    .map((p) => `  <url>\n    <loc>${url.origin}${p}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>`)
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
};
