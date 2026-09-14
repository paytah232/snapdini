// Starting points for a poster, so nobody faces a blank canvas.
//
// A preset IS a saved poster config — the same object shape the designer already persists to
// `events.poster_config` and reads back in `restore()`. That is the whole trick: the wizard hands
// one to PosterModal as `initialConfig` and the existing restore path applies it. No parallel
// format, no second code path, nothing to keep in step.
//
// WHAT A PRESET SETS, AND WHAT IT MUST NOT.
// It sets the LOOK: paper, ink, decoration, and how the join details are shown. It deliberately
// omits `headline`, `message` and `stepsText`, because `restore()` reads every field with `??` —
// so an absent one keeps what the host already wrote. Picking a style must never eat their words.
//
// `colorsLocked: true` on every preset. Without it the designer keeps recomputing text colours from
// the event theme, and the preset's palette would be quietly overwritten by the very next reactive
// pass. Locking is what makes a chosen style stick.
//
// `printBg` is the "background is the PAPER" idea: on the tinted presets the colour is shown the
// whole time you design — so ink is chosen against what it will really sit on — but left off what
// prints, because a host ordering cream stock does not want us spraying cream ink onto it.
//
// The vocabulary here is not invented. It follows the stationery research that produced the motifs
// in cardDecor.ts: restraint is the signal, one focal flourish rather than scattered ornament, two
// weights never three, negative space doing the decorating. Everything is stroke-only or untinted —
// these get printed, often on a home printer, where a heavy fill is both ugly and expensive.

import type { DecorKind, DecorPos } from './cardDecor';
import type { TitleFace, TypeSetKey } from './posterFonts';
import type { EventTheme } from './events';
import { THEME_PRESETS } from './theme';

export interface PosterPreset {
  key: string;
  label: string;
  /** One line, shown under the name in the picker. Says what it is FOR, not what it looks like —
   *  the thumbnail already shows that. */
  blurb: string;
  /** A partial poster config, applied through the designer's own restore(). */
  cfg: Record<string, unknown>;
  /** The matching palette for the GUEST-FACING APP — the join screen, the camera chrome, the
   *  gallery — so choosing a design themes the whole event rather than only the paper.
   *
   *  Deliberately NOT derived from the poster's colours, which would be the obvious shortcut and
   *  the wrong one. A poster palette is for PRINT: light stock, dark ink, because that is what a
   *  printer can do and what paper is. The app is dark-first and lit from behind. Botanical's cream
   *  #fbf9f4 as an app background would not read as the same design, it would read as the lights
   *  coming on. So each preset carries a screen palette that shares its CHARACTER — its hue, its
   *  restraint, its accent — rather than its literal values. */
  theme: EventTheme;
  /** The Theme card's own preset this palette IS, when it is one of them.
   *
   *  Naming it rather than only applying colours is what lets the Theme card show the choice as
   *  selected — picking Botanical applied a green and highlighted nothing, which reads as the
   *  setting not having taken.
   *
   *  Optional in the type because a preset need not have a matching built-in palette — the card says
   *  "Custom" when it does not. In practice all eight now do: `mono` and `linen` were added to
   *  THEME_PRESETS precisely so Minimal and Letterpress could name one instead of being tuned to
   *  their paper with nothing on the card to show for it. */
  themePreset?: string;
}

/** Shared by every preset: lock the palette, and keep the join details legible and present. */
const base = {
  colorsLocked: true,
  bgMode: 'plain' as const,
  codeDisplay: 'url' as const,
  showFooterUrl: true,
};

const decor = (kind: DecorKind, pos: DecorPos, scale: number, colour: string) =>
  ({ decorKind: kind, decorPos: pos, decorScale: scale, decorColour: colour });

/** The typeface pairing, and whether the title leads with the structural face or the script one.
 *
 *  This is the single biggest difference between a preset and a default, and until the faces were
 *  bundled it was not available: every preset drew in the same Helvetica stack, so a style could
 *  change the paper and the line art and nothing about the words. It sets the FACES only — never
 *  `headlineTop` or `headlineBottom`, which are words, and words belong to the host. */
const type_ = (set: TypeSetKey, face: TitleFace) => ({ typeSetKey: set, titleFace: face });

export const POSTER_PRESETS: PosterPreset[] = [
  {
    key: 'minimal',
    label: 'Minimal',
    blurb: 'One fine-line camera, and room to breathe. Cheapest to print.',
    cfg: {
      ...base,
      // A single line-drawn camera rather than nothing at all. Bare was TOO bare — it read as an
      // unstyled default rather than as a decision — and the camera is the one motif that is about
      // this product rather than about weddings. One focal flourish, drawn monoline, is exactly the
      // restraint the research described; "no decoration" is not the same thing as restraint.
      //
      // The one-line camera, not the QR surround: it is the motif drawn without lifting the pen,
      // which is what makes a bare layout read as drawn rather than as unstyled.
      ...decor('cameraline', 'top', 1, '#111111'),
      ...type_('modern', 'display'),
      cBg: '#ffffff', printBg: false,
      cHeadline: '#111111', cMessage: '#3d3d3d', cSteps: '#3d3d3d', cCode: '#111111', cFooter: '#6b6b6b',
    },
    // `mono` — neutral and quiet like the paper, with one warm note. With no motif and no colour
    // on the poster, the app is where this design gets to breathe at all.
    theme: THEME_PRESETS.mono as EventTheme, themePreset: 'mono',
  },
  {
    key: 'botanical',
    label: 'Botanical',
    blurb: 'A single sprig. Weddings, showers, garden parties.',
    cfg: {
      ...base,
      // The sprig is one focal flourish at the top rather than ornament in every corner.
      ...decor('botanical', 'top', 1.1, '#6b7f5e'),
      ...type_('garden', 'script'),
      cBg: '#fbf9f4', printBg: false,
      cHeadline: '#2f3a2c', cMessage: '#4a5546', cSteps: '#4a5546', cCode: '#2f3a2c', cFooter: '#7c8578',
    },
    // Literally the Theme card's `forest`, not a green of its own — so the card can show it as
    // selected, and there is one definition of the palette rather than two that drift.
    theme: THEME_PRESETS.forest as EventTheme, themePreset: 'forest',
  },
  {
    key: 'deco',
    label: 'Art deco',
    blurb: 'Symmetry and geometry. Black tie, birthdays, NYE.',
    cfg: {
      ...base,
      // Deco is the other whole stationery vocabulary — geometry rather than nature — and it wants
      // both positions, because its symmetry is the point.
      ...decor('deco', 'both', 1, '#b08d3f'),
      ...type_('editorial', 'display'),
      cBg: '#12100d', printBg: true,
      // Light ink on a dark ground, which a home printer cannot do — the designer's own
      // lighter-than-the-paper check surfaces that as a note, and sign shops print it happily.
      cHeadline: '#f0e6cf', cMessage: '#d9cdb0', cSteps: '#d9cdb0', cCode: '#12100d', cFooter: '#b08d3f',
    },
    // `warm` — amber on near-black is the closest the built-ins get to gold, and close enough
    // that inventing a second near-identical palette would only make the card lie about it.
    theme: THEME_PRESETS.warm as EventTheme, themePreset: 'warm',
  },
  {
    key: 'letterpress',
    label: 'Letterpress',
    blurb: 'A fine rule and a heavier frame. Formal invitations.',
    cfg: {
      ...base,
      // The letterpress contrast the research described: a hairline set against one heavier
      // element, never three weights competing.
      ...decor('frame', 'top', 1, '#2b2b2b'),
      ...type_('formal', 'display'),
      cBg: '#f2efe9', printBg: false,
      cHeadline: '#1c1c1c', cMessage: '#40403c', cSteps: '#40403c', cCode: '#1c1c1c', cFooter: '#77756e',
    },
    // `linen` — ecru on charcoal, the printed card's restraint inverted for a lit screen. The
    // most muted accent of the five, because a letterpress suite that shouts is not one.
    theme: THEME_PRESETS.linen as EventTheme, themePreset: 'linen',
  },
  {
    key: 'celebration',
    label: 'Celebration',
    blurb: 'Confetti and colour. Birthdays, hens, work parties.',
    cfg: {
      ...base,
      ...decor('confetti', 'both', 1, '#e0483d'),
      ...type_('modern', 'script'),
      cBg: '#ffffff', printBg: false,
      cHeadline: '#16232e', cMessage: '#3f4a54', cSteps: '#3f4a54', cCode: '#16232e', cFooter: '#7b858d',
    },
    // `pink` — the one built-in whose job is also to look like a party.
    theme: THEME_PRESETS.pink as EventTheme, themePreset: 'pink',
  },
  {
    key: 'wavy',
    label: 'Wavy',
    blurb: 'A hand-drawn wobble and a script name. Modern, warm, not fussy.',
    cfg: {
      ...base,
      // The border IS the design here, so nothing else competes: no corner motif, no rule, and the
      // title carries the only flourish. Straight from the reference signs, where a wobbly frame on
      // cream does all the work a printed ornament used to.
      ...decor('wave', 'top', 1, '#1d1d1b'),
      ...type_('modern', 'script'),
      cBg: '#faf7f1', printBg: false,
      cHeadline: '#1d1d1b', cMessage: '#4a4842', cSteps: '#4a4842', cCode: '#1d1d1b', cFooter: '#86837a',
    },
    // `linen` — the warm off-white inverted for a lit screen, and the quietest accent we have.
    theme: THEME_PRESETS.linen as EventTheme, themePreset: 'linen',
  },
  {
    key: 'sweetheart',
    label: 'Sweetheart',
    blurb: 'A camera with a heart for a lens. Weddings, engagements, hens.',
    cfg: {
      ...base,
      // The single most repeated idea across every reference sign, and the one that makes a camera
      // read as affectionate rather than as equipment.
      ...decor('heartlens', 'top', 1.05, '#7a2338'),
      ...type_('formal', 'script'),
      cBg: '#ffffff', printBg: false,
      cHeadline: '#2a1620', cMessage: '#584450', cSteps: '#584450', cCode: '#2a1620', cFooter: '#8d7f87',
    },
    theme: THEME_PRESETS.pink as EventTheme, themePreset: 'pink',
  },
  {
    key: 'editorial',
    label: 'Editorial',
    blurb: 'Big high-contrast serif, nothing else. Bold on a wall.',
    cfg: {
      ...base,
      // No motif at all, deliberately — this is the one design where the TYPE is the ornament, and
      // adding line art to it would be adding a second voice to a page that only wants one.
      ...decor('none', 'top', 1, '#111111'),
      ...type_('editorial', 'display'),
      cBg: '#ffffff', printBg: false,
      cHeadline: '#111111', cMessage: '#3a3a3a', cSteps: '#3a3a3a', cCode: '#111111', cFooter: '#7a7a7a',
    },
    theme: THEME_PRESETS.mono as EventTheme, themePreset: 'mono',
  },
];

export const presetByKey = (key: string): PosterPreset | undefined =>
  POSTER_PRESETS.find((p) => p.key === key);

/** Which design to put first for a given kind of event.
 *
 *  A suggestion, never a decision — the gallery still shows all eight and the host picks. The point
 *  is that someone making a wedding sign should not have to work out for themselves that Botanical
 *  is the one, and that a preset list in a fixed order silently privileges whatever happens to be
 *  first for everybody.
 *
 *  The keys are the mission-pack keys (see EVENT_TYPES in challenges.ts), which are the same values
 *  `decorFor()` and `tickFor()` key off — one vocabulary for "what kind of event is this", not a
 *  second one invented here. An unknown or unstated type maps to nothing, which leaves the gallery
 *  in its declared order. */
const PRESET_FOR_TYPE: Record<string, string> = {
  wedding: 'botanical',
  engagement: 'sweetheart',
  'baby-shower': 'botanical',
  hens: 'sweetheart',
  birthday: 'celebration',
  graduation: 'celebration',
  christmas: 'deco',
  corporate: 'letterpress',
  general: 'minimal',
};

export const presetForEventType = (type: string | null | undefined): PosterPreset | undefined =>
  presetByKey(PRESET_FOR_TYPE[type ?? ''] ?? '');

/** The gallery's order for this event: the suggested design first, everything else as declared.
 *
 *  Stable — no sorting by anything that could change between renders, because a gallery that
 *  reshuffles while you are looking at it is a gallery you cannot point at. */
export const presetsForEventType = (type: string | null | undefined): PosterPreset[] => {
  const first = presetForEventType(type);
  if (!first) return POSTER_PRESETS;
  return [first, ...POSTER_PRESETS.filter((p) => p.key !== first.key)];
};
