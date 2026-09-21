import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capturedAtFor, captureSpanMs, gateUpload, lateUploadAllowed,
         maxAcceptedClipMs } from '../routes/photos';

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

/* THE WIRING, not just the rule.
 *
 * Everything above proves gateUpload() reaches the right verdict when it is handed a body. None of
 * it proves the ROUTES hand it one. An audit found exactly that hole: replace `req.body` with
 * `null` at both call sites — unplugging the entire duration feature, so every clip falls back to
 * assuming the ten-minute ceiling — and the whole app suite passed, 1154 of 1154.
 *
 * That is the same bug class this codebase keeps meeting: a value that is computed correctly,
 * tested thoroughly, and then never actually delivered. captureRotation was appended by both
 * upload paths and read by neither. durationSecs sat on the queue item and never left the phone.
 * A pure function with excellent tests is not a feature until something calls it.
 *
 * A source assertion rather than a driven request, deliberately: what is in question is whether
 * one specific argument is present at two specific call sites, and that is a question about the
 * text. Driving the route would also answer it, but only incidentally, and would go on passing if
 * a third upload path appeared tomorrow and forgot.
 */
describe('the routes actually hand the gate a body to read', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'photos.ts'), 'utf8');

  test('every gateUpload call site passes the request body', () => {
    const calls = [...SRC.matchAll(/gateUpload\([^;]*?\);/gs)].map((m) => m[0]);
    // The single-shot POST / and the chunked POST /complete. A third would have to answer this too.
    assert.ok(calls.length >= 2, `expected both upload paths to gate, found ${calls.length}`);
    for (const c of calls) {
      // `[,)]` not just `)`: the body is no longer always the last argument — /complete passes a
      // fifth now — and pinning it to the end made this fail for a reason that had nothing to do
      // with what it guards. Still catches the thing it exists for, which is the body being
      // replaced by `null`.
      assert.ok(/req\.body\s*[,)]/.test(c),
        `a gateUpload call is not being given the body, so durationSecs can never reach it:\n${c}`);
    }
  });

  test('a still declared as a clip does not buy a clip\'s allowance', () => {
    // `mediaType` is the CLIENT'S word, and on the chunked route it was the whole basis for the
    // extra reach past the close. A photograph posted as mediaType:'video' therefore collected up
    // to the full ten-minute ceiling of it — bounded and low-value, but it was the one way round
    // the rule that a still gets nothing, and a rule that can be opted out of is not a rule.
    //
    // The fix splits the question in two, and the split is what this pins. `isVideo` stays
    // generous because it drives ENTITLEMENT: a real clip with an odd extension must not slip
    // past the paid-video check. The allowance is strict because it drives REACH, and the only
    // evidence worth anything there is the file's own extension.
    const cap = maxAcceptedClipMs(600);
    // Generous, for entitlement: the declaration alone is enough.
    assert.equal(captureSpanMs(true, { durationSecs: 30 }, cap), 30_000);
    // Strict, for reach: told 'this is not a clip by its extension', it grants nothing at all —
    // not even with a duration attached, which is exactly what a forged still would send.
    assert.equal(captureSpanMs(false, { durationSecs: 30 }, cap), 0);
    assert.equal(captureSpanMs(false, {}, cap), 0);

    // And the two are genuinely wired apart at the route, or the split above is decoration.
    const src = SRC.slice(SRC.indexOf("const extSaysVideo"));
    const head = src.slice(0, src.indexOf('wipe(); return res.status(gate.status)'));
    // `isVideo` stays generous — it drives entitlement, and a real clip with an odd extension
    // must not be mistaken for a photograph and slip past the paid-video check.
    assert.match(head, /const isVideo = mediaType === 'video' \|\| extSaysVideo/,
      'the generous test must still honour the declaration, for entitlement');
    // The ALLOWANCE comes from the bytes. Believing `ext` instead of `mediaType` was the second
    // attempt at this and an audit correctly called it useless: both fields arrive in the same
    // request body, so that moved the forgery rather than stopping it.
    assert.match(head, /const sniffed = stagedLooksLikeVideo\(uploadId\);/,
      'the allowance must be settled by reading the staged bytes');
    assert.match(head, /const clipAllowance = sniffed \?\? isVideo;/,
      'falling back to the declaration only where the header could not be read');
    assert.match(head, /gateUpload\([^;]*req\.body, clipAllowance\)/s,
      'the gate must be handed the byte-derived allowance, not a body field');
  });

  test('and the gate reads a duration out of it', () => {
    // The other end of the same wire. If captureSpanMs stopped consulting the body, passing it
    // would be ceremony.
    const span = SRC.slice(SRC.indexOf('export function captureSpanMs'));
    const body = span.slice(0, span.indexOf('\n}'));
    assert.match(body, /durationMs/, 'captureSpanMs must read the claimed duration');
    assert.match(body, /durationSecs/, 'both units, because the queue has carried each at times');
  });
});

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

/* ── THE CAPTURE THAT BEGAN INSIDE THE EVENT ───────────────────────────────────────────────
 *
 * `capturedAt` changed meaning underneath this gate. It used to be stamped when the queue item was
 * written — for a clip, the moment recording STOPPED — and it is now stamped when recording
 * STARTS. The product rule did not change and was never in doubt: press record before the event
 * ends and the clip is yours, however long it runs and whenever it finishes uploading.
 *
 * Under the old stamp that rule held only by luck. CLOCK_SKEW_MS is five minutes; a clip
 * stop-stamped at the end of a ninety-second recording lands eighty-nine seconds past the close,
 * and eighty-nine is comfortably under three hundred — so the ninety-second case sailed through
 * while the ten-minute case, which is the one somebody uses to film the speeches, was refused
 * outright with the guest's video already uploaded. A clock-skew pad was quietly doubling as a
 * clip-duration allowance nobody had sized it for or written down.
 *
 * These pin the rule on purpose instead, and they pin it for BOTH generations of client, because
 * the server cannot tell a start stamp from a stop stamp and an old queue keeps draining old
 * stamps for as long as the tab lives.
 *
 * READ THE REFUSALS DIFFERENTLY FROM THE ACCEPTANCES. The change is a pure loosening, so every
 * case below that asserts a refusal passes both before and after it and cannot fail for its
 * absence. Those are guards on how far the new generosity is allowed to go, not evidence that it
 * works; the acceptances are the evidence.
 */

const SEC = 1000;

describe('lateUploadAllowed — a clip begun before the close is honoured to its last frame', () => {
  // The clip length that matters throughout: as long a recording as this server will keep at all.
  const CAP = maxAcceptedClipMs(600);

  test('the server has an opinion about the longest clip it will keep, and it is a real number', () => {
    // An infinite or absent ceiling here would make the late-upload window infinite too, since the
    // gate widens itself by exactly this much when a client sends no duration.
    assert.ok(Number.isFinite(CAP) && CAP > 0, `clip ceiling must be finite and positive, got ${CAP}`);
    assert.ok(CAP > 6 * MIN, `these cases assume a clip ceiling above six minutes; this build has ${CAP}ms`);
  });

  test('a ten-minute clip begun a second before the close, stop-stamped by an old client', () => {
    // THE CASE THAT WAS REFUSED. The phone stamped the queue item when recording stopped, so the
    // claim lands 9m59s past the end — nearly ten minutes past a five-minute skew pad. The guest
    // filmed the speeches starting one second before the event closed and lost the lot.
    const stopStamped = ENDS - SEC + 10 * MIN;
    assert.equal(lateUploadAllowed(ENDS, stopStamped, ENDS + 40 * MIN, 10 * MIN), true);
  });

  test('...and with no clip allowance it is refused, which is the behaviour being fixed', () => {
    // GUARD / documentation. Same numbers, no fourth argument: this is what the gate used to do,
    // written down so the next person can see what the argument buys rather than inferring it.
    const stopStamped = ENDS - SEC + 10 * MIN;
    assert.equal(lateUploadAllowed(ENDS, stopStamped, ENDS + 40 * MIN), false);
  });

  test('a clip with no duration claim at all gets the benefit of the doubt', () => {
    // An old client sends no duration, and neither does a camera-roll upload. Assuming zero would
    // be assuming the stamp is a start stamp — assuming away the entire problem, and doing it in
    // favour of precisely the guests least likely to be on a new client.
    const span = captureSpanMs(true, {}, CAP);
    assert.equal(span, CAP);
    assert.equal(lateUploadAllowed(ENDS, ENDS - SEC + CAP, ENDS + CAP + 40 * MIN, span), true);
  });

  test('a ninety-second clip whose chunks are still landing a day and a minute after the close', () => {
    // THE CHUNKED PATH. /chunk does not gate at all — only /complete does — so no individual part
    // can ever be refused for arriving late; the question is whether the upload as a whole is
    // still allowed when the LAST part lands. A bad connection pushes that past the twenty-four
    // hours, and the twenty-four hours used to be measured from the EVENT's end rather than from
    // the end of the capture, silently docking a long clip's network grace by its own length.
    const begun = ENDS - SEC;
    assert.equal(lateUploadAllowed(ENDS, begun, ENDS + 24 * HOUR + MIN, 90 * SEC), true);
    assert.equal(lateUploadAllowed(ENDS, begun, ENDS + 24 * HOUR + MIN), false);   // the old bound
  });

  test('a long clip gets its full day measured from its own last frame, and no more', () => {
    const begun = ENDS - SEC;
    assert.equal(lateUploadAllowed(ENDS, begun, ENDS + 24 * HOUR + 9 * MIN, 10 * MIN), true);
    // GUARD: the grace is a day, not a day and a bit for anyone who claims a long clip.
    assert.equal(lateUploadAllowed(ENDS, begun, ENDS + 24 * HOUR + 11 * MIN, 10 * MIN), false);
  });

  test('a capture genuinely begun after the close is still refused, whatever span it claims', () => {
    // GUARD. The line the generosity is not allowed to cross: an hour past the end is not "the
    // speeches ran long", it is a different evening, and the event has to actually close.
    for (const span of [0, 90 * SEC, CAP]) {
      assert.equal(lateUploadAllowed(ENDS, ENDS + HOUR, ENDS + HOUR + MIN, span), false, `span ${span}`);
    }
  });

  test('a still is given no clip allowance whatsoever', () => {
    // GUARD. Begin and stop are the same instant for a photograph, so there is nothing to widen,
    // and the photo path must come out of this change bit-for-bit as it went in.
    assert.equal(captureSpanMs(false, { durationSecs: 600, durationMs: 600_000 }, CAP), 0);
    assert.equal(lateUploadAllowed(ENDS, ENDS + 10 * MIN, ENDS + 11 * MIN, 0), false);
  });
});

describe('captureSpanMs — the clip length is read, clamped, and never believed', () => {
  const CAP = maxAcceptedClipMs(600);

  test('milliseconds and seconds are both understood', () => {
    // The queue has historically carried whole seconds while the column and ffprobe speak
    // milliseconds. Reading only one of them means the other silently falls back to the ceiling,
    // which is the right answer for the wrong reason and hides the bug for as long as it works.
    assert.equal(captureSpanMs(true, { durationMs: 12_000 }, CAP), 12_000);
    assert.equal(captureSpanMs(true, { durationSecs: 12 }, CAP), 12_000);
    assert.equal(captureSpanMs(true, { durationMs: 12_000, durationSecs: 99 }, CAP), 12_000);
  });

  test('a made-up duration cannot hold the event open', () => {
    // GUARD. The client is the only witness to the clip length, so it is a forgeable field and a
    // century of it would otherwise be a century of open door.
    const century = 100 * 365 * 24 * 60 * 60 * 1000;
    assert.equal(captureSpanMs(true, { durationMs: century }, CAP), CAP);
    assert.equal(lateUploadAllowed(ENDS, ENDS + 24 * HOUR, ENDS + 25 * HOUR,
                                   captureSpanMs(true, { durationMs: century }, CAP)), false);
  });

  test('an explicitly-sent zero is a measurement, not a missing one', () => {
    // WHY A SUB-SECOND CLIP IS A REAL CASE. The camera counts recording time off a one-second
    // interval (`recSecs++`), so a clip the guest taps out in under a second genuinely has a
    // duration of zero whole seconds — and Camera.svelte sends it on purpose, testing `!= null`
    // rather than truthiness, precisely so the server is not left assuming the ten-minute
    // ceiling for half a second of video. `secs > 0` then threw it away: the 0 went down the
    // "no claim at all" branch and collected the whole ceiling, so the one field the client took
    // care to send changed nothing at all.
    assert.equal(captureSpanMs(true, { durationSecs: 0 }, CAP), 0);
    // AND AS A STRING, because that is how it arrives at the door most captures come through:
    // POST / is multipart, so every field on that wire is text and this one is '0', not 0. A fix
    // that only understood the JSON shape would work on the chunked /complete and quietly not on
    // the single-shot upload — which is the half of the split this codebase has been caught by
    // before.
    assert.equal(captureSpanMs(true, { durationSecs: '0' }, CAP), 0);

    // What honouring it BUYS, which is the only reason to care. Seven minutes past the close is
    // outside the clock-skew pad, so the verdict turns entirely on the clip allowance: an
    // unmeasured clip is given the ceiling and let in, a clip that says it was under a second
    // has nothing to be given and the event is properly shut.
    const begun = ENDS + 7 * MIN;
    assert.equal(lateUploadAllowed(ENDS, begun, begun + MIN, captureSpanMs(true, {}, CAP)), true,
      'no claim is still the benefit of the doubt');
    assert.equal(lateUploadAllowed(ENDS, begun, begun + MIN, captureSpanMs(true, { durationSecs: 0 }, CAP)), false,
      'a clip that says it was under a second cannot hold a closed event open for ten minutes');
  });

  test('only a real zero counts as one — empty, absent and rubbish are still the ceiling', () => {
    // GUARD, and the reason the fix is not simply `secs >= 0`. Number('') is 0. So is
    // Number(null), Number([]) and Number(false). Reading the field with Number() and accepting
    // zero would therefore turn every one of those — an old client that sends nothing, a field
    // that arrived empty, a forged value — into "this clip was under a second", which is the
    // original bug back again with a new cause, aimed at exactly the clients least able to
    // survive it.
    const notAZero = [{ durationSecs: '' }, { durationSecs: '   ' }, { durationSecs: null },
                      { durationSecs: undefined }, { durationSecs: [] }, { durationSecs: false }];
    for (const b of notAZero) {
      assert.equal(captureSpanMs(true, b as never, CAP), CAP,
        `${JSON.stringify(b)} is an absence, not a zero`);
    }
    // And a still gets nothing whatsoever out of any of it, zero included.
    assert.equal(captureSpanMs(false, { durationSecs: 0 }, CAP), 0);
  });

  test('rubbish, absence and the wrong unit all fall back to the ceiling rather than to zero', () => {
    // Falling back to zero would be the tidy-looking choice and the wrong one: zero is the answer
    // for a still, and applying it to a clip we simply failed to measure re-creates the original
    // bug for every client that does not send the field.
    const bad = [undefined, null, {}, { durationMs: 0 }, { durationMs: -5 }, { durationMs: NaN },
                 { durationSecs: 'abc' }, { durationSecs: '' }, { durationSecs: {} }];
    for (const b of bad) {
      assert.equal(captureSpanMs(true, b as never, CAP), CAP, `${JSON.stringify(b)} must fall back to the ceiling`);
    }
  });
});

describe('gateUpload — the whole door, not just the rule behind it', () => {
  // A participant with room on their roll and a video entitlement, so the only thing any of these
  // can trip on is the end of the event. videoSeconds is the hard ceiling, which makes the answer
  // identical whether or not this build has billing switched on.
  const base = {
    id: 'p1', photosTaken: 0, maxPhotos: 30, extraPhotos: 0, isLocked: false,
    startsAt: 0, expiresAt: 0, eventId: 'e1', moderationEnabled: false, videoSeconds: 600,
    challengeSet: null, eventChallenges: null, aspectRatios: null,
  };
  const CAP = maxAcceptedClipMs(base.videoSeconds);
  // gateUpload reads the wall clock itself, so the event is placed relative to now rather than to
  // the fixed ENDS the pure functions above can use.
  const endedMsAgo = (ms: number) => ({ ...base, startsAt: Date.now() - 48 * HOUR, expiresAt: Date.now() - ms });
  const ENDED = { status: 410, error: 'Event has ended' };

  test('/complete for a maximum-length clip begun a second before the close, old-style stamp', () => {
    // The chunked path end to end, arriving half an hour after the camera stopped. The stamp is
    // the STOP — an old client, or a queue item written before the change — which is what turned
    // a fully uploaded video into a 410.
    const p = endedMsAgo(CAP + 30 * MIN - SEC);
    assert.equal(gateUpload(p, true, p.expiresAt + CAP - SEC, { durationMs: CAP }), null);
  });

  test('the same upload with no duration field anywhere on the wire', () => {
    const p = endedMsAgo(CAP + 30 * MIN - SEC);
    assert.equal(gateUpload(p, true, p.expiresAt + CAP - SEC, {}), null);
  });

  test('a clip whose capturedAt never arrived is assumed to have been running', () => {
    // No stamp falls back to `now`, exactly as it always did. For a clip that fallback carries an
    // arithmetic fact with it: the bytes are in our hands, so the camera was running for the
    // length of the clip before they could be.
    const p = endedMsAgo(CAP / 2 + 2 * MIN);
    assert.equal(gateUpload(p, true, undefined, undefined), null);
  });

  test('a PHOTO whose capturedAt never arrived is refused exactly as before', () => {
    // GUARD. The still path must not move. There is no duration to give it the benefit of, and
    // inventing one would let a photograph taken after the close into a closed event.
    const p = endedMsAgo(CAP / 2 + 2 * MIN);
    assert.deepEqual(gateUpload(p, false, undefined, undefined), ENDED);
  });

  test('a clip genuinely begun an hour after the close is refused at the door', () => {
    // GUARD, and the one that keeps the whole arrangement honest: the widening is bounded by the
    // clip, so a recording started long after everyone went home is still somebody else's evening.
    const p = endedMsAgo(90 * MIN);
    assert.deepEqual(gateUpload(p, true, p.expiresAt + HOUR, { durationMs: CAP }), ENDED);
  });
});
