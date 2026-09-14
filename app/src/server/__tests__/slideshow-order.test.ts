// What a slideshow is made of, in what order, and how long it is allowed to take.
//
// There is no cap any more: if the host wants all 300 photos they get all 300. What that removes is
// a `slice(0, 60)` that used to answer two questions at once — which photos survived, and what
// order they played in — and answered the first one by accident, binning the end of a long night.
// What it ADDS is a time problem: the flat five-minute ffmpeg kill was survivable at 60 items and
// would have made the big renders the only ones that reliably died. So the order still has to be
// exactly what was asked for, favourites must NOT quietly float to the front now that there is no
// cut for them to survive, and the budget has to grow with the film.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { seededShuffle, orderForRender, orderOf, encodeTimeoutMs } from '../slideshow';

type Shot = { id: number; isFavourite: boolean };
const shots = (n: number, favourites: number[] = []): Shot[] =>
  Array.from({ length: n }, (_, i) => ({ id: i, isFavourite: favourites.includes(i) }));
const ids = (xs: Shot[]) => xs.map((x) => x.id);

describe('order choice', () => {
  test('anything that is not "shuffled" is the chronological default', () => {
    assert.equal(orderOf(undefined), 'chronological');
    assert.equal(orderOf('chronological'), 'chronological');
    assert.equal(orderOf('nonsense'), 'chronological');
    assert.equal(orderOf('shuffled'), 'shuffled');
  });
  test('chronological keeps the order the query gave (taken_at, start → end)', () => {
    const all = shots(10);
    assert.deepEqual(ids(orderForRender(all, 'chronological', 'job-1')), ids(all));
  });
  test('it copies rather than sorting the caller’s array in place', () => {
    const all = shots(10);
    orderForRender(all, 'shuffled', 'job-1');
    assert.deepEqual(ids(all), ids(shots(10)));
  });
});

describe('nothing is left out', () => {
  test('a 92-photo event renders all 92, in the order it happened', () => {
    const all = shots(92, [91]);
    const chosen = orderForRender(all, 'chronological', 'job-1');
    assert.equal(chosen.length, 92);
    assert.deepEqual(ids(chosen), ids(all));
  });
  test('400 photos is 400 photos', () => {
    assert.equal(orderForRender(shots(400), 'chronological', 'job-1').length, 400);
    assert.equal(orderForRender(shots(400), 'shuffled', 'job-1').length, 400);
  });
  test('a favourite at the end of the night stays at the end of the night', () => {
    // It used to be promoted, but only ever to survive the cut. With no cut, promoting it would
    // silently move the last photo of the night to the front of the film.
    const chosen = orderForRender(shots(92, [91]), 'chronological', 'job-1');
    assert.equal(ids(chosen).at(-1), 91);
    assert.deepEqual(ids(chosen), [...ids(chosen)].sort((a, b) => a - b));
  });
  test('starring most of the roll changes nothing about the order', () => {
    const favourites = Array.from({ length: 70 }, (_, i) => i + 22);
    const all = shots(92, favourites);
    assert.deepEqual(ids(orderForRender(all, 'chronological', 'job-1')), ids(all));
  });
});

describe('the shuffle is deterministic per render', () => {
  test('the same seed deals the same order every time', () => {
    const all = shots(40);
    assert.deepEqual(ids(seededShuffle(all, 'job-1')), ids(seededShuffle(all, 'job-1')));
    assert.deepEqual(
      ids(orderForRender(all, 'shuffled', 'job-1')),
      ids(orderForRender(all, 'shuffled', 'job-1')),
    );
  });
  test('a different render (a different seed) deals a different order', () => {
    const all = shots(40);
    assert.notDeepEqual(ids(seededShuffle(all, 'job-1')), ids(seededShuffle(all, 'job-2')));
  });
  test('it is a permutation — nothing is lost or duplicated, at any size', () => {
    for (const n of [40, 400]) {
      const all = shots(n);
      assert.deepEqual([...ids(seededShuffle(all, 'job-1'))].sort((a, b) => a - b), ids(all));
    }
  });
  test('a shuffle of nothing, or of one, is not a crash', () => {
    assert.deepEqual(seededShuffle([], 'job-1'), []);
    assert.deepEqual(ids(seededShuffle(shots(1), 'job-1')), [0]);
  });
});

describe('the encode budget grows with the work', () => {
  // The budget is applied per CHUNK now, not to the whole film. A chunk is at most 20s of 4K, and
  // that measured ~18s to encode in this container — so the five-minute floor alone is already
  // about 16× what a chunk needs, and the scaling part only matters for the long final mux pass.
  test('a chunk-sized span gets the five-minute floor', () => {
    assert.equal(encodeTimeoutMs(20, '4k'), 5 * 60_000);
    assert.equal(encodeTimeoutMs(0, '4k'), 5 * 60_000);
  });
  test('a longer span buys more time, without exception', () => {
    assert.ok(encodeTimeoutMs(300, '4k') < encodeTimeoutMs(600, '4k'));
    assert.ok(encodeTimeoutMs(600, '4k') < encodeTimeoutMs(1200, '4k'));
  });
  test('a long film outgrows the flat five minutes the old code would have killed it with', () => {
    assert.ok(encodeTimeoutMs(600, '4k') > 5 * 60_000);
    assert.ok(encodeTimeoutMs(965, '4k') > 5 * 60_000);   // the 400-photo film
  });
  test('clips cost more than stills, because they run longer', () => {
    // Ten 6s clips are 60s of film against ten 3s stills at 30s — same item count, different work.
    assert.ok(encodeTimeoutMs(1200, '4k') > encodeTimeoutMs(600, '4k'));
  });
  test('1080p is cheaper to encode, and its budget says so', () => {
    assert.ok(encodeTimeoutMs(1200, '1080p') < encodeTimeoutMs(1200, '4k'));
  });
  test('an unknown resolution is budgeted as the 4K default, never as the cheap one', () => {
    assert.equal(encodeTimeoutMs(1200, undefined), encodeTimeoutMs(1200, '4k'));
    assert.equal(encodeTimeoutMs(1200, 'nonsense'), encodeTimeoutMs(1200, '4k'));
  });
  test('it clears the measured rate several times over', () => {
    // 4K measured 0.89x real time here. A run would have to be three times slower than measured
    // before the budget killed it — which is the point: it is not a performance limit.
    assert.ok(encodeTimeoutMs(600, '4k') / 1000 > 600 * 0.89 * 3);
  });
});
