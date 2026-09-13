// Getting a photo off the web page and into someone's actual photo library.
//
// On Android and desktop an `<a download>` does the obvious thing. On iOS it does not: Safari has
// no API that writes to the camera roll, so a download lands in Files, and the guest is left with
// their photos somewhere they will never look for them. That is what a tester reported.
//
// The Web Share API is the way in. `navigator.share({ files })` opens the iOS share sheet, which
// has "Save Image" on it — one extra tap, and the photo lands in Photos properly. It is also the
// natural thing on Android, where the sheet offers Photos, Drive, messaging and so on.
//
// TWO RULES, both learned the hard way elsewhere:
//   • It needs TRANSIENT ACTIVATION — a real tap, in the same task. So this must be called straight
//     from a click handler, never after an await that might outlive the gesture. That is why the
//     blob is fetched BEFORE share is reached where possible, and why the capture-time auto-save
//     does not use it: a share sheet after every shutter press would be intolerable anyway.
//   • A cancelled sheet throws AbortError. That is the guest saying no, so it must NOT fall through
//     to a download — they would get the very file they just declined.

export type SaveOutcome = 'shared' | 'downloaded' | 'cancelled' | 'failed';

/** Can this browser share an actual file (rather than just a link)? */
export function canShareFiles(): boolean {
  try {
    if (typeof navigator === 'undefined' || !navigator.share || !navigator.canShare) return false;
    // A representative probe: canShare is per-payload, and some browsers accept a URL share while
    // refusing files, which is the case that matters here.
    const probe = new File([new Blob(['x'], { type: 'image/jpeg' })], 'probe.jpg', { type: 'image/jpeg' });
    return navigator.canShare({ files: [probe] });
  } catch { return false; }
}

/** Last-resort download. Silent on Android/desktop; on iOS this is the Files behaviour we are
 *  trying to improve on, which is why it is the fallback and not the first choice. */
export function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** iOS, including an iPad pretending to be a Mac.
 *
 *  Sniffing the platform is not something to reach for lightly, but there is no feature test for
 *  the question that matters here — "does this share sheet offer a way to KEEP the file" — and the
 *  answer differs by OS, not by capability. */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports itself as "Macintosh"; a Mac with a touchscreen is an iPad.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
}

/** Offer a blob to the OS, by whichever route actually keeps it on THIS platform.
 *
 *  This had it backwards at first, and a tester caught it. The share sheet is not universally
 *  better — it is better on iOS and worse everywhere else:
 *
 *  • iOS — a download goes to Files, and there is no API that writes to the camera roll. The share
 *    sheet is the only route to Photos, via its "Save Image" action. Worth the extra tap.
 *  • Android — the share sheet lists apps to send the photo TO. There is no "keep this" on it, so
 *    a guest who wanted the photo got a list of ways to give it away. A plain download is silent,
 *    one tap, lands in Downloads, and the gallery picks it up.
 *  • Desktop — a download is obviously right.
 */
export async function saveBlob(blob: Blob, filename: string): Promise<SaveOutcome> {
  if (isIOS() && canShareFiles()) {
    try {
      const file = new File([blob], filename, { type: blob.type || 'image/jpeg' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return 'shared';
      }
    } catch (e) {
      // They closed the sheet. Respect it — do not hand them the file anyway.
      if ((e as DOMException)?.name === 'AbortError') return 'cancelled';
      // Anything else (no activation left, an unsupported payload) falls through to the download.
      // On iOS that means Files rather than Photos, which is worse but is still the photo.
    }
  }
  try { downloadBlob(blob, filename); return 'downloaded'; }
  catch { return 'failed'; }
}

/** Fetch a photo by URL and hand it to the OS. Same-origin, so no CORS to negotiate.
 *  Call from a click handler: the fetch is awaited, so browsers that consume activation eagerly
 *  may refuse the share afterwards and fall back to a download — which still works. */
export async function savePhotoByUrl(url: string, filename: string): Promise<SaveOutcome> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Could not fetch that photo');
  return saveBlob(await res.blob(), filename);
}

// ── Saving a whole roll ──────────────────────────────────────────────────────
//
// A zip is right on a desktop and close to useless on a phone: you need an extractor, and the
// photos never reach the camera roll, which is the only place anyone wants them. iOS will take
// several files in one share and offer "Save N Images", which puts the lot straight into Photos.
//
// The catch is memory. Every file has to be a Blob in RAM before it can be shared, and a 60-shot
// roll at 4–8MB each is half a gigabyte — a dead tab on a phone. So the roll is CHUNKED: fetch a
// batch, hand it over, drop the references, fetch the next. The batch is capped by BYTES rather
// than by count, because ten 300KB thumbnails and ten 8MB originals are not the same ask.

/** Roughly how much to hold in memory at once. Comfortably under what a phone tab will bear, while
 *  still being several photos per sheet so a roll does not become a dozen prompts. */
const CHUNK_BYTES = 48 * 1024 * 1024;
/** And a hard count, so a hundred tiny files do not all land in one share the OS then chokes on. */
const CHUNK_FILES = 10;

export interface SaveManyProgress { done: number; total: number; }

/** Save many photos the way this platform actually keeps them.
 *
 *  Returns how many were saved. A cancelled share stops the whole run — carrying on would keep
 *  showing sheets to someone who has just said no.
 *
 *  Non-iOS callers should prefer the server's zip: one file, one click, no memory ceiling. This is
 *  for the platform where a zip is a dead end. */
export async function saveMany(
  items: { url: string; filename: string }[],
  onProgress?: (p: SaveManyProgress) => void,
): Promise<{ saved: number; cancelled: boolean }> {
  let saved = 0;
  for (let i = 0; i < items.length; ) {
    const batch: File[] = [];
    let bytes = 0;
    // Fetch until the batch is full by either measure. The first file always goes in, however big,
    // or a single oversized video would stall the loop forever.
    while (i < items.length && batch.length < CHUNK_FILES && (bytes < CHUNK_BYTES || batch.length === 0)) {
      const it = items[i];
      try {
        const r = await fetch(it.url, { credentials: 'same-origin' });
        if (r.ok) {
          const b = await r.blob();
          batch.push(new File([b], it.filename, { type: b.type || 'image/jpeg' }));
          bytes += b.size;
        }
      } catch { /* skip the ones that fail; the rest of the roll should still arrive */ }
      i++;
    }
    if (!batch.length) continue;
    try {
      if (isIOS() && navigator.canShare?.({ files: batch })) {
        await navigator.share({ files: batch });
      } else {
        for (const f of batch) downloadBlob(f, f.name);
      }
      saved += batch.length;
      onProgress?.({ done: Math.min(i, items.length), total: items.length });
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return { saved, cancelled: true };
      // Anything else: fall back to downloads for this batch rather than losing it.
      for (const f of batch) downloadBlob(f, f.name);
      saved += batch.length;
    }
    // Let the tab breathe between batches so the memory from the last one is actually released.
    await new Promise((r) => setTimeout(r, 60));
  }
  return { saved, cancelled: false };
}
