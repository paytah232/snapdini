// A half-finished event, kept across the sign-up detour.
//
// Two pages need this and they must agree, which is why the key and the window live here rather
// than being retyped in each: /app writes the draft before sending someone off to sign up and
// restores it when they return, and /dashboard needs to know a draft is waiting so it can send a
// freshly verified user back to finish it instead of dropping them on the dashboard.
//
// localStorage, NOT sessionStorage: verifying an email opens a NEW TAB, where sessionStorage does
// not exist. So the draft is stamped and expires on age instead of on tab lifetime.
export const DRAFT_KEY = 'snapdini-event-draft';
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;   // long enough to go and find a verification email

type Draft = Record<string, unknown> & { savedAt?: number };

const fresh = (d: Draft | null): boolean =>
  !!d && typeof d.savedAt === 'number' && Date.now() - d.savedAt <= DRAFT_TTL_MS;

function read(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;   // private mode, blocked storage, or corrupt JSON — all mean "no draft"
  }
}

/** Stamps and stores the fields. Storage being unavailable is never an error: the draft is a
 *  convenience, and losing it must not stop someone creating an event. */
export function saveDraft(fields: Record<string, unknown>): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), ...fields }));
  } catch { /* ignore */ }
}

export function clearDraft(): void {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

/** One-shot: reads and REMOVES, so a refresh cannot resurrect a draft the user has already been
 *  given back. Returns null when there is nothing fresh — a stale draft is someone's abandoned
 *  attempt, not this journey, and is cleared rather than left to reappear later. */
export function takeDraft(): Record<string, unknown> | null {
  const d = read();
  clearDraft();
  return fresh(d) ? (d as Record<string, unknown>) : null;
}

/** NON-consuming: "is there an event waiting to be finished?". Used to decide where to send a
 *  freshly verified user, which must not itself spend the draft — /app is what restores it. */
export function hasFreshDraft(): boolean {
  const d = read();
  if (d && !fresh(d)) { clearDraft(); return false; }
  return fresh(d);
}
