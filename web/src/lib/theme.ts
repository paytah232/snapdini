import { browser } from '$app/environment';
import type { EventTheme } from './events';

export type ThemeMode = 'system' | 'light' | 'dark';

/** Resolve a mode to whether light should be active. */
export function isLight(mode: ThemeMode): boolean {
  if (mode === 'light') return true;
  if (mode === 'dark') return false;
  return browser ? matchMedia('(prefers-color-scheme: light)').matches : false;
}

/** Apply a theme mode by toggling [data-theme] on <html>. */
export function applyTheme(mode: ThemeMode = 'system'): void {
  if (!browser) return;
  document.documentElement.setAttribute('data-theme', isLight(mode) ? 'light' : 'dark');
}

/** Relative luminance (0–1) of a #rgb / #rrggbb colour, per WCAG. */
function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const ch = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG contrast ratio between two colours (1–21), or null if unparseable. */
function contrast(a: string, b: string): number | null {
  const la = luminance(a), lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Apply a per-event theme (colours, font, mode, custom CSS) to the page.
 *  A custom colour palette is only applied if text↔background contrast is legible —
 *  this guards against malformed themes (e.g. an all-black palette) making the whole
 *  page invisible. Mode, font and custom CSS are always honoured. */
const EVENT_VARS = ['--bg', '--surface', '--surface-2', '--border', '--text', '--text-muted', '--accent', '--accent-dark', '--accent-ink', '--font'];

// Default event palette — a warm look. Applied to any event that has no theme of its own, so
// every event page (join / gallery / manager) has a deliberate look and themes never bleed in
// from a previously-viewed event.
export const DEFAULT_EVENT_THEME: EventTheme = {
  bg: '#1a1209', surface: '#231a0e', surface2: '#2c2010', border: '#3d2e18',
  text: '#f5e8c8', textMuted: '#9c8060', accent: '#e8994a', accentDark: '#c47830',
};

/** Strip any per-event palette/font/custom-CSS overrides from <html>. Call when leaving an event
 *  page for the marketing/app chrome (home, login, dashboard…) so an event's look never bleeds in.
 *  The chrome's light/dark mode is restored separately via the appearance preference. */
export function clearEventTheme(): void {
  if (!browser) return;
  const r = document.documentElement;
  for (const v of EVENT_VARS) r.style.removeProperty(v);
  document.querySelectorAll('style[data-event-css]').forEach((e) => e.remove());
}

export function applyEventTheme(theme: EventTheme | null | undefined): void {
  if (!browser) return;
  const r = document.documentElement;

  // ALWAYS clear any previous per-event overrides first, so a theme never bleeds into the next
  // event. An event with no theme of its own falls back to the warm default below.
  for (const v of EVENT_VARS) r.style.removeProperty(v);
  document.querySelectorAll('style[data-event-css]').forEach((e) => e.remove());

  // No event theme → use the warm default (NOT the app's dark chrome) so event pages are themed.
  if (!theme || Object.keys(theme).length === 0) theme = DEFAULT_EVENT_THEME;

  // Only trust the palette when bg & text are present AND legibly contrasting.
  const ratio = theme.bg && theme.text ? contrast(theme.bg, theme.text) : null;
  const paletteOk = !(theme.bg && theme.text) || (ratio !== null && ratio >= 3);
  if (paletteOk) {
    const set = (k: string, v?: string) => { if (v) r.style.setProperty(k, v); };
    set('--bg', theme.bg); set('--surface', theme.surface); set('--surface-2', theme.surface2);
    set('--border', theme.border); set('--text', theme.text); set('--text-muted', theme.textMuted);
    set('--accent', theme.accent); set('--accent-dark', theme.accentDark);
    // Pick legible ink for text/icons on the accent (e.g. labels on primary buttons).
    if (theme.accent) {
      const la = luminance(theme.accent);
      if (la !== null) r.style.setProperty('--accent-ink', la > 0.45 ? '#111' : '#fff');
    }
  }

  // Appearance follows the PALETTE (a light bg ⇒ light chrome) — no separate mode toggle needed.
  // An explicit theme.mode (legacy events) still wins for back-compat.
  if (theme.mode) {
    r.setAttribute('data-theme', isLight(theme.mode) ? 'light' : 'dark');
  } else if (theme.bg) {
    const bgLum = luminance(theme.bg);
    if (bgLum !== null) r.setAttribute('data-theme', bgLum > 0.5 ? 'light' : 'dark');
  }

  if (theme.font) r.style.setProperty('--font', theme.font);
  if (theme.customCss) { const s = document.createElement('style'); s.setAttribute('data-event-css', ''); s.textContent = theme.customCss; document.head.appendChild(s); }
}
