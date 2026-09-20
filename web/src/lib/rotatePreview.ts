/* Previewing a turn before it is committed — the arithmetic, in one place.
 *
 * Both surfaces that offer rotation (the host's Review screen and the guest's Lightbox) turn the
 * picture with a CSS transform first and write the file once, at Save. A transform NEVER changes a
 * layout box, which is what makes the preview cheap — and is also the one thing that goes wrong
 * with it: a landscape photo turned on its side is now as tall as it used to be wide, so it hangs
 * out of a box that was sized for the other orientation. In the review page's single view that box
 * sits directly above the action row, and because a transform also creates a stacking context the
 * overflow painted straight over the buttons rather than behind them.
 *
 * Shrinking the turned picture by the short side over the long one puts it back inside the box it
 * started in, and that box already fits. It gives up a little room — a 3:2 shot previews at two
 * thirds — in exchange for needing no measurement of the container, no resize listener and no
 * second layout pass. For something on screen for a few seconds on the way to Save that is the
 * right trade; the committed photo is laid out by the browser like any other.
 *
 * This lived inside Lightbox.svelte until the review screen grew the same control and the same
 * bug. One implementation, so the two previews cannot drift apart.
 */

/** How far to shrink a quarter-turned picture so it still fits the room it had.
 *
 *  Measured off the ELEMENT's own box rather than photo.width/height: those fields are optional,
 *  and a clip carrying a display matrix reports the dimensions it was STORED at, not the ones it
 *  draws. 1 whenever there is nothing to measure yet — an image that has not loaded has no box,
 *  and a guess is worse than leaving the picture alone until `load` fires and asks again.
 *
 *  Safe to call at any moment, including while a turn is already applied: a transform does not
 *  change offsetWidth/offsetHeight, so this answers the same thing however many times the picture
 *  has been turned. */
export function fitScaleFor(w: number, h: number): number {
  return w > 0 && h > 0 ? Math.min(w / h, h / w) : 1;
}

/** The whole transform for a pending turn.
 *
 *  `none` at rest, so the value can be bound straight to `style:transform` without the call site
 *  deciding between a string and null. The fit is applied on a QUARTER turn only: a half turn
 *  leaves the box the same shape, so scaling it would shrink the picture for no reason. */
export function previewTransform(turn: number, fitScale = 1): string {
  if (!turn) return 'none';
  const quarter = turn === 90 || turn === -90;
  return `rotate(${turn}deg)${quarter ? ` scale(${fitScale})` : ''}`;
}
