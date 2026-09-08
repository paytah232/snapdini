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

/**
 * Reads the draft WITHOUT removing it, and clears it only if it has gone stale.
 *
 * It used to consume on read, which created a race that could only bite the person it was meant to
 * help: on one device, the tab that opens the verification email and the tab that was polling both
 * head for /app, and whichever mounted first ATE the draft — leaving the other showing an empty
 * form. Roughly a one-in-five coin flip, and the loser was often the tab in front of the user,
 * because they had just clicked the link in it.
 *
 * So nothing competes for it now. The draft's life ends where it should: when the event is actually
 * created (clearDraft below), or when it ages out. Re-reading it is harmless — on a refresh mid-
 * creation it restores what someone typed instead of handing them a blank form, which is the better
 * outcome anyway, since unsaved edits were going to be lost either way.
 */
export function readDraft(): Record<string, unknown> | null {
  const d = read();
  if (d && !fresh(d)) { clearDraft(); return null; }   // an abandoned attempt, not this journey
  return fresh(d) ? (d as Record<string, unknown>) : null;
}

/** "Is there an event waiting to be finished?" — used to decide where to send a freshly verified
 *  user. Like readDraft it leaves the draft alone; only creating the event ends it. */
export function hasFreshDraft(): boolean {
  const d = read();
  if (d && !fresh(d)) { clearDraft(); return false; }
  return fresh(d);
}
