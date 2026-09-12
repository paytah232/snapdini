// How long a caption is, measured the way the person writing it would measure it.
//
// The limit used to be 140 UTF-16 code units, enforced by the textarea's `maxlength`. That is not
// what anyone means by "140 characters": a plain emoji costs 2, one with a skin tone costs 4, and a
// family (👨‍👩‍👧) costs 8 — one visible character eating eight of someone's budget. Worse, `maxlength`
// refuses an insert that will not fit ENTIRELY, so near the limit a simple 😀 still went in while a
// family emoji was silently dropped. That is what "it only supports some emoji" actually was: not
// validation rejecting them, just arithmetic that disagreed with the screen.
//
// So count grapheme clusters — what the user sees as one character. Intl.Segmenter is in every
// current browser and in Node 18+; the fallbacks below only matter for something very old, and
// degrade toward counting too generously rather than refusing valid text.

export const CAPTION_MAX = 140;

const segmenter: Intl.Segmenter | null = (() => {
  try {
    return typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      : null;
  } catch {
    return null;
  }
})();

/** The visible characters in a string: 👨‍👩‍👧 is one, not eight. */
export function graphemes(text: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(text), (s) => s.segment);
  return [...text];   // code points: still far closer than .length, and never splits a surrogate
}

/** How long this reads as, to a person. */
export const captionLength = (text: string): number => graphemes(text).length;

/** How many more they can type. Never negative — a negative count is a bug telling on itself. */
export const captionRemaining = (text: string): number => Math.max(0, CAPTION_MAX - captionLength(text));

/** Cut a caption to the limit without ever splitting a character apart. */
export function clampCaption(text: string): string {
  const g = graphemes(text);
  return g.length <= CAPTION_MAX ? text : g.slice(0, CAPTION_MAX).join('');
}

// A raw ceiling, separate from the one people see, and applied BEFORE segmenting so a contrived
// payload cannot make us walk megabytes of text.
//
// It has to be generous enough that 140 graphemes always fits underneath it, or the guard would cut
// a caption before the grapheme clamp ever ran — exactly the silent truncation this file exists to
// end. The worst realistic grapheme is a long ZWJ sequence: 👨‍👩‍👧‍👦 is 11 UTF-16 units, a flag is 4,
// a skin-toned gesture 4. At 16000 a caption of 140 of the very worst (11 × 140 = 1540) sits an
// order of magnitude clear. Nothing a person types will ever meet this; it exists so the column
// cannot be used as a store by something that is not a person.
export const CAPTION_MAX_RAW = 16000;
