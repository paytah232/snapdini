// The client-error console, and the two things it has to get right before anyone reads it again.
//
// WHAT WAS ACTUALLY WRONG. Fifty production reports were eleven problems. Twelve consecutive rows
// were one camera permission failure repeated verbatim, eight more were the next one, and the six
// upload failures that may have cost a guest their photos sat below them where nobody scrolled.
// Nothing threw, nothing was logged, and no test could have gone red: the failure was that the
// screen stopped being worth opening. So the claims here are about SHAPE —
//
//   1. what counts as "the same error", which is the entire grouping decision and the only part
//      of it that is a judgement rather than a GROUP BY. It lives in fingerprintOf() precisely so
//      it can be pinned against the real production strings, which is what the first block does.
//   2. that resolving a group resolves the GROUP. The old button toggled one row by id, so
//      clearing twelve identical reports was twelve presses — and the mixed case (resolved last
//      week, recurred this morning) has no single value to negate, which is why the handler takes
//      an explicit target and why that is tested rather than assumed.
//
// WHAT IS REAL HERE: the handlers, fingerprintOf, and assembleErrorGroups, all driven as
// themselves. Only the database is a stand-in — the same approach and for the same reason as
// photo-rotate-route.test.ts: the claims worth making are "this UPDATE was scoped to the
// fingerprint and not to the id" and "the session token is nowhere in the inserted row", and a
// live Postgres would let both pass for the wrong reason and would not run at all on a machine
// without one.
//
// The aggregate SQL itself is exercised against a real Postgres by hand, not here; what IS
// asserted about it below is the one property a reader cannot check by reading it — that the
// NULL-fingerprint guard is present in every place that groups, because GROUP BY collapses NULLs
// TOGETHER and losing that guard would silently merge every unrelated error into one group.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── A database that answers the queries these two routes make ────────────────

type Row = Record<string, unknown>;

const tableName = (t: unknown): string =>
  (t as Record<symbol, string>)?.[Symbol.for('drizzle:Name')] ?? 'unknown';

/** Every raw statement, in order, with its bound values. The group-handled tests are entirely
 *  about which statement ran and what it was scoped to, so the log IS the assertion surface. */
let sqlLog: { sql: string; params: unknown[] }[] = [];
let summaryRows: Row[] = [];
let occurrenceRows: Row[] = [];
let openReports = 0;
/** What `SELECT fingerprint, handled FROM client_errors WHERE id = ?` finds — undefined for the
 *  404 case. */
let lookupRow: Row | undefined;
/** What the session-token exchange finds. Empty = no such session, which is the common case. */
let participantRows: Row[] = [];
let inserted: { table: string; values: Row }[] = [];

function reset(): void {
  sqlLog = []; summaryRows = []; occurrenceRows = []; openReports = 0;
  lookupRow = undefined; participantRows = []; inserted = [];
}

const allFn = async (sql: string, params: unknown[] = []): Promise<Row[]> => {
  sqlLog.push({ sql, params });
  if (/row_number\(\)/.test(sql)) return occurrenceRows;
  if (/GROUP BY/.test(sql)) return summaryRows;
  return [];
};
const getFn = async (sql: string, params: unknown[] = []): Promise<Row | undefined> => {
  sqlLog.push({ sql, params });
  if (/WHERE id = \?/.test(sql)) return lookupRow;
  if (/count\(\*\) FILTER/.test(sql)) return { n: openReports };
  return undefined;
};
const runFn = async (sql: string, params: unknown[] = []): Promise<Row> => {
  sqlLog.push({ sql, params });
  return { rowCount: 0 };
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function chain<T>(produce: (c: any) => T): any {
  const o: any = {
    where() { return o; },
    set(v: Row) { o._set = v; return o; },
    values(v: Row) { o._values = v; return o; },
    returning() { return o; },
    limit() { return o; },
    orderBy() { return o; },
    leftJoin() { return o; },
    innerJoin() { return o; },
    then(res: (v: T) => unknown, rej: (e: unknown) => unknown) {
      return Promise.resolve().then(() => produce(o)).then(res, rej);
    },
  };
  return o;
}

const fakeDb: any = {
  select() { return { from(t: unknown) { return chain(() => (tableName(t) === 'participants' ? participantRows : [])); } }; },
  insert(t: unknown) { return chain((c) => { inserted.push({ table: tableName(t), values: c._values }); return []; }); },
  update() { return chain(() => []); },
  delete() { return chain(() => []); },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// Swapped into the module cache BEFORE anything under test is loaded. Nothing above this line may
// pull in ../db.
const dbPath = require.resolve('../db');
require(dbPath);                                     // builds a pool object; connects to nothing
require.cache[dbPath]!.exports = {
  db: fakeDb, schema: {}, pool: {}, all: allFn, get: getFn, run: runFn,
};

const adminRoutes = require('../routes/admin') as typeof import('../routes/admin');
const clientErrorRoutes = require('../routes/clienterror') as typeof import('../routes/clienterror');
const { assembleErrorGroups } = adminRoutes;
const { fingerprintOf } = clientErrorRoutes;

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

/** The LAST handler on a route, so requireAdmin is stepped over — who may open this screen is
 *  auth.ts's business and is tested there. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function routeHandler(router: any, method: string, p: string): (req: any, res: any) => Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = router.stack.find((l: any) => l.route?.path === p && l.route?.methods?.[method]);
  assert.ok(layer, `no ${method.toUpperCase()} ${p} — the handler under test has moved`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

/** A request, with the header bag the capture endpoint reads. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeReq(over: Record<string, any> = {}, headers: Record<string, string> = {}): any {
  return {
    params: {}, query: {}, body: {},
    get: (name: string) => headers[name.toLowerCase()],
    ...over,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(router: any, method: string, p: string, req: any): Promise<Reply> {
  const { res, rec } = fakeRes();
  await routeHandler(router, method, p)(req, res);
  return rec;
}

beforeEach(reset);

// ── 1. What counts as the same error ─────────────────────────────────────────
//
// Every string below is one that actually arrived, or a variant of one — nothing invented, so a
// rule that looks clever and merges two real defects fails here rather than in the archive.

const PERM_DENIED = 'camera: NotAllowedError Permission denied';
const UA_REFUSED = 'camera: NotAllowedError The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission';

describe('fingerprintOf — which reports are one problem', () => {
  test('twelve identical reports collapse to one group', () => {
    const keys = new Set(Array.from({ length: 12 }, () => fingerprintOf('camera', PERM_DENIED)));
    assert.equal(keys.size, 1, 'twelve copies of one message must be one key');
  });

  test('distinct problems stay distinct', () => {
    // The four that mattered most in the real fifty: two camera failures and two upload failures.
    const keys = new Set([
      fingerprintOf('camera', PERM_DENIED),
      fingerprintOf('camera', UA_REFUSED),
      fingerprintOf('upload', 'Event has ended'),
      fingerprintOf('upload', 'Network error'),
    ]);
    assert.equal(keys.size, 4, 'four different defects must not share a key');
  });

  test('the same words from a different place are a different problem', () => {
    // `camera` and `camera-denied` are the same sentence and NOT the same event: one is a fault,
    // the other is a guest choosing not to grant a permission, and the second arrives already
    // handled. Merging them would drop a real failure into a group the operator never opens.
    assert.notEqual(fingerprintOf('camera', PERM_DENIED), fingerprintOf('camera-denied', PERM_DENIED));
  });

  test('a line break does not split a group in two', () => {
    // The browser supplies this text, and Chrome and Safari do not wrap it in the same place.
    assert.equal(
      fingerprintOf('camera', 'camera: NotAllowedError The request is not\n  allowed'),
      fingerprintOf('camera', 'camera: NotAllowedError The request is not allowed'),
    );
  });

  test('an id in the message does not give every report a group of its own', () => {
    assert.equal(
      fingerprintOf('upload', 'photo 4eb28f7a-df8d-4276-9c2f-4126cb17e415 failed'),
      fingerprintOf('upload', 'photo 9b1c0d22-aaaa-4276-9c2f-000000000000 failed'),
    );
  });

  test('nor does a byte count or a duration', () => {
    assert.equal(
      fingerprintOf('upload', 'aborted after 1048576 bytes'),
      fingerprintOf('upload', 'aborted after 2097152 bytes'),
    );
  });

  test('but a short number still tells two failures apart', () => {
    // Runs of three or more digits only. A two-digit number is a retry count or the tail of a
    // status line, where 502 and 500 are different failures — the reason the rule is not `\d+`.
    assert.notEqual(fingerprintOf('upload', 'refused (50)'), fingerprintOf('upload', 'refused (51)'));
  });

  test('two messages that differ only past 120 characters are one group', () => {
    // A consequence of the truncation rather than a separate rule, and the desirable one: the
    // variable tail of a long browser message ("...because the user denied permission to use the
    // device at <origin>") is not what distinguishes one defect from another.
    assert.equal(fingerprintOf('camera', `${UA_REFUSED} on a Pixel`), fingerprintOf('camera', UA_REFUSED));
  });

  test('a report with no context still gets a usable key', () => {
    // Null context is not an empty group name: it must not merge with a context literally called
    // the empty string, and it must not blow up.
    assert.equal(fingerprintOf(null, 'Load failed'), '-|Load failed');
  });
});

// ── 2. Hanging the reports off their problem ─────────────────────────────────

const summary = (key: string, over: Partial<Row> = {}): any => ({   // eslint-disable-line @typescript-eslint/no-explicit-any
  key, count: 1, open: 1, guests: 0, firstSeen: 1, lastSeen: 1, eventCodes: [], versions: [], ...over,
});
const occurrence = (key: string, id: string, at: number, over: Partial<Row> = {}): any => ({   // eslint-disable-line @typescript-eslint/no-explicit-any
  key, id, at, message: 'Event has ended', context: 'upload', eventCode: 'ABC', url: '/join/ABC',
  userAgent: null, stack: null, participantId: null, participantName: null, appVersion: '1.5.1',
  clientBuild: null, displayMode: 'browser', viewport: '390x844', connection: '4g', outcome: null,
  handled: false, ...over,
});

describe('assembleErrorGroups', () => {
  test('a group carries its own occurrences and nobody else’s', () => {
    const groups = assembleErrorGroups(
      [summary('upload|Event has ended', { count: 2, open: 2 }), summary('camera|denied')],
      [occurrence('upload|Event has ended', 'a', 30), occurrence('camera|denied', 'c', 20),
       occurrence('upload|Event has ended', 'b', 10)],
    );
    assert.deepEqual(groups.map((g) => g.occurrences.map((o) => o.id)), [['a', 'b'], ['c']]);
  });

  test('the newest report is the one whose detail is shown', () => {
    // `latest` drives the stack, the device and the wording the operator reads, so it must be the
    // most recent one — not whichever row the aggregate's max(id) happened to land on, which is
    // the reason the representative is chosen here instead of in SQL.
    const groups = assembleErrorGroups(
      [summary('k', { count: 2, open: 2 })],
      [occurrence('k', 'newest', 99, { stack: 'the one that matters' }), occurrence('k', 'older', 1)],
    );
    assert.equal(groups[0].latestId, 'newest');
    assert.equal(groups[0].latest.stack, 'the one that matters');
  });

  test('a group is handled only when nothing in it is still open', () => {
    const [mixed, done] = assembleErrorGroups(
      [summary('a', { count: 12, open: 1 }), summary('b', { count: 8, open: 0 })],
      [occurrence('a', 'a1', 2), occurrence('b', 'b1', 1, { handled: true })],
    );
    // The mixed case is a group that was resolved and has RECURRED. It must come back as open on
    // its own — that is the whole "is it still happening" signal, and it costs nothing.
    assert.equal(mixed.handled, false);
    assert.equal(done.handled, true);
  });

  test('the tallies come through untouched — they are the whole table, not the sample', () => {
    // The sample is capped at twenty; the count is not. A group whose count quietly became
    // "how many we fetched" would answer "is this getting worse" with a number that cannot grow.
    const [g] = assembleErrorGroups(
      [summary('k', { count: 590, open: 590, guests: 9, firstSeen: 5, lastSeen: 900 })],
      [occurrence('k', 'only', 900)],
    );
    assert.equal(g.count, 590);
    assert.equal(g.guests, 9);
    assert.equal(g.occurrences.length, 1);
  });

  test('a group whose reports vanished between the two queries is dropped, not rendered empty', () => {
    // Two statements, and a retention purge can commit between them. A group with no detail row
    // and no message reads as a rendering fault rather than as a race.
    assert.deepEqual(assembleErrorGroups([summary('gone')], []), []);
  });
});

// ── 3. The grouped read ──────────────────────────────────────────────────────

describe('GET /client-errors', () => {
  test('returns one entry per problem, with its reports attached', async () => {
    summaryRows = [summary('upload|Event has ended', { count: 6, open: 6, guests: 3 })];
    occurrenceRows = [occurrence('upload|Event has ended', 'x', 9)];
    openReports = 6;
    const rec = await call(adminRoutes.default, 'get', '/client-errors', fakeReq());
    assert.equal(rec.body.groups.length, 1);
    assert.equal(rec.body.groups[0].count, 6);
    assert.equal(rec.body.groups[0].occurrences.length, 1);
    // Both numbers, because "50 open" and "6 open" describe the same queue and only one of them
    // is a workload. The badge used to show the first.
    assert.equal(rec.body.open, 6);
    assert.equal(rec.body.openGroups, 1);
  });

  test('every statement that groups carries the NULL-fingerprint guard', async () => {
    summaryRows = [summary('k')];
    occurrenceRows = [occurrence('k', 'x', 1)];
    await call(adminRoutes.default, 'get', '/client-errors', fakeReq());
    const grouping = sqlLog.filter((q) => /GROUP BY|PARTITION BY/.test(q.sql));
    assert.ok(grouping.length >= 2, 'expected an aggregate and a windowed sample');
    for (const q of grouping) {
      // Without this, a row that somehow arrived with no fingerprint does not become its own
      // group — every such row joins ONE group together, which is a worse screen than no
      // grouping at all and would look exactly like a real cluster.
      assert.match(q.sql, /COALESCE\(\s*(?:ce\.)?fingerprint,\s*'id:'/,
        'a grouping statement lost the NULL guard');
    }
  });

  test('asks for the sample per problem, not for the newest rows overall', async () => {
    summaryRows = [summary('k')];
    occurrenceRows = [occurrence('k', 'x', 1)];
    await call(adminRoutes.default, 'get', '/client-errors', fakeReq());
    const sample = sqlLog.find((q) => /row_number\(\)/.test(q.sql));
    assert.ok(sample, 'no windowed sample query ran');
    // A flat "newest 300" would let one noisy group eat the whole budget and every other group
    // would then open on nothing.
    assert.match(sample.sql, /PARTITION BY/);
    assert.deepEqual(sample.params[1], ['k'], 'the sample must be scoped to the groups on screen');
  });

  test('a table with nothing in it does not go looking for occurrences', async () => {
    const rec = await call(adminRoutes.default, 'get', '/client-errors', fakeReq());
    assert.deepEqual(rec.body.groups, []);
    assert.equal(sqlLog.filter((q) => /row_number\(\)/.test(q.sql)).length, 0);
  });
});

// ── 4. Resolving a problem, rather than a row ────────────────────────────────

describe('POST /client-errors/:id/handled', () => {
  const updates = () => sqlLog.filter((q) => /^UPDATE/.test(q.sql.trim()));

  test('resolves the whole group, not the one report that was named', async () => {
    lookupRow = { fingerprint: 'camera|camera: NotAllowedError Permission denied', handled: false };
    const rec = await call(adminRoutes.default, 'post', '/client-errors/:id/handled',
      fakeReq({ params: { id: 'the-newest-of-twelve' }, body: { handled: true } }));
    assert.equal(rec.body.ok, true);
    assert.equal(updates().length, 1);
    const [u] = updates();
    // The defect this closes: twelve identical reports were twelve presses, because the UPDATE
    // was scoped to the id the console happened to be showing.
    assert.match(u.sql, /WHERE fingerprint = \?/);
    assert.ok(!/WHERE id = \?/.test(u.sql), 'the update must not be scoped to a single report');
    assert.deepEqual(u.params, [true, 'camera|camera: NotAllowedError Permission denied']);
  });

  test('does what the console says, rather than negating a mixed group', async () => {
    // Resolved last week, recurred this morning: the representative row is OPEN, so a plain
    // `NOT handled` would resolve the group — which happens to be right here and wrong the other
    // way round, when the newest report is one the operator has already cleared. There is no
    // single value to negate, so the caller sends the one it is showing.
    lookupRow = { fingerprint: 'k', handled: false };
    const rec = await call(adminRoutes.default, 'post', '/client-errors/:id/handled',
      fakeReq({ params: { id: 'r1' }, body: { handled: false } }));
    assert.equal(rec.body.handled, false);
    assert.deepEqual(updates()[0].params, [false, 'k']);
  });

  test('with no body at all it still toggles, for a caller that sends none', async () => {
    lookupRow = { fingerprint: 'k', handled: true };
    const rec = await call(adminRoutes.default, 'post', '/client-errors/:id/handled',
      fakeReq({ params: { id: 'r1' }, body: undefined }));
    assert.equal(rec.body.handled, false);
  });

  test('a report with no fingerprint is still resolvable, on its own', async () => {
    // Unreachable after the 0071 backfill. It is here because the alternative is
    // `WHERE fingerprint = NULL`, which matches nothing — a button that silently does nothing on
    // the only control this screen has.
    lookupRow = { fingerprint: null, handled: false };
    await call(adminRoutes.default, 'post', '/client-errors/:id/handled',
      fakeReq({ params: { id: 'lonely' }, body: { handled: true } }));
    assert.match(updates()[0].sql, /WHERE id = \?/);
    assert.deepEqual(updates()[0].params, [true, 'lonely']);
  });

  test('an id that is not there is a 404 and touches nothing', async () => {
    // The failure mode worth spending a test on: a handler that looked the row up, got nothing,
    // and carried on would run an UPDATE with a NULL fingerprint — which under `IS NOT DISTINCT
    // FROM` semantics or a careless rewrite is every un-fingerprinted row in the table.
    lookupRow = undefined;
    const rec = await call(adminRoutes.default, 'post', '/client-errors/:id/handled',
      fakeReq({ params: { id: 'never-existed' }, body: { handled: true } }));
    assert.equal(rec.code, 404);
    assert.deepEqual(updates(), []);
  });
});

// ── 5. What the capture endpoint keeps, and what it refuses to ───────────────

const SESSION_TOKEN = 'session-token-not-a-real-one';

describe('POST /api/client-error', () => {
  const stored = () => inserted[0].values;
  const post = (body: Row, headers: Record<string, string> = {}) =>
    call(clientErrorRoutes.default, 'post', '/', fakeReq({ body }, headers));

  test('the session token is exchanged for an id and never stored', async () => {
    participantRows = [{ id: 'participant-1' }];
    await post({ message: 'Event has ended', context: 'upload', eventCode: 'ABC' },
      { 'x-session-token': SESSION_TOKEN });
    assert.equal(stored().participantId, 'participant-1');
    // The point of the whole design: a bearer credential must not come to rest in a diagnostic
    // log a human reads. Checked over every value, not just the one field, so a later addition
    // that quietly echoes the header fails here.
    for (const [k, v] of Object.entries(stored())) {
      assert.ok(!String(v ?? '').includes(SESSION_TOKEN), `${k} carries the session token`);
    }
  });

  test('neither a name nor an email is copied onto the report', async () => {
    // Both are joinable from participants when the operator needs them, which means erasing a
    // guest erases them from this screen too. A copy here would outlive the guest.
    participantRows = [{ id: 'participant-1', name: 'Priya', email: 'priya@example.invalid' }];
    await post({ message: 'Load failed', context: 'upload' }, { 'x-session-token': SESSION_TOKEN });
    const values = JSON.stringify(stored());
    assert.ok(!values.includes('Priya'));
    assert.ok(!values.includes('example.invalid'));
  });

  test('a report from a page with no session is still recorded', async () => {
    await post({ message: 'Load failed', context: 'upload' });
    assert.equal(inserted.length, 1);
    assert.equal(stored().participantId, null);
  });

  test('a session that no longer exists costs the name, not the report', async () => {
    participantRows = [];
    await post({ message: 'Load failed' }, { 'x-session-token': 'stale' });
    assert.equal(inserted.length, 1);
    assert.equal(stored().participantId, null);
  });

  test('the client cannot choose its own fingerprint', async () => {
    // This endpoint is public and unauthenticated. A client that picked its own key could merge
    // its reports into somebody else's group, or split one defect into a thousand groups and push
    // every real problem off the screen — a denial of the only diagnostic view there is.
    await post({ message: 'Event has ended', context: 'upload', fingerprint: 'anything-i-like' });
    assert.equal(stored().fingerprint, fingerprintOf('upload', 'Event has ended'));
  });

  test('the recorded version is the one we deployed, not the one the client claims', async () => {
    await post({ message: 'x', build: '1789918862688', appVersion: '99.99.99' });
    assert.notEqual(stored().appVersion, '99.99.99');
    assert.match(String(stored().appVersion), /^\d+\.\d+\.\d+/);
    // The client's own build id IS kept, separately: when the two disagree the guest was running
    // a bundle we had already replaced.
    assert.equal(stored().clientBuild, '1789918862688');
  });

  test('a query string never reaches the row', async () => {
    // A custom join link carries a code in the path and an organizer link carries a credential in
    // the fragment. The reporter sends a pathname; this is the second lock on the same door.
    await post({ message: 'x', url: '/join/ABC?token=a-secret#org=another' });
    assert.equal(stored().url, '/join/ABC');
  });

  test('display mode is one of two words, or nothing at all', async () => {
    await post({ message: 'x', displayMode: 'standalone' });
    assert.equal(stored().displayMode, 'standalone');
    reset();
    await post({ message: 'x', displayMode: 'something a caller invented' });
    assert.equal(stored().displayMode, null, 'free text here would break the console filter');
    reset();
    await post({ message: 'x' });
    assert.equal(stored().displayMode, null, 'silence is not a guess of browser');
  });

  test('the stack is kept, and capped', async () => {
    await post({ message: 'x', stack: `at frame\n${'x'.repeat(9000)}` });
    assert.ok(String(stored().stack).startsWith('at frame'));
    assert.ok(String(stored().stack).length <= 4000, 'a runaway recursion must not post a megabyte');
  });

  test('an empty message is still refused, and writes nothing', async () => {
    const rec = await post({ message: '   ' });
    assert.equal(rec.code, 400);
    assert.deepEqual(inserted, []);
  });
});
