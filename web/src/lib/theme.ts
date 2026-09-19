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
export function luminance(hex: string): number | null {
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

/** WCAG contrast ratio between two colours (1–21), or null if unparseable.
 *
 *  Exported because the custom-palette picker has to answer "is this legible?" with the SAME
 *  arithmetic the guard below uses. A second implementation there — even a correct one — would
 *  eventually disagree at the boundary, and the picker would bless a palette that applyEventTheme
 *  then silently throws away. See $lib/palette. */
export function contrast(a: string, b: string): number | null {
  const la = luminance(a), lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Apply a per-event theme (colours, font, mode, custom CSS) to the page.
 *  A custom colour palette is only applied if text↔background contrast is legible —
 *  this guards against malformed themes (e.g. an all-black palette) making the whole
 *  page invisible. Mode, font and custom CSS are always honoured. */
const EVENT_VARS = ['--bg', '--surface', '--surface-2', '--border', '--text', '--text-muted', '--accent', '--accent-fill', '--accent-dark', '--accent-ink', '--font'];

/** The floor the palette guard enforces: below this, text on the background is not "hard to read"
 *  but gone, and the whole page with it. 3:1 rather than WCAG's 4.5 body-text figure on purpose —
 *  this is a safety catch against a broken palette, not a house style, and refusing a host's
 *  merely-tight colours would be us overruling their design. The picker in $lib/palette imports
 *  this so it refuses exactly what this refuses, and only warns about the rest. */
export const PALETTE_MIN_CONTRAST = 3;

/** Legible ink for text and icons sitting ON the accent — a label on a primary button, a tick in a
 *  filled circle. Two answers, not a gradient: near-black on a light accent, white on a dark one.
 *
 *  Shared rather than inlined because the palette picker's preview has to make the same call as the
 *  page does, or a host would be shown white-on-yellow while the real Join button renders
 *  black-on-yellow. Null when the accent cannot be parsed, meaning "leave --accent-ink alone and
 *  let the app default stand". */
export function accentInk(accent: string): string | null {
  // Pick the ink that MEASURES better, rather than guessing from a luminance threshold.
  //
  // The threshold was 0.45, and it was wrong in the direction that matters: break-even between
  // near-black and white ink sits nearer 0.18, so every accent between the two got white when it
  // wanted black. Measured against the nine shipped palettes, five failed — including `warm`, the
  // DEFAULT event theme, where white on #e8994a is 2.31:1 while near-black is 8.17:1. The button
  // that says "Join the event" is the loudest control on a guest's phone, and on five of nine
  // themes its label was the least readable thing on the page.
  //
  // `contrast()` is right here and already exported, so there is no reason to approximate it. Two
  // answers, not a gradient — but now chosen rather than assumed.
  if (luminance(accent) === null) return null;   // unparseable: leave --accent-ink alone
  const onDark = contrast('#111', accent), onLight = contrast('#fff', accent);
  if (onDark === null || onLight === null) return null;
  return onDark >= onLight ? '#111' : '#fff';
}

// Default event palette — a warm look. Applied to any event that has no theme of its own, so
// every event page (join / gallery / manager) has a deliberate look and themes never bleed in
// from a previously-viewed event.
/** The palettes the Theme card offers, and the only place they are defined.
 *
 *  Lived inside the admin page until a poster preset needed to NAME one: picking "Botanical"
 *  applied a green palette of its own that was not `forest`, so the Theme card highlighted nothing
 *  and the host was left wondering whether it had worked. A preset that cannot be named cannot be
 *  shown as chosen. 'warm' is the default and listed first. */
/** Is this background light enough that the page should wear light chrome?
 *
 *  The threshold applyEventTheme has always used, lifted out because two other places now need to
 *  ask the same question — the custom palette builder (which light/dark to generate) and the
 *  picker that opens it. Asking it in three places with three thresholds is how a host ends up
 *  building a light palette in a modal that then renders their event dark. */
export function isLightBg(hex?: string | null): boolean {
  const l = hex ? luminance(hex) : null;
  return l !== null && l > 0.5;
}

export const THEME_PRESETS: Record<string, Partial<EventTheme>> = {
    warm:     { bg:'#1a1209', surface:'#231a0e', surface2:'#2c2010', border:'#3d2e18', text:'#f5e8c8', textMuted:'#9c8060', accent:'#e8994a', accentDark:'#c47830' },
    dark:     { bg:'#0f0f0f', surface:'#1a1a1a', surface2:'#222', border:'#2a2a2a', text:'#f5f5f5', textMuted:'#888', accent:'#a8ff78', accentDark:'#72d52d' },
    ocean:    { bg:'#050d1a', surface:'#0a1628', surface2:'#0e1e36', border:'#162944', text:'#d0e8ff', textMuted:'#6698bb', accent:'#38bdf8', accentDark:'#0ea5e9' },
    midnight: { bg:'#0a0a14', surface:'#111128', surface2:'#16163a', border:'#222248', text:'#e8e8ff', textMuted:'#6668aa', accent:'#818cf8', accentDark:'#6366f1' },
    forest:   { bg:'#0a130a', surface:'#111e11', surface2:'#162416', border:'#1e3020', text:'#d8f0d8', textMuted:'#5a8060', accent:'#4ade80', accentDark:'#22c55e' },
    pink:     { bg:'#1a0a14', surface:'#26101e', surface2:'#331528', border:'#46203a', text:'#ffe4f3', textMuted:'#b06a92', accent:'#f472b6', accentDark:'#ec4899' },
  // These two arrived with the poster designs (Minimal and Letterpress) and are offered here for
  // the same reason every other palette is: one the product already uses should be one a host can
  // CHOOSE, not one that can only appear as a side effect and then read as "custom".
  //
  // Both are deliberately quiet. `dark` is the other neutral, but its acid-green accent is a loud
  // note neither design wants — which is precisely why they did not just reuse it.
    mono:     { bg:'#101010', surface:'#191919', surface2:'#232323', border:'#333333', text:'#f2f2f2', textMuted:'#8f8f8f', accent:'#d6b26a', accentDark:'#b08f4e' },
    linen:    { bg:'#141414', surface:'#1d1d1c', surface2:'#272725', border:'#3a3a37', text:'#f2efe9', textMuted:'#98958d', accent:'#b9a88a', accentDark:'#968768' },
  // ── The light palettes, last so the row reads dark → light ──────────────────────────────────
  //
  // There is no light/dark switch because the BACKGROUND already decides it (see applyEventTheme):
  // a bg above 0.5 luminance puts the whole event in light chrome. That was sound, but it left the
  // capability unreachable — of the nine palettes above, exactly ONE (`light`) was light, so a host
  // who wanted a light event had one look to take or leave, while `linen` reads like a tenth and is
  // #141414. Four light options is the fix; a mode toggle would only have added a control that can
  // contradict the colours beside it.
  //
  // Eight a side, and most are the light counterpart of a dark palette above, so the two columns
  // pair up: light↔dark, cream↔warm, sky↔ocean, lilac↔midnight, sage↔forest, blush↔pink, and mist
  // is the cool neutral that answers mono. `clay` is the exception and has no dark twin:
  // the row had no warm RED at all in either direction, which is the one a lot of events actually
  // want — anything autumn, anything festive, anything with a red invitation.
  // The ladder inverts with them — `surface` is the LIGHTEST step (white) and `border` the darkest,
  // where a dark palette climbs the other way.
  //
  // Every accent here is deliberately dark rather than mid-tone: accentInk() has to clear 4.5:1
  // against it for the Join button's label, and a mid-tone accent clears neither white nor #111.
    light:    { bg:'#f5f5f0', surface:'#ffffff', surface2:'#f0f0ea', border:'#ddd', text:'#1a1a1a', textMuted:'#777', accent:'#2563eb', accentDark:'#1d4ed8' },
    cream:    { bg:'#faf6ee', surface:'#ffffff', surface2:'#f2ebdd', border:'#e2d8c4', text:'#2a2118', textMuted:'#7a6a55', accent:'#a14e0f', accentDark:'#7d3c0b' },
    mist:     { bg:'#f4f6f8', surface:'#ffffff', surface2:'#e9edf2', border:'#d3dae2', text:'#16202b', textMuted:'#5f7185', accent:'#0f766e', accentDark:'#0b544e' },
    blush:    { bg:'#fdf4f7', surface:'#ffffff', surface2:'#f8e8ef', border:'#eed3de', text:'#2b1520', textMuted:'#8a6375', accent:'#be185d', accentDark:'#971349' },
    sage:     { bg:'#f2f7f0', surface:'#ffffff', surface2:'#e6efe3', border:'#cfe0ca', text:'#16231a', textMuted:'#5a7560', accent:'#15803d', accentDark:'#106330' },
    clay:     { bg:'#fdf4f0', surface:'#ffffff', surface2:'#f8e7df', border:'#eed3c6', text:'#2b1a13', textMuted:'#8a6553', accent:'#b91c1c', accentDark:'#8f1515' },
    sky:      { bg:'#eff6fc', surface:'#ffffff', surface2:'#e2eef9', border:'#c6dcef', text:'#12212e', textMuted:'#54748f', accent:'#0369a1', accentDark:'#04527d' },
    lilac:    { bg:'#f7f4fd', surface:'#ffffff', surface2:'#ece5f9', border:'#d9cdf0', text:'#211a2e', textMuted:'#6f6289', accent:'#6d28d9', accentDark:'#571fae' }
  };

/** What each palette is CALLED on screen. The picker printed the raw key, which is fine for most of
 *  them and actively wrong for one: `linen` is ink-on-ecru inverted for a lit screen, so the key
 *  promises the lightest palette we ship and paints the second-darkest. The key itself has to stay
 *  — poster presets name it and saved events store it — so the label is where it gets told the
 *  truth. Anything absent here falls back to its key. */
export const THEME_PRESET_LABELS: Record<string, string> = {
  linen: 'ink & linen',
};

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
  const paletteOk = !(theme.bg && theme.text) || (ratio !== null && ratio >= PALETTE_MIN_CONTRAST);
  if (paletteOk) {
    const set = (k: string, v?: string) => { if (v) r.style.setProperty(k, v); };
    set('--bg', theme.bg); set('--surface', theme.surface); set('--surface-2', theme.surface2);
    set('--border', theme.border); set('--text', theme.text); set('--text-muted', theme.textMuted);
    set('--accent', theme.accent); set('--accent-dark', theme.accentDark);
    // --accent-fill follows the event accent too. The app splits the brand yellow in two because a
    // light page needs one value for TEXT and a brighter one for FILLS; an event palette has no such
    // split, so the fill has to be told, or the guest's Join button stays brand yellow on an
    // otherwise green event. That was not a decision anyone made — the line below it has always
    // computed --accent-ink from theme.accent, which is ink chosen for a fill that never arrived: an
    // event with a dark accent got WHITE ink on the unchanged yellow button, about 1.4:1.
    set('--accent-fill', theme.accent);
    // Pick legible ink for text/icons on the accent (e.g. labels on primary buttons).
    if (theme.accent) {
      const ink = accentInk(theme.accent);
      if (ink) r.style.setProperty('--accent-ink', ink);
    }
  }

  // Appearance follows the PALETTE (a light bg ⇒ light chrome) — no separate mode toggle needed.
  // An explicit theme.mode (legacy events) still wins for back-compat.
  if (theme.mode) {
    r.setAttribute('data-theme', isLight(theme.mode) ? 'light' : 'dark');
  } else if (theme.bg && luminance(theme.bg) !== null) {
    r.setAttribute('data-theme', isLightBg(theme.bg) ? 'light' : 'dark');
  }

  if (theme.font) r.style.setProperty('--font', theme.font);
  if (theme.customCss) { const s = document.createElement('style'); s.setAttribute('data-event-css', ''); s.textContent = theme.customCss; document.head.appendChild(s); }
}
