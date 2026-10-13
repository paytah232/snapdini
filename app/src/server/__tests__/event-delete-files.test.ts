// Deleting an event's files deletes EVERYTHING the event owns in the store.
//
// Found against a real bucket: the organizer's delete named the thumbnail and the playback proxy
// by hand and left a shaped clip's crop, its poster and the download re-encode behind — five
// orphans per clip, with no folder to spot them in. And the retention purge used to rely on
// removing the event's folder, which the organizer's delete never did. Both callers are about to
// drop the event row, so everything under its prefix is unreachable the moment they return; this
// pins that it is also GONE, on the local driver against a real temp folder, including the
// legacy locations an old event may still have files in.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdini-event-delete-'));
process.env.UPLOADS_DIR = TMP;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const tableName = (t: unknown): string => (t as Record<symbol, string>)?.[Symbol.for('drizzle:Name')] ?? 'unknown';
const EVENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
let photoRows: { filename: string }[] = [];
let eventRow: { theme: string | null; posterConfig: string | null } | null = null;
/* eslint-disable @typescript-eslint/no-explicit-any */
function chain<T>(produce: () => T): any {
  const o: any = { where() { return o; }, from() { return o; }, then(res: (v: T) => unknown, rej: (e: unknown) => unknown) { return Promise.resolve().then(produce).then(res, rej); } };
  return o;
}
const fakeDb: any = {
  select() {
    return { from(t: unknown) { return chain(() => tableName(t) === 'photos' ? photoRows : tableName(t) === 'events' ? (eventRow ? [eventRow] : []) : []); } };
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */
const dbPath = require.resolve('../db');
require(dbPath);
require.cache[dbPath]!.exports = { db: fakeDb, schema: {}, pool: {}, get: async () => null, all: async () => [], run: async () => {} };
const cleanup = require('../cleanup') as typeof import('../cleanup');
const { derivedNames } = require('../images') as typeof import('../images');

const put = (rel: string) => { fs.mkdirSync(path.dirname(path.join(TMP, rel)), { recursive: true }); fs.writeFileSync(path.join(TMP, rel), 'x'); };
const there = (rel: string) => fs.existsSync(path.join(TMP, rel));

describe('unlinkUpload', () => {
  test('removes the original and every derived copy, and nothing else', async () => {
    const rel = `${EVENT}/clip.mp4`;
    const mine = [rel, ...derivedNames(rel)];
    for (const f of mine) put(f);
    put(`${EVENT}/other.jpg`);
    await cleanup.unlinkUpload(rel);
    for (const f of mine) assert.equal(there(f), false, `${f} should be gone`);
    assert.equal(there(`${EVENT}/other.jpg`), true, 'a neighbour is untouched');
  });
  test('tolerates a missing file and a name outside the key grammar', async () => {
    await cleanup.unlinkUpload(`${EVENT}/never-existed.jpg`);
    await cleanup.unlinkUpload('../../etc/passwd');
    await cleanup.unlinkUpload(null);
  });
});

describe('deleteEventFiles', () => {
  before(() => {
    photoRows = [{ filename: `${EVENT}/a.jpg` }, { filename: `${EVENT}/v.mp4` }, { filename: 'legacy-flat.jpg' }];
    eventRow = {
      theme: JSON.stringify({ headerImage: `/uploads/${EVENT}/theme-1.jpg`, logo: '/uploads/themes/legacy-header.jpg', bg: '#000' }),
      posterConfig: JSON.stringify({ bgImage: `/uploads/${EVENT}/poster-bg.jpg`, evil: '/uploads/../../etc/passwd' }),
    };
    for (const f of [`${EVENT}/a.jpg`, `${EVENT}/a_thumb.webp`, `${EVENT}/v.mp4`, ...derivedNames(`${EVENT}/v.mp4`),
                     `${EVENT}/theme-1.jpg`, `${EVENT}/poster-bg.jpg`, `${EVENT}/audio-track.m4a`, `${EVENT}/slideshow-abc.mp4`,
                     `${EVENT}/orphan-nothing-references.jpg`, 'legacy-flat.jpg', 'legacy-flat_thumb.webp', 'themes/legacy-header.jpg',
                     `slideshow-audio/${EVENT}-track.mp3`, `slideshow-audio/${OTHER}-track.mp3`,
                     `${OTHER}/keep.jpg`, 'feedback/keep.jpg']) put(f);
  });
  test('the whole event prefix, the legacy files it names, and nothing of anybody else', async () => {
    await cleanup.deleteEventFiles(EVENT);
    assert.equal(fs.existsSync(path.join(TMP, EVENT)), false, 'the event folder is gone entirely');
    for (const f of ['legacy-flat.jpg', 'legacy-flat_thumb.webp', 'themes/legacy-header.jpg', `slideshow-audio/${EVENT}-track.mp3`]) assert.equal(there(f), false, `${f} should be gone`);
    for (const f of [`${OTHER}/keep.jpg`, 'feedback/keep.jpg', `slideshow-audio/${OTHER}-track.mp3`]) assert.equal(there(f), true, `${f} must survive`);
    assert.equal(fs.existsSync('/etc/passwd'), true);
  });
});
