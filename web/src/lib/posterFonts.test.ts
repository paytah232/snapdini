// The failure this module exists to prevent is silent: canvas accepts a font family that has not
// loaded and prints in Arial without telling anyone, and the artefact is a PNG the host takes to a
// printer. So the tests lock the two things that make that impossible — every set names faces that
// really exist in static/fonts, and nothing ever resolves to an empty family.
import { describe, it, expect } from 'vitest';
import {
  TYPE_SETS, DEFAULT_TYPE_SET, typeSet, titleFaceOf, castFor, applyFace, ensurePosterFonts,
} from './posterFonts';

// The five files actually bundled. If a set names a sixth, the poster prints in the fallback stack.
const BUNDLED = ['Playfair Display', 'Cormorant Garamond', 'Great Vibes', 'Sacramento', 'Jost'];

describe('the typeface pairings', () => {
  it('only ever names a face we actually ship', () => {
    for (const set of TYPE_SETS) {
      for (const face of [set.display, set.body, set.script]) {
        if (!face) continue;
        const first = face.family.split(',')[0].trim().replace(/^"|"$/g, '');
        // Either a bundled webfont, or a system stack that needs no file at all.
        expect(BUNDLED.includes(first) || /Helvetica|Arial|Georgia|serif|sans-serif/.test(first)).toBe(true);
      }
    }
  });

  it('always gives a family with a fallback behind it', () => {
    for (const set of TYPE_SETS) {
      for (const face of [set.display, set.body, set.script]) {
        if (!face) continue;
        expect(face.family).toContain(',');
        expect(face.scale).toBeGreaterThan(0);
        expect(face.lineHeight).toBeGreaterThan(0);
      }
    }
  });

  it('defaults to the plain set, so an old design opens looking like itself', () => {
    expect(DEFAULT_TYPE_SET).toBe('plain');
    expect(typeSet(undefined).key).toBe('plain');
    expect(typeSet(null).key).toBe('plain');
    // An unknown key from a stored blob must land somewhere real, not on undefined.
    expect(typeSet('nonsense' as never).key).toBe('plain');
  });

  it('gives scripts a boost, because they set small for their em', () => {
    // Great Vibes at 72px reads far smaller than Playfair at 72px; without this every script
    // headline comes out timid next to the caps line above it.
    for (const set of TYPE_SETS) {
      if (set.script) expect(set.script.scale).toBeGreaterThan(1.2);
    }
  });
});

describe('picking the headline face', () => {
  it('uses the script face when asked and the set has one', () => {
    const garden = typeSet('garden');
    expect(titleFaceOf(garden, 'script')).toBe(garden.script);
    expect(titleFaceOf(garden, 'display')).toBe(garden.display);
  });

  it('falls back to the display face rather than to nothing', () => {
    // Plain has no script. Asking for one must not produce an undefined family, which reaches
    // ctx.font as "400 72px undefined" and silently draws in the browser default.
    const plain = typeSet('plain');
    expect(plain.script).toBeNull();
    expect(titleFaceOf(plain, 'script')).toBe(plain.display);
    expect(titleFaceOf(plain, undefined)).toBe(plain.display);
  });
});

describe('applying a face to a context', () => {
  const ctx = () => {
    const calls: Record<string, string> = {};
    return new Proxy({} as CanvasRenderingContext2D, {
      set(_t, k: string, v) { calls[k] = String(v); return true; },
      get(_t, k: string) { return k === '__calls' ? calls : undefined; },
    }) as CanvasRenderingContext2D & { __calls: Record<string, string> };
  };

  it('reports the size it really drew at, not the size it was asked for', () => {
    const c = ctx();
    const set = typeSet('formal');
    const px = applyFace(c, set.script!, 72);
    expect(px).toBe(Math.round(72 * set.script!.scale));
    expect(c.__calls.font).toContain(`${px}px`);
  });

  it('writes tracking as em, and clears it rather than leaving it set', () => {
    const c = ctx();
    applyFace(c, typeSet('formal').display, 60);
    expect(c.__calls.letterSpacing).toBe('0.22em');
    // A face with no tracking must actively zero it — canvas state is sticky, so otherwise a
    // tracked headline would space out the join code drawn after it.
    applyFace(c, typeSet('plain').display, 60);
    expect(c.__calls.letterSpacing).toBe('0px');
  });
});

describe('casing', () => {
  it('uppercases only where the face asks for it', () => {
    expect(castFor(typeSet('editorial').display, 'capture the')).toBe('CAPTURE THE');
    expect(castFor(typeSet('plain').display, 'capture the')).toBe('capture the');
  });
});

describe('loading', () => {
  it('resolves for the plain set without needing a font API at all', async () => {
    // Runs in jsdom, where document.fonts may not exist. Plain needs no file, so it must short
    // circuit — and every other set must resolve rather than reject, because a poster in the
    // fallback stack beats a designer that refuses to draw.
    await expect(ensurePosterFonts('plain')).resolves.toBeUndefined();
    await expect(ensurePosterFonts('editorial')).resolves.toBeUndefined();
  });
});
