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
