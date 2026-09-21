import { clampCaption, CAPTION_MAX, CAPTION_MAX_RAW } from '../../../../shared/caption';
import { clampComment, COMMENT_MAX_RAW } from '../../../../shared/comment';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { ZipArchive } from 'archiver';
import { v4 as uuidv4 } from 'uuid';
import { and, asc, count, desc, eq, gt, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { readSets, isOfferedChallenge } from '../challenges';
import { hasShotsLeft, photosRemaining as remainingFor } from '../allowance';
import { matchNewPhoto } from './faces';
import { missionsFor } from './participants';
import { events, participants, photos, photoHearts, photoComments, commentHearts, shareVisitors } from '../schema';
import { stripImageMetadata, makeThumbnail, makeVideoPoster, makePlaybackProxy, fixAudioLead, thumbName, playName,
         cropClipToShape, cropName, dlName, shapeRatio, derivedNames, normalizeTurn, rotateImageTo,
         rotateClipTo, whileDeriving, isDeriving } from '../images';
import { probeVideoMeta } from '../slideshow';
import { isRevealed } from '../lib';
import { scheduledRevealAt, galleryCacheSeconds, galleryCacheControl } from '../../../../shared/reveal';
import { eventByIdentifier } from './events';
import { recordAdminAction } from '../admin-actions';
import { billingEnabled } from '../billing';

const router = Router();

import { UPLOADS_DIR, INCOMING_DIR, eventDir, eventRelPath, uploadDiskPath } from '../paths';
const MAX_PHOTO_MB   = parseInt(process.env.MAX_FILE_SIZE_MB || '64'); // headroom for an 8K still at max quality (q100/4:4:4)
const MAX_VIDEO_MB   = parseInt(process.env.MAX_VIDEO_SIZE_MB || '8192'); // plans for 90s 8K clips (multi-GB)
const VIDEO_MAX_SECS = parseInt(process.env.VIDEO_MAX_SECONDS || '0');
// Video LENGTH policy. The event's purchased seconds are a pricing ladder (10s/30s/60s/90s), not a
// technical limit, so enforcing them to the second punishes the people who actually paid: a phone
// clip reading 11.4s against a 10s plan is a container-rounding artefact, not abuse. Worse, a guest
// filming the speeches on their own camera has no way to trim it at 1am.
//
// So an event that HAS bought video accepts over-length clips, and we record how far over. Buying
// video at all is still required — gateUpload refuses videoSeconds === 0, unchanged, so this is not
// a route around the fee.
//   VIDEO_GRACE_SECONDS    > 0 caps how far past the purchased limit we accept (0 = no cap, the
//                          default, i.e. deliberately open while we gather data on how often it happens)
//   VIDEO_HARD_MAX_SECONDS absolute ceiling — a storage/abuse guard, never a pricing gate
// A guest may take back a shot they have just fluffed — a thumb over the lens, a lid-shut blink —
// and get the frame back on their roll. Deliberately SHORT: "that was my thumb" is known within a
// couple of seconds, whereas a long window turns a 12-shot roll into unlimited retries and the
// limited roll stops meaning anything. After it closes the frame is permanent.
// 30s, not 60. The judgement a guest is making — blurry, eyes shut, wrong moment — is made within a
// second or two of the photo appearing; the rest of the minute is a button nobody presses. And the
// window is not free: on an instant-reveal event the shot is in everyone's gallery the moment it is
// taken, so a long window is a longer stretch in which somebody else sees a photo, maybe hearts it,
// and then watches it vanish. Still env-tunable — PHOTO_DELETE_WINDOW_SECONDS — so an operator can
// take it back without a deploy.
export const DELETE_WINDOW_SECONDS = parseInt(process.env.PHOTO_DELETE_WINDOW_SECONDS || '30');
const DELETE_WINDOW_MS = DELETE_WINDOW_SECONDS * 1000;
// The UI arms a delete on the first tap and commits on the second. Someone who taps just inside the window and
// confirms a few seconds later decided inside the window, so the server tolerates a short grace
// rather than refusing a choice that was made in time. Small enough that it cannot turn a limited
// roll into unlimited retries.
const DELETE_CONFIRM_GRACE_MS = parseInt(process.env.PHOTO_DELETE_CONFIRM_GRACE_SECONDS || '15') * 1000;
const VIDEO_GRACE_SECS    = parseInt(process.env.VIDEO_GRACE_SECONDS || '0');
const VIDEO_HARD_MAX_SECS = parseInt(process.env.VIDEO_HARD_MAX_SECONDS || '600');

const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|3gp|mkv)$/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|heic|heif|bmp)$/i;

// Robust video detection: some mobile browsers (esp. iOS) hand us a recorded clip with an
// empty/octet-stream MIME, so fall back to the filename extension the client set.
function isVideoUpload(file: Express.Multer.File): boolean {
  return file.mimetype.startsWith('video/') || VIDEO_EXT_RE.test(file.originalname || '');
}

const storage = multer.diskStorage({
  // Stage the upload first — the event id isn't known until we resolve the session in the handler,
  // so we move the file into UPLOADS_DIR/<eventId>/ once we know it (same-filesystem atomic rename).
  destination(req, file, cb) {
    fs.mkdirSync(INCOMING_DIR, { recursive: true });
    cb(null, INCOMING_DIR);
  },
  filename(req, file, cb) {
    const ext = isVideoUpload(file)
      ? (/mp4|mov|m4v/i.test(file.mimetype + ' ' + (file.originalname || '')) ? 'mp4' : 'webm')
      : 'jpg';
    cb(null, `${uuidv4()}.${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: Math.max(MAX_PHOTO_MB, MAX_VIDEO_MB) * 1024 * 1024 },
  fileFilter(req, file, cb) {
    // Accept by MIME or by a known media extension (covers missing/odd MIME from mobile).
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')
        || VIDEO_EXT_RE.test(file.originalname || '') || IMAGE_EXT_RE.test(file.originalname || ''))
      return cb(null, true);
    const e = new Error('Only photos and videos can be uploaded') as Error & { status?: number };
    e.status = 400;
    cb(e);
  },
});

// A photoRow input is a joined photos+participants row. Type it loosely to the fields read
// below; not every caller selects every column (e.g. gallery rows omit rating/status).
type PhotoRowInput = {
  id: string;
  filename: string;
  takenAt: number;
  participantName: string;
  participantId: string;
  challengeId: string | null;
  caption?: string | null;
  isHighlighted: boolean;
  rating?: number | null;
  mediaType?: string | null;
  status?: string | null;
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  // Optional because the older, narrower selects never asked for it. Absent reads the same as
  // 'unknown', which is the correct answer for a row nobody recorded it on.
  captureOrientation?: string | null;
  // The correction somebody has already applied, in degrees clockwise. Optional for the same reason
  // the line above is: the narrower selects never asked for it, and absent reads as "untouched",
  // which is the right answer for a row nobody has rotated.
  captureRotation?: number | null;
  // What was MEASURED at the shutter, as against what has since been APPLIED. Optional like the two
  // above, and the badge below is derived from it — so a select that feeds photoRow and forgets it
  // does not break, it silently stops badging. Every such select therefore asks for it.
  captureTurn?: number | null;
  captureShape?: string | null;
};

// Mission id → the wording the host wrote, across EVERY set on the event. Built once per request
// so a row costs a lookup rather than a JSON parse, and taken from the event's whole list rather
// than one guest's card: the host reviewing the album must see a caption on every photo, not only
// on the shots from whichever card they happen to be holding.
// First set wins a shared id: two cards may reuse an id with different wording, and a stable choice
// beats a caption that depends on set order.
export function challengeCaptions(stored: string | null | undefined): Map<string, string> {
  const byId = new Map<string, string>();
  for (const set of readSets(stored))
    for (const c of set.items) if (!byId.has(c.id)) byId.set(c.id, c.text);
  return byId;
}

// `onDisk` is asked up to three times for EVERY row a gallery returns — the `_dl`, `_play` and
// `_crop` siblings — and it was asking the filesystem each time, synchronously, on the event loop.
// UPLOADS_DIR is normally a remote volume (an 18TB NFS share here), and the cost is paid by every
// request the process is serving, not just this one.
//
// All three siblings live in the same event folder as the original, so ONE readdir answers every
// question about every row: 500 filesystem questions for a 200-clip gallery become 1. Measured on
// this box against the real share with the client cache dropped between runs, median of 5: 73.0ms
// of blocked loop → 12.2ms at 200 clips, 230.8ms → 30.6ms at 500. The tail is the better argument —
// worst of five went 376ms → 17ms, and 1196ms → 101ms. (The NFS round trip here is 0.2ms, not the
// 10ms this was first blamed on; it is the SEQUENCE of a thousand blocking calls that costs, so a
// slower link or a busier server only widens the gap.) Kept for a couple of seconds because a
// gallery is polled continuously and the answers only change when a crop or proxy lands (seconds
// after an upload) or the event is purged. That window is one the callers are already built for:
// the whole fallback ladder in playFile/downloadFile exists because a crop lands AFTER the upload
// response, and "until it lands, serve the original" is the documented, correct answer. Within a
// single response all three lookups now come from one consistent snapshot, which three separate
// stat calls never guaranteed.
const LISTING_TTL_MS = 2_000;
const listings = new Map<string, { at: number; names: Set<string> }>();
function dirNames(dir: string): Set<string> {
  const now = Date.now();
  const hit = listings.get(dir);
  if (hit && now - hit.at < LISTING_TTL_MS) return hit.names;
  let names: Set<string>;
  // Missing directory reads as "nothing on disk", exactly as existsSync did for every name in it.
  try { names = new Set(fs.readdirSync(dir)); } catch { names = new Set(); }
  // A cache with no bound is a leak: event folders are unbounded over the life of the process. The
  // entries are short-lived by TTL anyway, so dropping the lot is enough — no LRU needed.
  if (listings.size > 64) listings.clear();
  listings.set(dir, { at: now, names });
  return names;
}

/** Throw the readdir cache away. Tests only.
 *
 *  The cache is module-level and its TTL is wall-clock, which makes any suite that both writes
 *  files and reads them back order- and speed-dependent: whether a test sees a file it has just
 *  deleted depends on how long the previous test took. That produced a genuine intermittent — one
 *  failure in roughly seventeen full runs of the app suite — where a zip test that expected no
 *  manifest got one, or did not, according to machine load.
 *
 *  Exported rather than reached into, so the coupling is visible from both ends: a test that
 *  needs a clean filesystem view says so, and anyone changing the cache can see who depends on
 *  being able to clear it. */
export function __resetListingCache(): void { listings.clear(); }
const onDisk = (name: string): boolean => {
  // A LEGACY FLAT filename — from before the per-event layout, no "<eventId>/" on it — would make
  // the line below list the uploads ROOT: thousands of event folders, measured at 193ms cold here,
  // to answer one question. Those rows are the rare leftovers and never arrive in bulk, so they
  // keep the single stat and this change is strictly cheaper than what it replaces, never dearer.
  const dir = path.dirname(name);
  if (dir === '.' || dir === '/' || dir === '') {
    try { return fs.existsSync(path.join(UPLOADS_DIR, name)); } catch { return false; }
  }
  const abs = path.join(UPLOADS_DIR, name);
  return dirNames(path.dirname(abs)).has(path.basename(abs));
};

/** The fields the crop/play/download ladder actually reads. Named because three functions share
 *  it and one of them (downloadFile) had already written it out by hand — and because taking the
 *  whole joined gallery row instead meant they could not be called with a photo that is not a
 *  gallery row, which the rotate reply is. */
type MediaRow = { filename: string; mediaType?: string | null; captureShape?: string | null };

/** Did this row ask for a shape the camera may not have given it? */
const wantsCrop = (p: { mediaType?: string | null; captureShape?: string | null }): boolean =>
  p.mediaType === 'video' && !!p.captureShape && p.captureShape !== 'full';

/** The cropped sibling's name, but only once the file is really there. Existence IS the flag: the
 *  crop runs after the upload response and can fail, so a column saying "cropped" could point at a
 *  file that was never written. */
function cropped(p: MediaRow): string | null {
  if (!wantsCrop(p)) return null;
  const name = cropName(p.filename);
  return onDisk(name) ? name : null;
}

/** The file to PLAY.
 *
 *  Preference order, and the reasoning for it:
 *
 *   _dl.mp4   — the re-encoded true crop. Best thing to play as well as to download: it is real
 *               H.264, and being an actual re-encode it is ~40% smaller than the lossless copy,
 *               which is bandwidth saved on every single view. The lossless file's only advantage
 *               is a generation of quality nobody can see on a phone, and it costs that 40% on
 *               every play to keep.
 *   _play.mp4 — a WebM that needed an H.264 proxy before a phone would touch it.
 *   _crop.mp4 — the lossless crop. This is the INTERIM answer: it exists within about 400ms of the
 *               upload, while the re-encode takes seconds, so it is what keeps the gallery correct
 *               in the gap. Also the permanent answer if the re-encode failed.
 *
 *  Null means "nothing better than `url`", which is right for an MP4 that needed no crop at all.
 */
export function playFile(p: MediaRow): string | null {
  if (p.mediaType !== 'video') return null;
  if (wantsCrop(p)) {
    const dl = dlName(p.filename);
    if (onDisk(dl)) return dl;
  }
  const crop = cropped(p);
  const proxy = playName(crop ?? p.filename);
  if (onDisk(proxy)) return proxy;
  return crop;
}

/** The file to hand over when somebody SAVES this, resolved in one place so that the gallery's
 *  download button and the whole-event zip cannot disagree — which they did: the zip read
 *  `filename` straight off the row and handed out the uncropped original of a clip the gallery was
 *  showing cropped.
 *
 *  Preference order, best first:
 *    _dl.mp4   — re-encoded, the surplus actually removed
 *    _crop.mp4 — right shape, surplus hidden in the bitstream (or, for a WebM, already a true crop)
 *    original  — no crop was wanted, or none succeeded
 */
export function downloadFile(p: MediaRow): string {
  if (!wantsCrop(p)) return p.filename;
  const dl = dlName(p.filename);
  if (onDisk(dl)) return dl;
  const crop = cropName(p.filename);
  return onDisk(crop) ? crop : p.filename;
}

/** Should the gallery mark this one "shot sideways"?
 *
 *  The mark is a TO-DO list, not a fact about the photograph: it points at the shots that are lying
 *  on their side and still need somebody to say which way up they go. Two halves, and both have to
 *  be true — the phone was measurably turned relative to the page, and nothing has yet put it back.
 *
 *  capture_orientation USED TO BE THE FIRST HALF, AND IT IS NOT FIT FOR IT. It answers 'landscape'
 *  for two situations that share nothing but the word: auto-rotate on, where the page turned with
 *  the phone and the scene is in the file the right way up, and rotation locked, where the page did
 *  not move and the scene is in the file on its side. The badge fired on both, so it fired on
 *  correctly-captured landscape shots — reported against a clip that had come out perfectly. A
 *  to-do list that points at work nobody needs to do is one nobody works through, which is a fair
 *  description of how thirteen photos came to sit there for months. captureTurn tells the two
 *  apart, because it is the turn relative to the PAGE rather than the grip in the abstract, so
 *  capture_orientation is out of this derivation entirely. The column stays — it is the historical
 *  record of how the phone was held, and the only thing that can still find those thirteen by hand.
 *
 *  THE SECOND HALF is capture_rotation: whatever has been baked into the pixels since, by the
 *  camera at the shutter, by the server on a clip, or by somebody pressing rotate. Non-zero means
 *  dealt with. A row rotated 180 twice comes back to 0 and starts badging again, which is correct —
 *  it is sideways once more, and the badge's job is to say so.
 *
 *  A NULL TURN DOES NOT BADGE, and that is a decision with a visible consequence: every row in
 *  production predates this column, so the mark goes quiet everywhere at once, the thirteen
 *  included. Deliberate. The alternative on offer was a grandfather clause falling back to
 *  capture_orientation for old rows, which would have kept those thirteen at the price of
 *  reinstating the original false positive for every landscape row uploaded since, and of leaving
 *  two rules in the product for one question. The owner's call was to lose the thirteen from the
 *  badge and straighten them as the site admin. One rule, one meaning, no dead branch. */
export function shotSideways(p: { captureTurn?: number | null; captureRotation?: number | null }): boolean {
  return !!p.captureTurn && (p.captureRotation ?? 0) === 0;
}

/** One photo, as a viewer sees it.
 *
 *  `myParticipantId` is THE fork between a shared answer and a personal one, and it now decides
 *  more than a field: a response built with `null` is byte-identical for every viewer and is
 *  therefore given a public, edge-cacheable Cache-Control (see galleryCacheSeconds). One built with
 *  a real participant id carries `isOwn` and must never leave the origin cacheable.
 *
 *  Exported so `gallery-cache.test.ts` can pin that, and so the difference is something a test can
 *  fail on rather than something a reviewer has to notice. */
/** Heart counts for a set of photos, plus which of them the asker has hearted.
 *
 *  Counted, never stored. See migration 0057: a heart_count column would be one more tally to drift
 *  out of step with reality on a purge or a cascade, and this codebase has had that bug enough
 *  times. Two small queries beat one column you cannot trust. */
export type HeartInfo = { counts: Map<string, number>; mine: Set<string>; viewer: string | null };

export async function heartsFor(eventId: string, photoIds: string[], myParticipantId: string | null): Promise<HeartInfo> {
  if (!photoIds.length) return { counts: new Map(), mine: new Set(), viewer: myParticipantId };
  // Scoped by EVENT, never by a list of photo ids. `inArray` emits one bind parameter PER ID, so a
  // 14,000-photo gallery sent a query carrying 14,000 placeholders — measured at 880 KB of SQL text
  // and 38.9ms of pure PLANNING, paid twice per request when hearts and comments are both on.
  // Migration 0059 added `photo_hearts_event_photo_idx` and wrote this warning down; the /hearts
  // endpoint was converted then and this fan-out was missed.
  //
  // A photo's event never changes, so event-scoping returns the same rows — `photoIds` here IS the
  // event's photo set. The Set below is belt and braces for the narrower callers.
  const tally = await db
    .select({ photoId: photoHearts.photoId, n: count() })
    .from(photoHearts).where(eq(photoHearts.eventId, eventId))
    .groupBy(photoHearts.photoId);
  const wanted = new Set(photoIds);
  const counts = new Map(tally.filter((r) => wanted.has(r.photoId)).map((r) => [r.photoId, Number(r.n)]));
  if (!myParticipantId) return { counts, mine: new Set(), viewer: null };
  // Separate and filtered rather than reading every row and picking mine out of it: at a big event
  // that is thousands of rows over the wire to answer a question about one person.
  const own = await db.select({ photoId: photoHearts.photoId }).from(photoHearts)
    .where(and(eq(photoHearts.eventId, eventId), eq(photoHearts.participantId, myParticipantId)));
  return { counts, mine: new Set(own.filter((r) => wanted.has(r.photoId)).map((r) => r.photoId)), viewer: myParticipantId };
}

/** How many comments each of these photos carries.
 *
 *  Counted, never stored, for the same reason hearts are — see migration 0060. There is no
 *  per-viewer half to this one: WHO wrote a comment is on the comment itself and is the same answer
 *  for everybody, so unlike HeartInfo this can ride a shared reply without a viewer at all. */
export type CommentInfo = { counts: Map<string, number> };

export async function commentsFor(eventId: string, photoIds: string[]): Promise<CommentInfo> {
  if (!photoIds.length) return { counts: new Map() };
  // Event-scoped for the same reason heartsFor is — see the note there.
  const tally = await db
    .select({ photoId: photoComments.photoId, n: count() })
    .from(photoComments).where(eq(photoComments.eventId, eventId))
    .groupBy(photoComments.photoId);
  const wanted = new Set(photoIds);
  return { counts: new Map(tally.filter((r) => wanted.has(r.photoId)).map((r) => [r.photoId, Number(r.n)])) };
}

/** `hearts` undefined means the feature is OFF for this event — the fields are then absent from the
 *  payload entirely rather than sent as zeroes, so a client cannot draw an empty heart on a gallery
 *  where hearting is not a thing you can do.
 *
 *  `hearted` rides ONLY when the info knows whose view this is. The public gallery reply is
 *  shared-cacheable (cacheableFor), so anything per-viewer in it is one guest's state handed to the
 *  next guest out of the cache. The COUNT is shared truth and caches fine; who pressed it does not,
 *  and the client asks for its own set separately.
 *
 *  `comments` is the same contract for the comment count, and likewise absent when the host has
 *  comments off — which is EVERY event by default, so most galleries never carry the field at all.
 *  The count is shared truth and caches fine; the messages themselves are a separate, per-viewer
 *  read (see GET /:joinCode/comments), because the visibility rule they must pass depends on who is
 *  asking. */
export function photoRow(p: PhotoRowInput, myParticipantId: string | null, captions: Map<string, string>, hearts?: HeartInfo, comments?: CommentInfo) {
  return {
    id:              p.id,
    // The clip in the shape the guest chose, when the server managed to cut one; otherwise the file
    // exactly as it arrived. The uncropped original is never deleted — it stays beside this until
    // the event's normal purge, so a crop that turns out to be wrong on some device is a thing we
    // can still put right rather than a thing we have destroyed.
    url:             `/uploads/${downloadFile(p)}`,
    thumbUrl:        `/uploads/${thumbName(cropped(p) ?? p.filename)}`,  // grid thumbnail / video poster
    // A phone-decodable H.264 copy, when one has been built. The original stays the download; this
    // is only what a <video> element plays, because the original may be VP8/WebM that phones
    // software-decode (stutter) and Safari may refuse entirely.
    // Omitted when it would only repeat `url` — which is the common case once the re-encode has
    // landed, since by then the same file is both the best play and the right download.
    ...(playFile(p) && playFile(p) !== downloadFile(p) ? { playUrl: `/uploads/${playFile(p)}` } : {}),
    takenAt:         p.takenAt,
    participantName: p.participantName,
    participantId:   p.participantId,
    // The mission this shot was for, as the host wrote it — shown as the photo's caption, which is
    // what turns the album into an annotated record instead of a pile of photos. An id the host has
    // since deleted from their list resolves to nothing rather than leaking a raw slug.
    challenge:       (p.challengeId && captions.get(p.challengeId)) || null,
    // The written caption, if anyone wrote one. Deliberately a SECOND field beside `challenge`
    // rather than a replacement for it: a captioned trick shot shows the caption as the caption and
    // keeps the mission as a small label, so the trick attribution is never silently eaten. Always
    // present (null when absent) so no reader has to feature-detect it.
    caption:         p.caption ?? null,
    isHighlighted:   !!p.isHighlighted,
    rating:          p.rating ?? 0,
    mediaType:       p.mediaType || 'photo',
    status:          p.status || 'approved',
    sizeBytes:       p.sizeBytes ?? undefined,
    width:           p.width ?? undefined,
    height:          p.height ?? undefined,
    durationMs:      p.durationMs ?? undefined,
    // Only ever sent when it is TRUE. The gallery's single use is a "shot sideways" mark, and
    // 'portrait'/null/unknown/already-corrected all mean "say nothing" — shipping those would put
    // several values on the wire to distinguish states no reader distinguishes. See shotSideways().
    shotSideways:    shotSideways(p) ? true : undefined,
    isOwn:           myParticipantId ? p.participantId === myParticipantId : undefined,
    ...(hearts ? { hearts: hearts.counts.get(p.id) ?? 0 } : {}),
    ...(hearts?.viewer ? { hearted: hearts.mine.has(p.id) } : {}),
    ...(comments ? { comments: comments.counts.get(p.id) ?? 0 } : {}),
  };
}

// ── Shared upload machinery (used by the single-shot POST / and the chunked /complete) ─────────

type UploadParticipant = {
  id: string; photosTaken: number; maxPhotos: number; extraPhotos: number; isLocked: boolean;
  startsAt: number; expiresAt: number; eventId: string; moderationEnabled: boolean; videoSeconds: number;
  challengeSet: string | null; eventChallenges: string | null;
  // The frame shapes this event is entitled to, as the stored JSON. Selected on the upload path for
  // the same reason `eventChallenges` is: the shape arrives from the client and is worthless
  // without the list to check it against.
  aspectRatios: string | null;
  /** When this event's media is due to be deleted, and when it actually was. Together they are the
   *  only honest ceiling on a late upload: a shot may arrive for as long as there is still an event
   *  for it to land in. `purgeAt` is nulled and `purgedAt` stamped by the sweeper. */
  purgeAt: number | null; purgedAt: number | null;
};

async function participantForUpload(sessionToken: string): Promise<UploadParticipant | null> {
  const [p] = await db.select({
    id: participants.id, photosTaken: participants.photosTaken, maxPhotos: events.maxPhotos,
    extraPhotos: participants.extraPhotos,
    isLocked: events.isLocked, startsAt: events.startsAt, expiresAt: events.expiresAt,
    eventId: events.id, moderationEnabled: events.moderationEnabled, videoSeconds: events.videoSeconds,
    challengeSet: participants.challengeSet, eventChallenges: events.challenges,
    aspectRatios: events.aspectRatios,
    // The retention window — what now bounds a late upload. See lateUploadAllowed.
    purgeAt: events.purgeAt, purgedAt: events.purgedAt,
  }).from(participants).innerJoin(events, eq(events.id, participants.eventId))
    .where(eq(participants.sessionToken, sessionToken));
  return p ?? null;
}

/* THE NETWORK GRACE PERIOD IS GONE, DELIBERATELY.
 *
 *  A 24-hour ceiling used to live here, described as "a grace period for the NETWORK" — right about
 *  the intent, wrong about the consequence. Twenty-four hours is still a judgement about
 *  connectivity, and it still throws away photographs on the strength of one.
 *
 *  On 2026-09-21 it did exactly that: nineteen uploads for a hen do were refused between three and
 *  six hours past the ceiling, one handset draining fifteen queued captures in ninety seconds.
 *  Every one of those shutters had been pressed while the event was open.
 *
 *  A phone that goes flat and is charged the next evening, a guest who flies home before opening
 *  the app again, a venue whose wifi never comes back — the photograph was taken inside the event
 *  in all three cases, and the only thing separating them from a phone that uploaded instantly is
 *  luck. What the event is entitled to refuse is a NEW capture taken after it closed. That is a
 *  different question from how long the upload took, and only the first one is the event's
 *  business.
 *
 *  So the rule is now the one this file's tests always claimed in their title: the shutter decides,
 *  the network does not. The ceiling that replaces it is not "none" — it is the event's own
 *  retention window, which is the only limit that means anything: past it there is no event left
 *  for the photo to land in. See lateUploadAllowed and mediaWindowOpen. */

/** How far ahead of us a phone's clock may be and still be believed. Phones drift, and a handset a
 *  minute or two fast must not have its shots read as "taken after the end". */
const CLOCK_SKEW_MS = 5 * 60_000;

/** What the client SAYS the shutter went at, reduced to something safe to reason about.
 *
 *  Never trusted as given. A client clock is advisory: it can be wrong by hours, and it can be set
 *  deliberately by someone who would like their photo in an event that has closed. So a claim is
 *  only honoured when it is plausible — a real number, not in the future beyond ordinary drift, and
 *  not before the event began. Anything else falls back to the server's own clock, which is the
 *  behaviour this had before the field existed. */
export function capturedAtFor(raw: unknown, p: { startsAt: number | null }, now: number): number {
  const claimed = Number(raw);
  if (!Number.isFinite(claimed) || claimed <= 0) return now;
  if (claimed > now + CLOCK_SKEW_MS) return now;
  if (p.startsAt && claimed < p.startsAt) return now;
  return claimed;
}

/** The clip length this event is ENTITLED to, in seconds.
 *
 *  Lifted out of gateUpload and finalizeUpload, which computed it separately and identically. Two
 *  copies of the rule that decides whether a guest's video survives is one copy too many: the
 *  gate's copy and the ceiling's copy disagreeing by a second means a clip waved through at the
 *  door and then destroyed after the transcode, which is the worst of both answers and the
 *  slowest way to reach it. */
export function allowedVideoSecs(videoSeconds: number): number {
  // Self-host (billing off) is the FULL app — that is the pitch, and the licence. An unset
  // VIDEO_MAX_SECONDS therefore means "no per-event limit", NOT "video disabled": the old reading
  // silently refused every video upload on a fresh self-hosted install with no error a self-hoster
  // could act on. Set VIDEO_MAX_SECONDS to a positive number to cap it. Only a HOSTED deployment
  // gates video behind the paid add-on.
  return billingEnabled ? videoSeconds : (VIDEO_MAX_SECS > 0 ? VIDEO_MAX_SECS : Number.POSITIVE_INFINITY);
}

/** The longest clip this server will actually KEEP for this event, in milliseconds.
 *
 *  Always finite and never above VIDEO_HARD_MAX_SECS, even where the entitlement is unlimited: the
 *  hard maximum is a storage and abuse guard rather than a pricing gate, and it is the one number
 *  in the video path that nothing is allowed to argue with.
 *
 *  It has a second job now. finalizeUpload destroys anything longer than this, so it is also the
 *  honest upper bound on how long a capture we are willing to believe in — which is exactly what
 *  the late-upload gate needs when a client does not tell us how long its clip was. A duration
 *  large enough to widen that gate further than this number is a duration attached to a file we
 *  would have refused anyway, so believing it would buy an attacker nothing and cost us a branch. */
export function maxAcceptedClipMs(videoSeconds: number): number {
  const allowed = allowedVideoSecs(videoSeconds);
  return Math.min(VIDEO_GRACE_SECS > 0 ? allowed + VIDEO_GRACE_SECS : VIDEO_HARD_MAX_SECS, VIDEO_HARD_MAX_SECS) * 1000;
}

/** The number the client actually sent, or null if it did not send one.
 *
 *  `Number()` on its own cannot answer this question, because it maps four different kinds of
 *  nothing — '', null, [], false — onto the number 0, and 0 is a value this gate now has to be
 *  able to believe (see captureSpanMs). A string is accepted because it is how the field really
 *  arrives on the single-shot upload: POST / is multipart, so every field on that wire is text
 *  and `durationSecs` is '0' rather than 0. A reader that only understood the JSON shape would
 *  work on the chunked /complete and quietly not on the door most photographs come through. */
function numericClaim(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** How far `capturedAt` may sit from the instant the capture actually BEGAN, in milliseconds.
 *
 *  THE PROBLEM THIS EXISTS FOR, because nothing about the field name gives it away.
 *
 *  `capturedAt` comes from the client and has meant two different things in two generations of the
 *  app. The current camera stamps it when recording STARTS. Everything before it stamps it when
 *  the item is ENQUEUED, which for a clip is when recording STOPS — and that is not only a problem
 *  for handsets that have not reloaded the page. Items sit in a guest's IndexedDB queue across
 *  reloads by design, so a queue built before the change keeps draining old-style stamps at us for
 *  as long as that tab lives. For a still the two instants are the same and none of this matters.
 *  For a clip they are a whole clip apart.
 *
 *  WE CANNOT TELL THE TWO APART. There is no version marker on the wire, and there is nothing in
 *  the values themselves that separates them: a start stamp and a stop stamp are both plausible
 *  past instants and both are consistent with an upload arriving some time afterwards. Sniffing
 *  was considered and rejected — the only rule anyone could propose ("a stop stamp lands nearer to
 *  `now`") is wrong in precisely the case that matters, a long clip uploaded promptly.
 *
 *  SO WE HONOUR BOTH READINGS. Whichever generation sent it, the capture certainly lies inside
 *  [capturedAt - span, capturedAt + span], and the gate asks whether THAT interval began before
 *  the event closed. For a photo the span is zero and the gate is bit-for-bit what it always was,
 *  so nothing about stills moves an inch. For a clip the span is the clip's own length where the
 *  client tells us, and the longest clip we would keep at all where it does not.
 *
 *  THE COST, stated plainly rather than buried: a clip from a CURRENT client that genuinely began
 *  after the event closed is accepted if it began within its own duration of the end — up to ten
 *  minutes at the default hard maximum. That is a deliberate trade, not an oversight. The
 *  alternative is refusing a guest's ten-minute recording of the speeches because an old phone
 *  stamped it at the stop instead of the start, and a lost video is unrecoverable in a way that a
 *  slightly late one we kept is not.
 *
 *  It is retirable without touching the rule. The day a client sends something that says "this
 *  stamp is the START", and every pre-change queue has drained, the backward half of the interval
 *  can go and the span becomes forward-only. Nothing sends such a field today, so nothing here
 *  pretends to read one — a speculative branch that no client exercises is a branch that is wrong
 *  by the time anyone needs it.
 *
 *  The claim is CLAMPED, never trusted. A forged durationMs of a hundred years would otherwise
 *  hold the event's door open for a hundred years, and the client is the only witness to it.
 *
 *  Both `durationMs` and `durationSecs` are read. The queue has historically carried the clip
 *  length in whole seconds while the column and the ffprobe result speak milliseconds; accepting
 *  either costs one branch and removes the entire class of "the field was there, in the other
 *  unit, and we silently fell back to the ten-minute assumption".
 *
 *  AND A `durationSecs` OF ZERO IS A MEASUREMENT, not an absence. The camera counts recording
 *  time off a one-second interval (`recSecs++`), so a clip the guest taps out in under a second
 *  really does have a duration of zero whole seconds — and Camera.svelte goes out of its way to
 *  send it, testing `!= null` rather than truthiness, precisely so the server is not left
 *  assuming a ten-minute ceiling for a half-second video. `secs > 0` then threw that away: an
 *  explicit 0 fell down the "no claim at all" branch and collected the entire ceiling, so the one
 *  field the client took care to send changed nothing whatsoever. Honouring it costs a
 *  sub-second clip nothing it should have had and takes ten minutes of held-open door off an
 *  event that closed.
 *
 *  WHICH IS WHY THE READING IS `numericClaim` AND NOT `Number`. Number('') is 0. So is
 *  Number(null), Number([]) and Number(false). Widening the test to `secs >= 0` would therefore
 *  turn every one of those — an old client that sends nothing, a field that arrived empty, a
 *  forged value — into "this clip was under a second", which is the original bug back again with
 *  a new cause and aimed at exactly the clients least able to survive it. Only a number, or a
 *  string that is really a number, is a claim; everything else is silence.
 *
 *  `durationMs` is deliberately NOT given the same treatment. It is the millisecond side of the
 *  wire — the column and the ffprobe result — where a zero means "not measured" rather than
 *  "shorter than my resolution", and it is pinned as rubbish by the tests for that reason. The
 *  asymmetry is the two fields meaning different things, not an oversight. */
export function captureSpanMs(isVideo: boolean,
                              body: { durationMs?: unknown; durationSecs?: unknown } | null | undefined,
                              maxClipMs: number): number {
  if (!isVideo) return 0;
  const ms = Number(body?.durationMs);
  const secs = numericClaim(body?.durationSecs);
  const claimed = Number.isFinite(ms) && ms > 0 ? ms
                : secs !== null && secs >= 0 ? secs * 1000
                : null;
  // No claim at all is the old client and the camera-roll upload, which are the two cases most in
  // need of the benefit of the doubt. Assume the longest clip we would keep rather than assume
  // zero: assuming zero is assuming the stamp is a start stamp, which is assuming away the whole
  // problem in favour of the guests who are least likely to have one.
  if (claimed === null) return maxClipMs;
  return Math.min(claimed, maxClipMs);
}

/** May a shot that arrives AFTER the event closed still be accepted?
 *
 *  Two conditions, and both halves are the point.
 *
 *  Taken inside the window — because whether a photograph belongs to an event is settled by when
 *  the shutter went, not by whether the network cooperated before a deadline. Without this, a queue
 *  draining slowly loses real photographs from the party, which is what happened.
 *
 *  And still inside the grace — because without it the event never actually closes, and a phone
 *  found in a drawer next year could post into a stranger's gallery.
 *
 *  `spanMs` IS THE CLIP ALLOWANCE, and it is why this grew a fourth argument. The rule, in the
 *  owner's words, is that we do the heavy lifting if the guest captures before the event ends,
 *  regardless of when the capture actually stops. A ninety-second clip begun one second before the
 *  close used to pass this test purely by luck — CLOCK_SKEW_MS happened to be five minutes and the
 *  clip happened to be shorter than five minutes. A ten-minute clip begun in the same second did
 *  not, and was refused outright. That is a clock-skew pad quietly doing a second job it was never
 *  sized for and nobody had written down, and the fix is to give the clip its own term so the pad
 *  can go back to meaning clock skew and nothing else. The skew has not changed by a millisecond;
 *  it has simply stopped being load-bearing for a question it knows nothing about. See
 *  captureSpanMs for where the span comes from and what it costs us.
 *
 *  THE OUTER BOUND IS MEASURED FROM THE END OF THE CAPTURE, not from the end of the event, for the
 *  same reason. A ten-minute clip begun just before the close has not finished RECORDING until ten
 *  minutes after it, and only then starts climbing a party's worst connection; handing it the same
 *  twenty-four hours as a still taken at lunchtime quietly docks its network grace by the length of
 *  the clip, which is exactly backwards — the long clip is the one that needs the time. Where the
 *  capture cannot have ended later than the event did, which is every photo and every clip that
 *  finished before the close, this is arithmetically identical to what it always was.
 *
 *  `spanMs` defaults to zero so a caller that has not been taught about clips — and every photo —
 *  gets precisely the function that was here before any of this.
 *
 *  Its own function, rather than two lines inside the gate, so the rule can be tested at the
 *  boundaries where it is easy to get wrong by one skew or one window. */
export function lateUploadAllowed(expiresAt: number, capturedAt: number, spanMs = 0): boolean {
  const mayHaveBegun = capturedAt - spanMs;    // the earliest instant this capture can have started
  return mayHaveBegun <= expiresAt + CLOCK_SKEW_MS;
}

/** Is there still an event for a photo to land in?
 *
 *  This is the ceiling that replaced the 24-hour network grace, and the difference is what it is a
 *  statement ABOUT. The old bound asked how long the upload took, which is a fact about a phone's
 *  signal and says nothing about whether the photograph belongs in the gallery. This asks whether
 *  the gallery still exists, which is the only thing that can actually make a late upload
 *  impossible: past the purge the photo rows and the files are deleted, so accepting one would
 *  write a file into an event that has nothing to show it.
 *
 *  `purgedAt` set means the sweeper has already been through — there is nothing to join. `purgeAt`
 *  null with no `purgedAt` means no purge is scheduled, and we lean long, the same way purgeAtFor
 *  leans long, because every wrong answer here costs somebody their photographs. */
export function mediaWindowOpen(purgeAt: number | null, purgedAt: number | null, now: number): boolean {
  if (purgedAt != null) return false;
  if (purgeAt == null) return true;
  return now <= purgeAt;
}

// Returns {status,error} to reject the upload, or null if it's allowed right now.
//
// `durationRaw` is the request BODY, read for one thing only: the clip length the client claims.
// Handed over whole rather than pre-read at the call sites because there are two call sites — the
// single-shot POST / and the chunked /complete — and the one property this gate must never lose is
// that an upload gets the same answer whichever door it came through. A field read at one call
// site and forgotten at the other is how that property dies quietly.
//
// Exported for the tests. The interesting cases here are combinations (a video, after the close,
// with an old-style stamp and no duration) and a test that can only reach them through two other
// functions is a test of those two functions, not of the gate.
export function gateUpload(p: UploadParticipant, isVideo: boolean, capturedAt?: number,
                           durationRaw?: { durationMs?: unknown; durationSecs?: unknown } | null,
                           /** May this upload claim a CLIP'S allowance past the close?
                            *
                            *  Separate from `isVideo`, and the separation is the point. `isVideo`
                            *  decides entitlement — whether this event may have video at all —
                            *  and must stay generous about what counts as a clip, or a genuine
                            *  recording with an unusual extension slips past the paid check.
                            *  This decides how far past the event's end the upload may reach,
                            *  and must be the opposite: as tight as the evidence allows.
                            *
                            *  They differ because on the chunked route `isVideo` is partly the
                            *  CLIENT'S word — `mediaType === 'video'` — and a still declared as a
                            *  clip would otherwise buy the full ten-minute ceiling of extra reach
                            *  past the close for a photograph. Low value and bounded, but it is
                            *  the one way round the rule that a still gets no allowance, and the
                            *  rule is only worth having if it cannot be opted out of.
                            *
                            *  Defaults to `isVideo` so the single-shot route is unchanged: there
                            *  the flag already comes from the file itself, not from a field. */
                           clipAllowance: boolean = isVideo): { status: number; error: string } | null {
  const allowed = allowedVideoSecs(p.videoSeconds);
  if (isVideo && billingEnabled && allowed === 0) {
    return { status: 403, error: 'Video uploads are not enabled for this event' };
  }
  const now = Date.now();
  if (p.startsAt && now < p.startsAt)     return { status: 403, error: "Event hasn't started yet" };
  if (p.isLocked)                         return { status: 403, error: 'Event is locked' };
  // Whether a photograph belongs to an event is settled by when the shutter WENT, not by whether
  // the network cooperated before a deadline — and for a clip, "went" means the instant recording
  // BEGAN. A guest who presses record with one second left on the clock has captured something
  // that belongs to this party, and it stays theirs however long the clip runs and however long it
  // then takes to arrive. A capture that began after the close is refused, as it always was.
  //
  // Both halves matter. Without the first, a queue draining slowly loses real photographs from the
  // party and a long clip started at the last moment is thrown away for the crime of being long.
  // Without the second, the event never actually closes.
  //
  // An upload carrying no capturedAt at all — a client too old to send one, or one whose claim was
  // too implausible for capturedAtFor to honour — still falls back to `now`, exactly as before.
  // Subtracting a clip's span from that fallback is not a concession, it is arithmetic: the bytes
  // are in our hands, so the camera must have been running for the length of the clip before they
  // could be, and the recording therefore began at least that long ago.
  if (now > p.expiresAt) {
    // Two different refusals, and they are told apart because they are different things to be told.
    // "You are too late" and "you took this after it finished" used to share one message, which
    // meant a guest whose phone had simply been flat read it as an accusation and a guest genuinely
    // shooting afterwards read it as a network problem.
    const span = captureSpanMs(clipAllowance, durationRaw, maxAcceptedClipMs(p.videoSeconds));
    if (!lateUploadAllowed(p.expiresAt, capturedAt ?? now, span)) {
      return { status: 410, error: 'Event has ended' };
    }
    // The shutter was pressed inside the event. The only thing that can refuse it now is that the
    // event's media has been deleted, and then there is genuinely nowhere to put it.
    if (!mediaWindowOpen(p.purgeAt, p.purgedAt, now)) {
      return { status: 410, error: 'Event photos have been deleted' };
    }
  }
  if (!hasShotsLeft(p))                   return { status: 403, error: 'No shots remaining' };
  return null;
}

// Move a fully-received staged file into the event folder, process it (strip+thumbnail for images,
// probe+poster for video), insert the photo row, and bump the participant's count. Returns the
// success payload. Throws an error tagged { status: 400 } for an invalid image (file cleaned first).
/** How the phone was held, as reported by the browser at capture. Anything we do not recognise —
 *  including nothing at all — is stored as NULL and reads as "unknown". The client is the only
 *  witness to this, so the value is untrusted input like any other and is matched against a fixed
 *  list rather than written through. */
function readOrientation(raw: unknown): string | null {
  return raw === 'portrait' || raw === 'landscape' ? raw : null;
}

/** How far the phone was TURNED relative to the page, as an untrusted field. Degrees clockwise.
 *
 *  A SEPARATE VALIDATOR FROM readQuarter, which is the one thing about it worth reading twice.
 *  readQuarter guards a rotate REQUEST and refuses 0 on purpose, because 0 is not a turn and
 *  honouring it would rewrite a file and invalidate every cached copy of it to achieve nothing.
 *  This one guards a MEASUREMENT, and 0 is the most common answer there is: the phone was square
 *  with the page. Refusing it here would throw away the only thing that distinguishes a client that
 *  measured and found nothing from a client too old to measure at all — which is precisely the
 *  distinction the badge now rests on, since a landscape shot with turn 0 is a correct photo and a
 *  landscape shot with turn NULL is a row we know nothing about.
 *
 *  180 is accepted and is very nearly unreachable: the tilt watcher settles on 0, 90 or -90 (see
 *  deviceTilt.ts on the client). It costs nothing to honour and the alternative is a value the
 *  server silently drops if the client ever grows one.
 *
 *  Anything else — 270, 45, a word, an object — is NULL and not 0, for the reason capture_rotation
 *  does the same with the same class of input: "nobody said" and "measured, and it was nothing" are
 *  different claims, they read the same today, and only one of them can still be told apart later. */
export function readTurn(raw: unknown): number | null {
  // The blank is checked because Number('') is 0, and 0 is a value this validator ACCEPTS — so a
  // field the client appended empty, or a form that sent the key with nothing after it, would read
  // back as a measurement of "the phone was square with the page" rather than as no measurement at
  // all. That is the one mistake the whole 0-versus-NULL distinction exists to avoid, arriving
  // through the front door. readQuarter is not exposed to it only because it refuses 0 outright.
  const n = typeof raw === 'number' ? raw
    : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim())
    : NaN;
  return n === 0 || n === 90 || n === -90 || n === 180 ? n : null;
}

/** The frame shapes an event may ask for, read off its stored JSON. Unreadable or empty reads as
 *  the free baseline, which is the one shape every event has. */
export function allowedShapes(stored: string | null | undefined): string[] {
  try {
    const p = JSON.parse(stored || '["1:1"]');
    if (Array.isArray(p) && p.length) return p.map(String);
  } catch { /* fall through to the baseline */ }
  return ['1:1'];
}

/** The shape the guest chose, checked against what this EVENT actually has.
 *
 *  Matching the ratio GRAMMAR (`\d{1,2}:\d{1,2}`) was all this used to do, and the grammar is not
 *  the rule. Three things followed from that:
 *
 *   - the $5 frame pack was a UI-only gate. The camera only offers the shapes the event sent it, so
 *     nothing an honest guest does is affected — but `captureShape: '9:16'` posted by hand to a
 *     free, square-only event was honoured, and the clip came back in a shape nobody paid for.
 *   - `'99:1'` was a legal shape.
 *   - and every shaped clip queues a full-resolution CRF-18 re-encode (`dlName`) in the single
 *     global video slot that guest playback proxies also wait in, so one forged field per upload on
 *     one free event was a lever on video for every other event on the box.
 *
 *  A shape we will not honour falls back to `'full'` — keep the clip exactly as recorded — rather
 *  than rejecting the upload. The upload is a guest standing at a party with one of a fixed number
 *  of shots spent; losing the moment over a field that only decides FRAMING is out of all
 *  proportion to it, and it is the same call the crop path already makes ("a clip in the wrong shape
 *  is a far smaller problem than a clip that does not play", images.ts).
 *
 *  `'full'` specifically, and not the event's own first shape, for two reasons. It is the only
 *  fallback that does no work: falling back to a real ratio would still buy the forged request its
 *  re-encode, which is half of what is being closed here. And it never removes pixels — cropping a
 *  guest's clip to a shape nobody chose is a worse answer than handing back the whole frame.
 *
 *  Honest clients cannot reach the fallback: the camera renders only the event's own shapes, and an
 *  event's shape set can be added to but is re-quoted and paid for before it changes, so a stale
 *  client holds FEWER shapes than the server allows, never more. */
export function readShape(raw: unknown, allowed: string[]): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  // 'full' is "do not crop", which is what an unentitled event gets anyway — and it is the fallback
  // below, so refusing it here would only be a slower way of saying the same thing.
  if (v === 'full') return 'full';
  if (!shapeRatio(v)) return null;
  return allowed.includes(v) ? v : 'full';
}

async function finalizeUpload(p: UploadParticipant, stagedPath: string, isVideo: boolean,
                              source: 'capture' | 'upload' = 'capture', challengeRaw?: unknown,
                              orientationRaw?: unknown, shapeRaw?: unknown, rotationRaw?: unknown,
                              turnRaw?: unknown, capturedAtRaw?: unknown) {
  const destDir = eventDir(p.eventId);
  fs.mkdirSync(destDir, { recursive: true });
  const baseName = path.basename(stagedPath);                       // <uuid>.ext
  const finalPath = path.join(destDir, baseName);
  fs.renameSync(stagedPath, finalPath);
  const storedName = eventRelPath(p.eventId, baseName);             // "<eventId>/<uuid>.ext"
  const sizeBytes = fs.statSync(finalPath).size;

  // How far the phone was turned relative to the page when this was framed. Read here rather than
  // at the insert because for a clip it is not only stored, it is WORK: see the correction
  // scheduled at the bottom of this function.
  const turn = readTurn(turnRaw);
  // Every background job started under this upload's base name. Collected so the capture-turn
  // correction can be the last thing to touch the clip — again, see the bottom of this function.
  const derivations: Promise<unknown>[] = [];

  let dims: { width?: number; height?: number; durationMs?: number } = {};
  if (!isVideo) {
    try { dims = await stripImageMetadata(finalPath); await makeThumbnail(finalPath); }
    catch {
      try { fs.unlinkSync(finalPath); } catch { /* */ }
      const e = new Error('Invalid or unsupported image file') as Error & { status?: number }; e.status = 400; throw e;
    }
  } else {
    dims = await probeVideoMeta(finalPath).catch(() => ({}));
    await makeVideoPoster(finalPath).catch(() => false);
    // Deliberately NOT awaited: a 30s clip takes ~15s to transcode and the guest is standing at a
    // party. The gallery falls back to the original until the proxy lands.
    //
    // CHAINED, not run alongside: fixAudioLead rewrites the original in place, and a proxy built
    // from the file as it arrived would simply carry the fault into the copy meant to be free of
    // it. Correcting first also usually means no proxy is needed at all — an in-step H.264 clip
    // takes the early-out instead of a full transcode.
    //
    // WRAPPED IN whileDeriving, like the crop chain below. Everything this kicks off writes files
    // under `finalPath`'s base name for minutes afterwards, and POST /:id/rotate moves that base
    // name — so the rotate route has to be able to ask whether this is still running. Nothing else
    // reads the register; see the note on it in images.ts for what happens when a rename lands in
    // the middle of one of these.
    //
    // COLLECTED, not discarded, because a clip with a capture turn has one more pass coming and it
    // has to be the last one. Pushing the promise is the only change; nothing waits on it here.
    derivations.push(whileDeriving(finalPath, () => fixAudioLead(finalPath)
      .catch(() => false)
      .then(() => makePlaybackProxy(finalPath))
      .catch(() => false)));
    // Enforce the event's video length limit server-side (defense-in-depth): the in-browser recorder
    // auto-stops at the limit, but a native-camera clip could be any length. Only when we can read a
    // real duration; +3s tolerance for container rounding.
    // Both numbers now come from the shared helpers rather than being recomputed here. The gate
    // widens its late-upload window by exactly maxAcceptedClipMs, so if this ceiling and that
    // widening ever drifted apart we would either wave through clips we then delete after paying
    // for the transcode, or refuse at the door clips we were perfectly willing to store.
    const allowed = allowedVideoSecs(p.videoSeconds);
    if (allowed > 0 && typeof dims.durationMs === 'number') {
      const secs = dims.durationMs / 1000;
      const cap = maxAcceptedClipMs(p.videoSeconds) / 1000;
      // The SERVER keeps whatever it is given, up to an absolute ceiling. The UI is what gates
      // length (the recorder stops itself at the event's limit), and if a capture overshoots anyway
      // — a 10s limit yielding a 15s file because the recorder flushed late — throwing it away
      // punishes the guest for our bug. A guest never gets that moment back; we can always fix the
      // recorder. `source` therefore decides how we REPORT an overage, never whether we keep it.
      if (secs > cap) {
        try { fs.unlinkSync(finalPath); } catch { /* */ }
        const e = new Error(`Video is too long — this server accepts clips up to ${Math.round(cap)}s`) as Error & { status?: number };
        e.status = 413; throw e;
      }
      // Over the purchased limit but inside the ceiling: keep it, and leave the evidence. No column
      // needed — photos.duration_ms against events.video_seconds already answers "how far over".
      if (secs > allowed + 3) {
        console.log(source === 'capture'
          // The recorder was supposed to stop at `allowed`. It did not. Kept regardless, but this
          // one is a bug to chase, not a guest being generous with their own camera.
          ? `[video] DEFECT: in-app capture overshot — ${Math.round(secs)}s on a ${allowed}s event (${p.eventId}); recorder should have stopped itself`
          : `[video] over-limit camera-roll clip kept: ${Math.round(secs)}s on a ${allowed}s event (${p.eventId})`);
      }
    }
  }

  // Every item starts 'pending'; visibility is gated by the event's moderation SETTING at view time.
  // Which mission this shot was for, if the guest picked one. Validated against THEIR set, not the
  // event's whole list: the text becomes the photo's caption in the gallery, so an unchecked value
  // would let a guest write arbitrary text under someone else's photo — and would let them tick off
  // a mission from a card they were never handed.
  //
  // A trick is a PHOTO prompt. Every challenge we ship is worded as a still, the saved shape carries
  // no notion of a clip, and the point of the list is that a guest's roll is finite — spending one
  // of a fixed number of shots on a trick is a real decision. A clip is a different currency
  // (seconds, usually paid) and one ten-second clip plausibly contains several tricks at once, which
  // makes ticking them arbitrary. So a video never ticks anything, whatever it was tagged with.
  const challengeId = !isVideo && isOfferedChallenge(readSets(p.eventChallenges), p.challengeSet, challengeRaw)
    ? String(challengeRaw).trim() : null;

  const status = 'pending';
  const photoId = uuidv4();
  // Resolved ONCE. It was read twice — once for the column, once for the crop below — which is two
  // chances for the stored shape and the shape that was actually cut to disagree.
  const shape = readShape(shapeRaw, allowedShapes(p.aspectRatios));

  // Claiming the frame and storing the photo are ONE decision, so they are one statement pair in
  // one transaction — and the counter is arithmetic the DATABASE does, never a number this process
  // read a moment ago and adds one to.
  //
  // It used to be `set({ photosTaken: p.photosTaken + 1 })` over a value read back in
  // participantForUpload(). Ten uploads arriving together on one session token all read 0, all
  // wrote 1, and a 30-shot roll recorded one photo taken while holding ten. The limited roll is
  // this product, and `extraPhotos` is something a guest PAYS for, so a lost increment is a guest
  // shooting frames nobody sold them.
  //
  // The WHERE is the cap. An atomic counter that nothing compares is only half a fix: gateUpload()
  // above still checks hasShotsLeft() — it is what stops us transcoding a clip we are about to
  // refuse — but it decides on a row read before any of this work, so it can only ever be an early
  // out. THIS predicate is the enforcement, evaluated by Postgres against the row it is locking.
  //
  // The limit is re-read from `events` inside the same statement rather than trusted from `p`, for
  // the reason the join route re-reads guestCap under its lock: a host who buys a bigger tier
  // mid-party, or a guest who tops up their own roll while an upload is in flight, should be
  // believed immediately. GREATEST(extra_photos, 0) mirrors the clamping in allowance.ts so a
  // negative column can never shrink the roll below what the event sold.
  const eventMaxPhotos = sql<number>`(select ${events.maxPhotos} from ${events} where ${events.id} = ${participants.eventId})`;
  const claim = await db.transaction(async (tx) => {
    const [row] = await tx.update(participants)
      .set({ photosTaken: sql`${participants.photosTaken} + 1` })
      .where(and(
        eq(participants.id, p.id),
        sql`${participants.photosTaken} < ${eventMaxPhotos} + greatest(${participants.extraPhotos}, 0)`,
      ))
      .returning({
        photosTaken: participants.photosTaken,
        extraPhotos: participants.extraPhotos,
        maxPhotos: eventMaxPhotos,
      });
    // No row came back: the roll filled up between the gate and here. Return nothing and the
    // transaction rolls back, so there is no orphan photo row to reconcile later.
    if (!row) return null;
    await tx.insert(photos).values({
      id: photoId, eventId: p.eventId, participantId: p.id, filename: storedName,
      // takenAt stays the arrival time. It is what the delete window and the roll's ordering have
      // always been measured against, and quietly redefining it would shorten a guest's window to
      // undo a photo that took a while to upload. capturedAt is the honest answer to a DIFFERENT
      // question, recorded beside it rather than on top of it.
      mediaType: isVideo ? 'video' : 'photo', takenAt: Date.now(),
      capturedAt: capturedAtFor(capturedAtRaw, p, Date.now()), status,
      challengeId,
      sizeBytes, width: dims.width ?? null, height: dims.height ?? null, durationMs: dims.durationMs ?? null,
      source,
      captureOrientation: readOrientation(orientationRaw),
      // What the SHUTTER already put right, in the same degrees-clockwise the rotate button
      // accumulates: the camera turns its canvas by the phone's own glyph rotation before it
      // encodes, so the pixels arriving here are upright and it tells us by how much.
      //
      // This field was posted by both upload paths and read by neither, which is worse than not
      // sending it. A photo the shutter had already straightened stored capture_orientation
      // 'landscape' with nothing against it, so shotSideways() said yes — the badge pointing at
      // precisely the photos that do NOT need attention, and inviting a host to rotate a picture
      // that was already the right way up. That is the fault capture_rotation exists to prevent.
      //
      // Read through readQuarter, the same validator the rotate route applies to the same wire
      // value: a turn is a turn whoever applied it, and a field a client could forge is not a
      // number to write through. So anything that is not one of the three real turns — 0, 270,
      // absent, nonsense — becomes NULL and NOT 0, because "nobody said" and "turned, and the
      // total is zero" are different claims. readOrientation treats an unrecognised grip exactly
      // that way for exactly that reason; both read as "no correction applied" today, and only
      // one of them can still be told apart later.
      //
      // NEVER FOR A CLIP, whatever the wire says. The camera can only bake a rotation into pixels
      // it drew itself, and it draws only stills — a clip is whatever MediaRecorder handed over.
      // So a video arriving with captureRotation set is a client claiming work it cannot have done,
      // and believing it would take the "shot sideways" badge off a clip that is still on its side.
      // The turn below is what a clip carries instead, and the correction that follows is what
      // eventually writes this column for one.
      captureRotation: isVideo ? null : readQuarter(rotationRaw),
      // What was MEASURED, as against what was applied — and for a clip, the work outstanding.
      // Same wire, same untrusted client, its own validator: readTurn keeps 0 (the phone was square
      // with the page, which is a real answer and the common one) where readQuarter above throws it
      // away. See readTurn for why the two cannot be the same function.
      captureTurn: turn,
      captureShape: shape,
    });
    return row;
  });
  if (!claim) {
    try { fs.unlinkSync(finalPath); } catch { /* */ }
    const e = new Error('No shots remaining') as Error & { status?: number };
    e.status = 403; throw e;
  }
  // Face matching, if the host enabled it and anyone has enrolled. Deliberately not awaited:
  // it runs against the thumbnail after this response, and a slow or dead ML container must
  // never hold up a guest's upload.
  void matchNewPhoto(p.eventId, photoId, storedName);
  // Finish the shape the camera would not give us. Not awaited, for the same reason as the face
  // match: the clip is safely stored by this line, and a guest holding a phone at a party must not
  // wait on ffmpeg. Until it lands, the gallery serves the original — which is the right answer
  // whether the crop is still running, or failed, or was never needed.
  if (isVideo) {
    if (shape && shape !== 'full') {
      derivations.push(whileDeriving(finalPath, () => cropClipToShape(finalPath, shape)
        // The poster is cut from the original, so it shows the uncropped frame. Re-cut it from the
        // cropped file so the grid thumbnail matches the clip it opens.
        .then((ok) => { if (ok) return makeVideoPoster(path.join(destDir, cropName(baseName))); })
        .catch(() => { /* the original still plays */ })));
    }
    // ── The turn the phone was given, applied to the clip ─────────────────────────────────────
    //
    // A PHOTO NEVER GETS HERE, and that is the whole reason captureTurn and captureRotation are two
    // columns. The camera draws stills to a canvas and rotates the canvas before it encodes, so a
    // photo's pixels are already upright and its captureRotation says by how much; turning one here
    // would be a second rotation nobody asked for. A clip cannot be given that treatment — putting
    // a canvas between the camera and MediaRecorder means a second encoder on a phone already
    // struggling with the first — so it arrives turned, and this is where that is put right.
    //
    // LAST, AFTER EVERY OTHER DERIVATION, which is what `derivations` above is collected for. The
    // crop, its poster and the playback proxy are all cut from the original, and each carries a
    // display matrix of its own; a rotated original beside an unrotated playback copy is worse than
    // leaving the lot alone, because the gallery would then play one orientation and download the
    // other. Waiting also means the siblings exist to be turned rather than being built moments
    // later from a file that has moved under them.
    //
    // (`_dl.mp4` is the one that does not appear in `derivations`: cropClipToShape starts it
    // unawaited and it outlives the promise collected here. It is correct either way, and only
    // because ffmpeg work is serialised through one slot — run first, it is a sibling on disk and
    // is turned with the rest; run after, it is re-encoded FROM the corrected original and comes
    // out upright on its own. There is no interleaving where it is read half-turned.)
    //
    // Registered with whileDeriving at this line, synchronously, rather than inside the promise:
    // the register must never fall to zero between the copies finishing and this starting, or
    // POST /:id/rotate would see a clip that looks settled and rename a base this is about to
    // rewrite — the exact race that route's 409 exists to prevent.
    //
    // NOT AWAITED, AND ITS FAILURE IS NOT THE UPLOAD'S. The guest was answered long before this
    // runs; a clip that cannot be turned is a clip the right way round in every respect except
    // which way up, and losing it to a cosmetic correction would be far the worse outcome. When it
    // fails, capture_rotation stays NULL against a non-zero capture_turn — which is exactly the
    // state the "shot sideways" badge exists to show, so the clip surfaces in the host's review
    // screen and the rotate button finishes the job by hand.
    if (turn) {
      void whileDeriving(finalPath, () => Promise.allSettled(derivations)
        .then(() => turnClipUpright(photoId, storedName, turn, dims)))
        .catch((e) => console.warn(`[video] capture turn failed for ${storedName}:`, (e as Error).message));
    }
  }
  // Every photo is STORED 'pending' on purpose: visibility is decided at read time against the
  // event's current setting, which is what lets a host switch moderation on later and have the
  // shots already taken go through it. That is a feature, and the column must keep working that way.
  //
  // What must NOT leak out of that is the word "pending" when moderation is off. It said
  // pendingModeration: true on an event with no moderation at all, so a guest was told their photo
  // was waiting for approval while it was already in the gallery. Report the event's answer, not
  // the column's.
  return {
    success: true, photoId, status,
    pendingModeration: !!p.moderationEnabled && status === 'pending',
    // Straight off the row the claim above returned, through the one allowance helper, so the
    // number the guest is shown is the number the database holds — not a local arithmetic guess
    // that a second upload in flight has already made wrong.
    photosRemaining: remainingFor({ maxPhotos: claim.maxPhotos, extraPhotos: claim.extraPhotos, photosTaken: claim.photosTaken }),
  };
}

/** Put an uploaded clip the right way up, in place, once its derived copies are finished.
 *
 *  ONLY EVER CALLED FOR A VIDEO, and only with a non-zero measured turn — finalizeUpload decides
 *  both. See the note where it is scheduled for why a photo must never reach this.
 *
 *  A REMUX, NOT A ROTATION. rotateClipTo writes a display matrix with `-c copy` and does not decode
 *  a frame (images.ts has the direction, measured against real files, and the reason the matrix is
 *  probed and REPLACED rather than added). That is a header value and a stream copy: seconds, no
 *  generation of loss, and the same trick fixAudioLead uses.
 *
 *  IN PLACE, UNDER THE SAME NAMES — which is the opposite of what POST /:id/rotate does, so it is
 *  worth saying why the two differ. That route renames because /uploads is served immutable for a
 *  year: it corrects a photo that has been in a gallery for hours or days, and every browser and
 *  every edge cache already holding the old bytes would keep them. This runs in the minutes after
 *  the upload, inside the same window in which fixAudioLead already rewrites the original under its
 *  own name for exactly the same reason — the file is still settling, and a rename here would mean
 *  a second copy of that route's guarded-move-and-paired-delete protocol, which is a thing this
 *  module has already been bitten by owning twice (see derivedNames). If bytes do escape to a cache
 *  before this lands, the rotate button remains the way to fix that one photo, renaming as it goes.
 *
 *  ALL OR NOTHING. Every file is turned into a temporary beside itself and NOTHING is moved into
 *  place until all of them are done. A half-applied turn — a corrected original next to an
 *  untouched playback proxy — plays one way up and downloads the other, which is worse than the
 *  sideways clip we started with and is not a state anything downstream can detect or repair.
 *
 *  Resolves either way; the caller treats failure as "leave it to the badge and the button". */
async function turnClipUpright(photoId: string, rel: string, turn: number,
                               dims: { width?: number; height?: number }): Promise<void> {
  // The original and every clip the pipeline derives from it — the crop the guest chose, the
  // playback proxy, the proxy of the crop, and the full-resolution download copy. derivedNames is
  // the ONE list (see images.ts): a copy missing from it is a copy left sideways, and the failure
  // is silent. The thumbnails in that list are re-cut below rather than turned, because a poster is
  // a fresh ffmpeg still and ffmpeg honours the matrix when it cuts one.
  // EXCLUDE the stills, rather than allow-list the video containers.
  //
  // This was an allow-list of mp4/m4v/mov, written to skip the .webp posters that derivedNames()
  // also returns. It did that — and it also dropped the ORIGINAL whenever the original was .webm,
  // which is what MediaRecorder produces wherever there is no MP4 encoder: Firefox on Android,
  // Samsung Internet, older Chrome.
  //
  // The consequence was the exact state this function's contract says must never exist. The derived
  // _play.mp4 is built for a webm unconditionally, so the list was never empty and the "nothing to
  // do" escape never fired: playback came out upright, the original stayed sideways, the poster was
  // re-cut from the untouched original, and capture_rotation was recorded as done — which switches
  // the "shot sideways" badge OFF. Half-corrected, undetectable, and with the one signal that would
  // have surfaced it deliberately silenced. Downloads handed back the sideways file for ever.
  //
  // Inverted, any container we can store is turned and only the stills are skipped. WebM does carry
  // a display matrix — measured, not assumed — so there was never a reason to leave it out.
  const names = [rel, ...derivedNames(rel)].filter((n) => !/\.(webp|jpe?g|png|gif)$/i.test(n));
  const staged: { tmp: string; final: string }[] = [];
  const scrap = () => {
    for (const s of staged) { try { fs.unlinkSync(uploadDiskPath(s.tmp)); } catch { /* */ } }
  };

  for (const name of names) {
    // Most of these will not exist. A clip with no chosen shape has no crop and no download copy,
    // and one that was already H.264 and in step needs no proxy — absent is the normal case, not a
    // fault, exactly as it is for the rotate route and the delete route.
    try { fs.accessSync(uploadDiskPath(name)); } catch { continue; }
    const tmp = `${name}.turn${path.extname(name)}`;
    if (!await rotateClipTo(uploadDiskPath(name), uploadDiskPath(tmp), turn)) { scrap(); return; }
    staged.push({ tmp, final: name });
  }
  // The original itself has gone — the guest deleted the clip while we were queued behind ffmpeg.
  // Nothing to correct and nothing to record.
  if (!staged.length) return;

  // Only now, and same-directory so each is atomic. Everything above this line can still walk away
  // leaving the upload exactly as it was.
  try { for (const s of staged) fs.renameSync(uploadDiskPath(s.tmp), uploadDiskPath(s.final)); }
  catch { scrap(); return; }

  // Posters are cut with ffmpeg, which auto-rotates, so re-cutting is all it takes for the grid
  // thumbnail to match the clip it opens. The original's, and the crop's when there is one — the
  // gallery picks between them (photoRow's thumbUrl).
  await makeVideoPoster(uploadDiskPath(rel)).catch(() => false);
  const crop = cropName(rel);
  try {
    fs.accessSync(uploadDiskPath(crop));
    await makeVideoPoster(uploadDiskPath(crop)).catch(() => false);
  } catch { /* no crop to poster */ }

  // WHAT IS NOW BAKED IN, so nothing does it twice. capture_rotation is the record of work done on
  // the pixels whoever did it, and from here that includes us: the badge reads it, and the rotate
  // button accumulates on top of it, so a host straightening this clip further gets the total and
  // not a fresh start.
  //
  // The stored width/height are the CODED dimensions off ffprobe, which a metadata turn does not
  // change — but the gallery lays out with the DISPLAYED shape, and that is what just turned. So
  // the pair swaps for a quarter and is left alone for a half, exactly as the rotate route does it.
  const swap = turn % 180 !== 0 && typeof dims.width === 'number' && typeof dims.height === 'number';
  // The WHERE carries the name we started from, which is the same guard the rotate route uses: a
  // row that has been deleted, or moved out from under us, must not have a correction written back
  // onto whatever now lives at that id.
  const [moved] = await db.update(photos)
    .set({ captureRotation: turn, ...(swap ? { width: dims.height, height: dims.width } : {}) })
    .where(and(eq(photos.id, photoId), eq(photos.filename, rel)))
    .returning({ id: photos.id });
  if (moved) console.log(`[video] turned ${path.basename(rel)} ${turn}\u00b0 clockwise (${staged.length} file(s))`);
}
// ── POST /api/photos — single-shot upload (photos + videos under the chunk threshold) ──────────

// ── DELETE /api/photos/:id — a guest takes back their own shot, inside the window ─────────────
// Distinct statuses on purpose: the client shows a different thing for "not yours" than for
// "too late", and a single 403 for both would make the countdown UI impossible to get right.
// Does a phone-decodable copy exist yet? Only ever called for video rows (the caller
// short-circuits on mediaType), and a gallery holds few of those, so one stat each is cheaper than
// carrying a column that can fall out of step with the filesystem.

router.delete('/:id', async (req: Request, res: Response) => {
  const sessionToken = String(req.body?.sessionToken || req.query?.sessionToken || '');
  if (!sessionToken) return res.status(400).json({ error: 'sessionToken required' });

  const [me] = await db
    .select({ id: participants.id, eventId: participants.eventId, photosTaken: participants.photosTaken,
              isLocked: events.isLocked, expiresAt: events.expiresAt, maxPhotos: events.maxPhotos,
              extraPhotos: participants.extraPhotos,
              // For the mission progress this delete may have just changed (see below).
              challengeSet: participants.challengeSet, eventChallenges: events.challenges })
    .from(participants)
    .innerJoin(events, eq(events.id, participants.eventId))
    .where(eq(participants.sessionToken, sessionToken));
  if (!me) return res.status(403).json({ error: 'Invalid session' });

  const [photo] = await db
    .select({ id: photos.id, participantId: photos.participantId, filename: photos.filename, takenAt: photos.takenAt })
    .from(photos).where(eq(photos.id, String(req.params.id)));
  // Same answer for "does not exist" and "belongs to another guest": whether a given photo id
  // exists in someone else's roll is not this guest's business.
  if (!photo || photo.participantId !== me.id) return res.status(404).json({ error: 'Photo not found' });

  if (me.isLocked) return res.status(423).json({ error: 'The host has locked this event' });
  if (Date.now() > Number(me.expiresAt)) return res.status(410).json({ error: 'This event has ended' });
  if (Date.now() - Number(photo.takenAt) > DELETE_WINDOW_MS + DELETE_CONFIRM_GRACE_MS) {
    return res.status(410).json({ error: 'Too late to delete this one — it is part of the roll now' });
  }

  // Inside the window nobody has meaningfully seen it, so remove it outright rather than leaving a
  // rejected row for the host to wonder about.
  // Same rule as the upload path, pointing the other way: the row going away and the frame coming
  // back are one decision, so they are one transaction, and the subtraction belongs to Postgres.
  // `set({ photosTaken: me.photosTaken - 1 })` over a read-back value meant two deletes racing each
  // other both read 5 and both wrote 4 — the guest paid for a frame they never used. GREATEST(…, 0)
  // keeps a counter that has drifted from ever going negative and handing out a free roll.
  //
  // The DELETE returns rows, and the decrement only happens when it actually removed one: a
  // double-tapped delete (two requests, one photo) must not give the frame back twice.
  const gaveBack = await db.transaction(async (tx) => {
    // RETURNING the filename, not just the id, and the rest of this route uses THAT name rather
    // than the one read a few lines above. The two can differ: POST /:id/rotate writes the
    // corrected photo under a fresh uuid and moves the row onto it, so a rotation committing
    // between our read and this DELETE would leave us unlinking the pre-rotation names — already
    // gone — and leaving the rotated file behind as an orphan nothing references, until the
    // event's purge eventually collects it. The row the DELETE actually removed is the only
    // authority on what is on the disk.
    const [gone] = await tx.delete(photos).where(eq(photos.id, photo.id)).returning({ id: photos.id, filename: photos.filename });
    if (!gone) return null;
    const [row] = await tx.update(participants)
      .set({ photosTaken: sql`greatest(${participants.photosTaken} - 1, 0)` })
      .where(eq(participants.id, me.id))
      .returning({ photosTaken: participants.photosTaken, extraPhotos: participants.extraPhotos });
    return row ? { ...row, filename: gone.filename } : null;
  });
  // Another request got there first. Same answer as "never existed" — see above.
  if (!gaveBack) return res.status(404).json({ error: 'Photo not found' });
  // The original plus every copy made from it. The list used to be written out here; it now lives
  // in images.ts beside the functions that name those copies, because the rotate route has to
  // account for exactly the same set and two hand-kept lists is how one of them ends up short.
  for (const f of [gaveBack.filename, ...derivedNames(gaveBack.filename)]) {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch { /* already gone is fine */ }
  }

  // Mission progress is DERIVED from the photos table, so this delete may have just un-ticked a
  // trick — and the client cannot work that out for itself: the gallery payload carries the
  // mission's TEXT (`challenge`), not its id. Re-derive it here, after the row is gone, and hand
  // back the authoritative list so the camera's trick list cannot sit on a tick the server has
  // already dropped. Costs one small query on an action a guest takes at most a handful of times.
  const { challengesDone } = await missionsFor(me.eventChallenges, me.challengeSet, me.id);

  // Wired even though this route is GUEST-only — it needs a session token, and the host surfaces
  // reject rather than delete. It costs a signed-out guest nothing (no session cookie, so
  // admin-actions.ts resolves nobody without a query), and it covers the one way an operator can
  // reach it: joining a customer's event as a guest and then removing a shot from inside it.
  await recordAdminAction(req, {
    event: me.eventId, action: 'photo.delete', targetType: 'photo', targetId: photo.id,
    before: { filename: gaveBack.filename, participantId: photo.participantId, takenAt: photo.takenAt },
    after: null,
  });

  res.json({ success: true, photosRemaining: remainingFor({ ...me, extraPhotos: gaveBack.extraPhotos, photosTaken: gaveBack.photosTaken }), challengesDone });
});

// ── PUT /api/photos/:id/caption — write, edit or clear the words under a photo ─────────────────
// Captions are the one piece of a photo that is TEXT, so they get a tighter hand than a rating:
// a guest may caption their OWN shots, and the event's organizer may caption anything in their
// event (they already curate the album, and they are the one who has to answer for what a shared
// gallery says). Nobody else, including another guest at the same event.
//
// Length is a hard cap rather than a rejection: a caption is one line typed on a phone at a party,
// and bouncing someone's sentence back at them because it ran four characters long is a worse
// product than keeping the first 140. Blank clears.

// Normalise what a phone keyboard produces into what a gallery can render on one line: collapse
// every run of whitespace (newlines included — a caption is not a paragraph), trim, then cut.
// Returns null for "no caption", which is also what an empty or whitespace-only submission means:
// clearing is the same action as saving nothing, so the UI needs no separate delete call.
export function normalizeCaption(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // A raw ceiling first, so a contrived payload cannot make us segment megabytes of text. This is
  // not the limit anyone writing a sentence will meet — see CAPTION_MAX_RAW.
  const collapsed = raw.slice(0, CAPTION_MAX_RAW).replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  // Cut by GRAPHEME, not by code unit. Slicing UTF-16 at 140 both disagreed with the count the
  // writer was shown and could land inside an emoji, leaving a lone surrogate on the card.
  // trimEnd after the cut so a caption sliced mid-space does not keep a dangling one; it cannot
  // empty the string, because `collapsed` starts with a non-space character.
  return clampCaption(collapsed).trimEnd();
}

router.put('/:id/caption', async (req: Request, res: Response) => {
  const photoId = String(req.params.id);
  const sessionToken = String(req.body?.sessionToken || '');
  // Header first, body as the fallback — same shape the rest of the organizer surface uses, and it
  // keeps the long-lived secret out of access logs when the client can send a header.
  const organizerCode = String(req.get('x-organizer-code') || req.body?.organizerCode || '');

  const [photo] = await db
    // `caption` is selected for the audit log and nothing else — an entry saying a caption changed,
    // without saying what it said, is not something anybody can act on. Same row, no extra query.
    .select({ id: photos.id, eventId: photos.eventId, participantId: photos.participantId,
              caption: photos.caption })
    .from(photos).where(eq(photos.id, photoId));
  // 404, never 401/403, for anything the caller is not entitled to touch — including a photo that
  // simply does not exist. Same reasoning as DELETE /:id above: whether a given photo id exists,
  // and whose roll it is in, is not a stranger's business, and a 403 would answer that for them.
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  const caption = normalizeCaption(req.body?.caption);

  // The guest who took it.
  if (sessionToken) {
    const [me] = await db.select({ id: participants.id }).from(participants)
      .where(and(eq(participants.sessionToken, sessionToken), eq(participants.eventId, photo.eventId)));
    if (me && me.id === photo.participantId) {
      await db.update(photos).set({ caption }).where(eq(photos.id, photo.id));
      // Echo what was STORED, not what was sent: the client must show the trimmed, collapsed,
      // capped text the gallery will show, or the guest sees their caption change on next load.
      return res.json({ success: true, id: photo.id, caption });
    }
  }

  // The organizer of the event this photo belongs to. Resolved from the PHOTO's event, so an
  // organizer code for some other event is just a stranger here.
  //
  // NOTE: this is the organizer-CODE capability only, not the owner-by-identity / co-host paths in
  // requireOrganizer — that middleware resolves its event from a :joinCode route param and there
  // isn't one on a photo-id route. The host's Review screen always holds the code, so this covers
  // the real surface; a co-host who reached Review without a code cannot caption.
  if (organizerCode) {
    const [event] = await db.select({ organizerCode: events.organizerCode }).from(events)
      .where(eq(events.id, photo.eventId));
    if (event && organizerCode === event.organizerCode) {
      await db.update(photos).set({ caption }).where(eq(photos.id, photo.id));
      await recordAdminAction(req, {
        event: photo.eventId, action: 'photo.caption', targetType: 'photo', targetId: photo.id,
        before: { caption: photo.caption }, after: { caption },
      });
      return res.json({ success: true, id: photo.id, caption });
    }
  }

  return res.status(404).json({ error: 'Photo not found' });
});

// ── POST /api/photos/:id/rotate — put a sideways shot the right way up ────────────────────────
//
// THE FAULT THIS ANSWERS. The camera draws to a square canvas and posts the pixels, so a stored
// photo has no EXIF at all — no orientation tag, nothing a viewer could honour. With the phone's
// rotation lock on, turning it sideways moves nothing: the page stays portrait, the camera track
// stays portrait, and the scene is written into the file lying on its side. capture_orientation
// (0042) is the only witness to that, and it says 'landscape' without saying WHICH WAY, so there
// is nothing to correct automatically. Thirteen production photos are in exactly that state.
//
// WHICH IS WHY THIS IS A BUTTON. The information needed to fix one of these does not exist in the
// file, in the database, or in anything we could compute; it exists in the memory of whoever was
// standing there. So we ask them, and record what they said (capture_rotation), which is what
// stops the "shot sideways" mark pointing at photos already dealt with — see shotSideways().
//
// THE FILE IS RENAMED, AND THAT IS THE WHOLE CACHING STRATEGY. /uploads is served
// `immutable, max-age=365d` (index.ts) on the promise that a uuid filename addresses one set of
// bytes for ever. Everything downstream has taken that promise: browsers will not even revalidate
// an immutable response, and Cloudflare is caching these at the edge. So rewriting the bytes under
// the same name fixes the photo for precisely nobody except someone with an empty cache — the host
// would press rotate, see nothing change, and press it again. A `?v=2` query would beat the
// browser, but it would have to be appended by EVERY place that builds a media URL (the gallery,
// the share payload in routes/shares.ts, the host's review feed in routes/events.ts), and the one
// that got missed would go on serving the stale bytes for a year with nothing to show for it.
// A new name needs none of that: `photos.filename` is the single place the name lives, every
// derived name is computed from it (thumbName/cropName/playName/dlName), and every consumer reads
// the column at request time. Checked before choosing it — shares, the face matcher (photo_faces
// keys on photo_id, never a path), the event and share zips, the host feed and the purge sweeps
// all resolve the name from the row, so none of them needs to know this happened. The old name
// stops existing, so anything that did somehow hold one fails visibly rather than quietly serving
// the wrong picture.
//
// WHO MAY DO IT. The guest who took the shot, or the event's organizer — the same two, resolved
// the same way, as the caption route above. Rotating is the same class of act: a correction to an
// existing photo, not a claim on anybody's roll.

/** The turn, as an untrusted field. Degrees CLOCKWISE, and only the three that are a turn: a
 *  quarter each way and a half.
 *
 *  270 is deliberately NOT quietly folded into -90. The wire contract is a named turn chosen by a
 *  person pressing a button, and a client sending 270 has a bug worth seeing rather than a value
 *  worth guessing at. 0 is refused for the same reason — it is not a rotation, and honouring it
 *  would rewrite the file, change its name and invalidate every cached copy to achieve nothing. */
export function readQuarter(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  return n === 90 || n === -90 || n === 180 ? n : null;
}

/** May this caller turn this photo? Pure, so the rule is a thing a test can fail on rather than
 *  something a reviewer has to spot inside a handler.
 *
 *  `organizerCodeMatches` is the organizer-CODE capability only — the same limitation the caption
 *  route documents: requireOrganizer resolves its event from a `:joinCode` param and there is no
 *  such param on a photo-id route, so the owner-by-identity and co-host paths are not available
 *  here. The host's Review screen always holds the code, which is the surface that matters.
 *
 *  A guest at the same event who did not take the shot is a stranger to it, and gets exactly what a
 *  stranger gets. */
export function mayRotate(a: { photoOwnerId: string; askerParticipantId: string | null; organizerCodeMatches: boolean }): boolean {
  if (a.organizerCodeMatches) return true;
  return a.askerParticipantId !== null && a.askerParticipantId === a.photoOwnerId;
}

router.post('/:id/rotate', async (req: Request, res: Response) => {
  const photoId = String(req.params.id);
  const sessionToken = String(req.body?.sessionToken || '');
  // Header first, body as the fallback — the same shape as the caption route, and it keeps the
  // long-lived secret out of access logs whenever the client can send a header.
  const organizerCode = String(req.get('x-organizer-code') || req.body?.organizerCode || '');

  const [photo] = await db
    .select({ id: photos.id, eventId: photos.eventId, participantId: photos.participantId,
              filename: photos.filename, mediaType: photos.mediaType,
              width: photos.width, height: photos.height,
              captureOrientation: photos.captureOrientation, captureRotation: photos.captureRotation,
              captureTurn: photos.captureTurn,
              captureShape: photos.captureShape })
    .from(photos).where(eq(photos.id, photoId));
  // 404, never 401/403, for anything the caller is not entitled to touch — including a photo that
  // simply does not exist. Same reasoning as DELETE and the caption route: whether a given photo id
  // exists, and whose roll it is in, is not a stranger's business.
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  const [me] = sessionToken
    ? await db.select({ id: participants.id }).from(participants)
        .where(and(eq(participants.sessionToken, sessionToken), eq(participants.eventId, photo.eventId)))
    : [];
  // Resolved from the PHOTO's event, so an organizer code for some other event is just a stranger.
  const [event] = organizerCode
    ? await db.select({ organizerCode: events.organizerCode }).from(events).where(eq(events.id, photo.eventId))
    : [];
  if (!mayRotate({ photoOwnerId: photo.participantId, askerParticipantId: me?.id ?? null,
                   organizerCodeMatches: !!event && !!organizerCode && organizerCode === event.organizerCode })) {
    return res.status(404).json({ error: 'Photo not found' });
  }

  // Validated AFTER the authorisation, deliberately: a 400 is then only ever reachable by somebody
  // entitled to be here, so the two statuses cannot be used to tell an existing photo from an
  // absent one.
  const quarter = readQuarter(req.body?.quarter);
  if (quarter === null) return res.status(400).json({ error: 'quarter must be 90, -90 or 180' });

  const oldRel = photo.filename;
  const isVideo = photo.mediaType === 'video';

  // ONE ANSWER FOR "THIS PHOTO IS NOT YOURS TO MOVE RIGHT NOW". Written once because it is given
  // from three places — the guarded UPDATE at the bottom, and the two ways the source can vanish
  // under us before we ever get there.
  const CONFLICT = 'That photo was being changed by someone else — try again';
  /** Has the file we read off the row gone while we were working on it? Another rotation
   *  committing first unlinks it (see the bottom of this handler), and so does a guest's delete.
   *  Asked of the DISK rather than inferred from the failure, because the two things that fail here
   *  fail differently — sharp throws, rotateClipTo returns false — and neither reliably carries an
   *  ENOENT for a caller to match on. */
  const sourceGone = () => { try { fs.accessSync(uploadDiskPath(oldRel)); return false; } catch { return true; } };

  // A CLIP WHOSE COPIES ARE STILL BEING BUILT IS NOT READY TO BE RENAMED.
  //
  // finalizeUpload answers the guest and THEN builds the crop, its poster, the playback proxy and
  // the full-resolution `_dl` re-encode — none of it awaited, all of it queued behind one global
  // video slot, so the window is minutes rather than seconds. A rotation inside that window turns
  // whichever siblings happen to exist at that instant, moves the row to the new base and clears
  // the old one; the job then finishes and writes `<oldbase>_crop.mp4` under a name nothing
  // references, while the base the row now carries has no crop and no download copy and nothing
  // that will ever build them. The guest's chosen shape reverts to full frame permanently, and no
  // error is raised anywhere.
  //
  // REFUSING IS THE WHOLE FIX, and it is deliberately the dumbest of the three ways out. Rebuilding
  // the missing copies afterwards means starting the same expensive pipeline again while the first
  // one is still in it, racing it for the same video slot and for the same output names. Making the
  // request WAIT means holding a connection open for however long an ffmpeg queue is. Refusing
  // costs one retry of a button that a host presses seconds apart anyway, it cannot lose a file,
  // and it needs no marker of its own beyond the one the upload path already sets.
  //
  // 409 and not 423: this is temporary and retrying is the correct response, which is exactly what
  // the client does with the conflict the guarded UPDATE returns.
  if (isDeriving(uploadDiskPath(oldRel))) {
    return res.status(409).json({ error: 'That clip is still being prepared — give it a moment and try again' });
  }
  // Same folder, same extension, new uuid. `uploadDiskPath` rather than a bare join for every
  // filesystem call below, because it is the one helper that resolves and re-checks containment —
  // these names come from our own column, but a path helper that is only correct for trusted input
  // is a trap for whoever adds the next caller.
  const dir = path.posix.dirname(oldRel);
  const newBase = `${uuidv4()}${path.extname(oldRel)}`;
  const newRel = dir === '.' ? newBase : `${dir}/${newBase}`;
  const written: string[] = [];
  const binWritten = () => { for (const f of written) { try { fs.unlinkSync(uploadDiskPath(f)); } catch { /* */ } } };

  let width = photo.width, height = photo.height;
  try {
    if (!isVideo) {
      const dims = await rotateImageTo(uploadDiskPath(oldRel), uploadDiskPath(newRel), quarter);
      written.push(newRel);
      await makeThumbnail(uploadDiskPath(newRel));
      written.push(thumbName(newRel));
      // sharp read the result back, so these are measured rather than swapped arithmetically.
      width = dims.width ?? null;
      height = dims.height ?? null;
    } else {
      // Metadata only, `-c copy`, not one frame decoded — see rotateClipTo. A re-encode would cost
      // minutes in the single video slot and hand the guest back a visibly worse copy of their own
      // clip, to fix something that is a header value.
      if (!await rotateClipTo(uploadDiskPath(oldRel), uploadDiskPath(newRel), quarter)) {
        if (sourceGone()) return res.status(409).json({ error: CONFLICT });
        return res.status(500).json({ error: 'That clip could not be rotated' });
      }
      written.push(newRel);
      // The crop/proxy/download copies each carry their OWN display matrix, so each is turned by
      // the same quarter into the matching name under the new base. The two lists are the same
      // transforms in the same order by construction (derivedNames), which is why they pair by
      // index.
      //
      // ALL OR NOTHING. This was best-effort — "a sibling that fails to rotate is simply not
      // published, and the ladder in playFile/downloadFile falls back to the original" — which
      // reads perfectly well until you follow it to the bottom of this handler, where the OLD names
      // are deleted whether or not anything replaced them. A crop that failed to turn was deleted
      // and never rebuilt, so the shape the guest chose was gone for good and the clip quietly went
      // back to full frame. There is no ladder back from that. Giving up here instead costs the
      // host a retry and leaves every file exactly as it was.
      const from = derivedNames(oldRel), to = derivedNames(newRel);
      for (let i = 0; i < from.length; i++) {
        if (!/\.(mp4|m4v|mov)$/i.test(from[i])) continue;      // the thumbs are re-cut below, not moved
        try { fs.accessSync(uploadDiskPath(from[i])); } catch { continue; }
        if (await rotateClipTo(uploadDiskPath(from[i]), uploadDiskPath(to[i]), quarter)) { written.push(to[i]); continue; }
        binWritten();
        if (sourceGone()) return res.status(409).json({ error: CONFLICT });
        return res.status(500).json({ error: 'That clip could not be rotated' });
      }
      // Posters are cut with ffmpeg, which auto-rotates, so re-cutting them is all it takes for the
      // grid to match the clip it opens. Both the original's and (when there is one) the crop's —
      // the gallery picks between them, see photoRow's thumbUrl.
      await makeVideoPoster(uploadDiskPath(newRel)).catch(() => false);
      written.push(thumbName(newRel));
      const newCrop = cropName(newRel);
      try {
        fs.accessSync(uploadDiskPath(newCrop));
        await makeVideoPoster(uploadDiskPath(newCrop)).catch(() => false);
        written.push(thumbName(newCrop));
      } catch { /* no crop to poster */ }
      // A clip's stored width/height are the CODED dimensions off ffprobe, which a metadata
      // rotation does not change — but what the gallery lays out with is the DISPLAYED shape, and
      // that is what just turned. So the pair is swapped for a quarter turn and left alone for a
      // half, exactly as it is for a still.
      if (quarter % 180 !== 0) { width = photo.height; height = photo.width; }
    }
  } catch (e) {
    binWritten();
    // Two rotations racing. The winner unlinked our source between the row read at the top of this
    // handler and sharp opening it, so sharp throws "Input file is missing" and the express error
    // handler would report a 500 — an internal fault, for something that is only a conflict, and
    // the very conflict the guarded UPDATE below was written to answer with a 409. Same answer,
    // reached earlier; the loser's own output is already binned above.
    if (sourceGone()) return res.status(409).json({ error: CONFLICT });
    throw e;
  }

  // Degrees clockwise now baked in, folded back into (-180, 180]: 90 then 90 is 180, 180 then 180
  // is 0 (and 0 badges again, because the photo really is sideways again).
  const total = normalizeTurn((photo.captureRotation ?? 0) + quarter);

  // The WHERE carries the filename we started from, so two rotates racing each other cannot both
  // claim the same source: the second one finds the row already moved, throws its own output away
  // and says so. Without it the loser would overwrite the winner's row with a name derived from a
  // file that no longer exists, and the photo would 404 for everybody.
  const [moved] = await db.update(photos)
    .set({ filename: newRel, width, height, captureRotation: total })
    .where(and(eq(photos.id, photo.id), eq(photos.filename, oldRel)))
    .returning({ id: photos.id });
  if (!moved) {
    binWritten();
    return res.status(409).json({ error: CONFLICT });
  }

  // Only now: the row no longer points here, so nothing can be reading these. Best-effort, as
  // everywhere else — a file already gone is a fine outcome, and a file that will not unlink is an
  // orphan the event's purge collects (it removes the whole event folder) rather than a reason to
  // fail a correction that has succeeded.
  //
  // PAIRED, NOT LISTED: each old name goes only once the file that REPLACED it is on the disk. The
  // two lists are the same pure transform over two bases, so index i under the old base is index i
  // under the new one — pinned in photo-rotate.test.ts, because that is the property this loop
  // rests on. The unpaired delete this replaces is how a single failed sibling became permanent
  // data loss: it removed the old `_crop.mp4` whether or not a new one existed, and nothing in the
  // product ever rebuilds one. Litter is recoverable; the only copy of a file is not.
  const olds = [oldRel, ...derivedNames(oldRel)];
  const news = [newRel, ...derivedNames(newRel)];
  for (let i = 0; i < olds.length; i++) {
    try { fs.accessSync(uploadDiskPath(news[i])); } catch { continue; }   // nothing replaced it — keep it
    try { fs.unlinkSync(uploadDiskPath(olds[i])); } catch { /* already gone is fine */ }
  }

  // The filename travels with the quarter, and it has to. A rotation REPLACES the file under a
  // fresh uuid and the loop above has just unlinked the old one, so the name the row used to carry
  // now exists nowhere else at all — an audit entry recording only "turned 90°" would be describing
  // a file nobody can name. Written after the cleanup rather than before it because only here is
  // the action actually finished: everything above this line can still answer 409 and leave the
  // photo exactly as it was.
  //
  // `photo.eventId` rather than an event row: this route is addressed by photo id and never loads
  // one, and admin-actions.ts fetches it only on the rare request that turns out to be loggable.
  await recordAdminAction(req, {
    event: photo.eventId, action: 'photo.rotate', targetType: 'photo', targetId: photo.id,
    before: { filename: oldRel, captureRotation: photo.captureRotation, width: photo.width, height: photo.height },
    after:  { filename: newRel, captureRotation: total, width, height },
  });

  // Everything the client needs to show the corrected photo without a refetch — and the new URLs
  // ARE the cache-bust, which is the point of the rename.
  //
  // The url/playUrl ladder reads the directory through the 2s listing cache in `onDisk`, which was
  // populated before these files existed, so for a moment after a video rotation it can answer with
  // the original rather than the crop. That is the documented fallback ("until it lands, serve the
  // original"), it is correct to play, and it settles by itself on the next poll.
  const after = { ...photo, filename: newRel, width, height, captureRotation: total };
  res.json({
    success: true,
    id: photo.id,
    url: `/uploads/${downloadFile(after)}`,
    thumbUrl: `/uploads/${thumbName(cropped(after) ?? newRel)}`,
    ...(playFile(after) ? { playUrl: `/uploads/${playFile(after)}` } : {}),
    width: width ?? undefined,
    height: height ?? undefined,
    captureRotation: total,
    // Sent as a real boolean here, unlike the gallery row, because this reply exists to UPDATE a
    // card that is already on screen: `undefined` would leave a client merging the response unable
    // to tell "no longer sideways" from "no opinion", and the mark would stay up until a reload.
    shotSideways: shotSideways(after),
  });
});

// ── THE VISIBILITY RULE, in one place ─────────────────────────────────────────
//
// Which of an event's photos may this asker see? Two halves: moderation (a rejected shot, or an
// unapproved one where the host is vetting, is not in the gallery) and the reveal (before it, a
// guest sees their own roll and a stranger sees nothing at all).
//
// It lives here rather than inline because a security audit found the hearts endpoint scoping by
// EVENT alone: it never joined photos, so it applied neither half, and a stranger holding only the
// join code could read back the ids of photos hidden from them. No filename or /uploads path
// leaked, and an id is not a capability here (every id-addressable route refuses one you do not
// own) — but a hidden photo should not be handing out its id either. Two endpoints now depend on
// this rule, and two inline copies is how one of them gets fixed and the other does not.
//
// CALLERS MUST KEEP THEIR OWN eventId AS THE LEADING PREDICATE and join `photos` by PRIMARY KEY.
// This clause filters on `photos`; it does not scope to an event. Scoping on `photos.eventId`
// instead forces a full scan of every heart/comment on the server (65ms at 60k hearts, and rising),
// which is exactly what carrying event_id on those tables exists to avoid.
type Visibility = Parameters<typeof isRevealed>[0] & { moderationEnabled: boolean };

function seeablePhotos(event: Visibility, myParticipantId: string | null) {
  const visible = event.moderationEnabled
    ? eq(photos.status, 'approved')
    : ne(photos.status, 'rejected');
  return isRevealed(event)
    ? visible
    : myParticipantId ? and(visible, eq(photos.participantId, myParticipantId)) : sql`false`;
}

/** The same rule for ONE already-loaded row — the write paths, which hold the photo rather than a
 *  query. A photo this says no to must be answered exactly as a stranger is answered (404), or the
 *  endpoint becomes a way to probe for hidden photos. */
// `myParticipantId` is nullable because a gallery-link VISITOR has no roll of their own (0063).
// null is the honest answer for them rather than a sentinel: it can never equal a photo's
// participantId, so the "your own shot" branch below simply does not apply, and pre-reveal they see
// nothing — which is exactly right for somebody who only holds the link.
function canSeePhoto(event: Visibility, photo: { participantId: string; status: string | null },
                     myParticipantId: string | null): boolean {
  // YOUR OWN SHOT IS ALWAYS YOURS — before the reveal, under moderation, and after the host has
  // rejected it. Rejecting takes a photo out of everyone ELSE's gallery; it does not confiscate it
  // from the person who took it, and it is deliberately not announced to them either. This used to
  // sit the other way round, with the visibility test in front of the ownership one, so the owner
  // of a rejected shot was refused their own heart and got "Could not save that" on a photo sitting
  // in their own roll, with nothing to explain it.
  if (myParticipantId !== null && photo.participantId === myParticipantId) return true;
  const visible = event.moderationEnabled ? photo.status === 'approved' : photo.status !== 'rejected';
  return visible && isRevealed(event);
}

// ── GET /api/photos/:joinCode/hearts — every count for the event, and which are mine ────────
//
// Its own endpoint rather than a field on the gallery, for two reasons that point the same way.
// The gallery reply is big and SHARED-CACHEABLE, so it can carry neither live numbers nor per-guest
// state; and counts move constantly at a busy event while the photos themselves do not. Polling
// this costs one indexed group-by and a keyed lookup, against re-sending every photo row.
//
// Queried by EVENT, not by a list of ids: a 400-guest event is 14,000 photos, and an `IN` list of
// 14,000 uuids is a megabyte of query text before the database has done anything.
router.get('/:joinCode/hearts', async (req: Request, res: Response) => {
  const event = await eventByIdentifier(String(req.params.joinCode));
  if (!event) return res.status(404).json({ error: 'Event not found' });
  perViewer(res);                       // carries `mine`; must never be cached across guests
  // Whichever pair governs THIS caller, matching the write path exactly. They disagreed: with hearts
  // off for guests but on for the link, a visitor could heart and then never read it back.
  const asVisitor = !req.get('x-session-token') && !!req.get('x-visitor-token');
  if (!(asVisitor ? event.galleryHeartsEnabled : event.heartsEnabled)) return res.json({ hearts: {}, mine: [] });

  // No join: photo_hearts carries the event itself (0059), so this reads only this event's rows
  // straight off photo_hearts_event_photo_idx. With the join it was a full scan of every heart on
  // the server — 65ms at 60k hearts, and rising.
  // `?ids=` scopes the answer to what is on screen. Without it a 14,000-photo event answers with a
  // count for every photo that has one — correct, and a payload nobody asked for on a poll.
  //
  // Over the cap the ids are IGNORED rather than truncated. Truncating silently returned a zero for
  // every photo past the 500th, which does not read as "too many ids" — it reads as hearts having
  // randomly stopped working on big galleries. Falling back to the whole event is a correct
  // superset, and is exactly what a caller sending no ids already gets, so it costs nothing new.
  const idsParam = typeof req.query.ids === 'string' ? req.query.ids : '';
  const asked = idsParam ? idsParam.split(',').map((x) => x.trim()).filter(Boolean) : [];
  const only = asked.length && asked.length <= 500 ? asked : [];

  // Header (or body) only — never the query string. nginx logs "$request", so a token in a
  // URL is written into the access log, the browser history and every proxy between. The zip
  // route is the ONE justified exception and says so: it is reached by navigating, and a
  // navigation cannot carry a header. Everything here is a fetch.
  const sessionToken = req.get('x-session-token') || '';
  const [me] = sessionToken
    ? await db.select({ id: participants.id }).from(participants)
        .where(and(eq(participants.sessionToken, sessionToken), eq(participants.eventId, event.id)))
    : [];

  // THE VISIBILITY RULE — one implementation, shared with the comments read below. See
  // seeablePhotos() for what it is and for the leak that put it there. `photoHearts.eventId` stays
  // the leading predicate, so this is still an indexed read of ONE event's hearts joined to photos
  // by primary key.
  const seeable = seeablePhotos(event, me?.id ?? null);

  const tally = await db
    .select({ photoId: photoHearts.photoId, n: count() })
    .from(photoHearts)
    .innerJoin(photos, eq(photos.id, photoHearts.photoId))
    .where(and(
      eq(photoHearts.eventId, event.id),
      seeable,
      ...(only.length ? [inArray(photoHearts.photoId, only)] : []),
    ))
    .groupBy(photoHearts.photoId);
  const hearts: Record<string, number> = {};
  for (const r of tally) hearts[r.photoId] = Number(r.n);

  let mine: string[] = [];
  // A gallery-link visitor has their own hearts to report, exactly like a guest. Only asked for
  // when there is no guest session: somebody who has joined reacts as the guest they are.
  const visitor = me ? null : await galleryVisitor(req, event.id);
  if (visitor) {
    const own = await db.select({ photoId: photoHearts.photoId })
      .from(photoHearts)
      .innerJoin(photos, eq(photos.id, photoHearts.photoId))
      .where(and(eq(photoHearts.eventId, event.id), eq(photoHearts.visitorId, visitor.id), seeable));
    mine = own.map((r) => r.photoId);
  } else if (me) {
    // Keyed on photo_hearts_event_participant_idx, and filtered the SAME way as the counts: a photo
    // you hearted and the host has since rejected must drop out of your own list too, or the client
    // keeps drawing a filled heart on something that is no longer in the gallery.
    //
    // Never scoped by `ids`: a guest's own hearts across a whole event are a few dozen rows off a
    // keyed index (0.08ms measured at 60k hearts), so narrowing it would save nothing and would
    // make the client re-ask every time it scrolled.
    const own = await db.select({ photoId: photoHearts.photoId })
      .from(photoHearts)
      .innerJoin(photos, eq(photos.id, photoHearts.photoId))
      .where(and(eq(photoHearts.eventId, event.id), eq(photoHearts.participantId, me.id), seeable));
    mine = own.map((r) => r.photoId);
  }
  res.json({ hearts, mine });
});

// ── Guest comments ───────────────────────────────────────────────────────────
//
// Everything below repeats the shape the hearts endpoints ended up with AFTER a security audit went
// through them, because the mistakes are the same ones and they are cheaper to copy than relearn:
// the visibility rule is applied on every read, per-viewer state never rides a shared-cacheable
// reply, the session token is accepted from a header, and the event's own gates (locked, not yet
// started) are honoured on the write.

/** The rule for what a given caller may see of an event's photos.
 *
 *  Factored out because it is now written in four places and getting it wrong in ONE of them is
 *  precisely how the hearts poll came to hand a stranger the ids of photos hidden from them. */
/** How many photo rows a single gallery response may carry.
 *
 *  The gallery used to answer with EVERY photo in the event: measured at 530 bytes of JSON per
 *  photo, which is ~7.4MB at 14,000 — sent before a single picture has loaded, to every phone in
 *  the room at once. The grid lazy-loads its IMAGES already (`loading="lazy"`); this is the
 *  metadata catching up.
 *
 *  A page, not a page NUMBER: offsets renumber themselves when a photo is uploaded or rejected
 *  mid-scroll, which shows a guest the same shot twice or skips one silently. The cursor is the
 *  last row's own sort key, so it means the same thing no matter what changed behind it. */
const GALLERY_PAGE_MAX = 100;
// 100, measured rather than guessed: a photo row is 547 bytes of JSON raw and ~85 gzipped, so a page
// is ~8.5KB on the wire — a quarter of a second on a bad connection. That covers a desktop screen
// plus the 800px of prefetch runway in ONE round trip, where 50 needs two; and at 14,000 photos it
// is 140 requests rather than 280. Bigger than this buys nothing a scroll can use.

/** `<takenAt>_<id>`, which is exactly the (taken_at DESC, id ASC) order key the gallery is sorted
 *  by. Returns null for anything malformed rather than guessing — a bad cursor reads as "start
 *  from the top", which is the safe answer. */
function keysetAfter(raw: unknown) {
  if (typeof raw !== 'string' || !raw) return null;
  const cut = raw.indexOf('_');
  if (cut < 1) return null;
  const takenAt = Number(raw.slice(0, cut));
  const id = raw.slice(cut + 1);
  if (!Number.isFinite(takenAt) || !id) return null;
  // Strictly PAST that row in the sort order: older, or the same instant with a higher id. The id
  // half is what makes a burst of shots taken in the same millisecond page correctly.
  return or(lt(photos.takenAt, takenAt), and(eq(photos.takenAt, takenAt), gt(photos.id, id)));
}

function pageLimit(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), GALLERY_PAGE_MAX) : GALLERY_PAGE_MAX;
}

function seeableClause(ev: { moderationEnabled: boolean | null } & Parameters<typeof isRevealed>[0],
                       meId: string | null) {
  const visible = ev.moderationEnabled ? eq(photos.status, 'approved') : ne(photos.status, 'rejected');
  if (isRevealed(ev)) return visible;
  // Before the reveal a guest sees their own roll and a stranger sees nothing at all.
  return meId ? and(visible, eq(photos.participantId, meId)) : sql`false`;
}

/** The participant this request is, within THIS event — or null. */
async function participantIn(req: Request, eventId: string) {
  // Header (or body) only — never the query string. nginx logs "$request", so a token in a
  // URL is written into the access log, the browser history and every proxy between. The zip
  // route is the ONE justified exception and says so: it is reached by navigating, and a
  // navigation cannot carry a header. Everything here is a fetch.
  const token = req.get('x-session-token') || String(req.body?.sessionToken || '');
  if (!token) return null;
  const [me] = await db.select({ id: participants.id, name: participants.name }).from(participants)
    .where(and(eq(participants.sessionToken, token), eq(participants.eventId, eventId)));
  return me ?? null;
}

// ── GET /api/photos/:joinCode/comments?ids=a,b — the threads on those photos ──
//
// Scoped by ids rather than answering with the whole event: a thread is only ever read when a photo
// is open, and a 14,000-photo event's every comment is not something to send on the off-chance.
router.get('/:joinCode/comments', async (req: Request, res: Response) => {
  const event = await eventByIdentifier(String(req.params.joinCode));
  if (!event) return res.status(404).json({ error: 'Event not found' });
  perViewer(res);                        // carries `canDelete`, which is per-viewer by definition
  const asVisitorC = !req.get('x-session-token') && !!req.get('x-visitor-token');
  if (!(asVisitorC ? event.galleryCommentsEnabled : event.commentsEnabled)) return res.json({ comments: {} });

  const idsParam = typeof req.query.ids === 'string' ? req.query.ids : '';
  const ids = idsParam ? idsParam.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 50) : [];
  if (!ids.length) return res.json({ comments: {} });

  const me = await participantIn(req, event.id);
  const visitor = me ? null : await galleryVisitor(req, event.id);
  const isOrganizer = (req.get('x-organizer-code') || '') === event.organizerCode;

  const rows = await db
    .select({
      id: photoComments.id, photoId: photoComments.photoId, body: photoComments.body,
      createdAt: photoComments.createdAt, participantId: photoComments.participantId,
      visitorId: photoComments.visitorId,
      author: participants.name, visitorName: shareVisitors.name,
    })
    .from(photoComments)
    .innerJoin(photos, eq(photos.id, photoComments.photoId))
    // LEFT joins, plural: since 0061 a comment has exactly one author but two possible KINDS of
    // author — a participant, or somebody who only ever had a share link. An inner join on either
    // would silently drop the other kind's messages from the thread.
    .leftJoin(participants, eq(participants.id, photoComments.participantId))
    .leftJoin(shareVisitors, eq(shareVisitors.id, photoComments.visitorId))
    .where(and(
      eq(photoComments.eventId, event.id),
      inArray(photoComments.photoId, ids),
      seeableClause(event, me?.id ?? null),
    ))
    .orderBy(asc(photoComments.createdAt), asc(photoComments.id));

  // Hearts on the comments themselves, in one grouped query for the whole page of threads rather
  // than one per comment.
  const cIds = rows.map((r) => r.id);
  const hearts = cIds.length ? await db
    .select({ commentId: commentHearts.commentId, n: count() })
    .from(commentHearts).where(inArray(commentHearts.commentId, cIds))
    .groupBy(commentHearts.commentId) : [];
  const heartBy = new Map(hearts.map((h) => [h.commentId, Number(h.n)]));
  const mine = ((me || visitor) && cIds.length) ? new Set((await db
    .select({ commentId: commentHearts.commentId }).from(commentHearts)
    .where(and(inArray(commentHearts.commentId, cIds),
               me ? eq(commentHearts.participantId, me.id) : eq(commentHearts.visitorId, visitor!.id))))
    .map((h) => h.commentId)) : new Set<string>();

  const comments: Record<string, unknown[]> = {};
  for (const r of rows) {
    (comments[r.photoId] ??= []).push({
      id: r.id, body: r.body, author: r.author || r.visitorName || 'Guest', createdAt: r.createdAt,
      // WHO this is, not just what they are called. `share_visitors.name` is forty characters of
      // anything, so without this a person holding a forwarded link can post under the bride's name
      // and the thread cannot tell the difference. The host's own moderation feed has carried this
      // since it was written; the public threads flattened both kinds into one `author` field.
      authorKind: r.author ? 'guest' : 'visitor',
      hearts: heartBy.get(r.id) ?? 0, hearted: mine.has(r.id),
      // Resolved HERE rather than shipping participant ids for the client to compare: the client
      // does not need to know who everyone is to know which message is its own.
      // A visitor can take back their own words, the same as a guest can.
      canDelete: isOrganizer || (!!me && r.participantId === me.id)
                 || (!!visitor && r.visitorId === visitor.id),
    });
  }
  res.json({ comments });
});

// ── POST /api/photos/:id/comment — leave one ─────────────────────────────────
router.post('/:id/comment', async (req: Request, res: Response) => {
  const raw = req.body?.body;
  if (typeof raw !== 'string') return res.status(400).json({ error: 'body required' });
  // Cut the oversized case before doing any work: COMMENT_MAX_RAW is the guard against somebody
  // posting a megabyte, and clampComment does the real trim to COMMENT_MAX graphemes.
  const body = clampComment(raw.slice(0, COMMENT_MAX_RAW));
  if (!body) return res.status(400).json({ error: 'Write something first' });

  const [photo] = await db.select({
    id: photos.id, eventId: photos.eventId, participantId: photos.participantId, status: photos.status,
  }).from(photos).where(eq(photos.id, String(req.params.id)));
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  const [ev] = await db.select().from(events).where(eq(events.id, photo.eventId));
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  // Which switch applies depends on WHO is asking — checked once that is known.
  const me = await participantIn(req, photo.eventId);
  const visitor = me ? null : await galleryVisitor(req, photo.eventId);
  if (!me && !visitor) return res.status(403).json({ error: 'Invalid session' });
  if (me && !ev.commentsEnabled) return res.status(403).json({ error: 'Comments are off for this event' });
  if (visitor && !ev.galleryCommentsEnabled) return res.status(403).json({ error: 'Comments are off for this link' });
  // A visitor with no name has only ever hearted. Words go under a name.
  if (visitor && !visitor.name) return res.status(403).json({ error: 'Enter your name first' });

  // Same rule as canSeePhoto, and for the same reason: your own shot is always yours, so you can
  // still caption and comment on one the host has taken out of everybody else's gallery. A visitor
  // holds no photos, so nothing here is ever "their own".
  const own = !!me && photo.participantId === me.id;
  if (!own) {
    const visible = ev.moderationEnabled ? photo.status === 'approved' : photo.status !== 'rejected';
    if (!visible || !isRevealed(ev)) return res.status(404).json({ error: 'Photo not found' });
  }

  // The host's gates, honoured exactly as hearts honour them — and for the same reason ending is
  // NOT one of them: people read and talk about a gallery for weeks after the event, and only the
  // roll is over.
  if (ev.isLocked) return res.status(423).json({ error: 'This event is locked' });
  if (ev.startsAt && Date.now() < ev.startsAt) {
    return res.status(403).json({ error: "This event hasn't started yet" });
  }

  const [row] = await db.insert(photoComments)
    .values({ id: uuidv4(), photoId: photo.id, eventId: photo.eventId,
              ...(me ? { participantId: me.id } : { visitorId: visitor!.id }),
              body, createdAt: Date.now() })
    .returning({ id: photoComments.id, createdAt: photoComments.createdAt });
  res.json({ id: row.id, body, author: me ? me.name : visitor!.name, createdAt: row.createdAt, canDelete: true });
});

// ── DELETE /api/photos/comments/:id — the writer, or the host ────────────────
//
// Two authorities, no others. The writer can take their own words back; the host can remove
// anything from their own event, which is the whole reason comments can be switched on at all —
// a host who cannot delete is a host hoping nobody says anything.
router.delete('/comments/:id', async (req: Request, res: Response) => {
  const [row] = await db.select({
    id: photoComments.id, eventId: photoComments.eventId,
    participantId: photoComments.participantId, visitorId: photoComments.visitorId,
    // For the audit log. Deleting a guest's words is the most visible thing on this surface and
    // the least recoverable: the row is gone outright, so if the log does not carry the text,
    // nothing anywhere does.
    photoId: photoComments.photoId, body: photoComments.body,
  }).from(photoComments).where(eq(photoComments.id, String(req.params.id)));
  // 404 for "not yours" as well as "not there": a distinct 403 would confirm a comment id exists.
  if (!row) return res.status(404).json({ error: 'Comment not found' });

  const [ev] = await db.select().from(events).where(eq(events.id, row.eventId));
  if (!ev) return res.status(404).json({ error: 'Comment not found' });

  const isOrganizer = (req.get('x-organizer-code') || '') === ev.organizerCode;
  const me = isOrganizer ? null : await participantIn(req, row.eventId);
  const visitor = (isOrganizer || me) ? null : await galleryVisitor(req, row.eventId);
  const mine = (!!me && me.id === row.participantId) || (!!visitor && visitor.id === row.visitorId);
  if (!isOrganizer && !mine) return res.status(404).json({ error: 'Comment not found' });

  await db.delete(photoComments).where(eq(photoComments.id, row.id));
  // `ev` is the full event row this route already loaded, so nothing extra is read. Recorded
  // whichever door the caller came through, rather than only the organizer-code one: the gate is
  // "a site admin on an event they do not manage", and that is admin-actions.ts's question to
  // answer, not a condition to re-derive here.
  await recordAdminAction(req, {
    event: ev, action: 'comment.delete', targetType: 'comment', targetId: row.id,
    before: { photoId: row.photoId, body: row.body,
              participantId: row.participantId, visitorId: row.visitorId },
    after: null,
  });
  res.json({ success: true });
});

// ── Reacting on the EVENT'S OWN gallery link, without having joined ──────────
//
// The gallery link is the link a host is most likely to send round, and until 0063 it was the most
// restrictive one in the product: a curated /s/ link could be opened to reactions for anybody
// holding it, while `/gallery/<code>` could not. A host sharing "the whole gallery" and a host
// sharing a link to the whole gallery were being treated as two different decisions.
//
// A gallery visitor is the same small thing a share visitor is — a name, a token, and the link it
// belongs to — and emphatically NOT a participant: no seat against `guest_cap`, no roll, no trick
// card, no line in the guest list. What differs is where the permission comes from: a share carries
// its own switches, and the gallery INHERITS the event's, because the gallery link IS the event.

/** The gallery visitor behind `x-visitor-token`, or null. Scoped to this event's gallery: a token
 *  minted on a curated share is not an identity here, and vice versa. */
async function galleryVisitor(req: Request, eventId: string) {
  const token = String(req.get('x-visitor-token') || '');
  if (!token) return null;
  const [v] = await db.select().from(shareVisitors)
    .where(and(eq(shareVisitors.sessionToken, token), eq(shareVisitors.eventId, eventId)));
  return v ?? null;
}

// ── POST /api/photos/:joinCode/visitor — "who's looking" on the gallery link ──
//
// The name is OPTIONAL, for the same reason it is on a share: nothing shows who hearted a photo, so
// a heart needs a visitor and not a name, while a comment puts words under one. Posting a name
// later UPDATES the same row, so the hearts left before you said who you were stay yours.
router.post('/:joinCode/visitor', async (req: Request, res: Response) => {
  const event = await eventByIdentifier(String(req.params.joinCode));
  if (!event) return res.status(404).json({ error: 'Event not found' });
  // The GALLERY LINK's own switches, not the guest ones: `heartsEnabled` / `commentsEnabled` are
  // about people who scanned the QR, and this endpoint is for people who only hold the link. A host
  // can have one without the other. See 0064.
  if (!event.galleryHeartsEnabled && !event.galleryCommentsEnabled) {
    return res.status(403).json({ error: 'Reactions are off for this link' });
  }
  const name = String(req.body?.name ?? '').trim().slice(0, 40);

  perViewer(res);
  const existing = await galleryVisitor(req, event.id);
  if (existing) {
    // An empty name means "give me my token back" — never a rename to blank, which would strip the
    // name off every comment they have already left.
    if (name && name !== existing.name) {
      await db.update(shareVisitors).set({ name }).where(eq(shareVisitors.id, existing.id));
    }
    return res.json({ token: existing.sessionToken, name: name || existing.name });
  }
  const token = uuidv4();
  await db.insert(shareVisitors)
    .values({ id: uuidv4(), eventId: event.id, name, sessionToken: token, createdAt: Date.now() });
  res.json({ token, name });
});

// ── POST /api/photos/comments/:id/heart — a guest loves someone's REMARK ─────
//
// The same wire as a photo heart: an EXPLICIT `heart: true|false`, never a toggle, so a retried
// request lands on what was asked for rather than the opposite of it.
//
// What you can heart is bounded by what you can SEE: the comment's photo has to pass canSeePhoto(),
// so a comment on a rejected or pre-reveal shot is not reachable through here.
router.post('/comments/:id/heart', async (req: Request, res: Response) => {
  const sessionToken = String(req.body?.sessionToken || '');
  if (!sessionToken && !req.get('x-visitor-token')) return res.status(400).json({ error: 'sessionToken required' });
  const want = req.body?.heart;
  if (typeof want !== 'boolean') return res.status(400).json({ error: 'heart must be true or false' });

  const [row] = await db.select({
    id: photoComments.id, eventId: photoComments.eventId, photoId: photoComments.photoId,
  }).from(photoComments).where(eq(photoComments.id, String(req.params.id)));
  if (!row) return res.status(404).json({ error: 'Comment not found' });

  const [ev] = await db.select().from(events).where(eq(events.id, row.eventId));
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  // Gated on COMMENTS, not on hearts: this is a reaction to a comment, and a host who has switched
  // comments off has switched off the thing being hearted.
  // Gated on COMMENTS rather than hearts — a switched-off thread has nothing here to react to —
  // and on whichever comments switch governs the caller.
  const [me] = sessionToken ? await db.select({ id: participants.id }).from(participants)
    .where(and(eq(participants.sessionToken, sessionToken), eq(participants.eventId, row.eventId))) : [];
  const visitor = me ? null : await galleryVisitor(req, row.eventId);
  if (!me && !visitor) return res.status(403).json({ error: 'Invalid session' });
  if (me && !ev.commentsEnabled) return res.status(403).json({ error: 'Comments are off for this event' });
  if (visitor && !ev.galleryCommentsEnabled) return res.status(403).json({ error: 'Comments are off for this link' });

  const [photo] = await db.select({
    id: photos.id, eventId: photos.eventId, participantId: photos.participantId, status: photos.status,
  }).from(photos).where(eq(photos.id, row.photoId));
  if (!photo || !canSeePhoto(ev, photo, me ? me.id : null)) return res.status(404).json({ error: 'Comment not found' });

  if (ev.isLocked) return res.status(423).json({ error: 'This event is locked' });
  if (ev.startsAt && Date.now() < ev.startsAt) {
    return res.status(403).json({ error: "This event hasn't started yet" });
  }

  if (want) {
    // onConflictDoNothing leans on the partial unique index from 0062 — a double tap, a second tab
    // or a retry cannot produce a second row.
    await db.insert(commentHearts)
      .values({ id: uuidv4(), commentId: row.id, eventId: row.eventId,
                ...(me ? { participantId: me.id } : { visitorId: visitor!.id }), createdAt: Date.now() })
      .onConflictDoNothing();
  } else {
    await db.delete(commentHearts)
      .where(and(eq(commentHearts.commentId, row.id),
                 me ? eq(commentHearts.participantId, me.id) : eq(commentHearts.visitorId, visitor!.id)));
  }
  const [{ n }] = await db.select({ n: count() }).from(commentHearts).where(eq(commentHearts.commentId, row.id));
  res.json({ hearted: want, hearts: Number(n) });
});

// ── POST /api/photos/:id/heart — a guest loves someone's shot ────────────────
//
// The wire takes an EXPLICIT `heart: true|false`, not a toggle. A toggle is the obvious shape for a
// double tap and the wrong one on a phone: a request that times out and is retried flips the state
// twice and lands on the opposite of what the person asked for, with the UI showing the version
// that lost. Explicit is idempotent — say it twice, get the same answer.
router.post('/:id/heart', async (req: Request, res: Response) => {
  const sessionToken = String(req.body?.sessionToken || '');
  // Either credential will do: a guest's session in the body, or a gallery visitor's token in the
  // header. One of the two must be there.
  const hasVisitorToken = !!req.get('x-visitor-token');
  if (!sessionToken && !hasVisitorToken) return res.status(400).json({ error: 'sessionToken required' });
  const want = req.body?.heart;
  if (typeof want !== 'boolean') return res.status(400).json({ error: 'heart must be true or false' });

  const [photo] = await db.select({
    id: photos.id, eventId: photos.eventId, participantId: photos.participantId, status: photos.status,
  }).from(photos).where(eq(photos.id, String(req.params.id)));
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  const [ev] = await db.select().from(events).where(eq(events.id, photo.eventId));
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  // Which switch applies depends on WHO is asking, so it is checked once that is known.
  const [me] = sessionToken ? await db.select({ id: participants.id }).from(participants)
    .where(and(eq(participants.sessionToken, sessionToken), eq(participants.eventId, photo.eventId))) : [];
  // A visitor only where there is no guest session: somebody who has joined reacts AS the guest they
  // are, so their hearts sit in the guest list and their own roll like everyone else's.
  const visitor = me ? null : await galleryVisitor(req, photo.eventId);
  if (!me && !visitor) return res.status(403).json({ error: 'Invalid session' });
  // The switch has to REFUSE THE ENDPOINT, not merely hide the control — 0057 says exactly that.
  // These two lines had been written into the /comment handler by mistake, which left the heart
  // WRITE path ungated (and, the other way round, made commenting impossible whenever hearts were
  // off). The reads were gated all along, so nothing showed it until a host turned hearts back on
  // and every heart they had opted out of appeared at once.
  if (me && !ev.heartsEnabled) return res.status(403).json({ error: 'Hearts are off for this event' });
  if (visitor && !ev.galleryHeartsEnabled) return res.status(403).json({ error: 'Hearts are off for this link' });

  // You can only heart what you can actually SEE — canSeePhoto() is the row-level half of the rule
  // the GET above applies as a WHERE clause. A visitor has no roll of their own, so `null` is the
  // honest viewer id: they see exactly the revealed, un-rejected set and nothing more.
  if (!canSeePhoto(ev, photo, me ? me.id : null)) return res.status(404).json({ error: 'Photo not found' });

  // Lock is the host's kill switch and every other guest write honours it (uploads 423, delete 423)
  // — hearts were walking straight past. Same for an event that has not opened yet: nothing should
  // happen there at all.
  //
  // Ending is DELIBERATELY not a barrier, which is the one place hearts differ from uploads. The
  // gallery is meant to stay alive after the event: people browse it, download it and send it round
  // for weeks, and hearting is part of browsing. Uploads stop because the roll is over; looking does
  // not stop.
  if (ev.isLocked) return res.status(423).json({ error: 'This event is locked' });
  if (ev.startsAt && Date.now() < ev.startsAt) {
    return res.status(403).json({ error: "This event hasn't started yet" });
  }

  if (want) {
    // onConflictDoNothing leans on the unique index from 0057: a double tap, two tabs or a retry
    // cannot produce a second row.
    //
    // That is one heart per PARTICIPANT, which is not the same as one per person. Joining is
    // unauthenticated, so somebody determined can mint participants and heart the same photo from
    // each — bounded by the event's guest cap where billing is on, and unbounded on a self-host
    // build. The ceiling on the damage is a vanity number, and the same trick fills the guest list
    // (which is the pre-existing problem worth solving, and is not this one).
    await db.insert(photoHearts)
      .values({ id: uuidv4(), photoId: photo.id, eventId: photo.eventId,
                ...(me ? { participantId: me.id } : { visitorId: visitor!.id }), createdAt: Date.now() })
      .onConflictDoNothing();
  } else {
    await db.delete(photoHearts)
      .where(and(eq(photoHearts.photoId, photo.id),
                 me ? eq(photoHearts.participantId, me.id) : eq(photoHearts.visitorId, visitor!.id)));
  }

  // Counted after the write and sent back, so the client shows the real total rather than its own
  // optimistic guess — which is what drifts when two people heart the same photo at once.
  const [{ n }] = await db.select({ n: count() }).from(photoHearts).where(eq(photoHearts.photoId, photo.id));
  res.json({ hearted: want, hearts: Number(n) });
});

router.post('/', upload.single('photo'), async (req: Request, res: Response) => {
  const { sessionToken } = req.body;
  if (!sessionToken) { if (req.file) fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'sessionToken required' }); }
  if (!req.file)     return res.status(400).json({ error: 'No file uploaded' });

  const isVideo = isVideoUpload(req.file);
  // multer's single fileSize limit is the larger (video) cap; enforce the smaller PHOTO cap here.
  const perTypeMaxMb = isVideo ? MAX_VIDEO_MB : MAX_PHOTO_MB;
  if (req.file.size > perTypeMaxMb * 1024 * 1024) { fs.unlinkSync(req.file.path); return res.status(413).json({ error: `${isVideo ? 'Video' : 'Photo'} too large (max ${perTypeMaxMb} MB)` }); }

  const participant = await participantForUpload(sessionToken);
  if (!participant) { fs.unlinkSync(req.file.path); return res.status(403).json({ error: 'Invalid session' }); }
  const gate = gateUpload(participant, isVideo, capturedAtFor(req.body?.capturedAt, participant, Date.now()), req.body);
  if (gate) { fs.unlinkSync(req.file.path); return res.status(gate.status).json({ error: gate.error }); }

  try {
    return res.json(await finalizeUpload(participant, req.file.path, isVideo, req.body?.source === 'upload' ? 'upload' : 'capture', req.body?.challengeId, req.body?.captureOrientation, req.body?.captureShape, req.body?.captureRotation, req.body?.captureTurn, req.body?.capturedAt));
  } catch (e) {
    // A `status` on the error means finalizeUpload raised it FOR the guest ("Video is too long —
    // this server accepts clips up to 30s"), so its message is the message and must survive. An
    // error without one is an internal fault, and its text is sharp/ffmpeg output or a Postgres
    // constraint name — not something to hand an unauthenticated uploader. Log that one instead.
    const status = (e as { status?: number }).status;
    if (status) return res.status(status).json({ error: (e as Error).message });
    console.error('[photos] upload failed:', (e as Error).message);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// ── Chunked upload (for videos larger than a single request can carry — Cloudflare caps bodies at
// ~100MB). Client splits the blob into parts and POSTs each to /chunk; /complete reassembles them
// and runs the SAME gating + finalize as a normal upload. ──────────────────────────────────────

const CHUNK_MAX_MB = 100;
const SAFE_UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/;
// Upper bound on part count. The client slices into ~5MB parts for resilient/resumable uploads;
// divide by 4 (below the client size) so the bound tolerates smaller-than-expected parts, plus margin.
const MAX_CHUNKS = Math.ceil(MAX_VIDEO_MB / 4) + 16;
const uploadPartsDir = (uploadId: string) => path.join(INCOMING_DIR, `chunks-${uploadId}`);

/** Is the staged upload REALLY a clip — according to its own bytes?
 *
 *  Everything else about "is this a video" on the chunked route is the client's word. `mediaType`
 *  obviously so. `ext` too: it is destructured straight out of `req.body` a few lines into
 *  /complete, so an audit correctly pointed out that a first attempt to tighten this — believe the
 *  extension rather than the declaration — moved the forgery from one client-supplied field to
 *  another and changed nothing. Posting a JPEG as `ext:"mp4"` bought exactly what posting it as
 *  `mediaType:"video"` had just been stopped from buying.
 *
 *  The bytes are the only thing on this route the client cannot simply assert. Both container
 *  families the camera produces announce themselves in the first few: ISO-BMFF (mp4/m4v/mov/3gp)
 *  carries 'ftyp' at offset 4, and Matroska/WebM opens with the EBML magic. A still does neither.
 *
 *  WHAT THIS IS FOR, and it is narrow: the extra reach past an event's close that a clip gets,
 *  because a recording begun before the end may legitimately finish and upload long after it. A
 *  still has no such claim. This is not an entitlement check and must not be reused as one — the
 *  paid-video length is enforced against ffprobe on the assembled file, which is stronger still.
 *
 *  Chunk 0 is read because it is the only part guaranteed to hold the header. If it is not there
 *  the answer is `null`, meaning "cannot tell": /complete is about to refuse the whole upload for
 *  missing parts anyway, and the caller falls back to the declared value so that a legitimate
 *  clip retrying a lost part still gets 409 "resend" rather than 410 "event has ended" — which
 *  would wipe the parts it had already managed to send. */
function stagedLooksLikeVideo(uploadId: string): boolean | null {
  try {
    const fd = fs.openSync(path.join(uploadPartsDir(uploadId), '0'), 'r');
    try {
      const head = Buffer.alloc(12);
      const n = fs.readSync(fd, head, 0, 12, 0);
      if (n < 12) return null;
      if (head.subarray(4, 8).toString('latin1') === 'ftyp') return true;          // mp4/m4v/mov/3gp
      if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true;  // webm/mkv
      return false;
    } finally { fs.closeSync(fd); }
  } catch { return null; }   // no part 0 yet, or unreadable — say so rather than guess
}

const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(INCOMING_DIR, { recursive: true }); cb(null, INCOMING_DIR); },
    filename: (_req, _file, cb) => cb(null, `part-${uuidv4()}`),
  }),
  limits: { fileSize: CHUNK_MAX_MB * 1024 * 1024 },
});

// Concatenate parts 0..total-1 in <dir> into <dest>, in order (streamed — never loads a part into memory).
function concatParts(dir: string, total: number, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    out.on('error', reject);
    out.on('finish', () => resolve());
    let i = 0;
    const next = () => {
      if (i >= total) { out.end(); return; }
      const rd = fs.createReadStream(path.join(dir, String(i++)));
      rd.on('error', reject);
      rd.on('end', next);
      rd.pipe(out, { end: false });
    };
    next();
  });
}

// POST /api/photos/chunk — stage one part (multipart field 'chunk' + fields uploadId,index,total,sessionToken).
router.post('/chunk', chunkUpload.single('chunk'), async (req: Request, res: Response) => {
  const drop = () => { if (req.file) { try { fs.unlinkSync(req.file.path); } catch { /* */ } } };
  const { sessionToken, uploadId } = req.body || {};
  const index = parseInt(req.body?.index, 10);
  const total = parseInt(req.body?.total, 10);
  if (!req.file) return res.status(400).json({ error: 'No chunk uploaded' });
  if (!sessionToken || !SAFE_UPLOAD_ID.test(String(uploadId || '')) || !Number.isInteger(index) || index < 0
      || !Number.isInteger(total) || total < 1 || total > MAX_CHUNKS || index >= total) { drop(); return res.status(400).json({ error: 'Bad chunk request' }); }
  if (!(await participantForUpload(sessionToken))) { drop(); return res.status(403).json({ error: 'Invalid session' }); }

  const dir = uploadPartsDir(uploadId);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.renameSync(req.file.path, path.join(dir, String(index))); }   // idempotent: a re-sent part overwrites
  catch { drop(); return res.status(500).json({ error: 'Could not store chunk' }); }
  res.json({ ok: true, index });
});

// POST /api/photos/complete — reassemble the staged parts and finalize (JSON body).
router.post('/complete', async (req: Request, res: Response) => {
  const { sessionToken, uploadId, ext, mediaType } = req.body || {};
  const total = parseInt(req.body?.total, 10);
  if (!sessionToken || !SAFE_UPLOAD_ID.test(String(uploadId || '')) || !Number.isInteger(total) || total < 1 || total > MAX_CHUNKS)
    return res.status(400).json({ error: 'Bad complete request' });

  const participant = await participantForUpload(sessionToken);
  if (!participant) return res.status(403).json({ error: 'Invalid session' });

  // Two questions, two answers, and only one of them may be taken on trust.
  //
  // `isVideo` is the generous one. It drives entitlement, the size cap and which branch processes
  // the file, and it must stay generous: a real clip whose extension is unusual must not slip
  // past the paid-video check by being mistaken for a photograph.
  //
  // The allowance — how far past the event's close this upload may reach — is the strict one, and
  // it is settled by the BYTES. Both `mediaType` and `ext` arrive in the request body, so neither
  // is evidence of anything; a first version of this believed `ext` and merely moved the forgery
  // from one field to another. `null` means the header could not be read, in which case there is
  // nothing better to go on than the declaration — and the upload is about to be refused for
  // missing parts regardless. See stagedLooksLikeVideo.
  const extSaysVideo = VIDEO_EXT_RE.test('x.' + String(ext || ''));
  const isVideo = mediaType === 'video' || extSaysVideo;
  const sniffed = stagedLooksLikeVideo(uploadId);
  const clipAllowance = sniffed ?? isVideo;
  const dir = uploadPartsDir(uploadId);
  const wipe = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } };

  const gate = gateUpload(participant, isVideo, capturedAtFor(req.body?.capturedAt, participant, Date.now()),
                          req.body, clipAllowance);
  if (gate) { wipe(); return res.status(gate.status).json({ error: gate.error }); }

  // All parts present + within the size cap?
  const missing: number[] = [];
  let totalBytes = 0;
  for (let i = 0; i < total; i++) {
    try { totalBytes += fs.statSync(path.join(dir, String(i))).size; } catch { missing.push(i); }
  }
  if (missing.length) return res.status(409).json({ error: 'Missing chunks', missing });   // client resends these
  const perTypeMaxMb = isVideo ? MAX_VIDEO_MB : MAX_PHOTO_MB;
  if (totalBytes > perTypeMaxMb * 1024 * 1024) { wipe(); return res.status(413).json({ error: `${isVideo ? 'Video' : 'Photo'} too large (max ${perTypeMaxMb} MB)` }); }

  const safeExt = /^(mp4|webm|mov|m4v|jpe?g|png|webp)$/i.test(String(ext || '')) ? String(ext).toLowerCase() : (isVideo ? 'mp4' : 'jpg');
  const staged = path.join(INCOMING_DIR, `${uuidv4()}.${safeExt}`);
  try { await concatParts(dir, total, staged); }
  catch { try { fs.unlinkSync(staged); } catch { /* */ } wipe(); return res.status(500).json({ error: 'Reassembly failed' }); }
  wipe();   // parts no longer needed

  try {
    return res.json(await finalizeUpload(participant, staged, isVideo, req.body?.source === 'upload' ? 'upload' : 'capture', req.body?.challengeId, req.body?.captureOrientation, req.body?.captureShape, req.body?.captureRotation, req.body?.captureTurn, req.body?.capturedAt));
  } catch (e) {
    // A `status` on the error means finalizeUpload raised it FOR the guest ("Video is too long —
    // this server accepts clips up to 30s"), so its message is the message and must survive. An
    // error without one is an internal fault, and its text is sharp/ffmpeg output or a Postgres
    // constraint name — not something to hand an unauthenticated uploader. Log that one instead.
    const status = (e as { status?: number }).status;
    if (status) return res.status(status).json({ error: (e as Error).message });
    console.error('[photos] upload failed:', (e as Error).message);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// ── GET /api/photos/:joinCode/download — zip of the files as the gallery serves them ──
// Public, gallery-scoped: requires the event revealed + downloads allowed. `?ids=a,b`
// limits to a selection; omit for everything. Streams a max-compression zip of the
// FULL-quality originals.

router.get('/:joinCode/download', async (req: Request, res: Response) => {
  const event = await eventByIdentifier(String(req.params.joinCode));
  if (!event) return res.status(404).json({ error: 'Event not found' });
  // The organizer (valid organizer code) can always download their own originals; guests only
  // once the gallery is revealed AND downloads are allowed. Header only — never the query string.
  const orgCode = req.get('x-organizer-code') || '';
  const isOrganizer = !!orgCode && orgCode === event.organizerCode;
  // A guest zipping their OWN roll, which is the whole of what the camera screen offers. Before the
  // reveal this is the only zip anyone but the organizer can have, and it is bounded to the photos
  // that guest took — the same ones their roll already shows them and already lets them save one at
  // a time. So the zip hands over nothing the session could not already fetch; it only saves them
  // tapping save thirty-five times.
  //
  // The token travels in the QUERY rather than a header because this is reached by navigating to
  // the URL (the response is a stream, not something to hold in memory), and a navigation cannot
  // carry headers. That is the same reason DELETE /:id accepts it there. Note the contrast with the
  // ORGANIZER code a few lines up, which stays header-only: that one opens the whole event.
  let ownOnly: string | null = null;
  if (!isOrganizer) {
    if (!event.allowDownloads) return res.status(403).json({ error: 'Downloads are disabled for this event' });
    if (!isRevealed(event)) {
      const token = typeof req.query.sessionToken === 'string' ? req.query.sessionToken : '';
      const [me] = token
        ? await db.select({ id: participants.id }).from(participants)
            .where(and(eq(participants.sessionToken, token), eq(participants.eventId, event.id)))
        : [];
      // Deliberately the SAME message either way. "Not revealed yet" is the truth for a guest with
      // no session, and a wrong token must not get a different answer that confirms the event has
      // photos worth guessing at.
      if (!me) return res.status(403).json({ error: 'Photos are not revealed yet' });
      ownOnly = me.id;
    }
  }

  const idsParam = typeof req.query.ids === 'string' ? req.query.ids : '';
  const ids = idsParam ? idsParam.split(',').map((s) => s.trim()).filter(Boolean) : [];

  // Visible set: with moderation on, only approved; off, anything not binned (rejected).
  //
  // Own-roll is the exception: a guest sees their own shots in their roll whether or not a host has
  // approved them yet, and can save each one from there. Holding a zip of the same photos to the
  // stricter rule would hand back fewer files than the screen they pressed the button on.
  const visible = ownOnly
    ? ne(photos.status, 'rejected')
    : event.moderationEnabled ? eq(photos.status, 'approved') : ne(photos.status, 'rejected');
  const rows = await db
    // captureShape is not decoration here: downloadFile needs it to know a clip wanted a shape, and
    // without it every clip in the zip silently falls back to the uncropped original.
    // `id` is what makes the LATE re-read in zipPhotosToResponse possible at all. Everything else
    // in this select is a snapshot that ages for as long as the download takes; the id is the one
    // column that cannot go stale, so it is the handle the archive loop re-resolves the rest from.
    .select({ id: photos.id, filename: photos.filename, mediaType: photos.mediaType, captureShape: photos.captureShape,
              participantId: photos.participantId, participantName: participants.name })
    .from(photos)
    .innerJoin(participants, eq(participants.id, photos.participantId))
    .where(and(
      eq(photos.eventId, event.id),
      visible,
      ...(ids.length ? [inArray(photos.id, ids)] : []),
      // The scope, not a filter the caller chose: an unrevealed guest gets their own photos and
      // nothing else, whatever ids they asked for.
      ...(ownOnly ? [eq(photos.participantId, ownOnly)] : []),
    ))
    // THIS ORDER NAMES THE FILES IN THE ZIP (see zipPhotosToResponse below: it walks these rows
    // assigning "<Event> - <Who> - <n>"), so a tie in it means the same photo gets a different
    // number in two downloads of one event, and neither matches the gallery. Two guests called
    // Sarah at a wedding is the base case and (name, takenAt) does not separate them: measured,
    // two downloads of a 12-photo event came back with slots 2 and 3 swapped after nothing but an
    // unrelated column being touched. `participants.id` groups each person's shots contiguously —
    // which is what "group by person" claimed and ties quietly broke — and `photos.id` makes the
    // whole order total.
    .orderBy(asc(participants.name), asc(participants.id), asc(photos.takenAt), asc(photos.id));
  if (!rows.length) return res.status(404).json({ error: 'No photos to download' });

  await zipPhotosToResponse(res, event.name, rows);
});

/** How many rows to re-read per database round trip while the archive is being built.
 *
 *  One select per file would be 400 round trips threaded through a stream that is already
 *  minutes long, and this route runs while every other guest at the event is polling the gallery
 *  off the same pool — that is the chattiness worth avoiding. One select for the whole set would
 *  be the stale snapshot again, taken slightly later and no more true by entry 300.
 *
 *  Fifty is the compromise, and what it actually buys is a bounded WINDOW: a name can only be as
 *  old as the time it takes to stream the fifty files before it, rather than as old as the whole
 *  download. Eight queries for a 400-photo event is nothing. It does not close the window — a
 *  rotate landing inside a batch is still possible, and that is exactly what the warning
 *  bookkeeping below exists to catch and report rather than swallow. */
const ZIP_REFRESH_BATCH = 50;

/** How long the archive may make no progress AT ALL before the download is written off as dead.
 *
 *  "No progress" is three things at once and all three are load-bearing: no entry has settled, no
 *  byte has reached the response, and the response is not sitting back-pressured waiting for the
 *  guest's end to read. Anything less is a timer that kills working downloads — see the long note
 *  on waitForSettle for the one this replaced.
 *
 *  Two minutes because the shortest legitimate silence worth tolerating is an NFS stat storm on a
 *  purged event, which is seconds, and the longest thing this must catch is a response that will
 *  otherwise stay open until the process restarts. Anywhere in that range is defensible; what is
 *  not defensible is not having one.
 *
 *  A `let` with a setter rather than a constant, and rather than an environment variable, for
 *  one reason each. The suite has to be able to exercise the watchdog without waiting two minutes
 *  for every case — and an env var would oblige both compose files to carry a knob nobody will
 *  ever deploy (compose-env.test.ts enforces exactly that, and is right to). Two minutes remains
 *  the only value anything in production uses. */
let zipSettleIdleMs = 120_000;

/** Test hook: shorten the watchdog. Returns the previous value so a test can put it back.
 *
 *  Exported rather than reached into, for the same reason as __resetListingCache: the coupling is
 *  then visible from both ends, and anyone changing the watchdog can see who depends on being
 *  able to hurry it along. */
export function __setZipSettleIdleMs(ms: number): number {
  const was = zipSettleIdleMs;
  zipSettleIdleMs = ms;
  return was;
}

/** Does this file exist, without stopping the world to find out.
 *
 *  `fs.existsSync` on an NFS share is ~4µs warm and ~143µs cold, and it blocks the event loop for
 *  every microsecond of it — the reason `onDisk()` and its cached readdir exist at all. This is
 *  the confirming look on a cache MISS, which is rare for one rotated photo and universal for a
 *  purged event, so it has to be the async one. */
const exists = (file: string) => fs.promises.access(file).then(() => true, () => false);

/** What a mid-stream zip failure can possibly look like to the person waiting for it.
 *
 *  By the time anything in the archive loop can fail, the `200 OK`, the content type and the
 *  `Content-Disposition` are long gone, and so are the bytes of the first few photos. A JSON error
 *  is not available. Neither is a status code, nor a header, nor a message of any kind. The only
 *  channel left is the SHAPE OF THE RESPONSE ITSELF.
 *
 *  That channel is real, and it is the whole of the fix. A store-only zip has no length anybody
 *  knows until the last entry is written, so there is no Content-Length and the body goes out
 *  `Transfer-Encoding: chunked` — and a chunked body is only COMPLETE once the zero-length
 *  terminating chunk arrives. Killing the socket before that leaves the framing unterminated,
 *  which is not ambiguous to anything that speaks HTTP: Chrome and Firefox file the download as
 *  failed rather than dropping a truncated .zip into the Downloads folder, curl exits 18, and
 *  nginx in front of us resets its own downstream connection when an upstream dies this way.
 *
 *  So the load-bearing rule here is a NEGATIVE one, and it is the easiest thing in the world to
 *  undo by accident while "tidying up error handling": never call res.end() on a failed archive.
 *  end() writes that terminating chunk, and the client then receives a well-framed, complete,
 *  successful HTTP response whose body happens to be half a zip. That is precisely the reported
 *  failure — a corrupt file and no error anywhere. res.destroy() is not cleanup after the error;
 *  it IS the error message, and the only one this stage of the response can still send.
 *
 *  `archive.abort()` in front of it was missing, and matters for us rather than for the client:
 *  without it archiver carries on working its queue, statting and opening hundreds of files off
 *  the share and pushing them into a socket nobody is reading, for a download that already
 *  failed. */
export function onZipStreamError(res: { destroy(): unknown }, archive: { abort(): unknown }, err: Error): void {
  console.error('[zip] failed mid-stream, aborting the download:', err);
  archive.abort();
  res.destroy();
}

/** The note that goes INSIDE the zip when something could not be included.
 *
 *  Inside the archive, rather than a header or a status or a different filename, because there is
 *  nowhere else left to put it: the response headers were written before the first entry had even
 *  been statted, and the count is not known until the last one has. The archive is the only
 *  writable surface that still exists at that point.
 *
 *  The contract this creates is the point of it. A zip with no such file in it is complete, and
 *  that claim is now true. A zip with one names exactly what is not there, so "I think a photo is
 *  missing" stops being something only the host's memory can answer.
 *
 *  Plain and undramatic on purpose. The overwhelmingly likely cause is a rotation landing
 *  mid-archive, and in that case nothing has been lost at all — the photo is in the gallery under
 *  a new name and a second download will have it. So the copy says "try again", not "your photos
 *  are gone". */
function missingManifest(total: number, missing: string[]): string {
  const n = missing.length;
  return [
    'Some photos could not be included in this download',
    '===================================================',
    '',
    `${n} of ${total} ${n === 1 ? 'is' : 'are'} missing from this zip:`,
    '',
    ...missing.map((name) => `  - ${name}`),
    '',
    'These were looked for a second time once the rest of the download had',
    'finished, in case they had simply been rotated or re-cropped while it was',
    'being prepared — that is the usual reason, and it is recovered',
    'automatically. These ones were still not there, so they have most likely',
    'been removed from the event. Check the gallery: anything still showing',
    'there will come through on another download.',
    '',
  ].join('\n');
}

// ── Streaming a zip while the event is still being edited ─────────────────────────────────────
//
// Stream a .zip of the given photo rows, named "<Event> - <Participant> - <n>.ext" where n is that
// participant's own capture-order number. Resolves once the archive is finalised (or has been
// abandoned), and answers with the entry names that could NOT be included — empty when every row
// handed in is really in the file.
//
// THE RACE EVERYTHING ODD BELOW IS BUILT AROUND.
//
// A 400-photo event is minutes of streaming off an NFS share, and the host is very often sitting
// in the Review screen for those minutes, straightening shots. POST /:id/rotate does not edit a
// file in place: it writes a fresh uuid, moves the row onto it and unlinks the old name. So a
// filename read at the start of a download is a filename that can cease to exist halfway through
// it — for a photo that is completely fine under a different one.
//
// Three separate things went wrong with that, and every one of them was silent:
//
//   1. The caller SNAPSHOTS the rows with one select and hands the array over. By the time entry
//      300 is reached that array is minutes old, so it can name a file nobody can open, for a
//      photo that is still there. The right outcome is the rotated file in the zip — not a hole,
//      and not an error.
//   2. `onDisk()` answers from a readdir cached for LISTING_TTL_MS (2s). Inside that window it
//      will cheerfully say "present" about a name unlinked a second ago, so the guard passes and
//      the entry gets queued regardless.
//   3. `archive.file()` only QUEUES. Archiver lstats the path later and opens the read stream
//      later still. An lstat that fails does `_entriesCount--` and emits 'warning' — and
//      'warning' had NO LISTENER, so the entry simply vanished and the download completed looking
//      perfect. A failure in the window between the lstat and the read reaches 'error' instead,
//      which destroyed the socket mid-body with nothing anywhere to say why.
//
// The answers, in the same order: names are re-read from the database in batches immediately
// before they are queued; a cache miss is confirmed against the real filesystem before anything
// is declared missing; and every dropped entry is counted, named in a README inside the zip, and
// returned to the caller. Between them there is no longer a path where a file vanishes and nobody
// is told.
export async function zipPhotosToResponse(
  res: Response,
  eventName: string,
  // captureShape is required, not optional: downloadFile needs it to tell that a clip asked for a
  // shape, and a caller that forgets it gets uncropped originals in the zip with no error anywhere.
  // Making it mandatory turns that into a compile failure instead of a silent wrong file.
  //
  // `id` is required for the same class of reason. Without it the only filenames this function can
  // ever see are the ones in the snapshot, which is the defect above; with it, the row is
  // re-resolvable at the moment it matters. A caller that cannot supply an id cannot be made safe
  // against a concurrent rotate, so the compiler refuses it rather than letting it look fine.
  rows: { id: string; filename: string; mediaType: string | null; captureShape: string | null;
          participantId: string; participantName: string | null }[],
): Promise<string[]> {
  const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const evName = fileSafe(eventName || 'Snapdini').slice(0, 40) || 'Snapdini';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${evName}.zip"`);

  // STORE, not DEFLATE. Everything in here is JPEG, MP4 or WebP — already compressed — so deflate
  // has nothing to find. Measured on 60 real photos (50.28 MB): level 9 saved 0.10% and took
  // 6.8s; store took 0.32s. That is 21x the CPU to save 51 KB, spent while the host waits for the
  // download to start and a core is pinned. On a 400-photo event it is nearer a minute for a few
  // hundred KB. Bundling is the job here; compressing is not.
  const archive = new ZipArchive({ store: true });

  // ── Did every entry we queued actually get into the file? ──────────────────────────────────
  //
  // Archiver settles each queued entry exactly once, through one of three events: 'entry' when it
  // is written, 'warning' when the lstat failed and it has been dropped, or 'error' when the whole
  // stream is finished. Counting all three is what lets this function wait for the queue to be
  // genuinely resolved — which it must do, because the README below cannot be written until the
  // last warning has fired, and `append` after `finalize` is a QUEUECLOSED error.
  //
  // Waiting does not make the response any slower: finalize() already only completed on queue
  // drain. The difference is that we now know what happened before we commit to calling it.
  /** Absolute source path → what that file is, to us.
   *
   *  Keyed by PATH, and that is the load-bearing part. The first version of this kept two maps —
   *  path → entry name, and entry name → photo id — and the second of those is not a key at all.
   *  Entry names are `<event> - <participant> - <n>`, numbered per participant, so two guests both
   *  called Sarah each produce "Party - Sarah - 1.jpg": the second overwrites the first, and a
   *  dropped entry for one of them is then traced back to the OTHER one's row. The recovery pass
   *  would re-add Sarah B's photo a second time, mark it recovered, and Sarah A's genuinely lost
   *  photo would never reach the README — which is exactly the silent hole this whole thing was
   *  written to close, rebuilt inside the fix for it.
   *
   *  Paths are server-generated uuids and cannot collide. */
  const entryFor = new Map<string, { entry: string; id: string }>();
  /** Queued-and-lost or never-queued, each still carrying the id that can go and find it again.
   *  `done` is set by the recovery pass rather than collecting names in a set, for the same
   *  reason: a name is not an identity here. */
  let missing: { id: string | null; entry: string; done?: boolean }[] = [];
  let queued = 0, settled = 0, failed = false;
  let wake: (() => void) | null = null;
  let onSettle: (() => void) | null = null;
  const settle = () => {
    settled++;
    onSettle?.();                       // progress: push the watchdog's deadline out
    if (wake && settled >= queued) { const w = wake; wake = null; onSettle = null; w(); }
  };
  /** Resolves the moment anything writes this download off — the archiver erroring, the guest
   *  closing the tab, the watchdog below. Nothing else resolves it, which is what makes it safe
   *  to race a perfectly healthy finalize() against: it cannot fire first on a download that is
   *  still working. */
  let stopWaiting: (() => void) | null = null;
  const abandoned = new Promise<void>((resolve) => { stopWaiting = resolve; });
  const giveUp = () => {
    failed = true;
    stopWaiting?.();
    if (wake) { const w = wake; wake = null; w(); }
  };

  archive.on('entry', settle);
  archive.on('warning', (err) => {
    // An lstat failure carries the path it failed on, which is how a dropped entry is traced back
    // to the photo it was meant to be; the archiver's own warnings (unsupported entry types) carry
    // an entry data object with the name instead. Between them there is always something to print,
    // and the fallback exists only so that an unrecognised warning still gets counted rather than
    // quietly unbalancing the settle count and hanging the response.
    const p = (err as NodeJS.ErrnoException).path;
    const hit = p ? entryFor.get(p) : undefined;
    const named = hit?.entry ?? (err as { data?: { name?: string } }).data?.name ?? p;
    console.error('[zip] entry dropped by archiver: %s (%s)', named ?? 'unknown entry', err?.message);
    missing.push({ id: hit?.id ?? null, entry: named ?? 'an unnamed photo' });
    settle();
  });
  archive.on('error', (err: Error) => { onZipStreamError(res, archive, err); giveUp(); });
  // A cancelled download — the guest closing the tab, a phone losing wifi — otherwise leaves this
  // function awaiting a queue that will never drain, holding the rows and the archiver for the
  // life of the process while archiver keeps pulling files off the share for nobody. `close` fires
  // on a successful response too, hence the writableFinished guard.
  res.on('close', () => { if (!res.writableFinished && !failed) { archive.abort(); giveUp(); } });
  archive.pipe(res);
  /** Has a single byte of archive reached the response since the watchdog last looked?
   *
   *  ONE ENTRY IS ONE SETTLE, which is why the watchdog cannot be a pure settle timer. A guest's
   *  half-gigabyte clip going out to a phone on mobile data is many minutes between 'entry'
   *  events, and every one of those minutes is spent successfully writing the thing. Counting
   *  bytes is how "the archive has stopped" is told apart from "the archive is busy", and getting
   *  that wrong now costs the download rather than merely mislogging it.
   *
   *  Attached AFTER the pipe above, never before: adding a 'data' listener to a paused readable
   *  starts it flowing, and doing that ahead of the pipe would spill the first chunks of the zip
   *  on the floor. */
  let flowed = false;
  archive.on('data', () => { flowed = true; });

  /** Write the download off: stop the archiver, and leave the guest with a FAILED transfer.
   *
   *  onZipStreamError is the whole of the failure channel at this point — the 200, the headers
   *  and the first entries are long gone, so destroying the socket without the terminating chunk
   *  is the only thing left that means "this body is not complete". See its own note. */
  const abandon = (why: string): void => { onZipStreamError(res, archive, new Error(why)); giveUp(); };

  /** Resolve once every queued entry has settled — or fail the download.
   *
   *  THE WATCHDOG THIS REPLACES WAS A LIE, and it is worth writing down exactly how, because it
   *  read perfectly. It stopped waiting, logged the count, and let the function walk on to
   *  `await archive.finalize()` — and in archiver 8 (lib/core.js, `finalize()`) that promise
   *  resolves on the zip module's own `end`, which the module only reaches once
   *  `_pending === 0 && _queue.idle()`. That is the precise condition the watchdog exists because
   *  it has NOT happened. So in the one scenario the whole mechanism was written for — a queued
   *  entry archiver never settles — the request did not stop hanging at all. It hung two minutes
   *  later, at finalize, with no bytes, no error and no end. A watchdog that moves a hang is
   *  worse than no watchdog, because it also stops anybody going looking for one.
   *
   *  SO THE TIMEOUT NOW FAILS THE DOWNLOAD instead of proceeding with it, and there is no third
   *  option available. Once archiver has stopped resolving entries no complete zip can be
   *  produced: the README naming what is missing is itself an append onto the queue that will not
   *  drain. Racing finalize() against a timer was the alternative and it was rejected — it leaves
   *  archiver working a response nobody will ever read, and it has to destroy the socket at the
   *  end of it anyway, so it is the same outcome bought with a live queue still pulling files off
   *  the share.
   *
   *  IDLE, not total: the wait is legitimately minutes on a 400-photo event over NFS, so a total
   *  timeout would cut healthy downloads short. And idle means NOTHING IS MOVING — see `flowed`
   *  above for the bytes, and `writableNeedDrain` below for the other half of it. A response that
   *  is back-pressured is not a stalled archive; it is a guest whose phone has stopped reading,
   *  and the download it is still attached to is the one thing this must never kill. */
  function waitForSettle(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (failed || settled >= queued) { resolve(); return; }
      let idle: ReturnType<typeof setTimeout>;
      // BOTH hooks are cleared here, not only on the timeout path. giveUp() resolves through
      // `wake` and used to leave `onSettle` behind it, so a late 'entry' arriving after a
      // cancelled download re-armed a fresh two-minute timer — which, now that the timer does
      // something, would have fired on a response that had been over for minutes.
      const done = () => { clearTimeout(idle); wake = null; onSettle = null; resolve(); };
      const arm = () => {
        clearTimeout(idle);
        flowed = false;
        idle = setTimeout(() => {
          if (flowed || res.writableNeedDrain) { arm(); return; }   // alive, merely slow
          console.error('[zip] "%s": %d of %d entries never settled — failing the download',
                        evName, queued - settled, queued);
          abandon(`${queued - settled} of ${queued} entries never settled`);
          done();
        }, zipSettleIdleMs);
      };
      // Every settle pushes the deadline out, so progress keeps the wait alive and silence ends it.
      onSettle = arm;
      wake = done;
      arm();
    });
  }

  const perPerson = new Map<string, number>();
  for (let start = 0; start < rows.length && !failed; start += ZIP_REFRESH_BATCH) {
    const slice = rows.slice(start, start + ZIP_REFRESH_BATCH);
    // RESOLVE LATE. The filenames in `slice` are as old as the snapshot; these are as old as this
    // line. A rotate that has already committed moved the row to a new uuid and unlinked the old
    // name, so re-reading is the difference between the zip containing the rotated photo and the
    // zip containing a hole where it was.
    let fresh: Map<string, MediaRow> | null = null;
    try {
      const now = await db
        .select({ id: photos.id, filename: photos.filename, mediaType: photos.mediaType,
                  captureShape: photos.captureShape })
        .from(photos)
        .where(inArray(photos.id, slice.map((r) => r.id)));
      fresh = new Map(now.map((p) => [p.id, p as MediaRow]));
    } catch (e) {
      // A database hiccup must not cost the host the other 390 photos, so this batch falls back to
      // the snapshot and the existence checks below decide. `fresh` staying null is load-bearing
      // beyond the fallback: it is also what stops an absent row being read as "this photo was
      // deleted" when the truth is "we never managed to ask".
      console.error('[zip] could not refresh filenames for the batch at %d, using the snapshot:', start, e);
    }

    for (const r of slice) {
      // The NUMBER comes from the snapshot's position and is taken for every row, including the
      // ones that turn out to be missing. That is a deliberate change from the dense numbering
      // this loop used to do, and the reason is the same one the caller's ORDER BY is written for:
      // a given photo must get the same name in two downloads of one event. Skipping the counter
      // on a missing file renumbers everything after it, so one absent photo silently renames the
      // whole rest of the zip — and leaves the README below with no name to report it under.
      // A gap in the numbering is the honest artefact of a gap in the archive.
      const who = fileSafe(r.participantName || 'Guest') || 'Guest';
      const n = (perPerson.get(r.participantId) || 0) + 1; perPerson.set(r.participantId, n);
      const cur = fresh?.get(r.id) ?? r;
      // The same file the gallery's own download button hands over — see downloadFile. Reading
      // r.filename here meant a clip the gallery showed cropped came out of the zip uncropped.
      const rel = downloadFile(cur);
      const ext = cur.mediaType === 'video' ? (rel.split('.').pop() || 'mp4') : 'jpg';
      const entry = `${evName} - ${who} - ${n}.${ext}`;

      // The row is gone from the database entirely, and we know that rather than guessing it: a
      // delete between the snapshot and here takes the file with it, so there is nothing to add
      // and nothing that a retry will recover. Say so in the README rather than dropping it.
      if (fresh && !fresh.has(r.id)) { missing.push({ id: r.id, entry }); continue; }

      const file = path.join(UPLOADS_DIR, rel);
      // onDisk(), not existsSync: every row in a zip lives in ONE event folder, so this is a single
      // cached readdir (measured 542µs) instead of a synchronous NFS stat per photo (4µs warm, 143µs
      // COLD — at 14,000 photos ~2.0s of blocked event loop, with every other guest's request waiting
      // behind it). The same fix was made for the gallery path; the zip was left behind.
      //
      // The confirming existsSync only runs on a MISS, and it is there because the cache is wrong
      // in both directions, not just one. The listing is up to LISTING_TTL_MS old, so a file that
      // a rotation created a moment ago is not in it — and without this second look that freshly
      // written, perfectly present photo would be reported to the guest as missing. One stat on
      // the rare miss costs nothing; the false accusation would be worse than the original bug.
      // `await fs.promises.access`, not `fs.existsSync`. The comment above is about avoiding a
      // synchronous stat per photo on an NFS share — ~143µs cold, which at 14,000 photos is two
      // seconds of BLOCKED event loop with every other guest's request queued behind it. Reaching
      // for existsSync on the miss path put that straight back: the miss path is rare for one
      // rotated photo and it is EVERY row for a purged event or a mass rotation, which is exactly
      // when the origin can least afford to stop answering. Awaiting costs this download the same
      // wall-clock and costs everybody else nothing.
      if (!onDisk(rel) && !(await exists(file))) { missing.push({ id: r.id, entry }); continue; }

      entryFor.set(file, { entry, id: r.id });
      queued++;
      archive.file(file, { name: entry });
    }
  }

  // Everything is queued; wait for archiver to have actually resolved each one before deciding
  // what to say about the result.
  //
  // WITH A WATCHDOG, because the counting is the load-bearing part and it is only as complete as
  // the three events it listens to. Archiver settles a queued entry through 'entry', 'warning' or
  // 'error'; if it ever finds a fourth way to abandon one — or if somebody removes a listener —
  // `settled` never reaches `queued`, this promise never resolves, and the guest's download hangs
  // open for ever with no error and no bytes. A missing photo is a bad outcome; a response that
  // never ends is a worse one, and it is the failure mode that silence produces.
  //
  // IDLE, not total: the wait is legitimately minutes on a 400-photo event over NFS, so a total
  // timeout would cut healthy downloads short. What is never legitimate is nothing settling at
  // all for two minutes while entries are outstanding.
  await waitForSettle();

  // The socket is already destroyed and the body deliberately unterminated — see onZipStreamError.
  // Appending anything now would be a QUEUECLOSED error on a stream nobody is reading.
  if (failed) return missing.map((m) => m.entry);

  // ── One last look, before we admit to anything ────────────────────────────────────────────
  //
  // Everything above narrows the race; this closes most of what is left of it. Resolving names in
  // batches of 50 means a row is read at most fifty files before it is queued — but "at most fifty
  // files" is still tens of seconds on a large event over NFS, and a rotate landing inside that
  // window produced a README entry for a photo that was never actually lost. It had simply moved
  // again, and we reported the last place we looked.
  //
  // By the time the queue has drained we know exactly which entries failed, and — because they are
  // carrying their ids — exactly which rows to go and ask about. One more select, one stat each,
  // and the overwhelmingly common cause of a miss (a rename, which is entirely recoverable) is
  // recovered. What is left after this is the genuinely unrecoverable kind: a deleted row, or a
  // file that is not on the share at all.
  //
  // ONE pass, deliberately, and not a loop. Each pass narrows the window by the time the previous
  // one took, so the second would be defending against a rename landing inside a few milliseconds
  // of database round trip — while adding a way for a pathological event to keep this function
  // alive indefinitely. The README is the right answer to the residue, and it is now telling the
  // truth about it rather than reporting a photo that was merely in motion.
  //
  // `fs.existsSync`, not `onDisk()`: the readdir cache is up to LISTING_TTL_MS old and a file that
  // has just been written is precisely what it will not know about — which is the entire case this
  // pass exists for. The retry set is small and rare, so the stats are affordable here in a way
  // they are not in the main loop.
  if (missing.length) {
    const ids = [...new Set(missing.map((m) => m.id).filter((id): id is string => id !== null))];
    let recovered = 0;
    if (ids.length) {
      try {
        const nowRows = await db
          .select({ id: photos.id, filename: photos.filename, mediaType: photos.mediaType,
                    captureShape: photos.captureShape })
          .from(photos)
          .where(inArray(photos.id, ids));
        const byId = new Map(nowRows.map((p) => [p.id, p as MediaRow]));
        for (const m of missing) {
          if (m.id === null) continue;
          const cur = byId.get(m.id);
          if (!cur) continue;                       // the row really is gone
          const file = path.join(UPLOADS_DIR, downloadFile(cur));
          if (!(await exists(file))) continue;      // and neither is the file, under any name
          // The entry keeps the name it was always going to have. The numbering is positional so
          // that two downloads of one event agree, and a photo recovered here must not be renamed
          // just because it arrived late — it goes in at the end of the archive under its original
          // name, which is the only part of it anybody sees.
          entryFor.set(file, { entry: m.entry, id: m.id });
          queued++;
          archive.file(file, { name: m.entry });
          m.done = true;
          recovered++;
        }
      } catch (e) {
        // Nothing is lost by failing here: every one of these was already going into the README.
        console.error('[zip] the recovery pass could not re-read %d rows:', ids.length, e);
      }
    }
    if (recovered) {
      console.error('[zip] "%s": recovered %d of %d missing entries on the second look',
                    evName, recovered, missing.length);
      missing = missing.filter((m) => !m.done);
      // Filtered BEFORE the wait on purpose: a recovered entry that fails AGAIN re-enters `missing`
      // through the warning handler during this await, and has then earned its place in the README.
      //
      // THE SAME GUARDED WAIT as the first one, and that is the entire change here. This was a
      // bare promise with neither an idle timer nor an onSettle hook — so an entry the recovery
      // pass re-queued and archiver then abandoned hung the response exactly as the first wait
      // used to, seventy lines below the watchdog written to stop it. The newer code had quietly
      // reintroduced the older bug, which is the argument for there being one way to wait here
      // rather than two.
      await waitForSettle();
      if (failed) return missing.map((m) => m.entry);
    }
  }

  const names = missing.map((m) => m.entry);
  if (names.length) {
    console.error('[zip] "%s": %d of %d entries could not be included', evName, names.length, rows.length);
    archive.append(missingManifest(rows.length, names), { name: `${evName} - MISSING PHOTOS.txt` });
  }
  // RACED, not awaited bare. finalize() resolves when the zip module emits `end`, so on a healthy
  // download finalize wins every time and nothing here changes by a millisecond. What the race
  // defends against is the other end going away DURING that last flush: res.on('close') aborts the
  // archiver, an aborted archiver unpipes its module and never ends it, and the promise finalize
  // already handed us would then never settle at all — stranding this function, its rows and its
  // archiver in memory for the life of the process over a socket that closed minutes ago.
  // `abandoned` resolves only once something has already written the download off, so it cannot
  // cut a working one short, and a finalize() that rejects after the race has settled is handled
  // by the race itself rather than surfacing as an unhandled rejection.
  await Promise.race([archive.finalize(), abandoned]);
  return names;
}

// ── Who may hold a copy of this answer ─────────────────────────────────────────
//
// Exactly two possibilities, and they are deliberately two FUNCTIONS rather than two strings, so
// that "which one did this branch send?" is a thing grep answers in one line.
//
// The only cacheable photos response is the public gallery one, and it is cacheable only because
// it is the same bytes for everybody. Everything else — organizer, participant, ?own=true, anything
// reached with a session token — is per-viewer by construction and is marked so no intermediary
// may hold it: Cloudflare, a corporate proxy, a captive-portal cache on venue wifi.
const cacheableFor = (res: Response, seconds: number) => {
  res.set('Cache-Control', galleryCacheControl(seconds));
  // The organizer branch is selected by a request HEADER on this same URL, and a cache key is
  // host+path+query — headers are not in it. Today that is harmless only because the organizer
  // branch answers `private, no-store` and so is never stored; drop that one line and a shared
  // cache would start handing the host's view to strangers. Vary states the dependency where the
  // `public` is set, so the two cannot drift apart. Costs nothing: requests without the header
  // (every real gallery visitor) still share one entry.
  res.vary('x-organizer-code');
};
export const perViewer = (res: Response) => { res.set('Cache-Control', 'private, no-store'); };

// ── GET /api/photos/:joinCode — fetch photos ───────────────────────────────────

router.get('/:joinCode', async (req: Request, res: Response) => {
  const { gallery, highlightsOnly } = req.query;
  // Secrets ride in headers (fall back to query for older links).
  // HEADER ONLY. The organizer code is a full per-event admin capability (rename, moderate, delete,
  // download originals, email every guest) and nginx logs "$request" — so a query-string copy writes
  // the secret into the access log, the browser history and every proxy in between. The zip route
  // and requireOrganizer both say this already; this fallback is the one that drifted, and nothing
  // in web/src has ever sent it.
  const organizerCode = req.get('x-organizer-code');
  // Header (or body) only — never the query string. nginx logs "$request", so a token in a
  // URL is written into the access log, the browser history and every proxy between. The zip
  // route is the ONE justified exception and says so: it is reached by navigating, and a
  // navigation cannot carry a header. Everything here is a fetch.
  const sessionToken  = req.get('x-session-token');
  const raw = String(req.params.joinCode);

  const [event] = await db.select().from(events)
    .where(or(eq(events.joinCode, raw.toUpperCase()), eq(events.slug, raw.toLowerCase())))
    // JOIN CODE WINS on a tie — see isSlugAvailable in routes/events.ts for how the two namespaces
    // can collide, and eventByIdentifier for the same rule written out.
    .orderBy(sql`CASE WHEN ${events.joinCode} = ${raw.toUpperCase()} THEN 0 ELSE 1 END`)
    .limit(1);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const revealed = isRevealed(event);
  // Visible set for guests/gallery: moderation on → only approved; off → anything not binned.
  const visible = event.moderationEnabled ? eq(photos.status, 'approved') : ne(photos.status, 'rejected');
  const captions = challengeCaptions(event.challenges);

  // ── Organizer mode — sees all photos regardless of reveal state ───────────
  if (organizerCode) {
    if (organizerCode !== event.organizerCode)
      return res.status(403).json({ error: 'Invalid organizer code' });
    perViewer(res);
    const rows = await db
      .select({
        id:              photos.id,
        filename:        photos.filename,
        takenAt:         photos.takenAt,
        isHighlighted:   photos.isHighlighted,
        rating:          photos.rating,
        participantId:   photos.participantId,
        challengeId:     photos.challengeId,
        caption:         photos.caption,
        mediaType:       photos.mediaType,
        sizeBytes:       photos.sizeBytes,
        width:           photos.width,
        height:          photos.height,
        durationMs:      photos.durationMs,
        captureOrientation: photos.captureOrientation,
        captureRotation: photos.captureRotation,
        captureTurn: photos.captureTurn,
        captureShape: photos.captureShape,
        status:          photos.status,
        participantName: participants.name,
      })
      .from(photos)
      .innerJoin(participants, eq(participants.id, photos.participantId))
      .where(highlightsOnly === 'true'
        ? and(eq(photos.eventId, event.id), eq(photos.isHighlighted, true))
        : eq(photos.eventId, event.id))
      // `photos.id` last — `taken_at` is a millisecond bigint, and a burst of shots (or a bulk
      // import) shares it. Without it the gallery reorders under the host between refreshes, and
      // the numbering in a zip of the same event disagrees with what they are looking at.
      .orderBy(desc(photos.takenAt), asc(photos.id));
    // Undefined when the host has hearts off, so the fields are absent from the payload rather
    // than sent as zeroes — a client must not be able to draw an empty heart on a gallery
    // where hearting is not a thing you can do.
    // Undefined when the host has comments off — which is EVERY event by default, so most
    // galleries never carry the field at all. Absent, not zero: a client must not draw an
    // empty thread on a gallery where commenting is not a thing you can do.
    const comments = event.commentsEnabled
      ? await commentsFor(event.id, rows.map((r) => r.id))
      : undefined;
    const hearts = event.heartsEnabled
      ? await heartsFor(event.id, rows.map((r) => r.id), null)
      : undefined;
    return res.json({
      revealed: true,
      allowDownloads: !!event.allowDownloads,
      moderationEnabled: !!event.moderationEnabled,
      photos: rows.map(p => photoRow(p, null, captions, hearts, comments)),
    });
  }

  // ── Gallery (view-only) mode ──────────────────────────────────────────────
  if (gallery === 'true') {
    if (!revealed) {
      const [{ c: photoCount }] = await db.select({ c: count() }).from(photos)
        .where(and(eq(photos.eventId, event.id), visible));
      const revealAt = scheduledRevealAt(event);
      // The LOCK WALL, cached. Capped so the entry always expires before `revealAt` — a stale
      // "not yet" served after the reveal fired is the one failure this whole rule exists to
      // prevent. A manual reveal gets seconds; a reveal minutes away gets the full minute.
      cacheableFor(res, galleryCacheSeconds({ revealed: false, revealAt, revealMode: event.revealMode, now: Date.now() }));
      // `awaitingHost` and not `revealHidden`: a guest needs to know whether asking would change
      // anything, not whether the host actively hid the photos or simply has not revealed them yet.
      // False for a timed reveal — the countdown is the whole answer there, and sending somebody to
      // badger the host about a clock is worse than saying nothing.
      return res.json({ revealed: false, photoCount, revealMode: event.revealMode, revealAt,
        awaitingHost: !!event.revealHidden || event.revealMode === 'manual' });
    }
    // ── Sorting by hearts, ACROSS THE WHOLE EVENT ──────────────────────────────
    //
    // The client used to sort whatever it had loaded, which with paging means "the most hearted of
    // the first hundred" — a different answer on every scroll position, and never the real one. A
    // sort has to happen where all the rows are, so it happens here.
    //
    // One grouped pass over this event's hearts (keyed by `photo_hearts_event_photo_idx`), hash
    // joined to the page. NOT a correlated subquery per row: that is one index lookup per photo in
    // the event, every time, and the ORDER BY needs all of them before it can take a hundred.
    //
    // The cursor is `<hearts>_<takenAt>_<id>` for this sort rather than `<takenAt>_<id>` — same
    // idea, the row's own place in the order. Ties are the normal case here (everything with zero),
    // which is exactly why the rest of the key is not optional.
    //
    // Tied photos stay in NEWEST-FIRST order, the same order the default sort puts them in. The
    // tie used to break on the id alone — a uuid, so effectively at random — and on a small event
    // where everything has exactly one heart that shuffled the whole gallery for no reason a guest
    // could see: switching to Most loved reordered photos that were all equally loved.
    const byHearts = req.query.sort === 'hearted' && event.heartsEnabled;
    if (byHearts) {
      const wantedH = pageLimit(req.query.limit);
      const cur = typeof req.query.after === 'string' ? req.query.after : '';
      const cut = cur.indexOf('_');
      const cut2 = cut > 0 ? cur.indexOf('_', cut + 1) : -1;
      const aN = cut > 0 ? Number(cur.slice(0, cut)) : null;
      const aT = cut2 > 0 ? Number(cur.slice(cut + 1, cut2)) : null;
      const aId = cut2 > 0 ? cur.slice(cut2 + 1) : null;
      // SPELLED OUT, not a row-value comparison. `(a, b) < (x, y)` is only equivalent to a keyset
      // when BOTH columns sort the same way, and this order is `hearts DESC, id ASC` — mixed. The
      // row-value form silently asked for a SMALLER id on a tie, which re-served rows that were
      // already on the previous page (measured: 6 of 8 repeated). Ties are the normal case here,
      // because most photos have no hearts at all, so this is the common path and not an edge.
      const keyset = (aN !== null && Number.isFinite(aN) && aT !== null && Number.isFinite(aT) && aId)
        ? sql`AND (COALESCE(h.n, 0) < ${aN}::bigint
                   OR (COALESCE(h.n, 0) = ${aN}::bigint AND p.taken_at < ${aT})
                   OR (COALESCE(h.n, 0) = ${aN}::bigint AND p.taken_at = ${aT} AND p.id > ${aId}))`
        : sql``;
      const visSql = event.moderationEnabled
        ? sql`p.status = 'approved'`
        : sql`p.status <> 'rejected'`;
      const onlyStarred = highlightsOnly === 'true' ? sql`AND p.is_highlighted = true` : sql``;
      const hearted = await db.execute(sql`
        SELECT p.id, p.filename, p.taken_at AS "takenAt", p.is_highlighted AS "isHighlighted",
               p.participant_id AS "participantId", p.challenge_id AS "challengeId", p.caption,
               p.media_type AS "mediaType", p.size_bytes AS "sizeBytes", p.width, p.height,
               p.duration_ms AS "durationMs", p.capture_orientation AS "captureOrientation",
               p.capture_rotation AS "captureRotation", p.capture_turn AS "captureTurn",
               p.capture_shape AS "captureShape", pa.name AS "participantName",
               COALESCE(h.n, 0)::int AS hearts
        FROM photos p
        JOIN participants pa ON pa.id = p.participant_id
        LEFT JOIN (SELECT photo_id, count(*) AS n FROM photo_hearts
                   WHERE event_id = ${event.id} GROUP BY photo_id) h ON h.photo_id = p.id
        WHERE p.event_id = ${event.id} AND ${visSql} ${onlyStarred} ${keyset}
        -- DESC on the count, then DESC on the age, then ASC on the id: the keyset above spells out
        -- this exact ordering, so the two must be changed together or paging silently skips rows.
        ORDER BY COALESCE(h.n, 0) DESC, p.taken_at DESC, p.id ASC
        LIMIT ${wantedH + 1}
      `);
      const hRows = (hearted.rows ?? hearted) as Array<Record<string, unknown>>;
      const moreH = hRows.length > wantedH;
      if (moreH) hRows.length = wantedH;
      const lastH = hRows[hRows.length - 1];
      const nextH = moreH && lastH ? `${lastH.hearts}_${lastH.takenAt}_${lastH.id}` : null;
      const idsH = hRows.map((r) => String(r.id));
      const [totH] = await db.select({
        visible:    sql<number>`count(*) FILTER (WHERE ${visible})`,
        highlights: sql<number>`count(*) FILTER (WHERE ${visible} AND ${photos.isHighlighted} = true)`,
      }).from(photos).where(eq(photos.eventId, event.id));
      const capsH = challengeCaptions(event.challenges);
      const cmtH = event.commentsEnabled ? await commentsFor(event.id, idsH) : undefined;
      const hrtH = await heartsFor(event.id, idsH, null);
      cacheableFor(res, galleryCacheSeconds({ revealed: true, revealAt: scheduledRevealAt(event), revealMode: event.revealMode, now: Date.now() }));
      return res.json({
        revealed: true,
        hasHighlights: Number(totH.highlights) > 0,
        nextCursor: nextH,
        photoCount: Number(totH.visible),
        pendingCount: 0,
        allowDownloads: !!event.allowDownloads,
        moderationEnabled: !!event.moderationEnabled,
        revealMode: event.revealMode,
        revealAt: scheduledRevealAt(event),
        // Shaped explicitly rather than cast. The rows come back from raw SQL as `unknown`, and an
        // `as never` at the call site hid the one thing that matters here from the guard test in
        // gallery-cache.test.ts: the SECOND argument is the viewer, and on this branch it must be
        // null or a shared cache will hand one guest's gallery to another.
        photos: hRows.map((row) => {
          const p = {
            id: String(row.id), filename: String(row.filename), takenAt: Number(row.takenAt),
            participantName: String(row.participantName), participantId: String(row.participantId),
            challengeId: row.challengeId == null ? null : String(row.challengeId),
            caption: row.caption == null ? null : String(row.caption),
            isHighlighted: !!row.isHighlighted,
            mediaType: row.mediaType == null ? null : String(row.mediaType),
            sizeBytes: row.sizeBytes == null ? null : Number(row.sizeBytes),
            width: row.width == null ? null : Number(row.width),
            height: row.height == null ? null : Number(row.height),
            durationMs: row.durationMs == null ? null : Number(row.durationMs),
            captureOrientation: row.captureOrientation == null ? null : String(row.captureOrientation),
            captureRotation: row.captureRotation == null ? null : Number(row.captureRotation),
            captureTurn: row.captureTurn == null ? null : Number(row.captureTurn),
            captureShape: row.captureShape == null ? null : String(row.captureShape),
          };
          return photoRow(p, null, capsH, hrtH, cmtH);
        }),
      });
    }

    const rows = await db
      .select({
        id:              photos.id,
        filename:        photos.filename,
        takenAt:         photos.takenAt,
        isHighlighted:   photos.isHighlighted,
        participantId:   photos.participantId,
        challengeId:     photos.challengeId,
        caption:         photos.caption,
        mediaType:       photos.mediaType,
        sizeBytes:       photos.sizeBytes,
        width:           photos.width,
        height:          photos.height,
        durationMs:      photos.durationMs,
        captureOrientation: photos.captureOrientation,
        captureRotation: photos.captureRotation,
        captureTurn: photos.captureTurn,
        captureShape: photos.captureShape,
        participantName: participants.name,
      })
      .from(photos)
      .innerJoin(participants, eq(participants.id, photos.participantId))
      .where(and(
        highlightsOnly === 'true'
          ? and(eq(photos.eventId, event.id), visible, eq(photos.isHighlighted, true))
          : and(eq(photos.eventId, event.id), visible),
        keysetAfter(req.query.after) ?? undefined,
      ))
      .orderBy(desc(photos.takenAt), asc(photos.id))   // newest first, `id` last so it is a total order
      // One more than asked for, purely to answer "is there another page?" without a second query.
      // The extra row is sliced off below and never reaches the client.
      .limit(pageLimit(req.query.limit) + 1);
    // Both numbers are in `rows` already, and `rows` is the same filtered set the counts were
    // asking the database to re-derive. Unfiltered, `rows` IS (event, visible), so it answers both
    // — the starred total is a filter over rows that carry `isHighlighted`. Under ?highlightsOnly,
    // `rows` IS the starred set, so it answers that one exactly, and only the event-wide visible
    // total still has to be asked for (it deliberately ignores the filter — the client needs it to
    // tell "nothing here yet" from "nothing starred yet"). Two queries become one, or none.
    const wanted = pageLimit(req.query.limit);
    const hasMore = rows.length > wanted;
    if (hasMore) rows.length = wanted;                  // drop the probe row
    const last = rows[rows.length - 1];
    const nextCursor = hasMore && last ? `${last.takenAt}_${last.id}` : null;

    // COUNTED, not derived from `rows` — `rows` is one page now, so "how many are there" and "are
    // any starred" cannot be read off it any more. One scan answers both, and it is the event-wide
    // answer either way: the client needs it to tell "nothing here yet" from "nothing starred yet",
    // which is a distinction ?highlightsOnly would otherwise erase.
    const [totals] = await db.select({
      visible:    sql<number>`count(*) FILTER (WHERE ${visible})`,
      highlights: sql<number>`count(*) FILTER (WHERE ${visible} AND ${photos.isHighlighted} = true)`,
    }).from(photos).where(eq(photos.eventId, event.id));
    const hasHighlights = Number(totals.highlights) > 0;
    const visibleCount = Number(totals.visible);
    // The signal the revealed branch deliberately did not carry, and whose absence left a
    // moderated, revealed, genuinely-EMPTY gallery polling every 45 seconds for ever: the client
    // could not tell "the host is still approving" from "nobody took a photo", so it assumed the
    // former and never stopped asking. Counted only when moderation is on — with it off there is
    // no queue and the extra query would buy nothing.
    const pendingCount = event.moderationEnabled
      ? (await db.select({ c: count() }).from(photos)
          .where(and(eq(photos.eventId, event.id), eq(photos.status, 'pending'))))[0].c
      : 0;
    cacheableFor(res, galleryCacheSeconds({ revealed: true, revealAt: scheduledRevealAt(event), revealMode: event.revealMode, now: Date.now() }));
    // Undefined when the host has hearts off, so the fields are absent from the payload rather
    // than sent as zeroes — a client must not be able to draw an empty heart on a gallery
    // where hearting is not a thing you can do.
    // Undefined when the host has comments off — which is EVERY event by default, so most
    // galleries never carry the field at all. Absent, not zero: a client must not draw an
    // empty thread on a gallery where commenting is not a thing you can do.
    const comments = event.commentsEnabled
      ? await commentsFor(event.id, rows.map((r) => r.id))
      : undefined;
    const hearts = event.heartsEnabled
      // null on purpose: see photoRow. This reply is cached and shared, so it carries counts and
      // never "did YOU heart it".
      ? await heartsFor(event.id, rows.map((r) => r.id), null)
      : undefined;
    return res.json({
      revealed: true, hasHighlights,
      // Null once there is nothing after this page. The client keeps asking while it is a string,
      // which is what makes the grid feel like one uninterrupted scroll rather than pages.
      nextCursor,
      photoCount: visibleCount, pendingCount,
      // The reveal fields ride on the REVEALED answer too, and did not used to. The gallery page
      // sets revealAt from `data.revealAt ?? null` on every load, so a revealed reply without them
      // silently wiped the instant the gallery unlocked — which is what `justRevealed` (the 48h
      // "you have just been let in" window behind the referral card's emphasis) is computed from.
      // It has therefore been permanently false in production. They are also what lets a page that
      // polls its way THROUGH a reveal keep a coherent countdown.
      revealMode: event.revealMode,
      revealAt: scheduledRevealAt(event),
      // Moderation is a WHERE clause, not a gate: a moderated event answers revealed-with-no-photos
      // for as long as the host has approved nothing. Without this flag the gallery cannot tell
      // that case from "this event genuinely has no photos", so it said "No photos yet" and never
      // asked again.
      moderationEnabled: !!event.moderationEnabled,
      allowDownloads: !!event.allowDownloads,
      photos: rows.map(p => photoRow(p, null, captions, hearts, comments)),
    });
  }

  // ── Participant mode — session required ───────────────────────────────────
  // `?own=true` — just this guest's own shots.
  //
  // The camera's roll shows a guest their OWN photos and nothing else, and it used to fetch the
  // whole event to do it: after reveal this branch returns everyone's visible photos and the client
  // threw ~75% of them away with `.filter(p => p.isOwn)`. Measured on a real event: 93 rows and
  // 50.8KB over the wire to render 23. That is the surface most likely to be on a phone on venue
  // wifi, so the filter belongs here.
  //
  // The counts the roll still needs about the REST of the event ("is there anything in the shared
  // gallery worth linking to?") come back as numbers instead — see ownCount/othersCount below.
  if (!sessionToken) return res.status(403).json({ error: 'sessionToken required' });

  // Everything past this line is built with a real participant id — `isOwn` per row,
  // `myParticipantId` on the envelope, and under ?own=true a body that is literally one guest's
  // photographs. An intermediary holding any of it would hand one guest's answer to the next.
  perViewer(res);

  const [participant] = await db.select({ id: participants.id }).from(participants)
    .where(and(eq(participants.sessionToken, String(sessionToken)), eq(participants.eventId, event.id)));
  if (!participant) return res.status(403).json({ error: 'Not a participant' });

  const ownOnly = req.query.own === 'true';
  /** This guest's own shots, whatever their moderation status — the same set the own-clause below
   *  lets through, and the same set the pre-reveal branch has always returned. */
  const mine = eq(photos.participantId, participant.id);

  if (!revealed) {
    const [{ c: photoCount }] = await db.select({ c: count() }).from(photos)
      .where(and(eq(photos.eventId, event.id), visible));
    // Even before the gallery is revealed, a participant can always see their OWN shots.
    const ownRows = await db
      .select({
        id:              photos.id,
        filename:        photos.filename,
        takenAt:         photos.takenAt,
        isHighlighted:   photos.isHighlighted,
        rating:          photos.rating,
        participantId:   photos.participantId,
        challengeId:     photos.challengeId,
        caption:         photos.caption,
        mediaType:       photos.mediaType,
        sizeBytes:       photos.sizeBytes,
        width:           photos.width,
        height:          photos.height,
        durationMs:      photos.durationMs,
        captureOrientation: photos.captureOrientation,
        captureRotation: photos.captureRotation,
        captureTurn: photos.captureTurn,
        captureShape: photos.captureShape,
        status:          photos.status,
        participantName: participants.name,
      })
      .from(photos)
      .innerJoin(participants, eq(participants.id, photos.participantId))
      .where(and(eq(photos.eventId, event.id), eq(photos.participantId, participant.id)))
      .orderBy(desc(photos.takenAt), asc(photos.id));   // newest first, `id` last for a total order
    // Undefined when the host has hearts off, so the fields are absent from the payload rather
    // than sent as zeroes — a client must not be able to draw an empty heart on a gallery
    // where hearting is not a thing you can do.
    // Undefined when the host has comments off — which is EVERY event by default, so most
    // galleries never carry the field at all. Absent, not zero: a client must not draw an
    // empty thread on a gallery where commenting is not a thing you can do.
    const comments = event.commentsEnabled
      ? await commentsFor(event.id, ownRows.map((r) => r.id))
      : undefined;
    const hearts = event.heartsEnabled
      ? await heartsFor(event.id, ownRows.map((r) => r.id), participant.id)
      : undefined;
    return res.json({ revealed: false, photoCount, revealMode: event.revealMode,
      awaitingHost: !!event.revealHidden || event.revealMode === 'manual',
      revealAt: scheduledRevealAt(event),
      // Already own-only, whether or not ?own was asked for. othersCount is 0 rather than the real
      // number on purpose: before the reveal there is nothing of anyone else's this guest may see,
      // and the count exists to answer "is there a gallery worth linking to yet".
      ownCount: ownRows.length, othersCount: 0,
      myParticipantId: participant.id, photos: ownRows.map(p => photoRow(p, participant.id, captions, hearts, comments)) });
  }

  const rows = await db
    .select({
      id:              photos.id,
      filename:        photos.filename,
      takenAt:         photos.takenAt,
      isHighlighted:   photos.isHighlighted,
      participantId:   photos.participantId,
      challengeId:     photos.challengeId,
      caption:         photos.caption,
      mediaType:       photos.mediaType,
      sizeBytes:       photos.sizeBytes,
      width:           photos.width,
      height:          photos.height,
      durationMs:      photos.durationMs,
      captureOrientation: photos.captureOrientation,
      captureRotation: photos.captureRotation,
      captureTurn: photos.captureTurn,
      captureShape: photos.captureShape,
      participantName: participants.name,
    })
    .from(photos)
    .innerJoin(participants, eq(participants.id, photos.participantId))
    // A participant ALWAYS sees their own shots (even pending under moderation, or after the gallery
    // is revealed) — plus everyone else's visible photos. Without the own-clause, a guest who keeps
    // shooting after reveal would watch their new (pending) snaps vanish from their own gallery.
    .where(and(
      eq(photos.eventId, event.id),
      // own-only collapses the or-clause to its second half, which is exactly the set the client
      // used to filter down to: the same rows, none of the transfer.
      ownOnly ? mine : or(visible, mine),
      ...(highlightsOnly === 'true' ? [eq(photos.isHighlighted, true)] : []),
    ))
    .orderBy(desc(photos.takenAt), asc(photos.id));   // newest first, `id` last for a total order
  // THREE numbers, ONE scan. These were three separate COUNT queries over the same event, on a
  // request every guest makes — three passes of the same index to answer three questions about the
  // same rows. `count(*) FILTER (WHERE …)` asks all three in one go.
  //
  // The two roll numbers are counted rather than inferred so they stay right under ?highlightsOnly,
  // which shrinks `rows` but says nothing about the event.
  const [tallies] = await db.select({
    highlights: sql<number>`count(*) FILTER (WHERE ${photos.isHighlighted} = true AND ${visible})`,
    own:        sql<number>`count(*) FILTER (WHERE ${mine})`,
    others:     sql<number>`count(*) FILTER (WHERE ${visible} AND ${photos.participantId} <> ${participant.id})`,
  }).from(photos).where(eq(photos.eventId, event.id));
  const hasHighlights = Number(tallies.highlights) > 0;
  const ownCount = Number(tallies.own);
  const othersCount = Number(tallies.others);

  // Undefined when the host has hearts off, so the fields are absent from the payload rather
  // than sent as zeroes — a client must not be able to draw an empty heart on a gallery
  // where hearting is not a thing you can do.
  // Undefined when the host has comments off — which is EVERY event by default, so most
  // galleries never carry the field at all. Absent, not zero: a client must not draw an
  // empty thread on a gallery where commenting is not a thing you can do.
  const comments = event.commentsEnabled
    ? await commentsFor(event.id, rows.map((r) => r.id))
    : undefined;
  const hearts = event.heartsEnabled
    ? await heartsFor(event.id, rows.map((r) => r.id), participant.id)
    : undefined;
  res.json({
    revealed: true, hasHighlights,
    allowDownloads: !!event.allowDownloads,
    ownCount, othersCount,
    myParticipantId: participant.id,
    photos: rows.map(p => photoRow(p, participant.id, captions, hearts, comments)),
  });
});

export default router;
