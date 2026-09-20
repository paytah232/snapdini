// POST /api/photos/:id/rotate, and the upload insert it depends on, driven as ROUTES.
//
// WHY A SECOND FILE. photo-rotate.test.ts pins the four decisions the feature is made of as pure
// functions — who may press it, what counts as a turn, when the mark comes off, that the pixels
// actually move. Every one of them passed while the route around them was wrong, because none of
// them is the route: an audit found the handler dropping a field the client sends on both upload
// paths, deleting files whose replacements had never been written, and answering a lost race with
// a 500. A pure-function suite cannot see any of that. This file drives the handlers.
//
// WHAT IT IS ALLOWED TO BE REAL ABOUT. The filesystem, sharp, and the handlers themselves: a
// rotation here really does encode a JPEG, really renames, really unlinks. Only the database is a
// stand-in — the same approach, and for the same reason, as billing-upgrade.test.ts: the claims
// worth making are "the row moved to the new name", "the insert carried captureRotation" and "the
// guarded UPDATE lost, so nothing was deleted", and a live Postgres would let all three pass for
// the wrong reason (or not run at all on a machine without one).
//
// THE FOUR DEFECTS THIS EXISTS FOR, each of which was silent in production:
//
//   1. `captureRotation` was posted by the camera on BOTH upload paths and read by neither. A
//      photo the shutter had already straightened stored capture_orientation 'landscape' with
//      nothing against it, so the "shot sideways" badge fired on an upright photo and invited the
//      host to rotate a correct picture — the exact thing the column was added to stop.
//   2. Rotating a clip raced the upload's own derivation, which runs for MINUTES after the guest
//      is answered, and deleted the old base regardless. The crop the guest chose was lost for
//      good, with orphans left under a name nothing references.
//   3. A rotation that lost a race to another rotation came back 500 instead of 409.
//   4. None of the above had a route-level test, which is why all of it survived review.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

// ── Everything below must be set BEFORE the modules under test are required ──
// paths.ts reads UPLOADS_DIR once, at import. A unit suite that writes into the real uploads
// volume is one that can delete somebody's photos.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdini-rotate-route-'));
process.env.UPLOADS_DIR = TMP;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

// ── A database that remembers one photo and what was asked of it ─────────────

const tableName = (t: unknown): string =>
  (t as Record<symbol, string>)?.[Symbol.for('drizzle:Name')] ?? 'unknown';

/** Pull the bound values back out of a Drizzle condition — the same helper, for the same reason,
 *  as billing-upgrade.test.ts: the guarded UPDATE at the heart of this feature is a WHERE, and a
 *  fake that cannot read a WHERE cannot tell the winner of a race from the loser. */
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

interface PhotoRow {
  id: string; eventId: string; participantId: string; filename: string;
  mediaType: string; width: number | null; height: number | null;
  captureOrientation: string | null; captureRotation: number | null; captureTurn: number | null;
  captureShape: string | null;
  takenAt: number; status: string; challengeId: string | null;
}

const EVENT_ID = 'ev1';
const OWNER = 'guest-who-took-it';
const ORG_CODE = 'org-code-not-a-real-secret';
const SESSION_OWNER = 'session-owner';
const SESSION_STRANGER = 'session-stranger';
const CHALLENGES = JSON.stringify({ sets: [{ key: 'a', label: 'Set A', items: [{ id: 'wear-a-hat', text: 'A hat' }] }] });

let photoRow: PhotoRow | null = null;
let updateSets: Record<string, unknown>[] = [];
let inserts: { table: string; values: Record<string, unknown> }[] = [];
let deleted: { id: string; filename: string }[] = [];
/** Fired ONCE, immediately after the handler has read the photo row — the moment a competing
 *  rotation or delete would commit. The whole point of the two race tests. */
let afterPhotoRead: (() => void) | null = null;

const participantsBySession: Record<string, { id: string; eventId: string }> = {
  [SESSION_OWNER]: { id: OWNER, eventId: EVENT_ID },
  [SESSION_STRANGER]: { id: 'another-guest-entirely', eventId: EVENT_ID },
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function chain<T>(produce: (c: any) => T): any {
  const o: any = {
    where(cond: unknown) { o._where = condValues(cond); return o; },
    set(v: Record<string, unknown>) { o._set = v; return o; },
    values(v: Record<string, unknown>) { o._values = v; return o; },
    returning() { return o; },
    limit() { return o; },
    orderBy() { return o; },
    innerJoin() { return o; },
    leftJoin() { return o; },
    onConflictDoNothing() { return o; },
    then(res: (v: T) => unknown, rej: (e: unknown) => unknown) {
      return Promise.resolve().then(() => produce(o)).then(res, rej);
    },
  };
  return o;
}

/** The participant row the upload path resolves from a session token, joined to its event. */
const uploadParticipant = () => ({
  id: OWNER, photosTaken: 0, maxPhotos: 12, extraPhotos: 0,
  isLocked: false, startsAt: null, expiresAt: Date.now() + 3_600_000,
  eventId: EVENT_ID, moderationEnabled: false, videoSeconds: 0,
  challengeSet: 'a', eventChallenges: CHALLENGES, aspectRatios: '["1:1"]',
});

function selectRows(table: string, c: any): unknown[] {
  const where = (c._where ?? []) as unknown[];
  if (table === 'participants') {
    // Both shapes land here: the rotate route's bare lookup by session token, and the upload
    // path's participants⋈events join.
    const token = where.find((v) => typeof v === 'string' && v in participantsBySession) as string | undefined;
    if (!token) return [];
    const p = participantsBySession[token];
    return [{ ...uploadParticipant(), ...p }];
  }
  if (table === 'events') return [{ id: EVENT_ID, organizerCode: ORG_CODE }];
  if (table === 'photos') {
    if (!photoRow || !where.includes(photoRow.id)) return [];
    const snapshot = { ...photoRow };
    const hook = afterPhotoRead; afterPhotoRead = null;
    if (hook) hook();
    return [snapshot];
  }
  return [];
}

const fakeDb: any = {
  select() { return { from(t: unknown) { return chain((c) => selectRows(tableName(t), c)); } }; },
  selectDistinct() { return { from(t: unknown) { return chain((c) => selectRows(tableName(t), c)); } }; },
  update(t: unknown) {
    return chain((c) => {
      const table = tableName(t);
      if (table !== 'photos') return [{ photosTaken: 1, extraPhotos: 0, maxPhotos: 12 }];
      // THE GUARD, honoured rather than assumed: `where filename = <the name we started from>`.
      // A rotation that committed first has already moved the row onto a new name, so the loser's
      // WHERE matches nothing and it must be told so.
      if (!photoRow || !(c._where ?? []).includes(photoRow.filename)) return [];
      updateSets.push(c._set);
      Object.assign(photoRow, c._set);
      return [{ id: photoRow.id }];
    });
  },
  insert(t: unknown) { return chain((c) => { inserts.push({ table: tableName(t), values: c._values }); return []; }); },
  delete(t: unknown) {
    return chain(() => {
      if (tableName(t) !== 'photos' || !photoRow) return [];
      const gone = { id: photoRow.id, filename: photoRow.filename };
      deleted.push(gone);
      photoRow = null;
      return [gone];
    });
  },
  transaction(cb: (tx: unknown) => unknown) { return Promise.resolve().then(() => cb(fakeDb)); },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// Swapped into the module cache BEFORE the routes are first loaded, so their `import { db }`
// resolves to the stand-in.
const dbPath = require.resolve('../db');
require(dbPath);                                     // constructs a pool object; connects to nothing
require.cache[dbPath]!.exports = { db: fakeDb, schema: {}, pool: {} };

const photosRoutes = require('../routes/photos') as typeof import('../routes/photos');
const images = require('../images') as typeof import('../images');
const { UPLOADS_DIR, INCOMING_DIR } = require('../paths') as typeof import('../paths');

// ── Driving the handlers ─────────────────────────────────────────────────────

interface Reply { code: number; body: any }   // eslint-disable-line @typescript-eslint/no-explicit-any
function fakeRes(): { res: unknown; rec: Reply } {
  const rec: Reply = { code: 200, body: undefined };
  const res: Record<string, unknown> = {
    status(c: number) { rec.code = c; return res; },
    json(b: unknown) { rec.body = b; return res; },
    end() { return res; },
  };
  return { res, rec };
}

/** The LAST handler on a route, so multer on POST / is stepped over rather than run — there is no
 *  multipart body here, only the file it would have staged. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const routeHandler = (method: string, p: string): ((req: any, res: any) => Promise<void>) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (photosRoutes.default as any).stack
    .find((l: any) => l.route?.path === p && l.route?.methods?.[method]);   // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.ok(layer, `no ${method.toUpperCase()} ${p} — the handler under test has moved`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
};

async function call(method: string, p: string, req: Record<string, unknown>): Promise<Reply> {
  const { res, rec } = fakeRes();
  await routeHandler(method, p)({ params: {}, body: {}, query: {}, get: () => undefined, ...req }, res);
  return rec;
}

type Who = { organizerCode?: string; sessionToken?: string };
const rotate = (quarter: unknown, who: Who = { organizerCode: ORG_CODE }, id = photoRow?.id) =>
  call('post', '/:id/rotate', {
    params: { id },
    body: { quarter, ...(who.sessionToken ? { sessionToken: who.sessionToken } : {}) },
    get: (h: string) => (h === 'x-organizer-code' ? who.organizerCode : undefined),
  });

// ── The photo on disk ────────────────────────────────────────────────────────

const disk = (rel: string) => path.join(UPLOADS_DIR, rel);
const there = (rel: string) => fs.existsSync(disk(rel));

/** A real 40×20 JPEG, red down the left half — the same fixture shape photo-rotate.test.ts uses to
 *  prove which way the pixels went. */
async function writeJpeg(file: string): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const red = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
  await sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 0, g: 0, b: 255 } } })
    .composite([{ input: red, left: 0, top: 0 }])
    .jpeg().toFile(file);
}

let n = 0;
/** One stored photo, on disk and in the stand-in, with its grid thumbnail beside it. */
async function givenAPhoto(over: Partial<PhotoRow> = {}): Promise<string> {
  const rel = `${EVENT_ID}/photo-${process.pid}-${n++}.jpg`;
  await writeJpeg(disk(rel));
  await images.makeThumbnail(disk(rel));
  photoRow = {
    id: 'p-' + n, eventId: EVENT_ID, participantId: OWNER, filename: rel, mediaType: 'photo',
    // captureTurn 90: a shot the phone really was turned for, which is what every fixture here is
    // meant to be. It is also what the badge is now derived from, so a fixture without it would
    // make "the mark came back" below pass or fail for a reason unrelated to rotating.
    width: 40, height: 20, captureOrientation: 'landscape', captureRotation: null, captureTurn: 90,
    captureShape: null,
    takenAt: Date.now(), status: 'pending', challengeId: null, ...over,
  };
  return rel;
}

beforeEach(() => { updateSets = []; inserts = []; deleted = []; afterPhotoRead = null; photoRow = null; });

// ── WHO MAY PRESS IT, through the route rather than through mayRotate() ───────

describe('the rotate route answers the right person', () => {
  test('the host, holding the organizer code', async () => {
    const rel = await givenAPhoto();
    const r = await rotate(90);
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.notEqual(photoRow!.filename, rel, 'the row still points at the pre-rotation name');
  });

  test('the guest who took it, holding their session', async () => {
    await givenAPhoto();
    const r = await rotate(90, { sessionToken: SESSION_OWNER });
    assert.equal(r.code, 200, JSON.stringify(r.body));
  });

  test('ANOTHER GUEST AT THE SAME EVENT IS A STRANGER TO IT', async () => {
    // The one that matters, and the one a pure mayRotate() test can only half tell you: a valid
    // session for this event must not reach the filesystem at all.
    const rel = await givenAPhoto();
    const r = await rotate(90, { sessionToken: SESSION_STRANGER });
    assert.equal(r.code, 404);
    assert.deepEqual(r.body, { error: 'Photo not found' }, '404 and nothing else — a 403 would '
      + 'confirm to a stranger that this photo id exists and whose roll it is in');
    assert.ok(there(rel), 'the original was touched on a refused rotation');
    assert.equal(updateSets.length, 0);
  });

  test('a gallery-link visitor — no session, no code — is refused', async () => {
    const rel = await givenAPhoto();
    const r = await rotate(90, {});
    assert.equal(r.code, 404);
    assert.ok(there(rel));
    assert.equal(updateSets.length, 0);
  });

  test('an organizer code for some OTHER event is just a stranger', async () => {
    await givenAPhoto();
    const r = await rotate(90, { organizerCode: 'some-other-events-code' });
    assert.equal(r.code, 404);
    assert.equal(updateSets.length, 0);
  });

  test('a bad turn is refused, and only AFTER the caller is known', async () => {
    // The order is the point: a 400 must be reachable only by somebody entitled to be here, or the
    // pair of statuses tells a stranger whether the photo exists.
    await givenAPhoto();
    assert.equal((await rotate(270)).code, 400);
    assert.equal((await rotate(270, { sessionToken: SESSION_STRANGER })).code, 404);
  });
});

// ── THE RENAME, WHICH IS THE ENTIRE CACHING STRATEGY ─────────────────────────

describe('the file is renamed and the old one stops existing', () => {
  test('a rotated photo lands under a new name, with its thumbnail, and the row follows', async () => {
    const rel = await givenAPhoto();
    assert.ok(there(rel) && there(images.thumbName(rel)));

    const r = await rotate(90);
    assert.equal(r.code, 200, JSON.stringify(r.body));
    const now = photoRow!.filename;

    assert.notEqual(now, rel, '/uploads is served immutable for a year — reusing the name fixes '
      + 'the photo for nobody whose browser or CDN already holds it');
    assert.ok(there(now), 'the rotated file is not on disk');
    assert.ok(there(images.thumbName(now)), 'the grid thumbnail was not re-cut under the new name');
    assert.ok(!there(rel), 'the pre-rotation original is still on the volume');
    assert.ok(!there(images.thumbName(rel)), 'the pre-rotation thumbnail is still on the volume');
    assert.equal(r.body.url, `/uploads/${now}`, 'the reply must carry the new URL — it IS the cache-bust');
  });

  test('a quarter turn swaps the stored dimensions, measured rather than assumed', async () => {
    await givenAPhoto();
    const r = await rotate(90);
    assert.deepEqual([r.body.width, r.body.height], [20, 40]);
    assert.deepEqual([photoRow!.width, photoRow!.height], [20, 40]);
  });

  test('a half turn keeps them', async () => {
    await givenAPhoto();
    const r = await rotate(180);
    assert.deepEqual([r.body.width, r.body.height], [40, 20]);
  });
});

// ── THE COLUMN THE WHOLE FEATURE EXISTS FOR ──────────────────────────────────

describe('capture_rotation accumulates through the route and stays in one window', () => {
  const rotateTwice = async (first: number, second: number) => {
    await givenAPhoto();
    await rotate(first);
    const r = await rotate(second);
    assert.equal(r.code, 200, JSON.stringify(r.body));
    return r;
  };

  test('a never-touched row takes the turn it was given', async () => {
    await givenAPhoto();
    const r = await rotate(90);
    assert.equal(r.body.captureRotation, 90);
    assert.equal(photoRow!.captureRotation, 90, 'the row must carry it, not just the reply');
  });

  test('two quarters the same way make a half', async () => {
    assert.equal((await rotateTwice(90, 90)).body.captureRotation, 180);
  });

  test('two halves come back to nothing — and the mark comes back with them', async () => {
    const r = await rotateTwice(180, 180);
    assert.equal(r.body.captureRotation, 0);
    assert.equal(r.body.shotSideways, true, 'the photo really is sideways again');
  });

  test('past the half it wraps the short way round, never to 270', async () => {
    assert.equal((await rotateTwice(180, 90)).body.captureRotation, -90);
  });

  test('a corrected photo reports the mark as a real false, not an absent field', async () => {
    // Unlike the gallery row. This reply exists to update a card already on screen, and a client
    // merging `undefined` cannot tell "no longer sideways" from "no opinion".
    await givenAPhoto();
    const r = await rotate(90);
    assert.equal(r.body.shotSideways, false);
    assert.ok('shotSideways' in JSON.parse(JSON.stringify(r.body)));
  });
});

// ── THE RACES ────────────────────────────────────────────────────────────────

describe('two rotations racing', () => {
  test('the loser gets a 409 and leaves nothing behind', async () => {
    // The winner commits between our read of the row and our UPDATE: the guarded
    // `where filename = <what we started from>` matches nothing.
    const rel = await givenAPhoto();
    afterPhotoRead = () => { photoRow!.filename = `${EVENT_ID}/somebody-else-got-here-first.jpg`; };

    const before = fs.readdirSync(path.join(UPLOADS_DIR, EVENT_ID)).length;
    const r = await rotate(90);
    assert.equal(r.code, 409);
    assert.match(r.body.error, /being changed by someone else/);
    assert.equal(fs.readdirSync(path.join(UPLOADS_DIR, EVENT_ID)).length, before,
      'the loser left its own output on the volume — nothing will ever reference or collect it');
    assert.ok(there(rel), 'the loser deleted a file it never replaced');
  });

  test('and a 409 — NOT a 500 — when the winner has already unlinked the source', async () => {
    // The same race, lost one step earlier: the winner's cleanup runs before sharp opens the file,
    // so sharp throws "Input file is missing". That surfaced as a generic 500, reporting an
    // internal fault for something that is only a conflict and that the caller should retry.
    const rel = await givenAPhoto();
    afterPhotoRead = () => { fs.unlinkSync(disk(rel)); };

    const r = await rotate(90);
    assert.equal(r.code, 409, 'a vanished source is a conflict, not a server fault');
    assert.match(r.body.error, /being changed by someone else/);
  });
});

// ── THE RACE THAT COST A GUEST THEIR CROP ────────────────────────────────────

describe('a clip whose derived copies are still being built refuses to be renamed', () => {
  test('rotate is refused while the upload is still deriving, and nothing moves', async () => {
    // finalizeUpload answers the guest and then builds the crop, poster, proxy and download copy —
    // minutes of work behind one video slot. Renaming inside that window leaves the finished job
    // writing under a base nothing references, and the new base with no crop that anything will
    // ever rebuild: the shape the guest chose reverts to full frame for good.
    const rel = await givenAPhoto({ mediaType: 'video', captureShape: '4:5' });
    let release!: () => void;
    const job = new Promise<void>((r) => { release = r; });
    const tracked = images.whileDeriving(disk(rel), () => job);

    const r = await rotate(90);
    assert.equal(r.code, 409);
    assert.match(r.body.error, /still being prepared/);
    assert.equal(updateSets.length, 0, 'the row was moved while its copies were still being written');
    assert.equal(photoRow!.filename, rel);
    assert.ok(there(rel));

    release();
    await tracked;
    assert.equal(images.isDeriving(disk(rel)), false, 'the register never let go of the name');
  });

  test('a job that fails still releases the name', async () => {
    // Otherwise one failed transcode wedges a photo shut for the life of the process, which is a
    // worse bug than the race being closed here.
    const rel = await givenAPhoto();
    await images.whileDeriving(disk(rel), () => Promise.reject(new Error('ffmpeg died'))).catch(() => {});
    assert.equal(images.isDeriving(disk(rel)), false);
    assert.equal((await rotate(90)).code, 200);
  });

  test('the register is per-file, so one clip deriving does not freeze the gallery', async () => {
    const mine = await givenAPhoto();
    const somebodyElse = path.join(UPLOADS_DIR, EVENT_ID, 'another-upload.mp4');
    let release!: () => void;
    const tracked = images.whileDeriving(somebodyElse, () => new Promise<void>((r) => { release = r; }));
    assert.equal((await rotate(90)).code, 200);
    assert.notEqual(photoRow!.filename, mine);
    release();
    await tracked;
  });
});

// ── DEFECT 1, WHERE IT ACTUALLY LIVED: THE UPLOAD INSERT ─────────────────────

// Walk up to the app dir, then hop to its sibling web/ — the same approach as
// turnstile-wiring.test.ts, which cannot use import.meta.dirname under this tsconfig either.
function findApp(): string {
  let d = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(d, 'src', 'server', 'index.ts'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  const app = path.join(process.cwd(), 'app');
  if (fs.existsSync(path.join(app, 'src', 'server', 'index.ts'))) return app;
  throw new Error('could not locate the app directory from ' + process.cwd());
}
const CAMERA = fs.readFileSync(
  path.join(path.dirname(findApp()), 'web', 'src', 'lib', 'components', 'Camera.svelte'), 'utf8');

/** Every field name the camera puts on an upload — the multipart form of the single-shot path and
 *  the JSON body of /complete, read off the client rather than remembered. */
function cameraFields(): { single: string[]; complete: string[] } {
  const oneShot = CAMERA.slice(CAMERA.indexOf('function uploadSingle'), CAMERA.indexOf('function uploadChunked'));
  assert.ok(oneShot.length > 200, 'uploadSingle has moved or been renamed in Camera.svelte');
  const single = [...oneShot.matchAll(/form\.append\('([A-Za-z]+)'/g)].map((m) => m[1]);

  const body = /fetch\('\/api\/photos\/complete'[\s\S]{0,400}?body: JSON\.stringify\(\{([^}]*)\}\)/.exec(CAMERA);
  assert.ok(body, 'the /complete call has moved or been reshaped in Camera.svelte');
  const complete = body[1].split(',').map((part) => part.split(':')[0].trim()).filter(Boolean);
  return { single, complete };
}

/** What the transfer needs, as opposed to what the PHOTO is. Nothing here describes the picture,
 *  so nothing here is expected in the row. */
const TRANSPORT = new Set(['photo', 'chunk', 'sessionToken', 'uploadId', 'index', 'total', 'ext']);

/** A value for every non-transport field the camera sends, and what the row must then hold. Each
 *  one is deliberately NOT the default the server would fall back to, so a field that is dropped
 *  on the way in cannot pass by coincidence. */
/** Inside the fixture event and a few minutes old — the case the grace window exists to admit. */
const PLAUSIBLE_SHUTTER = Date.now() - 5 * 60_000;

const SENT: Record<string, { sent: unknown; stored: unknown }> = {
  source:             { sent: 'upload',    stored: 'upload' },
  mediaType:          { sent: 'photo',     stored: 'photo' },
  challengeId:        { sent: 'wear-a-hat', stored: 'wear-a-hat' },
  captureOrientation: { sent: 'landscape', stored: 'landscape' },
  captureShape:       { sent: '1:1',       stored: '1:1' },
  captureRotation:    { sent: 90,          stored: 90 },
  // Listed ahead of the client sending it, on purpose. The loop below only checks fields it finds
  // in Camera.svelte, so this costs nothing today — and the day captureTurn is appended there, the
  // camera and the server are already agreed instead of this test failing on a field it has never
  // heard of. A different value from captureRotation so the two cannot be confused for each other.
  captureTurn:        { sent: -90,         stored: -90 },
  // A plausible shutter instant: inside the event window and comfortably in the past, so
  // capturedAtFor() honours it rather than falling back to the server clock. Anything implausible
  // is DESIGNED to come back as now(), which would make this assertion pass for the wrong reason.
  capturedAt:         { sent: PLAUSIBLE_SHUTTER, stored: PLAUSIBLE_SHUTTER },
};

const photoInsert = () => {
  const row = inserts.find((i) => i.table === 'photos');
  assert.ok(row, 'no photo row was inserted');
  return row.values;
};

/** POST /api/photos, with the file multer would have staged already on disk. */
async function uploadSingle(body: Record<string, unknown>): Promise<Reply> {
  const staged = path.join(INCOMING_DIR, `staged-${process.pid}-${n++}.jpg`);
  await writeJpeg(staged);
  return call('post', '/', {
    body: { sessionToken: SESSION_OWNER, ...body },
    file: { path: staged, size: fs.statSync(staged).size, originalname: 'media.jpg', mimetype: 'image/jpeg' },
  });
}

/** POST /api/photos/complete, with the one chunk it is to reassemble already staged. */
async function uploadChunked(body: Record<string, unknown>): Promise<Reply> {
  const uploadId = `upload${process.pid}${n++}`;
  const dir = path.join(INCOMING_DIR, `chunks-${uploadId}`);
  fs.mkdirSync(dir, { recursive: true });
  await writeJpeg(path.join(dir, '0'));
  return call('post', '/complete', {
    body: { sessionToken: SESSION_OWNER, uploadId, total: 1, ext: 'jpg', mediaType: 'photo', ...body },
  });
}

const everything = () => Object.fromEntries(Object.entries(SENT).map(([k, v]) => [k, v.sent]));

describe('the upload insert carries every field the camera sends', () => {
  // THE TEST THAT WOULD HAVE CAUGHT IT. `captureRotation` was appended by both upload paths and
  // read by neither, and nothing in the suite compared the two halves. Read off Camera.svelte so
  // the NEXT field somebody adds to the camera and forgets on the server fails here rather than in
  // a gallery six months later.
  for (const [pathName, drive] of [['POST /api/photos', uploadSingle], ['POST /api/photos/complete', uploadChunked]] as const) {
    test(`${pathName} — every field lands in the row`, async () => {
      const r = await drive(everything());
      assert.equal(r.code, 200, JSON.stringify(r.body));
      const values = photoInsert();
      const sent = pathName.endsWith('complete') ? cameraFields().complete : cameraFields().single;
      const expected = sent.filter((f) => !TRANSPORT.has(f));
      assert.ok(expected.length >= 5, 'the camera stopped sending fields this test knows about');
      for (const field of expected) {
        const want = SENT[field];
        assert.ok(want, `the camera now sends "${field}" and this test does not know what it should `
          + 'store. Add it to SENT — and check the server reads it, which is the bug this file exists for.');
        assert.equal(values[field], want.stored,
          `the camera sends ${field} on ${pathName} and the inserted row does not carry it`);
      }
    });
  }

  test('captureRotation specifically — the field that was being dropped', async () => {
    // Both halves, as the camera sends them for a turned still: it MEASURED 90 and it APPLIED 90.
    await uploadSingle({ captureOrientation: 'landscape', captureRotation: 90, captureTurn: 90 });
    const values = photoInsert();
    assert.equal(values.captureRotation, 90);
    assert.equal(values.captureTurn, 90);
    // And therefore the badge does not fire on a photo the shutter already put right, which is the
    // entire reason the column exists.
    assert.equal(photosRoutes.shotSideways(values as { captureTurn?: number | null; captureRotation?: number | null }), false,
      'a photo the camera straightened is still being marked "shot sideways"');
  });

  test('a turn nobody could have applied is stored as NULL, never as 0', async () => {
    // Same validator as the rotate route (readQuarter), because it is the same claim arriving over
    // the same wire from the same untrusted client. NULL and 0 both read as "no correction
    // applied" today, and only NULL still says "nobody told us" tomorrow.
    for (const raw of [0, 270, 45, 'ninety', '', null, {}]) {
      inserts = [];
      await uploadSingle({ captureOrientation: 'landscape', captureRotation: raw });
      assert.equal(photoInsert().captureRotation, null, `captureRotation: ${JSON.stringify(raw)}`);
    }
  });

  test('a photo that reports a turn and no correction is the one that badges', async () => {
    // The rotation lock case: the phone was turned, the page did not follow, and the camera could
    // not straighten what it had not drawn. Turn recorded, nothing applied against it.
    await uploadSingle({ captureOrientation: 'landscape', captureTurn: 90 });
    const values = photoInsert();
    assert.equal(values.captureRotation, null);
    assert.equal(values.captureTurn, 90);
    assert.equal(photosRoutes.shotSideways(values as { captureTurn?: number | null; captureRotation?: number | null }), true,
      'a sideways shot nobody has straightened must still badge');
  });

  test('a client too old to measure a turn badges nothing at all', async () => {
    // What every row in production looks like: capture_orientation says 'landscape' and the two
    // newer columns are empty. The badge is silent, deliberately — see shotSideways().
    await uploadSingle({ captureOrientation: 'landscape' });
    const values = photoInsert();
    assert.equal(values.captureTurn, null);
    assert.equal(photosRoutes.shotSideways(values as { captureTurn?: number | null; captureRotation?: number | null }), false,
      "capture_orientation is back in the badge's derivation, and with it the false positive that "
      + 'fired on every correctly-captured landscape shot');
  });
});

// ── NOTHING IS DELETED THAT WAS NOT REPLACED ─────────────────────────────────

describe('a rotation never deletes a file it did not replace', () => {
  test('a derived copy with no counterpart under the new name is left alone', async () => {
    // The rule the cleanup loop rests on, and the one whose absence turned a single failed sibling
    // into permanent data loss: the old names used to go whether or not anything had been written
    // in their place, and nothing in the product rebuilds a crop.
    //
    // Staged with a still, because the real case — a clip whose `_crop.mp4` fails to turn — needs
    // ffmpeg, which a unit run is not entitled to assume. The loop does not care what kind of file
    // it is holding: it pairs old name to new name and asks the disk.
    const rel = await givenAPhoto();
    const strayCrop = images.cropName(rel);
    fs.writeFileSync(disk(strayCrop), 'a derived copy that will have no replacement');

    const r = await rotate(90);
    assert.equal(r.code, 200, JSON.stringify(r.body));
    const now = photoRow!.filename;

    assert.ok(!there(rel), 'the original WAS replaced, so it should have gone');
    assert.ok(!there(images.cropName(now)), 'the premise: nothing wrote a crop under the new name');
    assert.ok(there(strayCrop), 'a copy was deleted with nothing written in its place — that is the '
      + "guest's chosen shape gone for good, and litter is the cheaper mistake of the two");
  });

  test('a clip that cannot be rotated at all leaves every file and the row exactly as they were', async () => {
    // rotateClipTo refuses anything it cannot verify afterwards (see images.ts), and the answer to
    // that must be "nothing happened" — not a half-moved photo.
    const rel = `${EVENT_ID}/clip-${process.pid}-${n++}.mp4`;
    fs.mkdirSync(path.dirname(disk(rel)), { recursive: true });
    fs.writeFileSync(disk(rel), 'not remotely an mp4');
    photoRow = {
      id: 'p-clip', eventId: EVENT_ID, participantId: OWNER, filename: rel, mediaType: 'video',
      width: 1920, height: 1080, captureOrientation: 'landscape', captureRotation: null,
      captureTurn: 90, captureShape: '4:5', takenAt: Date.now(), status: 'pending', challengeId: null,
    };

    const r = await rotate(90);
    assert.equal(r.code, 500);
    assert.deepEqual(r.body, { error: 'That clip could not be rotated' });
    assert.ok(there(rel), 'the clip was deleted by a rotation that never produced a replacement');
    assert.equal(updateSets.length, 0, 'the row was moved to a name that was never written');
  });
});

// ── DELETE, WHICH READS ONE NAME AND UNLINKS ANOTHER ─────────────────────────

describe('a delete unlinks the row it actually deleted', () => {
  test('a rotation committing mid-delete does not leave the rotated file behind', async () => {
    // DELETE read the filename at the top of the handler and unlinked by THAT name. A rotation
    // landing in between renames the file and moves the row, so the delete removed names that were
    // already gone and left the rotated original on the volume — invisible, and only collected
    // when the whole event is purged.
    const rel = await givenAPhoto({ takenAt: Date.now() });
    const rotated = `${EVENT_ID}/rotated-in-between.jpg`;
    await writeJpeg(disk(rotated));
    afterPhotoRead = () => { photoRow!.filename = rotated; };

    const r = await call('delete', '/:id', {
      params: { id: photoRow!.id },
      body: { sessionToken: SESSION_OWNER },
    });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal(deleted[0].filename, rotated);
    assert.ok(!there(rotated), 'the file the row actually pointed at is still on the volume');
    assert.ok(there(rel), 'the pre-rotation name is not this delete’s to guess at');
  });
});
