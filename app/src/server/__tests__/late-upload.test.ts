import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { capturedAtFor, lateUploadAllowed } from '../routes/photos';

/* A photo taken during an event and uploaded just after it closed used to be refused.
 *
 * Six were, at one hen do: the event ended at 14:00, and at 14:18 a single Android phone on a
 * crowded connection failed six uploads in a row, three to nine seconds apart — the signature of a
 * queue draining with backoff, not of somebody still taking pictures. The server could not tell the
 * difference because it stamped the capture time at UPLOAD, so "taken inside the window" was not a
 * question it was able to ask.
 *
 * These pin the two halves of the answer. Losing either one is a silent regression: drop the first
 * and real photographs from the party disappear again; drop the second and the event never closes.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const ENDS = Date.UTC(2026, 8, 20, 14, 0);
const EV = { startsAt: ENDS - 48 * HOUR };

describe('lateUploadAllowed — the shutter decides, the network does not', () => {
  test('taken inside, uploaded eighteen minutes late: accepted', () => {
    // The exact case this exists for.
    assert.equal(lateUploadAllowed(ENDS, ENDS - 47 * MIN, ENDS + 18 * MIN), true);
  });

  test('taken inside, uploaded next morning: still accepted', () => {
    // A phone that went flat at the party and was charged overnight is the same story, longer gap.
    assert.equal(lateUploadAllowed(ENDS, ENDS - 2 * HOUR, ENDS + 9 * HOUR), true);
  });

  test('taken AFTER the end: refused, however promptly it arrives', () => {
    // The event really is over. This is the half that stops the grace window becoming an extension.
    assert.equal(lateUploadAllowed(ENDS, ENDS + 10 * MIN, ENDS + 11 * MIN), false);
  });

  test('taken inside, but arriving beyond the grace: refused', () => {
    assert.equal(lateUploadAllowed(ENDS, ENDS - MIN, ENDS + 25 * HOUR), false);
  });

  test('a phone a couple of minutes fast is still believed', () => {
    // Handset clocks drift. Reading a slightly-fast phone's shot as "taken after the end" would
    // refuse a photograph that was plainly taken at the party.
    assert.equal(lateUploadAllowed(ENDS, ENDS + 2 * MIN, ENDS + 3 * MIN), true);
  });

  test('an hour fast is not', () => {
    assert.equal(lateUploadAllowed(ENDS, ENDS + HOUR, ENDS + HOUR + MIN), false);
  });
});

describe('capturedAtFor — a client clock is advisory, never evidence', () => {
  const NOW = ENDS - HOUR;

  test('a plausible claim is honoured', () => {
    assert.equal(capturedAtFor(NOW - 5 * MIN, EV, NOW), NOW - 5 * MIN);
  });

  test('a claim from the future falls back to our own clock', () => {
    // Otherwise a phone set forward — by accident or on purpose — could dodge the end of an event.
    assert.equal(capturedAtFor(NOW + HOUR, EV, NOW), NOW);
  });

  test('a claim from before the event even began falls back', () => {
    assert.equal(capturedAtFor(EV.startsAt - HOUR, EV, NOW), NOW);
  });

  test('rubbish and absence both fall back, rather than becoming zero', () => {
    // Number('') is 0 and Number(undefined) is NaN; either becoming a timestamp would date every
    // such photo to 1970 and put it outside every event window there has ever been.
    for (const bad of [undefined, null, '', 'abc', NaN, 0, -1, {}]) {
      assert.equal(capturedAtFor(bad, EV, NOW), NOW, `${String(bad)} must fall back`);
    }
  });

  test('a small forward drift inside the skew is kept as given', () => {
    assert.equal(capturedAtFor(NOW + 2 * MIN, EV, NOW), NOW + 2 * MIN);
  });
});
