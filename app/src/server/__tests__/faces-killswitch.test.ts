// The face-matching kill switch.
//
// This feature is deliberately built but NOT enabled: it carries legal review obligations that are
// still open. MACHINE_LEARNING_URL is the single switch that keeps
// it inert, so it is worth testing like a safety interlock rather than a config flag. The failure
// that matters is the quiet one — the switch off, but a stale `face_matching_enabled = true` left
// on an events row still putting the UI in front of guests.
//
// Every test that says "nothing was sent to the ML server" hands detectFaces a REAL image on disk
// and counts calls to fetch. Both matter. A path that does not exist returns [] one line before
// fetch is reached, so an interlock test pointed at /nonexistent.jpg passes with the kill switch
// deleted; and detectFaces swallows every error and returns [], so the RESULT cannot tell a call
// that was never made from one that was made and threw. Only the call count can.
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const ENV = { ...process.env };
after(() => { process.env = { ...ENV }; });

// A real, readable JPEG: sharp parses it, orientedJpeg produces bytes, and the only thing left
// between that and the network is the kill switch itself.
const IMAGE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'faces-killswitch-')), 'photo.jpg');
before(async () => {
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#888888' } }).jpeg().toFile(IMAGE);
});
after(() => { fs.rmSync(path.dirname(IMAGE), { recursive: true, force: true }); });

async function withUrl(url: string | undefined) {
  if (url === undefined) delete process.env.MACHINE_LEARNING_URL;
  else process.env.MACHINE_LEARNING_URL = url;
  return await import('../faces');
}

/** Run `fn` with fetch replaced, and report what it was asked for. */
async function watchingFetch<T>(
  fn: () => Promise<T>,
  reply: (url: string) => unknown = () => { throw new Error('must not reach the ML server'); },
): Promise<{ result: T; calls: string[] }> {
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => { calls.push(String(u)); return reply(String(u)); }) as unknown as typeof fetch;
  try {
    return { result: await fn(), calls };
  } finally { globalThis.fetch = orig; }
}

describe('off — no MACHINE_LEARNING_URL', () => {
  test('reports unavailable', async () => {
    const f = await withUrl(undefined);
    assert.equal(f.faceMatchingAvailable(), false);
  });

  test('an empty or whitespace value is still off, not a URL of ""', async () => {
    assert.equal((await withUrl('')).faceMatchingAvailable(), false);
    assert.equal((await withUrl('   ')).faceMatchingAvailable(), false);
  });

  test('a real photo is not sent anywhere, and yields nothing to match against', async () => {
    const f = await withUrl(undefined);
    const { result, calls } = await watchingFetch(() => f.detectFaces(IMAGE));
    assert.deepEqual(calls, [], 'the image was sent to the ML server with the switch off');
    assert.deepEqual(result, []);
  });

  test('an enrolled guest and a real photo still produce no call and no links', async () => {
    const f = await withUrl(undefined);
    const { result, calls } = await watchingFetch(() => f.matchAgainstEnrolled(IMAGE,
      [{ participantId: 'p1', embedding: new Array(512).fill(0.1) }]));
    assert.deepEqual(calls, [], 'matching a photo against an enrolled guest reached the ML server');
    assert.deepEqual(result, []);
  });

  test('a selfie is not embedded either — enrolment is off with the rest of it', async () => {
    const f = await withUrl(undefined);
    const { result, calls } = await watchingFetch(() => f.embedSelfie(IMAGE));
    assert.deepEqual(calls, [], 'a selfie was sent to the ML server with the switch off');
    assert.equal(result, null);
  });
});

describe('on — MACHINE_LEARNING_URL set', () => {
  test('reports available', async () => {
    assert.equal((await withUrl('http://ml:3003')).faceMatchingAvailable(), true);
  });

  test('a real photo IS sent — which is what makes the tests above mean something', async () => {
    // The interlock tests are only worth anything if the same call, with the switch on, gets
    // through. This is that control.
    const f = await withUrl('http://ml:3003');
    const { calls } = await watchingFetch(() => f.detectFaces(IMAGE));
    assert.deepEqual(calls, ['http://ml:3003/predict']);
  });

  test('a trailing slash does not produce a double-slashed endpoint', async () => {
    const f = await withUrl('http://ml:3003/');
    assert.equal(f.faceMatchingAvailable(), true);
    const { calls } = await watchingFetch(() => f.detectFaces(IMAGE));
    assert.deepEqual(calls, ['http://ml:3003/predict'], 'the trailing slash survived into the endpoint');
  });

  test('a refusal from the ML server is not an upload failure', async () => {
    // Face matching is a nicety bolted onto the upload path. Whatever the ML server says, the
    // answer here is "no faces", never a throw.
    const f = await withUrl('http://ml:3003');
    const { result, calls } = await watchingFetch(
      () => f.detectFaces(IMAGE),
      () => ({ ok: false, status: 503, json: async () => ({}) }),
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(result, []);
  });
});
