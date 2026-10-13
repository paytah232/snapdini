// The SEO identity the root layout hands every page, driven through the real load().
//
// The defect this guards: a non-indexable (dev) host answered noindex yet still emitted
// `canonical: <itself>`, because the canonical was built from its own ORIGIN. Google ranks
// rel=canonical, not noindex, when choosing between duplicates — so it kept the dev host as the
// original. CANONICAL_ORIGIN must win when set, and nothing must ever come from the request host.
import { describe, it, expect, vi, afterEach } from 'vitest';

async function identity(envVars: Record<string, string>, href = 'https://preview.example.com/pricing') {
  vi.resetModules();
  vi.doMock('$env/dynamic/private', () => ({ env: envVars }));
  const { load } = await import('../routes/+layout.server');
  const url = new URL(href);
  const data = await (load as (e: unknown) => Promise<Record<string, unknown>>)({
    url, request: new Request(url), fetch: () => { throw new Error('must not be called'); },
  });
  return data as { seoIndexable: boolean; canonicalOrigin: string; robotsMeta: string };
}

afterEach(() => { vi.doUnmock('$env/dynamic/private'); vi.resetModules(); });

describe('root layout SEO identity', () => {
  it('a suppressed host names the real site as canonical when CANONICAL_ORIGIN is set', async () => {
    const d = await identity({ SEO_INDEXABLE: '', ORIGIN: 'https://preview.example.com', CANONICAL_ORIGIN: 'https://snapdini.com' });
    expect(d.seoIndexable).toBe(false);
    expect(d.robotsMeta).toBe('noindex, nofollow');
    expect(d.canonicalOrigin).toBe('https://snapdini.com');
  });
  it('without CANONICAL_ORIGIN the canonical is this deployment\'s own ORIGIN (the indexable host)', async () => {
    const d = await identity({ SEO_INDEXABLE: '1', ORIGIN: 'https://snapdini.com', CANONICAL_ORIGIN: '' }, 'https://snapdini.com/');
    expect(d.seoIndexable).toBe(true);
    expect(d.robotsMeta).toBe('index, follow');
    expect(d.canonicalOrigin).toBe('https://snapdini.com');
  });
  it('never builds the canonical from the request host when either is configured', async () => {
    const d = await identity({ SEO_INDEXABLE: '', ORIGIN: 'https://preview.example.com', CANONICAL_ORIGIN: 'https://snapdini.com' }, 'https://evil.example/');
    expect(d.canonicalOrigin).toBe('https://snapdini.com');
  });
});
