// The rules that decide whether an optional email goes out, and that a link from one of those
// emails reaches the right account without a login. Both are things that fail silently: a wrong
// answer here does not throw, it sends a message somebody asked us not to send, or tells somebody
// trying to unsubscribe that their link is invalid.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPTIONAL_EMAIL_KINDS, SERVICE_EMAIL_KINDS, PREFS_TOKEN_RE, PREFS_TOKEN_TTL_MS,
  isOptionalKind, maskEmail, parseOptOutRequest,
} from '../email-prefs';
import { tokenUsable } from '../auth';

describe('which emails may be switched off', () => {
  test('only the two promotional kinds are optional', () => {
    // The service messages are about something the host set up and are exempt (Spam Act Sch 1
    // cl 3). Adding one here would quietly make a message people rely on skippable.
    assert.deepEqual(OPTIONAL_EMAIL_KINDS.map((k) => k.key), ['surveyEmail', 'activationNudgeEmail']);
  });

  test('every optional kind says what it is, in the recipient\'s words', () => {
    for (const k of OPTIONAL_EMAIL_KINDS) {
      assert.ok(k.label.length > 3, `${k.key} has no label`);
      assert.ok(k.description.length > 20, `${k.key} has no usable description`);
    }
  });

  test('the page can always state what keeps coming', () => {
    // "You cannot unsubscribe from these" is only acceptable if we say what they are.
    assert.ok(SERVICE_EMAIL_KINDS.length >= 4);
    for (const k of SERVICE_EMAIL_KINDS) assert.ok(k.label && k.description);
  });

  test('a kind we do not send is not optional', () => {
    assert.equal(isOptionalKind('welcomeEmail'), false);
    assert.equal(isOptionalKind('checkinEmail'), false);
    assert.equal(isOptionalKind(''), false);
    assert.equal(isOptionalKind(null), false);
    assert.equal(isOptionalKind('surveyEmail'), true);
  });
});

describe('reading a save from the preference page', () => {
  test('the payload is the whole desired set, so an empty list re-subscribes', () => {
    assert.deepEqual(parseOptOutRequest({ optOut: [] }), []);
  });

  test('unticking one kind and ticking another is one complete answer', () => {
    assert.deepEqual(parseOptOutRequest({ optOut: ['activationNudgeEmail'] }), ['activationNudgeEmail']);
  });

  test('unknown kinds are dropped, not refused', () => {
    // A bookmarked page from before a message kind was retired must still be able to save the
    // kinds that DO exist — failing the whole request would leave them subscribed.
    assert.deepEqual(parseOptOutRequest({ optOut: ['surveyEmail', 'ponyEmail', 42] }), ['surveyEmail']);
  });

  test('duplicates collapse', () => {
    assert.deepEqual(parseOptOutRequest({ optOut: ['surveyEmail', 'surveyEmail'] }), ['surveyEmail']);
  });

  test('a payload that is not a list at all is a malformed request, not an empty one', () => {
    // The difference matters: treating junk as [] would silently re-subscribe someone.
    assert.equal(parseOptOutRequest({ optOut: 'surveyEmail' }), null);
    assert.equal(parseOptOutRequest({}), null);
    assert.equal(parseOptOutRequest(null), null);
  });
});

describe('the address shown back on the page', () => {
  test('enough to recognise, not enough to harvest', () => {
    const masked = maskEmail('gillian.kieran@example.com');
    assert.ok(masked.startsWith('g'));
    assert.ok(masked.endsWith('@example.com'));
    assert.ok(!masked.includes('illian.kieran'), 'leaked the local part');
  });

  test('the mask does not give away how long the name is', () => {
    const a = maskEmail('jo@example.com');
    const b = maskEmail('jonathan-fitzwilliam@example.com');
    assert.equal(a.length, b.length);
  });

  test('junk is masked rather than echoed', () => {
    assert.equal(maskEmail('not-an-address'), '•••');
    assert.equal(maskEmail('@example.com'), '•••');
  });
});

describe('the preference-centre token', () => {
  const row = (over: Partial<{ purpose: string; consumedAt: number | null; expiresAt: number }> = {}) =>
    ({ purpose: 'email_prefs', consumedAt: null, expiresAt: 2_000, ...over });

  test('a live token for this purpose opens the page', () => {
    assert.equal(tokenUsable(row(), 'email_prefs', 1_000), true);
  });

  test('a token minted for something else does not', () => {
    // The sign-in link and the unsubscribe link are both rows in the same table. Without the
    // purpose check, one emailed link would be redeemable as the other.
    assert.equal(tokenUsable(row({ purpose: 'magic_login' }), 'email_prefs', 1_000), false);
  });

  test('an expired token does not', () => {
    assert.equal(tokenUsable(row({ expiresAt: 999 }), 'email_prefs', 1_000), false);
  });

  test('the boundary instant is still valid', () => {
    assert.equal(tokenUsable(row({ expiresAt: 1_000 }), 'email_prefs', 1_000), true);
  });

  test('a spent token does not', () => {
    assert.equal(tokenUsable(row({ consumedAt: 500 }), 'email_prefs', 1_000), false);
  });

  test('a token that is not in the table does not', () => {
    assert.equal(tokenUsable(undefined, 'email_prefs', 1_000), false);
  });

  test('the unsubscribe link outlives the message by a long way', () => {
    // The Act requires the facility to still work at least 30 days after the message was sent, and
    // people act on these months later. A sign-in link's 30 minutes would fail almost every real
    // attempt — as "this link is invalid", which is indistinguishable from us ignoring them.
    assert.ok(PREFS_TOKEN_TTL_MS > 30 * 86_400_000);
  });

  test('a path segment that is not a token never reaches the database', () => {
    assert.equal(PREFS_TOKEN_RE.test('z'.repeat(64)), false);        // hex only
    assert.equal(PREFS_TOKEN_RE.test('0123ABCD'.repeat(8)), false);  // lower-case hex only
    assert.equal(PREFS_TOKEN_RE.test('0123abcd'), false);            // too short
    assert.equal(PREFS_TOKEN_RE.test('../../etc/passwd'), false);
    assert.equal(PREFS_TOKEN_RE.test('0123456789abcdef'.repeat(4)), true);
  });
});
