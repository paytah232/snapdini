// The kind of event, as a thing a host can change after their event exists.
//
// It could not be, and the reason was a real one that had quietly stopped applying. The wizard's
// edit mode showed the field as read-only text, on the grounds that the type "is stored alongside
// the trick list and written by the same endpoint, so changing it here would either do nothing or
// quietly regenerate a list the host may have spent time editing."
//
// Half of that is true and is pinned below: PUT /challenges writes event_type and challenges in ONE
// statement, refuses a body without a parseable list, and CLEARS the column when the list it is
// given is empty. Routing a type change through there really would destroy a host's own list.
//
// The other half was never true. Nothing on the server derives the trick list from the type — the
// mission packs live in web/src/lib/challenges.ts because a host can write their own, and seeding
// a list from a pack is a one-shot client action taken at creation. So the type by itself is a
// plain column, and PUT /settings now writes it under the ordinary present-key rule.
//
// What the read-only line could not do at all was answer the host who had never chosen a type:
// it rendered the words "Not set" and pointed at an editor, with nothing to protect and no way to
// proceed. The demo event (POST /api/events/demo) is exactly that event.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { nextEventType, parseEventType, parseChallengeSets, serialiseSets } from '../challenges';

describe('nextEventType — the present-key rule', () => {
  test('a save that never mentions it leaves the stored value alone', () => {
    // The whole reason this is not `parseEventType(body.eventType)` inline. A save that only
    // touched the event name would otherwise clear a type the host chose on another screen, and an
    // older client would clear it on every save it ever made.
    assert.equal(nextEventType(undefined, 'wedding'), 'wedding');
    assert.equal(nextEventType(undefined, null), null);
  });

  test('a type the host picked is stored, normalised', () => {
    assert.equal(nextEventType('birthday', null), 'birthday');
    assert.equal(nextEventType('  Wedding ', 'birthday'), 'wedding');
  });

  test('null is a real answer — "none of these fit" — and clears it', () => {
    // The chips toggle off as well as on, so this is the host un-saying it. If the client omitted
    // the key instead, that would be the one edit the wizard could not make.
    assert.equal(nextEventType(null, 'wedding'), null);
    assert.equal(nextEventType('', 'wedding'), null);
  });

  test('anything unparseable clears rather than storing rubbish', () => {
    for (const bad of ['WEDDING!!', 'a', '../../etc', 42, {}, ['wedding']]) {
      assert.equal(nextEventType(bad, 'wedding'), null, `${JSON.stringify(bad)} was stored`);
    }
  });

  test('it never looks at the trick list, because nothing derives one from the other', () => {
    // parseEventType is a string validator and that is all it is. If setting a type ever starts
    // producing missions, it must not happen here — a host's own list is not ours to rewrite.
    assert.equal(parseEventType('wedding'), 'wedding');
    assert.equal(nextEventType.length, 2);
  });
});

describe('why the type is NOT routed through PUT /challenges', () => {
  test('that endpoint cannot be asked for the type alone — it refuses a body with no list', () => {
    // The route answers 400 on a null here, so `{ eventType: 'birthday' }` is not a request it can
    // serve. "Change the type" through it always also means "and here is the whole list again".
    assert.equal(parseChallengeSets(undefined), null);
    assert.equal(parseChallengeSets({}), null);
  });

  test('and an EMPTY list is accepted and wipes the column', () => {
    // Not a refusal — a success. parseChallengeSets returns [] (not null), serialiseSets turns
    // that into null, and the route writes it straight over the host's cards. This is the work
    // that would be destroyed, and the reason the fix went into PUT /settings instead.
    const sets = parseChallengeSets([]);
    assert.deepEqual(sets, []);
    assert.notEqual(sets, null);
    assert.equal(serialiseSets(sets!, null), null);
  });

  test('a real list survives that endpoint unchanged, which is all it was ever for', () => {
    const sets = parseChallengeSets([{ id: 'own-1', text: 'The cake' }]);
    assert.equal(sets?.length, 1);
    assert.equal(sets?.[0].items.length, 1);
    assert.notEqual(serialiseSets(sets!, null), null);
  });
});
