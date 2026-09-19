// Participant session lives in localStorage keyed by joinCode (matches the old app, so
// existing demo/join links keep working).
const key = (joinCode: string) => `session_${joinCode}`;

export const getSession = (joinCode: string): string | null =>
  typeof localStorage !== 'undefined' ? localStorage.getItem(key(joinCode)) : null;
export const saveSession = (joinCode: string, token: string): void => localStorage.setItem(key(joinCode), token);
export const clearSession = (joinCode: string): void => localStorage.removeItem(key(joinCode));

// Organizer admin code (per-event), used by the admin page.
const adminKey = (joinCode: string) => `admin_${joinCode}`;
export const getAdminCode = (joinCode: string): string =>
  (typeof localStorage !== 'undefined' ? localStorage.getItem(adminKey(joinCode)) : '') || '';
export const saveAdminCode = (joinCode: string, code: string): void => localStorage.setItem(adminKey(joinCode), code);
// Clear every cached organizer code — called on logout so signing out also revokes the
// quick manager access this browser had stored (organizer codes are bearer credentials).
export const clearAllAdminCodes = (): void => {
  if (typeof localStorage === 'undefined') return;
  for (const k of Object.keys(localStorage)) if (k.startsWith('admin_')) localStorage.removeItem(k);
};

// ── Which event this browser was last in ─────────────────────────────────────────────────────
//
// The installed app launches at a FIXED start_url with no code in it. Without somewhere to look
// that up, it opens on whatever that URL happens to be and knows nothing: a guest installs it from
// the middle of a party, taps it, and lands on a stranger's screen with their event, their name and
// their shots apparently gone. Nothing was actually lost — the session is still in this browser,
// keyed by a join code the launcher never carried.
//
// The PATH is stored, not just the code, so a guest who arrived on a custom link comes back to the
// address they used rather than being bounced to its /join/CODE equivalent.
const LAST = 'snap_last_event';

export type LastEvent = { code: string; path: string };

export const rememberEvent = (joinCode: string, path: string): void => {
  try { localStorage.setItem(LAST, JSON.stringify({ code: joinCode, path })); } catch { /* private mode */ }
};

export const lastEvent = (): LastEvent | null => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LAST) : null;
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LastEvent>;
    // This value gets NAVIGATED TO, so it is checked rather than trusted: one leading slash and no
    // second slash or backslash after it, which is what keeps "//evil.example" — a protocol-relative
    // URL that leaves the site entirely — from being a stored path.
    return typeof v?.code === 'string' && typeof v?.path === 'string' && /^\/[^/\\]/.test(v.path)
      ? { code: v.code, path: v.path }
      : null;
  } catch { return null; }
};

/** Forget the way back if it leads HERE — called when this page turns out to be a dead event. */
export const forgetEventAt = (path: string): void => {
  try { if (lastEvent()?.path === path) localStorage.removeItem(LAST); } catch { /* ignore */ }
};
