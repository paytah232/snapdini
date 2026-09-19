// Two ways a guest can end up holding a card nobody meant them to have.
//
// Both are silent, both are about the moment the card is WRITTEN rather than read, and both were
// invisible in the read-path tests in card-choice.test.ts — which is why they are here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { reseatParticipant, readSetSource, resolveSetChoice, type ChallengeSet } from '../challenges';

const item = (id: string, text: string) => ({ id, text });
const SETS: ChallengeSet[] = [
  { key: 'a', label: 'Card A', items: [item('a1', 'The cake'), item('a2', 'A stranger')] },
  { key: 'b', label: 'Card B', items: [item('b1', 'The bar')] },
];
const ONE: ChallengeSet[] = [SETS[0]];

// ── 1. The host deletes a card somebody is holding ────────────────────────────

describe('a deleted card does not silently become card A', () => {
  test('a guest whose card survived is not touched', () => {
    assert.equal(reseatParticipant(SETS, { key: 'a' }), null);
    assert.equal(reseatParticipant(SETS, { key: 'b' }), null);
  });

  test('a guest holding a deleted card is asked again rather than moved in silence', () => {
    // The host removed card B. Without this, every read falls through setByKey's `?? sets[0]` to
    // card A: a different list, zero ticks, and the captions on the photos they already took
    // resolving to nothing — with no prompt, ever, because their source is settled.
    const next = reseatParticipant(ONE.concat([{ key: 'c', label: 'Card C', items: [item('c1', 'x')] }]), { key: 'b' });
    assert.deepEqual(next, { key: 'a', source: 'pending' });
    // 'pending' is the ONLY state that puts the question back on screen — that is the whole point.
    assert.equal(readSetSource(next!.source), 'pending');
  });

  test('...but is not asked when there is nothing to choose between', () => {
    // One card left. A prompt with a single button is an interruption, not a question.
    assert.deepEqual(reseatParticipant(ONE, { key: 'b' }), { key: 'a', source: 'auto' });
  });

  test('a host who deleted the whole list leaves their guests with no card and no question', () => {
    assert.deepEqual(reseatParticipant([], { key: 'a' }), { key: null, source: null });
    // ...and someone who never had one is already in that state.
    assert.equal(reseatParticipant([], { key: null }), null);
  });

  test('a participant who predates the trick list is left alone', () => {
    // NULL card at an event that now HAS cards: they joined before any of this, assignSet has never
    // run for them, and inventing a reseat here would be this rule making up a change nobody asked
    // for. Both null and undefined, because the column and the row type disagree about which.
    assert.equal(reseatParticipant(SETS, { key: null }), null);
    assert.equal(reseatParticipant(SETS, { key: undefined }), null);
  });

  test('the reseated guest lands on a card that actually exists', () => {
    for (const sets of [SETS, ONE, [SETS[1]]]) {
      const next = reseatParticipant(sets, { key: 'gone' });
      assert.ok(next, 'a deleted card must always produce a change');
      assert.ok(sets.some((s) => s.key === next!.key),
        `reseat put the guest on '${next!.key}', which is not one of ${sets.map((s) => s.key).join(', ')}`);
    }
  });

  test('a reseated guest can answer the question they are about to be asked', () => {
    // The end-to-end shape: reseat says 'pending', and 'pending' is exactly what resolveSetChoice
    // requires before it will accept an answer. If these two ever disagree, the guest is prompted
    // and then refused.
    const next = reseatParticipant(SETS, { key: 'gone' })!;
    const answered = resolveSetChoice(SETS, { key: next.key, source: readSetSource(next.source) }, 'b');
    assert.deepEqual(answered, { ok: true, key: 'b', source: 'self' });
  });
});

// ── 2. Two taps, one card ─────────────────────────────────────────────────────
//
// POST /api/participants/card reads the source, decides, and then writes. Those are separate
// moments, and a guest at a party supplies the concurrency for free: a double tap, a retry on a
// flaky connection, the camera open on two devices. The promise shown before the tap is "you cannot
// change this". A promise kept by reading a value you then overwrite unconditionally is not kept.
//
// Read as source, because the thing being guarded is a WHERE clause: exercising it would need a
// database, an event, a participant and two requests racing, to assert the presence of one
// predicate.

function routeSource(): string {
  let d = process.cwd();
  for (let i = 0; i < 6; i++) {
    const f = path.join(d, 'src', 'server', 'routes', 'participants.ts');
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  const f = path.join(process.cwd(), 'app', 'src', 'server', 'routes', 'participants.ts');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  throw new Error('could not locate routes/participants.ts from ' + process.cwd());
}

describe('the card write is the lock, not the read above it', () => {
  const src = routeSource();
  const route = src.slice(src.indexOf("router.post('/card'"), src.indexOf("router.post('/feedback'"));

  test('the route exists and still writes the card', () => {
    assert.ok(route.length > 200, 'POST /card has moved — this test navigates by it');
    assert.ok(route.includes('challengeSetSource: out.source'));
  });

  test('the UPDATE itself refuses a row that is no longer pending', () => {
    const update = route.slice(route.indexOf('db.update(participants)'));
    assert.match(update, /\.where\(and\(\s*eq\(participants\.id, p\.id\),\s*eq\(participants\.challengeSetSource, 'pending'\)\)\)/,
      "POST /api/participants/card writes the guest's card without making the write itself " +
      'conditional on the card still being unanswered.\n\n' +
      'resolveSetChoice() reads the source; the UPDATE happens several awaits later. Two requests ' +
      'that both pass the read both win, and the guest who was told "you cannot change this" can ' +
      'change it by tapping twice. The fix is a predicate on the UPDATE, not a longer read.');
  });

  test('zero rows affected is the same answer as "already answered"', () => {
    assert.match(route, /if \(!won\.length\)/,
      'the conditional UPDATE\'s result is not checked — a write that changed nothing would be ' +
      'reported to the guest as success, with a card they do not hold');
    const lost = route.slice(route.indexOf('if (!won.length)'));
    assert.ok(lost.includes('alreadySettled('),
      'losing the race must answer with the existing 409 path, not a new error');
    assert.ok(lost.includes('db.select'),
      "the 409 must report the card the guest ACTUALLY holds — re-read, not the stale copy from " +
      'the top of the handler, which is exactly the value that turned out to be wrong');
  });

  test('NULL is NOT lockable-into by this route', () => {
    // NULL is every participant who joined before any of this existed. readSetSource() reads it as
    // 'auto' — settled — and resolveSetChoice refuses it. A predicate of
    // `IS NULL OR = 'pending'` would open a door the branch above has always kept shut, and would
    // reassign the card of someone who was never asked.
    assert.ok(!/challengeSetSource\)\s*,\s*isNull/.test(route) && !route.includes('isNull(participants.challengeSetSource)'),
      'the card lock now accepts a NULL source. NULL means settled-before-this-existed, not ' +
      'unanswered — resolveSetChoice() refuses it and so must the write.');
    assert.equal(readSetSource(null), 'auto');
    assert.deepEqual(resolveSetChoice(SETS, { key: 'a', source: readSetSource(null) }, 'b'),
      { ok: false, reason: 'locked' });
  });
});
