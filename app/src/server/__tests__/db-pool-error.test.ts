// The database pool must not take the process down with it.
//
// node-postgres emits 'error' on an idle pooled client when the server closes the connection —
// a restart, a replica promotion, an admin `pg_terminate_backend`. There is no in-flight request to
// reject, so the event lands on the Pool, and an EventEmitter with no 'error' listener throws. Node
// exits. That happened on devel on 2026-09-21 ("terminating connection due to administrator
// command"), and the container stayed up with a dead app inside it, so nothing restarted it.
//
// The scenario that makes it serious is the read-only failover from 1.5.1: a promotion terminates
// every connection the pool holds, so without a listener the app would die at precisely the moment
// that feature exists to survive.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db';

describe('the pg pool', () => {
  test('has an error listener, or Node exits on an idle-client drop', () => {
    assert.ok(pool.listenerCount('error') > 0,
      'pg Pool has no error listener — an idle client dropped by the server will kill the process');
  });

  test('survives the actual event that killed it, not a mock of it', () => {
    // Emitting 'error' IS the failure: with no listener this call throws, which is precisely the
    // unhandled-'error'-event path that reached the process. So this asserts the real mechanism
    // rather than standing in for it.
    const real = new Error('terminating connection due to administrator command');
    const quiet = console.error;
    console.error = () => {};
    try {
      assert.doesNotThrow(() => pool.emit('error', real, undefined as never));
    } finally {
      console.error = quiet;
    }
  });

  test('says which client went, so an operator can tell this from a query failure', () => {
    // A silent catch would pass the two tests above and leave a promotion looking like nothing
    // happened. The message has to reach the log.
    const seen: string[] = [];
    const quiet = console.error;
    console.error = (m?: unknown) => { seen.push(String(m)); };
    try {
      pool.emit('error', new Error('terminating connection due to administrator command'), undefined as never);
    } finally {
      console.error = quiet;
    }
    assert.equal(seen.length, 1, 'the handler must log exactly once per dropped client');
    assert.match(seen[0], /terminating connection due to administrator command/);
    assert.match(seen[0], /\[db\]/);
  });
});
