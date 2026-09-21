// The bulk zip, driven while the event is being edited underneath it.
//
// WHY THIS FILE EXISTS. A download of a 400-photo event is minutes of streaming, and the host
// spends those minutes in the Review screen straightening shots. POST /:id/rotate does not edit a
// file in place — it writes a fresh uuid, moves the row onto it and unlinks the old name — so
// every filename the zip route read at the start is a filename that can stop existing before the
// archive reaches it. Three separate mechanisms turned that into silence, and an audit found all
// three live:
//
//   1. THE SNAPSHOT. The route selects the rows once and hands the array to zipPhotosToResponse,
//      which trusted it for the whole of the stream. By entry 300 it is minutes old, so it names a
//      file nobody can open for a photo that is perfectly fine under a new name. The guest got a
//      zip with a hole in it. `rotate lands before the archive reaches the row` is the test below.
//   2. THE 2-SECOND readdir CACHE. `onDisk()` answers from a listing cached for LISTING_TTL_MS, so
//      inside that window it says "present" about a name unlinked a second ago, the entry is
//      queued anyway, and archiver's own lstat is the thing that fails. That failure emits
//      'warning' — which had NO LISTENER — and archiver simply drops the entry. Nothing logged,
//      nothing in the response, a download that completed looking perfect. `an entry archiver
//      drops` is the test below, and it reproduces the staleness honestly by warming the cache
//      with a real first download rather than by reaching into the module.
//   3. THE MID-STREAM ERROR. Headers are long gone by then, so the handler did the only thing it
//      could and destroyed the socket — but it left archiver running, and nothing said why.
//
// WHAT IS REAL HERE. The filesystem, archiver, and the zip bytes: the assertions below parse the
// actual central directory of the actual archive, because "is the photo in the file" is the only
// question worth asking and a mocked archiver cannot answer it. Only the database is a stand-in,
// for the same reason as photo-rotate-route.test.ts — the claims are about WHEN a filename is
// read, and a fake is the only way to change an answer at a chosen instant.
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

// paths.ts reads UPLOADS_DIR once, at import, and a suite that writes into the real uploads volume
// is one that can delete somebody's photos.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdini-zip-race-'));
process.env.UPLOADS_DIR = TMP;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

// ── A database that answers with whatever the test has most recently decided ──

const tableName = (t: unknown): string =>
  (t as Record<symbol, string>)?.[Symbol.for('drizzle:Name')] ?? 'unknown';

interface Stored { id: string; filename: string; mediaType: string | null; captureShape: string | null }

/** The rows as the database holds them RIGHT NOW, which is not the same thing as the snapshot the
 *  route took. Keyed by id, because that is the handle the fix re-resolves from. */
let live = new Map<string, Stored>();

/* eslint-disable @typescript-eslint/no-explicit-any */
function chain<T>(produce: () => T): any {
  const o: any = {
    where() { return o; },
    from() { return o; },
    innerJoin() { return o; },
    orderBy() { return o; },
    limit() { return o; },
    then(res: (v: T) => unknown, rej: (e: unknown) => unknown) {
      return Promise.resolve().then(produce).then(res, rej);
    },
  };
  return o;
}

const fakeDb: any = {
  select() {
    return {
      from(t: unknown) {
        return chain(() => (tableName(t) === 'photos' ? [...live.values()] : []));
      },
    };
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const dbPath = require.resolve('../db');
require(dbPath);
require.cache[dbPath]!.exports = { db: fakeDb, schema: {}, pool: {} };

const photosRoutes = require('../routes/photos') as typeof import('../routes/photos');
const { zipPhotosToResponse, onZipStreamError } = photosRoutes;

// ── Reading the archive back ──────────────────────────────────────────────────
//
// The central directory, not the local headers: archiver streams, so it sets the data-descriptor
// flag and writes zeroes for the sizes in the local header. The sizes that are true are at the
// end of the file. Everything here is stored (never deflated — see the comment on the ZipArchive
// options), so an entry's bytes are its bytes.

interface Entry { name: string; body: Buffer }

function readZip(buf: Buffer): Entry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  assert.notEqual(eocd, -1, 'no end-of-central-directory — this is not a complete zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory record expected');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    assert.equal(method, 0, `${name} was compressed; the zip is meant to be store-only`);
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const at = local + 30 + lNameLen + lExtraLen;
    out.push({ name, body: buf.subarray(at, at + csize) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** A stand-in for the express response: a real stream, so archiver's pipe and backpressure are
 *  real, plus the two header setters the function calls. */
function fakeRes(): { res: any; done: Promise<Buffer>; destroyed: () => boolean } {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const chunks: Buffer[] = [];
  const s = new PassThrough();
  s.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    s.on('end', () => resolve(Buffer.concat(chunks)));
    s.on('close', () => resolve(Buffer.concat(chunks)));
  });
  (s as any).setHeader = () => {};                 // eslint-disable-line @typescript-eslint/no-explicit-any
  return { res: s, done, destroyed: () => s.destroyed };
}

const EVENT = 'ev-zip';
const disk = (rel: string) => path.join(TMP, rel);
function writeFile(rel: string, body: string): void {
  fs.mkdirSync(path.dirname(disk(rel)), { recursive: true });
  fs.writeFileSync(disk(rel), body);
}

let n = 0;
/** One photo, in the database and on the disk, at the name given. */
function givenAPhoto(body: string): Stored {
  const id = `p-${++n}`;
  const rel = `${EVENT}/${id}-a.jpg`;
  writeFile(rel, body);
  const row: Stored = { id, filename: rel, mediaType: 'photo', captureShape: null };
  live.set(id, row);
  return row;
}

/** What the route's own select produced at the start of the request. Deliberately a COPY: the
 *  whole point is that it goes on saying what it said while the database moves on. */
const snapshot = (rows: Stored[]) =>
  rows.map((r) => ({ ...r, participantId: 'guest-1', participantName: 'Ada' }));

/** What a rotation does to the stored file, at the level this test cares about: a new uuid holding
 *  the turned pixels, the row moved onto it, the old name unlinked. */
function rotateOnDisk(row: Stored, body: string): string {
  const rel = `${EVENT}/${row.id}-b.jpg`;
  writeFile(rel, body);
  fs.unlinkSync(disk(row.filename));
  live.set(row.id, { ...row, filename: rel });
  return rel;
}

async function zip(rows: ReturnType<typeof snapshot>): Promise<{ entries: Entry[]; missing: string[] }> {
  const { res, done } = fakeRes();
  const missing = await zipPhotosToResponse(res, 'Party', rows);
  return { entries: readZip(await done), missing };
}

beforeEach(() => {
  live = new Map();
  // AND the readdir cache, which is module-level with a two-second wall-clock TTL. Without this
  // the suite is order- and speed-dependent: whether a test sees a file another test has just
  // unlinked depends on how long the previous test happened to take. Measured as a real flake —
  // one failure in about seventeen full app-suite runs, clean in isolation every time, which is
  // the most expensive shape a flake can have because it never reproduces when you look at it.
  photosRoutes.__resetListingCache();
});

describe('the bulk zip against a concurrent rotate', () => {
  // THE HEADLINE CLAIM. A rotate only changes the NAME — the photo is still there — so the right
  // outcome is the rotated file in the zip. Trusting the snapshot instead produced an archive with
  // one fewer photo in it and a 200 OK on top.
  test('puts the ROTATED file in the archive rather than a hole where it was', async () => {
    const p = givenAPhoto('before the turn');
    const taken = snapshot([p]);                    // the route's select, minutes ago
    rotateOnDisk(p, 'after the turn');              // the host presses rotate mid-download

    const { entries, missing } = await zip(taken);
    assert.deepEqual(missing, [], 'nothing is missing — the photo was renamed, not lost');
    assert.deepEqual(entries.map((e) => e.name), ['Party - Ada - 1.jpg']);
    assert.equal(entries[0].body.toString(), 'after the turn');
  });

  // A rotate landing inside the readdir cache's 2s window, which is how an entry gets QUEUED for a
  // name that is already gone.
  //
  // IT ONLY PINS THE LISTENER BECAUSE THE SUITE IS CLEAN. An audit found this test passing with
  // the 'warning' listener renamed to a dead event, which made it a test of the outcome and not of
  // the mechanism. The cause was not the test: it was the module-level readdir cache leaking
  // between tests, so the warming below was landing on a listing another test had already filled
  // and the entry was being caught by the existence guard instead of reaching archiver. With the
  // cache reset in beforeEach the warming does what it says, and removing the listener now fails
  // here — verified both ways.
  //
  // Which is the argument for the reset in miniature: shared state between tests does not only
  // cause flakes, it quietly changes which code path a test exercises, and a test exercising the
  // wrong path still passes.
  //
  // The listener also has a structural backstop, because a missing one used to mean more than a
  // missing manifest line: an entry that never settles leaves the response awaiting a count that
  // will never complete, and the download hangs open for ever. See the idle watchdog on the
  // settle wait in zipPhotosToResponse.
  test('names an entry archiver drops instead of letting it vanish', async () => {
    const p = givenAPhoto('here for now');
    const taken = snapshot([p]);

    const first = await zip(taken);                 // warms the listing for this event folder
    assert.deepEqual(first.entries.map((e) => e.name), ['Party - Ada - 1.jpg']);

    fs.unlinkSync(disk(p.filename));                // gone, but the cached listing still says otherwise
    live.set(p.id, { ...p });                       // the row still points at it, as a delete-less purge would

    const { entries, missing } = await zip(taken);
    assert.deepEqual(missing, ['Party - Ada - 1.jpg'], 'the dropped entry must be reported, not swallowed');
    // And the guest is told inside the only surface left once the headers have gone: the archive.
    const readme = entries.find((e) => e.name.endsWith('MISSING PHOTOS.txt'));
    assert.ok(readme, `no manifest in the zip; entries were ${JSON.stringify(entries.map((e) => e.name))}`);
    assert.match(readme!.body.toString(), /Party - Ada - 1\.jpg/);
    assert.match(readme!.body.toString(), /1 of 1 is missing/);
  });

  // A photo really deleted between the snapshot and the archive is a different outcome from a
  // rotated one — nothing will bring it back — but it is the same rule: say so.
  test('reports a row that has been deleted outright', async () => {
    const p = givenAPhoto('doomed');
    const taken = snapshot([p]);
    live.delete(p.id);
    fs.unlinkSync(disk(p.filename));

    const { entries, missing } = await zip(taken);
    assert.deepEqual(missing, ['Party - Ada - 1.jpg']);
    assert.deepEqual(entries.map((e) => e.name), ['Party - MISSING PHOTOS.txt']);
  });

  // A clean download must stay clean: a README in every zip would train people to ignore it.
  test('adds no manifest when everything is there', async () => {
    const a = givenAPhoto('one'), b = givenAPhoto('two');
    const { entries, missing } = await zip(snapshot([a, b]));
    assert.deepEqual(missing, []);
    assert.deepEqual(entries.map((e) => e.name), ['Party - Ada - 1.jpg', 'Party - Ada - 2.jpg']);
  });

  // The numbering is positional, so one missing photo does not silently rename every photo after
  // it. Two downloads of the same event have to agree on which file is "Ada - 3".
  test('keeps the numbering of the photos that did survive', async () => {
    const a = givenAPhoto('one'), b = givenAPhoto('two'), c = givenAPhoto('three');
    const taken = snapshot([a, b, c]);
    live.delete(b.id);
    fs.unlinkSync(disk(b.filename));

    const { entries } = await zip(taken);
    const names = entries.map((e) => e.name);
    assert.ok(names.includes('Party - Ada - 1.jpg'), names.join(', '));
    assert.ok(names.includes('Party - Ada - 3.jpg'), 'the third photo must still be number 3');
    assert.ok(!names.includes('Party - Ada - 2.jpg'), 'number 2 is the hole, and stays the hole');
  });

  // THE SECOND LOOK. Resolving names in batches narrows the race to "at most fifty files ahead of
  // where we are", which on a large event over NFS is still tens of seconds — and a rotate landing
  // inside that window produced a README naming a photo that had never been lost. It had moved
  // again, and we reported the last place we looked. By the time the queue has drained we know
  // exactly which entries failed and which rows they came from, so we can go and ask again.
  test('goes back at the end for a photo that moved again while the archive was streaming', async () => {
    const p = givenAPhoto('first name');
    const taken = snapshot([p]);

    // The rotate commits the instant AFTER the batch read — the one window batching cannot close.
    // The iterator is materialised before the mutation, so this select still answers with the old
    // name exactly as a real one taken a moment earlier would.
    const origValues = live.values.bind(live);
    let selects = 0;
    (live as unknown as { values: () => IterableIterator<Stored> }).values = () => {
      const out = [...origValues()];
      if (++selects === 1) rotateOnDisk(p, 'second name');
      return out[Symbol.iterator]();
    };

    const { entries, missing } = await zip(taken);
    assert.deepEqual(missing, [], 'it moved, it was not lost — and the second look found it');
    assert.deepEqual(entries.map((e) => e.name), ['Party - Ada - 1.jpg'],
      'and under the name it was always going to have, not a renumbered one');
    assert.equal(entries[0].body.toString(), 'second name');
    assert.ok(selects >= 2, 'the recovery pass has to actually ask the database again');
  });

  // The other half of the same claim: the pass recovers what MOVED, and must not talk itself into
  // thinking it recovered what is simply gone. A deleted row has nothing to find, and the README
  // is the honest answer to it.
  test('still reports a photo that is genuinely gone, after looking twice', async () => {
    const a = givenAPhoto('here'), b = givenAPhoto('vanishing');
    const taken = snapshot([a, b]);
    live.delete(b.id);
    fs.unlinkSync(disk(b.filename));

    const { entries, missing } = await zip(taken);
    assert.deepEqual(missing, ['Party - Ada - 2.jpg']);
    const names = entries.map((e) => e.name);
    assert.ok(names.includes('Party - MISSING PHOTOS.txt'), names.join(', '));
    const readme = entries.find((e) => e.name.endsWith('MISSING PHOTOS.txt'))!.body.toString();
    assert.match(readme, /looked for a second time/, 'the README must describe what was done');
  });
});

describe('a zip that fails after the headers have gone', () => {
  // There is no status code left, no header and no JSON — the only thing this stage of the
  // response can still say is "the body is not finished", which it says by destroying the socket
  // and never writing the terminating chunk. So the assertions are: the archiver is stopped, the
  // socket is destroyed, and — the load-bearing one — end() is never called, because ending would
  // hand the client a complete, well-framed HTTP response containing half a zip.
  test('stops the archiver and destroys the response without ending it', () => {
    let aborted = false, destroyed = false, ended = false;
    const res = { destroy() { destroyed = true; }, end() { ended = true; } };
    onZipStreamError(res, { abort() { aborted = true; } }, new Error('ENOENT halfway through'));
    assert.equal(aborted, true, 'archiver must stop pulling files off the share for a dead download');
    assert.equal(destroyed, true);
    assert.equal(ended, false, 'end() would terminate the chunked body and make a truncated zip look complete');
  });
});
