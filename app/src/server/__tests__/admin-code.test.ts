// Who may read the event's admin code back out of the API.
//
// The code is minted at creation, dropped into one URL and never shown again — so an owner who
// wanted to delegate had nothing to send. It is returned now, and WHO it is returned to is the
// whole of the security in this feature:
//
//   owner   → yes. It is their event, and they always had a way in anyway (their login), so the
//             code is a convenience they are entitled to hand on.
//   code    → yes, trivially. They authenticated WITH it.
//   cohost  → NO. A co-host already manages by identity and does not need it, and this key would
//             OUTLIVE their removal: take somebody off the event and they would keep a working
//             key to it for ever. Withholding costs them nothing.
//
// This file fails if that middle rule is ever loosened.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const events = fs.readFileSync(path.join(__dirname, '..', 'routes', 'events.ts'), 'utf8');

describe('the admin code is returned to the owner, never to a co-host', () => {
  test('the admin payload gates it on how the caller authorised', () => {
    const at = events.indexOf('organizerCode: (req.organizerVia');
    assert.ok(at > -1,
      'the admin payload no longer gates `organizerCode` on `req.organizerVia`. If it is now sent '
      + 'unconditionally, a co-host receives a key that survives their own removal.');
    const line = events.slice(at, at + 220);
    assert.match(line, /'owner'/, 'the owner can no longer read their own admin code');
    assert.ok(!/'cohost'/.test(line),
      'a CO-HOST is now given the admin code. They manage by identity and do not need it, and the '
      + 'code outlives their removal — so this hands a removed co-host a permanent key.');
  });

  test('requireOrganizer still distinguishes the three ways in', () => {
    // The gate above is only meaningful while these stay distinct.
    for (const via of ["'owner'", "'cohost'", "'code'"]) {
      assert.ok(events.includes(`req.organizerVia = ${via}`),
        `requireOrganizer no longer sets organizerVia = ${via}, which the admin-code gate reads`);
    }
  });
});
