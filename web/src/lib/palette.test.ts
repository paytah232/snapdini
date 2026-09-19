import { describe, it, expect, beforeEach } from 'vitest';
import {
  HARMONIES, TWEAKABLE, buildPalette, baseFromTheme, hexToHsl, hslToHex,
  paletteFromTheme, paletteReport, toHex6, normalizeStoredColor, CONTRAST_COMFORTABLE
} from './palette';
import { THEME_PRESETS, accentInk, applyEventTheme, contrast, isLightBg, PALETTE_MIN_CONTRAST } from './theme';
import type { EventTheme } from './events';

const clearVars = () => document.documentElement.removeAttribute('style');

describe('palette: reading a colour', () => {
  it('expands #rgb and normalises rgb() the way stored themes spell them', () => {
    // The shipped `light` palette really does store '#ddd'.
    expect(toHex6('#ddd')).toBe('#dddddd');
    expect(toHex6('rgb(1, 2, 3)')).toBe('#010203');
    expect(toHex6('#e8994a')).toBe('#e8994a');
  });

  it('falls back to black only for things that are not colours', () => {
    expect(toHex6('rebeccapurple')).toBe('#000000');
    expect(toHex6(undefined)).toBe('#000000');
    expect(toHex6('')).toBe('#000000');
  });

  it('normalizeStoredColor keeps an exotic-but-valid stored value instead of blacking it out', () => {
    // 8-digit hex passes the server's colour regex, so it can be in the column. Flattening it to
    // black on the next theme save would be data loss the host never asked for.
    expect(normalizeStoredColor('#e8994a80')).toBe('#e8994a80');
    expect(normalizeStoredColor('#ddd')).toBe('#dddddd');
    expect(normalizeStoredColor('1, 2, 3')).toBe('#010203');
    expect(normalizeStoredColor('not a colour')).toBe('#000000');
    expect(normalizeStoredColor(undefined)).toBe('#000000');
  });

  it('round-trips every shipped accent through HSL without drifting', () => {
    for (const [name, p] of Object.entries(THEME_PRESETS)) {
      const hsl = hexToHsl(p.accent as string);
      expect(hsl, name).not.toBeNull();
      expect(hslToHex(hsl!), name).toBe((p.accent as string).toLowerCase());
    }
  });

  it('refuses to do maths on something that is not a colour', () => {
    expect(hexToHsl('chartreuse')).toBeNull();
    expect(hexToHsl('#12345')).toBeNull();
    expect(buildPalette('chartreuse', 'mono')).toBeNull();
  });
});

describe('palette: light mode', () => {
  // Every hue, because the failure this guards against is hue-dependent: a blue at 45% lightness
  // carries a legible label and a yellow at the same 45% does not.
  const HUES = Array.from({ length: 24 }, (_, i) => hslToHex({ h: i * 15, s: 0.75, l: 0.55 }));

  it('builds a page that is actually light, on every hue and harmony', () => {
    for (const base of HUES) {
      for (const h of HARMONIES) {
        const p = buildPalette(base, h.key, 'light')!;
        expect(isLightBg(p.bg), `${base}/${h.key} bg ${p.bg}`).toBe(true);
        // …and the chrome follows it, which is the whole reason there is no separate mode switch.
        clearVars();
        applyEventTheme(p as EventTheme);
        expect(document.documentElement.getAttribute('data-theme'), `${base}/${h.key}`).toBe('light');
      }
    }
  });

  it('keeps the Join button’s label legible, which is why the accent is walked down', () => {
    for (const base of HUES) {
      const p = buildPalette(base, 'mono', 'light')!;
      const ink = accentInk(p.accent);
      expect(ink, base).not.toBeNull();
      const ratio = contrast(ink as string, p.accent) as number;
      expect(ratio, `${base} → accent ${p.accent}, ink ${ink} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('passes the same legibility report every shipped palette has to pass', () => {
    for (const base of HUES) {
      for (const h of HARMONIES) {
        const rep = paletteReport(buildPalette(base, h.key, 'light')!);
        expect(rep.blocked, `${base}/${h.key}`).toBe(false);
        expect(rep.checks[0].level, `${base}/${h.key}`).toBe('good');
      }
    }
  });

  // The promise only ever applied to dark, and adding light must not have quietly moved it.
  it('leaves dark mode byte for byte what it was', () => {
    for (const h of HARMONIES) {
      expect(buildPalette('#e8994a', h.key)!.accent, h.key).toBe('#e8994a');
      expect(buildPalette('#e8994a', h.key), h.key).toEqual(buildPalette('#e8994a', h.key, 'dark'));
    }
  });

  it('fills a light theme’s missing colours with light ones', () => {
    // A saved light event that never stored a muted text colour. Filling it from a dark palette
    // would hand it a near-white muted grey — invisible on its own page.
    const p = paletteFromTheme({ bg: '#faf6ee', surface: '#ffffff', text: '#2a2118', accent: '#a14e0f' } as EventTheme);
    expect(contrast(p.textMuted, '#faf6ee')!, `muted ${p.textMuted} on a light page`).toBeGreaterThan(3);
  });
});

describe('palette: harmony', () => {
  const base = '#e8994a';                       // the shipped warm accent
  const hueOf = (hex: string) => hexToHsl(hex)!.h;

  it('hands back the host’s own colour as the accent when it is already a usable one', () => {
    for (const h of HARMONIES) {
      // Byte for byte. A picker that quietly returns a DIFFERENT colour from the one you chose is
      // one nobody trusts a second time.
      expect(buildPalette(base, h.key)!.accent, h.key).toBe(base);
    }
  });

  it('rotates the BACKGROUND by each harmony’s documented angle, and never the accent', () => {
    const baseHue = hueOf(base);
    for (const h of HARMONIES) {
      const p = buildPalette(base, h.key)!;
      expect(hueOf(p.accent), `${h.key} accent`).toBeCloseTo(baseHue, 0);
      expect(hueOf(p.bg), `${h.key} bg`).toBeCloseTo((baseHue + h.shift) % 360, 0);
    }
  });

  it('keeps the whole background family on one hue', () => {
    const p = buildPalette(base, 'complement')!;
    const hue = hueOf(p.bg);
    for (const k of ['surface', 'surface2', 'border', 'text', 'textMuted'] as const) {
      // Within a few degrees, not exactly: near-white at 4% saturation is only a handful of 8-bit
      // steps wide, so reading a hue back out of it quantises. That is the round trip being lossy,
      // not the palette wandering — and it is invisible at that saturation.
      expect(Math.abs(hueOf(p[k]) - hue), k).toBeLessThan(8);
    }
  });

  it('climbs the same lightness rungs the shipped palettes use', () => {
    const p = buildPalette(base, 'mono')!;
    const l = (hex: string) => hexToHsl(hex)!.l;
    expect(l(p.bg)).toBeLessThan(l(p.surface));
    expect(l(p.surface)).toBeLessThan(l(p.surface2));
    expect(l(p.surface2)).toBeLessThan(l(p.border));
    expect(l(p.border)).toBeLessThan(l(p.textMuted));
    expect(l(p.textMuted)).toBeLessThan(l(p.text));
  });

  it('lifts a near-black pick into a lightness that can actually be seen', () => {
    const p = buildPalette('#03040a', 'mono')!;
    expect(hexToHsl(p.accent)!.l).toBeGreaterThanOrEqual(0.44);
  });

  it('darkens the accent for --accent-dark rather than inventing a second colour', () => {
    const p = buildPalette(base, 'mono')!;
    expect(hexToHsl(p.accentDark)!.h).toBeCloseTo(hexToHsl(p.accent)!.h, 0);
    expect(hexToHsl(p.accentDark)!.l).toBeLessThan(hexToHsl(p.accent)!.l);
  });

  it('falls back to monochrome for a harmony key it has never heard of', () => {
    expect(buildPalette(base, 'kaleidoscope')).toEqual(buildPalette(base, 'mono'));
  });

  it('offers a hand-tune for four colours, all of them real palette keys', () => {
    const p = buildPalette(base, 'mono')!;
    for (const t of TWEAKABLE) expect(p[t.key], t.key).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('palette: the contrast gate', () => {
  beforeEach(clearVars);

  it('never generates a palette the page would refuse — 360 hues × every harmony', () => {
    for (let h = 0; h < 360; h += 5) {
      for (const harmony of HARMONIES) {
        const p = buildPalette(hslToHex({ h, s: 0.8, l: 0.55 }), harmony.key)!;
        const r = contrast(p.text, p.bg)!;
        expect(r, `hue ${h} / ${harmony.key}`).toBeGreaterThanOrEqual(PALETTE_MIN_CONTRAST);
        expect(paletteReport(p).blocked, `hue ${h} / ${harmony.key}`).toBe(false);
      }
    }
  });

  it('blocks exactly what applyEventTheme throws away, and nothing else', () => {
    // The whole point of importing the guard rather than restating it. A palette the picker blesses
    // must survive the page; one it blocks must be one the page would have silently discarded.
    const cases: [string, string][] = [
      ['#111111', '#131313'],   // the all-black palette the guard exists for
      ['#0f0f0f', '#f0ece6'],   // the app's own
      ['#777777', '#999999'],   // 1.6:1 — visible in a swatch, unreadable as text
      ['#0f0f0f', '#5a5a5a'],   // 3.06:1 — just over the floor
      ['#0f0f0f', '#585858']    // 2.94:1 — just under it
    ];
    for (const [bg, text] of cases) {
      const p = { ...buildPalette('#e8994a', 'mono')!, bg, text };
      const { blocked } = paletteReport(p);

      clearVars();
      applyEventTheme({ bg, text } as EventTheme);
      const applied = document.documentElement.style.getPropertyValue('--bg') === bg;

      expect(blocked, `${bg} / ${text}`).toBe(!applied);
    }
  });

  it('warns without blocking between the guard’s floor and comfortable reading', () => {
    const p = { ...buildPalette('#e8994a', 'mono')!, bg: '#0f0f0f', text: '#6a6a6a' };
    const r = contrast(p.text, p.bg)!;
    expect(r).toBeGreaterThan(PALETTE_MIN_CONTRAST);
    expect(r).toBeLessThan(CONTRAST_COMFORTABLE);
    const rep = paletteReport(p);
    expect(rep.checks[0].level).toBe('warn');
    expect(rep.blocked).toBe(false);
  });

  it('says so in words, not only in a colour', () => {
    const bad = paletteReport({ ...buildPalette('#e8994a', 'mono')!, bg: '#111111', text: '#131313' });
    expect(bad.checks[0].level).toBe('fail');
    expect(bad.checks[0].note).toMatch(/could not read|can’t be used/i);
    expect(bad.checks[0].ratio).toBeGreaterThan(1);
  });

  it('keeps muted text and the accent advisory — the page does not drop a palette over either', () => {
    const p = { ...buildPalette('#e8994a', 'mono')!, textMuted: '#151515', accent: '#121212' };
    const rep = paletteReport(p);
    expect(rep.checks[1].level).toBe('warn');
    expect(rep.checks[2].level).toBe('warn');
    expect(rep.blocked).toBe(false);
  });

  it('passes every shipped palette, which is the least it can do', () => {
    for (const [name, t] of Object.entries(THEME_PRESETS)) {
      const rep = paletteReport(paletteFromTheme(t as EventTheme));
      expect(rep.blocked, name).toBe(false);
      expect(rep.checks[0].level, name).toBe('good');
    }
  });
});

describe('palette: opening the picker on a theme that already exists', () => {
  // A saved custom theme, in the shape the column actually holds: the six colours the admin page
  // has always written, and neither of the two it used to drop.
  const saved: EventTheme = {
    bg: '#050d1a', surface: '#0a1628', surface2: '#0e1e36',
    border: '#162944', text: '#d0e8ff', accent: '#38bdf8',
    customCss: '.x{}', headerImage: '/uploads/abc.jpg'
  };

  it('hands back every stored colour byte for byte — opening and using it changes nothing', () => {
    const p = paletteFromTheme(saved);
    expect(p.bg).toBe(saved.bg);
    expect(p.surface).toBe(saved.surface);
    expect(p.surface2).toBe(saved.surface2);
    expect(p.border).toBe(saved.border);
    expect(p.text).toBe(saved.text);
    expect(p.accent).toBe(saved.accent);
  });

  it('fills only the two the editor used to drop, from the theme’s OWN accent family', () => {
    const p = paletteFromTheme(saved);
    // Not the shipped warm brown: an ocean theme should gain a muted blue.
    expect(p.textMuted).not.toBe('#9c8060');
    expect(hexToHsl(p.textMuted)!.h).toBeCloseTo(hexToHsl(saved.accent!)!.h, 0);
    expect(hexToHsl(p.accentDark)!.h).toBeCloseTo(hexToHsl(saved.accent!)!.h, 0);
  });

  it('opens on the theme’s accent, because that is the colour the host chose on purpose', () => {
    expect(baseFromTheme(saved)).toBe('#38bdf8');
    expect(baseFromTheme(null)).toBe('#e8994a');          // the shipped warm accent
    expect(baseFromTheme({})).toBe('#e8994a');
  });

  it('gives an event with no theme a full palette rather than an empty editor', () => {
    const p = paletteFromTheme(null);
    for (const v of Object.values(p)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
    expect(paletteReport(p).blocked).toBe(false);
  });
});
