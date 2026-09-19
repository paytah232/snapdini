// Which section/tab a page was on, remembered across a refresh.
//
// sessionStorage, deliberately, not the URL. The admin page's hash already carries the ORGANIZER
// CODE — a bearer credential — so a view name there would either fight it or park a section name
// next to a secret in the address bar. It is also the wrong thing to put in a shareable link: a URL
// someone sends should open the page, not reproduce whichever tab they happened to be standing on.
//
// Per-TAB (sessionStorage, not localStorage) and keyed per subject, so two events open side by side
// keep their own place instead of overwriting one another, and closing the tab forgets it — which
// is the lifetime people expect of "where I was", as opposed to a setting they chose.
//
// Every read is validated against the caller's own list of allowed values. Stored view names go
// stale the moment a section is renamed or removed, and a page that trusts one puts itself into a
// state it can no longer render.

const available = (): Storage | null => {
  try {
    if (typeof sessionStorage === 'undefined') return null;   // SSR
    return sessionStorage;
  } catch { return null; }                                     // private mode, storage blocked
};

export function readView<T extends string>(key: string, allowed: readonly T[]): T | null {
  const s = available();
  if (!s) return null;
  try {
    const v = s.getItem(`snap_view_${key}`);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : null;
  } catch { return null; }
}

/** null clears it — "back to the menu" is a place too, and has to be remembered as one. */
export function writeView(key: string, value: string | null): void {
  const s = available();
  if (!s) return;
  try {
    if (value === null) s.removeItem(`snap_view_${key}`);
    else s.setItem(`snap_view_${key}`, value);
  } catch { /* the place just will not stick */ }
}
