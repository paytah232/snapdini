// The analytics ingest is a PUBLIC write endpoint, which is the only reason these tests exist.
// Three things have to hold or the feature becomes a liability rather than a measurement:
// names cannot be arbitrary, props cannot carry a payload, and a path cannot carry a credential.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isEventName, cleanProps, cleanPath, visitKey, EVENT_NAMES } from '../analytics';

describe('event names come from the allowlist', () => {
  test('a known name is accepted', () => { assert.equal(isEventName('page_view'), true); });
  test('an unknown name is refused', () => { assert.equal(isEventName('page_view; DROP TABLE'), false); });
  test('non-strings are refused', () => {
    for (const v of [null, undefined, 1, {}, [], true]) assert.equal(isEventName(v), false);
  });
  test('every documented name really is allowed', () => {
    for (const n of EVENT_NAMES) assert.equal(isEventName(n), true, n);
  });
});

describe('props cannot be used to smuggle anything', () => {
  test('scalars survive', () => {
    assert.deepEqual(cleanProps({ tier: '60', shots: 12, paid: true }), { tier: '60', shots: 12, paid: true });
  });
  test('nested objects and arrays are dropped', () => {
    assert.deepEqual(cleanProps({ a: { b: 1 }, c: [1, 2] }), {});
  });
  test('a long value is truncated, not rejected wholesale', () => {
    const out = cleanProps({ q: 'x'.repeat(500) });
    assert.equal((out.q as string).length, 120);
  });
  test('keys are constrained, so nothing exotic reaches jsonb', () => {
    assert.deepEqual(cleanProps({ 'Not-Valid': 1, '': 1, ['a'.repeat(40)]: 1, ok_key: 2 }), { ok_key: 2 });
  });
  test('the number of props is capped', () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 50; i++) many[`k${i}`] = i;
    assert.equal(Object.keys(cleanProps(many)).length, 8);
  });
  test('a non-object is simply empty', () => {
    for (const v of [null, 'x', 5, [1]]) assert.deepEqual(cleanProps(v), {});
  });
  test('NaN and Infinity do not reach the column', () => {
    assert.deepEqual(cleanProps({ a: NaN, b: Infinity, c: 1 }), { c: 1 });
  });
});

describe('paths are reduced to a route pattern, never a URL with a secret in it', () => {
  test('the query string is dropped — it is where the credentials are', () => {
    assert.equal(cleanPath('/admin/ABC12345?code=deadbeefdeadbeefdeadbeefdeadbeef'), '/admin/:code');
  });
  test('the fragment is dropped — the organizer code travels in the hash', () => {
    assert.equal(cleanPath('/admin/ABC12345#deadbeefdeadbeefdeadbeefdeadbeef'), '/admin/:code');
  });
  test('join codes are collapsed', () => { assert.equal(cleanPath('/join/EPZ8MYF2'), '/join/:code'); });
  test('uuids are collapsed', () => {
    assert.equal(cleanPath('/gallery/7ecd750d-4b62-4391-bfe1-55a205962c39'), '/gallery/:id');
  });
  test('a 32-hex token anywhere is collapsed', () => {
    assert.equal(cleanPath('/admin/deadbeefdeadbeefdeadbeefdeadbeef'), '/admin/:token');
  });
  test('anything that is not a path is refused', () => {
    for (const v of ['https://evil.test/x', 'javascript:alert(1)', '', null, 7]) assert.equal(cleanPath(v), null);
  });
});

describe('the visit key groups without identifying', () => {
  test('the same visitor within a day gets the same key', () => {
    assert.equal(visitKey('203.0.113.9', 'UA/1'), visitKey('203.0.113.9', 'UA/1'));
  });
  test('a different address gets a different key', () => {
    assert.notEqual(visitKey('203.0.113.9', 'UA/1'), visitKey('203.0.113.10', 'UA/1'));
  });
  test('a different browser gets a different key', () => {
    assert.notEqual(visitKey('203.0.113.9', 'UA/1'), visitKey('203.0.113.9', 'UA/2'));
  });
  test('no IP means no key at all, rather than a shared bucket', () => {
    assert.equal(visitKey(undefined, 'UA/1'), null);
  });
  test('the key is a short hash and contains nothing of the input', () => {
    const k = visitKey('203.0.113.9', 'Mozilla/5.0')!;
    assert.match(k, /^[0-9a-f]{32}$/);
    assert.ok(!k.includes('203'));
  });
});
