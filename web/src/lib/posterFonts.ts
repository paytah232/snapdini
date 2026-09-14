// ── Poster typography ────────────────────────────────────────────────────────
// Every reference sign a host might compare us against sets two or three typefaces with distinct
// jobs: a SCRIPT for the emotional word, a DISPLAY face for the structural caps, and a small
// wide-tracked face for the instructions. The contrast between them IS the design — the line art is
// an accent around it. We drew everything in one Helvetica stack, which is why our posters all read
// as the same poster no matter which preset made them.
//
// The faces are self-hosted in static/fonts (OFL 1.1, see the README there) rather than pulled from
// a font CDN, for two reasons: the app has to work on a venue's bad wifi, and a canvas export must
// not silently print in Arial because a third party was slow.
//
// ── The trap this module exists to close ──
// ctx.font accepts a family that has not loaded and falls back WITHOUT ERROR. So a poster exported
// before the webfont arrives is a poster in Arial — and it is the PNG the host prints, not a preview
// they can re-render. Nothing may paint until ensurePosterFonts() has resolved.

export type TypeSetKey = 'plain' | 'editorial' | 'formal' | 'garden' | 'modern';

/** One face, and how it wants to be set. `upper` and `tracking` are part of the face's JOB here:
 *  an instruction line in Jost is only right in caps at 0.14em, and a preset that forgot that would
 *  look like a mistake rather than a choice. */
export type Face = {
  family: string;          // a full CSS font-family list, fallback included
  weight: number;
  tracking: number;        // em, applied via ctx.letterSpacing where supported
  upper: boolean;
  /** Multiplier on the requested px. Scripts have a small x-height for their em, so Great Vibes at
   *  72px reads far smaller than Playfair at 72px; without this every script headline looks timid. */
  scale: number;
  /** Line height as a multiple of the drawn size. Scripts have long ascenders and descenders and
   *  collide with themselves at the 1.18 that suits a sans. */
  lineHeight: number;
};

export type TypeSet = {
  key: TypeSetKey;
  label: string;
  note: string;            // shown under the label in the designer, so the choice is legible
  display: Face;
  /** null = this set has no script face; a script headline falls back to the display face rather
   *  than to a browser default, which would be an Arial headline in a formal design. */
  script: Face | null;
  body: Face;
};

const SYS = '"Helvetica Neue", Arial, sans-serif';
const PLAYFAIR = '"Playfair Display", Georgia, "Times New Roman", serif';
const CORMORANT = '"Cormorant Garamond", Garamond, Georgia, serif';
const GREAT_VIBES = '"Great Vibes", "Snell Roundhand", cursive';
const SACRAMENTO = '"Sacramento", "Snell Roundhand", cursive';
const JOST = '"Jost", "Helvetica Neue", Arial, sans-serif';

export const TYPE_SETS: TypeSet[] = [
  {
    key: 'plain', label: 'Plain', note: 'System sans — what every poster used to be',
    display: { family: SYS, weight: 800, tracking: 0, upper: false, scale: 1, lineHeight: 1.18 },
    script: null,
    body: { family: SYS, weight: 400, tracking: 0, upper: false, scale: 1, lineHeight: 1.18 },
  },
  {
    key: 'editorial', label: 'Editorial', note: 'High-contrast serif caps over a light script',
    display: { family: PLAYFAIR, weight: 700, tracking: 0.02, upper: true, scale: 1, lineHeight: 1.12 },
    script: { family: SACRAMENTO, weight: 400, tracking: 0, upper: false, scale: 1.5, lineHeight: 1.0 },
    body: { family: JOST, weight: 400, tracking: 0.14, upper: true, scale: 0.92, lineHeight: 1.45 },
  },
  {
    key: 'formal', label: 'Formal', note: 'Wide Garamond caps with a copperplate script',
    display: { family: CORMORANT, weight: 600, tracking: 0.22, upper: true, scale: 1.04, lineHeight: 1.2 },
    script: { family: GREAT_VIBES, weight: 400, tracking: 0, upper: false, scale: 1.45, lineHeight: 1.05 },
    body: { family: JOST, weight: 400, tracking: 0.12, upper: true, scale: 0.9, lineHeight: 1.45 },
  },
  {
    key: 'garden', label: 'Garden', note: 'Airy tracked caps, Garamond body — suits greenery',
    display: { family: JOST, weight: 400, tracking: 0.18, upper: true, scale: 0.96, lineHeight: 1.22 },
    script: { family: SACRAMENTO, weight: 400, tracking: 0, upper: false, scale: 1.5, lineHeight: 1.0 },
    body: { family: CORMORANT, weight: 500, tracking: 0.03, upper: false, scale: 1.06, lineHeight: 1.3 },
  },
  {
    key: 'modern', label: 'Modern', note: 'Geometric sans throughout, script for the one word',
    display: { family: JOST, weight: 500, tracking: 0.06, upper: true, scale: 1, lineHeight: 1.16 },
    script: { family: SACRAMENTO, weight: 400, tracking: 0, upper: false, scale: 1.5, lineHeight: 1.0 },
    body: { family: JOST, weight: 400, tracking: 0.08, upper: false, scale: 1, lineHeight: 1.3 },
  },
];

export const DEFAULT_TYPE_SET: TypeSetKey = 'plain';

export const typeSet = (key: TypeSetKey | undefined | null): TypeSet =>
  TYPE_SETS.find((t) => t.key === key) ?? TYPE_SETS[0];

/** Which face the headline is set in. A design either leads with the structure or with the feeling;
 *  the references do both and they look nothing alike. */
export type TitleFace = 'display' | 'script';

export const titleFaceOf = (set: TypeSet, which: TitleFace | undefined): Face =>
  which === 'script' ? (set.script ?? set.display) : set.display;

// ── Loading ──────────────────────────────────────────────────────────────────
// One in-flight promise per set, kept for the life of the tab. This is module state in a file the
// renderer is otherwise pure in, and it is deliberate: the alternative is every thumbnail in a
// preset gallery re-requesting five faces on every redraw.
const pending = new Map<string, Promise<void>>();

/** A font shorthand FontFaceSet.load() will accept — it wants a size and a single family. */
const probe = (f: Face) => `${f.weight} 64px ${f.family.split(',')[0].trim()}`;

/** Resolve once every face this set needs is actually available to canvas.
 *
 *  Never rejects. A face that fails to load is a poster in the fallback stack, which is worse than
 *  the design intends but is still a usable poster — refusing to draw at all would be worse. */
export function ensurePosterFonts(key: TypeSetKey | undefined | null): Promise<void> {
  const set = typeSet(key);
  if (set.key === 'plain') return Promise.resolve();
  if (typeof document === 'undefined' || !('fonts' in document)) return Promise.resolve();
  const hit = pending.get(set.key);
  if (hit) return hit;
  const faces = [set.display, set.body, ...(set.script ? [set.script] : [])];
  const p = Promise.all(faces.map((f) => document.fonts.load(probe(f)).catch(() => []))).then(() => undefined);
  pending.set(set.key, p);
  return p;
}

/** Every bundled face, warmed at once — for the designer, which lets the host flip between sets and
 *  must not show a frame of Arial each time they do. */
export const warmAllPosterFonts = (): Promise<void> =>
  Promise.all(TYPE_SETS.map((t) => ensurePosterFonts(t.key))).then(() => undefined);

// ── Drawing helpers ──────────────────────────────────────────────────────────
// letterSpacing landed in Chrome 99 / Safari 17.4 / Firefox 127. On anything older the assignment is
// simply ignored and the text sets solid, which is a slightly tighter poster rather than a broken
// one — so it is applied unconditionally and never feature-gated into a second code path.
type Spaced = CanvasRenderingContext2D & { letterSpacing?: string };

/** Apply a face to the context at `sizePx`, returning the size it actually drew at (after the
 *  face's own scale) so the caller can work out line height and block extents. */
export function applyFace(ctx: CanvasRenderingContext2D, face: Face, sizePx: number): number {
  const px = Math.max(1, Math.round(sizePx * face.scale));
  ctx.font = `${face.weight} ${px}px ${face.family}`;
  (ctx as Spaced).letterSpacing = face.tracking ? `${face.tracking}em` : '0px';
  return px;
}

/** Put the context back to no tracking. Canvas state is sticky, so a tracked headline would
 *  otherwise silently space out the join code drawn after it. */
export const clearTracking = (ctx: CanvasRenderingContext2D) => { (ctx as Spaced).letterSpacing = '0px'; };

export const castFor = (face: Face, text: string): string => (face.upper ? text.toLocaleUpperCase() : text);
