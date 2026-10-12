// The storage contract, run against BOTH drivers.
//
// Everything above this layer — ingest, the sibling ladder, the zip, the purge, the serving
// handler — is written once against MediaStore and must behave the same wherever the bytes live.
// So the contract is pinned here, once, and each driver has to pass all of it: the local driver
// against a temp directory, the s3 driver against an in-process stub so no network, container or
// credential is involved. A difference between the two drivers is a bug in one of them, and this
// is where it shows up before a migration does.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { LocalStore } from '../media/local';
import { S3Store } from '../media/s3';
import type { MediaStore } from '../media/types';
import { assertKey, assertPrefix, keyFromWebPath, isTempName, contentTypeFor } from '../media/keys';
import { serveUploads, parseRange } from '../media/serve';
import { startS3Stub, type S3Stub } from './helpers/s3-stub';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdini-media-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const read = async (s: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

describe('keys', () => {
  test('accepts the shapes the database holds', () => {
    assert.equal(assertKey('ab12cd34/9f8e7d6c.jpg'), 'ab12cd34/9f8e7d6c.jpg');
    assert.equal(assertKey('/ab12cd34/9f8e7d6c_thumb.webp'), 'ab12cd34/9f8e7d6c_thumb.webp');
    assert.equal(assertKey('feedback/x.jpg'), 'feedback/x.jpg');
    assert.equal(assertKey('legacy-flat.jpg'), 'legacy-flat.jpg');
    assert.equal(assertKey('themes/header.v2.webp'), 'themes/header.v2.webp');
    assert.equal(keyFromWebPath('/uploads/ev/a.jpg'), 'ev/a.jpg');
  });
  for (const bad of ['../etc/passwd', 'ev/../../etc/passwd', 'ev/..', '', 'ev/', '/uploads/../x', 'ev/a b.jpg', 'ev/.hidden', 'a/b/../c']) {
    test(`refuses ${JSON.stringify(bad)}`, () => { assert.throws(() => assertKey(bad), /unsafe media key/); });
  }
  test('prefixes', () => {
    assert.equal(assertPrefix('ev1'), 'ev1');
    assert.equal(assertPrefix('/ev1/'), 'ev1');
    assert.equal(assertPrefix(''), '');
    assert.throws(() => assertPrefix('..'), /unsafe media prefix/);
    assert.throws(() => assertPrefix('a/../b'), /unsafe media prefix/);
  });
  test('temp names never publish', () => {
    for (const n of ['x.jpg.tmp.mp4', 'x_crop.mp4.raw.mp4', 'x.mp4.sync.mp4', 'x.mp4.rot.mp4', 'x.mp4.turn.mp4', '.x.jpg.ab12.part', '.incoming'])
      assert.equal(isTempName(n), true, n);
    for (const n of ['x.jpg', 'x_thumb.webp', 'x_play.mp4', 'slideshow-abc.mp4', 'audio-1.mp3']) assert.equal(isTempName(n), false, n);
  });
  test('content types', () => {
    assert.equal(contentTypeFor('a.jpg'), 'image/jpeg');
    assert.equal(contentTypeFor('a_thumb.webp'), 'image/webp');
    assert.equal(contentTypeFor('a_play.mp4'), 'video/mp4');
    assert.equal(contentTypeFor('a.unknownext'), 'application/octet-stream');
  });
});

describe('parseRange', () => {
  test('forms', () => {
    assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
    assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=0-500', 100), { start: 0, end: 99 });
    assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
    assert.equal(parseRange('bytes=5-2', 100), 'unsatisfiable');
    assert.equal(parseRange('items=0-1', 100), null);
    assert.equal(parseRange(undefined, 100), null);
    assert.equal(parseRange('bytes=0-1,5-6', 100), null);
  });
});

function contract(name: string, make: () => Promise<{ store: MediaStore; close(): Promise<void> }>) {
  describe(`${name} driver`, () => {
    let store: MediaStore;
    let close: () => Promise<void>;
    before(async () => { ({ store, close } = await make()); });
    after(async () => { await close(); });

    test('put / stat / get / exists round-trip', async () => {
      const body = Buffer.from('hello media');
      await store.put('ev1/a.jpg', body);
      assert.equal(await store.exists('ev1/a.jpg'), true);
      const st = await store.stat('ev1/a.jpg');
      assert.ok(st);
      assert.equal(st!.size, body.length);
      assert.ok(st!.etag);
      assert.equal(st!.contentType, 'image/jpeg');
      const got = await store.get('ev1/a.jpg');
      assert.ok(got);
      assert.equal((await read(got!.stream)).toString(), 'hello media');
      assert.equal(got!.size, body.length);
      assert.equal(await store.exists('ev1/missing.jpg'), false);
      assert.equal(await store.stat('ev1/missing.jpg'), null);
      assert.equal(await store.get('ev1/missing.jpg'), null);
    });

    test('put from a stream of unknown length, and from a local file with move', async () => {
      await store.put('ev1/s.txt', Readable.from([Buffer.from('ab'), Buffer.from('cd')]));
      assert.equal((await read((await store.get('ev1/s.txt'))!.stream)).toString(), 'abcd');
      const staged = path.join(TMP, `${name}-staged.jpg`);
      fs.writeFileSync(staged, 'from disk');
      await store.put('ev1/m.jpg', staged, { move: true });
      assert.equal(fs.existsSync(staged), false, 'the source is gone after a move');
      assert.equal((await read((await store.get('ev1/m.jpg'))!.stream)).toString(), 'from disk');
      const kept = path.join(TMP, `${name}-kept.jpg`);
      fs.writeFileSync(kept, 'copied');
      await store.put('ev1/c.jpg', kept);
      assert.equal(fs.existsSync(kept), true, 'a plain put leaves the source alone');
    });

    test('overwriting a key replaces the bytes', async () => {
      await store.put('ev1/o.jpg', Buffer.from('one'));
      await store.put('ev1/o.jpg', Buffer.from('two!'));
      const st = await store.stat('ev1/o.jpg');
      assert.equal(st!.size, 4);
      assert.equal((await read((await store.get('ev1/o.jpg'))!.stream)).toString(), 'two!');
    });

    test('Range reads', async () => {
      await store.put('ev1/r.bin', Buffer.from('0123456789'));
      const a = await store.get('ev1/r.bin', { range: { start: 2, end: 4 } });
      assert.deepEqual(a!.range, { start: 2, end: 4, total: 10 });
      assert.equal((await read(a!.stream)).toString(), '234');
      assert.equal(a!.size, 3);
      const b = await store.get('ev1/r.bin', { range: { start: 7 } });
      assert.equal((await read(b!.stream)).toString(), '789');
      const c = await store.get('ev1/r.bin', { range: { start: 0, end: 500 } });
      assert.equal((await read(c!.stream)).toString(), '0123456789');
      assert.equal(await store.get('ev1/r.bin', { range: { start: 10 } }), null, 'past the end is unsatisfiable');
    });

    test('a multipart-sized object goes up and comes back intact', async () => {
      // Over two 16 MB parts, so the s3 driver takes the multipart path; the local driver just
      // streams. 33 MB of a repeating pattern keeps the check cheap.
      const size = 33 * 1024 * 1024;
      const pattern = Buffer.alloc(64 * 1024);
      for (let i = 0; i < pattern.length; i++) pattern[i] = i % 251;
      const chunks = Math.ceil(size / pattern.length);
      await store.put('ev1/big.mp4', Readable.from((function* () { for (let i = 0; i < chunks; i++) yield pattern; })()));
      const st = await store.stat('ev1/big.mp4');
      assert.equal(st!.size, chunks * pattern.length);
      const tail = await store.get('ev1/big.mp4', { range: { start: st!.size - 5 } });
      const got = await read(tail!.stream);
      assert.equal(got.length, 5);
      assert.equal(got[4], (pattern.length - 1) % 251);
    });

    test('list is names directly under a prefix, files only; listDirs is the folders', async () => {
      await store.put('ev2/x.jpg', Buffer.from('x'));
      await store.put('ev2/x_thumb.webp', Buffer.from('t'));
      await store.put('ev3/y.jpg', Buffer.from('y'));
      assert.deepEqual(await store.list('ev2'), ['x.jpg', 'x_thumb.webp']);
      assert.deepEqual(await store.list('nope'), []);
      const dirs = await store.listDirs('');
      for (const d of ['ev1', 'ev2', 'ev3']) assert.ok(dirs.includes(d), `listDirs has ${d}`);
      assert.ok(!(await store.list('')).includes('x.jpg'), 'a nested file is not a root file');
    });

    test('paging through a listing longer than one page', async () => {
      for (let i = 0; i < 7; i++) await store.put(`ev4/f${i}.jpg`, Buffer.from(String(i)));
      const names = await store.list('ev4');
      assert.deepEqual(names, [0, 1, 2, 3, 4, 5, 6].map((i) => `f${i}.jpg`));
    });

    test('delete is idempotent; deletePrefix empties a folder and refuses the root', async () => {
      await store.put('ev5/a.jpg', Buffer.from('a'));
      await store.put('ev5/b.jpg', Buffer.from('b'));
      await store.delete('ev5/a.jpg');
      await store.delete('ev5/a.jpg');
      assert.equal(await store.exists('ev5/a.jpg'), false);
      assert.equal(await store.exists('ev5/b.jpg'), true);
      for (let i = 0; i < 6; i++) await store.put(`ev5/p${i}.jpg`, Buffer.from('p'));
      const n = await store.deletePrefix('ev5');
      assert.equal(n, 7);
      assert.deepEqual(await store.list('ev5'), []);
      await assert.rejects(() => store.deletePrefix(''), /refusing/);
      assert.equal(await store.exists('ev1/a.jpg'), true, 'nothing outside the prefix went');
    });

    test('copy', async () => {
      await store.put('ev6/src.jpg', Buffer.from('copy me'));
      await store.copy('ev6/src.jpg', 'ev6/dst.jpg');
      assert.equal((await read((await store.get('ev6/dst.jpg'))!.stream)).toString(), 'copy me');
      assert.equal(await store.exists('ev6/src.jpg'), true);
    });

    test('keys outside the grammar are refused before anything touches storage', async () => {
      await assert.rejects(() => store.put('../escape.jpg', Buffer.from('x')), /unsafe/);
      await assert.rejects(() => store.get('ev1/../../etc/passwd'), /unsafe/);
      await assert.rejects(() => store.delete('ev1/..'), /unsafe/);
    });

    describe('checkout', () => {
      test('adopt a staged file, work on it, publish, release', async () => {
        const staged = path.join(TMP, `${name}-adopt.jpg`);
        fs.writeFileSync(staged, 'original');
        const co = await store.checkout('ev7', { adopt: [{ name: 'u.jpg', from: staged }] });
        assert.equal(fs.existsSync(staged), false, 'adopted = moved');
        assert.equal(fs.readFileSync(co.path('u.jpg'), 'utf8'), 'original');
        // A tool writes a sibling beside it and rewrites the original in place.
        fs.writeFileSync(co.path('u_thumb.webp'), 'thumb');
        fs.writeFileSync(co.path('u.jpg'), 'stripped');
        fs.writeFileSync(co.path('u.jpg.tmp.jpg'), 'half-written');   // never published
        await co.publish(['u.jpg', 'u_thumb.webp']);
        assert.equal((await read((await store.get('ev7/u.jpg'))!.stream)).toString(), 'stripped');
        assert.equal((await read((await store.get('ev7/u_thumb.webp'))!.stream)).toString(), 'thumb');
        assert.equal(await store.exists('ev7/u.jpg.tmp.jpg'), false);
        await co.release();
        await co.release();   // twice is fine
        if (store.driver === 's3') assert.equal(fs.existsSync(co.dir), false, 'nothing transient survives a release');
        else assert.equal(fs.existsSync(co.path('u.jpg')), true, 'the live folder is untouched');
      });

      test('fetch brings the named siblings that exist; publish() with no names sends what changed', async () => {
        await store.put('ev8/v.mp4', Buffer.from('clip'));
        await store.put('ev8/v_crop.mp4', Buffer.from('crop'));
        const co = await store.checkout('ev8');
        const present = await co.fetch(['v.mp4', 'v_crop.mp4', 'v_play.mp4']);
        assert.deepEqual([...present].sort(), ['v.mp4', 'v_crop.mp4']);
        assert.equal(fs.readFileSync(co.path('v_crop.mp4'), 'utf8'), 'crop');
        // Nothing changed yet: a bare publish uploads nothing new (the stub's log proves it below).
        await co.publish();
        fs.writeFileSync(co.path('v_play.mp4'), 'proxy');
        fs.writeFileSync(co.path('v_crop.mp4.raw.mp4'), 'scratch');
        await new Promise((r) => setTimeout(r, 5));
        await co.publish();
        assert.equal((await read((await store.get('ev8/v_play.mp4'))!.stream)).toString(), 'proxy');
        assert.equal(await store.exists('ev8/v_crop.mp4.raw.mp4'), false);
        // fetch() with no names takes the whole folder.
        const co2 = await store.checkout('ev8');
        const all = await co2.fetch();
        assert.deepEqual([...all].sort(), ['v.mp4', 'v_crop.mp4', 'v_play.mp4']);
        await co.remove(['v_crop.mp4']);
        assert.equal(await store.exists('ev8/v_crop.mp4'), false);
        assert.equal(fs.existsSync(co.path('v_crop.mp4')), false);
        await co.release(); await co2.release();
      });

      test('a checkout of an empty prefix is usable', async () => {
        const co = await store.checkout('ev9');
        assert.deepEqual([...await co.fetch()], []);
        fs.writeFileSync(co.path('new.jpg'), 'n');
        await co.publish(['new.jpg']);
        assert.equal(await store.exists('ev9/new.jpg'), true);
        await co.release();
      });

      test('checkout names cannot escape the folder', async () => {
        const co = await store.checkout('ev9');
        assert.throws(() => co.path('../x'), /unsafe/);
        assert.throws(() => co.path('a/b'), /unsafe/);
        await co.release();
      });
    });

    describe('serving', () => {
      let server: http.Server;
      let base: string;
      before(async () => {
        await store.put('evs/p.jpg', Buffer.from('JPEGBYTES'));
        const app = express();
        app.use('/uploads', serveUploads(store));
        app.use((_req, res) => res.status(404).json({ error: 'fallthrough' }));
        server = app.listen(0, '127.0.0.1');
        await new Promise((r) => server.once('listening', r));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      });
      after(() => new Promise<void>((r) => server.close(() => r())));

      test('200 with immutable caching, a validator and the right type', async () => {
        const r = await fetch(`${base}/uploads/evs/p.jpg`);
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
        assert.equal(r.headers.get('content-type'), 'image/jpeg');
        assert.equal(r.headers.get('accept-ranges'), 'bytes');
        assert.equal(r.headers.get('content-length'), '9');
        assert.ok(r.headers.get('etag'));
        assert.equal(await r.text(), 'JPEGBYTES');
      });
      test('304 on a matching ETag', async () => {
        const first = await fetch(`${base}/uploads/evs/p.jpg`);
        const etag = first.headers.get('etag')!;
        const r = await fetch(`${base}/uploads/evs/p.jpg`, { headers: { 'if-none-match': etag } });
        assert.equal(r.status, 304);
      });
      test('206 for a range, 416 past the end', async () => {
        const r = await fetch(`${base}/uploads/evs/p.jpg`, { headers: { range: 'bytes=4-6' } });
        assert.equal(r.status, 206);
        assert.equal(r.headers.get('content-range'), 'bytes 4-6/9');
        assert.equal(await r.text(), 'BYT');
        const bad = await fetch(`${base}/uploads/evs/p.jpg`, { headers: { range: 'bytes=50-' } });
        assert.equal(bad.status, 416);
        assert.equal(bad.headers.get('content-range'), 'bytes */9');
      });
      test('HEAD carries the headers and no body', async () => {
        const r = await fetch(`${base}/uploads/evs/p.jpg`, { method: 'HEAD' });
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('content-length'), '9');
        assert.equal(await r.text(), '');
      });
      test('404 for a missing object, a dotfile, and a traversal; other methods fall through', async () => {
        assert.equal((await fetch(`${base}/uploads/evs/nope.jpg`)).status, 404);
        assert.equal((await fetch(`${base}/uploads/evs/.secret`)).status, 404);
        assert.equal((await fetch(`${base}/uploads/evs/..%2F..%2Fetc%2Fpasswd`)).status, 404);
        const post = await fetch(`${base}/uploads/evs/p.jpg`, { method: 'POST' });
        assert.equal(post.status, 404);
        assert.deepEqual(await post.json(), { error: 'fallthrough' });
      });
    });
  });
}

contract('local', async () => {
  const root = path.join(TMP, 'local-root');
  return { store: new LocalStore(root), close: async () => {} };
});

contract('s3', async () => {
  const stub = await startS3Stub();
  const store = new S3Store({
    endpoint: stub.endpoint, region: 'us-east-1', bucket: stub.bucket,
    accessKey: 'test', secretKey: 'test', forcePathStyle: true, prefix: 'dev',
    workRoot: path.join(TMP, 's3-work'),
    listPageSize: 3,   // small, so the paging tests really page
  });
  return { store, close: async () => { await stub.close(); } };
});

describe('s3 driver specifics', () => {
  let stub: S3Stub;
  let store: S3Store;
  before(async () => {
    stub = await startS3Stub();
    store = new S3Store({
      endpoint: stub.endpoint, region: 'us-east-1', bucket: stub.bucket, accessKey: 't', secretKey: 't',
      forcePathStyle: true, prefix: 'dev', workRoot: path.join(TMP, 's3-work-2'),
    });
  });
  after(async () => { await stub.close(); });

  test('the environment prefix is applied to every key, and only once', async () => {
    await store.put('evp/a.jpg', Buffer.from('a'));
    await store.put('flat.jpg', Buffer.from('f'));
    assert.deepEqual([...stub.objects.keys()].sort(), ['dev/evp/a.jpg', 'dev/flat.jpg']);
    assert.deepEqual(await store.list('evp'), ['a.jpg']);
    assert.deepEqual(await store.list(''), ['flat.jpg']);
    assert.deepEqual(await store.listDirs(''), ['evp']);
  });
  test('a bare publish with nothing changed sends no PUT', async () => {
    await store.put('ev8/v.mp4', Buffer.from('clip'));
    const before = stub.log.filter((l) => l.method === 'PUT').length;
    const co = await store.checkout('ev8', { fetch: ['v.mp4'] });
    await co.publish();
    await co.release();
    assert.equal(stub.log.filter((l) => l.method === 'PUT').length, before);
  });
  test('the content type is set from the key on put', async () => {
    await store.put('evp/t.webp', Buffer.from('w'));
    assert.equal(stub.objects.get('dev/evp/t.webp')!.contentType, 'image/webp');
  });
});
