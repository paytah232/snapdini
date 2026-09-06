// The face-matching kill switch.
//
// This feature is deliberately built but NOT enabled: it carries legal review obligations that are
// still open. MACHINE_LEARNING_URL is the single switch that keeps
// it inert, so it is worth testing like a safety interlock rather than a config flag. The failure
// that matters is the quiet one — the switch off, but a stale `face_matching_enabled = true` left
// on an events row still putting the UI in front of guests.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

const ENV = { ...process.env };
after(() => { process.env = { ...ENV }; });

async function withUrl(url: string | undefined) {
  if (url === undefined) delete process.env.MACHINE_LEARNING_URL;
  else process.env.MACHINE_LEARNING_URL = url;
  return await import('../faces');
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

  test('detection never calls out and yields nothing to match against', async () => {
    const f = await withUrl(undefined);
    const fetchSpy = () => { throw new Error('must not reach the ML server'); };
    const orig = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      assert.deepEqual(await f.detectFaces('/nonexistent.jpg'), []);
    } finally { globalThis.fetch = orig; }
  });

  test('matching a photo against enrolled guests yields no links', async () => {
    const f = await withUrl(undefined);
    const out = await f.matchAgainstEnrolled('/nonexistent.jpg',
      [{ participantId: 'p1', embedding: new Array(512).fill(0.1) }]);
    assert.deepEqual(out, []);
  });
});

describe('on — MACHINE_LEARNING_URL set', () => {
  test('reports available', async () => {
    assert.equal((await withUrl('http://ml:3003')).faceMatchingAvailable(), true);
  });

  test('a trailing slash does not produce a double-slashed endpoint', async () => {
    const f = await withUrl('http://ml:3003/');
    assert.equal(f.faceMatchingAvailable(), true);
    let called = '';
    const orig = globalThis.fetch;
    globalThis.fetch = (async (u: string) => { called = String(u); throw new Error('stop'); }) as unknown as typeof fetch;
    try { await f.detectFaces('/nonexistent.jpg'); } catch { /* expected */ } finally { globalThis.fetch = orig; }
    assert.ok(!called.includes('//predict'), `endpoint was ${called}`);
  });
});
