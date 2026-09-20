// Read-only mode — serving from a streaming replica.
//
// Verified end to end against the real warm standby on 2026-09-20: the stock image
// crash-looped on `PreventCommandIfReadOnly`, and with this in place the app booted healthy, served
// reads, refused writes with 503, and wrote nothing. These tests hold the decisions that made that
// work, because every one of them is the kind that looks like a detail and is not.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyReplicaState, isReadOnly, readOnlyKnown, blockedByReadOnly, READ_ONLY_BODY } from '../readonly';

describe('deciding whether this database is a replica', () => {
  beforeEach(() => { applyReplicaState(false); });

  test('a failed check KEEPS the last answer rather than guessing', () => {
    // The only two guesses available are both wrong. "Writable" lets writes through to a replica
    // that will reject them; "read-only" takes a healthy production site read-only over one dropped
    // packet. The answer we already had is better than either.
    applyReplicaState(true);
    assert.equal(isReadOnly(), true);
    applyReplicaState(null);
    assert.equal(isReadOnly(), true, 'a null answer must not clear read-only');

    applyReplicaState(false);
    applyReplicaState(null);
    assert.equal(isReadOnly(), false, 'a null answer must not impose read-only either');
  });

  test('promotion lifts the mode with no restart', () => {
    // pg_promote() during an incident. The poll sees pg_is_in_recovery() go false and the site
    // starts taking writes on its own — nobody has to remember to clear a flag mid-outage. This is
    // the entire reason the mode is detected rather than configured.
    applyReplicaState(true);
    assert.equal(isReadOnly(), true);
    applyReplicaState(false);
    assert.equal(isReadOnly(), false);
  });

  test('the state is marked known once answered', () => {
    applyReplicaState(true);
    assert.equal(readOnlyKnown(), true);
  });
});

describe('which requests a replica refuses', () => {
  test('nothing is blocked while the database is writable', () => {
    applyReplicaState(false);
    assert.equal(blockedByReadOnly('POST', '/photos/chunk'), false);
    assert.equal(blockedByReadOnly('DELETE', '/photos/abc'), false);
  });

  describe('once read-only', () => {
    beforeEach(() => { applyReplicaState(true); });

    test('reads are served — that is the whole point of the mode', () => {
      // A guest during an outage mostly wants to LOOK at their photos, and looking is a read. If
      // this ever starts returning true the feature has no reason to exist.
      for (const p of ['/config', '/events/ABCD1234', '/photos/ABCD1234', '/auth/me'])
        assert.equal(blockedByReadOnly('GET', p), false, p);
      assert.equal(blockedByReadOnly('HEAD', '/photos/ABCD1234'), false);
    });

    test('GETs that WRITE are refused too', () => {
      // The method test alone waves these through. Both are email links, and an email link can
      // only be a GET — there is no way to make a mail client POST. On a replica the write throws
      // and the guest is told 500 "Something went wrong" about a sign-in link that is merely
      // early. Found by auditing every GET route for a write, not by assuming.
      assert.equal(blockedByReadOnly('GET', '/auth/verify'), true);
      assert.equal(blockedByReadOnly('GET', '/auth/magic'), true);
      // ...and only those. Every other GET is a read and must still be served.
      assert.equal(blockedByReadOnly('GET', '/auth/me'), false);
      assert.equal(blockedByReadOnly('GET', '/auth/verify-something-else'), false);
    });

    test('every write method is refused', () => {
      for (const m of ['POST', 'PUT', 'PATCH', 'DELETE'])
        assert.equal(blockedByReadOnly(m, '/photos/chunk'), true, m);
      // Lower-case too: the method comes off the wire and Express does not normalise it for us.
      assert.equal(blockedByReadOnly('post', '/photos/chunk'), true);
    });

    test('the allowlist is only for endpoints that touch no row', () => {
      // csp-report logs a line and stores nothing, so it keeps working on a replica. The list is
      // deliberately tiny: anything NEW must default to blocked, which is what this asserts.
      assert.equal(blockedByReadOnly('POST', '/csp-report'), false);
      assert.equal(blockedByReadOnly('POST', '/csp-report-not-really'), true);
      assert.equal(blockedByReadOnly('POST', '/webhooks/mailgun'), true);
    });
  });
});

describe('what a refused write tells the guest', () => {
  test('says the photos are safe, and that it is paused rather than failed', () => {
    // The message a guest sees mid-failover. "Failed" would have them re-shooting a moment they
    // cannot re-shoot; the upload queue resends on its own, so "paused" is both kinder and true.
    assert.match(READ_ONLY_BODY.error, /safe/i);
    assert.match(READ_ONLY_BODY.error, /paused/i);
    assert.match(READ_ONLY_BODY.error, /no need to re-upload/i);
    assert.equal(READ_ONLY_BODY.readOnly, true);
  });
});
