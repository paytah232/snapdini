// The zip download cannot be left hanging open — whatever archiver does.
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT zip-download-race.test.ts.
//
// That file drives the REAL archiver against the real filesystem and asserts on the bytes of the
// real zip, which is the only way to answer "is the photo in the file". This one asks the
// opposite question: what happens when archiver stops answering at all. That state cannot be
// produced with the real archiver on purpose — every route it has out of a queued entry emits
// 'entry', 'warning' or 'error', which is exactly why the settle bookkeeping works — so the
// archiver here is a stand-in. It is the only stand-in of consequence: the rows, the filenames,
// the disk and the response are all real enough for the function to behave as it does in
// production.
//
// WHAT WENT WRONG, because the code read as though it was already handled. A watchdog on the
// settle wait logged "giving up on the wait" after two idle minutes and let the function carry
// on — to `await archive.finalize()`. In archiver 8 (lib/core.js) finalize() returns a promise
// that resolves on the zip module's `end`, and the module only ends once `_pending === 0 &&
// _queue.idle()`. That is the precise condition the watchdog exists because it has NOT happened.
// So in the one scenario the mechanism was written for, nothing was prevented: the request hung
// at finalize instead of at the wait, two minutes later, with no bytes, no error and no end. The
// socket then stays open until the process restarts.
//
// Seventy lines further down, the recovery pass awaited a bare promise with no idle timer and no
// settle hook at all — the same hang, reintroduced inside the fix for it.
//
// THE FIVE CLAIMS BELOW:
//
//   1. An entry that never settles ends the request, as a FAILED download: archiver stopped, the
//      socket destroyed, and — the load-bearing part, see onZipStreamError — never ended, because
//      ending it hands the client a complete, well-framed HTTP response containing half a zip.
//   2. A client that goes away during the final flush does not strand the request either. An
//      aborted archiver never ends its module, so the promise finalize() already returned never
//      settles, and this function, its rows and its archiver would sit in memory for the life of
//      the process over a socket that closed minutes ago.
//   3. The recovery pass waits the same guarded way the first wait does.
//   4/5. AND NONE OF IT MAY KILL A WORKING DOWNLOAD. One entry is one settle, so a single large
//      clip going out to a slow phone is legitimately minutes of silence from the settle counter
//      while bytes flow the whole time — and a guest whose end has stopped reading is a
//      back-pressured response, not a stalled archive. Both are downloads in progress and both
//      must survive. That is the half which makes it safe to give the watchdog teeth, and the
//      half a "just add a timeout" version gets wrong.
import { test, describe, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// paths.ts reads UPLOADS_DIR once, at import, and a suite that writes into the real uploads
// volume is one that can delete somebody's photos.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdini-zip-watchdog-'));
process.env.UPLOADS_DIR = TMP;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

// ── An archiver that can be made to stop answering ───────────────────────────

interface EntryData { name: string }

/** How the next archive this module hands out will behave. Set before the call, because the
 *  instance is created inside the function under test and there is no seam to reach it through
 *  beforehand. */
interface Behaviour {
  /** Does a queued entry ever settle, or is it swallowed? */
  settles: boolean;
  /** How long an admitted entry takes to settle. */
  settleAfterMs: number;
  /** Emit a chunk this often while an entry is being "written". Zero for none. */
  dribbleMs: number;
  /** Hang finalize() even with nothing outstanding — which is what an ABORTED archiver does,
   *  since abort() unpipes the module and the module then never emits `end`. */
  finalizeHangs: boolean;
}

/** A stand-in for ZipArchive modelling the parts of archiver 8's contract this function leans on,
 *  and nothing else.
 *
 *  THE ONE MODELLED DETAIL THAT MATTERS: finalize() resolves only once every queued entry has
 *  settled. That is not a convenience for these tests — it is what archiver really does (the
 *  promise is resolved from the zip module's `end`, which needs `_pending === 0 &&
 *  _queue.idle()`), and it is the whole reason a watchdog that merely stops waiting moves the
 *  hang rather than removing it. A fake that resolved finalize() unconditionally would let the
 *  broken version of this code pass every test in this file. */
class StuckArchive extends EventEmitter {
  static latest: StuckArchive | null = null;
  static next: Behaviour = { settles: false, settleAfterMs: 0, dribbleMs: 0, finalizeHangs: false };
  /** Called the instant the code under test reaches finalize(), so a test can act there. */
  static onFinalize: ((a: StuckArchive) => void) | null = null;

  behaviour: Behaviour;
  queued: { path: string; name: string }[] = [];
  appended: string[] = [];
  settledCount = 0;
  aborted = false;
  finalizeCalled = false;
  private timers: NodeJS.Timeout[] = [];

  constructor() { super(); this.behaviour = { ...StuckArchive.next }; StuckArchive.latest = this; }

  pipe(dest: unknown): unknown { return dest; }

  file(src: string, data: EntryData): this {
    this.queued.push({ path: src, name: data.name });
    if (!this.behaviour.settles) return this;               // queued, and never heard of again
    if (this.behaviour.dribbleMs) {
      this.timers.push(setInterval(() => this.emit('data', Buffer.from('PK')), this.behaviour.dribbleMs));
    }
    this.timers.push(setTimeout(() => {
      this.stopTimers();
      this.settledCount++;
      this.emit('entry', data);
    }, this.behaviour.settleAfterMs));
    return this;
  }

  append(_source: unknown, data: EntryData): this { this.appended.push(data.name); return this; }

  abort(): this { this.aborted = true; this.stopTimers(); return this; }

  finalize(): Promise<void> {
    this.finalizeCalled = true;
    StuckArchive.onFinalize?.(this);
    if (this.behaviour.finalizeHangs || this.settledCount < this.queued.length) {
      return new Promise<void>(() => { /* exactly as archiver leaves it */ });
    }
    return Promise.resolve();
  }

  stopTimers(): void { for (const t of this.timers) clearTimeout(t); this.timers = []; }
}

const archiverPath = require.resolve('archiver');
require(archiverPath);
// Replaced wholesale rather than patched: routes/photos.ts takes `ZipArchive` and nothing else
// out of this package, and nothing else loaded in this file's process touches it.
require.cache[archiverPath]!.exports = { ZipArchive: StuckArchive };

// ── A database that answers with whatever the test has most recently decided ──

const tableName = (t: unknown): string =>
  (t as Record<symbol, string>)?.[Symbol.for('drizzle:Name')] ?? 'unknown';

interface Stored { id: string; filename: string; mediaType: string | null; captureShape: string | null }

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
const { zipPhotosToResponse, __setZipSettleIdleMs, __resetListingCache } = photosRoutes;

// ── The response, as much of one as this function touches ────────────────────

/** Everything zipPhotosToResponse asks of a response, and the two facts worth asserting about
 *  one: was it destroyed, and was it ENDED. Never ending a failed body is the whole of the
 *  failure signal at this stage of a request — see onZipStreamError. */
class FakeRes extends EventEmitter {
  headers: Record<string, string> = {};
  destroyed = false;
  ended = false;
  writableFinished = false;
  writableNeedDrain = false;
  setHeader(k: string, v: string): void { this.headers[k] = v; }
  // Faithful to a real socket: 'close' follows a destroy, on a later turn of the loop.
  destroy(): void { this.destroyed = true; setImmediate(() => this.emit('close')); }
  end(): void { this.ended = true; }
}

type ResArg = Parameters<typeof zipPhotosToResponse>[0];
const asRes = (r: FakeRes): ResArg => r as unknown as ResArg;

const EVENT = 'ev-zip';
const disk = (rel: string) => path.join(TMP, rel);
function writeFile(rel: string, body: string): void {
  fs.mkdirSync(path.dirname(disk(rel)), { recursive: true });
  fs.writeFileSync(disk(rel), body);
}

let n = 0;
/** One photo, in the database and on the disk. */
function givenAPhoto(body: string): Stored {
  const id = `p-${++n}`;
  const rel = `${EVENT}/${id}-a.jpg`;
  writeFile(rel, body);
  const row: Stored = { id, filename: rel, mediaType: 'photo', captureShape: null };
  live.set(id, row);
  return row;
}

/** What the route's own select produced at the start of the request. */
const snapshot = (rows: Stored[]) =>
  rows.map((r) => ({ ...r, participantId: 'guest-1', participantName: 'Ada' }));

/** A rotation, at the level this file cares about: a new name, the row moved onto it, the old
 *  name unlinked. */
function rotateOnDisk(row: Stored, body: string): string {
  const rel = `${EVENT}/${row.id}-b.jpg`;
  writeFile(rel, body);
  fs.unlinkSync(disk(row.filename));
  live.set(row.id, { ...row, filename: rel });
  return rel;
}

/** Long enough that every working download here finishes inside it, short enough that a hung one
 *  costs the suite nothing. Each case below settles in tens of milliseconds, or not at all. */
const PATIENCE_MS = 2_000;

/** 'HUNG' rather than a rejection, so a failure says what actually happened: a test that instead
 *  ran into the runner's own timeout reports a timeout, which names nothing. */
async function within<T>(p: Promise<T>): Promise<T | 'HUNG'> {
  let t: NodeJS.Timeout | undefined;
  const hung = new Promise<'HUNG'>((r) => { t = setTimeout(() => r('HUNG'), PATIENCE_MS); });
  const out = await Promise.race([p, hung]);
  clearTimeout(t);
  return out;
}

let restoreIdle = 120_000;
beforeEach(() => {
  live = new Map();
  n = 0;
  StuckArchive.latest = null;
  StuckArchive.onFinalize = null;
  StuckArchive.next = { settles: false, settleAfterMs: 0, dribbleMs: 0, finalizeHangs: false };
  // The readdir cache is module-level with a two-second wall-clock TTL, so without this the suite
  // is order- and speed-dependent — see the longer note in zip-download-race.test.ts.
  __resetListingCache();
  // 60ms, so the watchdog is something that happens during a test rather than two minutes later.
  restoreIdle = __setZipSettleIdleMs(60);
});
afterEach(() => {
  __setZipSettleIdleMs(restoreIdle);
  StuckArchive.latest?.stopTimers();
});

describe('a zip archive that stops answering', () => {
  test('fails the download rather than leaving the request open for ever', async () => {
    const p = givenAPhoto('queued, and then silence');
    const res = new FakeRes();

    const out = await within(zipPhotosToResponse(asRes(res), 'Party', snapshot([p])));

    assert.notEqual(out, 'HUNG',
      'the request never returned: the watchdog stopped waiting and then blocked on finalize(), ' +
      'which cannot resolve while an entry is outstanding — the hang was moved, not removed');
    const a = StuckArchive.latest!;
    assert.equal(a.queued.length, 1, 'the entry has to have been queued, or this proves nothing');
    assert.equal(a.aborted, true, 'archiver must stop working a download that has been written off');
    assert.equal(res.destroyed, true, 'the socket is the only place a failure can still be reported');
    assert.equal(res.ended, false,
      'ending the body writes the terminating chunk, which tells the client a truncated zip is complete');
    assert.equal(a.finalizeCalled, false,
      'finalize() on a queue that will never drain IS the hang — it must not be reached');
    assert.deepEqual(a.appended, [],
      'a README cannot be appended to a queue that will not drain; QUEUECLOSED is the other outcome');
  });

  test('does not strand the request when the guest goes away during the final flush', async () => {
    // The watchdog is deliberately taken out of the picture here — this is the OTHER hang, and one
    // a settle watchdog cannot see: every entry HAS settled, so there is nothing left to wait for
    // except finalize(), and the abort that the closing socket triggers leaves the module unable
    // ever to end.
    __setZipSettleIdleMs(60_000);
    StuckArchive.next = { settles: true, settleAfterMs: 0, dribbleMs: 0, finalizeHangs: true };
    const p = givenAPhoto('all present and correct');
    const res = new FakeRes();
    StuckArchive.onFinalize = () => { setImmediate(() => res.emit('close')); };  // wifi gone, mid-flush

    const out = await within(zipPhotosToResponse(asRes(res), 'Party', snapshot([p])));

    assert.notEqual(out, 'HUNG',
      'finalize() never settles once the archiver has been aborted, so awaiting it bare leaves ' +
      'this function, its rows and its archiver alive for the life of the process');
    const a = StuckArchive.latest!;
    assert.equal(a.finalizeCalled, true, 'the ordinary path must still go through finalize()');
    assert.equal(a.aborted, true, 'the close handler stops archiver pulling files for a dead socket');
  });

  test('waits the same guarded way after the recovery pass re-queues an entry', async () => {
    // The second wait had neither an idle timer nor a settle hook. Reaching it needs a photo that
    // is missing when the archive walks past it and present when the recovery pass looks again,
    // which is what a rotate landing between the two does — the same construction as the recovery
    // test in zip-download-race.test.ts, with an archiver that then abandons the recovered entry.
    const p = givenAPhoto('first name');
    const taken = snapshot([p]);
    const origValues = live.values.bind(live);
    let selects = 0;
    (live as unknown as { values: () => IterableIterator<Stored> }).values = () => {
      const out = [...origValues()];
      if (++selects === 1) rotateOnDisk(p, 'second name');
      return out[Symbol.iterator]();
    };
    const res = new FakeRes();

    const out = await within(zipPhotosToResponse(asRes(res), 'Party', taken));

    assert.notEqual(out, 'HUNG', 'the recovery pass must not be able to hang the response either');
    const a = StuckArchive.latest!;
    assert.ok(selects >= 2, 'the recovery pass has to have actually run, or this tests nothing');
    assert.deepEqual(a.queued.map((q) => path.basename(q.path)), [`${p.id}-b.jpg`],
      'the only entry ever queued is the recovered one, so it is the SECOND wait being exercised');
    assert.equal(a.aborted, true);
    assert.equal(res.destroyed, true);
    assert.equal(res.ended, false);
  });
});

describe('a slow download is not a stalled one', () => {
  test('an entry that is still writing bytes is left alone', async () => {
    // GUARD, and the reason the watchdog counts bytes rather than settles. One entry is one
    // settle: a half-gigabyte clip going out to a phone on mobile data is many minutes between
    // 'entry' events, every one of them spent writing it successfully. A plain idle-settle timer
    // kills that download. Five watchdog periods long, with a chunk every 10ms, so the timer
    // fires repeatedly during the entry and has to re-arm each time — and so that a busy machine
    // has to lose six chunks in a row, not one, before this reports a flake instead of a bug.
    StuckArchive.next = { settles: true, settleAfterMs: 300, dribbleMs: 10, finalizeHangs: false };
    const p = givenAPhoto('a very large clip');
    const res = new FakeRes();

    const out = await within(zipPhotosToResponse(asRes(res), 'Party', snapshot([p])));

    assert.deepEqual(out, [], 'nothing was missing — this download was simply slow');
    const a = StuckArchive.latest!;
    assert.equal(a.aborted, false, 'a download still putting bytes on the wire must not be written off');
    assert.equal(res.destroyed, false);
    assert.equal(a.finalizeCalled, true, 'and it must finish the way a healthy download does');
  });

  test('a response the guest has stopped reading is a slow guest, not a stalled archive', async () => {
    // GUARD, the other half. A locked phone or a tunnel stops the client reading, the socket
    // buffer fills, and archiver is blocked on back-pressure with nothing to emit — indis-
    // tinguishable from a dead queue by bytes alone. The download is alive and may resume at any
    // moment; killing it after two minutes of a screen being off would be a new bug shipped
    // inside the fix for an old one.
    StuckArchive.next = { settles: true, settleAfterMs: 300, dribbleMs: 0, finalizeHangs: false };
    const p = givenAPhoto('waiting on a phone that has gone to sleep');
    const res = new FakeRes();
    res.writableNeedDrain = true;

    const out = await within(zipPhotosToResponse(asRes(res), 'Party', snapshot([p])));

    assert.deepEqual(out, []);
    const a = StuckArchive.latest!;
    assert.equal(a.aborted, false, 'back-pressure is the guest being slow, not the archive being dead');
    assert.equal(res.destroyed, false);
  });
});
