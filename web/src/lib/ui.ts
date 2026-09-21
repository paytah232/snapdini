import { reportStaleMedia } from './staleMedia';

// On a grid <img> whose thumbnail is missing (e.g. pre-backfill photos), fall back to
// the full-resolution original — once, to avoid an error loop if that's missing too.
//
// The fallback alone was never enough, and for the commonest cause it is actively wrong. A
// rotation RENAMES the stored file (it has to — /uploads is immutable for a year), so both the
// thumbnail and the original move together: falling back from one rotated-away stem to the other
// is a second 404 on the same missing photo. The fallback still earns its place for the case it
// was written for — a pre-backfill photo that genuinely has no thumbnail — so it stays, and the
// report is what covers the rename. See lib/staleMedia.ts.
export function imgFallback(e: Event, fullUrl: string): void {
  const t = e.currentTarget as HTMLImageElement;
  if (!t.dataset.fb) {
    // FIRST failure: try the original, and say nothing yet. A missing thumbnail on its own is the
    // ordinary pre-backfill case — the photo is fine, only its derivative was never generated —
    // and reporting it would spend the page's whole heal budget on an event where nothing has been
    // renamed and no refetch can help.
    t.dataset.fb = '1';
    t.src = fullUrl;
    return;
  }
  // SECOND failure: the thumbnail AND the original are both gone, which a missing derivative
  // cannot explain. A rename moves both together, so this is the signal worth acting on.
  reportStaleMedia(t.currentSrc || t.src);
}

// On a video-poster <img> whose poster is missing (e.g. pre-backfill clips, or ffmpeg failed),
// hide the broken image so the cell just shows its dark background + ▶ overlay.
//
// Hiding it is right either way, but it is not the end of the story when the clip has been
// rotated: the poster is re-cut under the new stem and the CLIP itself has moved too, so a cell
// that quietly loses its poster is also a cell whose play button now leads to a 404.
export function hidePoster(e: Event): void {
  const t = e.currentTarget as HTMLImageElement;
  reportStaleMedia(t.currentSrc || t.src);
  t.style.display = 'none';
}

// Svelte action for modals/dialogs: move focus into the element on open and restore it
// to the previously-focused element on close. Pair with Escape-to-close on the modal.
export function modalFocus(node: HTMLElement) {
  const prev = document.activeElement as HTMLElement | null;
  node.focus();
  return { destroy() { prev?.focus?.(); } };
}

/** The ONE shape every tile in a photo grid takes, as a CSS aspect-ratio number, taken from the
 *  event's frame setting rather than from each file. Per-photo shapes were faithful to the data
 *  and wrong to the product: only photos go through cropRect, so a clip recorded straight off the
 *  sensor sat full-frame beside square photos and the grid read as untidy.
 *  'full' has no fixed shape at all, so it falls back to square — the same fallback the camera
 *  itself uses for its own roll. */
/** The one shape every tile in a grid is drawn at.
 *
 *  "The event's shape" is a real thing only when the host enabled exactly ONE. With several, the
 *  roll genuinely contains a mixture — each photo is cropped at capture to whatever was selected
 *  then — and taking ratios[0] was an arbitrary pick dressed up as an answer (for the demo, which
 *  enables everything, that first entry is 'full', which is not even a ratio).
 *
 *  So: one shape enabled, use it — the tiles then match the photos exactly and nothing is cropped.
 *  Several, and we commit to a square and crop to fill, which is what every photo grid does. A grid
 *  is an index, not a viewer: the lightbox shows the whole photo, uncropped, so nothing is lost.
 *  Padding to fit was the alternative and it is worse here — letterbox bars at 150px give each card
 *  a different visual weight, which is the raggedness we just removed wearing a different hat. */
export function tileAspect(ratios: string[] | null | undefined): number {
  // 'full' means "don't crop", so it describes no particular shape and cannot be a tile.
  const shapes = (ratios ?? []).filter((r) => r && r !== 'full');
  if (shapes.length !== 1) return 1;
  const [w, h] = shapes[0].split(':').map(Number);
  return w > 0 && h > 0 ? w / h : 1;
}
