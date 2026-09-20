// A site admin standing inside somebody else's event.
//
// THIS IS NOT ACCESS CONTROL. Everything here runs in the browser, the server authorises the same
// account for the same writes with or without it, and a determined operator gets past it with
// devtools in four seconds. It exists because the event manager looks IDENTICAL whether the
// operator is in their own event or in a paying customer's wedding, and half a dozen of its
// controls save on the change event — one stray tap and a live event has moderation on, downloads
// off, or face matching switched on for guests who never agreed to it, with no confirm and no undo.
//
// You cannot accidentally autosave what you cannot click. That is the whole idea. Treat a bypass as
// a UX bug, never as a security hole — the security boundary is `requireAdmin` on the server.

/** Whose event is this, as far as the browser can tell?
 *
 *  Three states, not a boolean, because "we have not been told yet" is a real answer and folding it
 *  into `false` is what would put an unguarded manager on screen for the moment before the reply
 *  lands. Which way that moment falls is decided in `isGuarded` below. */
export type Ownership = 'unknown' | 'yours' | 'theirs';

/** Read the answer off `youManage` — the field the PUBLIC event endpoint computes (owner OR
 *  accepted co-host, by identity; see events.ts). The admin payload does NOT carry it, which is why
 *  the manager reads it off the public event it already fetches for the organizer-code wall.
 *
 *  `undefined`/`null` is "not answered", not "no". An older API, a failed fetch and a reply still in
 *  flight all arrive here the same way, and none of them is evidence that the event is somebody
 *  else's. */
export function ownershipOf(youManage: boolean | undefined | null): Ownership {
  if (youManage === true) return 'yours';
  if (youManage === false) return 'theirs';
  return 'unknown';
}

/** Does the guardrail apply at all?
 *
 *  Deliberately `!== 'yours'` rather than `=== 'theirs'`. The safe direction is obvious once you
 *  write down both mistakes: guarding your own event costs one press of "Take control", and NOT
 *  guarding a customer's costs a changed setting on a live wedding. So an unanswered ownership
 *  check holds the page read-only until it is answered.
 *
 *  Nobody but a site admin ever sees any of this. An owner, a co-host and someone holding the
 *  organizer code get the manager exactly as it has always been. */
export function isGuarded(viewerIsAdmin: boolean, ownership: Ownership): boolean {
  return viewerIsAdmin && ownership !== 'yours';
}

/** Is the page read-only right now? Guarded, and control not yet taken. */
export function isLocked(viewerIsAdmin: boolean, ownership: Ownership, tookControl: boolean): boolean {
  return isGuarded(viewerIsAdmin, ownership) && !tookControl;
}

/** SESSION storage, not local.
 *
 *  Taking control has to survive the things that happen while you actually work — a reload, the
 *  30-second refresh, opening the review screen and coming back — or the prompt becomes noise and
 *  gets clicked through on reflex, which is the failure mode this whole file exists to avoid.
 *
 *  It must NOT survive the tab. localStorage would mean an operator who unlocked a customer's
 *  event in March is still unlocked in it in July, on a screen that looks like their own. Per tab
 *  and per event is the span of one sitting, which is the span of the decision.
 *
 *  Keyed by join code because that is what the manager route is keyed by, and because two events
 *  open in two tabs must not share an answer. */
const controlKey = (code: string) => `snap_admin_control_${code}`;

export function readTookControl(code: string): boolean {
  try {
    return sessionStorage.getItem(controlKey(code)) === '1';
  } catch {
    // Safari in private mode throws on access, not on write. Refusing to remember is the safe
    // failure: the operator is asked again, which is the state this file prefers anyway.
    return false;
  }
}

export function writeTookControl(code: string, on: boolean): void {
  try {
    if (on) sessionStorage.setItem(controlKey(code), '1');
    else sessionStorage.removeItem(controlKey(code));
  } catch {
    /* as above — an unremembered answer is a re-prompt, not a broken page */
  }
}

/** The words on the confirm. Here rather than in the markup so the test can assert that taking
 *  control is a deliberate act and stays one. */
export const TAKE_CONTROL_CONFIRM =
  'You are about to edit an event you do not own.\n\n'
  + 'Every change is saved immediately and logged against your account. Continue?';

/** What the page says when a press is refused. Shown as a toast rather than swallowed: a control
 *  that does nothing when pressed is the bug docs/DEVELOPMENT.md names, and "nothing happened" is
 *  indistinguishable from "the site is broken". */
export const LOCKED_REFUSAL = 'Read-only — press “Take control” in the red bar to edit this event.';
