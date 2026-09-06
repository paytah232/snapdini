// Retention and duration do NOT follow the guest-tier rule.
//
// The guest tier buys FEATURES: under the free-guest cap, shots/frames/video cost nothing. Retention
// and duration are add-ons priced independently of guest count — except that a PAID event has a
// month of retention included. The upgrade panel had applied the feature rule to retention and so
// showed the price exactly inverted: "free" on the event that is charged, "+$3" on the event that
// already includes it. These pin the real shape so a UI label can be checked against it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { quote, RETENTION_FREE_DAYS, RETENTION_PAID_DAYS, FREE_ALL_GUESTS } from '../billing';

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
