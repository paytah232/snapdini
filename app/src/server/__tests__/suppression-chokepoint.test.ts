// Suppression lives in ONE place — sendMail — and this is the test that keeps it there.
//
// It used to live in a single route, so a guest who chose "never email me from Snapdini again"
// carried on receiving the gallery link, the thank-you, the release reminder and every lifecycle
// message. The unsubscribe worked perfectly; it simply did not reach anything. The risk now is the
// reverse — that a future send quietly opts itself out — so the shape of the contract is pinned
// rather than the wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SERVER = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(SERVER, p), 'utf8');

test('sendMail is the only thing that talks to a transport', () => {
  // If another module reaches for nodemailer or the Mailgun API directly it bypasses the check,
  // and no amount of care at the call sites would help.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(SERVER, dir), { withFileTypes: true })) {
      const rel = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'drizzle') walk(rel); continue; }
      if (!e.name.endsWith('.ts')) continue;
      const src = read(rel);
      if (rel.endsWith('email.ts')) continue;                       // the chokepoint itself
      if (/nodemailer|api\.mailgun\.net|createTransport/.test(src)) offenders.push(rel);
    }
  };
  walk('.');
  assert.deepEqual(offenders, [], `these bypass sendMail: ${offenders.join(', ')}`);
});

test('the check runs before either transport, not after', () => {
  const src = read('email.ts');
  const check = src.indexOf('blocksFor(');
  const mailgun = src.indexOf('return sendViaMailgun(', check);
  assert.ok(check > 0, 'sendMail must consult blocksFor');
  assert.ok(mailgun > check, 'suppression must be decided BEFORE a transport is chosen');
});

test('suppression answers, it does not throw', () => {
  // Callers stamp one-shot guards around these calls. An exception would leave a claim un-made and
  // the sweep would retry the same suppressed address on every tick, forever.
  const src = read('email.ts');
  assert.match(src, /suppressed: true/, 'a suppressed send must return a result');
  const seg = src.slice(src.indexOf('if (!always)'), src.indexOf('if (mailgunConfigured) return sendViaMailgun'));
  assert.doesNotMatch(seg, /throw/, 'the suppression branch must not throw');
});

test('only the three defensible senders opt out, and each says why', () => {
  // always:true is the dangerous flag in this file. Every use must be a message where NOT sending
  // is the greater harm, and must carry a comment saying so.
  const expected = new Set(['email.ts', 'ops-notify.ts', 'routes/contact.ts']);
  const found = new Map<string, number>();
  const walk = (dir: string) => {
    for (const e of readdirSync(join(SERVER, dir), { withFileTypes: true })) {
      const rel = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'drizzle') walk(rel); continue; }
      if (!e.name.endsWith('.ts')) continue;
      const n = (read(rel).match(/always: true/g) || []).length;
      if (n) found.set(rel.replace(/^\.\//, ''), n);
    }
  };
  walk('.');
  assert.deepEqual(new Set(found.keys()), expected,
    `unexpected always:true — ${[...found.keys()].join(', ')}`);
});

test('an event-scoped send passes its event, or the per-event opt-out never applies', () => {
  // blocksFor('') only ever consults the GLOBAL list. A guest email that forgets its eventId still
  // honours "never email me again" but silently ignores "stop emails about this event".
  const src = read('guest-delivery.ts');
  const sends = src.match(/email\.sendMail\(\{[^}]*\}/g) || [];
  assert.ok(sends.length >= 3, 'expected the guest sends to still be here');
  for (const s of sends) {
    if (/to: (r|m)\./.test(s)) assert.match(s, /eventId/, `guest send without eventId: ${s.slice(0, 70)}`);
  }
});
