// POST /api/photos/chunk and POST /api/photos/complete, driven PAST THE END of an event.
//
// WHY A THIRD FILE ON ONE RULE. late-upload.test.ts pins lateUploadAllowed, capturedAtFor,
// captureSpanMs and gateUpload as pure functions, and it pins — by reading the source text — that
// both upload paths hand the gate a body. Every one of those can be green while the chunked route
// is wrong, because none of them IS the route. The single-shot POST / has been driven for a while
// (photo-rotate-route.test.ts for the insert, capture-turn.test.ts for the clip pipeline); the
// chunked path had never once been driven past a closed event.
//
// Which is the wrong path to have left uncovered, because it is the path the feature was written
// for. A long clip cannot go through POST / at all — Cloudflare caps bodies at ~100MB, which is
// why /chunk exists — so a ten-minute recording of the speeches is, by construction, a chunked
// upload. The headline case of the clip allowance was the one case with no end-to-end coverage,
// and it stayed that way through the change that introduced the allowance.
//
// WHAT IS REAL HERE. The handlers, the gate, the filesystem, the chunk staging, and the
// reassembly — a clip in this file really is cut into parts, really is posted one part at a time,
// and really is concatenated back into one file in the event folder. Only the database and the
// ffmpeg shell-outs are stood in for, the same approach and for the same reasons as
// capture-turn.test.ts: a unit run is not entitled to assume a Postgres or an ffmpeg (the dev VM
// this was written on has neither), and the two claims worth making — "the parts were reassembled
// and a row was inserted" and "the refusal reclaimed the disk" — are both claims a live Postgres
// would happily let pass for the wrong reason.
//
// THE FOUR THINGS THIS FILE IS FOR:
//
//   1. A CLIP BEGUN BEFORE THE CLOSE IS KEPT, however long it runs and however late its last part
//      lands. Under the old gate the ninety-second case passed by luck — CLOCK_SKEW_MS happens to
//      be five minutes and ninety seconds is less than five minutes — while the ten-minute case
//      came back 410 with the guest's video already fully uploaded and sitting in INCOMING_DIR.
//      A clock-skew pad was quietly doubling as a clip-duration allowance nobody had sized it for.
//   2. IT WORKS WITH NOTHING ON THE WIRE. An old client sends no duration at all, and an old
//      client is exactly who is still draining a pre-change queue at us. The fall back to the clip
//      ceiling is what carries that case, and it is the half most easily "tidied" into a zero.
//   3. THE GENEROSITY IS BOUNDED. A capture that genuinely began after the close is refused, and a
//      still gets none of the allowance whatsoever — there is no duration to give a photograph the
//      benefit of, and inventing one would let a post-close photograph into a closed event.
//   4. THE TWO CHUNK ENDPOINTS DO NOT DO THE SAME JOB. /chunk does not consult the event window at
//      all; /complete is the only door. That is asserted below rather than assumed, because "the
//      gate is on the other endpoint" is precisely the sort of belief that outlives the endpoint.
import { test, describe, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

// ── Everything here must be settled BEFORE anything under test is required ───

// paths.ts reads UPLOADS_DIR once, at import. A unit suite that writes into the real uploads
// volume is one that can delete somebody's photos.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdini-late-chunked-'));
process.env.UPLOADS_DIR = TMP;

// The clip ceiling is read out of the environment at import too, and it is the number every
// boundary in this file is arithmetic about: the gate widens its window by exactly this much when
// a client sends no duration. Pinned to the shipped defaults rather than inherited, so a
// deployment environment leaking into somebody's shell cannot silently move every case below to a
// different set of numbers and have them pass or fail for a reason unrelated to the gate.
process.env.VIDEO_HARD_MAX_SECONDS = '600';
process.env.VIDEO_GRACE_SECONDS = '0';
process.env.VIDEO_MAX_SECONDS = '0';

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

// ── A database that remembers what an upload inserted ────────────────────────

const tableName = (t: unknown): string =>
  (t as Record<symbol, string>)?.[Symbol.for('drizzle:Name')] ?? 'unknown';

/** Pull the bound values back out of a Drizzle condition — the same helper, for the same reason,
 *  as photo-rotate-route.test.ts and capture-turn.test.ts. Here it is what lets the stand-in tell
 *  a known session token from an unknown one, which POST /chunk's only real check turns on. */
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

const EVENT_ID = 'ev-that-has-closed';
const OWNER = 'guest-filming-the-speeches';
const SESSION = 'session-owner';

/** The event window, moved by each test. gateUpload reads the wall clock itself, so a case is
 *  expressed as "the close was this long ago" rather than against a fixed instant. */
let eventStartsAt: number | null = null;
let eventEndsAt = Date.now() + 60 * 60_000;

/** Close the event `ago` milliseconds before now, with a start far enough back that capturedAtFor
 *  honours any plausible stamp rather than falling back to the server clock for the wrong reason. */
function closedMsAgo(ago: number): void {
  eventStartsAt = Date.now() - 48 * 60 * 60_000;
  eventEndsAt = Date.now() - ago;
}

/** The participants⋈events row the upload path resolves from a session token.
 *
 *  videoSeconds is 600 because a hosted event with video switched off refuses clips at the gate
 *  for an entirely different reason, and every clip here has to reach the window check. At 600 the
 *  clip ceiling comes out at ten minutes whether or not this build has billing switched on — with
 *  billing on it is the entitlement, with billing off it is VIDEO_HARD_MAX_SECONDS — so nothing in
 *  this file depends on whether a STRIPE_SECRET_KEY happens to be in the environment. */
const participantRow = () => ({
  id: OWNER, photosTaken: 0, maxPhotos: 12, extraPhotos: 0,
  isLocked: false, startsAt: eventStartsAt, expiresAt: eventEndsAt,
  eventId: EVENT_ID, moderationEnabled: false, videoSeconds: 600,
  challengeSet: null, eventChallenges: null, aspectRatios: '["1:1","4:5","full"]',
});

let inserts: { table: string; values: Record<string, unknown> }[] = [];

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

function selectRows(table: string, c: any): unknown[] {
  if (table === 'participants') {
    // Keyed on the token rather than answering unconditionally, because "an unknown session is
    // turned away and its bytes dropped" is one of the claims made below about POST /chunk.
    return (c._where ?? []).includes(SESSION) ? [participantRow()] : [];
  }
  if (table === 'events') return [{ id: EVENT_ID, faceMatchingEnabled: false }];
  return [];
}

const fakeDb: any = {
  select() { return { from(t: unknown) { return chain((c) => selectRows(tableName(t), c)); } }; },
  selectDistinct() { return this.select(); },
  update(t: unknown) {
    // The atomic claim on the guest's roll. Always granted: the allowance is not this file's
    // subject, and a refusal here would turn every accepted case into a 403 for the wrong reason.
    return chain(() => (tableName(t) === 'photos' ? [] : [{ photosTaken: 1, extraPhotos: 0, maxPhotos: 12 }]));
  },
  insert(t: unknown) { return chain((c) => { inserts.push({ table: tableName(t), values: c._values }); return []; }); },
  delete() { return chain(() => []); },
  transaction(cb: (tx: unknown) => unknown) { return Promise.resolve().then(() => cb(fakeDb)); },
};

const dbPath = require.resolve('../db');
require(dbPath);                                     // builds a pool object; connects to nothing
require.cache[dbPath]!.exports = { db: fakeDb, schema: {}, pool: {} };

// ── ffmpeg, stood in for ─────────────────────────────────────────────────────
//
// A COPY of each module's exports, not a proxy and not a rewrite: the live functions are carried
// across by reference, so whileDeriving/isDeriving here are the very ones routes/photos.ts calls
// and the derivation register is shared. Only the handful that shell out are then overwritten.
// Same construction as capture-turn.test.ts — see the longer note there.
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

const { thumbName, playName, isDeriving } = realImages as any;

/** What ffprobe is to report about the reassembled file.
 *
 *  Deliberately NOT what decides anything here. The gate runs before a single part has been
 *  concatenated, so the only duration it can ever see is the one the CLIENT claimed on the wire;
 *  this is the figure finalizeUpload reads afterwards, and its only job in this file is to stay
 *  inside the ten-minute ceiling so a clip that got past the door is not then destroyed for length
 *  and turned into a 413 that looks like a gate failure. Set per case so each fixture is coherent
 *  with the clip it says it is. */
let probedDurationMs = 90_000;
slideshow.probeVideoMeta = async () => ({ width: 1920, height: 1080, durationMs: probedDurationMs });

/** Every stub yields to the event loop first. Not decoration: this work is all started unawaited,
 *  and a stub that settles inside the same microtask chain as the handler finishes before the
 *  guest is answered — which is the one thing none of it does in production. */
const later = () => new Promise((r) => setTimeout(r, 0));
const write = (abs: string, body: string) => {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

images.makeVideoPoster = async (file: string) => {
  await later();
  if (!fs.existsSync(file)) return false;
  write(thumbName(file), 'poster'); return true;
};
images.fixAudioLead = async () => { await later(); return false; };
images.makePlaybackProxy = async (file: string) => {
  await later();
  if (!fs.existsSync(file)) return false;
  write(playName(file), 'proxy'); return true;
};
// Neither is reachable by anything below — no case here sends a captureShape or a captureTurn —
// but a stub costs nothing and an accidental ffmpeg spawn in a unit run costs a mystery.
images.cropClipToShape = async () => { await later(); return false; };
images.rotateClipTo = async () => { await later(); return false; };
/* eslint-enable @typescript-eslint/no-explicit-any */

const photosRoutes = require('../routes/photos') as typeof import('../routes/photos');
const { INCOMING_DIR } = require('../paths') as typeof import('../paths');

// ── Driving the handlers ─────────────────────────────────────────────────────

interface Reply { code: number; body: any }          // eslint-disable-line @typescript-eslint/no-explicit-any

/** The LAST handler on a route, so multer on /chunk is stepped over rather than run — there is no
 *  multipart body here, only the part it would have staged. */
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
const nextUploadId = () => `clip-${process.pid}-${n++}`;

/** Where /complete will look for the parts. A second copy of the route's own naming, which is a
 *  coupling worth having: the assertions that matter most below are about what is left on the
 *  volume after a refusal, and a test that cannot name the directory cannot make them. */
const partsDir = (uploadId: string) => path.join(INCOMING_DIR, `chunks-${uploadId}`);

/** POST /api/photos/chunk, with the part multer would already have written to INCOMING_DIR.
 *
 *  The staged path is handed back as well as the reply: "the part we refused was dropped, not left
 *  in the incoming directory for ever" is only checkable by something that knows where it was. */
async function postChunk(fields: Record<string, unknown>,
                         bytes: string | Buffer = 'PART'): Promise<Reply & { staged: string }> {
  fs.mkdirSync(INCOMING_DIR, { recursive: true });
  const staged = path.join(INCOMING_DIR, `part-${process.pid}-${n++}`);
  fs.writeFileSync(staged, bytes);
  // Multipart, so every field arrives as a STRING — index '0' and total '3', never 0 and 3. The
  // handler parseInt()s them and that is worth exercising as the wire really shapes it.
  const rec = await call('post', '/chunk', {
    body: fields,
    file: { path: staged, size: fs.statSync(staged).size, originalname: 'chunk', mimetype: 'application/octet-stream' },
  });
  return { ...rec, staged };
}

/** POST /api/photos/complete. A JSON body, so `total` is a real number here. */
const postComplete = (body: Record<string, unknown>) =>
  call('post', '/complete', { body: { sessionToken: SESSION, ...body } });

/** Three parts with distinguishable bytes, so "the clip was reassembled, in order" is a claim the
 *  disk can answer rather than something inferred from a 200.
 *
 *  THE FIRST PART OPENS WITH A REAL ISO-BMFF HEADER, and that is not decoration.
 *
 *  The extra reach past an event's close that a clip gets is now settled by the staged bytes, not
 *  by `mediaType` or `ext` — both of those arrive in the request body, so a still could be posted
 *  as either and buy a clip's allowance. Once the server started looking, these fixtures were
 *  caught out: they declared `mediaType: 'video'` and staged the ASCII string 'a-clip-in-three-',
 *  so the server correctly answered "that is not a clip" and four accept-case tests went red.
 *
 *  The tests were wrong, not the server. A test that claims to upload a clip has to upload
 *  something that is one, or it is asserting about a code path the product will never take. The
 *  0x18-byte 'ftyp' box below is the smallest honest way to be a clip: four bytes of box length,
 *  the 'ftyp' type at offset 4 that every mp4/m4v/mov/3gp begins with, and a brand. */
const FTYP = '\x00\x00\x00\x18ftypisom';
const PARTS = [FTYP + 'a-clip-in-three-', 'parts-reassembled-', 'in-the-right-order'];

interface Chunked extends Reply { uploadId: string; dir: string }

/** The whole chunked journey for one clip: every part through POST /chunk, then POST /complete. */
async function uploadClipInParts(body: Record<string, unknown> = {},
                                 opts: { send?: number[]; total?: number } = {}): Promise<Chunked> {
  const uploadId = nextUploadId();
  const total = opts.total ?? PARTS.length;
  for (const i of opts.send ?? PARTS.map((_, k) => k)) {
    const part = await postChunk({ sessionToken: SESSION, uploadId, index: String(i), total: String(total) }, PARTS[i]);
    assert.equal(part.code, 200, `part ${i} was not staged: ${JSON.stringify(part.body)}`);
  }
  const rec = await postComplete({ uploadId, total, ext: 'mp4', mediaType: 'video', ...body });
  return { ...rec, uploadId, dir: partsDir(uploadId) };
}

/** The same, for a still: one part, and a real JPEG, because the photo path runs sharp for real
 *  the moment it gets past the gate. */
async function uploadPhotoInParts(body: Record<string, unknown> = {}): Promise<Chunked> {
  const uploadId = nextUploadId();
  const jpeg = await sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg().toBuffer();
  const part = await postChunk({ sessionToken: SESSION, uploadId, index: '0', total: '1' }, jpeg);
  assert.equal(part.code, 200, JSON.stringify(part.body));
  const rec = await postComplete({ uploadId, total: 1, ext: 'jpg', mediaType: 'photo', ...body });
  return { ...rec, uploadId, dir: partsDir(uploadId) };
}

describe('a still cannot talk its way into a clip\'s allowance', () => {
  // BOTH fields are the client's word, which is what made the first two attempts at this useless.
  // Blocking `mediaType: 'video'` moved the forgery to `ext: 'mp4'`; an audit then caught that the
  // supposedly "strict" flag was reading another field out of the very same request body. Only the
  // staged BYTES are evidence, so only the staged bytes decide the allowance.
  //
  // THE ARITHMETIC, because getting it wrong makes these pass for the wrong reason — which is
  // exactly what the first draft did. The event closed eight minutes ago and the capture is
  // stamped ONE minute ago, i.e. seven minutes AFTER the close:
  //
  //   a still gets span 0        -> allowed only if capturedAt <= close + 5 min skew
  //                              -> close + 7 min is outside it            REFUSED
  //   a clip claims span 10 min  -> allowed if capturedAt - 10 min <= close + 5 min
  //                              -> close - 3 min is comfortably inside it ALLOWED
  //
  // Both halves are needed for the pair to mean anything. The first draft stamped the capture AT
  // the close, where a still is legitimately allowed and the refusal never fires — the test failed
  // and briefly looked like the fix was broken. Stamp it too late instead (say thirty minutes) and
  // the refusals hold because they are outside the clip ceiling too, so they pass with the fix
  // removed. Only this band distinguishes the two.
  const CLOSED_AGO = 8 * 60_000;
  const CAPTURED_AGO = 60_000;

  /** One staged part of real JPEG bytes, whatever the body then claims it is. */
  async function stageAStill(): Promise<string> {
    const uploadId = nextUploadId();
    const jpeg = await sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 10, g: 90, b: 200 } } })
      .jpeg().toBuffer();
    const part = await postChunk({ sessionToken: SESSION, uploadId, index: '0', total: '1' }, jpeg);
    assert.equal(part.code, 200, JSON.stringify(part.body));
    return uploadId;
  }

  test('declared a clip by mediaType, but the bytes are a photograph', async () => {
    closedMsAgo(CLOSED_AGO);
    const uploadId = await stageAStill();
    const done = await postComplete({ uploadId, total: 1, ext: 'jpg', mediaType: 'video',
                                      durationSecs: 600, capturedAt: Date.now() - CAPTURED_AGO });
    assert.equal(done.code, 410, `a still bought a clip's reach: ${JSON.stringify(done.body)}`);
  });

  test('declared a clip by ext as well — the precise gap the audit found', async () => {
    // After mediaType was blocked, `ext` was believed instead, and it arrives in the same body.
    // Sending both is what a forger would actually do.
    closedMsAgo(CLOSED_AGO);
    const uploadId = await stageAStill();
    const done = await postComplete({ uploadId, total: 1, ext: 'mp4', mediaType: 'video',
                                      durationSecs: 600, capturedAt: Date.now() - CAPTURED_AGO });
    assert.equal(done.code, 410, `ext:'mp4' on a JPEG bought a clip's reach: ${JSON.stringify(done.body)}`);
  });

  test('and a REAL clip in the very same window is still honoured', async () => {
    // The other half, and it is not optional: without it both tests above would pass with the
    // allowance deleted outright, which would throw away the long clips the mechanism exists for.
    closedMsAgo(CLOSED_AGO);
    const rec = await uploadClipInParts({ durationSecs: 600, capturedAt: Date.now() - CAPTURED_AGO });
    assert.equal(rec.code, 200, `a genuine clip was refused: ${JSON.stringify(rec.body)}`);
  });
});

const photoInsert = () => {
  const row = inserts.find((i) => i.table === 'photos');
  assert.ok(row, 'no photo row was inserted');
  return row.values;
};
const nothingWasInserted = () =>
  assert.equal(inserts.filter((i) => i.table === 'photos').length, 0,
    'a refused upload still wrote a row');

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

beforeEach(() => {
  inserts = [];
  probedDurationMs = 90 * SEC;
  eventStartsAt = null;
  eventEndsAt = Date.now() + HOUR;
  // The gallery listing keeps a module-level readdir cache. Nothing in this file lists a gallery,
  // but this suite writes real files into a real event folder, and a stale entry surviving into
  // another test is the shape of flake that cost an afternoon once already.
  photosRoutes.__resetListingCache();
});

/** Wait out everything the upload kicked off after answering the guest.
 *
 *  finalizeUpload starts the audio correction and the playback proxy UNAWAITED — a guest at a
 *  party does not wait on ffmpeg — so without this a test ends with work still running, and the
 *  next one begins with files appearing underneath it. The register is registered with
 *  synchronously inside finalizeUpload, so it cannot be observed empty in the gap. */
afterEach(async () => {
  const rel = inserts.find((i) => i.table === 'photos')?.values.filename;
  if (typeof rel !== 'string') return;
  const abs = path.join(TMP, rel);
  for (let i = 0; i < 2_000 && isDeriving(abs); i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(isDeriving(abs), false, 'the derivation register never let go of the name');
});

// ── THE FIXTURE EVERY BOUNDARY BELOW IS MEASURED AGAINST ─────────────────────

describe('the numbers this file is arithmetic about', () => {
  test('the clip ceiling for this event is ten minutes', () => {
    // Stated as a literal on purpose. Every boundary below is written out in minutes and seconds
    // rather than derived from this call, because an assertion with the constant under test on
    // both sides holds for any value the constant takes — a trap this repo has already been caught
    // by once. If the ceiling moves, this line is what says so, and it says so loudly.
    assert.equal(photosRoutes.maxAcceptedClipMs(600), 600_000,
      'the ten-minute ceiling has moved; every boundary in this file needs re-reading');
  });
});

// ── 1. A CLIP BEGUN BEFORE THE CLOSE, FINISHING LONG AFTER IT ────────────────

describe('the chunked route keeps a clip that was begun before the door shut', () => {
  test('ninety seconds, begun a second before the close, last part landing a day and a minute later', async () => {
    // A guest presses record with one second to go and films the speeches. The clip is fine; the
    // NETWORK is not, and its last part lands a day and a minute after the event closed.
    //
    // The twenty-four hours used to be measured from the END OF THE EVENT, which silently docked a
    // long clip's network grace by the clip's own length — exactly backwards, since the long clip
    // is the one that needs the time. Measured from the end of the CAPTURE, a ninety-second clip
    // has until a day and ninety seconds, and this arrives inside that by twenty-nine seconds.
    closedMsAgo(24 * HOUR + MIN);
    const begun = eventEndsAt - SEC;

    const r = await uploadClipInParts({ capturedAt: begun, durationSecs: 90 });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal(r.body.success, true);

    const row = photoInsert();
    assert.equal(row.mediaType, 'video');
    assert.equal(row.capturedAt, begun, 'the shutter instant the guest claimed was not the one stored');
    const stored = path.join(TMP, String(row.filename));
    assert.ok(fs.existsSync(stored), 'the row points at a file that is not on the volume');
    assert.equal(fs.readFileSync(stored, 'utf8'), PARTS.join(''),
      'the parts were not reassembled in order — a 200 on its own does not prove the clip survived');
    assert.ok(!fs.existsSync(r.dir), 'the staged parts were left behind after a successful complete');
  });

  test('the LONGEST clip this server keeps, stop-stamped by an old client, forty minutes late', async () => {
    // THE CASE THAT WAS REFUSED OUTRIGHT, and the reason the allowance exists.
    //
    // The phone stamped the queue item when recording STOPPED, which is what every client before
    // the change did and what a pre-change queue keeps doing for as long as that tab lives. So a
    // ten-minute clip begun one second before the close arrives claiming a capture instant 9m59s
    // PAST the end — nearly ten minutes past a five-minute clock-skew pad. The guest's video was
    // fully uploaded and then thrown away with a 410.
    closedMsAgo(40 * MIN);
    const stopStamped = eventEndsAt - SEC + 10 * MIN;
    probedDurationMs = 600 * SEC;

    const r = await uploadClipInParts({ capturedAt: stopStamped, durationMs: 600_000 });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    const row = photoInsert();
    assert.equal(row.mediaType, 'video');
    assert.ok(fs.existsSync(path.join(TMP, String(row.filename))));
  });

  test('...and again with NO duration anywhere on the wire, which is the old client exactly', async () => {
    // The same upload from a client too old to report how long it recorded for — and it is the
    // same clients that stop-stamp, so this combination is the realistic one rather than the
    // contrived one. With no claim the server assumes the longest clip it would keep at all, which
    // is what carries this case.
    //
    // Falling back to zero would be the tidy-looking choice and would re-break precisely this
    // guest: zero is the right answer for a still, and applying it to a clip we merely failed to
    // measure assumes the stamp is a start stamp — assuming away the entire problem.
    closedMsAgo(40 * MIN);
    const stopStamped = eventEndsAt - SEC + 10 * MIN;
    probedDurationMs = 600 * SEC;

    const body: Record<string, unknown> = { capturedAt: stopStamped };
    assert.ok(!('durationSecs' in body) && !('durationMs' in body),
      'the premise of this test is that nothing on the wire says how long the clip was');

    const r = await uploadClipInParts(body);
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal(photoInsert().mediaType, 'video');
  });

  test('a clip with no capturedAt at all, arriving after the close', async () => {
    // No stamp falls back to the server's own clock, exactly as it always did. For a clip that
    // fallback carries an arithmetic fact with it: the bytes are in our hands, so the camera must
    // have been running for the length of the clip before they could be, and the recording
    // therefore began at least that long ago. Eight minutes past the close is comfortably outside
    // the five-minute clock-skew pad and comfortably inside ten minutes of recording, so this one
    // is carried by the clip allowance and by nothing else.
    closedMsAgo(8 * MIN);

    const r = await uploadClipInParts({});
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal(photoInsert().mediaType, 'video');
  });
});

// ── 2. WHERE THE GENEROSITY STOPS ────────────────────────────────────────────

describe('the chunked route still closes the event', () => {
  test('a capture that genuinely began an hour after everyone went home is refused', async () => {
    // GUARD, and the one that keeps the whole arrangement honest. The widening is bounded by the
    // clip: an hour past the end is not "the speeches ran long", it is a different evening, and a
    // ten-minute claim cannot stretch to cover it.
    closedMsAgo(90 * MIN);
    const begunAfter = eventEndsAt + HOUR;
    probedDurationMs = 600 * SEC;

    const r = await uploadClipInParts({ capturedAt: begunAfter, durationMs: 600_000 });
    assert.equal(r.code, 410);
    assert.deepEqual(r.body, { error: 'Event has ended' });
    nothingWasInserted();
    assert.ok(!fs.existsSync(r.dir),
      'a refused upload left its parts in the incoming directory — nothing collects those, and a '
      + 'refused multi-gigabyte clip is a multi-gigabyte leak');
  });

  test('a forged duration cannot hold the door open for a capture begun a day late', async () => {
    // The client is the only witness to the clip length, so it is a forgeable field. A century of
    // it is clamped to the ceiling, and the ceiling is ten minutes, so a capture begun a day after
    // the close is still a day after the close.
    closedMsAgo(25 * HOUR);
    const r = await uploadClipInParts({ capturedAt: eventEndsAt + 24 * HOUR, durationMs: 100 * 365 * 24 * HOUR });
    assert.equal(r.code, 410);
    assert.deepEqual(r.body, { error: 'Event has ended' });
    nothingWasInserted();
  });
});

// ── 3. A STILL GETS NONE OF IT ───────────────────────────────────────────────

describe('a photo is given no clip allowance, because a photograph has no duration', () => {
  test('a photo with no capturedAt, uploaded eight minutes after the close, is refused', async () => {
    // Begin and stop are the same instant for a photograph. With no stamp the gate falls back to
    // `now`, `now` is past the close by more than the clock-skew pad, and there is nothing to
    // widen — so this is a 410 and must stay one. The still path had to come out of the clip
    // change bit-for-bit as it went in, and this is the chunked half of saying so.
    //
    // EIGHT MINUTES, CHOSEN RATHER THAN ROUND. It has to sit outside the five-minute skew pad (or
    // the refusal proves nothing about the allowance) and inside the ten-minute clip ceiling (or
    // the refusal would hold even if a still WERE handed a clip's worth of benefit, and the guard
    // would be decorative). Between five and ten is the only window in which this test can fail
    // for the reason it is written for. The first draft used twenty minutes and was exactly that
    // decorative — it stayed green with the still path wired to the clip allowance.
    closedMsAgo(8 * MIN);

    const r = await uploadPhotoInParts({});
    assert.equal(r.code, 410);
    assert.deepEqual(r.body, { error: 'Event has ended' });
    nothingWasInserted();
    assert.ok(!fs.existsSync(r.dir), 'the refused part was left staged');
  });

  test('and refused even when the client bolts a ten-minute duration onto it', async () => {
    // The obvious way to buy the allowance without a clip, and it buys nothing: the span is keyed
    // off the media type, not off the presence of the field. Same eight minutes, for the same
    // reason as above — inside the ceiling, outside the skew.
    closedMsAgo(8 * MIN);

    const r = await uploadPhotoInParts({ durationSecs: 600, durationMs: 600_000 });
    assert.equal(r.code, 410);
    assert.deepEqual(r.body, { error: 'Event has ended' });
    nothingWasInserted();
  });

  test('THE CONTROL: a photo TAKEN inside the window is still accepted after it', async () => {
    // Without this the two refusals above would also pass on a chunked route that had stopped
    // working altogether. This is the original defect — six photographs from a hen do, refused at
    // 14:18 for an event that ended at 14:00, by a single Android phone draining a queue — going
    // through the chunked door.
    closedMsAgo(18 * MIN);
    const shutter = eventEndsAt - 25 * MIN;

    const r = await uploadPhotoInParts({ capturedAt: shutter });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    const row = photoInsert();
    assert.equal(row.mediaType, 'photo');
    assert.equal(row.capturedAt, shutter);
    assert.ok(fs.existsSync(path.join(TMP, String(row.filename))));
  });
});

// ── 4. THE TWO ENDPOINTS ARE NOT THE SAME DOOR ───────────────────────────────

describe('POST /chunk does not gate on the event window, and /complete is why it need not', () => {
  test('a part is staged without a word about the window, even a day and two hours past the close', async () => {
    // THE REAL BEHAVIOUR, asserted rather than assumed. /chunk checks the shape of the request and
    // that the session exists, and nothing else: no window, no roll, no entitlement. Every one of
    // those questions is asked once, by /complete, about the upload as a whole.
    //
    // That division is deliberate and it is the right one. A part is not an upload — refusing part
    // forty of a hundred tells the client nothing it can act on, while the same refusal at
    // /complete is a single clear answer about a single thing. It does mean /complete is the only
    // thing standing between a closed event and a stored clip, which is what the rest of this file
    // is about, and it means a determined client can stage bytes into a closed event's incoming
    // directory — bounded by MAX_CHUNKS and the part size cap, and reclaimed by /complete's own
    // wipe when it refuses.
    closedMsAgo(24 * HOUR + 2 * HOUR);
    const uploadId = nextUploadId();

    const part = await postChunk({ sessionToken: SESSION, uploadId, index: '0', total: '1' });
    assert.equal(part.code, 200, JSON.stringify(part.body));
    assert.deepEqual(part.body, { ok: true, index: 0 });
    assert.ok(fs.existsSync(path.join(partsDir(uploadId), '0')), 'the part was not staged');

    // And the other half of the same claim: the upload is answered at /complete, where the window
    // is finally consulted — a day and two hours is past the grace whatever the capture was.
    const done = await postComplete({ uploadId, total: 1, ext: 'mp4', mediaType: 'video' });
    assert.equal(done.code, 410);
    assert.deepEqual(done.body, { error: 'Event has ended' });
    nothingWasInserted();
    assert.ok(!fs.existsSync(partsDir(uploadId)), 'the refusal did not reclaim the staged part');
  });

  test('but it does turn away a session it has never heard of, and drops the bytes it was handed', async () => {
    // "Does not gate on the window" must not be read as "does not check anything". An unknown
    // session is refused, and the part multer has already written to disk is unlinked rather than
    // left in the incoming directory, which nothing sweeps.
    const uploadId = nextUploadId();
    const part = await postChunk({ sessionToken: 'a-token-nobody-issued', uploadId, index: '0', total: '1' });
    assert.equal(part.code, 403);
    assert.deepEqual(part.body, { error: 'Invalid session' });
    assert.ok(!fs.existsSync(part.staged), 'the refused part was left in the incoming directory');
    assert.ok(!fs.existsSync(partsDir(uploadId)), 'a refused part still created its upload directory');
  });
});

// ── 5. A CLIP THAT IS ONLY HALF HERE ─────────────────────────────────────────

describe('a partially-uploaded clip', () => {
  test('is told exactly which part is missing, and keeps the ones it has', async () => {
    // The resumable half of the design. A 409 naming the gaps is an instruction to resend those
    // parts; wiping on it would mean an hour of uploading over a party connection thrown away
    // because one part timed out, and the client would have no way to know it had happened.
    const r = await uploadClipInParts({}, { send: [0, 2], total: 3 });
    assert.equal(r.code, 409);
    assert.deepEqual(r.body, { error: 'Missing chunks', missing: [1] });
    nothingWasInserted();
    assert.ok(fs.existsSync(path.join(r.dir, '0')), 'a part that HAD arrived was discarded');
    assert.ok(fs.existsSync(path.join(r.dir, '2')), 'a part that HAD arrived was discarded');
  });

  test('a late-but-allowed clip is told to resend rather than refused — the gate runs first', async () => {
    // The ORDER inside /complete, which is worth pinning because the two answers are not
    // interchangeable. The window is checked before the parts are counted, so a clip whose capture
    // began inside the event and whose last part has not arrived yet gets a 409 it can act on and
    // keeps its bytes. Reverse the order and this becomes a 409 too — but move the gate's wipe
    // ahead of the count and the guest loses everything they had already sent.
    closedMsAgo(30 * MIN);
    const r = await uploadClipInParts({ capturedAt: eventEndsAt - SEC, durationSecs: 90 },
                                      { send: [0, 1], total: 3 });
    assert.equal(r.code, 409);
    assert.deepEqual(r.body, { error: 'Missing chunks', missing: [2] });
    assert.ok(fs.existsSync(path.join(r.dir, '0')));
    assert.ok(fs.existsSync(path.join(r.dir, '1')));
  });

  test('a partial whose capture began after the close is refused, and its parts reclaimed', async () => {
    // The other side of that order: there is no point telling a client to resend into an event
    // that will never accept the result, and the parts it has already sent are dead weight.
    closedMsAgo(90 * MIN);
    const r = await uploadClipInParts({ capturedAt: eventEndsAt + HOUR, durationMs: 600_000 },
                                      { send: [0], total: 3 });
    assert.equal(r.code, 410);
    assert.deepEqual(r.body, { error: 'Event has ended' });
    nothingWasInserted();
    assert.ok(!fs.existsSync(r.dir), 'the refused upload kept its parts');
  });
});

// ── 6. THE TWO DOORS MUST AGREE ──────────────────────────────────────────────

describe('a clip gets the same answer whichever door it came through', () => {
  /** POST /api/photos with the clip multer would already have staged. */
  async function uploadSingleClip(body: Record<string, unknown>): Promise<Reply> {
    fs.mkdirSync(INCOMING_DIR, { recursive: true });
    const staged = path.join(INCOMING_DIR, `staged-${process.pid}-${n++}.mp4`);
    fs.writeFileSync(staged, PARTS.join(''));
    return call('post', '/', {
      body: { sessionToken: SESSION, ...body },
      file: { path: staged, size: fs.statSync(staged).size, originalname: 'clip.mp4', mimetype: 'video/mp4' },
    });
  }

  const doors: [string, (b: Record<string, unknown>) => Promise<Reply>][] = [
    ['POST /api/photos', uploadSingleClip],
    ['POST /api/photos/complete', (b) => uploadClipInParts(b)],
  ];

  for (const [name, drive] of doors) {
    test(`${name} — the maximum clip, stop-stamped, begun a second before the close: accepted`, async () => {
      // The one property the gate must never lose, and the reason gateUpload is handed the whole
      // body rather than a pre-read field at each call site: a field read at one door and
      // forgotten at the other is how "the same answer either way" dies quietly. The source-shape
      // test in late-upload.test.ts proves both call sites pass a body; this proves both reach the
      // same verdict when they do.
      closedMsAgo(40 * MIN);
      probedDurationMs = 600 * SEC;
      const r = await drive({ capturedAt: eventEndsAt - SEC + 10 * MIN, durationMs: 600_000 });
      assert.equal(r.code, 200, JSON.stringify(r.body));
      assert.equal(photoInsert().mediaType, 'video');
    });

    test(`${name} — a capture begun an hour after the close: refused`, async () => {
      closedMsAgo(90 * MIN);
      probedDurationMs = 600 * SEC;
      const r = await drive({ capturedAt: eventEndsAt + HOUR, durationMs: 600_000 });
      assert.equal(r.code, 410);
      assert.deepEqual(r.body, { error: 'Event has ended' });
      nothingWasInserted();
    });
  }
});
