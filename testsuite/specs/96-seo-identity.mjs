// Snapdini integration spec — 'SEO identity: exactly one host may claim to be the original'.
//
// The bug this guards: every SEO tag was built from the REQUEST host, so the dev deployment served
// `canonical: <itself>` and `robots: index, follow`. Google saw two identical self-declared
// originals, picked the dev one, and demoted the real homepage to a duplicate.
//
// So rather than hard-coding which host this is, the spec reads what the deployment CLAIMS and then
// insists every signal agrees. Mixed signals are the actual defect — a page saying "index me" while
// the header says otherwise, or a sitemap advertised on a host that answers noindex.
import { BASE, dbq, group, ok, spec } from '../lib/harness.mjs';

const get = async (p) => {
  const r = await fetch(`${BASE}${p}`, { redirect: 'manual' });
  return { status: r.status, header: r.headers.get('x-robots-tag'), body: await r.text() };
};
const attr = (html, re) => (re.exec(html) || [])[1] || '';

await spec('96-seo-identity', async () => {
  group('SEO identity: exactly one host may claim to be the original');
  {
    const home = await get('/');
    const robots = await get('/robots.txt');
    const sitemap = await get('/sitemap.xml');
    const pricing = await get('/pricing');

    // What does this deployment claim? The header is the authority; everything must match it.
    const suppressed = /noindex/i.test(home.header || '');
    ok('the homepage renders', home.status === 200, `status ${home.status}`);

    const homeMeta = attr(home.body, /<meta name="robots" content="([^"]*)"/);
    const priceMeta = attr(pricing.body, /<meta name="robots" content="([^"]*)"/);
    ok('every indexable page agrees with the header',
      /noindex/i.test(homeMeta) === suppressed && /noindex/i.test(priceMeta) === suppressed,
      `header=${home.header} home="${homeMeta}" pricing="${priceMeta}"`);

    if (suppressed) {
      // A non-canonical deployment must not invite or enable discovery…
      ok('a suppressed host serves no sitemap', sitemap.status === 404, `status ${sitemap.status}`);
      ok('and advertises none in robots.txt', !/sitemap:/i.test(robots.body), robots.body.slice(0, 120));
      // …but must remain CRAWLABLE, or the noindex above can never be read.
      ok('yet leaves crawling allowed, so the noindex can be seen',
        !/^Disallow:\s*\/\s*$/mi.test(robots.body), robots.body.slice(0, 200));
      ok('and explains itself so nobody reverts it', /noindex/i.test(robots.body));
    } else {
      ok('the canonical host serves a sitemap', sitemap.status === 200, `status ${sitemap.status}`);
      ok('and advertises it', /sitemap:/i.test(robots.body));
      ok('while still keeping private areas out',
        ['/app', '/admin', '/api/'].every((p) => robots.body.includes(`Disallow: ${p}`)));
    }

    // The canonical must come from configuration, so it is the SAME host the sitemap uses — a
    // mismatch is exactly what "built from the request host" produced.
    const canon = attr(home.body, /<link rel="canonical" href="([^"]*)"/);
    const ogUrl = attr(home.body, /<meta property="og:url" content="([^"]*)"/);
    ok('the homepage declares a canonical', !!canon, canon);
    ok('canonical and og:url agree', canon === ogUrl, `${canon} vs ${ogUrl}`);
    const canonHost = canon ? new URL(canon).host : '';
    if (!suppressed) {
      const firstLoc = attr(sitemap.body, /<loc>([^<]*)<\/loc>/);
      ok('the sitemap uses that same host', firstLoc && new URL(firstLoc).host === canonHost,
        `${firstLoc} vs ${canon}`);
      ok('robots.txt points at that same host too', robots.body.includes(`Sitemap: ${canon.replace(/\/$/, '')}/sitemap.xml`),
        robots.body.split('\n').filter((l) => /sitemap/i.test(l)).join(''));
    }

    // Per-event pages are social previews, not canonicals, and must stay out of the index either way.
    ok('per-event routes remain disallowed', ['/join', '/gallery', '/e/'].every((p) => robots.body.includes(p)) || suppressed);
  }
}, {});
