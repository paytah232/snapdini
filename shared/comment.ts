// How long a GUEST COMMENT is, measured the way the person writing it would measure it.
//
// Counting is caption.ts's problem, already solved and not solved twice: `graphemes()` is imported
// rather than reimplemented, because a family emoji costing 8 of somebody's budget is exactly the
// bug that file exists to record. What is different here is only the number.
//
// WHY 300 AND NOT 140. A caption is one line UNDER a photo, written by the person whose photo it
// is, and 140 is a line. A comment is a message TO somebody — "this is the best photo of the whole
// night, you two were glowing" plus a name — so it needs room for two or three sentences. It stops
// at 300 because past that a thread on a phone stops being a thread: one guest's paragraph pushes
// every other guest's message off a host's screen, and the whole reason comments default OFF is
// that they put other people's words on somebody else's gallery. 300 is long enough to say a real
// thing and short enough that no single comment can own the photo.
//
// A cap, never a rejection — same as a caption. Bouncing someone's message back because it ran four
// characters long is a worse product than keeping the first 300.
import { graphemes } from './caption';

export const COMMENT_MAX = 300;

/** How long this reads as, to a person. */
export const commentLength = (text: string): number => graphemes(text).length;

/** How many more they can type. Never negative — a negative count is a bug telling on itself. */
export const commentRemaining = (text: string): number => Math.max(0, COMMENT_MAX - commentLength(text));

/** Cut a comment to the limit without ever splitting a character apart. */
export function clampComment(text: string): string {
  const g = graphemes(text);
  return g.length <= COMMENT_MAX ? text : g.slice(0, COMMENT_MAX).join('');
}

// A raw ceiling, separate from the one people see, applied BEFORE segmenting so a contrived payload
// cannot make us walk megabytes of text. Sized the same way CAPTION_MAX_RAW is: the worst realistic
// grapheme is an 11-unit ZWJ family, so 300 of them is 3,300 UTF-16 units and 32,000 sits an order
// of magnitude clear. Nothing a person types will ever meet this; it exists so the column cannot be
// used as a store by something that is not a person.
export const COMMENT_MAX_RAW = 32000;
