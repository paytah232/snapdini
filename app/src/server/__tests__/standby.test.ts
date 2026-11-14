// The standby panel's gates. The host runner re-checks everything itself, so these are about the
// console telling the truth fast: never queue work for a runner that is not running, never queue a
// second rebuild on top of one in flight, and never let a malformed runner row take the page down.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus, parseRequest, rebuildDecision, STALE_MS, type StandbyStatus, type RebuildRequest } from '../standby';

const NOW = 1_800_000_000_000;
const status = (o: Partial<StandbyStatus> = {}): StandbyStatus => ({
  checkedAt: NOW - 30_000, healthy: false, summary: 'replication not streaming', checks: [],
  canRebuild: true, blockReason: null, ...o,
});
const request = (state: RebuildRequest['state']): RebuildRequest => ({
  id: 'r1', state, requestedBy: 'a@b.c', requestedAt: NOW - 1000, startedAt: null, finishedAt: null, steps: [], error: null,
});

describe('may a rebuild be requested', () => {
  test('no runner has ever reported: refuse', () => {
    const d = rebuildDecision(null, null, NOW);
    assert.equal(d.ok, false);
  });

  test('a silent runner is not running: refuse rather than queue work nobody will pick up', () => {
    const d = rebuildDecision(status({ checkedAt: NOW - STALE_MS - 1 }), null, NOW);
    assert.ok(!d.ok && /not running/.test(d.error));
    assert.equal(rebuildDecision(status({ checkedAt: NOW - STALE_MS + 1000 }), null, NOW).ok, true);
  });

  test('one rebuild at a time', () => {
    for (const s of ['requested', 'running'] as const) {
      const d = rebuildDecision(status(), request(s), NOW);
      assert.ok(!d.ok && d.error.includes(s));
    }
    for (const s of ['done', 'failed', 'refused'] as const) {
      assert.equal(rebuildDecision(status(), request(s), NOW).ok, true, `a ${s} request does not block the next`);
    }
  });

  test("the runner's own veto is passed through with its reason", () => {
    const d = rebuildDecision(status({ canRebuild: false, blockReason: 'standby is promoted: run a failback, not a rebuild' }), null, NOW);
    assert.ok(!d.ok && d.error === 'standby is promoted: run a failback, not a rebuild');
    const bare = rebuildDecision(status({ canRebuild: false }), null, NOW);
    assert.ok(!bare.ok && bare.error.length > 0, 'a veto without a reason still explains itself');
  });
});

describe('reading what the runner wrote', () => {
  test('malformed rows read as absent, not as a crash', () => {
    for (const raw of [null, '', 'not json', '[]', '{}', '{"checkedAt":"soon"}', 'null']) {
      assert.equal(parseStatus(raw), null, String(raw));
    }
    for (const raw of [null, 'x', '{"id":"a","state":"exploded"}', '{"state":"running"}']) {
      assert.equal(parseRequest(raw), null, String(raw));
    }
  });

  test('only an explicit true counts as healthy or allowed', () => {
    const s = parseStatus(JSON.stringify({ checkedAt: NOW, healthy: 'yes', canRebuild: 1, checks: [{ name: 'db', ok: 'true' }] }));
    assert.ok(s);
    assert.equal(s.healthy, false);
    assert.equal(s.canRebuild, false);
    assert.equal(s.checks[0].ok, false);
  });

  test('runner text is length-bounded and checks without a name are dropped', () => {
    const s = parseStatus(JSON.stringify({
      checkedAt: NOW, summary: 'x'.repeat(5000),
      checks: [{ name: '', ok: true }, { name: 'replication', ok: true, detail: 'streaming, 0 bytes behind' }],
    }));
    assert.ok(s);
    assert.equal(s.summary.length, 300);
    assert.deepEqual(s.checks.map((c) => c.name), ['replication']);
  });

  test('a request round-trips, keeping only the latest steps', () => {
    const steps = Array.from({ length: 100 }, (_, i) => ({ at: i, msg: `step ${i}` }));
    const r = parseRequest(JSON.stringify({ ...request('running'), steps }));
    assert.ok(r);
    assert.equal(r.state, 'running');
    assert.equal(r.steps.length, 60);
    assert.equal(r.steps.at(-1)?.msg, 'step 99');
  });
});
