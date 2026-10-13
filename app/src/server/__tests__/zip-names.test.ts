// A zip downloads whatever the event and its guests are called.
//
// The name of an event goes into two places: the Content-Disposition header, where a byte outside
// ASCII is a TypeError from setHeader (every demo roll is named with an emoji, so every demo-roll
// zip answered 500 with a JSON body under a zip content type); and the entry names inside the
// archive, where a slash or a control character is a path. Guests' names go into the entries too.
// Both are pinned here with the real archiver and a real http.ServerResponse for the header, so
// "did the download happen" is answered by parsing the bytes that came out.
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdini-zip-names-'));
process.env.UPLOADS_DIR = TMP;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const tableName = (t: unknown): string =>
  (t as Record<symbol, string>)?.[Symbol.for('drizzle:Name')] ?? 'unknown';
interface Stored { id: string; filename: string; mediaType: string | null; captureShape: string | null }
let live = new Map<string, Stored>();
/* eslint-disable @typescript-eslint/no-explicit-any */
function chain<T>(produce: () => T): any {
  const o: any = {
    where() { return o; }, from() { return o; }, innerJoin() { return o; }, orderBy() { return o; }, limit() { return o; },
    then(res: (v: T) => unknown, rej: (e: unknown) => unknown) { return Promise.resolve().then(produce).then(res, rej); },
  };
  return o;
}
const fakeDb: any = { select() { return { from(t: unknown) { return chain(() => (tableName(t) === 'photos' ? [...live.values()] : [])); } }; } };
/* eslint-enable @typescript-eslint/no-explicit-any */
const dbPath = require.resolve('../db');
require(dbPath);
require.cache[dbPath]!.exports = { db: fakeDb, schema: {}, pool: {} };
const photosRoutes = require('../routes/photos') as typeof import('../routes/photos');
const { zipPhotosToResponse, contentDisposition, __resetListingCache } = photosRoutes;

interface Entry { name: string; body: Buffer }
function readZip(buf: Buffer): Entry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  assert.notEqual(eocd, -1, 'no end-of-central-directory — this is not a complete zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const at = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.push({ name, body: buf.subarray(at, at + csize) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** A response that is a real stream AND validates headers the way Node does: setHeader goes
 *  through http.ServerResponse, so an invalid character throws exactly as it would in production. */
function fakeRes() {
  const chunks: Buffer[] = [];
  const s = new PassThrough();
  s.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => { s.on('end', () => resolve(Buffer.concat(chunks))); s.on('close', () => resolve(Buffer.concat(chunks))); });
  const headers: Record<string, string> = {};
  const probe = new http.ServerResponse({ method: 'GET' } as http.IncomingMessage);
  (s as unknown as { setHeader: (k: string, v: string) => void }).setHeader = (k, v) => { probe.setHeader(k, v); headers[k] = v; };
  return { res: s as unknown as Parameters<typeof zipPhotosToResponse>[0], done, headers };
}

const EVENT = 'ev-names';
let n = 0;
function givenAPhoto(body: string, rel?: string): Stored {
  const id = `p-${++n}`;
  const file = rel ?? `${EVENT}/${id}.jpg`;
  fs.mkdirSync(path.dirname(path.join(TMP, file)), { recursive: true });
  fs.writeFileSync(path.join(TMP, file), body);
  const row: Stored = { id, filename: file, mediaType: 'photo', captureShape: null };
  live.set(id, row);
  return row;
}
const rows = (items: { row: Stored; who: string }[]) =>
  items.map(({ row, who }, i) => ({ ...row, participantId: `guest-${i}`, participantName: who }));

beforeEach(() => { live = new Map(); n = 0; __resetListingCache(); });

const NASTY_EVENTS = [
  'Demo Roll 🎞️',
  'Tatiana’s 21st birthday',
  "Sarah's Hen Do",
  'Josh and Otis\' "Big Day"',
  'Slash / back\\slash : colon * star ? q < > | pipe',
  'Line\nbreak\r\nand\ttab',
  '🎉🎉🎉',
  'x'.repeat(300),
  '',
  '   ',
  'Ünïcödé Çafé — naïve résumé',
  '日本語の結婚式',
  '\u0000nul\u0001ctl',
];

describe('Content-Disposition for any name', () => {
  for (const name of NASTY_EVENTS) {
    test(`is a valid header for ${JSON.stringify(name).slice(0, 40)}`, () => {
      const v = contentDisposition(`${name}.zip`);
      const probe = new http.ServerResponse({ method: 'GET' } as http.IncomingMessage);
      probe.setHeader('Content-Disposition', v);                     // throws on an invalid byte
      assert.match(v, /^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9%._~!*'()-]*$/);
      assert.ok(/filename="[^"]+"/.test(v), 'the plain filename is never empty');
    });
  }
});

describe('the archive itself', () => {
  for (const name of NASTY_EVENTS) {
    test(`downloads for an event called ${JSON.stringify(name).slice(0, 40)}`, async () => {
      const a = givenAPhoto('one'), b = givenAPhoto('two');
      const { res, done, headers } = fakeRes();
      const missing = await zipPhotosToResponse(res, name, rows([{ row: a, who: "O'Brien 🎞️" }, { row: b, who: 'Slash/Back\\slash\nNewline' }]));
      const entries = readZip(await done);
      assert.deepEqual(missing, []);
      assert.equal(entries.length, 2, 'both photos are in the archive');
      // Membership, not order: archiver settles entries as their reads complete.
      assert.deepEqual(entries.map((e) => e.body.toString()).sort(), ['one', 'two']);
      for (const e of entries) {
        assert.ok(!e.name.includes('/') && !e.name.includes('\\'), `an entry name must not be a path: ${JSON.stringify(e.name)}`);
        assert.ok(!/[\r\n\t\x00-\x1f]/.test(e.name), `an entry name must not carry control characters: ${JSON.stringify(e.name)}`);
        assert.ok(e.name.length > 0 && e.name.length < 200, `entry name length ${e.name.length}`);
      }
      assert.equal(headers['Content-Type'], 'application/zip');
      assert.match(headers['Content-Disposition'], /^attachment; filename="[^"]+\.zip"; filename\*=UTF-8''/);
    });
  }

  test('a guest called the same thing twice still gets both photos, numbered', async () => {
    const a = givenAPhoto('a'), b = givenAPhoto('b');
    const { res, done } = fakeRes();
    await zipPhotosToResponse(res, 'Party', rows([{ row: a, who: 'Sam' }, { row: b, who: 'Sam' }]));
    const names = readZip(await done).map((e) => e.name);
    assert.equal(new Set(names).size, 2, `duplicate entry names: ${names.join(', ')}`);
  });

  test('a legacy flat filename (no event folder) is still included', async () => {
    // Rows from before the per-event layout hold a bare uuid. The listing is per event folder, so
    // such a row never appears in it; the confirming `exists` is what brings it in.
    const a = givenAPhoto('flat', 'legacy-flat-photo.jpg');
    const b = givenAPhoto('foldered');
    const { res, done } = fakeRes();
    const missing = await zipPhotosToResponse(res, 'Party', rows([{ row: a, who: 'Ada' }, { row: b, who: 'Ada' }]));
    assert.deepEqual(missing, []);
    assert.deepEqual(readZip(await done).map((e) => e.body.toString()).sort(), ['flat', 'foldered']);
  });
});
