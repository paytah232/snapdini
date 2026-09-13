// Which route actually KEEPS a photo differs by platform, and getting it backwards is invisible in
// code review — it only shows up as a tester saying "the share sheet has no way to save it".
import { describe, it, expect, vi, afterEach } from 'vitest';
import { isIOS } from './saveImage';

const ua = (s: string, touch = 0) =>
  vi.stubGlobal('navigator', { userAgent: s, maxTouchPoints: touch });

afterEach(() => vi.unstubAllGlobals());

describe('knowing when the share sheet is the only way to Photos', () => {
  it('spots an iPhone', () => {
    ua('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1');
    expect(isIOS()).toBe(true);
  });

  it('spots an iPad that is pretending to be a Mac', () => {
    // iPadOS 13+ reports "Macintosh". The touch points are what give it away, and without this an
    // iPad would take the Android path and land its photos in Files.
    ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', 5);
    expect(isIOS()).toBe(true);
  });

  it('does not mistake a real Mac for one', () => {
    ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/127 Safari/537.36', 0);
    expect(isIOS()).toBe(false);
  });

  it('leaves Android alone — a download is better there', () => {
    // The share sheet on Android lists apps to send the photo TO. There is no "keep this" on it,
    // so a guest who wanted the photo got a list of ways to give it away.
    ua('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/127 Mobile Safari/537.36', 5);
    expect(isIOS()).toBe(false);
  });

  it('leaves desktop alone', () => {
    ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127 Safari/537.36', 0);
    expect(isIOS()).toBe(false);
  });

  it('does not throw where there is no navigator at all', () => {
    vi.stubGlobal('navigator', undefined);
    expect(() => isIOS()).not.toThrow();
  });
});
