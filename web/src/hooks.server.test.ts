// Whether a third-party tag is allowed onto a page, tested through the real hook.
//
// The defect: this hook injected gtag and UET on EVERY route with no exclusions, and gtag's
// default page_location is document.location.href. The email preference-centre URL carries a
// 400-day, multi-use bearer token in its path — so opening an unsubscribe link sent that token to
// Google. `/email-preferences` is absent from 1.4.3 and 404s in production, so this never shipped;
// it was in the 1.5.0 diff.
//
// Driven through handle() rather than through a helper, because "the tag is not injected" is a
// property of the hook, not of a predicate it happens to call. $env/dynamic/private is mocked
// because under vitest it resolves empty, which would make every assertion below pass for the
// wrong reason — hence the first test, which proves the tags DO appear when they are allowed to.
import { describe, it, expect, vi } from 'vitest';
import { TOKEN_ROUTES } from '../../shared/token-paths';

vi.mock('$env/dynamic/private', () => ({
  env: { GTAG_ID: 'AW-TEST123456', MSUET_ID: '12345678', SEO_INDEXABLE: '1' },
}));

const HEX64 = '3f7a1c9e5b2d8046af13e79c4d6b28f05e9a7c31bd48620fae5d93c17b8042e6';
const UUID = '7ecd750d-4b62-4391-bfe1-55a205962c39';
const ORGANIZER = 'deadbeefdeadbeefdeadbeefdeadbeef';

const PLACEHOLDER = '%snapdini.analytics%';

/** The <head> the hook produced for this URL. */
async function head(href: string): Promise<string> {
  const { handle } = await import('./hooks.server');
  const url = new URL(href, 'https://snapdini.com');
  let out = PLACEHOLDER;
  await (handle as unknown as (a: unknown) => Promise<Response>)({
    event: { request: new Request(url), url },
    resolve: (_e: unknown, opts?: { transformPageChunk?: (c: { html: string }) => string }) => {
      out = opts?.transformPageChunk?.({ html: `<head>${PLACEHOLDER}</head>` }) ?? out;
      return new Response('');
    },
  });
  expect(out).not.toContain(PLACEHOLDER);      // the hook really ran
  return out;
}

const hasGoogle = (h: string) => h.includes('googletagmanager.com/gtag/js');
const hasMicrosoft = (h: string) => h.includes('bat.bing.com/bat.js');

describe('the tags are injected where they are meant to be', () => {
  // Without this test every assertion in the next block would pass on a misconfigured mock.
  it('fires both platforms on the marketing funnel', async () => {
    for (const p of ['/', '/pricing', '/signup', '/wedding-disposable-camera', '/join/EPZ8MYF2']) {
      const h = await head(p);
      expect(hasGoogle(h), p).toBe(true);
      expect(hasMicrosoft(h), p).toBe(true);
      expect(h, p).toContain('window.__snapdiniConsent');
    }
  });
});

describe('no third-party tag on a route whose URL is a credential', () => {
  it('injects NOTHING on /email-preferences/<64-hex token> — the leak', async () => {
    const h = await head(`/email-preferences/${HEX64}`);
    expect(h).toBe('<head></head>');
    expect(hasGoogle(h)).toBe(false);
    expect(hasMicrosoft(h)).toBe(false);
    expect(h).not.toContain(HEX64);
    expect(h).not.toContain('__snapdiniConsent');   // no banner either: nothing to consent to
  });

  it('injects NOTHING on /unsubscribe/<uuid invite token>', async () => {
    const h = await head(`/unsubscribe/${UUID}`);
    expect(h).toBe('<head></head>');
    expect(h).not.toContain(UUID);
  });

  it('covers every route on the list, with and without a token in the URL', async () => {
    for (const r of TOKEN_ROUTES) {
      expect(await head(r), r).toBe('<head></head>');
      expect(await head(`${r}/${HEX64}`), r).toBe('<head></head>');
    }
  });

  it('matches whole segments, so the funnel is not caught by a prefix', async () => {
    // /signup must not be swallowed by /s-anything, and /unsubscribed is a different route.
    for (const p of ['/signup', '/siteadmin', '/s/some-share', '/surveys']) {
      expect(hasGoogle(await head(p)), p).toBe(true);
    }
  });
});

describe('page_location is redacted as a second layer, for the routes NOT on the list', () => {
  it('reports a route pattern, never a token, if a token reaches a tracked route', async () => {
    const h = await head(`/gallery/${HEX64}`);
    expect(hasGoogle(h)).toBe(true);                          // still tracked…
    expect(h).toContain("page_location:location.origin+\"/gallery/:token\"+location.search");
    expect(h).not.toContain(HEX64);                           // …but not with the token in it
  });

  it('drops the fragment, which is where the organizer code lives', async () => {
    // /admin/<joinCode>#<organizerCode> is how the whole product links a host to their own event.
    // The fragment never reaches the server, but document.location.href does include it — so the
    // default page_location would have sent the host's credential to Google on every admin view.
    const h = await head('/admin/EPZ8MYF2');
    expect(h).toContain('page_location:location.origin+"/admin/EPZ8MYF2"+location.search');
    expect(h).not.toContain('location.hash');
    expect(h).not.toContain('location.href');
    expect(h).not.toContain(ORGANIZER);
  });

  it('keeps the query string, so utm and gclid attribution still works', async () => {
    const h = await head('/pricing?utm_source=google&gclid=abc123');
    expect(h).toContain('+location.search');
  });
});
