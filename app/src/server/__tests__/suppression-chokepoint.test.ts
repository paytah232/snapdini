// Suppression lives in ONE place — sendMail — and this is the test that keeps it there.
//
// It used to live in a single route, so a guest who chose "never email me from Snapdini again"
// carried on receiving the gallery link, the thank-you, the release reminder and every lifecycle
// message. The unsubscribe worked perfectly; it simply did not reach anything. The risk now is the
// reverse — that a future send quietly opts itself out.
//
// So the contract is exercised rather than read. Each test below stubs the TRANSPORT — Mailgun at
// its HTTP call, SMTP at its nodemailer transport — hands sendMail an address, and asks the only
// question that matters: did anything leave the building? An earlier version of this file compared
// the character offsets of two string literals in email.ts, which proved that the file was spelled
// a certain way and nothing about what it does.
//
// What is NOT stubbed is the rule itself: blocksFor keeps the real mergeBlocks and has only the
// database taken out from under it, so a change to what a suppression row MEANS still lands here.
//
// Two checks at the bottom stay source-level, because no behaviour can reach them: a module that
// imports nodemailer directly never goes through sendMail at all, so there is no call to observe.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Located by walking up for the app directory, the same way compose-env.test.ts does and for the
// same reason its comment gives: this package's tsconfig sets module=commonjs, where import.meta is
// a hard typecheck error. tsx runs it regardless, which is exactly how the suite stayed green while
// `tsc` was red — the failure was invisible from the test run alone.
function findServer(): string {
  let d = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(d, 'src', 'server', 'email.ts'))) return join(d, 'src', 'server');
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  const app = join(process.cwd(), 'app', 'src', 'server');
  if (existsSync(join(app, 'email.ts'))) return app;
  throw new Error('could not locate src/server from ' + process.cwd());
}
const SERVER = findServer();
const read = (p: string) => readFileSync(join(SERVER, p), 'utf8');

// ── The suppression list, with the database taken out ────────────────────────

interface SuppressionRow { email: string; reason: string; detail: string | null; createdAt: number }
interface EventOptOutRow { eventId: string; email: string; createdAt: number }

let globalRows: SuppressionRow[] = [];
let eventRows: EventOptOutRow[] = [];
let listUnreadable = false;
/** Every (eventId, addresses) sendMail asked about. Empty means it never asked. */
let asked: Array<{ eventId: string; addresses: string[] }> = [];

const norm = (s: string) => s.trim().toLowerCase();

// Swapped into the module cache BEFORE email.ts is first loaded, so email.ts's own
// `import { blocksFor }` resolves to this. mergeBlocks is the real one.
const unsubPath = require.resolve('../unsubscribe');
const realUnsub = require(unsubPath);
require.cache[unsubPath]!.exports = Object.assign(Object.create(null), realUnsub, {
  blocksFor: async (eventId: string, addresses: readonly string[]) => {
    asked.push({ eventId, addresses: [...addresses] });
    // A read that FAILS throws rather than answering "nobody is suppressed" — see blocksFor's own
    // comment. That distinction is a test below, so the stand-in has to be able to fail too.
    if (listUnreadable) throw new Error('suppression list unreadable');
    const want = new Set(addresses.map(norm));
    return realUnsub.mergeBlocks(
      globalRows.filter((r) => want.has(norm(r.email))),
      eventRows.filter((r) => r.eventId === eventId && want.has(norm(r.email))),
    );
  },
});

// ── The two transports, stubbed at their own boundaries ──────────────────────

interface Sent { to: string; via: 'mailgun' | 'smtp' }
let sent: Sent[] = [];

// SMTP first, with Mailgun unset, so email.ts picks the nodemailer path; then Mailgun, which it
// prefers when both are configured. Each module instance captures its transport choice at import,
// which is why there have to be two of them.
const emailPath = require.resolve('../email');
for (const k of ['MAILGUN_API_KEY', 'MAILGUN_DOMAIN']) delete process.env[k];
process.env.SMTP_HOST = 'smtp.test';
process.env.SMTP_USER = 'user';
process.env.SMTP_PASS = 'pass';
// nodemailer 10 is a dual CJS/ESM build: its CommonJS entry sets __esModule and exposes a SEPARATE
// `default` object, so email.ts's `import nodemailer from 'nodemailer'` now resolves to
// module.exports.default rather than module.exports itself, which is what v6 handed back. Patching
// only one of them leaves the real transport in place and the test dials smtp.test for real.
const smtpStub = () => ({
  sendMail: async ({ to }: { to: string }) => { sent.push({ to, via: 'smtp' }); return { messageId: '<smtp-1>' }; },
});
const nodemailerMod = require('nodemailer');
nodemailerMod.createTransport = smtpStub;
if (nodemailerMod.default) nodemailerMod.default.createTransport = smtpStub;
delete require.cache[emailPath];
const smtpEmail = require('../email');

process.env.MAILGUN_API_KEY = 'key';
process.env.MAILGUN_DOMAIN = 'mg.test';
delete require.cache[emailPath];
const mailgunEmail = require('../email');

// Mailgun's transport IS the HTTP call, so this is where "nothing was sent" is observable.
globalThis.fetch = (async (url: unknown, init: { body?: URLSearchParams }) => {
  sent.push({ to: String(init?.body?.get('to') ?? url), via: 'mailgun' });
  return { ok: true, json: async () => ({ id: '<mg-1@mg.test>' }) };
}) as unknown as typeof fetch;

interface Mail { to: string; subject: string; html: string; eventId?: string; always?: boolean }
interface SendResult { provider: string; messageId: string | null; suppressed?: true }
const TRANSPORTS: Array<[string, (m: Mail) => Promise<SendResult>]> = [
  ['mailgun', (m) => mailgunEmail.sendMail(m)],
  ['smtp', (m) => smtpEmail.sendMail(m)],
];
const mail = (over: Partial<Mail> = {}): Mail =>
  ({ to: 'guest@example.com', subject: 'Your photos', html: '<p>hi</p>', ...over });

beforeEach(() => {
  globalRows = [];
  eventRows = [];
  listUnreadable = false;
  asked = [];
  sent = [];
});

// ── What a suppressed address actually gets ──────────────────────────────────

for (const [name, sendMail] of TRANSPORTS) {
  describe(`over ${name}`, () => {
    test('an address that asked us to stop reaches the transport not at all', async () => {
      globalRows = [{ email: 'gone@example.com', reason: 'unsubscribed', detail: null, createdAt: 1 }];
      const r = await sendMail(mail({ to: 'gone@example.com' }));
      assert.deepEqual(sent, [], `the ${name} transport was handed a suppressed address`);
      assert.equal(r.suppressed, true, 'the caller was not told the send was refused');
      assert.equal(r.messageId, null, 'a refused send must not claim a provider id');
    });

    test('and an address that did not, does — which is what makes that mean something', async () => {
      const r = await sendMail(mail({ to: 'guest@example.com' }));
      assert.equal(sent.length, 1, `nothing reached the ${name} transport even unsuppressed`);
      assert.equal(r.suppressed, undefined, 'a delivered send must not be reported as suppressed');
      assert.ok(r.messageId, 'a delivered send must carry the provider id back');
    });

    test('suppression answers, it does not throw', async () => {
      // Callers stamp one-shot guards and write ledger rows around these calls. An exception would
      // leave a claim un-made and the sweep would retry the same suppressed address every tick.
      globalRows = [{ email: 'gone@example.com', reason: 'complained', detail: null, createdAt: 1 }];
      const r = await sendMail(mail({ to: 'gone@example.com' }));
      assert.equal(r.suppressed, true);
      assert.equal(r.provider, name, 'the result must still say which transport would have carried it');
    });
  });
}

describe('how far an opt-out reaches', () => {
  const send = (over: Partial<Mail> = {}) => mailgunEmail.sendMail(mail(over)) as Promise<SendResult>;

  test('"stop emails about this event" stops exactly that event', async () => {
    eventRows = [{ eventId: 'ev-wedding', email: 'jo@example.com', createdAt: 1 }];
    assert.equal((await send({ to: 'jo@example.com', eventId: 'ev-wedding' })).suppressed, true);
    assert.deepEqual(sent, [], 'the wedding mail went out anyway');
    assert.equal((await send({ to: 'jo@example.com', eventId: 'ev-birthday' })).suppressed, undefined,
      'someone who said stop about one event was cut off from another');
    assert.equal(sent.length, 1);
  });

  test('a send that forgets its event still honours "never again"', async () => {
    // blocksFor('') consults the GLOBAL list only. That is a narrowing, not a bypass: the global
    // stop still lands, and the event-scoped one is what a missing eventId loses.
    globalRows = [{ email: 'jo@example.com', reason: 'unsubscribed', detail: null, createdAt: 1 }];
    eventRows = [{ eventId: 'ev-wedding', email: 'kim@example.com', createdAt: 1 }];
    assert.equal((await send({ to: 'jo@example.com' })).suppressed, true, 'the global stop was lost with the eventId');
    assert.equal((await send({ to: 'kim@example.com' })).suppressed, undefined);
    assert.deepEqual(asked.map((a) => a.eventId), ['', ''], 'a missing eventId must not become a real one');
  });

  test('the address is matched however either side typed it', async () => {
    globalRows = [{ email: '  Jo@Example.COM ', reason: 'bounced', detail: null, createdAt: 1 }];
    assert.equal((await send({ to: 'JO@example.com ' })).suppressed, true,
      'a capital letter was enough to get past the suppression list');
    assert.deepEqual(sent, []);
  });

  test('the event the caller named is the event that is asked about', async () => {
    await send({ to: 'jo@example.com', eventId: 'ev-wedding' });
    assert.deepEqual(asked, [{ eventId: 'ev-wedding', addresses: ['jo@example.com'] }]);
  });
});

describe('the two ways past it', () => {
  const send = (over: Partial<Mail> = {}) => mailgunEmail.sendMail(mail(over)) as Promise<SendResult>;

  test('always:true is the only one, and it does not even ask', async () => {
    globalRows = [{ email: 'gone@example.com', reason: 'unsubscribed', detail: null, createdAt: 1 }];
    const r = await send({ to: 'gone@example.com', always: true });
    assert.equal(r.suppressed, undefined);
    assert.equal(sent.length, 1, 'a sign-in link was withheld from someone who just asked for it');
    assert.deepEqual(asked, [], 'always:true still consulted the list — a cost with no decision behind it');
  });

  test('a suppression list we cannot read refuses the send rather than allowing it', async () => {
    // The other way past would be a failed read treated as "nobody is suppressed". A refused send
    // is recoverable; mailing an address that asked us to stop is not.
    listUnreadable = true;
    await assert.rejects(() => send({ to: 'gone@example.com' }), /suppression list unreadable/);
    assert.deepEqual(sent, [], 'an unreadable suppression list was taken as permission to send');
  });
});

// ── The two things behaviour cannot reach ────────────────────────────────────

test('sendMail is the only thing that talks to a transport', () => {
  // A module that reaches for nodemailer or the Mailgun API directly never enters sendMail, so
  // there is no call to observe and no amount of care at the call sites would help. The only way
  // to see it is to look.
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

test('only the three defensible senders opt out', () => {
  // always:true is the dangerous flag. Every use must be a message where NOT sending is the greater
  // harm — a sign-in link, or something addressed to our own support inbox. Counted across the tree
  // because a new one is invisible at any single call site.
  const expected = new Set(['email.ts', 'ops-notify.ts', 'routes/contact.ts']);
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(join(SERVER, dir), { withFileTypes: true })) {
      const rel = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'drizzle') walk(rel); continue; }
      if (!e.name.endsWith('.ts')) continue;
      // Whitespace-tolerant: `always:true` and `always : true` are the same opt-out.
      if (/\balways\s*:\s*true\b/.test(read(rel))) found.add(rel.replace(/^\.\//, ''));
    }
  };
  walk('.');
  assert.deepEqual(found, expected, `unexpected always:true — ${[...found].join(', ')}`);
});

/** Every `sendMail({ ... })` argument object in a file, brace-matched rather than regex-sliced so a
 *  template literal or a nested object inside one cannot truncate it. */
function sendMailCalls(src: string): string[] {
  const out: string[] = [];
  const needle = 'sendMail({';
  for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) {
    let depth = 0, j = i + needle.length - 1;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) break;
    }
    out.push(src.slice(i, j + 1));
  }
  return out;
}

test('the only send in the guest path that omits its event is the one to the host', () => {
  // The behaviour above proves a missing eventId narrows the check to the global list. This is the
  // census of who actually omits it — a property of the call sites, not of sendMail, and so not
  // something calling sendMail can observe.
  const calls = sendMailCalls(read('guest-delivery.ts'));
  assert.ok(calls.length > 0, 'no sendMail call found in guest-delivery.ts at all — has it moved?');
  const recipientOf = (s: string) => (s.match(/to:\s*([^,\n]+)/) ?? [, '(no to:)'])[1]!.trim();
  const withoutEvent = calls.filter((s) => !/\beventId\b/.test(s)).map(recipientOf);
  // Exactly one send in this file may omit it: the notice to the HOST about their own event, which
  // is not a guest email and has no per-event opt-out to honour. Listed by recipient rather than
  // counted, so a new guest send without an eventId names itself in the failure.
  assert.deepEqual(withoutEvent, ['owner.email'],
    `guest sends without an eventId: ${withoutEvent.join(', ')}`);
});
