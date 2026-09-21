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

/** Only these get preloaded. A clip's `url` is an .mp4 and handing that to an Image() would start
 *  a download of the whole file to fail to decode it — hundreds of megabytes, for nothing. */
const STILL = /\.(jpe?g|png|webp|gif|avif)(\?|$)/i;

/** How long to hold the preview waiting for bytes that may never come.
 *
 *  This is a cosmetic wait in front of a write that has already succeeded, so it must never be
 *  able to strand the control. 4s is longer than a thumbnail on a bad connection and short enough
 *  that the fallback — the old flash, once — is over before anybody reaches for the button again.
 */
export const ROTATE_PRELOAD_TIMEOUT_MS = 4_000;

/** Wait until the browser actually HAS the turned files, then let the caller drop the preview.
 *
 *  The flash this removes: a turn is previewed with a CSS transform over the OLD file. On save the
 *  reply arrives with new names — rotation renames, it cannot rewrite, because /uploads is
 *  immutable for a year — and both call sites did the same two things in the same tick: point the
 *  <img> at the new name, and clear the transform. But pointing an <img> at a new src does not
 *  change what is on screen; the old bitmap stays painted until the new one has been fetched and
 *  decoded. So for those few hundred milliseconds the OLD picture was on screen with the preview
 *  taken off it — the photo visibly snapping back to the orientation the host had just corrected,
 *  before snapping forward again.
 *
 *  Both sites had a comment claiming they dropped the preview only once the corrected source was
 *  "in hand". It was: the URL was in hand. The bytes were not, and the bytes are what is painted.
 *
 *  Never rejects, and never waits forever: a preload that 404s or hangs resolves like any other,
 *  because the write itself has already succeeded and a cosmetic wait must not be able to hold the
 *  UI hostage. Worst case is the flash we started with. */
export function preloadStills(urls: (string | null | undefined)[],
                              timeoutMs: number = ROTATE_PRELOAD_TIMEOUT_MS): Promise<void> {
  const wanted = [...new Set(urls.filter((u): u is string => !!u && STILL.test(u)))];
  if (!wanted.length || typeof Image === 'undefined') return Promise.resolve();
  const each = wanted.map((u) => new Promise<void>((resolve) => {
    const img = new Image();
    // decode() as well as load, where it exists: onload means the bytes are here, decode() means
    // the bitmap is ready to paint. Without it the swap can still cost a frame on a big photo,
    // which is a smaller version of the same flicker.
    img.onload = () => { const d = img.decode?.(); d ? void d.then(resolve, () => resolve()) : resolve(); };
    img.onerror = () => resolve();
    img.src = u;
  }));
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    Promise.all(each).then(() => undefined),
    new Promise<void>((resolve) => { t = setTimeout(resolve, timeoutMs); }),
  ]).finally(() => clearTimeout(t));
}
