// The phone was TURNED. Who has to do something about it, and what the badge is allowed to claim.
//
// TWO FACTS THAT LOOK LIKE ONE, and every defect in this area has come from treating them as one:
//
//   captureRotation  degrees CLOCKWISE already baked into the stored pixels. Work DONE.
//   captureTurn      degrees CLOCKWISE the phone was turned relative to the PAGE when the shot was
//                    framed. A MEASUREMENT — and, for a clip, the work still outstanding.
//
// For a photo they are the same number, because the camera rotates its own canvas before it encodes
// and can tell us by how much. For a clip they are not: MediaRecorder writes whatever the camera
// hands it, and a canvas in that path means a second encoder on a phone already struggling with the
// first, so a clip arrives turned and the server has to finish the job. Store the measurement in
// capture_rotation and a clip is marked corrected while its pixels are still on their side.
//
// WHAT THIS FILE PINS:
//
//   THE CLIP CORRECTION. A turned clip is remuxed with a display matrix — header only, `-c copy`,
//   no frame decoded — and so is every copy derived from it. A corrected original beside an
//   uncorrected playback proxy plays one way up and downloads the other, which is worse than
//   leaving the lot alone, so the whole set moves or none of it does. When it fails, the upload is
//   untouched and still succeeded: a guest at a party does not lose their clip to a cosmetic fix.
//
//   THAT A PHOTO IS LEFT ALONE. Its pixels were straightened at the shutter. Turning one here would
//   be a second rotation nobody asked for, and it is keyed off nothing subtler than the media type.
//
//   THE BADGE, WHICH WAS LYING. It was derived from capture_orientation, which reports 'landscape'
//   both when the page turned with the phone (the picture is fine) and when rotation lock kept the
//   page still (the picture is sideways) — so it fired on correctly-captured landscape shots. It
//   was reported against a clip that had come out perfectly. capture_orientation is now out of the
//   derivation entirely, and the two rows that tell the story here differ ONLY in captureTurn.
//
//   AND WHAT LEGACY ROWS DO, which is nothing. Every row in production predates capture_turn, so
//   the badge goes quiet everywhere at once — the thirteen genuinely sideways photos included. That
//   is the owner's decision, taken over a grandfather clause that would have kept those thirteen by
//   reinstating the false positive for every landscape row uploaded since. One rule, one meaning.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

// ── Set before anything under test is loaded ─────────────────────────────────
// paths.ts reads UPLOADS_DIR once, at import: a suite that writes into the real uploads volume is
// one that can delete somebody's photos.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdini-capture-turn-'));
process.env.UPLOADS_DIR = TMP;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

// ── A database that remembers the one row an upload inserts ──────────────────

const tableName = (t: unknown): string =>
  (t as Record<symbol, string>)?.[Symbol.for('drizzle:Name')] ?? 'unknown';

/** Pull the bound values back out of a Drizzle condition — the same helper, for the same reason, as
 *  photo-rotate-route.test.ts: the correction's UPDATE is guarded by a WHERE, and a fake that
 *  cannot read a WHERE cannot tell a guarded write from an unguarded one. */
function condValues(cond: unknown): unknown[] {
  const vals: unknown[] = [];
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const walk = (n: any): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if ('value' in n && (typeof n.value === 'string' || typeof n.value === 'number')) vals.push(n.value);
    if (Array.isArray(n.queryChunks)) n.queryChunks.forEach(walk);
  };
  walk(cond);
  return vals;
}

const EVENT_ID = 'ev1';
const OWNER = 'guest-who-took-it';
const SESSION = 'session-owner';

/** The photo row as the database would hold it: what the insert wrote, plus anything a later UPDATE
 *  has set on it. Which is the whole question for the clip correction — did it record itself? */
let stored: Record<string, unknown> | null = null;
let photoUpdates: { set: Record<string, unknown>; where: unknown[] }[] = [];

/* eslint-disable @typescript-eslint/no-explicit-any */
function chain<T>(produce: (c: any) => T): any {
  const o: any = {
    where(cond: unknown) { o._where = condValues(cond); return o; },
    set(v: Record<string, unknown>) { o._set = v; return o; },
    values(v: Record<string, unknown>) { o._values = v; return o; },
    returning() { return o; },
    limit() { return o; }, orderBy() { return o; },
    innerJoin() { return o; }, leftJoin() { return o; },
    onConflictDoNothing() { return o; },
    then(res: (v: T) => unknown, rej: (e: unknown) => unknown) {
      return Promise.resolve().then(() => produce(o)).then(res, rej);
    },
  };
  return o;
}

/** The participants⋈events row the upload path resolves from a session token. `videoSeconds` is
 *  non-zero because a hosted event with video switched off refuses clips at the gate, and every
 *  clip in this file has to get past it. */
const participant = () => ({
  id: OWNER, photosTaken: 0, maxPhotos: 12, extraPhotos: 0,
  isLocked: false, startsAt: null, expiresAt: Date.now() + 3_600_000,
  eventId: EVENT_ID, moderationEnabled: false, videoSeconds: 30,
  challengeSet: null, eventChallenges: null, aspectRatios: '["1:1","4:5","full"]',
});

const fakeDb: any = {
  select() { return { from(t: unknown) {
    return chain(() => (tableName(t) === 'participants' ? [participant()]
      : tableName(t) === 'events' ? [{ id: EVENT_ID }] : []));
  } }; },
  selectDistinct() { return this.select(); },
  update(t: unknown) {
    return chain((c) => {
      // The atomic claim on the guest's roll. Always granted here; allowance is not this file.
      if (tableName(t) !== 'photos') return [{ photosTaken: 1, extraPhotos: 0, maxPhotos: 12 }];
      photoUpdates.push({ set: c._set, where: c._where ?? [] });
      if (!stored || !(c._where ?? []).includes(stored.filename)) return [];
      Object.assign(stored, c._set);
      return [{ id: stored.id }];
    });
  },
  insert(t: unknown) {
    return chain((c) => { if (tableName(t) === 'photos') stored = { ...c._values }; return []; });
  },
  delete() { return chain(() => []); },
  transaction(cb: (tx: unknown) => unknown) { return Promise.resolve().then(() => cb(fakeDb)); },
};

const dbPath = require.resolve('../db');
require(dbPath);                                     // builds a pool object; connects to nothing
require.cache[dbPath]!.exports = { db: fakeDb, schema: {}, pool: {} };

// ── ffmpeg, stood in for ─────────────────────────────────────────────────────
//
// A COPY OF THE MODULE'S EXPORTS, not a proxy and not a rewrite of images.ts: the live functions are
// carried across by reference, so whileDeriving/isDeriving here are the very ones routes/photos.ts
// will call and share the one register between them. Only the handful that shell out to ffmpeg are
// then overwritten. A unit run is not entitled to assume ffmpeg exists — photo-rotate-route.test.ts
// says so where it declines to stage the real case — and a stub buys determinism besides: which
// files were turned, in what order, and what happens when the fourth one fails.
const imagesPath = require.resolve('../images');
const realImages = require(imagesPath) as Record<string, unknown>;
const images: any = {};
for (const k of Object.keys(realImages)) images[k] = realImages[k];
require.cache[imagesPath]!.exports = images;

const slideshowPath = require.resolve('../slideshow');
const realSlideshow = require(slideshowPath) as Record<string, unknown>;
const slideshow: any = {};
for (const k of Object.keys(realSlideshow)) slideshow[k] = realSlideshow[k];
require.cache[slideshowPath]!.exports = slideshow;

const { derivedNames, thumbName, playName, cropName, dlName, isDeriving } = realImages as any;

/** Every call rotateClipTo received, in order. The order is load-bearing: the original has to be in
 *  the set, and so does every derived clip that exists at the time. */
let turns: { src: string; dest: string; clockwise: number }[] = [];
/** Files the stubbed pipeline "built" after the upload was answered, so the correction has real
 *  siblings to find on disk. */
let derived: string[] = [];
/** The suffix of the file ffmpeg is to refuse. Matched on the end of the name so a test can set it
 *  BEFORE the upload, which is when the correction may already be under way. */
let failOn: string | null = null;

/** Every stub yields to the event loop first. Not decoration: all of this work is started
 *  unawaited, and a stub that settles inside the same microtask chain as the upload handler
 *  finishes before the guest is answered — which is the one thing none of it does in production,
 *  and which quietly made "delete the clip mid-derivation" and "fail on the fourth file"
 *  untestable. A timer puts the work where it really is, after the response. */
const later = () => new Promise((r) => setTimeout(r, 0));

const abs = (rel: string) => path.join(TMP, rel);
const write = (rel: string, body: string) => {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), body);
};

// Coded dimensions, so the width/height swap a quarter turn implies is something a test can see.
slideshow.probeVideoMeta = async () => ({ width: 1920, height: 1080, durationMs: 5_000 });

// Each of these refuses a source that is not there, exactly as ffmpeg does when its input has been
// unlinked out from under it — which is what makes "the guest took their shot back" a real case
// rather than a stub obligingly rebuilding what the test just deleted.
images.makeVideoPoster = async (file: string) => {
  await later();
  if (!fs.existsSync(file)) return false;
  write(path.relative(TMP, thumbName(file)), 'poster'); return true;
};
images.fixAudioLead = async () => { await later(); return false; };
images.makePlaybackProxy = async (file: string) => {
  await later();
  if (!fs.existsSync(file)) return false;
  const rel = path.relative(TMP, playName(file));
  write(rel, 'proxy'); derived.push(rel); return true;
};
images.cropClipToShape = async (file: string) => {
  await later();
  if (!fs.existsSync(file)) return false;
  // The lossless crop, the proxy cut from it, and the full-resolution download copy. The `_dl` one
  // is deliberately included: cropClipToShape starts it unawaited in the real module, and "it
  // exists by the time the correction runs" is the interleaving worth covering.
  for (const name of [cropName(file), playName(cropName(file)), dlName(file)]) {
    const rel = path.relative(TMP, name);
    write(rel, 'derived'); derived.push(rel);
  }
  return true;
};
images.rotateClipTo = async (src: string, dest: string, clockwise: number) => {
  await later();
  turns.push({ src: path.relative(TMP, src), dest: path.relative(TMP, dest), clockwise });
  if (failOn && src.endsWith(failOn)) return false;
  // A real rotateClipTo writes a NEW file and leaves the source alone — the marker is how the test
  // tells a file that was replaced from one that was merely left where it was.
  fs.writeFileSync(dest, 'TURNED:' + clockwise);
  return true;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const photosRoutes = require('../routes/photos') as typeof import('../routes/photos');
const { INCOMING_DIR } = require('../paths') as typeof import('../paths');
const { shotSideways, readTurn, photoRow } = photosRoutes;

/** shotSideways, widened to accept capture_orientation.
 *
 *  The function's own parameter type no longer mentions that column — which is itself the fix, and
 *  is why several tests below could not call it directly. They pass through here so the claim
 *  "orientation cannot change the answer" can still be made against real values rather than being
 *  left to the type checker, which only stops the next caller from PASSING it. */
const badge = (p: { captureOrientation?: string | null; captureTurn?: number | null; captureRotation?: number | null }) =>
  shotSideways(p);

// ── Driving the upload handler ───────────────────────────────────────────────

interface Reply { code: number; body: any }          // eslint-disable-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const routeHandler = (method: string, p: string): ((req: any, res: any) => Promise<void>) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (photosRoutes.default as any).stack
    .find((l: any) => l.route?.path === p && l.route?.methods?.[method]);   // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.ok(layer, `no ${method.toUpperCase()} ${p} — the handler under test has moved`);
  const stack = layer.route.stack;                   // the LAST handler, stepping over multer
  return stack[stack.length - 1].handle;
};

async function call(method: string, p: string, req: Record<string, unknown>): Promise<Reply> {
  const rec: Reply = { code: 200, body: undefined };
  const res: Record<string, unknown> = {
    status(c: number) { rec.code = c; return res; },
    json(b: unknown) { rec.body = b; return res; },
    end() { return res; },
  };
  await routeHandler(method, p)({ params: {}, body: {}, query: {}, get: () => undefined, ...req }, res);
  return rec;
}

let n = 0;
/** POST /api/photos with the clip multer would already have staged. */
async function uploadClip(body: Record<string, unknown> = {}): Promise<Reply> {
  const staged = path.join(INCOMING_DIR, `staged-${process.pid}-${n++}.mp4`);
  fs.mkdirSync(INCOMING_DIR, { recursive: true });
  fs.writeFileSync(staged, 'ORIGINAL');
  return call('post', '/', {
    body: { sessionToken: SESSION, mediaType: 'video', ...body },
    file: { path: staged, size: fs.statSync(staged).size, originalname: 'clip.mp4', mimetype: 'video/mp4' },
  });
}

/** The same, with a real JPEG — the photo path runs sharp for real. */
async function uploadPhoto(body: Record<string, unknown> = {}): Promise<Reply> {
  const staged = path.join(INCOMING_DIR, `staged-${process.pid}-${n++}.jpg`);
  fs.mkdirSync(INCOMING_DIR, { recursive: true });
  await sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg().toFile(staged);
  return call('post', '/', {
    body: { sessionToken: SESSION, ...body },
    file: { path: staged, size: fs.statSync(staged).size, originalname: 'shot.jpg', mimetype: 'image/jpeg' },
  });
}

/** Wait for everything the upload started under this base name, the correction included.
 *
 *  Safe to spin on: the correction registers itself with whileDeriving SYNCHRONOUSLY inside
 *  finalizeUpload, so the register cannot fall to zero between the copies landing and the turn
 *  beginning — which is the same property POST /:id/rotate depends on for its 409. */
async function settled(rel: string): Promise<void> {
  for (let i = 0; i < 2_000 && isDeriving(abs(rel)); i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(isDeriving(abs(rel)), false, 'the derivation register never let go of the name');
}

const filename = () => String(stored!.filename);
const eventFiles = () => fs.readdirSync(path.join(TMP, EVENT_ID)).sort();

beforeEach(() => { stored = null; photoUpdates = []; turns = []; derived = []; failOn = null; });

// ── WHAT COUNTS AS A MEASUREMENT ─────────────────────────────────────────────

describe('reading the turn off the wire', () => {
  test('the four positions a phone can be in, as numbers and as form strings', () => {
    for (const [raw, want] of [[0, 0], [90, 90], [-90, -90], [180, 180],
                               ['0', 0], ['90', 90], [' -90 ', -90], ['180', 180]] as const)
      assert.equal(readTurn(raw), want, `readTurn(${JSON.stringify(raw)})`);
  });

  test('ZERO IS KEPT, which is the whole difference from readQuarter', () => {
    // readQuarter refuses 0 because 0 is not a turn to APPLY — honouring it would rewrite a file
    // and invalidate every cached copy to produce the identical picture. Here 0 is the commonest
    // MEASUREMENT there is: the phone was square with the page. Drop it and a correct landscape
    // shot becomes indistinguishable from a row nobody measured, which is the badge's whole basis.
    assert.equal(readTurn(0), 0);
    assert.equal(photosRoutes.readQuarter(0), null);
  });

  test('anything else is NULL and never 0 — "nobody said" is not "nothing to say"', () => {
    for (const raw of [270, -270, 45, 1.5, NaN, Infinity, true, {}, [], '', '  ', 'ninety', '90deg', null, undefined])
      assert.equal(readTurn(raw), null, `readTurn(${JSON.stringify(raw)})`);
  });
});

// ── THE BADGE ────────────────────────────────────────────────────────────────

describe('the "shot sideways" mark', () => {
  // The two rows the whole change is about. IDENTICAL capture_orientation — which is exactly why it
  // could never decide this — and opposite answers.
  const layoutFollowed = { captureOrientation: 'landscape', captureTurn: 0, captureRotation: null };
  const rotationLocked = { captureOrientation: 'landscape', captureTurn: 90, captureRotation: null };

  test('THE REPORTED BUG: a landscape shot whose page turned with the phone does NOT badge', () => {
    // Auto-rotate on. The layout went landscape, the camera track went with it, and the scene is in
    // the file the right way up. Nothing needs doing and nothing should be asked of anybody.
    assert.equal(shotSideways(layoutFollowed), false,
      'the badge is firing on correctly-captured landscape shots again — this is the fault that was '
      + 'reported against a clip that had come out perfectly');
  });

  test('a genuinely sideways, uncorrected clip DOES badge', () => {
    // Rotation lock on. The page did not move, so the scene went into the file on its side, and
    // nothing has been applied against it — either the server correction has not run or it failed.
    assert.equal(shotSideways(rotationLocked), true);
  });

  test('and the only thing separating those two rows is the turn', () => {
    assert.equal(layoutFollowed.captureOrientation, rotationLocked.captureOrientation);
    assert.notEqual(shotSideways(layoutFollowed), shotSideways(rotationLocked));
  });

  test('LEGACY ROWS DO NOT BADGE — every row in production, on the day this ships', () => {
    // A deliberate, accepted loss, not an oversight: the operator's thirteen sideways photos stop
    // being findable by badge, and he straightens them as the site admin or leaves them. The
    // alternative was a fallback to capture_orientation for rows with no turn, which buys those
    // thirteen back by reinstating the false positive above for every landscape row since — and
    // leaves the product answering one question with two rules.
    for (const orientation of ['landscape', 'portrait', 'unknown', null, undefined])
      assert.equal(badge({ captureOrientation: orientation, captureTurn: null, captureRotation: null }), false,
        `orientation ${orientation}`);
    assert.equal(shotSideways({}), false, 'a select that never asked for the columns');
  });

  test('capture_orientation cannot influence the answer AT ALL any more', () => {
    // Pinned rather than assumed. It is still selected, still stored, and still the only record of
    // how the phone was held — so the way this regresses is somebody putting it back into the
    // derivation "just for the old rows", which is precisely the decision that was declined.
    for (const orientation of ['landscape', 'portrait', 'unknown', null, undefined]) {
      assert.equal(badge({ captureOrientation: orientation, captureTurn: 90, captureRotation: null }), true);
      assert.equal(badge({ captureOrientation: orientation, captureTurn: 0, captureRotation: null }), false);
    }
  });

  test('once something has corrected it, the mark comes off', () => {
    // Whoever did it: the camera at the shutter, the server on a clip, or a host pressing rotate.
    for (const applied of [90, -90, 180])
      assert.equal(shotSideways({ captureTurn: 90, captureRotation: applied }), false, `rotation ${applied}`);
  });

  test('a row rotated back to square one badges again', () => {
    // 180 twice. It is sideways once more, and the mark's job is to say so.
    assert.equal(shotSideways({ captureTurn: 90, captureRotation: 0 }), true);
  });

  test('the wire carries it only when true', () => {
    // Absent, not false: the gallery's single use is a mark, and `false` on every row of a
    // 14,000-photo payload is a field shipped to say nothing.
    const base = {
      id: 'p1', filename: 'ev1/a.mp4', takenAt: 1, participantName: 'Sam', participantId: 'g1',
      challengeId: null, isHighlighted: false, mediaType: 'video',
    };
    const caps = new Map<string, string>();
    assert.equal(photoRow({ ...base, ...rotationLocked }, null, caps).shotSideways, true);
    const fine = photoRow({ ...base, ...layoutFollowed }, null, caps);
    assert.equal(fine.shotSideways, undefined);
    assert.ok(!('shotSideways' in JSON.parse(JSON.stringify(fine))),
      'undefined is dropped by JSON, false is not');
  });
});

// ── THE CLIP CORRECTION ──────────────────────────────────────────────────────

describe('a turned clip is put upright by the upload that received it', () => {
  test('the original AND every derived copy get the display matrix, and the row records it', async () => {
    const r = await uploadClip({ captureTurn: 90, captureShape: '4:5', captureOrientation: 'landscape' });
    assert.equal(r.code, 200, JSON.stringify(r.body));

    const rel = filename();
    assert.equal(stored!.captureTurn, 90, 'the measurement was not stored');
    assert.equal(stored!.captureRotation, null, 'a clip arrives with nothing applied to it');
    assert.equal(shotSideways(stored as never), true, 'until the correction lands it IS sideways');

    await settled(rel);

    // Every clip under this base name, original first — the set derivedNames() owns, which is the
    // one list the delete route and the rotate route also work from.
    const wanted = [rel, ...derivedNames(rel)].filter((f: string) => /\.mp4$/.test(f));
    assert.equal(wanted.length, 5, 'derivedNames no longer names four derived clips');
    assert.deepEqual(turns.map((t) => t.src).sort(), wanted.sort(),
      'a copy was left behind. A corrected original beside an uncorrected playback proxy plays one '
      + 'way up and downloads the other — worse than the sideways clip we started with');
    for (const t of turns) assert.equal(t.clockwise, 90, `${t.src} was turned by ${t.clockwise}`);

    // Written to one side and moved into place, never over the top of the source.
    for (const t of turns) assert.notEqual(t.dest, t.src);
    for (const f of wanted)
      assert.equal(fs.readFileSync(abs(f), 'utf8'), 'TURNED:90', `${f} still holds its pre-turn bytes`);
    assert.deepEqual(eventFiles().filter((f) => f.includes('.turn')), [],
      'a temporary was left on the uploads volume');

    // And it says so, so nothing does it again.
    assert.equal(stored!.captureRotation, 90);
    assert.equal(shotSideways(stored as never), false, 'a corrected clip is still being badged');
    assert.equal(photoUpdates.length, 1);
    assert.ok(photoUpdates[0].where.includes(rel),
      'the correction wrote back without naming the file it started from — a row deleted or moved '
      + 'in the meantime would take the correction anyway');

    // The coded size does not change; the DISPLAYED shape does, and that is what the gallery lays
    // out with. Same swap, same rule, as the rotate route.
    assert.deepEqual([stored!.width, stored!.height], [1080, 1920]);
  });

  test('a half turn keeps the dimensions', async () => {
    await uploadClip({ captureTurn: 180 });
    await settled(filename());
    assert.equal(stored!.captureRotation, 180);
    assert.deepEqual([stored!.width, stored!.height], [1920, 1080]);
  });

  test('a clip nobody turned is not touched at all', async () => {
    // 0 is a measurement and must be stored as one — but it is not work.
    await uploadClip({ captureTurn: 0 });
    await settled(filename());
    assert.equal(stored!.captureTurn, 0, '0 must be kept, not folded into NULL');
    assert.deepEqual(turns, []);
    assert.equal(stored!.captureRotation, null);
  });

  test('a client too old to measure one is not touched either', async () => {
    await uploadClip({ captureOrientation: 'landscape' });
    await settled(filename());
    assert.equal(stored!.captureTurn, null);
    assert.deepEqual(turns, []);
    assert.equal(shotSideways(stored as never), false, 'legacy rows badge nothing — see above');
  });
});

describe('a correction that fails costs the guest nothing', () => {
  test('the upload still succeeded, every file is as it was, and the badge picks up the slack', async () => {
    // The LAST file in the set. Everything before it has already been turned into a temporary, so
    // this is the case where "all or nothing" is the only thing between a working clip and one that
    // plays upright and downloads sideways.
    failOn = '_dl.mp4';
    const r = await uploadClip({ captureTurn: -90, captureShape: '4:5' });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    const rel = filename();

    await settled(rel);

    assert.ok(turns.some((t) => t.src === dlName(rel)), 'the failing file was never reached');
    assert.equal(fs.readFileSync(abs(rel), 'utf8'), 'ORIGINAL',
      'the clip was half-corrected — the guest can still play it, but not the way they shot it');
    for (const f of derived)
      assert.ok(!/^TURNED/.test(fs.readFileSync(abs(f), 'utf8')), `${f} was moved into place anyway`);
    assert.deepEqual(eventFiles().filter((f) => f.includes('.turn')), [],
      'the abandoned temporaries are still on the volume');

    // Nothing was recorded, so nothing believes the clip has been dealt with...
    assert.deepEqual(photoUpdates, []);
    assert.equal(stored!.captureRotation, null);
    // ...and the badge is exactly the fallback: the host sees it in review and the rotate button
    // finishes the job by hand.
    assert.equal(shotSideways(stored as never), true);
  });

  test('a clip deleted while the correction was queued is simply dropped', async () => {
    await uploadClip({ captureTurn: 90 });
    const rel = filename();
    // The guest took their shot back. Every file under the base name goes with it.
    for (const f of [rel, ...derivedNames(rel)]) { try { fs.unlinkSync(abs(f)); } catch { /* */ } }
    await settled(rel);
    assert.deepEqual(turns, [], 'ffmpeg was run on files that are no longer there');
    assert.deepEqual(photoUpdates, [], 'a correction was written back for a deleted photo');
  });
});

// ── AND A PHOTO IS NEVER TOUCHED ─────────────────────────────────────────────

describe('a photo is already straight when it arrives', () => {
  test('the server does not rotate it again, however it was turned', async () => {
    // The camera turned its own canvas before encoding and told us by how much. Doing it again here
    // is the one failure this split of columns exists to prevent.
    const r = await uploadPhoto({ captureTurn: 90, captureRotation: 90, captureOrientation: 'landscape' });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    await settled(filename());
    assert.equal(stored!.captureTurn, 90);
    assert.equal(stored!.captureRotation, 90, "the shutter's own correction was dropped");
    assert.deepEqual(turns, [], 'a photo was put through the clip correction');
    assert.deepEqual(photoUpdates, []);
    assert.equal(shotSideways(stored as never), false);
  });

  test('a CLIP claiming a correction it cannot have made is not believed', async () => {
    // A camera can only bake a rotation into pixels it drew itself, and it draws only stills. A
    // video arriving with captureRotation set is therefore a client claiming work nobody did — and
    // believing it would take the badge off a clip still lying on its side.
    await uploadClip({ captureTurn: 90, captureRotation: 90 });
    assert.equal(stored!.captureRotation, null);
    assert.equal(shotSideways(stored as never), true);
    await settled(filename());
  });
});
