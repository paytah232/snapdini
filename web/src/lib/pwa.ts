// ── "Add Snapdini to your home screen" ──────────────────────────────────────────
//
// Chrome shows its own install banner the moment a site meets its installability bar, and it picks
// the moment: usually the first visit, before a guest has any idea what Snapdini is. Capturing the
// event suppresses that banner and hands us the decision — so we can ask after somebody has taken
// a few photos and has a reason to say yes.
//
// What we CANNOT change is Chrome's memory of its own banner: that is per-origin and roughly 90
// days. Ours is per EVENT, because that is the unit a guest thinks in — a different wedding is a
// different occasion to be asked, and the same wedding is not.
//
// iOS has no equivalent. Safari has never fired `beforeinstallprompt` and shows no prompt at all;
// adding to the home screen there is Share → Add to Home Screen, by hand. So on iPhone this module
// reports "can't prompt" and the UI has to give instructions instead of a button.
import { writable } from 'svelte/store';

/** The deferred Chrome event. Not a Svelte store: it is a one-shot handle, not state to render. */
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let deferred: InstallEvent | null = null;

/** True when we hold a live prompt we can fire. Always false on iOS and in an installed window. */
export const canInstall = writable(false);

/** Already running as an installed app — nothing to offer. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches
    || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

/** iOS/iPadOS Safari, where the only route is the Share menu. iPadOS reports itself as a Mac, so
 *  the touch check is what separates an iPad from a desktop Safari that cannot install at all. */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Start listening. Safe to call more than once; later calls are ignored. */
let wired = false;
export function initInstall(): void {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    // THIS is what stops Chrome's own banner appearing. Without it the browser decides the moment.
    e.preventDefault();
    deferred = e as InstallEvent;
    canInstall.set(!isStandalone());
  });
  // Fired once the app is installed, by any route — including Chrome's menu, which never goes
  // through our prompt. Clearing here stops us offering an install to somebody who has one.
  window.addEventListener('appinstalled', () => { deferred = null; canInstall.set(false); });
}

/** Fire the real prompt. Returns what they chose, or null if there was nothing to fire. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | null> {
  if (!deferred) return null;
  const e = deferred;
  // A deferred prompt can only be used ONCE. Clearing first means a double-tap cannot fire it twice
  // and hit Chrome's "prompt already used" error.
  deferred = null;
  canInstall.set(false);
  try {
    await e.prompt();
    const { outcome } = await e.userChoice;
    return outcome === 'accepted' ? 'accepted' : 'dismissed';
  } catch {
    return null;
  }
}

// ── Whether to ASK, which is a different question from whether we CAN ──────────
const key = (joinCode: string) => `snap_install_asked_${joinCode}`;

/** Have we already asked at this event? Per event on purpose — see the note at the top. */
export function askedAlready(joinCode: string): boolean {
  try { return localStorage.getItem(key(joinCode)) === '1'; } catch { return false; }
}

export function markAsked(joinCode: string): void {
  try { localStorage.setItem(key(joinCode), '1'); } catch { /* private mode: we just ask again */ }
}
