// The three states of the bot-check widget, because two of them are invisible until they matter.
//
//  * No site key — a self-hosted stack with no Turnstile keys. The component must occupy NOTHING:
//    not a widget, not a notice, not even reserved space. A mystery 65px gap in the sign-up form
//    of every self-host install would be this component's fault and nobody else's.
//  * Site key, script on its way — space reserved immediately, so the widget arriving over the
//    network cannot shove the submit button out from under a thumb already moving towards it.
//  * Site key, script never arrives — an ad blocker or a privacy DNS resolver eating
//    challenges.cloudflare.com. This is the case that used to fail silently: no widget, no token,
//    no explanation, and a form that refuses for ever without saying why.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import Turnstile from './Turnstile.svelte';
import { getConfig } from '$lib/api';

vi.mock('$lib/api', () => ({ getConfig: vi.fn() }));

const config = (turnstileSiteKey: string | null) =>
  vi.mocked(getConfig).mockResolvedValue({ turnstileSiteKey } as never);

/** onMount is async and the script arrives a macrotask later — let both settle. */
async function flush() {
  for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 0)); await tick(); }
}

type Api = { render: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
function stubScriptApi(): { api: Api; opts: () => Record<string, unknown> } {
  const calls: Record<string, unknown>[] = [];
  const api: Api = {
    render: vi.fn((_el: HTMLElement, o: Record<string, unknown>) => { calls.push(o); return 'widget-1'; }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  (window as unknown as { turnstile?: Api }).turnstile = api;
  return { api, opts: () => calls[0] };
}

/** jsdom never fetches <script src>, so neither onload nor onerror fires by itself. */
function interceptScript(outcome: 'error' | 'never') {
  const real = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, 'appendChild').mockImplementation(((node: Node) => {
    const el = node as HTMLScriptElement;
    if (el.tagName === 'SCRIPT') {
      if (outcome === 'error') setTimeout(() => el.onerror?.(new Event('error')), 0);
      return node;
    }
    return real(node);
  }) as never);
}

const box = (c: HTMLElement) => c.querySelector('.turnstile');
const notice = (c: HTMLElement) => c.querySelector('.note');

beforeEach(() => { vi.mocked(getConfig).mockReset(); });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  const w = window as unknown as { turnstile?: unknown; __snapdiniTurnstile?: unknown };
  delete w.turnstile; delete w.__snapdiniTurnstile;
});

describe('Turnstile — a stack with no bot check configured', () => {
  it('renders nothing and reserves nothing, so sign-up looks exactly as it did', async () => {
    config(null);
    const { container } = render(Turnstile, { props: { action: 'register' } });
    await flush();
    expect(box(container)!.classList.contains('live')).toBe(false);
    expect(notice(container)).toBeNull();
    expect(box(container)!.textContent!.trim()).toBe('');
  });

  it('stays invisible when /api/config cannot be reached at all', async () => {
    vi.mocked(getConfig).mockRejectedValue(new Error('offline'));
    const { container } = render(Turnstile, { props: { action: 'login' } });
    await flush();
    expect(box(container)!.classList.contains('live')).toBe(false);
    expect(notice(container)).toBeNull();
  });
});

describe('Turnstile — configured', () => {
  it('reserves its space BEFORE the widget arrives', async () => {
    // The whole point: the class that carries min-height is on the element while the script is
    // still in flight, so nothing below it moves when the iframe finally lands.
    config('1x00000000000000000000AA');
    interceptScript('never');
    const { container } = render(Turnstile, { props: { action: 'login' } });
    await flush();
    expect(box(container)!.classList.contains('live')).toBe(true);
    expect(notice(container)).toBeNull();           // nothing to report yet — it may still load
  });

  it('renders the widget with THIS form’s action, not a shared one', async () => {
    config('site-key-123');
    const { api, opts } = stubScriptApi();
    const { container } = render(Turnstile, { props: { action: 'register' } });
    await flush();
    expect(api.render).toHaveBeenCalledTimes(1);
    expect(opts().sitekey).toBe('site-key-123');
    expect(opts().action).toBe('register');
    expect(opts().size).toBe('flexible');
    expect(typeof opts().callback).toBe('function');
    expect(box(container)!.classList.contains('live')).toBe(true);
    expect(notice(container)).toBeNull();
  });

  it('reset() asks Cloudflare for a fresh token — tokens are single-use', async () => {
    config('site-key-123');
    const { api } = stubScriptApi();
    const { component } = render(Turnstile, { props: { action: 'login' } });
    await flush();
    (component as unknown as { reset: () => void }).reset();
    expect(api.reset).toHaveBeenCalledWith('widget-1');
  });
});

describe('Turnstile — the script is blocked (ad blocker / private DNS)', () => {
  it('says what happened, names the address to allow, and offers a way round', async () => {
    config('site-key-123');
    interceptScript('error');
    const { container } = render(Turnstile, { props: { action: 'login' } });
    await flush();
    const text = notice(container)?.textContent ?? '';
    expect(text).not.toBe('');
    expect(text).toMatch(/ad blocker/i);
    expect(text).toMatch(/private DNS/i);
    expect(text).toMatch(/challenges\.cloudflare\.com/);
    expect(text).toMatch(/different network/i);
    // Our vocabulary is not the customer's.
    expect(text).not.toMatch(/turnstile|captcha|\btoken\b|\bbot\b/i);
    // Worded as a conditional ("if this form won't go through"), because with TURNSTILE_FAIL_OPEN
    // set the submit still succeeds and announcing a failure that never happens is its own bug.
    expect(text).toMatch(/if this form/i);
  });

  it('keeps the reserved space, so the notice replaces the widget instead of adding to the page', async () => {
    config('site-key-123');
    interceptScript('error');
    const { container } = render(Turnstile, { props: { action: 'login' } });
    await flush();
    expect(box(container)!.classList.contains('live')).toBe(true);
    expect(box(container)!.classList.contains('blocked')).toBe(true);
  });
});
