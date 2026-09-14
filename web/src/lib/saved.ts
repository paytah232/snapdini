// Which photos THIS device has already saved.
//
// Per-browser, not per-account, and deliberately so: "have I got this one?" is a question about
// the device you are standing there holding, and the same person on a laptop and a phone has two
// honest answers. It is also why this is localStorage and not a column — the database stays out of
// a question that is answered correctly by the thing asking it, and a 150-guest event does not
// generate a write per guest per photo.
//
// WHAT THE TICK CLAIMS, precisely, because a green tick that overstates is worse than none:
//   - the bytes were fetched from the server without error, AND
//   - they were handed to the browser's downloader (or to the OS share sheet, and the sheet
//     completed rather than being dismissed).
// It does NOT claim a file exists on disk. No web API reports that — a download can still be
// cancelled at the browser's own prompt, and an iOS share sheet can complete into Messages rather
// than into Photos. This is the strongest claim the platform actually supports, and the tick is
// therefore "sent to your device", not "verified on your disk".

const key = (code: string) => `snap_saved_${code}`;

/** Kept bounded: an event can run to thousands of photos and this is a convenience, not a ledger.
 *  Oldest marks fall off the front first. */
const MAX = 2000;

export function savedSet(code: string): Set<string> {
  try {
    const raw = localStorage.getItem(key(code));
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    // A private window, blocked site data, or a corrupted value. The grid renders without ticks,
    // which is the correct degradation: no claim at all beats a wrong one.
    return new Set();
  }
}

/** Record that these ids reached the device. Returns the new set so a caller can assign it
 *  straight into reactive state rather than re-reading storage. */
export function markSaved(code: string, ids: string[]): Set<string> {
  const set = savedSet(code);
  for (const id of ids) set.add(id);
  try {
    const arr = [...set];
    localStorage.setItem(key(code), JSON.stringify(arr.length > MAX ? arr.slice(arr.length - MAX) : arr));
  } catch { /* out of quota or unavailable — the marks just will not persist */ }
  return set;
}
