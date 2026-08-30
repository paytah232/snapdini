import { describe, it, expect, afterEach } from 'vitest';
import { inAppBrowserName, cameraUnavailable, isIOS } from './inAppBrowser';

const FB_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/569.0.0.55.71;FBDV/iPhone17,3;FBMD/iPhone;FBSN/iOS;FBSV/26.5;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5;IABMV/1]';
const SAFARI  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1';
const CHROME  = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const IG      = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 300.0.0.0';

describe('inAppBrowserName', () => {
  it('detects the real Facebook iOS webview seen in production logs', () => {
    // This exact UA shape accounted for 83% of ad-associated traffic; getUserMedia is absent there.
    expect(inAppBrowserName(FB_IOS)).toBe('Facebook');
  });
  it('detects other embedded webviews', () => {
    expect(inAppBrowserName(IG)).toBe('Instagram');
    expect(inAppBrowserName('… TikTok 30.1.0 …')).toBe('TikTok');
    expect(inAppBrowserName('… Snapchat/12.0 …')).toBe('Snapchat');
  });
  it('does NOT flag real browsers — a false positive nags every genuine visitor', () => {
    expect(inAppBrowserName(SAFARI)).toBeNull();
    expect(inAppBrowserName(CHROME)).toBeNull();
    expect(inAppBrowserName('')).toBeNull();
  });
});

describe('isIOS', () => {
  it('picks iOS so the notice can say "Open in Safari" vs a generic menu', () => {
    expect(isIOS(FB_IOS)).toBe(true);
    expect(isIOS(SAFARI)).toBe(true);
    expect(isIOS(CHROME)).toBe(false);
  });
});

describe('cameraUnavailable', () => {
  const orig = globalThis.navigator;
  afterEach(() => { Object.defineProperty(globalThis, 'navigator', { value: orig, configurable: true }); });
  const setNav = (v: unknown) => Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true });

  it('is true when mediaDevices is missing entirely (the webview case)', () => {
    setNav({ userAgent: FB_IOS });
    expect(cameraUnavailable()).toBe(true);
  });
  it('is true when getUserMedia is not a function', () => {
    setNav({ userAgent: FB_IOS, mediaDevices: {} });
    expect(cameraUnavailable()).toBe(true);
  });
  it('is false in a browser that can actually capture', () => {
    setNav({ userAgent: SAFARI, mediaDevices: { getUserMedia: () => {} } });
    expect(cameraUnavailable()).toBe(false);
  });
});
