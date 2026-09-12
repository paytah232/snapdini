// "140 characters" has to mean what the person writing it thinks it means. Counting UTF-16 code
// units instead made one emoji cost between 2 and 11 of someone's budget, and — because maxlength
// refuses an insert that will not fit entirely — silently dropped the longer ones near the limit
// while short ones still went in. That is what "it only supports some emoji" turned out to be.
import { describe, it, expect } from 'vitest';
import { CAPTION_MAX, CAPTION_MAX_RAW, captionLength, captionRemaining, clampCaption } from '../../../shared/caption';

const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';  // 11 UTF-16 units
const FLAG = '\u{1F1E6}\u{1F1FA}';                                        // 4
const THUMB_TONE = '\u{1F44D}\u{1F3FD}';                                  // 4
const HEART_VS = '❤️';                                          // 2

describe('a caption is measured the way a person reads it', () => {
  it('counts one visible character as one, however many code units it takes', () => {
    expect(captionLength(FAMILY)).toBe(1);
    expect(FAMILY.length).toBe(11);           // …which is what we used to charge them
    expect(captionLength(FLAG)).toBe(1);
    expect(captionLength(THUMB_TONE)).toBe(1);
    expect(captionLength(HEART_VS)).toBe(1);
  });

  it('counts plain text the obvious way', () => {
    expect(captionLength('hello')).toBe(5);
    expect(captionLength('')).toBe(0);
  });

  it('lets someone write a full caption of the most expensive emoji there is', () => {
    // The exact case that used to be impossible: at 11 units each, 140 of these is 1540 units, so
    // a 140-unit limit allowed twelve of them.
    const all = FAMILY.repeat(CAPTION_MAX);
    expect(captionLength(all)).toBe(CAPTION_MAX);
    expect(clampCaption(all)).toBe(all);
    expect(captionRemaining(all)).toBe(0);
  });

  it('clamps by visible character, keeping exactly the limit', () => {
    const over = FAMILY.repeat(CAPTION_MAX + 60);
    const cut = clampCaption(over);
    expect(captionLength(cut)).toBe(CAPTION_MAX);
  });

  it('never cuts a character in half', () => {
    // A UTF-16 slice lands inside an emoji and leaves a lone surrogate, which renders as a tofu box.
    const cut = clampCaption(FAMILY.repeat(CAPTION_MAX + 5));
    expect(cut).not.toMatch(/�/);
    expect(cut.endsWith(FAMILY)).toBe(true);
    // No orphaned surrogate at either end.
    expect(cut.charCodeAt(cut.length - 1) >= 0xd800 && cut.charCodeAt(cut.length - 1) <= 0xdbff).toBe(false);
  });

  it('never reports a negative remaining count', () => {
    expect(captionRemaining(FAMILY.repeat(500))).toBe(0);
    expect(captionRemaining('x'.repeat(1000))).toBe(0);
  });

  it('leaves anything already within the limit completely untouched', () => {
    const s = `What a night ${FLAG}${HEART_VS} — everyone was there`;
    expect(clampCaption(s)).toBe(s);
  });

  it('has a raw ceiling with room for the worst case underneath it', () => {
    // If the byte guard could bite before the grapheme clamp, it would truncate a legitimate
    // caption — the silent cut this whole module exists to prevent.
    expect(FAMILY.repeat(CAPTION_MAX).length).toBeLessThan(CAPTION_MAX_RAW);
  });
});
