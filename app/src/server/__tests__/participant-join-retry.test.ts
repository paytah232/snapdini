// Actual join handler, with a database model that serializes the event row lock. A persisted
// join attempt is a bearer secret, but never an admission grant for a first-time join.
import { test, beforeEach, after } from 'node:test';
import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-explicit-any */
const eventId = '230bb21f-8667-46f4-99df-589d18e0cf00';
const attempt = 'a7'.repeat(32);
let event: any;
let guests: any[];
let lockTail: Promise<void> = Promise.resolve();
function params(n: any): any[] {
  if (typeof n === 'string') return [n]; // SQL template values need not be wrapped in Param
  if (!n || typeof n !== 'object') return [];
  if (Array.isArray(n)) return n.flatMap(params);
  if ('value' in n) return [n.value];
  return Array.isArray(n.queryChunks) ? n.queryChunks.flatMap(params) : [];
}
const nameOf = (t: any) => t[Symbol.for('drizzle:Name')];
function chain(run: (o: any) => any) {
  const o: any = {
    where(cond: any) { o.args = params(cond); return o; },
    limit() { return o; }, for() { o.lock = true; return o; },
    values(value: any) { o.value = value; return o; },
    set(value: any) { o.value = value; return o; },
    then(resolve: any, reject: any) { return Promise.resolve().then(() => run(o)).then(resolve, reject); },
  };
  return o;
}
function connection(acquire?: () => Promise<void>): any {
  const conn: any = {
    select(selection: any) { return { from(table: any) { return chain(async (o) => {
      if (o.lock) { assert.ok(acquire); await acquire!(); }
      if (nameOf(table) === 'events') {
        return [event.id, event.joinCode, event.slug].some((v) => v && o.args.includes(v))
          ? [{ ...event }] : [];
      }
      if (nameOf(table) === 'participants') {
        if (selection?.c) return [{ c: guests.length }];
        return guests.filter((g) => o.args.includes(g.id) || o.args.includes(g.sessionToken)
          || (g.email && o.args.some((v: unknown) => typeof v === 'string' && v.toLowerCase() === g.email.toLowerCase())));
      }
      return [];
    }); } }; },
    update() { return chain((o) => {
      for (const guest of guests) if (o.args.includes(guest.id)) Object.assign(guest, o.value);
      return [];
    }); },
    insert() { return chain((o) => {
      assert.ok(!guests.some((g) => g.id === o.value.id), 'duplicate participant primary key');
      guests.push({ extraPhotos: 0, ...o.value }); return [];
    }); },
    transaction(callback: any) { return callback(conn); },
  };
  return conn;
}
const fakeDb = {
  ...connection(),
  async transaction(callback: any) {
    let release: (() => void) | undefined;
    const tx = connection(async () => {
      const previous = lockTail;
      lockTail = new Promise<void>((done) => { release = done; });
      await previous;
    });
    try { return await callback(tx); } finally { release?.(); }
  },
};
const dbPath = require.resolve('../db');
require(dbPath);
require.cache[dbPath]!.exports = { db: fakeDb, schema: {}, pool: {} };
const billingPath = require.resolve('../billing');
const billing = require(billingPath);
require.cache[billingPath]!.exports = { ...billing, billingEnabled: true };
const routes = require('../routes/participants').default;
const app = express();
app.use(express.json());
app.use('/api/participants', routes);
let server: Server | undefined;
let base = '';
after(() => { server?.close(); });
async function join(body: Record<string, unknown> = {}) {
  if (!base) {
    server = app.listen(0); server.unref();
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const response = await fetch(`${base}/api/participants`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ joinCode: 'TRYAGAIN', name: 'Guest', joinAttempt: attempt, ...body }),
  });
  return { code: response.status, body: await response.json() as any };
}
beforeEach(() => {
  event = { id: eventId, joinCode: 'TRYAGAIN', name: 'Event', slug: 'retry-event',
    startsAt: Date.now() - 3600_000, expiresAt: Date.now() + 3600_000,
    isLocked: false, maxPhotos: 12, paid: true, guestCap: 1,
    challenges: null, posterConfig: null };
  guests = []; lockTail = Promise.resolve();
});

test('replaying a lost join response returns the same session without another seat or rename', async () => {
  const first = await join();
  assert.equal(first.code, 200);
  const replay = await join({ name: 'Changed name', joinCode: 'retry-event' });
  assert.equal(replay.code, 200);
  assert.equal(replay.body.sessionToken, first.body.sessionToken);
  assert.equal(replay.body.participant.id, first.body.participant.id);
  assert.equal(replay.body.participant.name, 'Guest');
  assert.equal(guests.length, 1);
});

test('concurrent duplicate joins at a cap of one receive one shared session', async () => {
  const replies = await Promise.all(Array.from({ length: 8 }, () => join()));
  assert.ok(replies.every((r) => r.code === 200), JSON.stringify(replies));
  assert.equal(new Set(replies.map((r) => r.body.sessionToken)).size, 1);
  assert.equal(guests.length, 1);
});

test('a new attempt still respects guest cap', async () => {
  await join();
  assert.equal((await join({ joinAttempt: 'b8'.repeat(32) })).code, 403);
  assert.equal(guests.length, 1);
});

test('first attempts cannot bypass lock, event window or paid entitlement', async () => {
  event.isLocked = true;
  assert.equal((await join()).code, 403);
  event.isLocked = false; event.startsAt = Date.now() + 3600_000;
  assert.equal((await join()).code, 403);
  event.startsAt = Date.now() - 7200_000; event.expiresAt = Date.now() - 3600_000;
  assert.equal((await join()).code, 410);
  event.expiresAt = Date.now() + 3600_000; event.paid = false;
  assert.equal((await join()).code, 402);
  assert.equal(guests.length, 0);
});

test('an admitted attempt can recover its session after event closes or locks', async () => {
  const first = await join();
  guests[0].photosTaken = 3;
  event.isLocked = true; event.expiresAt = Date.now() - 3600_000;
  const replay = await join();
  assert.equal(replay.code, 200);
  assert.equal(replay.body.sessionToken, first.body.sessionToken);
  assert.equal(replay.body.photosRemaining, 9);
});

test('bad nonces are rejected before creating a participant', async () => {
  for (const joinAttempt of [null, '', 'short', 'A7'.repeat(32), {}, 'a7'.repeat(33)])
    assert.equal((await join({ joinAttempt })).code, 400);
  assert.equal(guests.length, 0);
});

test('nonce reuse at another event cannot recover the first event session', async () => {
  const first = await join();
  event.id = '1ed8776c-449e-4fc5-b0cb-ab39088d4876';
  event.guestCap = 2;
  const second = await join();
  assert.equal(second.code, 200);
  assert.notEqual(second.body.participant.id, first.body.participant.id);
  assert.notEqual(second.body.sessionToken, first.body.sessionToken);
});

test('legacy joins without an attempt remain supported', async () => {
  assert.equal((await join({ joinAttempt: undefined })).code, 200);
  assert.equal(guests.length, 1);
});

test('an email recovery with a nonce retains its original roll and idempotent token across lost responses', async () => {
  const first = await join({ joinAttempt: undefined, email: 'returning@example.com' });
  assert.equal(first.code, 200);
  guests[0].photosTaken = 4;
  const recovered = await join({ email: 'returning@example.com' });
  assert.equal(recovered.code, 200);
  assert.equal(recovered.body.recovered, true);
  assert.equal(recovered.body.participant.id, first.body.participant.id);
  assert.notEqual(recovered.body.sessionToken, first.body.sessionToken);
  const replay = await join({ email: 'returning@example.com' });
  assert.equal(replay.code, 200);
  assert.equal(replay.body.sessionToken, recovered.body.sessionToken);
  assert.equal(replay.body.photosRemaining, 8);
  assert.equal(guests.length, 1);
});

test('a later email recovery rotates and revokes the prior nonce token', async () => {
  const first = await join({ email: 'rotate@example.com' });
  const next = await join({ joinAttempt: undefined, email: 'rotate@example.com' });
  assert.equal(next.code, 200);
  assert.notEqual(next.body.sessionToken, first.body.sessionToken);
  // Possession of the old nonce alone no longer reclaims this roll or retrieves its new token.
  const revoked = await join();
  assert.equal(revoked.code, 403);
  assert.equal(guests[0].sessionToken, next.body.sessionToken);
  assert.equal(guests.length, 1);
});
