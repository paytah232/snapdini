import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import InAppBrowserNotice from './InAppBrowserNotice.svelte';

const FB_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/569.0.0.55.71;FBDV/iPhone17,3;FBSV/26.5;IABMV/1]';
const IG_ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Instagram 300.0.0.0';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36';

/** Replace navigator with a UA and an optional working camera. */
function setNav(ua: string, camera: boolean) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: ua,
      ...(camera ? { mediaDevices: { getUserMedia: async () => ({}) } } : {}),
      clipboard: { writeText: vi.fn(async () => {}) },
    },
  });
}
async function mount() {
  const r = render(InAppBrowserNotice);
  await new Promise((res) => setTimeout(res, 0));
  await tick();
  return r;
}
const notice = () => screen.queryByRole('status');
const origNav = globalThis.navigator;

beforeEach(() => { sessionStorage.clear(); });
afterEach(() => { cleanup(); Object.defineProperty(globalThis, 'navigator', { configurable: true, value: origNav }); });

describe('InAppBrowserNotice', () => {
  it('SHOWS inside the Facebook iOS webview (no camera API)', async () => {
    setNav(FB_IOS, false);
    await mount();
    expect(notice()).not.toBeNull();
    expect(notice()!.textContent).toMatch(/Facebook/);
    // iOS wording must name Safari, since that is the actual escape route there.
    expect(notice()!.textContent).toMatch(/Safari/);
  });

  it('SHOWS inside the Instagram Android webview, with non-iOS wording', async () => {
    setNav(IG_ANDROID, false);
    await mount();
    expect(notice()!.textContent).toMatch(/Instagram/);
    expect(notice()!.textContent).not.toMatch(/Safari/);
  });

  it('SHOWS in an UNRECOGNISED webview when the camera API is missing', async () => {
    setNav('Mozilla/5.0 (iPhone) SomeUnknownWebview/1.0', false);
    await mount();
    // Falls back to the generic wording rather than naming an app.
    expect(notice()!.textContent).toMatch(/built-in browser/i);
  });

  it('stays HIDDEN in Safari — a false positive would nag every real visitor', async () => {
    setNav(SAFARI, true);
    await mount();
    expect(notice()).toBeNull();
  });

  it('stays HIDDEN on desktop Chrome', async () => {
    setNav(DESKTOP, true);
    await mount();
    expect(notice()).toBeNull();
  });

  it('can be dismissed, and stays dismissed for the session', async () => {
    setNav(FB_IOS, false);
    await mount();
    await fireEvent.click(screen.getByLabelText(/dismiss/i));
    await tick();
    expect(notice()).toBeNull();
    cleanup();
    await mount();                       // simulate a client-side navigation
    expect(notice()).toBeNull();
  });

  it('copy-link button copies the current URL', async () => {
    setNav(FB_IOS, false);
    await mount();
    await fireEvent.click(screen.getByText(/copy link/i));
    await tick();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(window.location.href);
  });

  it('survives sessionStorage throwing (private mode) without hiding the notice', async () => {
    setNav(FB_IOS, false);
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    await mount();
    expect(notice()).not.toBeNull();
    spy.mockRestore();
  });

  it('survives a clipboard failure without crashing the notice', async () => {
    setNav(FB_IOS, false);
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('denied'));
    await mount();
    await fireEvent.click(screen.getByText(/copy link/i));
    await tick();
    expect(notice()).not.toBeNull();     // still usable; instructions remain on screen
  });
});
