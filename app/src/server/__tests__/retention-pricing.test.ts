// Retention and duration do NOT follow the guest-tier rule.
//
// The guest tier buys FEATURES: under the free-guest cap, shots/frames/video cost nothing. Retention
// and duration are add-ons priced independently of guest count — except that a PAID event has a
// month of retention included. The upgrade panel had applied the feature rule to retention and so
// showed the price exactly inverted: "free" on the event that is charged, "+$3" on the event that
// already includes it. These pin the real shape so a UI label can be checked against it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { quote, RETENTION_FREE_DAYS, RETENTION_PAID_DAYS, FREE_ALL_GUESTS, MAX_QUOTABLE_GUESTS } from '../billing';

const q = (guests: number, retentionDays: number, durationHours = 4) =>
  quote({ maxGuests: guests, maxPhotos: 12, aspectRatios: ['1:1'], videoSeconds: 0, durationHours, retentionDays });

describe('retention is charged on a free event and included on a paid one', () => {
  test('a free event pays for a month', () => {
    assert.ok(q(FREE_ALL_GUESTS, RETENTION_PAID_DAYS).retentionCents > 0);
  });
  test('a paid event gets the same month for nothing', () => {
    assert.equal(q(FREE_ALL_GUESTS + 1, RETENTION_PAID_DAYS).retentionCents, 0);
  });
  test('the included week is free on both', () => {
    assert.equal(q(FREE_ALL_GUESTS, RETENTION_FREE_DAYS).retentionCents, 0);
    assert.equal(q(FREE_ALL_GUESTS + 1, RETENTION_FREE_DAYS).retentionCents, 0);
  });
  test('beyond the included month both tiers pay the same', () => {
    assert.equal(q(FREE_ALL_GUESTS + 1, 92).retentionCents, q(FREE_ALL_GUESTS, 92).retentionCents);
    assert.ok(q(FREE_ALL_GUESTS + 1, 92).retentionCents > 0);
  });
});

describe('duration ignores the guest tier entirely', () => {
  test('the same long event costs the same on either tier', () => {
    assert.equal(q(FREE_ALL_GUESTS, RETENTION_FREE_DAYS, 72).durationCents,
                 q(FREE_ALL_GUESTS + 1, RETENTION_FREE_DAYS, 72).durationCents);
  });
  test('and it is a real charge, not zero', () => {
    assert.ok(q(FREE_ALL_GUESTS, RETENTION_FREE_DAYS, 72).durationCents > 0);
  });
});

// ── Off the top of the ladder ────────────────────────────────────────────────
//
// quote() has a third tier, 'custom', for a guest count no rung fits. It exists to say "talk to
// us", and it says so in `notes`. But it also reports baseCents 0 and every add-on 0, so
// `requiresPayment` came back FALSE — and the create route reads `entPaid = !q.requiresPayment`.
// POSTing maxGuests:1000 therefore produced a fully-entitled 1000-guest event, with video and every
// frame shape, for A$0: strictly more than the A$59 top tier, free, to anyone who could write a
// curl command. The upgrade route had it worse — `diff` went negative against what the host had
// already paid, so the free-delta branch applied it immediately.
//
// These pin the shape that made that possible, so nobody "fixes" the zero by making it look paid.

describe('a quote nobody can pay', () => {
  const over = (guests: number) =>
    quote({ maxGuests: guests, maxPhotos: 12, aspectRatios: ['1:1'], videoSeconds: 0, durationHours: 4, retentionDays: 7 });

  test('past the top rung the tier is custom, and it costs nothing because it has no price', () => {
    const q = over(MAX_QUOTABLE_GUESTS + 1);
    assert.equal(q.tier, 'custom');
    assert.equal(q.baseCents, 0);
    assert.equal(q.amountCents, 0);
  });

  test('and so it reports requiresPayment false — which is the trap, not the bug', () => {
    // Left true to itself, this is correct: there is nothing to charge. The defect was every
    // CALLER reading it as "this event is paid for". Both routes now refuse tier 'custom' outright;
    // this test exists so the refusal is never replaced by trusting this flag.
    assert.equal(over(1000).requiresPayment, false);
  });

  test('the last rung that can actually be sold still prices normally', () => {
    const q = over(MAX_QUOTABLE_GUESTS);
    assert.equal(q.tier, 'paid');
    assert.ok(q.baseCents > 0, 'the top sellable tier must still cost money');
    assert.equal(q.requiresPayment, true);
  });

  test('MAX_QUOTABLE_GUESTS really is the boundary, not a number written twice', () => {
    assert.equal(over(MAX_QUOTABLE_GUESTS).tier, 'paid');
    assert.equal(over(MAX_QUOTABLE_GUESTS + 1).tier, 'custom');
  });

  test('it says so out loud, so a caller that does allow it can tell the host why', () => {
    assert.ok(over(1000).notes.some((n) => /custom plan/i.test(n)));
  });
});
