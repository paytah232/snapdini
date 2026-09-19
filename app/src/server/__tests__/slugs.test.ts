// What a host may and may not claim as a custom URL.
//
// The rule these tests exist to pin down is that the match is EXACT. It is the kind of rule a
// later "tightening" quietly breaks — someone notices `snapdini1` is allowed, decides that looks
// like a loophole, switches to startsWith, and now nobody can call their event "supporters" or
// "billings-birthday". The false positives would be silent, common, and invisible to us: a host
// types the name of their own party, is refused, and never tells us.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isReservedSlug, RESERVED_SLUG_ERROR } from '../slugs';

describe('custom URLs a host may not claim', () => {
  test('our own name and the phrases a phishing link would want are refused', () => {
    for (const s of ['snapdini', 'support', 'billing', 'account', 'password', 'verify',
                     'refund', 'invoice', 'admin', 'login', 'official', 'security']) {
      assert.equal(isReservedSlug(s), true, `${s} should be reserved`);
    }
  });

  test('a reserved word with ANYTHING attached is a different word, and is allowed', () => {
    // This is the whole point. Each of these is a plausible real event name.
    for (const s of ['snapdini1', 'snapdinis-party', 'support-crew-xmas', 'billings-birthday',
                     'team-offsite', 'helpers', 'accounting-dept-do', 'my-demo-night',
                     'adminas-40th', 'verify-the-vibes']) {
      assert.equal(isReservedSlug(s), false, `${s} must be allowed — it is somebody's event`);
    }
  });

  test('case does not let one through', () => {
    // slugify() lowercases before we ever see it, but the guard must not depend on that.
    assert.equal(isReservedSlug('Snapdini'), true);
    assert.equal(isReservedSlug('SUPPORT'), true);
    assert.equal(isReservedSlug('  billing  '), true);
  });

  test('anything that is not a string is let THROUGH, not blocked', () => {
    // Fail open. Being wrongly refused your own event name is a cost we would pay often; letting
    // an odd value past here costs nothing, because length and uniqueness are still enforced.
    for (const v of [null, undefined, 42, {}, [], true]) {
      assert.equal(isReservedSlug(v), false);
    }
  });

  test('the message never claims somebody else has it', () => {
    // Nobody holds these, so "already taken" would be a lie, and a host retrying variations of a
    // word we will never release deserves to be told the actual rule.
    assert.doesNotMatch(RESERVED_SLUG_ERROR, /taken/i);
    assert.match(RESERVED_SLUG_ERROR, /reserved/i);
  });
});
