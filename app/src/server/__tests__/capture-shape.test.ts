// What a guest is allowed to ask for a clip to be SHAPED like.
//
// `captureShape` arrives on the upload as a string from the client, and it used to be checked
// against the ratio grammar and nothing else — `\d{1,2}:\d{1,2}` and you were through. The grammar
// is not the rule. The rule is what the EVENT has: square is free, every other frame is the $5
// frame pack, and the event row records exactly which shapes were paid for.
//
// Three separate things rode on the missing check, which is why it is worth a file:
//
//  1. THE PACK WAS A UI-ONLY GATE. The camera only draws the shapes the event sent it, so no honest
//     guest was ever affected — but `captureShape: '9:16'` posted by hand to a free, square-only
//     event was written straight to the row and honoured by the cropper. The paid feature was a
//     client-side decoration.
//
//  2. '99:1' WAS A LEGAL SHAPE. Two digits either side is all the grammar asks for.
//
//  3. IT WAS A LEVER ON EVERY OTHER EVENT ON THE BOX. A shaped clip queues a full-resolution
//     CRF-18 re-encode (`dlName`) inside the ONE global video slot that guest playback proxies also
//     wait in. So one forged field per upload, on one free event, is CPU taken from every other
//     event's guests — the expensive half of the bug, and the half a paywall test would miss.
//
// The fallback, and why it is 'full' rather than a refusal: the person on the other end of this is
// standing at a party having just spent one of a fixed number of shots. Losing the moment over a
// field that only decides framing is out of all proportion, so the upload always stands. 'full'
// specifically — not the event's own first shape — because it is the only fallback that does no
// work (a real ratio would still buy the forged request its re-encode) and the only one that
// removes no pixels. An honest client cannot reach it: it offers only the event's own shapes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readShape, allowedShapes } from '../routes/photos';

// A free event, and one that bought the pack. These are the stored JSON, verbatim.
const FREE = allowedShapes('["1:1"]');
const PAID = allowedShapes('["1:1","4:5","9:16","full"]');

describe('the event decides, not the string', () => {
  test('a shape the event paid for is honoured', () => {
    assert.equal(readShape('4:5', PAID), '4:5');
    assert.equal(readShape('9:16', PAID), '9:16');
    assert.equal(readShape('1:1', FREE), '1:1');
  });

  test('a shape the event never bought does not get cropped to for free', () => {
    // The whole finding, in one line: a square-only event asked for a tall frame.
    assert.equal(readShape('9:16', FREE), 'full');
    assert.equal(readShape('4:5', FREE), 'full');
    assert.equal(readShape('3:4', FREE), 'full');
  });

  test('the upload is never refused over it — the fallback keeps the clip whole', () => {
    // 'full' means "do not crop", so nothing is re-encoded and nothing is thrown away. Not null,
    // and not an error: a guest must not lose a shot to a field about framing.
    const got = readShape('9:16', FREE);
    assert.equal(got, 'full');
    assert.notEqual(got, null);
  });

  test('a shape nobody has is a shape nobody has, however well-formed', () => {
    assert.equal(readShape('99:1', PAID), 'full');
    assert.equal(readShape('16:9', PAID), 'full');    // grammatical, plausible, not in the options
  });

  test("'full' needs no entitlement — it is the absence of a crop", () => {
    assert.equal(readShape('full', FREE), 'full');
    assert.equal(readShape(' full ', FREE), 'full');
  });

  test('anything that is not a shape at all stays null', () => {
    for (const raw of [undefined, null, 42, {}, '', '  ', 'square', '1:1:1', '-1:2', '100:100'])
      assert.equal(readShape(raw, PAID), null, `readShape(${JSON.stringify(raw)})`);
  });
});

describe('allowedShapes reads the event row without trusting it', () => {
  test('the stored list comes back as it is', () => {
    assert.deepEqual(allowedShapes('["1:1","4:5"]'), ['1:1', '4:5']);
  });

  test('missing, empty or corrupt JSON reads as the free baseline, never as "anything"', () => {
    // The failure mode to avoid is a parse error opening the gate. Every event has square.
    for (const stored of [null, undefined, '', '[]', 'not json', '{"a":1}', '"1:1"'])
      assert.deepEqual(allowedShapes(stored), ['1:1'], `allowedShapes(${JSON.stringify(stored)})`);
  });

  test('numbers in the stored list cannot smuggle a non-string through', () => {
    assert.deepEqual(allowedShapes('[1,"4:5"]'), ['1', '4:5']);
    assert.equal(readShape('1:1', allowedShapes('[1]')), 'full');
  });
});
