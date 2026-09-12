// Where a demo visitor can go. The rule that matters is the last one: never offer a host link we
// cannot open, because a link that lands on a code prompt reads as the demo being broken rather
// than as a credential we happen not to have.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { demoLinks } from './demo';

const withStorage = (store: Record<string, string>) =>
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: () => {}, removeItem: () => {}, clear: () => {},
  });

afterEach(() => vi.unstubAllGlobals());

describe('the demo tour’s links', () => {
  it('points at the camera and the gallery for the event given', () => {
    withStorage({});
    const l = demoLinks('ABC123');
    expect(l.camera).toBe('/join/ABC123');
    expect(l.gallery).toBe('/gallery/ABC123');
  });

  it('prefers the code from the event payload', () => {
    // The reliable source: localStorage only ever had this on the device that STARTED the demo,
    // and the common path is starting on a laptop and scanning the QR with a phone.
    withStorage({});
    expect(demoLinks('ABC123', 'secret').host).toBe('/admin/ABC123#secret');
  });

  it('falls back to storage when the payload has none', () => {
    withStorage({ demo_org_ABC123: 'stored' });
    expect(demoLinks('ABC123').host).toBe('/admin/ABC123#stored');
  });

  it('lets the payload win over a stale stored value', () => {
    withStorage({ demo_org_ABC123: 'stale' });
    expect(demoLinks('ABC123', 'fresh').host).toBe('/admin/ABC123#fresh');
  });

  it('offers NO host link when it has no code at all', () => {
    withStorage({});
    expect(demoLinks('ABC123').host).toBe('');
    expect(demoLinks('ABC123', '').host).toBe('');
    expect(demoLinks('ABC123', null).host).toBe('');
  });

  it('survives storage being unreadable', () => {
    // Private mode, or site data blocked: throwing here would take the whole page down.
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); } });
    expect(() => demoLinks('ABC123')).not.toThrow();
    expect(demoLinks('ABC123').host).toBe('');
    // …and a code from the payload still works, because it never needed storage.
    expect(demoLinks('ABC123', 'secret').host).toBe('/admin/ABC123#secret');
  });

  it('escapes a code that would otherwise break the URL', () => {
    withStorage({});
    expect(demoLinks('ABC123', 'a b#c').host).toBe('/admin/ABC123#a%20b%23c');
  });
});
