// Guest-referral plumbing, client side.
//
// Guests never sign up, so the only way to connect "was a guest at X" to "later ran their own
// event" is a cookie set when they follow a link out of a gallery. The server owns the cookie
// (httpOnly) — this module just tells it when a referral happened, and keeps the tracking calls
// fire-and-forget so nothing here can slow a gallery down or break it.

/** Link a guest should follow to start their own event, carrying the source event's code. */
export function referralLink(sourceJoinCode: string): string {
  return `/?ref=${encodeURIComponent(sourceJoinCode)}`;
}

const beacon = (url: string, body: unknown) => {
  try {
    const json = JSON.stringify(body);
    // sendBeacon survives the page unloading, which matters when the click navigates away.
    if (navigator.sendBeacon?.(url, new Blob([json], { type: 'application/json' }))) return;
    void fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true });
  } catch { /* tracking must never throw into the UI */ }
};

/** Called on the landing page when `?ref=` is present, so the server can set the cookie. */
export function claimReferral(ref: string): void {
  if (ref) beacon('/api/track/ref', { ref });
}

export function trackGalleryView(joinCode: string): void {
  if (joinCode) beacon(`/api/track/gallery/${encodeURIComponent(joinCode)}`, {});
}

/** Batched so a scroll through 100 thumbnails is one request, not 100. */
export function trackPhotos(joinCode: string, ids: string[], kind: 'view' | 'download'): void {
  if (joinCode && ids.length) beacon('/api/track/photos', { joinCode, ids, kind });
}
