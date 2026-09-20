// purgeAt is the most destructive number in the product.
//
// cleanup.ts deletes every photo of every event whose purgeAt has passed, with no undo and no
// warning. It was computed at four separate call sites, and two of them were wrong:
//
//   · the Stripe upgrade webhook hardcoded `|| 7`, so an operator who set RETENTION_DAYS=30 got
//     thirty days everywhere EXCEPT the path a customer reaches by paying us;
//   · the same line read the expiry as `parseInt(metadata.expiresAt, 10) || 0`, so absent metadata
//     became the epoch. purgeAt landed on 8 January 1970 — already in the past — and the next sweep
//     destroyed the photos of an event whose owner had, one webhook earlier, paid to upgrade it.
//
// Every neighbouring field in that update used `|| undefined` precisely so a missing value would
// leave the stored one alone. purgeAt did the opposite, in the one place where doing the opposite
// is unrecoverable.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_NAME, purgeAtFor, purgeAtForEvent, RETENTION_DAYS } from '../lib';

const DAY = 86_400_000;
const END = Date.UTC(2026, 9, 24, 14, 0);

describe('when an event’s photos are destroyed', () => {
  test('the end of the event plus the days the customer holds', () => {
    assert.equal(purgeAtFor(END, 31), END + 31 * DAY);
    assert.equal(purgeAtFor(END, 1), END + DAY);
    assert.equal(purgeAtFor(END, 366), END + 366 * DAY);
  });

  test('an event with no allowance of its own falls back to the configured floor', () => {
    assert.equal(purgeAtFor(END), END + RETENTION_DAYS * DAY);
    assert.equal(purgeAtFor(END, null), END + RETENTION_DAYS * DAY);
    assert.equal(purgeAtFor(END, undefined), END + RETENTION_DAYS * DAY);
  });

  test('the floor is the environment’s, not a 7 written into a route', () => {
    // The actual defect. RETENTION_DAYS is read from the environment in ONE place now, so the
    // fallback cannot drift between the create path and the payment path.
    assert.equal(RETENTION_DAYS, parseInt(process.env.RETENTION_DAYS || '7', 10) || 7);
    assert.equal(purgeAtFor(END, 0), purgeAtFor(END));
  });

  test('nonsense retention leans LONG, never short', () => {
    // Every wrong answer here costs somebody their photos. A garbage value must not be read as
    // "zero days" — that is a purge at the moment the event ends.
    for (const bad of [0, -1, -999, NaN, Infinity, 'x' as unknown as number]) {
      const at = purgeAtFor(END, bad as number);
      assert.equal(at, END + RETENTION_DAYS * DAY, `retentionDays=${String(bad)} did not fall back`);
      assert.ok(at > END, `retentionDays=${String(bad)} purged at or before the event ended`);
    }
  });

  test('a missing expiry throws rather than quietly becoming 1970', () => {
    // The catastrophic case, stated as the thing it must never do. A purge computed from 0 is a
    // purge in the past, and a purge in the past is a deletion on the next sweep.
    for (const bad of [0, NaN, -1, undefined as unknown as number, null as unknown as number]) {
      assert.throws(() => purgeAtFor(bad as number, 31), RangeError,
        `expiresAt=${String(bad)} produced a purge instead of throwing`);
    }
  });

  test('every result it does return is in the future of the event it belongs to', () => {
    for (const days of [undefined, null, 0, 1, 7, 31, 366, -5, NaN]) {
      assert.ok(purgeAtFor(END, days as number) > END);
    }
  });
});

describe('purgeAtForEvent — a save must not promote a demo into a month-long event', () => {
  // DEMO_NAME imported, never retyped: isDemoEvent matches on the exact string, so a fixture with a
  // plausible-looking name would be classed as a REAL event and these tests would pass while
  // asserting nothing about demos at all.
  const DEMO = { ownerUserId: null, name: DEMO_NAME, retentionDays: null };
  const REAL = { ownerUserId: 'u_1', name: "Priya and Tom", retentionDays: null };

  test('a demo purges at its expiry, not a retention window later', () => {
    // The bug: any settings save recomputed this with purgeAtFor, which leans long by design, so a
    // three-hour throwaway became a month-long event. Demos then accumulated, because nothing in
    // the product ever shortens a purge back down.
    assert.equal(purgeAtForEvent(DEMO, END), END);
  });

  test('a demo that is rescheduled keeps purging at its (new) expiry', () => {
    assert.equal(purgeAtForEvent(DEMO, END + 2 * DAY), END + 2 * DAY);
  });

  test('a real event is untouched — still expiry plus the retention window', () => {
    // The half that matters most: the fix must not shorten anybody's retention. This is the
    // behaviour every real event had before and must still have.
    assert.equal(purgeAtForEvent(REAL, END), purgeAtFor(END, null));
    assert.equal(purgeAtForEvent(REAL, END), END + RETENTION_DAYS * DAY);
  });

  test('a real event that RESCHEDULES moves its purge with the new date', () => {
    assert.equal(purgeAtForEvent(REAL, END + 5 * DAY), END + 5 * DAY + RETENTION_DAYS * DAY);
  });

  test('a paid retention extension is still honoured', () => {
    const paid = { ...REAL, retentionDays: 90 };
    assert.equal(purgeAtForEvent(paid, END), END + 90 * DAY);
    assert.ok(purgeAtForEvent(paid, END) > purgeAtForEvent(REAL, END), 'longer than the default');
  });

  test('an unowned event that is NOT the demo is a real event', () => {
    // isDemoEvent needs BOTH no owner and the demo's name. An ordinary un-owned event getting the
    // demo's three-hour life would destroy a stranger's photos the same afternoon.
    const orphan = { ownerUserId: null, name: 'Sarah and Mike', retentionDays: null };
    assert.equal(purgeAtForEvent(orphan, END), END + RETENTION_DAYS * DAY);
  });
});
