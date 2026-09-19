/** Where a press lands on a carousel whose track carries a clone of each end.
 *
 *  The track is [clone of last, ...n real slides, clone of first], so real slides are 1..n and the
 *  clones sit at 0 and n+1. Stepping onto a clone is the point: it lets "next" from the last slide
 *  move one step RIGHT onto a picture identical to the first, and a transitionend handler then
 *  snaps — with animation off — to the real slide 1.
 *
 *  THE BUG THIS EXISTS TO PREVENT: the seam handler only corrects at exactly 0 or n+1, and it only
 *  runs when a transition ENDS. A press that lands before the previous transition has finished used
 *  to add to the position unconditionally, so the track walked past the clone to n+2 — a position
 *  with no slide in it. The seam handler could then never match again, so it stayed there: a black
 *  frame with no image, for the rest of the page's life. Spam-pressing the arrow is all it took.
 *
 *  So a step that would leave the track wraps ARITHMETICALLY instead, exactly as the
 *  reduced-motion path does, and reports `animate: false` because there is no honest frame to
 *  animate between — the caller re-enables animation after a paint.
 */
export function carouselStep(
  pos: number, d: number, n: number,
): { pos: number; animate: boolean } {
  const last = n + 1;                      // index of the trailing clone
  const next = pos + d;
  if (next >= 0 && next <= last) return { pos: next, animate: true };
  // Off the end of the track: land on the real slide the clone was standing in for.
  return { pos: wrapReal(pos, d, n), animate: false };
}

/** The real slide `d` steps from `pos`, 1-based, wrapping. Used by the guard above and by the
 *  reduced-motion path, which never animates and so never gets a transitionend either. */
export function wrapReal(pos: number, d: number, n: number): number {
  return 1 + (((pos - 1 + d) % n) + n) % n;
}
