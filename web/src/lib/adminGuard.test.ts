// The guard's decisions, on their own.
//
// These are four lines of logic and every one of them is a decision that could be flipped by
// somebody "tidying up" the truthiness — which is exactly the kind of change that looks harmless in
// a diff and silently unguards a customer's wedding. So the two that matter are asserted by name:
// an unanswered ownership check locks, and only a site admin is ever guarded at all.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ownershipOf, isGuarded, isLocked, readTookControl, writeTookControl, TAKE_CONTROL_CONFIRM,
} from './adminGuard';

describe('whose event is this', () => {
  it('reads youManage, and keeps "not answered yet" as its own state', () => {
    expect(ownershipOf(true)).toBe('yours');
    expect(ownershipOf(false)).toBe('theirs');
    // The three ways the answer can be absent — an older API, a failed fetch, a reply still in
    // flight — and none of them is evidence of anything.
    expect(ownershipOf(undefined)).toBe('unknown');
    expect(ownershipOf(null)).toBe('unknown');
  });
});

describe('who gets guarded', () => {
  it('nobody but a site admin', () => {
    // An owner, a co-host, and somebody holding the organizer code get the manager they have always
    // had. If this ever returns true for a non-admin, every host on the platform opens their own
    // event read-only.
    expect(isGuarded(false, 'theirs')).toBe(false);
    expect(isGuarded(false, 'unknown')).toBe(false);
    expect(isGuarded(false, 'yours')).toBe(false);
  });

  it('a site admin in their OWN event is not guarded', () => {
    expect(isGuarded(true, 'yours')).toBe(false);
  });

  it('a site admin in someone else’s event is', () => {
    expect(isGuarded(true, 'theirs')).toBe(true);
  });

  it('and so is a site admin whose ownership check has not come back', () => {
    // THE load-bearing one. `!== 'yours'`, not `=== 'theirs'`: guarding your own event costs one
    // press of Take control, and failing to guard a customer's costs a changed setting on a live
    // event. Write this as `=== 'theirs'` and the page renders live for as long as the check is in
    // flight — which, on a venue connection, is exactly when somebody starts tapping.
    expect(isGuarded(true, 'unknown')).toBe(true);
  });
});

describe('read-only until control is taken', () => {
  it('opens locked', () => {
    expect(isLocked(true, 'theirs', false)).toBe(true);
  });
  it('unlocks only for the admin who took control', () => {
    expect(isLocked(true, 'theirs', true)).toBe(false);
  });
  it('never locks anyone who was not guarded in the first place', () => {
    expect(isLocked(false, 'theirs', false)).toBe(false);
    expect(isLocked(true, 'yours', false)).toBe(false);
  });
});

describe('remembering that control was taken', () => {
  beforeEach(() => sessionStorage.clear());

  it('survives a reload, per event', () => {
    writeTookControl('ABC123', true);
    expect(readTookControl('ABC123')).toBe(true);
    // Per EVENT: unlocking one customer's event must not unlock the next one the operator opens.
    expect(readTookControl('XYZ789')).toBe(false);
  });

  it('can be handed back', () => {
    writeTookControl('ABC123', true);
    writeTookControl('ABC123', false);
    expect(readTookControl('ABC123')).toBe(false);
  });

  it('lives in the SESSION, so it cannot outlive the sitting', () => {
    // localStorage would mean an event unlocked in March is still unlocked in July, on a screen
    // that looks exactly like the operator's own. Asserted against the store rather than the
    // function, because the whole point is WHICH store it is.
    writeTookControl('ABC123', true);
    expect(sessionStorage.getItem('snap_admin_control_ABC123')).toBe('1');
    expect(localStorage.getItem('snap_admin_control_ABC123')).toBeNull();
  });
});

describe('taking control is a deliberate act', () => {
  it('says what is about to happen, and that it is recorded', () => {
    // The words are in the module rather than the markup so this can hold them to saying both
    // things: whose event it is, and that the change is logged. A confirm that only says "Are you
    // sure?" is one people learn to click through.
    expect(TAKE_CONTROL_CONFIRM).toMatch(/do not own/i);
    expect(TAKE_CONTROL_CONFIRM).toMatch(/logged/i);
  });
});
