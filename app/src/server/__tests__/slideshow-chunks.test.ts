// The rules that make a chunked encode look like one continuous film.
//
// A slideshow is no longer one ffmpeg run — measured in this container, one graph over 32 photos at
// 4K peaked at 9.9 GB and climbed ~86 MB for every further second of film, against a container with
// no memory limit. So the film is cut into runs and joined. The whole risk of doing that is the
// crossfades: a fade split across a join is a visible cut, and a visible cut is a failure, not a
// trade. Three invariants keep it honest, and they are all integer-frame arithmetic — a 0.6s fade
// rounded one way on one side of a join and the other way on the other side is a stutter that only
// appears at some item counts.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, planChunks, buildChunkArgs, canvasFor, type Timeline } from '../slideshow';

const FPS = 30, T = 0.6;
const stills = (n: number, secs = 3) => new Array(n).fill(secs);
const globals = (tl: Timeline, chunks: ReturnType<typeof planChunks>) =>
  chunks.map((c) => ({ start: tl.offset[c.from] + c.startFrame, end: tl.offset[c.from] + c.endFrame, c }));

describe('the timeline is exact, in frames', () => {
  test('total frames is the sum of the holds minus the overlaps', () => {
    const tl = buildTimeline(stills(20), FPS, T);
    const sum = tl.frames.reduce((a, b) => a + b, 0) - tl.fade.reduce((a, b) => a + b, 0);
    assert.equal(tl.totalFrames, sum);
    assert.equal(tl.frames[0], 90);   // 3s at 30fps, exactly
    assert.ok(tl.fade.every((f) => f === 18));   // 0.6s at 30fps, exactly
  });
  test('every item keeps at least one frame of its own between its two fades', () => {
    // This is what guarantees a chunk boundary always has somewhere safe to land.
    for (const durs of [stills(10, 2), stills(10, 8), [3, 1, 3, 1, 3], [2, 2, 2], [1, 1, 1, 1]]) {
      const tl = buildTimeline(durs, FPS, T);
      for (let i = 0; i < tl.frames.length; i++) {
        const inFade = i > 0 ? tl.fade[i - 1] : 0, outFade = i < tl.fade.length ? tl.fade[i] : 0;
        assert.ok(tl.frames[i] - inFade - outFade >= 1, `item ${i} of ${JSON.stringify(durs)} has no hold`);
      }
    }
  });
  test('a clip too short for a full fade shortens that junction rather than breaking', () => {
    // A 1s clip cannot give 0.6s to the fade on each side. Padding it would freeze a frame;
    // overlapping the two fades would corrupt the graph. It gets shorter fades instead.
    const tl = buildTimeline([3, 3, 1, 3, 3], FPS, T);
    assert.deepEqual(tl.fade, [18, 14, 14, 18]);
    assert.equal(tl.frames[2], 30);
  });
  test('one item is a timeline with no fades at all', () => {
    const tl = buildTimeline([4], FPS, T);
    assert.deepEqual(tl.fade, []);
    assert.equal(tl.totalFrames, 120);
  });
});

describe('chunks tile the film exactly once', () => {
  const cases: [number, number, number][] = [[2, 4, 600], [3, 2, 600], [9, 4, 600], [20, 5, 600], [97, 7, 600], [400, 12, 600]];
  for (const [n, maxItems, maxFrames] of cases) {
    test(`${n} items, ≤${maxItems} per chunk: contiguous, no gap, no overlap`, () => {
      const tl = buildTimeline(stills(n), FPS, T);
      const g = globals(tl, planChunks(tl, maxItems, maxFrames));
      assert.equal(g[0].start, 0, 'the film must start at frame 0');
      assert.equal(g[g.length - 1].end, tl.totalFrames, 'the film must end at the last frame');
      for (let i = 1; i < g.length; i++) assert.equal(g[i].start, g[i - 1].end, `gap or overlap at join ${i}`);
      for (const x of g) assert.ok(x.end > x.start, 'a chunk must produce frames');
    });
  }
  test('a single item is one chunk, whole', () => {
    const tl = buildTimeline([3], FPS, T);
    const chunks = planChunks(tl, 12, 600);
    assert.deepEqual(chunks, [{ from: 0, to: 0, startFrame: 0, endFrame: 90 }]);
  });
});

describe('no crossfade is ever split across a join', () => {
  for (const [n, maxItems, maxFrames] of [[20, 5, 600], [13, 4, 600], [97, 7, 600], [400, 12, 600]] as [number, number, number][]) {
    test(`${n} items, ≤${maxItems} per chunk`, () => {
      const tl = buildTimeline(stills(n), FPS, T);
      const g = globals(tl, planChunks(tl, maxItems, maxFrames));
      for (let j = 0; j < tl.fade.length; j++) {
        const from = tl.offset[j] + tl.frames[j] - tl.fade[j], to = tl.offset[j] + tl.frames[j];
        const home = g.find((x) => from >= x.start && to <= x.end);
        assert.ok(home, `fade ${j} (frames ${from}–${to}) straddles a chunk boundary`);
      }
    });
  }
  test('a chunk always spans at least two items, so a join is never inside a fade by accident', () => {
    const tl = buildTimeline(stills(40), FPS, T);
    for (const c of planChunks(tl, 12, 600)) assert.ok(c.to > c.from);
  });
});

describe('chunks stay inside the memory budget they were given', () => {
  test('no chunk produces more film than the frame budget allows', () => {
    const tl = buildTimeline(stills(200), FPS, T);
    for (const maxFrames of [90, 300, 600]) {
      for (const c of planChunks(tl, 12, maxFrames)) {
        // A chunk must hold at least one whole junction, so a two-item chunk is the floor and a
        // budget below it cannot be met. Every chunk bigger than the floor must obey the budget.
        const span = c.endFrame - c.startFrame;
        assert.ok(span <= maxFrames || c.to - c.from === 1,
          `chunk span ${span} over budget ${maxFrames} with ${c.to - c.from + 1} items`);
      }
    }
  });
  test('with the real 4K limits, the budget always binds', () => {
    // 20s per chunk at 30fps against the longest an item may be shown (8s) — the two-item floor is
    // 16s, so nothing ever escapes the budget in production.
    for (const secs of [2, 3, 5, 8]) {
      const tl = buildTimeline(stills(120, secs), FPS, T);
      for (const c of planChunks(tl, 12, 20 * FPS)) {
        assert.ok(c.endFrame - c.startFrame <= 20 * FPS, `${secs}s items: chunk span over 20s`);
      }
    }
  });
  test('a tiny budget still terminates, one junction at a time', () => {
    const tl = buildTimeline(stills(30), FPS, T);
    const chunks = planChunks(tl, 2, 1);
    assert.equal(chunks.length, 29);
    assert.equal(globals(tl, chunks).at(-1)!.end, tl.totalFrames);
  });
});

describe('every chunk is encoded with identical codec settings', () => {
  test('because the concat demuxer joins by trusting they match', () => {
    const tl = buildTimeline(stills(40), FPS, T);
    const items = tl.frames.map((_, i) => ({ path: `/tmp/${i}.jpg`, isVideo: false }));
    const profile = { W: 3840, H: 2160, crf: 20, preset: 'veryfast', fps: FPS, padColor: 'black', threads: 8 };
    const codecOf = (a: string[]) => {
      const keys = ['-c:v', '-pix_fmt', '-r', '-preset', '-crf', '-f'];
      return keys.map((k) => `${k}=${a[a.indexOf(k) + 1]}`).join(' ');
    };
    const sets = planChunks(tl, 7, 600).map((c, i) => codecOf(buildChunkArgs(items, tl, c, profile, `/tmp/p${i}.ts`)));
    assert.equal(new Set(sets).size, 1, `chunks disagree on codec settings: ${[...new Set(sets)].join(' | ')}`);
    assert.match(sets[0], /-f=mpegts/);
  });
  test('chunks carry no audio — the music is laid over the joined film instead', () => {
    const tl = buildTimeline(stills(8), FPS, T);
    const items = tl.frames.map((_, i) => ({ path: `/tmp/${i}.jpg`, isVideo: false }));
    const args = buildChunkArgs(items, tl, planChunks(tl, 4, 600)[0],
      { W: 1920, H: 1080, crf: 20, preset: 'veryfast', fps: FPS, padColor: 'black', threads: 8 }, '/tmp/p.ts');
    assert.ok(args.includes('-an'), 'a chunk that carries audio clicks at every join');
  });
  test('a chunk opens only its own items, not the whole event', () => {
    const tl = buildTimeline(stills(400), FPS, T);
    const items = tl.frames.map((_, i) => ({ path: `/tmp/${i}.jpg`, isVideo: false }));
    const chunk = planChunks(tl, 12, 600)[0];
    const args = buildChunkArgs(items, tl, chunk, { W: 3840, H: 2160, crf: 20, preset: 'veryfast', fps: FPS, padColor: 'black', threads: 8 }, '/tmp/p.ts');
    assert.equal(args.filter((a) => a === '-i').length, chunk.to - chunk.from + 1);
  });
});

describe('4K is not used to enlarge photos that are not 4K', () => {
  const hd = { width: 1920, height: 1080 }, portrait = { width: 1080, height: 1920 }, big = { width: 4032, height: 3024 };
  test('all sources inside 1080p → rendered at 1080p', () => {
    const c = canvasFor('4k', [hd, portrait, hd]);
    assert.deepEqual(c, { w: 1920, h: 1080, downgraded: true });
  });
  test('one bigger photo keeps the big canvas, because that one would lose detail', () => {
    assert.equal(canvasFor('4k', [hd, big]).downgraded, false);
    assert.equal(canvasFor('4k', [hd, big]).w, 3840);
  });
  test('unknown dimensions are never assumed small', () => {
    assert.equal(canvasFor('4k', [hd, { width: null, height: null }]).downgraded, false);
    assert.equal(canvasFor('4k', []).downgraded, false);
  });
  test('asking for 1080p is never upgraded', () => {
    assert.deepEqual(canvasFor('1080p', [big]), { w: 1920, h: 1080, downgraded: false });
  });
});
