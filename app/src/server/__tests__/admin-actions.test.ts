// The operator's audit trail, and the one property it lives or dies by: WHO gets recorded.
//
// A log of everything would be a log of nothing. The host's own settings saves outnumber an
// operator's interventions by whatever ratio the business has customers, so a trail that collects
// them buries the single entry somebody goes looking for after a wedding goes wrong. Four of the
// tests below are therefore about work that must NOT be written down — the owner's, the co-host's,
// and the operator's on his own events — and they are the ones to fix first if this file ever goes
// red, because a false negative here is a missing audit entry and a false positive is a log nobody
// can read.
//
// The other two are the contract the feature rests on: a multi-field settings save records exactly
// the fields that moved (not the twenty the form re-sent unchanged), and a logging failure is
// swallowed whole — a customer's save must not 500 because our bookkeeping would not insert.
//
// WHAT IS REAL HERE. The route handlers, admin-actions.ts and auth.ts, all driven as themselves.
// Only the database is a stand-in, the same approach and for the same reason as
// photo-rotate-route.test.ts: the claims worth making are "a row was written / was not written"
// and "it carried these three fields and no others", and a live Postgres would let some of them
// pass for the wrong reason and would not run at all on a machine without one.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── A database that answers by table, and remembers what was written to it ───

const tableName = (t: unknown): string =>
  (t as Record<symbol, string>)?.[Symbol.for('drizzle:Name')] ?? 'unknown';

type Row = Record<string, unknown>;

/** Rows each table hands back, per test. */
let tables: Record<string, Row[]> = {};
/** Every table a SELECT touched — this is how the "costs nothing" claim about the owner path is
 *  actually checked rather than asserted in a comment. */
let read: string[] = [];
let inserted: { table: string; values: Row }[] = [];
let updated: { table: string; set: Row }[] = [];
/** Set to a table name to make its INSERT throw, for the failure-containment test. */
let breakInsertOn: string | null = null;

function reset(): void {
  tables = {
    // The two counts PUT /settings takes before it will consider a reschedule.
    participants: [{ n: 0 }],
    photos: [{ n: 0 }],
    sessions: [],
    users: [],
    event_cohosts: [],
    events: [],
  };
  read = []; inserted = []; updated = []; breakInsertOn = null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function chain<T>(produce: (c: any) => T): any {
  const o: any = {
    where() { return o; },
    set(v: Row) { o._set = v; return o; },
    values(v: Row) { o._values = v; return o; },
    returning() { return o; },
    limit() { return o; },
    orderBy() { return o; },
    groupBy() { return o; },
    innerJoin() { return o; },
    leftJoin() { return o; },
    onConflictDoNothing() { return o; },
    then(res: (v: T) => unknown, rej: (e: unknown) => unknown) {
      return Promise.resolve().then(() => produce(o)).then(res, rej);
    },
  };
  return o;
}

const fakeDb: any = {
  select() { return { from(t: unknown) { const n = tableName(t); read.push(n); return chain(() => tables[n] ?? []); } }; },
  selectDistinct() { return { from(t: unknown) { const n = tableName(t); read.push(n); return chain(() => tables[n] ?? []); } }; },
  update(t: unknown) { return chain((c) => { updated.push({ table: tableName(t), set: c._set }); return [{ id: 'updated' }]; }); },
  insert(t: unknown) {
    return chain((c) => {
      const n = tableName(t);
      if (breakInsertOn === n) throw new Error('relation "admin_actions" does not exist');
      inserted.push({ table: n, values: c._values });
      return [];
    });
  },
  delete(t: unknown) { return chain(() => { read.push(tableName(t)); return []; }); },
  transaction(cb: (tx: unknown) => unknown) { return Promise.resolve().then(() => cb(fakeDb)); },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// Swapped into the module cache BEFORE anything under test is loaded, so every `import { db }`
// downstream resolves to the stand-in. Nothing above this line may pull in ../db.
const dbPath = require.resolve('../db');
require(dbPath);                                     // builds a pool object; connects to nothing
require.cache[dbPath]!.exports = { db: fakeDb, schema: {}, pool: {} };

const eventsRoutes = require('../routes/events') as typeof import('../routes/events');
const adminRoutes = require('../routes/admin') as typeof import('../routes/admin');
const auth = require('../auth') as typeof import('../auth');
const { changedOnly } = require('../admin-actions') as typeof import('../admin-actions');
const { purgeAtFor } = require('../lib') as typeof import('../lib');

// ── The event an operator is about to interfere with ─────────────────────────
//
// Round numbers for the start and the length on purpose: PUT /settings recomputes expiresAt as
// `startsAt + (expiresAt - startsAt) / 3_600_000 * 3_600_000`, and a ragged pair comes back a
// millisecond out through the float — which would show up as a phantom "expiresAt changed" entry
// and make this file assert the wrong thing for a reason that has nothing to do with auditing.
const START = 1789000000000;
const SIX_HOURS = 6 * 60 * 60 * 1000;
const OWNER_ID = 'user-who-booked-the-wedding';
const ADMIN_ID = 'user-site-operator';

const theEvent = () => ({
  id: 'ev-1', joinCode: 'ABC123', organizerCode: 'org-code-not-a-real-secret',
  ownerUserId: OWNER_ID, name: 'Priya and Tom', blurb: null, slug: null,
  startsAt: START, expiresAt: START + SIX_HOURS, originalStartsAt: null,
  revealMode: 'manual', revealDelayHours: 0, revealAt: null, revealedAt: null, revealHidden: false,
  moderationEnabled: false, allowDownloads: true, noFlash: false,
  heartsEnabled: true, commentsEnabled: true,
  galleryHeartsEnabled: false, galleryCommentsEnabled: false,
  timezone: 'Australia/Brisbane', ratingMode: 'favourite',
  aspectRatios: '["1:1"]', maxPhotos: 20, guestCap: 50, videoSeconds: 0, retentionDays: 30,
  purgeAt: purgeAtFor(START + SIX_HOURS, 30), purgedAt: null,
  amountPaidCents: 5900, paid: true, isLocked: false,
  guestMayBuyShots: true, guestMayBuyVideo: true, guestMayBuyFrames: true, guestMayRequest: true,
  faceMatchingEnabled: false,
  guestDelivery: 'manual', guestSendScope: 'all', guestSendAt: null,
  guestMailThanks: false, guestMailReminder: false, guestMailLive: false,
  eventType: null, challenges: null, theme: null, posterConfig: null,
});

/** Sign somebody in for the duration of one request. */
function signIn(id: string, isAdmin: boolean): void {
  tables.sessions = [{ id: 'sid-1', userId: id, expiresAt: Date.now() + 60_000 }];
  tables.users = [{ id, email: 'ops@example.invalid', displayName: 'Site Admin', isAdmin }];
}

// ── Driving the handlers ─────────────────────────────────────────────────────

interface Reply { code: number; body: any }   // eslint-disable-line @typescript-eslint/no-explicit-any
function fakeRes(): { res: unknown; rec: Reply } {
  const rec: Reply = { code: 200, body: undefined };
  const res: Record<string, unknown> = {
    status(c: number) { rec.code = c; return res; },
    json(b: unknown) { rec.body = b; return res; },
    end() { return res; },
  };
  return { res, rec };
}

/** The LAST handler on a route — requireOrganizer is stepped over, because WHICH of its three
 *  doors the caller came through is exactly what these tests are varying, and it is handed in
 *  directly as `organizerVia`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function routeHandler(router: any, method: string, p: string): (req: any, res: any) => Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = router.stack.find((l: any) => l.route?.path === p && l.route?.methods?.[method]);
  assert.ok(layer, `no ${method.toUpperCase()} ${p} — the handler under test has moved`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

type Via = 'owner' | 'cohost' | 'code';
async function saveSettings(via: Via, body: Record<string, unknown>): Promise<Reply> {
  const { res, rec } = fakeRes();
  await routeHandler(eventsRoutes.default, 'put', '/:joinCode/settings')({
    params: { joinCode: 'ABC123' }, body, query: {},
    cookies: { sid: 'sid-1' }, get: () => undefined,
    event: theEvent(), organizerVia: via,
  }, res);
  return rec;
}

const logged = () => inserted.filter((i) => i.table === 'admin_actions').map((i) => i.values);

beforeEach(reset);

// ── Who gets recorded ────────────────────────────────────────────────────────

describe('only a site admin, and only on an event that is not theirs', () => {
  test('an admin working on somebody else\'s event IS recorded', async () => {
    signIn(ADMIN_ID, true);
    const rec = await saveSettings('code', { moderationEnabled: true });
    assert.equal(rec.code, 200);
    assert.equal(logged().length, 1, 'an operator changed a customer\'s event and nothing was written down');

    const row = logged()[0];
    assert.equal(row.action, 'event.settings');
    assert.equal(row.targetType, 'event');
    assert.equal(row.targetId, 'ev-1');
    // Denormalised, so the entry still reads correctly after the account or the event is gone.
    assert.equal(row.adminUserId, ADMIN_ID);
    assert.equal(row.adminEmail, 'ops@example.invalid');
    assert.equal(row.eventId, 'ev-1');
    assert.equal(row.eventName, 'Priya and Tom');
    assert.equal(row.eventJoinCode, 'ABC123');
  });

  test('the OWNER saving their own settings is NOT recorded — and costs nothing to ignore', async () => {
    // The important one. This is the routine work that would otherwise be the whole log.
    signIn(OWNER_ID, false);
    const rec = await saveSettings('owner', { moderationEnabled: true, name: 'Renamed' });
    assert.equal(rec.code, 200);
    assert.deepEqual(logged(), [], 'a host\'s own settings save was written to the operator audit log');
    // requireOrganizer has ALREADY established identity to get here, so the recorder must not go
    // back to the database to re-establish it. If this ever fails, every settings save in the
    // product just grew a session lookup and a co-host lookup for nothing.
    assert.ok(!read.includes('sessions'), 'the owner path resolved a session it did not need');
    assert.ok(!read.includes('event_cohosts'), 'the owner path ran a co-host check it did not need');
  });

  test('a CO-HOST saving settings is NOT recorded', async () => {
    signIn('user-maid-of-honour', false);
    await saveSettings('cohost', { allowDownloads: false });
    assert.deepEqual(logged(), [], 'a co-host manages by identity like the owner — their work is not interference');
  });

  test('an admin who OWNS the event is not audited on it, even coming in by organizer code', async () => {
    // The organizerVia short-circuit cannot answer this one: the caller used the code door, so the
    // gate never asked who they were. youManage() is what stops the operator's own events filling
    // his audit log — and it is the same check the photo routes rely on entirely, having no
    // :joinCode and therefore no requireOrganizer in front of them.
    signIn(OWNER_ID, true);
    await saveSettings('code', { moderationEnabled: true });
    assert.deepEqual(logged(), [], 'the operator\'s work on his OWN event was recorded as interference');
  });

  test('an admin who is an accepted CO-HOST is not audited either', async () => {
    signIn('user-site-operator-as-cohost', true);
    tables.event_cohosts = [{ id: 'cohost-row' }];      // youManage()'s second door
    await saveSettings('code', { moderationEnabled: true });
    assert.deepEqual(logged(), []);
  });

  test('a signed-out caller holding the organizer code is not recorded', async () => {
    // There is no one to name. An anonymous organizer-code holder is the host as far as this
    // product is concerned, and an audit entry with no actor is worse than no entry.
    signIn(ADMIN_ID, true);
    const { res } = fakeRes();
    await routeHandler(eventsRoutes.default, 'put', '/:joinCode/settings')({
      params: { joinCode: 'ABC123' }, body: { moderationEnabled: true }, query: {},
      cookies: {}, get: () => undefined, event: theEvent(), organizerVia: 'code',
    }, res);
    assert.deepEqual(logged(), []);
  });
});

// ── What gets recorded ───────────────────────────────────────────────────────

describe('before and after hold what changed, and nothing else', () => {
  test('a multi-field settings save records the three fields that moved', async () => {
    signIn(ADMIN_ID, true);
    await saveSettings('code', { name: 'Renamed by support', moderationEnabled: true, allowDownloads: false });

    const row = logged()[0];
    assert.ok(row, 'nothing recorded');
    assert.deepEqual(row.before, {
      name: 'Priya and Tom', moderationEnabled: false, allowDownloads: true,
    });
    assert.deepEqual(row.after, {
      name: 'Renamed by support', moderationEnabled: true, allowDownloads: false,
    });
  });

  test('the fields the form re-sent unchanged are absent', async () => {
    // The settings form PUTs every field on every save (web/src/lib/eventEdit.ts), so without the
    // diff this entry would claim twenty fields were changed from and to themselves — and an
    // operator reading it could not tell which one he had actually touched.
    signIn(ADMIN_ID, true);
    await saveSettings('code', { moderationEnabled: true, timezone: 'Australia/Brisbane', noFlash: false });
    const after = logged()[0].after as Record<string, unknown>;
    assert.deepEqual(Object.keys(after), ['moderationEnabled']);
  });

  test('a save that changes nothing writes no row at all', async () => {
    signIn(ADMIN_ID, true);
    const rec = await saveSettings('code', { moderationEnabled: false, allowDownloads: true });
    assert.equal(rec.code, 200);
    assert.deepEqual(logged(), [], 'an operator opening Settings and pressing Save wrote an audit entry');
  });

  test('changedOnly() keeps null and {} apart, because the column does', () => {
    // after: null is "the object stopped existing" — a delete, where `before` is the only surviving
    // copy. It is NOT the same as "nothing changed", which writes nothing.
    assert.deepEqual(changedOnly({ name: 'Gone' }, null), { before: { name: 'Gone' }, after: null });
    assert.equal(changedOnly({ a: 1 }, { a: 1 }), null);
    assert.equal(changedOnly(null, null), null);
    // Only the keys on the AFTER side are compared — which is what lets every settings call site
    // hand over the whole pre-save row without enumerating fields twice.
    assert.deepEqual(changedOnly({ a: 1, b: 2 }, { b: 3 }), { before: { b: 2 }, after: { b: 3 } });
    // A key the row did not have reads as null rather than vanishing, so the pair keeps its shape.
    assert.deepEqual(changedOnly({}, { b: 3 }), { before: { b: null }, after: { b: 3 } });
  });
});

// ── Failure containment ──────────────────────────────────────────────────────

describe('the log can fail; the customer\'s save cannot', () => {
  test('an INSERT that throws does not fail the request it was logging', async () => {
    signIn(ADMIN_ID, true);
    breakInsertOn = 'admin_actions';
    const rec = await saveSettings('code', { name: 'Renamed by support', moderationEnabled: true });
    // The whole contract of recordAdminAction, in three assertions: the caller was answered
    // normally, the answer says it worked, and the write it was reporting on really did happen.
    assert.equal(rec.code, 200);
    assert.equal(rec.body.success, true);
    assert.equal(rec.body.name, 'Renamed by support');
    const evUpdate = updated.find((u) => u.table === 'events');
    assert.ok(evUpdate, 'the settings UPDATE did not run');
    assert.equal(evUpdate!.set.moderationEnabled, true);
    assert.deepEqual(logged(), [], 'the insert was supposed to have thrown');
  });
});

// ── The read side ────────────────────────────────────────────────────────────

describe('GET /api/admin/actions is site-admin only', () => {
  const callAdminGate = async (user: Row | null): Promise<Reply> => {
    tables.sessions = user ? [{ id: 'sid-1', userId: user.id, expiresAt: Date.now() + 60_000 }] : [];
    tables.users = user ? [user] : [];
    const { res, rec } = fakeRes();
    await auth.requireAdmin(
      { cookies: user ? { sid: 'sid-1' } : {} } as never, res as never,
      (() => { rec.code = 200; rec.body = { passed: true }; }) as never,
    );
    return rec;
  };

  test('a signed-in NON-admin is refused', async () => {
    const rec = await callAdminGate({ id: 'user-a-paying-host', email: 'host@example.invalid', isAdmin: false });
    assert.equal(rec.code, 403);
    assert.equal(rec.body.error, 'Admins only');
  });

  test('a signed-out caller is refused', async () => {
    const rec = await callAdminGate(null);
    assert.equal(rec.code, 401);
  });

  test('an admin is let through', async () => {
    const rec = await callAdminGate({ id: ADMIN_ID, email: 'ops@example.invalid', isAdmin: true });
    assert.equal(rec.body.passed, true);
  });

  test('the route is mounted BEHIND that gate, not beside it', async () => {
    // The two assertions above only protect this endpoint while it is on the admin router. The
    // router applies requireAdmin with a bare `router.use(...)` before any route is declared, so
    // the protection is positional — and a route declared on a different router, or this one moved
    // above the use(), would be wide open with every auth test still green.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = (adminRoutes.default as any).stack as any[];   // eslint-disable-line @typescript-eslint/no-explicit-any
    const gateAt = stack.findIndex((l) => !l.route && l.handle?.name === 'requireAdmin');
    const routeAt = stack.findIndex((l) => l.route?.path === '/actions' && l.route?.methods?.get);
    assert.ok(gateAt > -1, 'the admin router no longer applies requireAdmin as global middleware');
    assert.ok(routeAt > -1, 'GET /actions is not on the admin router');
    assert.ok(gateAt < routeAt, 'GET /actions is declared BEFORE requireAdmin — it is unauthenticated');
  });
});
