// Which trick card a guest ends up holding, and who got to decide.
//
// This is the half of the feature that reaches events ALREADY RUNNING, so most of what is pinned
// here is what must NOT change: a printed ?set= card still wins outright, the round-robin is still
// the answer for anyone without a card, and a participant who predates the whole idea is settled
// and is never asked anything.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignSet, assignSetWithSource, readSetSource, publicSetSource, shouldAskWhichSet,
  setChoices, resolveSetChoice, cardDesignHasQr, type ChallengeSet,
} from '../challenges';

const item = (id: string, text: string) => ({ id, text });
const SETS: ChallengeSet[] = [
  { key: 'a', label: 'Card A', items: [item('a1', 'The cake'), item('a2', 'A stranger'), item('a3', 'Shoes'), item('a4', 'The dog')] },
  { key: 'b', label: 'Card B', items: [item('b1', 'The bar'), item('b2', 'A hat')] },
];
const ONE: ChallengeSet[] = [SETS[0]];

describe('assignSetWithSource', () => {
  test('a printed card names its set and wins outright', () => {
    const r = assignSetWithSource(SETS, 'b', 0);
    assert.deepEqual(r, { key: 'b', source: 'qr' });
    // ...at any point in the round-robin, which is the whole reason those cards are printed.
    assert.deepEqual(assignSetWithSource(SETS, 'B', 7), { key: 'b', source: 'qr' });
  });

  test('no card named, several to choose from: round-robin, and a question still open', () => {
    assert.deepEqual(assignSetWithSource(SETS, undefined, 0), { key: 'a', source: 'pending' });
    assert.deepEqual(assignSetWithSource(SETS, undefined, 1), { key: 'b', source: 'pending' });
    assert.deepEqual(assignSetWithSource(SETS, undefined, 2), { key: 'a', source: 'pending' });
  });

  test('one card: assigned silently, never a question', () => {
    assert.deepEqual(assignSetWithSource(ONE, undefined, 3), { key: 'a', source: 'auto' });
    assert.equal(shouldAskWhichSet(ONE, 'auto'), false);
  });

  test('an event with no trick list has no card and no source', () => {
    assert.deepEqual(assignSetWithSource([], 'a', 0), { key: null, source: null });
  });

  test('it is assignSet with a label on it — the key never differs', () => {
    for (const req of [undefined, '', 'b', 'nope', 42]) {
      for (let n = 0; n < 5; n++) {
        assert.equal(assignSetWithSource(SETS, req, n).key, assignSet(SETS, req, n));
      }
    }
  });

  test('a key the event does not have is not a card in anyone’s hand', () => {
    const r = assignSetWithSource(SETS, 'zz', 0);
    assert.equal(r.source, 'pending');          // fell through to the round-robin
    assert.equal(r.key, 'a');
  });
});

describe('reading the stored source', () => {
  test('NULL — every participant who joined before this existed — is settled', () => {
    assert.equal(readSetSource(null), 'auto');
    assert.equal(readSetSource(undefined), 'auto');
    assert.equal(readSetSource(''), 'auto');
    assert.equal(shouldAskWhichSet(SETS, readSetSource(null)), false);
  });

  test('anything unrecognised is settled too — never a prompt from a bad byte', () => {
    assert.equal(readSetSource('banana'), 'auto');
  });

  test('the ones we write survive the round trip', () => {
    for (const v of ['qr', 'self', 'pending', 'auto'] as const) assert.equal(readSetSource(v), v);
  });

  test('pending is bookkeeping, and reports as what it is', () => {
    assert.equal(publicSetSource('pending'), 'auto');
    assert.equal(publicSetSource('qr'), 'qr');
    assert.equal(publicSetSource('self'), 'self');
    assert.equal(publicSetSource('auto'), 'auto');
  });
});

describe('who gets asked', () => {
  test('only a pending guest at an event with more than one card', () => {
    assert.equal(shouldAskWhichSet(SETS, 'pending'), true);
    assert.equal(shouldAskWhichSet(SETS, 'qr'), false);
    assert.equal(shouldAskWhichSet(SETS, 'self'), false);
    assert.equal(shouldAskWhichSet(SETS, 'auto'), false);
    assert.equal(shouldAskWhichSet(ONE, 'pending'), false);
    assert.equal(shouldAskWhichSet([], 'pending'), false);
  });
});

describe('the choices a guest is shown', () => {
  test('a label they can read off the card, and enough of the list to recognise it', () => {
    assert.deepEqual(setChoices(SETS), [
      { key: 'a', label: 'Card A', count: 4, preview: ['The cake', 'A stranger', 'Shoes'] },
      { key: 'b', label: 'Card B', count: 2, preview: ['The bar', 'A hat'] },
    ]);
  });
});

describe('answering "which card are you?"', () => {
  const pending = { key: 'a', source: 'pending' as const };

  test('a card they named becomes theirs, and is their own choice', () => {
    assert.deepEqual(resolveSetChoice(SETS, pending, 'b'), { ok: true, key: 'b', source: 'self' });
    assert.deepEqual(resolveSetChoice(SETS, pending, ' B '), { ok: true, key: 'b', source: 'self' });
  });

  test('"I don’t have a card" keeps the round-robin’s answer, settled', () => {
    for (const want of [null, undefined, '', '   ', 'none']) {
      assert.deepEqual(resolveSetChoice(SETS, pending, want), { ok: true, key: 'a', source: 'auto' });
    }
  });

  test('THE lock: a second attempt cannot change it', () => {
    const chosen = { key: 'b', source: 'self' as const };
    assert.deepEqual(resolveSetChoice(SETS, chosen, 'a'), { ok: false, reason: 'locked' });
    // ...and neither can "I don't have a card", which would otherwise be a way to re-roll.
    assert.deepEqual(resolveSetChoice(SETS, chosen, null), { ok: false, reason: 'locked' });
  });

  test('a printed card and a host’s move are final for the same reason', () => {
    assert.deepEqual(resolveSetChoice(SETS, { key: 'b', source: 'qr' }, 'a'), { ok: false, reason: 'locked' });
    assert.deepEqual(resolveSetChoice(SETS, { key: 'a', source: 'auto' }, 'b'), { ok: false, reason: 'locked' });
  });

  test('a card this event does not have is refused, not silently swapped', () => {
    assert.deepEqual(resolveSetChoice(SETS, pending, 'zz'), { ok: false, reason: 'unknown-set' });
    assert.deepEqual(resolveSetChoice(SETS, pending, 42), { ok: false, reason: 'unknown-set' });
  });

  test('an event with no trick list has nothing to answer', () => {
    assert.deepEqual(resolveSetChoice([], pending, 'a'), { ok: false, reason: 'no-sets' });
  });
});

describe('the nudge back to the card’s own code', () => {
  test('only when the saved design actually prints one', () => {
    assert.equal(cardDesignHasQr(JSON.stringify({ cardShowQr: true })), true);
    assert.equal(cardDesignHasQr(JSON.stringify({ cardShowQr: false })), false);
  });

  test('"we could not tell" is never a suggestion to go and scan something', () => {
    assert.equal(cardDesignHasQr(null), false);
    assert.equal(cardDesignHasQr(''), false);
    assert.equal(cardDesignHasQr('{not json'), false);
    assert.equal(cardDesignHasQr('{}'), false);
    assert.equal(cardDesignHasQr(JSON.stringify({ cardShowQr: 'yes' })), false);
  });
});

describe("'qr' is a label, not a claim — and nothing depends on it being one", () => {
  // A guest who POSTs {"set":"a"} at join time is recorded as 'qr' without ever having held a
  // printed card, and that cannot be fixed server-side: `?set=` is a query parameter on a page the
  // guest's browser loads, the join call is a POST that carries no query string, and only the
  // guest's own JavaScript can move the key between them. A scanned card and a hand-written body
  // are the same request. Reading req.query instead would break every card already printed.
  //
  // What makes that acceptable is pinned here: 'qr' and 'self' are ONE state everywhere it is
  // read, so the forged path ends at exactly the card an honest guest can reach by answering the
  // prompt. If a future change ever gives 'qr' a privilege 'self' does not have, these fail — and
  // it will need a real per-card secret first, which is a new column and a new print format.
  test('both are locked against a second answer, identically', () => {
    for (const source of ['qr', 'self'] as const) {
      assert.deepEqual(resolveSetChoice(SETS, { key: 'a', source }, 'b'), { ok: false, reason: 'locked' },
        `${source} let a guest re-answer`);
      assert.deepEqual(resolveSetChoice(SETS, { key: 'a', source }, null), { ok: false, reason: 'locked' });
    }
  });

  test('neither is ever asked "which card are you?"', () => {
    assert.equal(shouldAskWhichSet(SETS, 'qr'), false);
    assert.equal(shouldAskWhichSet(SETS, 'self'), false);
    // Only the round-robin's open question is, which is the whole reason 'pending' exists.
    assert.equal(shouldAskWhichSet(SETS, 'pending'), true);
  });

  test('both survive to the client as themselves — the label is information, not a permission', () => {
    assert.equal(publicSetSource('qr'), 'qr');
    assert.equal(publicSetSource('self'), 'self');
  });

  test('answering the prompt honestly reaches the same card the forgery would', () => {
    // The advantage on offer, measured: none. Forging gives set 'b' and a final source; joining
    // and answering 'b' gives set 'b' and a final source.
    const forged = assignSetWithSource(SETS, 'b', 0);
    const honest = resolveSetChoice(SETS, { key: assignSetWithSource(SETS, undefined, 0).key, source: 'pending' }, 'b');
    assert.equal(forged.key, 'b');
    assert.deepEqual(honest, { ok: true, key: 'b', source: 'self' });
  });
});
