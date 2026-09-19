import { describe, it, expect } from 'vitest';
// Vite's ?raw, not node:fs — this project's web tsconfig carries no node types, and the source is
// something Vite can hand us directly.
import adminSrc from '../routes/admin/[code]/+page.svelte?raw';
import downloadFormatSrc from './components/DownloadFormat.svelte?raw';

// An emoji used as an ICON has to be emoji-presentation, or desktop draws it in ink.
//
// Roughly a hundred emoji default to TEXT presentation (Emoji_Presentation=No) and only become
// colour glyphs when followed by U+FE0F. Phones colour them regardless; desktop browsers render a
// monochrome glyph, or tofu where the font carries no outline. In a row of eight tile icons that
// reads as one broken tile — which is how it was found: 🎛 on the Controls tile, in a row where
// ⚙️ had carried the selector all along.
//
// SCOPED TO ICON SLOTS ON PURPOSE. The codebase is full of bare ♥ ⚠ ↩ ↗ ▶ ©, and every one of them
// is deliberately typographic: they inherit `color`, sit inline with text, and forcing emoji
// presentation on them would turn a warning caret into a yellow road sign. This checks the places
// where the glyph IS the icon. Add a slot below when you add one.
const SLOTS: { src: string; pattern: RegExp; what: string }[] = [
  // Where the section icons actually live: one entry per section, read by BOTH the hub tile and the
  // bar you land on. This pattern moved with them — a slot that no longer holds any emoji is a test
  // that passes for the wrong reason.
  { src: adminSrc, pattern: /icon: '([^']*)'/g, what: 'admin SECTION_META icon' },
  // Still checked: the Poster tile keeps its icon inline, because Poster is not a section.
  { src: adminSrc, pattern: /class="hub-i"[^>]*>([^<{]*)</g, what: 'admin section tile (inline)' },
  { src: downloadFormatSrc, pattern: /class="chooser-opt-t">([^<]*)</g, what: 'download format option' },
];

/** Emoji whose default presentation is TEXT. Not the whole set — the ones a UI actually reaches
 *  for, plus everything already used in this repo. */
const TEXT_DEFAULT = new Set<number>([
  0x00a9, 0x00ae, 0x2122, 0x2139, 0x2194, 0x21a9, 0x21aa, 0x23cf, 0x23ed, 0x23ee, 0x23ef, 0x23f1,
  0x23f2, 0x23f8, 0x23f9, 0x23fa, 0x25b6, 0x25c0, 0x2600, 0x2601, 0x2602, 0x2603, 0x2604, 0x260e,
  0x2611, 0x2618, 0x261d, 0x2620, 0x2622, 0x2623, 0x2626, 0x262a, 0x262e, 0x262f, 0x2638, 0x2639,
  0x263a, 0x2640, 0x2642, 0x265f, 0x2660, 0x2663, 0x2665, 0x2666, 0x2668, 0x267b, 0x267e, 0x2692,
  0x2693, 0x2694, 0x2695, 0x2696, 0x2697, 0x2699, 0x269b, 0x269c, 0x26a0, 0x26a1, 0x26a7, 0x26b0,
  0x26b1, 0x26c8, 0x26cf, 0x26d1, 0x26d3, 0x26d4, 0x26e9, 0x26ea, 0x26f0, 0x26f1, 0x26f2, 0x26f3,
  0x26f4, 0x26f5, 0x26f7, 0x26f8, 0x26f9, 0x26fd, 0x2702, 0x2708, 0x2709, 0x270c, 0x270d, 0x270f,
  0x2712, 0x2714, 0x2716, 0x271d, 0x2721, 0x2733, 0x2734, 0x2744, 0x2747, 0x2763, 0x2764, 0x27a1,
  0x2934, 0x2935, 0x2b05, 0x2b06, 0x2b07, 0x2b55, 0x3030, 0x303d, 0x3297, 0x3299,
  0x1f321, 0x1f324, 0x1f325, 0x1f326, 0x1f327, 0x1f328, 0x1f329, 0x1f32a, 0x1f32b, 0x1f32c,
  0x1f336, 0x1f37d, 0x1f396, 0x1f397, 0x1f399, 0x1f39a, 0x1f39b, 0x1f39e, 0x1f39f, 0x1f3cb,
  0x1f3cc, 0x1f3cd, 0x1f3ce, 0x1f3d4, 0x1f3d5, 0x1f3d6, 0x1f3d7, 0x1f3d8, 0x1f3d9, 0x1f3da,
  0x1f3db, 0x1f3dc, 0x1f3dd, 0x1f3de, 0x1f3df, 0x1f3f3, 0x1f3f5, 0x1f3f7, 0x1f43f, 0x1f441,
  0x1f4fd, 0x1f549, 0x1f54a, 0x1f56f, 0x1f570, 0x1f573, 0x1f574, 0x1f575, 0x1f576, 0x1f577,
  0x1f578, 0x1f579, 0x1f587, 0x1f58a, 0x1f58b, 0x1f58c, 0x1f58d, 0x1f590, 0x1f5a5, 0x1f5a8,
  0x1f5b1, 0x1f5b2, 0x1f5bc, 0x1f5c2, 0x1f5c3, 0x1f5c4, 0x1f5d1, 0x1f5d2, 0x1f5d3, 0x1f5dc,
  0x1f5dd, 0x1f5de, 0x1f5e1, 0x1f5e3, 0x1f5e8, 0x1f5ef, 0x1f5f3, 0x1f5fa, 0x1f6cb, 0x1f6cd,
  0x1f6ce, 0x1f6cf, 0x1f6e0, 0x1f6e1, 0x1f6e2, 0x1f6e3, 0x1f6e4, 0x1f6e5, 0x1f6e9, 0x1f6f0, 0x1f6f3,
]);

describe('emoji used as an icon are emoji-presentation', () => {
  for (const slot of SLOTS) {
    it(`${slot.what}: every icon renders in colour on desktop`, () => {
      const src = slot.src;
      const found: string[] = [];
      let m: RegExpExecArray | null;
      const re = new RegExp(slot.pattern.source, 'g');
      while ((m = re.exec(src))) {
        const chars = [...m[1]];
        chars.forEach((ch, i) => {
          const cp = ch.codePointAt(0) as number;
          if (TEXT_DEFAULT.has(cp) && chars[i + 1] !== '️') {
            found.push(`${ch} (U+${cp.toString(16).toUpperCase()}) in ${JSON.stringify(m![1].trim())}`);
          }
        });
      }
      expect(found, `add U+FE0F after: ${found.join(', ')}`).toEqual([]);
    });
  }

  // The negative control: without it, a regex that matched nothing would pass forever — which is
  // exactly what nearly happened when the icons moved out of the markup and into SECTION_META.
  it('is actually looking at the icons', () => {
    const metaIcons = [...adminSrc.matchAll(/icon: '([^']*)'/g)].map((m) => m[1]);
    expect(metaIcons.length, 'one icon per admin section').toBeGreaterThanOrEqual(7);
    expect(metaIcons.join(''), 'the Controls knob needs its variation selector').toContain('\u{1F39B}\uFE0F');
    // …and the tile and the bar read the SAME entry, so they cannot drift apart.
    expect(adminSrc).toContain('{SECTION_META[section].icon}');
    expect(adminSrc).toContain('{SECTION_META.controls.icon}');
  });
});
