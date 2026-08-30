// In-app browser detection.
//
// Facebook's and Instagram's embedded webviews do not expose `navigator.mediaDevices.getUserMedia`,
// so the camera — which IS the product — cannot work inside them at all. This matters far more than
// it looks: paid traffic frequently lands in these webviews rather than the system browser (in one
// 96h sample, 83% of ad-associated requests came from the Facebook iOS in-app browser), and every
// one of those visitors hits a dead end with no explanation.
//
// Detection is best-effort by user agent. `cameraUnavailable()` is the authoritative check — prefer
// it when deciding whether the capture flow can actually run; use the name only to word the message.

export function inAppBrowserName(ua?: string): string | null {
  const s = ua ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  if (/FBAN|FBAV|FB_IAB|FBIOS/i.test(s)) return 'Facebook';
  if (/Instagram/i.test(s)) return 'Instagram';
  if (/TikTok|BytedanceWebview|musical_ly/i.test(s)) return 'TikTok';
  if (/Snapchat/i.test(s)) return 'Snapchat';
  if (/\bLine\//i.test(s)) return 'LINE';
  if (/\bTwitter\b|\bX11.*Twitter/i.test(s)) return 'X';
  if (/Pinterest/i.test(s)) return 'Pinterest';
  return null;
}

// True when the browser cannot give us a camera at all. Runs only client-side.
export function cameraUnavailable(): boolean {
  if (typeof navigator === 'undefined') return false;
  return !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function';
}

export function isIOS(ua?: string): boolean {
  const s = ua ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  return /iPhone|iPad|iPod/i.test(s);
}
