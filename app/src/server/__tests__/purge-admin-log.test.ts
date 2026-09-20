import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* The admin action log records what an operator changed on a customer's event, and to be useful it
 * records the BEFORE value — which means it holds copies of a removed guest's name and email, a
 * deleted comment's text, and captions.
 *
 * Everything else here is careful about that. The retention sweep deletes `participants` with the
 * comment "clears guest PII"; `client_errors` stores only a participant ID precisely so that
 * erasing a guest erases it there too. A log that kept the same facts for ever would outlive both
 * the privacy policy and the effort spent honouring it everywhere else.
 *
 * Asserted against the source because the sweep is one long function over a live database: standing
 * one up to prove a DELETE is present costs more than it tells you, and the failure mode being
 * guarded is somebody removing the line, not the line behaving oddly.
 */
const CLEANUP = readFileSync('src/server/cleanup.ts', 'utf8');

describe('the retention sweep leaves no guest PII behind', () => {
  test('the admin action log is purged with the event', () => {
    assert.match(CLEANUP, /db\.delete\(adminActions\)\.where\(eq\(adminActions\.eventId, e\.id\)\)/,
      'admin_actions must be deleted for the purged event');
  });

  test('it is purged in the same sweep as the guest rows, not on some other schedule', () => {
    // Same loop body as participants/photos/shares. A separate TTL would mean a window in which the
    // guests are gone and the copies of their names are not.
    const at = CLEANUP.indexOf('db.delete(adminActions)');
    const guests = CLEANUP.indexOf('db.delete(participants)');
    assert.ok(guests > -1 && at > guests, 'expected it alongside the participants delete');
    assert.ok(at - guests < 1800, 'expected it in the same block, not elsewhere in the file');
  });

  test('every table holding per-event guest data is swept', () => {
    for (const t of ['photos', 'participants', 'shares', 'slideshows', 'adminActions']) {
      assert.match(CLEANUP, new RegExp(`db\\.delete\\(${t}\\)`), `${t} is not purged`);
    }
  });
});
