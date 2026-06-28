import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { ZipArchive } from 'archiver';
import { v4 as uuidv4 } from 'uuid';
import { and, asc, count, desc, eq, inArray, ne, or } from 'drizzle-orm';
import { db } from '../db';
import { events, participants, photos } from '../schema';
import { stripImageMetadata, makeThumbnail, makeVideoPoster, thumbName } from '../images';
import { probeVideoMeta } from '../slideshow';
import { isRevealed } from '../lib';
import { eventByIdentifier } from './events';
import { billingEnabled } from '../billing';

const router = Router();

import { UPLOADS_DIR } from '../paths';
const MAX_PHOTO_MB   = parseInt(process.env.MAX_FILE_SIZE_MB || '64'); // headroom for an 8K still at max quality (q100/4:4:4)
const MAX_VIDEO_MB   = parseInt(process.env.MAX_VIDEO_SIZE_MB || '8192'); // plans for 90s 8K clips (multi-GB)
const VIDEO_MAX_SECS = parseInt(process.env.VIDEO_MAX_SECONDS || '0');

const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|3gp|mkv)$/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|heic|heif|bmp)$/i;

// Robust video detection: some mobile browsers (esp. iOS) hand us a recorded clip with an
// empty/octet-stream MIME, so fall back to the filename extension the client set.
function isVideoUpload(file: Express.Multer.File): boolean {
  return file.mimetype.startsWith('video/') || VIDEO_EXT_RE.test(file.originalname || '');
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = UPLOADS_DIR;
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
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

// ── POST /api/photos — upload photo or video ──────────────────────────────────

router.post('/', upload.single('photo'), async (req: Request, res: Response) => {
  const { sessionToken } = req.body;
  if (!sessionToken) { if (req.file) fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'sessionToken required' }); }
  if (!req.file)     return res.status(400).json({ error: 'No file uploaded' });

  const isVideo = isVideoUpload(req.file);

  // multer's single fileSize limit is the larger (video) cap; enforce the smaller PHOTO cap here
  // so an oversized image can't slip through under the video allowance.
  const perTypeMaxMb = isVideo ? MAX_VIDEO_MB : MAX_PHOTO_MB;
  if (req.file.size > perTypeMaxMb * 1024 * 1024) {
    fs.unlinkSync(req.file.path);
    return res.status(413).json({ error: `${isVideo ? 'Video' : 'Photo'} too large (max ${perTypeMaxMb} MB)` });
  }

  const [participant] = await db
    .select({
      id:                participants.id,
      photosTaken:       participants.photosTaken,
      maxPhotos:         events.maxPhotos,
      isLocked:          events.isLocked,
      startsAt:          events.startsAt,
      expiresAt:         events.expiresAt,
      eventId:           events.id,
      moderationEnabled: events.moderationEnabled,
      videoSeconds:      events.videoSeconds,
    })
    .from(participants)
    .innerJoin(events, eq(events.id, participants.eventId))
    .where(eq(participants.sessionToken, sessionToken));

  if (!participant) { fs.unlinkSync(req.file.path); return res.status(403).json({ error: 'Invalid session' }); }

  // Video allowed length: per-event entitlement when billing is on, else the global setting.
  const allowedVideoSecs = billingEnabled ? participant.videoSeconds : VIDEO_MAX_SECS;
  if (isVideo && allowedVideoSecs === 0) {
    fs.unlinkSync(req.file.path);
    return res.status(403).json({ error: 'Video uploads are not enabled for this event' });
  }

  const now = Date.now();
  if (participant.startsAt && now < participant.startsAt) { fs.unlinkSync(req.file.path); return res.status(403).json({ error: "Event hasn't started yet" }); }
  if (participant.isLocked)               { fs.unlinkSync(req.file.path); return res.status(403).json({ error: 'Event is locked' }); }
  if (now > participant.expiresAt)        { fs.unlinkSync(req.file.path); return res.status(410).json({ error: 'Event has ended' }); }
  if (participant.photosTaken >= participant.maxPhotos) { fs.unlinkSync(req.file.path); return res.status(403).json({ error: 'No shots remaining' }); }

  // Display metadata: byte size always; dimensions/duration where we can read them.
  let dims: { width?: number; height?: number; durationMs?: number } = {};
  const sizeBytes = req.file.size;

  // Strip metadata (EXIF/GPS) from images and validate they're real images. Videos pass
  // through (metadata stripping for video would need ffmpeg; video is off by default).
  if (!isVideo) {
    try {
      dims = await stripImageMetadata(req.file.path);  // keep full-res original, strip EXIF/GPS, get w×h
      await makeThumbnail(req.file.path);              // fast grid thumbnail alongside it
    }
    catch { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Invalid or unsupported image file' }); }
  } else {
    dims = await probeVideoMeta(req.file.path).catch(() => ({}));   // best-effort w×h + duration
    await makeVideoPoster(req.file.path).catch(() => false);        // poster frame for grid display
  }

  // Every photo starts 'pending'. Visibility is gated by the event's moderation SETTING at view
  // time (moderation on → only approved show; off → pending shows too), so enabling moderation
  // later correctly holds already-uploaded photos instead of leaving them auto-approved.
  const status = 'pending';
  const photo = {
    id:            uuidv4(),
    eventId:       participant.eventId,
    participantId: participant.id,
    filename:      req.file.filename,
    mediaType:     isVideo ? 'video' : 'photo',
    takenAt:       now,
    status,
  };

  await db.insert(photos).values({
    id:            photo.id,
    eventId:       photo.eventId,
    participantId: photo.participantId,
    filename:      photo.filename,
    mediaType:     photo.mediaType,
    takenAt:       photo.takenAt,
    status:        photo.status,
    sizeBytes,
    width:         dims.width ?? null,
    height:        dims.height ?? null,
    durationMs:    dims.durationMs ?? null,
  });

  await db.update(participants)
    .set({ photosTaken: participant.photosTaken + 1 })
    .where(eq(participants.id, participant.id));

  res.json({
    success:           true,
    photoId:           photo.id,
    status,
    pendingModeration: status === 'pending',
    photosRemaining:   participant.maxPhotos - participant.photosTaken - 1,
  });
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

  // zlib level 9 + max memLevel = the highest ratio standard zip (DEFLATE) offers. Note: JPEG/MP4
  // are already compressed, so the zip mainly bundles rather than shrinks them — that's expected.
  const archive = new ZipArchive({ zlib: { level: 9, memLevel: 9 } });
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
