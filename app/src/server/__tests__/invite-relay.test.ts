// The thing this product must never become: a mail relay anyone can use.
//
// ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
//
// POST /api/events/demo mints an event with no account, no payment and no identity of any kind,
// and RETURNS ITS ORGANIZER CODE to whoever asked. That code reaches every organizer route, and
// 1.5.0 adds one that puts caller-supplied text in caller-supplied inboxes from a domain carrying
// our SPF, DKIM and DMARC. So the whole chain was: one unauthenticated POST, import up to
// MAX_GUESTS_PER_EVENT addresses, press Send, and the subject line is `You're invited to ${name}` —
// eighty characters of the caller's choosing, signed by us. The only brake was a per-IP limiter,
// and a venue's guests already share one NAT address, so it cannot be tight.
//
// The tell was an asymmetry inside the product itself: a guest JOINING an event is gated on
// event.paid, and SENDING was gated on nothing but the organizer code.
//
// ── WHAT IS ASSERTED HERE ────────────────────────────────────────────────────
//
//   1. A demo event reaches NO TRANSPORT. The transport is injected into deliverInvite() for
//      exactly this reason: "nothing was sent" is observed here rather than traced by a reader.
//   2. A real send still reaches it, which is what makes (1) mean anything.
//   3. The discriminator for a demo is the honest one — the demo NAME with NO OWNER — and not any
//      of the ordinary settings a demo happens to have, every one of which a real host can pick.
//   4. The route reads an IDENTITY (owner or accepted co-host) before it sends, and an organizer
//      code alone is refused. Source-level, because the identity lives on the request object and
//      there is no behaviour to observe without an HTTP stack; the integration suite
//      (testsuite/specs/19-guest-invites.mjs) covers the wire.
//   5. The operator's allowance figure does not count a send that never happened.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deliverInvite } from '../routes/guests';
import { DEMO_NAME, isDemoEvent } from '../lib';
import type { Mail, SendResult } from '../email';

const SERVER = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(SERVER, p), 'utf8');
/** Source with comments stripped, so "does this code still do X" cannot be satisfied by a comment
 *  that SAYS it does. The same helper release-hardening.test.ts uses, for the same reason. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const MSG: Mail = { to: 'guest@example.com', subject: "You're invited to X", html: '<p>hi</p>', text: 'hi' };

// ── 1 + 2. Does anything leave the building? ─────────────────────────────────

describe('a demo event hands nothing to a transport', () => {
  test('the transport is not called — not suppressed, not black-holed, not called', async () => {
    const calls: Mail[] = [];
    const stub = async (m: Mail): Promise<SendResult> => {
      calls.push(m);
      return { provider: 'mailgun', messageId: 'should-not-exist' };
    };
    const r = await deliverInvite(true, MSG, stub);
    assert.deepEqual(calls, [], 'a demo event reached the transport — this is the relay, reopened');
    assert.equal(r, null, 'a demo send must report "nothing was sent, deliberately", which is null');
  });

  test('and a real send does reach it, which is what makes the line above mean something', async () => {
    const calls: Mail[] = [];
    const stub = async (m: Mail): Promise<SendResult> => {
      calls.push(m);
      return { provider: 'mailgun', messageId: 'a@b' };
    };
    const r = await deliverInvite(false, MSG, stub);
    assert.equal(calls.length, 1, 'a real host’s invite did not reach the transport');
    assert.equal(calls[0].to, 'guest@example.com');
    assert.equal(r?.messageId, 'a@b', 'the caller was not handed the provider’s id');
  });

  test('a suppressed real send is still distinguishable from a demo', async () => {
    // Both are "nobody was mailed", and they must not collapse into one state: a suppression is
    // reported to the host by address and reason, and a demo is reported as a delivery.
    const r = await deliverInvite(false, MSG, async () => ({ provider: 'mailgun', messageId: null, suppressed: true }));
    assert.notEqual(r, null, 'a suppressed send became indistinguishable from a demo');
    assert.equal(r?.suppressed, true);
  });

  test('the invite route has no way to the transport EXCEPT through deliverInvite', async () => {
    // A second `email.sendMail` in this file would send for a demo whatever deliverInvite does.
    const g = code('routes/guests.ts');
    const direct = [...g.matchAll(/email\.sendMail\s*\(/g)];
    assert.equal(direct.length, 0,
      'routes/guests.ts calls email.sendMail directly again — every send has to go through '
      + 'deliverInvite(), which is the only thing that knows a demo must not reach a transport');
    assert.match(g, /deliverInvite\(\s*demo\s*,/, 'the loop no longer asks deliverInvite about the demo');
  });
});

// ── 3. Which events are demos ────────────────────────────────────────────────

describe('what makes an event a demo', () => {
  const demo = { ownerUserId: null, name: DEMO_NAME };

  test('the demo name with no owner', () => {
    assert.equal(isDemoEvent(demo), true);
  });

  test('the name alone is not enough — anyone may call their event that', () => {
    assert.equal(isDemoEvent({ ownerUserId: 'u1', name: DEMO_NAME }), false);
  });

  test('and having no owner is not enough either', () => {
    assert.equal(isDemoEvent({ ownerUserId: null, name: 'Priya & Tom' }), false);
  });

  test('it is not keyed on any setting a real host can choose', () => {
    // guestCap === 2, a 4-hour duration, paid === true and maxPhotos === 12 are all things the demo
    // happens to have AND things an ordinary event can be created with. Keying on any of them would
    // hand a real host the demo's behaviour — which, now that the demo silently sends nothing, means
    // a real host's invitations vanishing with a green tick beside them.
    const src = code('lib.ts');
    const from = src.indexOf('export const isDemoEvent');
    const fn = src.slice(from, src.indexOf(';', from));
    assert.doesNotMatch(fn, /guestCap|videoSeconds|maxPhotos|expiresAt|\bpaid\b/,
      'the demo discriminator reads a setting a real host can also choose');
  });
});

// ── 4. Who may send ──────────────────────────────────────────────────────────

describe('an organizer code alone cannot mail arbitrary addresses', () => {
  const g = code('routes/guests.ts');
  const handler = g.slice(g.indexOf("router.post('/:joinCode/guests/invite'"));

  test('the send route refuses anything that is not an owner or an accepted co-host', () => {
    assert.match(handler.slice(0, 1600), /organizerVia !== 'owner' && req\.organizerVia !== 'cohost'/,
      'the identity gate is gone from the invite route');
    assert.match(handler.slice(0, 1600), /res\.status\(403\)/, 'the gate no longer refuses');
  });

  test('the demo is decided BEFORE the gate, so it is answered rather than refused', () => {
    // Order matters and is the whole of the owner's decision: a demo has no owner, so an
    // identity gate placed first would refuse it — and a red error on the one feature the demo is
    // demonstrating is a worse outcome than the abuse being guarded against.
    const demoAt = handler.indexOf('isDemoEvent(ev)');
    const gateAt = handler.indexOf("organizerVia !== 'owner'");
    assert.ok(demoAt > -1 && gateAt > -1, 'one of the two decisions is no longer in this handler');
    assert.ok(demoAt < gateAt, 'the identity gate now runs before the demo check, so a demo is refused');
  });

  test('requireOrganizer says which of its three doors was used', () => {
    // The gate above is only as good as this: if requireOrganizer stops setting organizerVia, every
    // request arrives as undefined and the gate refuses EVERYONE, including real hosts.
    const e = code('routes/events.ts');
    for (const via of ["'owner'", "'cohost'", "'code'"])
      assert.match(e, new RegExp(`req\\.organizerVia = ${via}`),
        `requireOrganizer no longer records the ${via} door`);
  });

  test('and the refusal tells a real host what to do about it', () => {
    // The person most likely to hit this is not an attacker, it is a host on their own manage link
    // in a browser they are signed out of.
    const h = read('routes/guests.ts');
    const msg = /error: 'Sending invitations needs the host account[^]*?needsAccount: true/.exec(h)?.[0] ?? '';
    assert.match(msg, /[Ss]ign in/, 'the refusal does not say what to do');
  });
});

// ── 5. The operator's numbers ────────────────────────────────────────────────

describe("a send that never happened does not move the operator's allowance figure", () => {
  test('the month-to-date invite count filters on `mailed`', () => {
    // Demo rolls are the MAJORITY of events on a live instance (routes/admin.ts says so, which is
    // why its listing defaults to "real"). Counting their fake sends would make the one number that
    // warns an operator before Mailgun's wall starts silently refusing mail cry wolf until it is
    // ignored.
    const b = code('email-budget.ts');
    const fn = b.slice(b.indexOf('async function countBetween'));
    assert.match(fn.slice(0, 900), /eq\(guestInvites\.mailed, true\)/,
      'countBetween counts invites that were never sent');
  });

  test('and the column exists in the schema and in a migration', () => {
    assert.match(code('schema.ts'), /mailed: boolean\('mailed'\)\.notNull\(\)\.default\(true\)/,
      'guest_invites.mailed is not in the schema');
    const sql = read('drizzle/0056_guest_invites_mailed.sql');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS mailed boolean NOT NULL DEFAULT true/,
      'the migration does not add the column, or is not idempotent');
  });

  test('nothing in a guest-list response exposes it', () => {
    // The caller must not be able to tell a demo's send from a real one. listPayload maps explicit
    // fields rather than spreading the row, so the check is that `mailed` is not among them.
    const g = code('routes/guests.ts');
    const payload = g.slice(g.indexOf('async function listPayload'), g.indexOf("router.get('/:joinCode/guests'"));
    assert.doesNotMatch(payload, /mailed/, 'the response leaks whether a send was real');
  });
});
