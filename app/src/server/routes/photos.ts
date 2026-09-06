import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { ZipArchive } from 'archiver';
import { v4 as uuidv4 } from 'uuid';
import { and, asc, count, desc, eq, inArray, ne, or } from 'drizzle-orm';
import { db } from '../db';
import { effectiveMaxPhotos, hasShotsLeft, photosRemaining as remainingFor } from '../allowance';
import { matchNewPhoto } from './faces';
import { events, participants, photos } from '../schema';
import { stripImageMetadata, makeThumbnail, makeVideoPoster, thumbName } from '../images';
import { probeVideoMeta } from '../slideshow';
import { isRevealed } from '../lib';
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
const DELETE_WINDOW_MS = parseInt(process.env.PHOTO_DELETE_WINDOW_SECONDS || '60') * 1000;
// The UI arms a delete on the first tap and commits on the second. Someone who taps at 59s and
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
  isHighlighted: boolean;
  rating?: number | null;
  mediaType?: string | null;
  status?: string | null;
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
};

function photoRow(p: PhotoRowInput, myParticipantId: string | null) {
  return {
    id:              p.id,
    url:             `/uploads/${p.filename}`,                       // full-quality original (download + lightbox)
    thumbUrl:        `/uploads/${thumbName(p.filename)}`,            // fast grid thumbnail (photo or video poster)
    takenAt:         p.takenAt,
    participantName: p.participantName,
    participantId:   p.participantId,
    isHighlighted:   !!p.isHighlighted,
    rating:          p.rating ?? 0,
    mediaType:       p.mediaType || 'photo',
    status:          p.status || 'approved',
    sizeBytes:       p.sizeBytes ?? undefined,
    width:           p.width ?? undefined,
    height:          p.height ?? undefined,
    durationMs:      p.durationMs ?? undefined,
    isOwn:           myParticipantId ? p.participantId === myParticipantId : undefined,
  };
}

// ── Shared upload machinery (used by the single-shot POST / and the chunked /complete) ─────────

type UploadParticipant = {
  id: string; photosTaken: number; maxPhotos: number; extraPhotos: number; isLocked: boolean;
  startsAt: number; expiresAt: number; eventId: string; moderationEnabled: boolean; videoSeconds: number;
};

async function participantForUpload(sessionToken: string): Promise<UploadParticipant | null> {
  const [p] = await db.select({
    id: participants.id, photosTaken: participants.photosTaken, maxPhotos: events.maxPhotos,
    extraPhotos: participants.extraPhotos,
    isLocked: events.isLocked, startsAt: events.startsAt, expiresAt: events.expiresAt,
    eventId: events.id, moderationEnabled: events.moderationEnabled, videoSeconds: events.videoSeconds,
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
async function finalizeUpload(p: UploadParticipant, stagedPath: string, isVideo: boolean, source: 'capture' | 'upload' = 'capture') {
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
  const status = 'pending';
  const photoId = uuidv4();
  await db.insert(photos).values({
    id: photoId, eventId: p.eventId, participantId: p.id, filename: storedName,
    mediaType: isVideo ? 'video' : 'photo', takenAt: Date.now(), status,
    sizeBytes, width: dims.width ?? null, height: dims.height ?? null, durationMs: dims.durationMs ?? null,
    source,
  });
  await db.update(participants).set({ photosTaken: p.photosTaken + 1 }).where(eq(participants.id, p.id));
  // Face matching, if the host enabled it and anyone has enrolled. Deliberately not awaited:
  // it runs against the thumbnail after this response, and a slow or dead ML container must
  // never hold up a guest's upload.
  void matchNewPhoto(p.eventId, photoId, storedName);
  return { success: true, photoId, status, pendingModeration: status === 'pending', photosRemaining: Math.max(0, effectiveMaxPhotos(p) - p.photosTaken - 1) };
}

// ── POST /api/photos — single-shot upload (photos + videos under the chunk threshold) ──────────

// ── DELETE /api/photos/:id — a guest takes back their own shot, inside the window ─────────────
// Distinct statuses on purpose: the client shows a different thing for "not yours" than for
// "too late", and a single 403 for both would make the countdown UI impossible to get right.
router.delete('/:id', async (req: Request, res: Response) => {
  const sessionToken = String(req.body?.sessionToken || req.query?.sessionToken || '');
  if (!sessionToken) return res.status(400).json({ error: 'sessionToken required' });

  const [me] = await db
    .select({ id: participants.id, eventId: participants.eventId, photosTaken: participants.photosTaken,
              isLocked: events.isLocked, expiresAt: events.expiresAt, maxPhotos: events.maxPhotos,
              extraPhotos: participants.extraPhotos })
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
  await db.delete(photos).where(eq(photos.id, photo.id));
  const remaining = Math.max(0, Number(me.photosTaken) - 1);
  await db.update(participants).set({ photosTaken: remaining }).where(eq(participants.id, me.id));
  for (const f of [photo.filename, photo.filename.replace(/\.[^.]+$/, '_thumb.webp')]) {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch { /* already gone is fine */ }
  }

  res.json({ success: true, photosRemaining: remainingFor({ ...me, photosTaken: remaining }) });
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
    return res.json(await finalizeUpload(participant, req.file.path, isVideo, req.body?.source === 'upload' ? 'upload' : 'capture'));
  } catch (e) {
    return res.status((e as { status?: number }).status || 500).json({ error: (e as Error).message || 'Upload failed' });
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
    return res.json(await finalizeUpload(participant, staged, isVideo, req.body?.source === 'upload' ? 'upload' : 'capture'));
  } catch (e) {
    return res.status((e as { status?: number }).status || 500).json({ error: (e as Error).message || 'Upload failed' });
  }
});

// ── GET /api/photos/:joinCode/download — zip of originals (all or a selection) ──
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
  if (!isOrganizer) {
    if (!isRevealed(event)) return res.status(403).json({ error: 'Photos are not revealed yet' });
    if (!event.allowDownloads) return res.status(403).json({ error: 'Downloads are disabled for this event' });
  }

  const idsParam = typeof req.query.ids === 'string' ? req.query.ids : '';
  const ids = idsParam ? idsParam.split(',').map((s) => s.trim()).filter(Boolean) : [];

  // Visible set: with moderation on, only approved; off, anything not binned (rejected).
  const visible = event.moderationEnabled ? eq(photos.status, 'approved') : ne(photos.status, 'rejected');
  const rows = await db
    .select({ filename: photos.filename, mediaType: photos.mediaType, participantId: photos.participantId, participantName: participants.name })
    .from(photos)
    .innerJoin(participants, eq(participants.id, photos.participantId))
    .where(ids.length
      ? and(eq(photos.eventId, event.id), visible, inArray(photos.id, ids))
      : and(eq(photos.eventId, event.id), visible))
    .orderBy(asc(participants.name), asc(photos.takenAt));   // group by person, in their capture order
  if (!rows.length) return res.status(404).json({ error: 'No photos to download' });

  zipPhotosToResponse(res, event.name, rows);
});

// Stream a max-compression .zip of the given photo rows, named "<Event> - <Participant> - <n>.ext"
// where n is that participant's own capture-order number.
export function zipPhotosToResponse(
  res: Response,
  eventName: string,
  rows: { filename: string; mediaType: string | null; participantId: string; participantName: string | null }[],
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
    const file = path.join(UPLOADS_DIR, r.filename);
    if (!fs.existsSync(file)) continue;
    const ext = r.mediaType === 'video' ? (r.filename.split('.').pop() || 'mp4') : 'jpg';
    const who = fileSafe(r.participantName || 'Guest') || 'Guest';
    const n = (perPerson.get(r.participantId) || 0) + 1; perPerson.set(r.participantId, n);
    archive.file(file, { name: `${evName} - ${who} - ${n}.${ext}` });
  }
  archive.finalize();
}

// ── GET /api/photos/:joinCode — fetch photos ───────────────────────────────────

router.get('/:joinCode', async (req: Request, res: Response) => {
  const { gallery, highlightsOnly } = req.query;
  // Secrets ride in headers (fall back to query for older links).
  const organizerCode = req.get('x-organizer-code') || req.query.organizerCode;
  const sessionToken  = req.get('x-session-token')  || req.query.sessionToken;
  const raw = String(req.params.joinCode);

  const [event] = await db.select().from(events)
    .where(or(eq(events.joinCode, raw.toUpperCase()), eq(events.slug, raw.toLowerCase())));
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const revealed = isRevealed(event);
  // Visible set for guests/gallery: moderation on → only approved; off → anything not binned.
  const visible = event.moderationEnabled ? eq(photos.status, 'approved') : ne(photos.status, 'rejected');

  // ── Organizer mode — sees all photos regardless of reveal state ───────────
  if (organizerCode) {
    if (organizerCode !== event.organizerCode)
      return res.status(403).json({ error: 'Invalid organizer code' });
    const rows = await db
      .select({
        id:              photos.id,
        filename:        photos.filename,
        takenAt:         photos.takenAt,
        isHighlighted:   photos.isHighlighted,
        rating:          photos.rating,
        participantId:   photos.participantId,
        mediaType:       photos.mediaType,
        sizeBytes:       photos.sizeBytes,
        width:           photos.width,
        height:          photos.height,
        durationMs:      photos.durationMs,
        status:          photos.status,
        participantName: participants.name,
      })
      .from(photos)
      .innerJoin(participants, eq(participants.id, photos.participantId))
      .where(highlightsOnly === 'true'
        ? and(eq(photos.eventId, event.id), eq(photos.isHighlighted, true))
        : eq(photos.eventId, event.id))
      .orderBy(desc(photos.takenAt));
    return res.json({
      revealed: true,
      allowDownloads: !!event.allowDownloads,
      moderationEnabled: !!event.moderationEnabled,
      photos: rows.map(p => photoRow(p, null)),
    });
  }

  // ── Gallery (view-only) mode ──────────────────────────────────────────────
  if (gallery === 'true') {
    if (!revealed) {
      const [{ c: photoCount }] = await db.select({ c: count() }).from(photos)
        .where(and(eq(photos.eventId, event.id), visible));
      return res.json({ revealed: false, photoCount, revealMode: event.revealMode,
        revealAt: event.revealMode === 'at_end' ? event.expiresAt + (event.revealDelayHours || 0) * 3600000 : null });
    }
    const rows = await db
      .select({
        id:              photos.id,
        filename:        photos.filename,
        takenAt:         photos.takenAt,
        isHighlighted:   photos.isHighlighted,
        participantId:   photos.participantId,
        mediaType:       photos.mediaType,
        sizeBytes:       photos.sizeBytes,
        width:           photos.width,
        height:          photos.height,
        durationMs:      photos.durationMs,
        participantName: participants.name,
      })
      .from(photos)
      .innerJoin(participants, eq(participants.id, photos.participantId))
      .where(highlightsOnly === 'true'
        ? and(eq(photos.eventId, event.id), visible, eq(photos.isHighlighted, true))
        : and(eq(photos.eventId, event.id), visible))
      .orderBy(desc(photos.takenAt));   // newest first in the guest gallery
    const [{ c: highlightCount }] = await db.select({ c: count() }).from(photos)
      .where(and(eq(photos.eventId, event.id), eq(photos.isHighlighted, true), visible));
    const hasHighlights = highlightCount > 0;
    return res.json({
      revealed: true, hasHighlights,
      allowDownloads: !!event.allowDownloads,
      photos: rows.map(p => photoRow(p, null)),
    });
  }

  // ── Participant mode — session required ───────────────────────────────────
  if (!sessionToken) return res.status(403).json({ error: 'sessionToken required' });

  const [participant] = await db.select({ id: participants.id }).from(participants)
    .where(and(eq(participants.sessionToken, String(sessionToken)), eq(participants.eventId, event.id)));
  if (!participant) return res.status(403).json({ error: 'Not a participant' });

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
        mediaType:       photos.mediaType,
        sizeBytes:       photos.sizeBytes,
        width:           photos.width,
        height:          photos.height,
        durationMs:      photos.durationMs,
        status:          photos.status,
        participantName: participants.name,
      })
      .from(photos)
      .innerJoin(participants, eq(participants.id, photos.participantId))
      .where(and(eq(photos.eventId, event.id), eq(photos.participantId, participant.id)))
      .orderBy(desc(photos.takenAt));   // newest first
    return res.json({ revealed: false, photoCount, revealMode: event.revealMode,
      revealAt: event.revealMode === 'at_end' ? event.expiresAt + (event.revealDelayHours || 0) * 3600000 : null,
      myParticipantId: participant.id, photos: ownRows.map(p => photoRow(p, participant.id)) });
  }

  const rows = await db
    .select({
      id:              photos.id,
      filename:        photos.filename,
      takenAt:         photos.takenAt,
      isHighlighted:   photos.isHighlighted,
      participantId:   photos.participantId,
      mediaType:       photos.mediaType,
      sizeBytes:       photos.sizeBytes,
      width:           photos.width,
      height:          photos.height,
      durationMs:      photos.durationMs,
      participantName: participants.name,
    })
    .from(photos)
    .innerJoin(participants, eq(participants.id, photos.participantId))
    // A participant ALWAYS sees their own shots (even pending under moderation, or after the gallery
    // is revealed) — plus everyone else's visible photos. Without the own-clause, a guest who keeps
    // shooting after reveal would watch their new (pending) snaps vanish from their own gallery.
    .where(highlightsOnly === 'true'
      ? and(eq(photos.eventId, event.id), or(visible, eq(photos.participantId, participant.id)), eq(photos.isHighlighted, true))
      : and(eq(photos.eventId, event.id), or(visible, eq(photos.participantId, participant.id))))
    .orderBy(desc(photos.takenAt));   // newest first in the guest gallery
  const [{ c: highlightCount }] = await db.select({ c: count() }).from(photos)
    .where(and(eq(photos.eventId, event.id), eq(photos.isHighlighted, true), visible));
  const hasHighlights = highlightCount > 0;

  res.json({
    revealed: true, hasHighlights,
    allowDownloads: !!event.allowDownloads,
    myParticipantId: participant.id,
    photos: rows.map(p => photoRow(p, participant.id)),
  });
});

export default router;
