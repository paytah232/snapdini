import type { RequestHandler } from './$types';

// robots.txt — index the marketing landing, keep app/admin/private + per-event pages out.
// Origin-aware so it's correct on any domain (dev or prod) without hard-coding.
export const GET: RequestHandler = ({ url }) => {
  const body = `User-agent: *
Allow: /$
Disallow: /app
Disallow: /dashboard
Disallow: /admin
Disallow: /siteadmin
Disallow: /gallery
Disallow: /join
Disallow: /e/
Disallow: /login
Disallow: /signup
Disallow: /contact
Disallow: /api/

Sitemap: ${url.origin}/sitemap.xml
`;
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
