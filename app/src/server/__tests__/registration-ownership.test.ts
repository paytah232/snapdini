// Real Express router and password/token/session logic; only database/mail boundaries are
// substituted. No environment files, deployed databases or outbound providers are used.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import express from 'express';
import cookieParser from 'cookie-parser';
import { PgDialect } from 'drizzle-orm/pg-core';
process.env.BASE_URL = 'https://test.example';
process.env.NODE_ENV = 'production';
type Row = Record<string, any>;
let tables: Record<string, Row[]>;
let sends: { to: string; kind: string; link: string }[];
let updates = 0;
const tableName = (t: unknown): string => (t as Record<symbol, string>)[Symbol.for('drizzle:Name')];
const dialect = new PgDialect();
function chain(produce: (c: any) => unknown): any {
  const c: any = {
    where(condition: any) { c.filter = dialect.sqlToQuery(condition); return c; },
    limit() { return c; }, orderBy() { return c; }, returning() { return c; },
    values(v: Row) { c.values_ = v; return c; }, set(v: Row) { c.set_ = v; return c; },
    then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) { return Promise.resolve().then(() => produce(c)).then(resolve, reject); },
  }; return c;
}
function rowsFor(name: string, c: any): Row[] {
  let rows = tables[name] ?? [];
  for (const m of (c.filter?.sql ?? '').matchAll(/"[a-z_]+"\."([a-z_]+)" = \$(\d+)/g)) {
    const key = m[1].replace(/_([a-z])/g, (_: string, x: string) => x.toUpperCase());
    rows = rows.filter(r => r[key] === c.filter.params[Number(m[2]) - 1]);
  } return rows;
}
const fakeDb = {
  select: () => ({ from: (t: unknown) => chain(c => rowsFor(tableName(t), c)) }),
  update: (t: unknown) => chain(c => { updates++; for (const row of rowsFor(tableName(t), c)) Object.assign(row, c.set_); return []; }),
  delete: () => chain(() => ({ rowCount: 0 })),
  insert: (t: unknown) => chain(c => { (tables[tableName(t)] ??= []).push(c.values_); return []; }),
};
function substitute(path: string, exports: unknown) {
  const filename = require.resolve(path); const replacement = new Module(filename);
  replacement.exports = exports; replacement.loaded = true; require.cache[filename] = replacement;
}
substitute('../db', { db: fakeDb, schema: {}, pool: {} });
substitute('../email', { sendAuthLink: async (args: typeof sends[number]) => { sends.push(args); return { delivered: true }; } });
const auth = require('../auth') as typeof import('../auth');
const router = (require('../routes/auth') as typeof import('../routes/auth')).default;
beforeEach(() => {
  sends = []; updates = 0;
  tables = { users: [{ id: 'owner-1', email: 'owner@example.invalid', displayName: 'Owner', passwordHash: null, emailVerifiedAt: Date.now() }], email_tokens: [], sessions: [] };
});
async function http(run: (request: (path: string, options?: RequestInit) => Promise<Response>) => Promise<void>) {
  const app = express(); app.use(express.json()); app.use(cookieParser()); app.use('/api/auth', router);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await run((path, options) => fetch(`http://127.0.0.1:${address.port}/api/auth${path}`, { redirect: 'manual', ...options })); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const registration = { email: 'owner@example.invalid', password: 'untrusted-password', displayName: 'Someone else' };
test('public registration cannot modify verified passwordless credentials or mint signup-poll/session capabilities', async () => {
  const original = structuredClone(tables.users[0]);
  await http(async request => {
    const response = await request('/register', post(registration));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'An account with that email already exists' });
    assert.deepEqual(tables.users[0], original); assert.equal(updates, 0);
    assert.deepEqual(tables.email_tokens, []); assert.deepEqual(tables.sessions, []); assert.equal(sends.length, 0);
    assert.equal(response.headers.getSetCookie().some(c => c.startsWith('sid=')), false);
    assert.equal((await request('/login', post(registration))).status, 401);
    assert.deepEqual(await (await request('/pending?token=unissued-token')).json(), { verified: false, expired: true });
    assert.deepEqual(tables.sessions, []);
  });
});
test('unverified passwordless accounts cannot be changed through registration', async () => {
  tables.users[0].emailVerifiedAt = null;
  await http(async request => {
    assert.equal((await request('/register', post(registration))).status, 409);
    assert.equal(tables.users[0].passwordHash, null); assert.equal(tables.users[0].emailVerifiedAt, null);
    assert.equal(updates, 0); assert.equal(sends.length, 0); assert.deepEqual(tables.email_tokens, []);
  });
});
test('existing password accounts retain the same registration conflict response', async () => {
  tables.users[0].passwordHash = await auth.hashPassword('original-password');
  const original = structuredClone(tables.users[0]);
  await http(async request => {
    assert.equal((await request('/register', post(registration))).status, 409);
    assert.deepEqual(tables.users[0], original); assert.equal(updates, 0); assert.deepEqual(tables.email_tokens, []);
  });
});
test('new registration preserves hashing, inbox verification and one-use pending handoff', async () => {
  tables.users = [];
  await http(async request => {
    const response = await request('/register', post({ ...registration, email: 'new@example.invalid' }));
    assert.equal(response.status, 201); const data = await response.json() as { pendingToken: string };
    assert.ok(data.pendingToken); assert.equal(sends.length, 1); assert.equal(tables.users.length, 1);
    assert.equal(await auth.verifyPassword(tables.users[0].passwordHash, registration.password), true);
    assert.equal(Boolean(tables.users[0].emailVerifiedAt), false);
    assert.deepEqual(tables.email_tokens.map(t => t.purpose), ['verify', 'signup_poll']);
    assert.deepEqual(await (await request(`/pending?token=${data.pendingToken}`)).json(), { verified: false });
    assert.deepEqual(tables.sessions, []);
    const verify = await request(new URL(sends[0].link).pathname.replace('/api/auth', '') + new URL(sends[0].link).search);
    assert.equal(verify.status, 302); assert.equal(tables.sessions.length, 1);
    const completed = await request(`/pending?token=${data.pendingToken}`);
    assert.equal((await completed.json() as { verified: boolean }).verified, true); assert.equal(tables.sessions.length, 2);
    assert.ok(completed.headers.getSetCookie().some(c => c.startsWith('sid=')));
    assert.deepEqual(await (await request(`/pending?token=${data.pendingToken}`)).json(), { verified: false, expired: true });
    assert.equal(tables.sessions.length, 2);
  });
});
test('passwordless owners can request a magic link but receive a session only after inbox proof', async () => {
  await http(async request => {
    assert.equal((await request('/magic-link', post({ email: 'owner@example.invalid' }))).status, 200);
    assert.equal(sends.length, 1); assert.equal(tables.users[0].passwordHash, null); assert.deepEqual(tables.sessions, []);
    assert.deepEqual(tables.email_tokens.map(t => t.purpose), ['magic_login']);
    assert.equal((await request('/magic?token=unissued-token')).status, 400); assert.deepEqual(tables.sessions, []);
    assert.equal((await request('/magic-link', post({ email: 'owner@example.invalid' }))).status, 429); assert.equal(sends.length, 1);
    const link = new URL(sends[0].link);
    const proof = await request(link.pathname.replace('/api/auth', '') + link.search);
    assert.equal(proof.status, 302); assert.equal(tables.sessions.length, 1);
    assert.ok(proof.headers.getSetCookie().some(c => c.startsWith('sid=')));
    assert.equal(tables.users[0].passwordHash, null);
    assert.equal((await request(link.pathname.replace('/api/auth', '') + link.search)).status, 400);
    assert.equal(tables.sessions.length, 1);
  });
});
