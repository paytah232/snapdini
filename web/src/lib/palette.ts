// Inventing an event palette from ONE colour the host picked.
//
// WHY THIS IS NOT IN theme.ts. theme.ts owns the palettes we ship (THEME_PRESETS) and the single
// contrast guard that decides whether a palette is safe to put on the page. This file owns the
// arithmetic that makes up a palette that was never shipped. It IMPORTS the guard rather than
// restating it, and that is the load-bearing part: if "legible" were defined twice, the picker
// would happily bless a palette that applyEventTheme then silently discards — and from the host's
// side a silent discard looks like the setting not having taken at all. One definition, or the
// feature lies.
//
// WHY HSL AND NOT A COLOUR LIBRARY. Everything here is hue rotation plus lightness targets, which
// is a dozen lines of sRGB↔HSL. A dependency would buy nothing, weigh more than the maths, and the
// pages this runs on serve a CSP that restricts script sources — so a library is both unwarranted
// and awkward. HSL is not perceptually uniform; that is why nothing below trusts it to decide
// legibility. It proposes, and WCAG contrast (theme.ts) disposes.

import { accentInk, contrast, DEFAULT_EVENT_THEME, isLightBg, PALETTE_MIN_CONTRAST } from './theme';
import type { EventTheme } from './events';

/** Hue 0–360, saturation and lightness 0–1. */
export interface Hsl {
  h: number;
  s: number;
  l: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Every spelling a saved theme might hold → `#rrggbb`, or null when it is not one we can do
 *  arithmetic on. `#abc` and `rgb(1, 2, 3)` are both real values in stored themes — the shipped
 *  `light` palette stores `#ddd` — and the server's own colour regex accepts named colours and
 *  8-digit hex besides, which this deliberately does NOT claim to understand. Null is the honest
 *  answer for those; each caller below decides what to do with it. */
function hexSix(val?: string): string | null {
  if (!val) return null;
  const v = val.trim();
  if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + [...v.slice(1)].map((c) => c + c).join('');
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  // Unanchored on purpose: this is the pattern the admin page has always used, and it matches the
  // bare "1, 2, 3" a CSS variable can hold as well as a full rgb(…).
  const m = v.match(/(\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return '#' + [m[1], m[2], m[3]].map((n) => clamp(parseInt(n, 10), 0, 255).toString(16).padStart(2, '0')).join('');
}

/** The strict form: a guaranteed `#rrggbb`, because that is the ONLY thing `<input type="color">`
 *  accepts — hand it anything else and the swatch renders empty with no error anywhere. Black is
 *  the fallback for the unreadable, which is what the admin page's own normalizeHex has always
 *  done for the same reason. */
export function toHex6(val?: string): string {
  return hexSix(val) ?? '#000000';
}

/** The lenient form, for round-tripping a STORED value: anything hexSix understands is normalised,
 *  and anything else that at least looks like a hex colour (an 8-digit one set through the API) is
 *  passed through untouched rather than flattened to black. The admin page's normalizeHex is this
 *  plus its historic '#000000' floor. */
export function normalizeStoredColor(val?: string): string {
  return hexSix(val) ?? (val?.trim().startsWith('#') ? val.trim() : '#000000');
}

/** `#rgb` / `#rrggbb` / `rgb(r,g,b)` → HSL, or null if it is not a colour we can do maths on. */
export function hexToHsl(val?: string): Hsl | null {
  const hex = hexSix(val);
  if (!hex) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i + 1, i + 3), 16) / 255);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s, l };
}

/** HSL → `#rrggbb`. Out-of-range input is clamped rather than rejected, so callers can do
 *  arithmetic on lightness without guarding every subtraction. */
export function hslToHex({ h, s, l }: Hsl): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 1),
    lig = clamp(l, 0, 1);
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;
  const seg = Math.floor(hue / 60) % 6;
  const rgb = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x]
  ][seg].map((v) => Math.round((v + m) * 255));
  return '#' + rgb.map((v) => clamp(v, 0, 255).toString(16).padStart(2, '0')).join('');
}

/** How far round the wheel the BACKGROUND family sits from the colour the host picked.
 *
 *  The rotation is applied to the background, never to the accent. That is the whole reason the
 *  word "complementary" means anything here: a host picks their colour, and the choice on offer is
 *  what to set it AGAINST. Rotating the accent instead would answer a question nobody asked —
 *  "here is a different colour from the one you chose" — and is how colour tools end up feeling
 *  like they are arguing with you. */
export const HARMONIES = [
  { key: 'mono', label: 'Monochrome', blurb: 'One hue throughout — quietest', shift: 0 },
  { key: 'analogous', label: 'Analogous', blurb: 'The hue next door — gentle', shift: 30 },
  { key: 'triadic', label: 'Triadic', blurb: 'A third of the wheel — distinct', shift: 120 },
  { key: 'complement', label: 'Complementary', blurb: 'Straight opposite — boldest', shift: 180 }
] as const;

export type HarmonyKey = (typeof HARMONIES)[number]['key'];

/** Which way up the palette is built. The app is dark-first and that is still the default; this is
 *  the host's to change, not ours to guess. */
export type PaletteMode = 'dark' | 'light';

/** The lightness rungs each mode climbs — page, card, raised card, border, text, muted text.
 *
 *  Read off THEME_PRESETS rather than invented, in both directions: the dark rungs are `warm`
 *  (7/10/13/20%) and `ocean` (6/9/13/16%); the light ones are `light` and `cream`, which put the
 *  page near 96%, the card at white, and the border down at ~85%. A generated palette that ignored
 *  them would not look like it belongs in the same product as the ones we ship. */
const RUNGS: Record<PaletteMode, { bg: number; surface: number; surface2: number; border: number; text: number; muted: number }> = {
  dark:  { bg: 0.065, surface: 0.105, surface2: 0.145, border: 0.225, text: 0.93,  muted: 0.56 },
  light: { bg: 0.965, surface: 0.995, surface2: 0.925, border: 0.845, text: 0.115, muted: 0.43 },
};

/** An accent at this hue that the Join button's LABEL can actually be read on.
 *
 *  Only light mode needs it, and it is the whole reason light mode cannot simply reuse the dark
 *  ladder upside down. `accentInk()` picks near-black or near-white for the label, and a mid-tone
 *  accent clears 4.5:1 against NEITHER — #b4661a manages 4.32 on white and 4.37 on black, so the
 *  loudest control on a guest's phone becomes the least readable thing on it. Lightness alone will
 *  not settle it either, because luminance is hue-dependent: a blue at 45% is safe and a yellow at
 *  the same 45% is not. So walk the colour down until the ink on it is legible, and stop there.
 *
 *  The cost is that light mode can hand back a DARKER accent than the host picked, which dark mode
 *  never does (see buildPalette's promise). That is the honest trade: a light page cannot carry a
 *  pale accent, and returning one that cannot be read would be the picker lying about the result. */
function legibleAccent(h: number, s: number, l: number): string {
  for (let cand = l; cand >= 0.16; cand -= 0.03) {
    const hex = hslToHex({ h, s, l: cand });
    const ink = accentInk(hex);
    if (ink && (contrast(ink, hex) ?? 0) >= 4.5) return hex;
  }
  return hslToHex({ h, s, l: 0.16 });
}

/** The eight colours an event palette actually needs, none of them optional.
 *  Deliberately a subset of EventTheme: a palette is colours, not fonts or custom CSS. */
export interface CustomPalette {
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentDark: string;
}

/** Which of the eight a host may nudge by hand, and what to call each one.
 *
 *  Four, not eight. `surface-2`, `border` and the two derived shades are structure — they have to
 *  keep their distance from their neighbours or cards stop reading as cards, and there is no
 *  sentence you can write next to a "Raised card" swatch that makes choosing it a good use of a
 *  host's evening. These four are the ones with names a host already has. */
export const TWEAKABLE = [
  { key: 'bg', label: 'Background' },
  { key: 'surface', label: 'Cards' },
  { key: 'text', label: 'Text' },
  { key: 'accent', label: 'Accent' }
] as const;

/** Build a whole event palette from one colour, one harmony and one direction (dark or light).
 *
 *  The ACCENT is the host's colour, kept at its own hue and saturation, with only its lightness
 *  pulled into the band where it can still be seen on a dark page. Pick a well-judged accent
 *  (#e8994a, the one this product ships) and you get it back byte for byte; pick near-black and you
 *  get that hue at a lightness that exists. A picker that silently returns something else for a
 *  good input is one nobody trusts twice.
 *
 *  The rest of the palette is the background family: one hue (rotated by the harmony), climbing
 *  through the same lightness rungs every shipped palette uses — page, card, raised card, border —
 *  then text near the top of the range and muted text half way. Those rungs are read off
 *  THEME_PRESETS rather than invented: `warm` sits at 7/10/13/20% lightness, `ocean` at 6/9/13/16%,
 *  and a generated palette that ignored them would not look like it belongs in the same product.
 *
 *  DARK IS THE DEFAULT, and stays it: the app is lit from behind and the guest screens are built
 *  for a room with the lights down. It is no longer the only option, though, and the reason is the
 *  host's, not ours — a host who has just picked a light palette and opens this to adjust it was
 *  being dragged back to dark with no way to say otherwise, which is the picker overruling a choice
 *  they had already made. `mode` is that say. Light mode is NOT the dark ladder upside down: it
 *  inverts the rungs (see RUNGS) and darkens the accent until its label is legible (legibleAccent).
 *
 *  THE PROMISE, and its one exception. In DARK mode a well-judged accent comes back byte for byte
 *  — pick #e8994a, the colour this product ships, and that is exactly what you get. In LIGHT mode
 *  it cannot: a pale page needs a dark accent, so the colour is walked down until the Join button's
 *  label can be read on it. A picker that returns a different colour from the one you chose is one
 *  nobody trusts twice, which is why this is the only place it happens and why it is written down.
 *
 *  Returns null only when the base colour cannot be parsed — never a half-built palette. */
export function buildPalette(
  baseHex: string,
  harmony: HarmonyKey | string = 'mono',
  mode: PaletteMode = 'dark',
): CustomPalette | null {
  const base = hexToHsl(baseHex);
  if (!base) return null;
  const shift = (HARMONIES.find((h) => h.key === harmony) ?? HARMONIES[0]).shift;
  const r = RUNGS[mode] ?? RUNGS.dark;
  const light = mode === 'light';

  const aS = clamp(base.s, 0.35, 0.95);
  // Dark pages need the accent lifted off the floor; light pages need it pulled down far enough to
  // read against. Same clamp, opposite ends of the range.
  const aL = light ? clamp(base.l, 0.22, 0.48) : clamp(base.l, 0.45, 0.72);
  const bh = (base.h + shift) % 360;
  // Backgrounds carry less saturation than the accent they sit behind: at 6% lightness a fully
  // saturated hue reads as a colour cast rather than as a dark room. The same holds at 96%, where
  // it reads as a wash rather than as paper.
  const bS = clamp(base.s * 0.8, 0.1, 0.6);
  const accent = light ? legibleAccent(base.h, aS, aL) : hslToHex({ h: base.h, s: aS, l: aL });
  // Darker than the accent in both modes — it is the pressed/hover colour, not a second accent.
  const accentL = hexToHsl(accent)?.l ?? aL;

  return {
    bg: hslToHex({ h: bh, s: bS, l: r.bg }),
    surface: hslToHex({ h: bh, s: bS * 0.92, l: r.surface }),
    surface2: hslToHex({ h: bh, s: bS * 0.85, l: r.surface2 }),
    border: hslToHex({ h: bh, s: bS * 0.7, l: r.border }),
    text: hslToHex({ h: bh, s: clamp(base.s * 0.25, 0.04, 0.22), l: r.text }),
    textMuted: hslToHex({ h: bh, s: clamp(base.s * 0.35, 0.06, 0.35), l: r.muted }),
    accent,
    accentDark: hslToHex({ h: base.h, s: aS, l: Math.max(0.08, accentL - 0.12) })
  };
}

/** The colour the picker should open on: the theme's own accent, because that is the one the host
 *  chose on purpose. Falls back to the shipped warm accent for an event that has no theme yet. */
export function baseFromTheme(t?: EventTheme | null): string {
  return toHex6(t?.accent || DEFAULT_EVENT_THEME.accent);
}

/** A saved theme → the eight colours the picker edits, WITHOUT changing any of them.
 *
 *  Every value present in the theme is passed through verbatim, spelling and all. This is what
 *  makes opening the picker on an existing event and closing it again a no-op: nothing is
 *  re-derived, re-rounded or re-cased behind the host's back.
 *
 *  Only the two keys the admin page never used to persist — textMuted and accentDark — can be
 *  missing, and they are filled from a MONOCHROME palette built off the theme's own accent rather
 *  than from the shipped warm default. An ocean-ish custom theme that never stored a muted text
 *  colour should gain a muted blue, not a muted brown. */
export function paletteFromTheme(t?: EventTheme | null): CustomPalette {
  // Non-null: baseFromTheme always returns a parseable #rrggbb. Generated the same way up as the
  // theme it is filling in: a light event missing a muted text colour should gain a light one, not
  // a near-white value that vanishes into its own page.
  const gen = buildPalette(baseFromTheme(t), 'mono', isLightBg(t?.bg) ? 'light' : 'dark') as CustomPalette;
  const pick = (v: string | undefined, fallback: string) => (v && v.trim() ? v : fallback);
  return {
    bg: pick(t?.bg, gen.bg),
    surface: pick(t?.surface, gen.surface),
    surface2: pick(t?.surface2, gen.surface2),
    border: pick(t?.border, gen.border),
    text: pick(t?.text, gen.text),
    textMuted: pick(t?.textMuted, gen.textMuted),
    accent: pick(t?.accent, gen.accent),
    accentDark: pick(t?.accentDark, gen.accentDark)
  };
}

/** Comfortable reading contrast (WCAG AA for body text). Above the guard's floor on purpose: the
 *  floor is "can this be seen at all", this is "would you want to read a page of it". */
export const CONTRAST_COMFORTABLE = 4.5;

export interface ContrastCheck {
  key: 'text' | 'muted' | 'accent';
  /** Said as the thing it affects, not as the token it is. A host does not have a `--text-muted`. */
  label: string;
  /** WCAG ratio 1–21, or null when a colour could not be read as a colour. */
  ratio: number | null;
  level: 'good' | 'warn' | 'fail';
  /** What to do about it, in words, on the screen where it can still be changed. */
  note: string;
}

/** Score a palette the way the page will.
 *
 *  `blocked` is deliberately the SAME condition as applyEventTheme's palette guard — body text
 *  against the background, below PALETTE_MIN_CONTRAST — so the picker refuses exactly what the page
 *  would have thrown away, no more and no less. Nothing else blocks: muted text and the accent are
 *  advisory, because the guard does not drop a palette over either, and a picker that refused more
 *  than the page does would be inventing a rule the rest of the product has never enforced. */
export function paletteReport(p: CustomPalette): { checks: ContrastCheck[]; blocked: boolean } {
  const rText = contrast(p.text, p.bg);
  const rMuted = contrast(p.textMuted, p.bg);
  const rAccent = contrast(p.accent, p.bg);

  const textLevel: ContrastCheck['level'] =
    rText === null || rText < PALETTE_MIN_CONTRAST ? 'fail' : rText < CONTRAST_COMFORTABLE ? 'warn' : 'good';

  const checks: ContrastCheck[] = [
    {
      key: 'text',
      label: 'Event name and body text',
      ratio: rText,
      level: textLevel,
      note:
        rText === null
          ? 'One of these two isn’t a colour we can read.'
          : textLevel === 'fail'
            ? 'Too close to the background — your guests could not read this, so it can’t be used. Lighten the text, or darken the background.'
            : textLevel === 'warn'
              ? 'Readable, but tight. A little more difference is kinder on a phone in a dark room.'
              : 'Easy to read.'
    },
    {
      key: 'muted',
      label: 'Hints and small print',
      ratio: rMuted,
      level: rMuted === null || rMuted < PALETTE_MIN_CONTRAST ? 'warn' : 'good',
      note:
        rMuted === null || rMuted < PALETTE_MIN_CONTRAST
          ? 'The smaller grey text will be hard to make out.'
          : 'Clear enough for the small stuff.'
    },
    {
      key: 'accent',
      label: 'Buttons and highlights',
      ratio: rAccent,
      level: rAccent === null || rAccent < PALETTE_MIN_CONTRAST ? 'warn' : 'good',
      note:
        rAccent === null || rAccent < PALETTE_MIN_CONTRAST
          ? 'Your accent barely stands out from the background, so the Join button is easy to miss.'
          : 'Stands out nicely.'
    }
  ];

  return { checks, blocked: textLevel === 'fail' };
}
