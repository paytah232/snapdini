// How the guest list is ORDERED, pinned at the source.
//
// The defect: "Editing a guest seemed to move them down the list — shouldn't it just organise
// alphabetically?" Nothing reordered anything. The list was `ORDER BY created_at`, a bulk import
// writes its entire batch with ONE timestamp, `ORDER BY` over ties has no defined order in
// Postgres, and an UPDATE writes a new tuple that a sequential scan then returns last. So every
// imported list was one big tie group, and editing anyone in it moved them to the bottom.
//
// Two things therefore have to hold, and the second is the one that actually fixes it:
//   1. the order is alphabetical, case-insensitively, with the nameless last;
//   2. the LAST sort key is UNIQUE. Without a unique final key the tie group is still a tie group —
//      two guests with the same name and address go on swapping places on every edit, and the
//      alphabetical sort merely makes the instability harder to spot.
//
// Asserted over the source, which is the same call this repo makes in release-hardening.test.ts and
// for the same reason: the alternative is a live Postgres inside the unit suite. A source assertion
// cannot prove Postgres honours it — that was proved on the wire against the dev stack, with a
// six-guest batch sharing one created_at, an edit, and an unchanged order — but it is what stops
// the ordering being quietly swapped back, which is exactly how it got here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const GUESTS = path.join(__dirname, '..', 'routes', 'guests.ts');
/** Comments stripped, so a check for "does this code still do X" is not satisfied by a comment
 *  saying it does. Every comment in that file talks about created_at. */
const code = fs.readFileSync(GUESTS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The GUEST_ORDER array's body, which is the whole definition. */
const orderBody = (): string => {
  const at = code.indexOf('const GUEST_ORDER = [');
  assert.notEqual(at, -1, 'GUEST_ORDER is gone — the ordering has been redefined somewhere else');
  return code.slice(at, code.indexOf('];', at));
};

describe('the guest list is ordered alphabetically', () => {
  test('by name, case-insensitively', () => {
    // Not the raw column: byte order puts every capitalised name above every lower-case one, so
    // "Zoe" sorts before "alice" and the list reads as two lists.
    assert.match(orderBody(), /lower\(\$\{eventGuests\.name\}\)/,
      'name is not lower-cased, so "alice" and "Alice" will not sort together');
  });

  test('with the nameless last, said out loud', () => {
    // A guest may legitimately have no name — an email-only import is supported — and they must not
    // pile up above everyone. Postgres defaults to NULLS LAST for ASC; stated anyway, because the
    // next person to add a DESC will not remember that the default flips with it.
    const body = orderBody();
    assert.match(body, /lower\(\$\{eventGuests\.name\}\) asc nulls last/);
    assert.match(body, /lower\(\$\{eventGuests\.email\}\) asc nulls last/,
      'the nameless need a second key, or they have no order among themselves');
  });

  test('and a UNIQUE last key, which is the part that kills the instability', () => {
    const terms = orderBody().split('\n').filter((l) => /eventGuests\./.test(l));
    const last = terms[terms.length - 1];
    assert.match(last, /eventGuests\.id/,
      'the final sort key must be the primary key — anything non-unique leaves a tie group, and a '
      + 'tie group is what made an edited guest jump to the bottom of the list');
  });

  test('no read of the guest list orders by created_at any more', () => {
    // Both readers: the list the host looks at, and the invite send — which is also capped at 200,
    // so its order decides WHO GETS MAILED when a list is longer than one send. The two must agree,
    // or "the first 200" means something different from what is on screen.
    assert.equal(/orderBy\(eventGuests\.createdAt\)/.test(code), false,
      'created_at is back as a sort key — a bulk import shares one, so this is not an order');
    const uses = code.match(/\.orderBy\(\.\.\.GUEST_ORDER\)/g) ?? [];
    assert.equal(uses.length, 2, `expected both guest reads to use GUEST_ORDER, found ${uses.length}`);
  });

  test('an edit still never writes createdAt, so nothing can reshuffle the list', () => {
    // The PATCH handler's own guarantee. If it ever started touching createdAt, alphabetical order
    // would hide the problem rather than fix it.
    const patch = code.slice(code.indexOf("router.patch('/:joinCode/guests/:id'"));
    const handler = patch.slice(0, patch.indexOf('router.delete'));
    assert.match(handler, /db\.update\(eventGuests\)\.set\(\{ \.\.\.cleaned, updatedAt: Date\.now\(\) \}\)/,
      'the guest PATCH no longer writes exactly {…cleaned, updatedAt} — check it is not writing createdAt');
  });
});
