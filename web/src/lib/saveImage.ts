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

/** Offer a blob to the OS: the share sheet where that exists, a download where it does not. */
export async function saveBlob(blob: Blob, filename: string): Promise<SaveOutcome> {
  if (canShareFiles()) {
    try {
      const file = new File([blob], filename, { type: blob.type || 'image/jpeg' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return 'shared';
      }
    } catch (e) {
      // They closed the sheet. Respect it — do not hand them the file anyway.
      if ((e as DOMException)?.name === 'AbortError') return 'cancelled';
      // Anything else (no activation left, an unsupported payload) falls through to the download,
      // which is strictly better than nothing.
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
