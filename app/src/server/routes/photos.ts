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
         cropClipToShape, cropName, dlName, shapeRatio } from '../images';
import { probeVideoMeta } from '../slideshow';
import { isRevealed } from '../lib';
import { scheduledRevealAt, galleryCacheSeconds, galleryCacheControl } from '../../../../shared/reveal';
import { eventByIdentifier } from './events';
import { billingEnabled } from '../billing';

const router = Router();

import { UPLOADS_DIR, INCOMING_DIR, eventDir, eventRelPath } from '../paths';
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

/** Did this row ask for a shape the camera may not have given it? */
const wantsCrop = (p: { mediaType?: string | null; captureShape?: string | null }): boolean =>
  p.mediaType === 'video' && !!p.captureShape && p.captureShape !== 'full';

/** The cropped sibling's name, but only once the file is really there. Existence IS the flag: the
 *  crop runs after the upload response and can fail, so a column saying "cropped" could point at a
 *  file that was never written. */
function cropped(p: PhotoRowInput): string | null {
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
export function playFile(p: PhotoRowInput): string | null {
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
export function downloadFile(p: { filename: string; mediaType?: string | null; captureShape?: string | null }): string {
  if (!wantsCrop(p)) return p.filename;
  const dl = dlName(p.filename);
  if (onDisk(dl)) return dl;
  const crop = cropName(p.filename);
  return onDisk(crop) ? crop : p.filename;
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
    // Only ever sent when it is 'landscape'. The gallery's single use is a "shot sideways" mark,
    // and 'portrait'/null/unknown all mean "say nothing" — shipping those would put three values on
    // the wire to distinguish states no reader distinguishes.
    shotSideways:    p.captureOrientation === 'landscape' ? true : undefined,
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
};

async function participantForUpload(sessionToken: string): Promise<UploadParticipant | null> {
  const [p] = await db.select({
    id: participants.id, photosTaken: participants.photosTaken, maxPhotos: events.maxPhotos,
    extraPhotos: participants.extraPhotos,
    isLocked: events.isLocked, startsAt: events.startsAt, expiresAt: events.expiresAt,
    eventId: events.id, moderationEnabled: events.moderationEnabled, videoSeconds: events.videoSeconds,
    challengeSet: participants.challengeSet, eventChallenges: events.challenges,
    aspectRatios: events.aspectRatios,
  }).from(participants).innerJoin(events, eq(events.id, participants.eventId))
    .where(eq(participants.sessionToken, sessionToken));
  return p ?? null;
}

// Returns {status,error} to reject the upload, or null if it's allowed right now.
function gateUpload(p: UploadParticipant, isVideo: boolean): { status: number; error: string } | null {
  // Self-host (billing off) is the FULL app — that is the pitch, and the licence. An unset
  // VIDEO_MAX_SECONDS therefore means "no per-event limit", NOT "video disabled": the old reading
  // silently refused every video upload on a fresh self-hosted install with no error a self-hoster
  // could act on. Set VIDEO_MAX_SECONDS to a positive number to cap it. Only a HOSTED deployment
  // gates video behind the paid add-on.
  const allowedVideoSecs = billingEnabled
    ? p.videoSeconds
    : (VIDEO_MAX_SECS > 0 ? VIDEO_MAX_SECS : Number.POSITIVE_INFINITY);
  if (isVideo && billingEnabled && allowedVideoSecs === 0) {
    return { status: 403, error: 'Video uploads are not enabled for this event' };
  }
  const now = Date.now();
  if (p.startsAt && now < p.startsAt)     return { status: 403, error: "Event hasn't started yet" };
  if (p.isLocked)                         return { status: 403, error: 'Event is locked' };
  if (now > p.expiresAt)                  return { status: 410, error: 'Event has ended' };
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
                              orientationRaw?: unknown, shapeRaw?: unknown) {
  const destDir = eventDir(p.eventId);
  fs.mkdirSync(destDir, { recursive: true });
  const baseName = path.basename(stagedPath);                       // <uuid>.ext
  const finalPath = path.join(destDir, baseName);
  fs.renameSync(stagedPath, finalPath);
  const storedName = eventRelPath(p.eventId, baseName);             // "<eventId>/<uuid>.ext"
  const sizeBytes = fs.statSync(finalPath).size;

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
    void fixAudioLead(finalPath)
      .catch(() => false)
      .then(() => makePlaybackProxy(finalPath))
      .catch(() => false);
    // Enforce the event's video length limit server-side (defense-in-depth): the in-browser recorder
    // auto-stops at the limit, but a native-camera clip could be any length. Only when we can read a
    // real duration; +3s tolerance for container rounding.
    const allowed = billingEnabled
      ? p.videoSeconds
      : (VIDEO_MAX_SECS > 0 ? VIDEO_MAX_SECS : Number.POSITIVE_INFINITY);
    if (allowed > 0 && typeof dims.durationMs === 'number') {
      const secs = dims.durationMs / 1000;
      const cap = Math.min(VIDEO_GRACE_SECS > 0 ? allowed + VIDEO_GRACE_SECS : VIDEO_HARD_MAX_SECS, VIDEO_HARD_MAX_SECS);
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
      mediaType: isVideo ? 'video' : 'photo', takenAt: Date.now(), status,
      challengeId,
      sizeBytes, width: dims.width ?? null, height: dims.height ?? null, durationMs: dims.durationMs ?? null,
      source,
      captureOrientation: readOrientation(orientationRaw),
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
      void cropClipToShape(path.join(destDir, baseName), shape)
        // The poster is cut from the original, so it shows the uncropped frame. Re-cut it from the
        // cropped file so the grid thumbnail matches the clip it opens.
        .then((ok) => { if (ok) return makeVideoPoster(path.join(destDir, cropName(baseName))); })
        .catch(() => { /* the original still plays */ });
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
    const [gone] = await tx.delete(photos).where(eq(photos.id, photo.id)).returning({ id: photos.id });
    if (!gone) return null;
    const [row] = await tx.update(participants)
      .set({ photosTaken: sql`greatest(${participants.photosTaken} - 1, 0)` })
      .where(eq(participants.id, me.id))
      .returning({ photosTaken: participants.photosTaken, extraPhotos: participants.extraPhotos });
    return row ?? null;
  });
  // Another request got there first. Same answer as "never existed" — see above.
  if (!gaveBack) return res.status(404).json({ error: 'Photo not found' });
  const cropFile = cropName(photo.filename);
  for (const f of [photo.filename, photo.filename.replace(/\.[^.]+$/, '_thumb.webp'), playName(photo.filename),
                   cropFile, thumbName(cropFile), playName(cropFile), dlName(photo.filename)]) {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch { /* already gone is fine */ }
  }

  // Mission progress is DERIVED from the photos table, so this delete may have just un-ticked a
  // trick — and the client cannot work that out for itself: the gallery payload carries the
  // mission's TEXT (`challenge`), not its id. Re-derive it here, after the row is gone, and hand
  // back the authoritative list so the camera's trick list cannot sit on a tick the server has
  // already dropped. Costs one small query on an action a guest takes at most a handful of times.
  const { challengesDone } = await missionsFor(me.eventChallenges, me.challengeSet, me.id);

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
    .select({ id: photos.id, eventId: photos.eventId, participantId: photos.participantId })
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
      return res.json({ success: true, id: photo.id, caption });
    }
  }

  return res.status(404).json({ error: 'Photo not found' });
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
  const gate = gateUpload(participant, isVideo);
  if (gate) { fs.unlinkSync(req.file.path); return res.status(gate.status).json({ error: gate.error }); }

  try {
    return res.json(await finalizeUpload(participant, req.file.path, isVideo, req.body?.source === 'upload' ? 'upload' : 'capture', req.body?.challengeId, req.body?.captureOrientation, req.body?.captureShape));
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

  const isVideo = mediaType === 'video' || VIDEO_EXT_RE.test('x.' + String(ext || ''));
  const dir = uploadPartsDir(uploadId);
  const wipe = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } };

  const gate = gateUpload(participant, isVideo);
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
    return res.json(await finalizeUpload(participant, staged, isVideo, req.body?.source === 'upload' ? 'upload' : 'capture', req.body?.challengeId, req.body?.captureOrientation, req.body?.captureShape));
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
    .select({ filename: photos.filename, mediaType: photos.mediaType, captureShape: photos.captureShape,
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

  zipPhotosToResponse(res, event.name, rows);
});

// Stream a max-compression .zip of the given photo rows, named "<Event> - <Participant> - <n>.ext"
// where n is that participant's own capture-order number.
export function zipPhotosToResponse(
  res: Response,
  eventName: string,
  // captureShape is required, not optional: downloadFile needs it to tell that a clip asked for a
  // shape, and a caller that forgets it gets uncropped originals in the zip with no error anywhere.
  // Making it mandatory turns that into a compile failure instead of a silent wrong file.
  rows: { filename: string; mediaType: string | null; captureShape: string | null;
          participantId: string; participantName: string | null }[],
) {
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
  archive.on('error', (err: Error) => { console.error('[zip] failed:', err); res.destroy(); });
  archive.pipe(res);

  const perPerson = new Map<string, number>();
  for (const r of rows) {
    // The same file the gallery's own download button hands over — see downloadFile. Reading
    // r.filename here meant a clip the gallery showed cropped came out of the zip uncropped.
    const rel = downloadFile(r);
    const file = path.join(UPLOADS_DIR, rel);
    // onDisk(), not existsSync: every row in a zip lives in ONE event folder, so this is a single
    // cached readdir (measured 542µs) instead of a synchronous NFS stat per photo (4µs warm, 143µs
    // COLD — at 14,000 photos ~2.0s of blocked event loop, with every other guest's request waiting
    // behind it). The same fix was made for the gallery path; the zip was left behind.
    if (!onDisk(rel)) continue;
    const ext = r.mediaType === 'video' ? (rel.split('.').pop() || 'mp4') : 'jpg';
    const who = fileSafe(r.participantName || 'Guest') || 'Guest';
    const n = (perPerson.get(r.participantId) || 0) + 1; perPerson.set(r.participantId, n);
    archive.file(file, { name: `${evName} - ${who} - ${n}.${ext}` });
  }
  archive.finalize();
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
      return res.json({ revealed: false, photoCount, revealMode: event.revealMode, revealAt });
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
