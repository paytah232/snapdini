// Sound that arrives already ahead of the picture.
//
// The microphone can take up to a second to hand over its first sample, and the muxer rebases the
// audio track to zero regardless of when it really started — so everything the mic recorded lands
// that far early, for the whole clip, with nothing in the file to say it happened. No packets are
// dropped and there is no gap to find; the only trace is the audio track ending short by exactly
// the distance it moved.
//
// Two things make these tests worth having. The correction is applied blind — nothing downstream
// re-checks the result — so a sign flip would push the sound the WRONG way and double the fault on
// files guests keep. And it is applied to the ORIGINAL, by a backfill that runs over every clip on
// every boot, so "already corrected" must read as "nothing to do" forever. Measuring ends rather
// than durations is what buys that, and it is the thing most likely to get "simplified" back.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { endsFrom, audioLeadFrom, leadTooBig, alreadyPlaced,
         AUDIO_LEAD_MIN_SECS, AUDIO_LEAD_MAX_SECS } from '../images';

/** Real `ffprobe -show_entries stream=codec_type,start_time,duration -of csv=p=0` output. */
const lead = (probe: string) => audioLeadFrom(endsFrom(probe));

describe('measuring how far the sound runs ahead of the picture', () => {
  test('the clips off the phone that started this report', () => {
    assert.equal(+lead('audio,0.000000,1.534667\nvideo,0.000000,2.531233').toFixed(4), 0.9966);
    assert.equal(+lead('audio,0.000000,3.261542\nvideo,0.000000,4.232033').toFixed(4), 0.9705);
    assert.equal(+lead('audio,0.000000,2.664604\nvideo,0.000000,3.079300').toFixed(4), 0.4147);
  });

  test('A CORRECTED CLIP REPORTS NOTHING TO DO — the backfill must not shift it twice', () => {
    // Exactly what the fix produces: same 1.534667s of audio, now starting at 0.997 instead of 0.
    // Read as durations this is indistinguishable from the broken file above, which is the whole
    // reason ends are used. Every boot runs the backfill over every clip; this is what stops that
    // walking the sound further out of step each time.
    assert.equal(lead('video,0.000000,2.531233\naudio,0.997000,1.534667'), 0);
  });

  test('clips recorded with a warm microphone are left alone', () => {
    assert.equal(lead('audio,0.000000,2.920437\nvideo,0.000000,2.946700'), 0);   // -26ms
    assert.equal(lead('audio,0.000000,7.316750\nvideo,0.000000,7.313867'), 0);   // audio a hair longer
  });

  test('audio LONGER than video is never treated as a lead', () => {
    // The harmless direction. Delaying already-late audio would only make it worse.
    assert.equal(lead('audio,0.000000,2.500000\nvideo,0.000000,2.000000'), 0);
  });

  test('a clip with no sound is left alone rather than guessed at', () => {
    assert.equal(endsFrom('video,0.000000,5.000000'), null);
    assert.equal(lead('video,0.000000,5.000000'), 0);
  });

  test('rows ffprobe could not work out are not numbers to act on', () => {
    for (const probe of ['video,N/A,5.0\naudio,0.0,4.0', 'video,0.0,N/A\naudio,0.0,4.0',
                         'video,0.0,5.0\naudio,N/A,4.0', 'video,0.0,5.0\naudio,0.0,0',
                         'video,0.0,-1\naudio,0.0,4.0', '', 'nonsense']) {
      assert.equal(endsFrom(probe), null, `${JSON.stringify(probe)} should not parse`);
      assert.equal(lead(probe), 0);
    }
  });

  test('the first stream of each kind wins, and other streams are ignored', () => {
    // A clip can carry a second audio track or a cover-art "video" stream; the fix maps 0:v:0 and
    // 1:a:0, so the measurement has to describe those same two and nothing else.
    const ends = endsFrom('video,0.000000,2.531233\naudio,0.997000,1.534667\n' +
                          'audio,0.000000,9.000000\ndata,0.000000,2.000000');
    assert.deepEqual(ends, { v: 2.531233, a: 2.531667, aStart: 0.997 });
  });

  test('A DEFICIT TOO BIG TO BE A WAKE-UP IS LEFT ALONE, not shifted', () => {
    // A real clip: 15.468s of video carrying 3.926s of audio. Corrected, the 11.5s "lead" moved the
    // whole soundtrack to the END of the clip — sound nowhere near its picture, which is worse than
    // the fault it was fixing. The assumption behind the shift is that the gap is time the mic spent
    // waking up, and 11.5s is not that.
    const broken = 'video,0.000000,15.468000\naudio,0.000000,3.926000';
    assert.equal(audioLeadFrom(endsFrom(broken)), 0);
    assert.equal(leadTooBig(endsFrom(broken)), true);
  });

  test('the biggest real wake-up still gets corrected', () => {
    // 0.997s, the worst measured across four sessions, on a clip only 2.5s long. A cap expressed as
    // a FRACTION of the clip would refuse this one at 39% — which is why the cap is absolute: the
    // wake-up is a property of the device, not of how long someone held the button.
    assert.ok(audioLeadFrom(endsFrom('video,0.000000,2.531233\naudio,0.000000,1.534667')) > 0.99);
    assert.equal(leadTooBig(endsFrom('video,0.000000,2.531233\naudio,0.000000,1.534667')), false);
  });

  test('either side of the upper cap falls the way it should', () => {
    assert.ok(audioLeadFrom(endsFrom('video,0.000000,10.0\naudio,0.000000,8.1')) > 0);   // 1.9s
    assert.equal(audioLeadFrom(endsFrom('video,0.000000,10.0\naudio,0.000000,7.9')), 0); // 2.1s
    assert.equal(AUDIO_LEAD_MAX_SECS, 2.0);
  });

  test('a clip with no audio is not reported as a too-big lead', () => {
    // endsFrom already refuses it, and leadTooBig must not turn that into a log line on every
    // silent clip in the library — a backfill walks all of them, every boot.
    assert.equal(leadTooBig(endsFrom('video,0.000000,5.000000')), false);
  });

  test('A PLACED AUDIO TRACK IS NEVER SHIFTED AGAIN, however the numbers read', () => {
    // The clip that forced this guard. Its 11.5s shift was only partly written, so the next pass
    // read the leftover as a fresh 7.7s lead and corrected on top — stacking to 11.542s and putting
    // the soundtrack past the end of the picture. Every one of these has a non-zero audio start,
    // which only we ever set, and that alone is enough to refuse. Note the SECOND case would
    // otherwise measure as a perfectly ordinary 3.8s... and the third as a plausible 0.9s.
    for (const probe of ['video,0.000000,15.467556\naudio,11.542000,3.925271',
                         'video,0.000000,15.467556\naudio,3.831000,3.925271',
                         'video,0.000000,4.836100\naudio,0.997000,2.939000']) {
      const ends = endsFrom(probe);
      assert.equal(alreadyPlaced(ends), true, probe);
      assert.equal(audioLeadFrom(ends), 0, probe);
      assert.equal(leadTooBig(ends), false, probe);   // and not logged as a fault on every boot
    }
  });

  test('a tiny non-zero audio start is still an uncorrected clip', () => {
    // Real files arrive with starts like 0.003 and 0.017 — container rounding, not placement. Those
    // must stay correctable, so the guard sits at the same threshold as the smallest shift we make.
    assert.equal(alreadyPlaced(endsFrom('video,0.000000,3.000000\naudio,0.003000,2.000000')), false);
    assert.ok(audioLeadFrom(endsFrom('video,0.000000,3.000000\naudio,0.003000,2.000000')) > 0.9);
  });

  test('a lead either side of the threshold falls the way it should', () => {
    // Not asserted AT the threshold: `1.15 - 1` is 0.14999999999999991, so the exact boundary is
    // not a place a real duration lands. That it holds a hair above and below is the part to pin.
    assert.ok(lead('audio,0.000000,1.0\nvideo,0.000000,1.2') > 0);
    assert.equal(lead('audio,0.000000,1.0\nvideo,0.000000,1.1'), 0);
    assert.equal(AUDIO_LEAD_MIN_SECS, 0.15);
  });
});
