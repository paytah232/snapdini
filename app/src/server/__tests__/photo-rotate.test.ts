// Turning a sideways shot the right way up.
//
// THE FAULT. A photo taken in this app is a square canvas crop with no EXIF whatsoever — no
// orientation tag, nothing a viewer could honour. With the phone's rotation lock on, turning it
// sideways moves nothing: the page stays portrait, the camera track stays portrait, and the scene
// lands in the file lying on its side. capture_orientation (0042) is the only witness, and it says
// 'landscape' without saying WHICH WAY, so nothing can be corrected automatically. Thirteen
// production photos are in exactly that state, which is why the fix is a button and not a sweep.
//
// What is worth a test file here is not the sharp call. It is the four decisions around it, each of
// which is silent when wrong:
//
//   WHO may press it — the guest who took it, or the host. A guest at the same event who did not
//   take the shot is a stranger to it, and one line in `mayRotate` is all that says so.
//
//   WHAT counts as a turn — 90, -90, 180 and nothing else. 270 and 0 are refused rather than
//   guessed at; 0 in particular would rewrite the file, change its name and invalidate every cached
//   copy of it to achieve nothing.
//
//   WHEN THE MARK COMES OFF — `shotSideways` has to answer no once a photo has been dealt with. It
//   used to be derived from capture_orientation, which cannot say whether the page turned with the
//   phone, so it also fired on landscape shots that were perfectly upright; it now reads
//   capture_turn (0069) and capture_rotation and nothing else. The legacy half of that story is in
//   capture-turn.test.ts, which owns the new rule.
//
//   THAT THE NAME CHANGES — /uploads is served `immutable, max-age=365d`, so rewriting bytes under
//   the same name fixes the photo for nobody with a warm cache. The rename IS the cache-bust.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { mayRotate, readQuarter, shotSideways, photoRow } from '../routes/photos';
import { normalizeTurn, derivedNames, rotateImageTo } from '../images';
import { applyReplicaState, blockedByReadOnly } from '../readonly';

describe('who may turn a photo', () => {
  const OWNER = 'participant-who-took-it';

  test('the guest who took it', () => {
    assert.equal(mayRotate({ photoOwnerId: OWNER, askerParticipantId: OWNER, organizerCodeMatches: false }), true);
  });

  test('the host, on a photo that is not theirs', () => {
    // The host curates the album and is the one who has to answer for what a shared gallery says,
    // so they may straighten anything in their event.
    assert.equal(mayRotate({ photoOwnerId: OWNER, askerParticipantId: null, organizerCodeMatches: true }), true);
    assert.equal(mayRotate({ photoOwnerId: OWNER, askerParticipantId: 'someone-else', organizerCodeMatches: true }), true);
  });

  test('ANOTHER GUEST AT THE SAME EVENT MAY NOT', () => {
    // The one that matters. A valid session for this event is not a claim on somebody else's shot,
    // and this is the only line in the product that says so.
    assert.equal(mayRotate({ photoOwnerId: OWNER, askerParticipantId: 'another-guest', organizerCodeMatches: false }), false);
  });

  test('nobody at all may not', () => {
    // No session and no organizer code — the anonymous gallery viewer.
    assert.equal(mayRotate({ photoOwnerId: OWNER, askerParticipantId: null, organizerCodeMatches: false }), false);
  });

  test('a null asker can never match a null owner into a yes', () => {
    // Defensive: `askerParticipantId === photoOwnerId` alone would be true for two nulls, and the
    // route hands it null for "no session". A photo always has an owner, so this is unreachable
    // today — and it is exactly the kind of unreachable that stops being so.
    assert.equal(mayRotate({ photoOwnerId: null as unknown as string, askerParticipantId: null, organizerCodeMatches: false }), false);
  });
});

describe('what counts as a turn', () => {
  test('the three real ones, as numbers', () => {
    assert.equal(readQuarter(90), 90);
    assert.equal(readQuarter(-90), -90);
    assert.equal(readQuarter(180), 180);
  });

  test('the same three as strings, because a form post is a string', () => {
    assert.equal(readQuarter('90'), 90);
    assert.equal(readQuarter(' -90 '), -90);
    assert.equal(readQuarter('180'), 180);
  });

  test('270 is refused rather than folded into -90', () => {
    // The same turn, spelled the way a buggy client spells it. Guessing hides the bug; refusing
    // shows it, and the wire contract is a named turn chosen by somebody pressing a button.
    assert.equal(readQuarter(270), null);
    assert.equal(readQuarter(-270), null);
  });

  test('0 is refused — it is not a rotation', () => {
    // Honouring it would re-encode the file, change its name and invalidate every cached copy of
    // it, all to produce the identical picture.
    assert.equal(readQuarter(0), null);
    assert.equal(readQuarter('0'), null);
    assert.equal(readQuarter(360), null);
  });

  test('anything that is not one of the three is a 400', () => {
    for (const raw of [undefined, null, '', '  ', 45, 91, 89, 1.5, NaN, Infinity, true, {}, [], 'ninety', '90deg'])
      assert.equal(readQuarter(raw), null, `readQuarter(${JSON.stringify(raw)})`);
  });
});

// The "shot sideways" mark itself lives in capture-turn.test.ts: what it is derived FROM changed
// with 0069, and the interesting cases there are now about captureTurn rather than about rotating.
// What belongs here is only that a rotation moves the mark, which the accumulation block below and
// the route suite both cover.

describe('rotations accumulate, and stay in one window', () => {
  // (-180, 180]. 270 and -90 are the same turn, and storing both spellings would make every later
  // "has this been corrected?" answer twice.
  const add = (was: number | null, quarter: number) => normalizeTurn((was ?? 0) + quarter);

  test('two quarters the same way make a half', () => {
    assert.equal(add(90, 90), 180);
    assert.equal(add(-90, -90), 180);          // -180 and 180 are one value, and 180 is the one kept
  });

  test('two halves come back to nothing', () => {
    assert.equal(add(180, 180), 0);
  });

  test('a quarter back undoes a quarter', () => {
    assert.equal(add(90, -90), 0);
    assert.equal(add(-90, 90), 0);
  });

  test('past the half, it wraps to the short way round', () => {
    assert.equal(add(180, 90), -90);           // 270
    assert.equal(add(180, -90), 90);           // 90
    assert.equal(add(-90, 180), 90);
  });

  test('four quarters land back where they started', () => {
    let r: number | null = null;
    for (let i = 0; i < 4; i++) r = add(r, 90);
    assert.equal(r, 0);
  });

  test('a NULL start is a zero start', () => {
    assert.equal(add(null, 90), 90);
  });

  test('the window is (-180, 180] and never [-180, 180)', () => {
    assert.equal(normalizeTurn(-180), 180);
    assert.equal(normalizeTurn(540), 180);
    assert.equal(normalizeTurn(-450), -90);
  });
});

describe('the pixels actually move, and the right way', () => {
  // Measured rather than asserted from the documentation, because the whole feature is a direction
  // and a direction that is 180 degrees wrong looks exactly as "implemented" as one that is right.
  // The same check was run against ffmpeg's `-display_rotation` while writing rotateClipTo, so the
  // still path and the clip path are known to agree.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdini-rotate-'));

  const leftRed = async (file: string) => {
    const red = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
    const blue = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer();
    await sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .composite([{ input: red, left: 0, top: 0 }, { input: blue, left: 20, top: 0 }])
      .jpeg().toFile(file);
  };
  const dominant = async (file: string, half: 'top' | 'bottom') => {
    const meta = await sharp(file).metadata();
    const h = Math.floor((meta.height ?? 0) / 2);
    const { data } = await sharp(file)
      .extract({ left: 2, top: half === 'top' ? 2 : h + 2, width: 4, height: 4 })
      .raw().toBuffer({ resolveWithObject: true });
    return data[0] > data[2] ? 'red' : 'blue';
  };

  test('a quarter clockwise puts the left edge on top', async () => {
    const src = path.join(tmp, 'src.jpg'), out = path.join(tmp, 'cw.jpg');
    await leftRed(src);
    const dims = await rotateImageTo(src, out, 90);
    assert.deepEqual([dims.width, dims.height], [20, 40], 'a quarter turn swaps the sides');
    assert.equal(await dominant(out, 'top'), 'red');
    assert.equal(await dominant(out, 'bottom'), 'blue');
  });

  test('a quarter the other way puts it on the bottom', async () => {
    const src = path.join(tmp, 'src2.jpg'), out = path.join(tmp, 'ccw.jpg');
    await leftRed(src);
    const dims = await rotateImageTo(src, out, -90);
    assert.deepEqual([dims.width, dims.height], [20, 40]);
    assert.equal(await dominant(out, 'top'), 'blue');
    assert.equal(await dominant(out, 'bottom'), 'red');
  });

  test('a half turn keeps the shape and is its own undo', async () => {
    const src = path.join(tmp, 'src3.jpg'), once = path.join(tmp, 'half.jpg'), twice = path.join(tmp, 'half2.jpg');
    await leftRed(src);
    const d1 = await rotateImageTo(src, once, 180);
    assert.deepEqual([d1.width, d1.height], [40, 20], 'a half turn must NOT swap the sides');
    const d2 = await rotateImageTo(once, twice, 180);
    assert.deepEqual([d2.width, d2.height], [40, 20]);
  });

  test('the SOURCE is never touched — the output is a new file', async () => {
    // This is the rename, seen from the disk's side: /uploads is served immutable, so an in-place
    // rewrite would be invisible to every warm cache. rotateImageTo must therefore never be able to
    // clobber its own input.
    const src = path.join(tmp, 'src4.jpg'), out = path.join(tmp, 'new4.jpg');
    await leftRed(src);
    const before = fs.readFileSync(src);
    await rotateImageTo(src, out, 90);
    assert.deepEqual(fs.readFileSync(src), before, 'the original was modified in place');
    assert.ok(fs.existsSync(out));
  });
});

describe('the derived files are listed in ONE place', () => {
  // Two routes must account for exactly the same set — delete removes them, rotate moves them — and
  // the failure when the two lists disagree is silent: an orphaned `_dl.mp4` nobody sees, or a
  // gallery still serving a crop cut from the pre-rotation clip.
  test('every copy the pipeline can make is named', () => {
    assert.deepEqual(derivedNames('ev1/abc.mp4').sort(), [
      'ev1/abc_crop.mp4',
      'ev1/abc_crop_play.mp4',
      'ev1/abc_crop_play_thumb.webp',
      'ev1/abc_crop_thumb.webp',
      'ev1/abc_dl.mp4',
      'ev1/abc_dl_thumb.webp',
      'ev1/abc_play.mp4',
      'ev1/abc_play_thumb.webp',
      'ev1/abc_thumb.webp',
    ]);
  });

  test('the thumbnails of the DERIVED clips are in it too', () => {
    // The one that had to be found the hard way. `backfillThumbnails` posters every video in an
    // event folder on boot, derived copies included, so `<id>_play_thumb.webp` exists on disk —
    // and the delete route's hand-written list had never named it, so every deleted clip left one
    // behind. A rotation renaming the base is what finally made the orphan visible.
    for (const n of ['ev1/abc_play_thumb.webp', 'ev1/abc_crop_play_thumb.webp', 'ev1/abc_dl_thumb.webp'])
      assert.ok(derivedNames('ev1/abc.mp4').includes(n), `${n} is not accounted for`);
  });

  test('the ORIGINAL is deliberately not in it', () => {
    // So that no caller can delete the original while meaning to clear only the copies.
    assert.ok(!derivedNames('ev1/abc.jpg').includes('ev1/abc.jpg'));
  });

  test('it is a pure name transform, so old and new bases pair up index by index', () => {
    // Which is exactly how the rotate route moves a clip's siblings onto the new uuid.
    const from = derivedNames('ev1/old.mp4'), to = derivedNames('ev1/new.mp4');
    assert.equal(from.length, to.length);
    for (let i = 0; i < from.length; i++)
      assert.equal(from[i].replace('old', 'new'), to[i]);
  });
});

describe('a replica refuses the rotate', () => {
  test('it is a write, so the /api gate covers it without a list of its own', () => {
    // The gate is by METHOD, and rotate is a POST that rewrites a row and the filesystem. Pinned
    // because the escape hatch beside it (WRITES_NOTHING) is a list somebody could add to.
    applyReplicaState(true);
    assert.equal(blockedByReadOnly('POST', '/photos/abc123/rotate'), true);
    applyReplicaState(false);
    assert.equal(blockedByReadOnly('POST', '/photos/abc123/rotate'), false);
  });
});

describe('the reason the file is renamed is still true', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
  const photos = fs.readFileSync(path.join(__dirname, '..', 'routes', 'photos.ts'), 'utf8');

  test('/uploads is still served immutable for a year', () => {
    // If this ever stops being true, the rename stops being necessary and a query parameter would
    // do. While it IS true, rewriting bytes under an existing name fixes the photo for nobody whose
    // browser or CDN already holds it.
    assert.match(index, /app\.use\('\/uploads', express\.static\(UPLOADS_DIR, \{ immutable: true, maxAge: '365d' \}\)\)/,
      'uploaded media is no longer immutable — re-read the caching note on the rotate route');
  });

  test('the rotate route writes a NEW name into the row', () => {
    const at = photos.indexOf("router.post('/:id/rotate'");
    assert.ok(at > -1, 'the rotate route is gone');
    // Generous on purpose. This is a window onto ONE handler, and the handler grows: at 12000 the
    // last of the three patterns below sat 69 characters from the end, so any line added to the
    // rotate route pushed it out and failed this test for a reason that had nothing to do with the
    // property being pinned. The next `describe` starts well past 20000, so the window cannot reach
    // into code this test would be wrong to match.
    const body = photos.slice(at, at + 20000);
    assert.match(body, /set\(\{ filename: newRel/,
      'rotate no longer renames the file. With /uploads immutable, every viewer with a warm cache '
      + 'keeps the sideways picture and the host sees nothing happen when they press the button.');
    assert.match(body, /const olds = \[oldRel, \.\.\.derivedNames\(oldRel\)\];/,
      'the pre-rotation files are no longer cleaned up — every rotation would leak a full-size '
      + 'original plus its thumbnail onto the uploads volume.');
    assert.match(body, /fs\.accessSync\(uploadDiskPath\(news\[i\]\)\); \} catch \{ continue; \}/,
      'the cleanup no longer checks that a replacement exists before deleting the file it replaces. '
      + 'That check is the difference between litter (recoverable) and deleting the only copy of a '
      + "guest's crop, which nothing in the product ever rebuilds.");
  });

  test('a clip is rotated by metadata, never re-encoded', () => {
    const images = fs.readFileSync(path.join(__dirname, '..', 'images.ts'), 'utf8');
    const at = images.indexOf('export async function rotateClipTo');
    assert.ok(at > -1);
    const body = images.slice(at, at + 1400);
    assert.match(body, /'-c', 'copy'/, 'rotateClipTo is re-encoding — that is minutes of CPU in the '
      + 'single video slot and a visibly worse clip, to change a header value');
    assert.ok(!/libx264/.test(body));
  });
});
