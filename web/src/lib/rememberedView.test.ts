import { describe, it, expect, beforeEach } from 'vitest';
import { readView, writeView } from './rememberedView';

const SECTIONS = ['controls', 'share', 'guests'] as const;

describe('remembering which section a page was on', () => {
  beforeEach(() => sessionStorage.clear());

  it('starts with no opinion, so a page opens on its own default', () => {
    expect(readView('admin:ABC', SECTIONS)).toBeNull();
  });

  it('round-trips a section', () => {
    writeView('admin:ABC', 'share');
    expect(readView('admin:ABC', SECTIONS)).toBe('share');
  });

  // The menu is a place. Without this, "back to all settings" then refresh would drop you into
  // whichever section you had left, which is the opposite of what you just asked for.
  it('remembers being back at the menu', () => {
    writeView('admin:ABC', 'share');
    writeView('admin:ABC', null);
    expect(readView('admin:ABC', SECTIONS)).toBeNull();
  });

  // A stored name goes stale the moment a section is renamed or dropped, and a page that trusts one
  // renders a state that no longer exists.
  it('ignores a section that is no longer a section', () => {
    sessionStorage.setItem('snap_view_admin:ABC', 'tricks');
    expect(readView('admin:ABC', SECTIONS)).toBeNull();
  });

  it('keeps two subjects apart', () => {
    writeView('admin:ABC', 'share');
    writeView('admin:XYZ', 'guests');
    expect(readView('admin:ABC', SECTIONS)).toBe('share');
    expect(readView('admin:XYZ', SECTIONS)).toBe('guests');
  });
});
