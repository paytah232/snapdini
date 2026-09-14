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

/** One thing to save. `id` is optional and is only used to report back which items landed, so a
 *  caller can mark them — see lib/saved.ts. */
export interface SaveItem { url: string; filename: string; id?: string; }

/** Save many photos the way this platform actually keeps them.
 *
 *  Returns how many were saved. A cancelled share stops the whole run — carrying on would keep
 *  showing sheets to someone who has just said no.
 *
 *  Non-iOS callers should prefer the server's zip: one file, one click, no memory ceiling. This is
 *  for the platform where a zip is a dead end. */
export async function saveMany(
  items: SaveItem[],
  onProgress?: (p: SaveManyProgress) => void,
): Promise<{ saved: number; cancelled: boolean; savedIds: string[] }> {
  let saved = 0;
  // WHICH ones landed, not just how many. A count cannot mark a grid: a roll where three fetches
  // failed and a share was cancelled halfway needs to tick exactly the ones that got through.
  const savedIds: string[] = [];
  for (let i = 0; i < items.length; ) {
    const batch: File[] = [];
    // Kept alongside the batch so an id is only recorded once the batch it belongs to is handed
    // over — a file that was fetched but never shared must not be ticked.
    const batchIds: string[] = [];
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
          if (it.id) batchIds.push(it.id);
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
      savedIds.push(...batchIds);
      onProgress?.({ done: Math.min(i, items.length), total: items.length });
    } catch (e) {
      // A dismissed share sheet is the one case where nothing reached the device, so this batch is
      // NOT recorded — ticking it would be the exact overstatement the marks exist to avoid.
      if ((e as DOMException)?.name === 'AbortError') return { saved, cancelled: true, savedIds };
      // Anything else: fall back to downloads for this batch rather than losing it.
      for (const f of batch) downloadBlob(f, f.name);
      saved += batch.length;
      savedIds.push(...batchIds);
    }
    // Let the tab breathe between batches so the memory from the last one is actually released.
    await new Promise((r) => setTimeout(r, 60));
  }
  return { saved, cancelled: false, savedIds };
}

/** Does this device want FILES rather than a zip?
 *
 *  A zip is the right answer on a desktop: one file, no memory ceiling, and unzipping is a
 *  double-click. On a phone it is close to a dead end — you need an extractor, and what comes out
 *  sits in a folder rather than in the camera roll, which is the only place anyone was trying to
 *  get to. So a touch device takes the files.
 *
 *  Coarse pointer rather than a width query: a narrow desktop window is still a desktop, and a
 *  tablet in landscape is still a tablet. */
export function prefersFiles(): boolean {
  try {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(pointer: coarse)').matches;
  } catch { return false; }
}

/** Above this many, ask before saving as files — but only where the count actually costs anybody
 *  anything.
 *
 *  These two platforms are not the same ask, and treating them as one is what made "Download all"
 *  hand back a zip on a 55-shot roll:
 *
 *  - Android and desktop: a save is a silent, sequential download. Fifty files is fifty rows in the
 *    downloads list and not one tap. saveMany() already chunks for memory, so there is no ceiling
 *    to protect — a cap here would be us inventing a limit the platform does not have.
 *  - iOS: every chunk is a share sheet somebody has to tap through. Fifty photos is six prompts in
 *    a row, which is worth warning about before it starts.
 *
 *  So the number is real on iOS and absent everywhere else. (Chrome does ask once per site before
 *  it will auto-download multiple files; that is a single prompt, not one per photo.) */
export const FILES_MAX = 25;

/** How many files this platform will save before it is worth stopping to ask. */
export function filesLimit(): number {
  return isIOS() ? FILES_MAX : Infinity;
}
