import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { isIndexable, robotsTxt, canonicalOrigin, canonicalSetting } from '$lib/seo';

// robots.txt. On the canonical deployment: index the marketing landing, keep app/admin/private and
// per-event pages out. On anything else (a preview host): crawlable but noindex — see $lib/seo for
// why crawling must stay allowed there.
export const GET: RequestHandler = ({ url }) => {
  const indexable = isIndexable(env.SEO_INDEXABLE);
  const origin = canonicalOrigin(canonicalSetting(env.CANONICAL_ORIGIN, env.ORIGIN), url.origin);
  const body = robotsTxt({ indexable, origin });
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
