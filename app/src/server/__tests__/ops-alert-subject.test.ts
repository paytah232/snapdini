// The subject line of an operator alert is TEXT, and its heading is HTML.
//
// This is the third time the same mistake has been made in this codebase, and the first two are
// already pinned (release-hardening.test.ts, "nothing host-written reaches an email heading
// unescaped"). The shape of it never varies: htmlEmail() drops its first argument straight into an
// <h2>, so a caller pre-escapes the event name to keep the heading safe — and the same escaped
// string then goes out as the `Subject:` header, where nothing decodes it back. An event called
// "Priya & Tom" reached support@ as "Priya &amp;amp; Tom" (twice over: the `&` in `&amp;` escapes
// again on the second pass).
//
// inline-emails.ts states the rule at the top of the file — subject RAW, html ESCAPED, text RAW —
// and every customer-facing builder keeps it. The ops alerts did not, so the split now happens in
// the one private `mail()` function they all go through, which is what this file exercises.
//
// ASSERTED AT THE TRANSPORT, not by reading the source. Mailgun's transport IS its HTTP call, so
// the `to`/`subject`/`html` fields recorded below are literally what would have gone over the wire.
// An earlier generation of tests in this project compared string offsets in the source and proved
// only that a file was spelled a certain way.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Configured BEFORE ops-notify is loaded, because email.ts captures its transport choice at import
// and ops-notify captures email.ts. Same ordering constraint as suppression-chokepoint.test.ts, and
// the same reason its comment gives — hence require() rather than a hoisted import.
process.env.MAILGUN_API_KEY = 'key';
process.env.MAILGUN_DOMAIN = 'mg.test';
process.env.OPS_NOTIFICATIONS = '1';
process.env.SUPPORT_EMAIL = 'ops@example.com';

interface Wire { to: string; subject: string; html: string }
let wire: Wire[] = [];
globalThis.fetch = (async (_url: unknown, init: { body?: URLSearchParams }) => {
  const b = init?.body;
  wire.push({ to: String(b?.get('to') ?? ''), subject: String(b?.get('subject') ?? ''), html: String(b?.get('html') ?? '') });
  return { ok: true, json: async () => ({ id: '<mg-1@mg.test>' }) };
}) as unknown as typeof fetch;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ops = require('../ops-notify') as typeof import('../ops-notify');

/** The name that finds this bug, and the reason it is this one: an ampersand is the character that
 *  escapes to a longer string containing itself, so a double escape is visible rather than a
 *  coin-flip. `<` and `"` are in there because an event name is host-supplied, 80 characters,
 *  unstripped, and settable on a free signup. */
const NAME = 'Priya & Tom <3 "the one"';
const EV = { name: NAME, joinCode: 'ABCD1234' };

beforeEach(() => { wire = []; });

describe('an unhappy-survey alert', () => {
  test('puts the raw name in the Subject header and the escaped name in the heading', async () => {
    await ops.notifyUnhappySurvey(EV, {
      overall: 1, setup: null, guestExperience: null, value: null, nps: 2,
      comments: null, contactOptIn: false,
    });
    assert.equal(wire.length, 1, 'the alert did not reach the transport at all');
    const [m] = wire;
    assert.ok(m.subject.includes(NAME), `the Subject header is not the host's words:\n${m.subject}`);
    assert.doesNotMatch(m.subject, /&amp;|&lt;|&quot;/, `HTML entities went out in a Subject header:\n${m.subject}`);
    // …and the heading, which IS markup, is still escaped. Both halves, because fixing one by
    // breaking the other is the obvious wrong move and would otherwise pass.
    assert.match(m.html, /<h2[^>]*>[^<]*Priya &amp; Tom &lt;3 &quot;the one&quot;/,
      'the <h2> carries the name unescaped — an event name is host-supplied markup');
    assert.doesNotMatch(m.html, /&amp;amp;/, 'the heading is double-escaped');
  });
});

describe('a roll-takeover alert', () => {
  test('keeps the same split', async () => {
    await ops.notifyRiskyRecovery(EV, {
      email: 'guest@example.com', previousName: 'Jo & Sam', newName: 'Someone Else', photosTaken: 3,
    });
    assert.equal(wire.length, 1, 'the alert did not reach the transport at all');
    const [m] = wire;
    assert.ok(m.subject.includes(NAME), `the Subject header is not the host's words:\n${m.subject}`);
    assert.doesNotMatch(m.subject, /&amp;|&lt;|&quot;/, `HTML entities went out in a Subject header:\n${m.subject}`);
    assert.match(m.html, /Priya &amp; Tom/, 'the body carries the name unescaped');
    // The two names in the table were typed by whoever made the request — including, in the case
    // this alert exists for, the attacker.
    assert.match(m.html, /Jo &amp; Sam/, 'a name typed by the person being reported is unescaped in the body');
    // MASKED. An alert ABOUT an address is not a licence to write the address into an inbox.
    assert.doesNotMatch(m.html, /guest@example\.com/, 'the guest address went out unmasked');
  });
});

describe('and an ordinary name is untouched', () => {
  test('a name with nothing special in it reads identically in both places', () => {
    // A guard against "fix it by escaping nothing anywhere", and against the reverse. The split
    // lives at the boundary in mail(), not sprinkled through the callers, so the overwhelmingly
    // common case has to come out unchanged on BOTH sides.
    return ops.notifyUnhappySurvey({ name: 'Sam and Alex', joinCode: 'ZZZZ0000' }, {
      overall: 1, setup: null, guestExperience: null, value: null, nps: 2,
      comments: null, contactOptIn: false,
    }).then(() => {
      assert.equal(wire.length, 1);
      assert.ok(wire[0].subject.includes('Sam and Alex'), wire[0].subject);
      assert.doesNotMatch(wire[0].subject, /&\w+;/, wire[0].subject);
      assert.match(wire[0].html, /<h2[^>]*>[^<]*Sam and Alex/, wire[0].html.slice(0, 400));
    });
  });
});
