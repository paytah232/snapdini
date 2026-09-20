// The webhook endpoint itself — the wiring between a verified Mailgun event and the two tables it
// is allowed to write.
//
// mailgun.test.ts proves the signature check, and delivery.test.ts proves the state machine. Both
// test a pure function. This file tests the thing in between, which is where the damage would
// actually happen: the handler decides WHICH send an event is about, whether to write at all, and
// whether an address loses its place on the mailing list. Every one of those is a question a
// correct verifier and a correct state machine can still be wired up wrongly to.
//
// The database is a stand-in that records what was asked of it, so each test can assert on the
// operation rather than on a row count. That is deliberate: "the address was suppressed" and "an
// UPDATE was issued against invite #2 and not invite #1" are the claims worth making, and a real
// database would let a test pass while writing to the wrong row for the right-looking reason.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normaliseEvent } from '../mailgun';

// An obviously fake key. Nothing in this repository ever carries a real one — the signing key is
// the single secret that stands between this endpoint and anyone on the internet.
const KEY = 'test-webhook-signing-key-not-a-real-one';

// ── A database that only remembers what it was told ──────────────────────────

interface InviteRow {
  id: string; eventId: string; email: string; token: string;
  status: string; provider: string | null; providerMessageId: string | null;
  reason: string | null; severity: string | null;
  sentAt: number; updatedAt: number; eventAt: number | null;
}
interface Op {
  kind: 'select' | 'update' | 'insert';
  table: string;
  where?: Array<{ column: string; value: unknown }>;
  set?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

let invites: InviteRow[] = [];
let ops: Op[] = [];
/** Set to make every database call throw, for the retry test. */
let dbBroken = false;

const updates = () => ops.filter((o) => o.kind === 'update');
const suppressions = () => ops.filter((o) => o.kind === 'insert' && o.table === 'email_suppressions');

/** Pull the (column, value) pairs back out of a Drizzle condition.
 *
 *  Drizzle builds `eq(col, x)` into a chunk list holding the Column object and a Param carrying the
 *  value, so walking it recovers exactly what the handler asked to match on. That is the point of
 *  going to this trouble rather than stubbing the query builder blind: the assertion "the lookup
 *  was by OUR token" is only meaningful if the test can see the token. */
function readCond(cond: unknown): Array<{ column: string; value: unknown }> {
  const cols: string[] = [];
  const vals: unknown[] = [];
  const walk = (n: any): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    // A column carries a name; a bound parameter carries a scalar value. The literal SQL fragments
    // between them carry an ARRAY as their value, which is the one thing that has to be excluded or
    // every condition reads as matching on ' = '.
    if (typeof n.name === 'string') cols.push(n.name);
    else if ('value' in n && !Array.isArray(n.value)) vals.push(n.value);
    if (Array.isArray(n.queryChunks)) n.queryChunks.forEach(walk);
  };
  walk(cond);
  return cols.map((column, i) => ({ column, value: vals[i] }));
}

const tableName = (t: any): string => t?.[Symbol.for('drizzle:Name')] ?? 'unknown';

/** Answer a select the way the real query would: match the recorded condition against the seeded
 *  rows. Only the two columns the handler ever looks up by are honoured, because a fake that
 *  quietly answered anything else would hide a handler that started asking for something else. */
function matchInvites(where: Array<{ column: string; value: unknown }>): InviteRow[] {
  return invites.filter((r) => where.every(({ column, value }) => {
    if (column === 'token') return r.token === value;
    if (column === 'provider_message_id') return r.providerMessageId === value;
    return false;
  }));
}

// Typed `any` throughout and deliberately so: this is a stand-in for a Drizzle query builder,
// whose chaining types exist to describe SQL we are not generating here.
function thenable<T>(produce: () => T): any {
  const o: any = {
    where(cond: unknown) { o._where = readCond(cond); return o; },
    set(v: Record<string, unknown>) { o._set = v; return o; },
    values(v: Record<string, unknown>) { o._values = v; return o; },
    onConflictDoNothing() { return o; },
    orderBy() { return o; },
    limit() { return o; },
    then(res: (v: T) => unknown, rej: (e: unknown) => unknown) {
      try {
        if (dbBroken) throw new Error('connection terminated unexpectedly');
        return Promise.resolve(produce()).then(res, rej);
      } catch (e) { return Promise.resolve().then(() => { throw e; }).then(res, rej); }
    },
  };
  return o;
}

const fakeDb = {
  select() {
    return {
      from(t: any) {
        const chain: any = thenable(() => {
          const op: Op = { kind: 'select', table: tableName(t), where: chain._where };
          ops.push(op);
          return matchInvites(chain._where || []);
        });
        return chain;
      },
    };
  },
  update(t: any) {
    const chain: any = thenable(() => {
      ops.push({ kind: 'update', table: tableName(t), where: chain._where, set: chain._set });
      return [];
    });
    return chain;
  },
  insert(t: any) {
    const chain: any = thenable(() => {
      ops.push({ kind: 'insert', table: tableName(t), values: chain._values });
      return [];
    });
    return chain;
  },
};

// Swapped into the module cache BEFORE routes/guests is first loaded, so its `import { db }`
// resolves to the stand-in. Same trick, and for the same reason, as suppression-chokepoint.test.ts:
// the rule under test is the handler's, and nothing is learned by also exercising Postgres — a unit
// suite that opens a socket is one that passes or fails on what else is running on the machine.
const dbPath = require.resolve('../db');
require(dbPath);                                     // constructs a pool object; connects to nothing
require.cache[dbPath]!.exports = { db: fakeDb, schema: {}, pool: {} };

const { mailgunWebhookHandler } = require('../routes/guests') as
  { mailgunWebhookHandler: (req: unknown, res: unknown) => Promise<unknown> };
const { _resetTokenCache, INVITE_VAR } = require('../mailgun') as
  { _resetTokenCache: () => void; INVITE_VAR: string };

// ── Building a request ───────────────────────────────────────────────────────

let tokenSeq = 0;
const nextToken = () => `tok-${++tokenSeq}-${'b'.repeat(40)}`;

/** Sign the way Mailgun does: HMAC-SHA256 hex over timestamp + token, with the real clock, because
 *  the handler reads the real clock and a fixed timestamp would eventually age out of the window. */
function signature(token: string, key = KEY) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { timestamp, token, signature: crypto.createHmac('sha256', key).update(timestamp + token).digest('hex') };
}

/** Just enough of an Express response to record what the handler answered. The status code is the
 *  assertion in half these tests: 404 / 406 / 500 / 200 each mean something different to Mailgun's
 *  retry ladder, and getting one of them wrong is invisible from the row data. */
interface Reply { code: number; body: any }
function fakeRes(): { res: unknown; rec: Reply } {
  const rec: Reply = { code: 200, body: undefined };
  const res: Record<string, unknown> = {
    status(c: number) { rec.code = c; return res; },
    json(b: unknown) { rec.body = b; return res; },
    end() { return res; },
  };
  return { res, rec };
}

/** One event, shaped the way Mailgun shapes it: fractional epoch SECONDS, the message id in the
 *  headers and wrapped in angle brackets, our token in `user-variables`. */
function eventData(over: Record<string, unknown> = {}, vars: Record<string, string> | null = null) {
  return {
    event: 'delivered',
    timestamp: Date.now() / 1000,
    id: 'mg-event-id',
    recipient: 'guest@example.com',
    message: { headers: { 'message-id': '<20260101.1234@mg.example.com>' } },
    'user-variables': vars === null ? {} : vars,
    ...over,
  };
}

async function post(body: unknown): Promise<Reply> {
  const { res, rec } = fakeRes();
  await mailgunWebhookHandler({ body }, res);
  return rec;
}

const invite = (over: Partial<InviteRow> = {}): InviteRow => ({
  id: 'inv-1', eventId: 'ev-1', email: 'guest@example.com', token: 'tok-seeded',
  status: 'sent', provider: 'mailgun', providerMessageId: null,
  reason: null, severity: null,
  sentAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000, eventAt: null,
  ...over,
});

beforeEach(() => {
  process.env.MAILGUN_WEBHOOK_SIGNING_KEY = KEY;
  invites = [];
  ops = [];
  dbBroken = false;
  _resetTokenCache();
});
afterEach(() => { delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY; });

// ── Failing closed ───────────────────────────────────────────────────────────

describe('the endpoint fails closed', () => {
  test('with no signing key configured it does not exist at all', async () => {
    // Not 403, and not "accept it anyway". Answering anything that admits to being a webhook
    // receiver advertises an unverifiable one to whoever is scanning, and accepting the event would
    // let a stranger write delivery state for any address they like.
    delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
    const token = nextToken();
    const r = await post({ signature: signature(token), 'event-data': eventData() });
    assert.equal(r.code, 404);
    assert.deepEqual(ops, [], 'nothing may be read or written without a key');
  });

  test('an event signed with somebody else’s key never reaches the database', async () => {
    // The forgery case, and the one the whole feature hangs on. A forged `failed` + `permanent`
    // would suppress a real guest's address deployment-wide, and no host would ever find out why
    // their invites stopped arriving.
    invites = [invite()];
    const token = nextToken();
    const r = await post({
      signature: signature(token, 'an-attackers-own-key'),
      'event-data': eventData({ event: 'failed', severity: 'permanent' }, { [INVITE_VAR]: 'tok-seeded' }),
    });
    assert.equal(r.code, 406);
    assert.deepEqual(ops, [], 'verification must happen before any query, not after');
  });

  test('a correctly signed event from last week is still refused', async () => {
    // Replay protection. A captured request stays perfectly signed forever — the signature says
    // nothing about when it was sent — so age is the only thing that can rule one out.
    const token = nextToken();
    const old = String(Math.floor((Date.now() - 8 * 86_400_000) / 1000));
    const r = await post({
      signature: { timestamp: old, token, signature: crypto.createHmac('sha256', KEY).update(old + token).digest('hex') },
      'event-data': eventData(),
    });
    assert.equal(r.code, 406);
    assert.deepEqual(ops, []);
  });

  test('a redelivered token is acknowledged, not reprocessed and not told off', async () => {
    // Mailgun retries for hours. The second arrival of a message we already handled is Mailgun
    // behaving correctly, so it gets a 2xx — a 406 here would keep it retrying — and it must not
    // apply anything a second time.
    invites = [invite()];
    const body = { signature: signature(nextToken()), 'event-data': eventData({}, { [INVITE_VAR]: 'tok-seeded' }) };
    const first = await post(body);
    assert.equal(first.code, 200);
    assert.equal(updates().length, 1);

    ops = [];
    const second = await post(body);
    assert.equal(second.code, 200);
    assert.equal(second.body.duplicate, true);
    assert.deepEqual(ops, [], 'a replayed token must not touch the database at all');
  });
});

// ── Finding the right send ───────────────────────────────────────────────────

describe('which send an event is about', () => {
  test('the join is by OUR token, never by the address', async () => {
    // The same person is on two hosts' guest lists, which is the ordinary case rather than an edge
    // one. Matching on the address would apply a bounce from one party to the other party's invite,
    // and the second host would see a delivery failure for a message that arrived perfectly.
    invites = [
      invite({ id: 'inv-jo', eventId: 'ev-jo', token: 'tok-jo' }),
      invite({ id: 'inv-sam', eventId: 'ev-sam', token: 'tok-sam' }),
    ];
    await post({
      signature: signature(nextToken()),
      'event-data': eventData({}, { [INVITE_VAR]: 'tok-sam' }),
    });
    const [u] = updates();
    assert.ok(u, 'the delivery should have been recorded');
    assert.deepEqual(u.where, [{ column: 'id', value: 'inv-sam' }]);
    assert.equal(u.set!.status, 'delivered');
  });

  test('an event that lost our variable falls back to the provider’s message id', async () => {
    // Mailgun truncates user-variables past 4KB, and an invite sent by an older build carries none
    // at all. The message id is the second key rather than a nicety: without it those sends could
    // never be resolved and would sit at "sent" forever.
    invites = [invite({ id: 'inv-old', token: 'tok-old', providerMessageId: '20260101.1234@mg.example.com' })];
    await post({ signature: signature(nextToken()), 'event-data': eventData() });
    const [u] = updates();
    assert.ok(u);
    assert.deepEqual(u.where, [{ column: 'id', value: 'inv-old' }]);
  });

  test('a delivered arriving after a bounce does not overwrite the bounce', async () => {
    // Out-of-order webhooks are routine, and applying whatever turned up last is wrong in the
    // direction that costs a domain its reputation: the host would see "delivered" on an address
    // that is permanently dead and go on mailing it.
    invites = [invite({ status: 'bounced', eventAt: Date.now() })];
    const r = await post({
      signature: signature(nextToken()),
      'event-data': eventData({}, { [INVITE_VAR]: 'tok-seeded' }),
    });
    assert.equal(r.code, 200);
    assert.deepEqual(updates(), [], 'nothing should have been written');
  });

  test('an event for a send we have no record of is still accepted', async () => {
    // A 5xx here would put Mailgun into an eight-hour retry ladder for an event we are never going
    // to be able to match — the row was purged with its event, most likely. There is nothing to
    // recover, so it is acknowledged.
    const r = await post({ signature: signature(nextToken()), 'event-data': eventData({}, { [INVITE_VAR]: 'gone' }) });
    assert.equal(r.code, 200);
    assert.deepEqual(updates(), []);
  });
});

// ── Suppression ──────────────────────────────────────────────────────────────

describe('what costs an address its place on the list', () => {
  test('a permanent failure suppresses the address', async () => {
    invites = [invite()];
    await post({
      signature: signature(nextToken()),
      'event-data': eventData(
        { event: 'failed', severity: 'permanent', 'delivery-status': { message: '550 5.1.1 no such user' } },
        { [INVITE_VAR]: 'tok-seeded' },
      ),
    });
    assert.equal(updates()[0].set!.status, 'bounced');
    const [s] = suppressions();
    assert.ok(s, 'a hard bounce must reach the suppression list');
    assert.equal(s.values!.email, 'guest@example.com');
    assert.equal(s.values!.reason, 'bounced');
    assert.equal(s.values!.detail, '550 5.1.1 no such user');
  });

  test('a TEMPORARY failure does not', async () => {
    // Both failure kinds arrive as `"event": "failed"`; only `severity` tells them apart. Suppressing
    // on the event name would strike off every guest whose mail server was busy for an hour, and
    // nothing would ever put them back.
    invites = [invite()];
    await post({
      signature: signature(nextToken()),
      'event-data': eventData({ event: 'failed', severity: 'temporary' }, { [INVITE_VAR]: 'tok-seeded' }),
    });
    assert.equal(updates()[0].set!.status, 'failed');
    assert.deepEqual(suppressions(), [], 'a busy mail server is not a dead mailbox');
  });

  test('a spam complaint suppresses, even though the mail was delivered', async () => {
    invites = [invite({ status: 'delivered', eventAt: Date.now() - 10_000 })];
    await post({
      signature: signature(nextToken()),
      'event-data': eventData({ event: 'complained' }, { [INVITE_VAR]: 'tok-seeded' }),
    });
    assert.equal(updates()[0].set!.status, 'complained');
    assert.equal(suppressions()[0].values!.reason, 'complained');
  });

  test('an unsubscribe suppresses', async () => {
    invites = [invite({ status: 'delivered', eventAt: Date.now() - 10_000 })];
    await post({
      signature: signature(nextToken()),
      'event-data': eventData({ event: 'unsubscribed' }, { [INVITE_VAR]: 'tok-seeded' }),
    });
    assert.equal(suppressions()[0].values!.reason, 'unsubscribed');
  });

  test('a bounce that matches no send suppresses the address anyway', async () => {
    // Deliberately not conditional on the row lookup. The address is dead whether or not we can
    // still say which message proved it, and refusing to record that would let exactly the
    // addresses we have lost track of go on being mailed.
    const r = await post({
      signature: signature(nextToken()),
      'event-data': eventData({ event: 'failed', severity: 'permanent', recipient: 'Gone@Example.COM' }, { [INVITE_VAR]: 'unknown' }),
    });
    assert.equal(r.code, 200);
    assert.deepEqual(updates(), []);
    // Lower-cased on the way in, because a suppressed `Mum@x.com` re-mailed as `mum@x.com` is the
    // precise failure suppression exists to prevent.
    assert.equal(suppressions()[0].values!.email, 'gone@example.com');
  });

  test('a delivery suppresses nothing', async () => {
    invites = [invite()];
    await post({ signature: signature(nextToken()), 'event-data': eventData({}, { [INVITE_VAR]: 'tok-seeded' }) });
    assert.deepEqual(suppressions(), []);
  });
});

// ── Retries and events we ignore ─────────────────────────────────────────────

describe('what happens when we cannot do the work', () => {
  test('a database failure answers 5xx and does NOT remember the token', async () => {
    // Mailgun's retry ladder is the recovery path for a transient fault, and it only works if the
    // retry is allowed through. Caching the token on the failed attempt would turn a ten-second
    // database hiccup into a bounce nobody ever learns about.
    invites = [invite()];
    const body = { signature: signature(nextToken()), 'event-data': eventData({}, { [INVITE_VAR]: 'tok-seeded' }) };

    dbBroken = true;
    const failed = await post(body);
    assert.equal(failed.code, 500);

    dbBroken = false;
    ops = [];
    const retry = await post(body);
    assert.equal(retry.code, 200);
    assert.notEqual(retry.body.duplicate, true, 'the retry must be processed, not dismissed as a duplicate');
    assert.equal(updates().length, 1, 'the event the outage lost should land on the retry');
  });

  test('an event we do not act on is acknowledged rather than retried forever', async () => {
    // `accepted` only means Mailgun took the message from us, which we already knew. There is
    // nothing to record, and a non-2xx would have Mailgun redelivering it for eight hours.
    const r = await post({ signature: signature(nextToken()), 'event-data': eventData({ event: 'accepted' }) });
    assert.equal(r.code, 200);
    assert.equal(r.body.ignored, 'accepted');
    assert.deepEqual(ops, []);
  });

  test('an unreadable body is acknowledged rather than retried forever', async () => {
    const r = await post({ signature: signature(nextToken()), 'event-data': 'not an object' });
    assert.equal(r.code, 200);
    assert.equal(r.body.ignored, 'unreadable');
    assert.deepEqual(ops, []);
  });
});

// ── Events that belong to a DIFFERENT deployment ────────────────────────────
//
// One Mailgun account can hold several sending domains, and they all post to the same configured
// webhook URL. So a bounce produced by a test send on the sandbox domain arrives at production,
// carrying a real person's address — and signature verification cannot catch it, because the event
// genuinely IS from Mailgun. It is just not about this deployment's mail.
//
// This is written from a real incident: on 2026-09-19 the email sampler sent 21 messages from devel
// over the sandbox domain, ten hard-bounced on Gmail's DMARC alignment check, and production applied
// the bounces and suppressed the operator's own address. Nothing was broken; every part did its job.
describe('a bounce from another sending domain', () => {
  const idOn = (domain: string) => `20260919041858.89aa263905e031a1@${domain}`;

  test('reads the sending domain off the message-id', () => {
    const ev = normaliseEvent({
      event: 'failed', severity: 'permanent', recipient: 'someone@example.com', timestamp: 1789793643.9,
      message: { headers: { 'message-id': idOn('sandbox126bbf401ba3431b84a66ab2f3ac52d3.mailgun.org') } },
    });
    assert.equal(ev?.sendingDomain, 'sandbox126bbf401ba3431b84a66ab2f3ac52d3.mailgun.org');
    assert.equal(ev?.status, 'bounced');   // it IS a hard bounce — just not ours to act on
  });

  test('takes everything after the LAST @, since a local part may contain one', () => {
    const ev = normaliseEvent({
      event: 'failed', severity: 'permanent', recipient: 'a@b.com', timestamp: 1789793643.9,
      message: { headers: { 'message-id': '2026.a@b@mg.snapdini.com' } },
    });
    assert.equal(ev?.sendingDomain, 'mg.snapdini.com');
  });

  test('reports no domain rather than a wrong one when the id has none', () => {
    // The guard fails OPEN on null, so a real bounce with an unreadable id still suppresses.
    const ev = normaliseEvent({
      event: 'failed', severity: 'permanent', recipient: 'a@b.com', timestamp: 1789793643.9,
      message: { headers: { 'message-id': 'no-at-sign-here' } },
    });
    assert.equal(ev?.sendingDomain, null);
  });

  test('the handler compares it against MAILGUN_DOMAIN and acknowledges rather than refuses', () => {
    // Acknowledged, because a 4xx would have Mailgun retrying an event that is perfectly correct
    // and simply addressed to a different deployment.
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'guests.ts'), 'utf8');
    const h = src.slice(src.indexOf('export async function mailgunWebhookHandler'));
    assert.match(h, /ev\.sendingDomain && ev\.sendingDomain !== ours/);
    assert.match(h, /ignored: 'other-domain'/);
    assert.match(h, /rememberToken\(token\)/);
    // Fails open: no domain on the event means it is still processed.
    assert.match(h, /const ours = \(process\.env\.MAILGUN_DOMAIN \|\| ''\)/);
  });
});
