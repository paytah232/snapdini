// Exercise real archiver downloads against S3-shaped streams, including connection-pool limits.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import type { MediaBody, MediaStore } from '../media/types';
let rows = makeRows(1);
function makeRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `photo-${i}`, filename: `event-s3/photo-${i}.jpg`,
    mediaType: 'photo', captureShape: null, participantId: 'guest', participantName: 'Guest' }));
}
const dbPath = require.resolve('../db');
require(dbPath);
require.cache[dbPath]!.exports = { db: { select() { const q = {
  from() { return q; }, where() { return q; },
  then(resolve: (value: typeof rows) => unknown) { return Promise.resolve(rows).then(resolve); },
}; return q; } }, schema: {}, pool: {} };
const { zipPhotosToResponse, __resetListingCache, __setZipSettleIdleMs } = require('../routes/photos') as typeof import('../routes/photos');
const { __setMedia } = require('../media') as typeof import('../media');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish`)), 1500);
  })]); } finally { clearTimeout(timer!); }
}
function response() {
  const chunks: Buffer[] = [];
  const stream = new PassThrough() as PassThrough & { setHeader(k: string, v: string): void };
  stream.setHeader = () => {};
  stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const closed = new Promise<void>(resolve => stream.once('close', resolve));
  return { res: stream as unknown as Parameters<typeof zipPhotosToResponse>[0], stream, chunks, closed };
}
function install(get: MediaStore['get']) {
  __setMedia({ driver: 's3', get, exists: async () => true,
    list: async () => rows.map(r => r.filename.split('/')[1]),
  } as unknown as MediaStore);
  __resetListingCache();
}
function body(stream: Readable, size = 65536): MediaBody {
  return { stream, size, etag: '"test"', mtimeMs: 0, contentType: 'image/jpeg' };
}
__setZipSettleIdleMs(500);
afterEach(() => { __setMedia(null); __resetListingCache(); rows = makeRows(1); });
async function brokenDownload() {
  install(async () => {
    let started = false;
    return body(new Readable({ read() {
      if (started) return;
      started = true;
      this.push(Buffer.alloc(16384, 7));
      setImmediate(() => this.destroy(Object.assign(new Error('S3 socket reset'), { code: 'ECONNRESET' })));
    } }));
  });
  const r = response();
  await bounded(zipPhotosToResponse(r.res, 'S3 party', rows), 'failed zip handler');
  await bounded(r.closed, 'aborted response');
  assert.equal(r.stream.writableFinished, false, 'incomplete archive must abort transfer');
  assert.ok(Buffer.concat(r.chunks).length > 0, 'failure occurred after archive bytes began');
}
// A source error must not kill Node; do not hide that bug with a test-only error listener.
if (process.env.SNAPDINI_ZIP_S3_CHILD === 'reset') {
  brokenDownload().then(() => { console.log('RESET_CONTAINED'); process.exit(0); },
    error => { console.error(error); process.exit(1); });
} else {
  test('mid-body ECONNRESET aborts the real zip and leaves the server process alive', { timeout: 5000 }, async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', __filename], {
      env: { ...process.env, SNAPDINI_ZIP_S3_CHILD: 'reset' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('exit', resolve);
      });
      assert.equal(exit, 0, output);
      assert.match(output, /RESET_CONTAINED/);
    } finally { clearTimeout(timer); child.kill(); }
  });
  test('a 61-entry zip completes with a two-connection S3 pool and one body open at a time', { timeout: 4000 }, async () => {
    rows = makeRows(61); // Cross both the SDK's usual 50-socket limit and the route refresh batch.
    let active = 0, peak = 0;
    const permits: (() => void)[] = [];
    const opened: Readable[] = [];
    install(async key => {
      if (active >= 2) await new Promise<void>(resolve => permits.push(resolve));
      active++; peak = Math.max(peak, active);
      let started = false;
      const stream = new Readable({ read() {
        if (started) return;
        started = true;
        setImmediate(() => { this.push(Buffer.alloc(65536, Number(key.match(/photo-(\d+)/)![1]) + 1)); this.push(null); });
      } });
      stream.once('end', () => { active--; permits.shift()?.(); });
      opened.push(stream);
      return body(stream);
    });
    const r = response();
    try {
      assert.deepEqual(await bounded(zipPhotosToResponse(r.res, 'S3 party', rows), 'complete zip'), []);
      const zip = Buffer.concat(r.chunks);
      const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      assert.ok(end >= 0, 'archive has its end-of-central-directory');
      assert.equal(zip.readUInt16LE(end + 10), rows.length);
      for (let i = 0; i < rows.length; i++) assert.ok(zip.includes(Buffer.alloc(65536, i + 1)), `body ${i} is present`);
      assert.equal(peak, 1, `archive opened ${peak} upstream bodies simultaneously`);
      assert.equal(active, 0);
    } finally { r.stream.destroy(); for (const stream of opened) stream.destroy(); }
  });
  test('cancelling while S3 get is pending destroys the eventual body', { timeout: 4000 }, async () => {
    const requested = deferred<void>(), fetched = deferred<MediaBody>(), destroyed = deferred<void>();
    const lateBody = new Readable({ read() {}, destroy(error, cb) { destroyed.resolve(); cb(error); } });
    install(async () => { requested.resolve(); return fetched.promise; });
    const r = response();
    const download = zipPhotosToResponse(r.res, 'S3 party', rows);
    try {
      await bounded(requested.promise, 'S3 request');
      r.stream.destroy();
      await bounded(r.closed, 'cancelled response');
      fetched.resolve(body(lateBody));
      await bounded(destroyed.promise, 'late S3 body cleanup');
      assert.equal(lateBody.destroyed, true);
      await bounded(download, 'cancelled zip handler');
    } finally { lateBody.destroy(); r.stream.destroy(); await bounded(download, 'cleanup handler'); }
  });
}
