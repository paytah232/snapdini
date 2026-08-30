import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { readable, writable } from 'svelte/store';

// The banner reads `$page.url` so it can react to a client-side navigation to /?consent=1.
// Drive that store directly; `setup()` keeps it in step with the simulated URL.
const pageUrl = writable(new URL('http://localhost/'));
vi.mock('$app/stores', () => ({
  page: { subscribe: (fn: (v: { url: URL; data: Record<string, unknown> }) => void) =>
    pageUrl.subscribe((url) => fn({ url, data: {} })) },
}));


import { tick } from 'svelte';
import ConsentBanner from './ConsentBanner.svelte';

type ConsentCfg = { enabled: boolean; eea: boolean };

function setup(cfg: ConsentCfg | undefined, opts: { search?: string; stored?: string } = {}) {
  (window as unknown as { __snapdiniConsent?: ConsentCfg }).__snapdiniConsent = cfg;
  window.history.replaceState({}, '', opts.search ?? '/');
  pageUrl.set(new URL(opts.search ?? '/', 'http://localhost'));
  if (opts.stored) localStorage.setItem('snapdini-consent', opts.stored);
}

async function mount() {
  const r = render(ConsentBanner);
  // Flush onMount's queued microtask + the resulting reactive `show` update into the DOM.
  await new Promise((res) => setTimeout(res, 0));
  await tick();
  return r;
}

const banner = () => screen.queryByRole('dialog', { name: /privacy consent/i });

beforeEach(() => {
  localStorage.clear();
  delete (window as unknown as { __snapdiniConsent?: ConsentCfg }).__snapdiniConsent;
  (window as unknown as { gtag: (...a: unknown[]) => void }).gtag = vi.fn();
  window.history.replaceState({}, '', '/');
});

afterEach(() => cleanup());

describe('ConsentBanner — when it shows', () => {
  it('SHOWS for a consent-region visitor with no prior choice', async () => {
    setup({ enabled: true, eea: true });
    await mount();
    expect(banner()).not.toBeNull();
  });

  it('does NOT show once a choice is stored', async () => {
    setup({ enabled: true, eea: true }, { stored: 'granted' });
    await mount();
    expect(banner()).toBeNull();
  });

  it('does NOT show to non-consent-region visitors (e.g. US/AU)', async () => {
    setup({ enabled: true, eea: false });
    await mount();
    expect(banner()).toBeNull();
  });

  it('does NOT show when no tag is configured', async () => {
    setup({ enabled: false, eea: true });
    await mount();
    expect(banner()).toBeNull();
  });

  it('does NOT show when the injected config is entirely absent', async () => {
    setup(undefined);
    await mount();
    expect(banner()).toBeNull();
  });

  it('force-shows anywhere via ?consent=1 (preview / change-your-mind), even after deciding', async () => {
    setup({ enabled: true, eea: false }, { search: '/?consent=1', stored: 'granted' });
    await mount();
    expect(banner()).not.toBeNull();
  });
});

describe('ConsentBanner — reopening via the footer link', () => {
  it('opens when ?consent arrives via CLIENT-SIDE navigation (no remount)', async () => {
    // The banner lives in the persistent layout, so clicking the footer's "Your Privacy Choices"
    // link never remounts it. Reading the URL only in onMount made that link silently do nothing.
    setup({ enabled: true, eea: false }, { stored: 'granted' });
    await mount();
    expect(banner()).toBeNull();                            // nothing showing yet

    pageUrl.set(new URL('http://localhost/?consent=1'));    // the footer link fires
    await tick();

    expect(banner()).not.toBeNull();
  });
});

describe('ConsentBanner — choices', () => {
  it('Accept stores granted and grants all four consent signals', async () => {
    setup({ enabled: true, eea: true });
    await mount();
    await fireEvent.click(screen.getByRole('button', { name: /accept/i }));

    expect(localStorage.getItem('snapdini-consent')).toBe('granted');
    const gtag = (window as unknown as { gtag: ReturnType<typeof vi.fn> }).gtag;
    expect(gtag).toHaveBeenCalledWith('consent', 'update', {
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
      analytics_storage: 'granted',
    });
    expect(banner()).toBeNull(); // dismissed
  });

  it('Reject stores denied and denies all four consent signals', async () => {
    setup({ enabled: true, eea: true });
    await mount();
    await fireEvent.click(screen.getByRole('button', { name: /reject/i }));

    expect(localStorage.getItem('snapdini-consent')).toBe('denied');
    const gtag = (window as unknown as { gtag: ReturnType<typeof vi.fn> }).gtag;
    expect(gtag).toHaveBeenCalledWith('consent', 'update', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
    });
    expect(banner()).toBeNull();
  });
});
