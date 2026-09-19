import { describe, it, expect, beforeEach } from 'vitest';
import { isLight, applyEventTheme, accentInk, contrast, PALETTE_MIN_CONTRAST, THEME_PRESETS } from './theme';
import type { EventTheme } from './events';

describe('theme.isLight', () => {
  it('light mode is always light', () => {
    expect(isLight('light')).toBe(true);
  });
  it('dark mode is never light', () => {
    expect(isLight('dark')).toBe(false);
  });
});

describe('theme.accentInk', () => {
  // Extracted from applyEventTheme so the palette picker's preview makes the same call the page
  // does. It no longer pins a THRESHOLD: the 0.45 figure this used to assert was wrong (break-even
  // is nearer 0.18), and #e8994a below is the proof — the default event accent, which used to get
  // white ink at 2.31:1 and now gets near-black at 8.17:1. What is pinned is the RULE: whichever
  // ink measures better wins. See the AA sweep over every shipped palette at the foot of this file.
  it('picks whichever ink measures better on the accent', () => {
    expect(accentInk('#f5c518')).toBe('#111');
    expect(accentInk('#a8ff78')).toBe('#111');
    expect(accentInk('#2563eb')).toBe('#fff');   // a genuinely dark blue: white still wins
    expect(accentInk('#e8994a')).toBe('#111');   // was '#fff' at 2.31:1 — the bug this fixes
  });
  it('says nothing at all about a colour it cannot read', () => {
    expect(accentInk('chartreuse')).toBeNull();
  });
});

describe('theme.contrast', () => {
  it('is the WCAG ratio, and the one thing the picker is allowed to use', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrast('#0f0f0f', '#f0ece6')).toBeGreaterThan(PALETTE_MIN_CONTRAST);
    expect(contrast('#111111', '#131313')).toBeLessThan(PALETTE_MIN_CONTRAST);
    expect(contrast('mauve', '#fff')).toBeNull();
  });
});

describe('theme.applyEventTheme — a theme saved before the palette picker existed', () => {
  // Exactly what the admin page has always written: the six colours, a preset name, and neither of
  // the two shades it used to drop. If the picker's arrival changed how one of these renders, the
  // host finds out when a guest opens their event.
  const legacy: EventTheme = {
    bg: '#050d1a', surface: '#0a1628', surface2: '#0e1e36', border: '#162944',
    text: '#d0e8ff', accent: '#38bdf8', preset: 'ocean'
  };
  const read = (v: string) => document.documentElement.style.getPropertyValue(v);

  beforeEach(() => {
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
  });

  it('renders it to exactly the variables it always did', () => {
    applyEventTheme(legacy);
    expect(read('--bg')).toBe('#050d1a');
    expect(read('--surface')).toBe('#0a1628');
    expect(read('--surface-2')).toBe('#0e1e36');
    expect(read('--border')).toBe('#162944');
    expect(read('--text')).toBe('#d0e8ff');
    expect(read('--accent')).toBe('#38bdf8');
    // The ONE variable a legacy theme now renders differently, and deliberately: accentInk used to
    // return white here (2.14:1 on this accent) and now returns near-black (8.81:1). Every other
    // value below is still byte-identical, which is what this test exists to guarantee.
    expect(read('--accent-ink')).toBe('#111');
    // Never stored, so never set — the app's own values still stand for these.
    expect(read('--text-muted')).toBe('');
    expect(read('--accent-dark')).toBe('');
    expect(read('--font')).toBe('');
    // Appearance still follows the background rather than a stored mode.
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('renders every shipped palette to its own values, unchanged', () => {
    for (const [name, p] of Object.entries(THEME_PRESETS)) {
      document.documentElement.removeAttribute('style');
      applyEventTheme(p as EventTheme);
      expect(read('--bg'), name).toBe(p.bg);
      expect(read('--surface'), name).toBe(p.surface);
      expect(read('--surface-2'), name).toBe(p.surface2);
      expect(read('--border'), name).toBe(p.border);
      expect(read('--text'), name).toBe(p.text);
      expect(read('--text-muted'), name).toBe(p.textMuted);
      expect(read('--accent'), name).toBe(p.accent);
      expect(read('--accent-dark'), name).toBe(p.accentDark);
    }
  });

  it('still refuses an illegible palette outright, and still honours the rest of the theme', () => {
    applyEventTheme({ bg: '#111111', text: '#131313', font: 'Georgia, serif', customCss: '' });
    expect(read('--bg')).toBe('');
    expect(read('--text')).toBe('');
    expect(read('--font')).toBe('Georgia, serif');
  });

  it('still falls back to the warm default for an event with no theme', () => {
    applyEventTheme(null);
    expect(read('--bg')).toBe('#1a1209');
    expect(read('--accent')).toBe('#e8994a');
  });

  it('still clears a previous event’s palette before applying the next', () => {
    applyEventTheme(THEME_PRESETS.forest as EventTheme);
    applyEventTheme({ bg: '#050d1a', text: '#d0e8ff' });
    expect(read('--bg')).toBe('#050d1a');
    expect(read('--accent')).toBe('');      // forest's green must not survive
  });

  /* ── The ONE rendering change to already-saved themes in this change ──────────────────────────
   *  --accent-fill now follows the event accent. It is called out in its own test so it can be
   *  found and reverted on its own: delete this block and the `set('--accent-fill', …)` line in
   *  applyEventTheme (and '--accent-fill' from EVENT_VARS) and nothing else moves.
   *
   *  Why it is here: the app splits the brand yellow into --accent (text, borders) and
   *  --accent-fill (anything the colour sits BEHIND) because a light page needs two lightnesses of
   *  one colour. An event palette has no such split, and nothing was telling the fill — so a guest
   *  on a green event still pressed a brand-yellow Join button, wearing ink that applyEventTheme
   *  had already computed from the GREEN. White on #f5c518 is 1.6:1. The picker's preview cannot
   *  honestly show a host their colours while the loudest control on the guest's screen ignores
   *  them. */
  it('paints the accent fill from the event accent, so the Join button is the host’s colour', () => {
    applyEventTheme(legacy);
    expect(read('--accent-fill')).toBe('#38bdf8');
    // Deliberately NOT "the event fill beats brand gold". That assertion held only while the ink
    // was white (2.14:1 vs gold's 1.63:1), and it encoded the wrong justification: gold is nearly
    // white, so on raw contrast it beats most mid-tone accents (here 11.58:1 vs 8.81:1) and would
    // beat them even more once both use dark ink. The point of painting the fill from the accent is
    // that it is the HOST'S colour and it is legible — not that it out-contrasts the brand.
    expect(contrast(read('--accent-fill'), read('--accent-ink'))!).toBeGreaterThanOrEqual(4.5);
  });

  it('clears the accent fill along with the rest when leaving an event', () => {
    applyEventTheme(legacy);
    applyEventTheme({ bg: '#111111', text: '#131313' });    // refused palette ⇒ nothing carried over
    expect(read('--accent-fill')).toBe('');
  });
});

describe('accentInk picks the ink that is actually legible', () => {
  // Every palette a host can choose, plus the default. The Join button's label sits on the accent,
  // so a failure here is the loudest control on a guest's phone being the least readable thing.
  it('clears WCAG AA on every shipped palette', () => {
    for (const [name, t] of Object.entries(THEME_PRESETS)) {
      const accent = t.accent as string;
      const ink = accentInk(accent);
      expect(ink, name).not.toBeNull();
      const ratio = contrast(ink as string, accent) as number;
      expect(ratio, `${name} (${accent}) ink ${ink} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  // The specific regression. The old 0.45 luminance threshold returned WHITE here, at 2.31:1,
  // on the theme every event gets unless the host picks another.
  it('gives the default warm accent dark ink, not white', () => {
    expect(accentInk('#e8994a')).toBe('#111');
    expect(contrast('#111', '#e8994a') as number).toBeGreaterThan(8);
  });

  it('still chooses white where white genuinely wins', () => {
    expect(accentInk('#2563eb')).toBe('#fff');   // the `light` palette's blue
    expect(accentInk('#000000')).toBe('#fff');
  });

  it('returns null for an unparseable accent so the app default stands', () => {
    expect(accentInk('not-a-colour')).toBeNull();
    expect(accentInk('')).toBeNull();
  });
});
