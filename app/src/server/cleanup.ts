import fs from 'fs';
import path from 'path';
import { and, eq, isNotNull, lt, count } from 'drizzle-orm';
import { db } from './db';
import { events, photos, participants, clientErrors, slideshows, shares } from './schema';
import { UPLOADS_DIR, uploadDiskPath } from './paths';
import { thumbName } from './images';
import { purgeOldSlideshows } from './slideshow';

const SWEEP_MS = 60 * 60 * 1000; // hourly
const CLIENT_ERROR_TTL_MS = 30 * 24 * 60 * 60 * 1000; // keep diagnostic reports ~30 days

function safeUnlink(file: string): void {
  fs.promises.unlink(file).catch(() => {}); // best-effort; ignore missing
}

// Remove a photo's uploaded file (and its grid thumbnail) given its stored filename.
export function unlinkUpload(filename?: string | null): void {
  if (!filename) return;
  safeUnlink(path.join(UPLOADS_DIR, filename));
  safeUnlink(path.join(UPLOADS_DIR, thumbName(filename))); // <name>_thumb.webp (no-op for videos)
}

// Delete every file owned by an event (photos + theme header image) from disk.
// Call this BEFORE deleting the event row (the row cascade removes DB records).
export async function deleteEventFiles(eventId: string): Promise<void> {
  const rows = await db.select({ filename: photos.filename }).from(photos).where(eq(photos.eventId, eventId));
  for (const p of rows) unlinkUpload(p.filename);

  const [ev] = await db.select({ theme: events.theme }).from(events).where(eq(events.id, eventId));
  if (ev && ev.theme) {
    try {
      const t = JSON.parse(ev.theme) as { headerImage?: string };
      // headerImage is stored as a "/uploads/themes/<file>" web path → map to UPLOADS_DIR.
      if (t.headerImage && t.headerImage.startsWith('/uploads/'))
        safeUnlink(uploadDiskPath(t.headerImage));
    } catch { /* malformed theme JSON — nothing to clean */ }
  }
}

// Purge events whose retention window (purgeAt) has passed. We delete all the heavy /
// personal data — photo + video files, the slideshow, photo rows, and participant rows
// (names/emails) — but KEEP a slim event record (settings + final stats) as the organizer's
// history. The record's purge_at is cleared so it isn't swept again.
export async function sweep(): Promise<number> {
  const due = await db.select({ id: events.id }).from(events)
    .where(and(isNotNull(events.purgeAt), lt(events.purgeAt, Date.now())));
  for (const e of due) {
    // snapshot final stats before deleting the child rows
    const [pc] = await db.select({ n: count() }).from(participants).where(eq(participants.eventId, e.id));
    const [phc] = await db.select({ n: count() }).from(photos).where(eq(photos.eventId, e.id));

    await deleteEventFiles(e.id);                 // photo/video + theme image files
    // All slideshow renders for this event (versioned files + rows), incl. favourited ones.
    try {
      const ss = await db.select().from(slideshows).where(eq(slideshows.eventId, e.id));
      for (const s of ss) safeUnlink(path.join(UPLOADS_DIR, s.filename));
      await db.delete(slideshows).where(eq(slideshows.eventId, e.id));
    } catch { /* best-effort */ }
    // Organizer's uploaded backing track(s), if any (named "<eventId>-*").
    try {
      const adir = path.join(UPLOADS_DIR, 'slideshow-audio');
      for (const f of fs.readdirSync(adir)) if (f.startsWith(`${e.id}-`)) safeUnlink(path.join(adir, f));
    } catch { /* none */ }

    await db.delete(photos).where(eq(photos.eventId, e.id));
    await db.delete(participants).where(eq(participants.eventId, e.id)); // clears guest PII
    await db.delete(shares).where(eq(shares.eventId, e.id));             // dead links; frees their /s/ slugs

    await db.update(events).set({
      purgeAt: null,
      purgedAt: Date.now(),
      slug: null,             // free the pretty /e/ URL so a future event can reuse it
      theme: null,            // the theme image file is deleted above; drop its dead path reference too
      statParticipants: Number(pc?.n ?? 0),
      statPhotos: Number(phc?.n ?? 0),
    }).where(eq(events.id, e.id));
  }
  if (due.length) console.log(`[sweeper] purged media for ${due.length} event(s) (kept stats archive)`);

  // Keep the diagnostics table bounded — drop client error reports older than the TTL.
  try { await db.delete(clientErrors).where(lt(clientErrors.createdAt, Date.now() - CLIENT_ERROR_TTL_MS)); }
  catch (e) { console.error('[sweeper] client_errors prune failed:', (e as Error).message); }

  // Auto-purge non-favourite slideshow renders older than a day (favourites kept until event purge).
  try { await purgeOldSlideshows(); } catch (e) { console.error('[sweeper] slideshow purge failed:', (e as Error).message); }

  return due.length;
}

// Start the periodic sweeper (and run once on boot).
export function start() {
  const run = () => sweep().catch((err) => console.error('[sweeper] failed:', err.message));
  run();
  const timer = setInterval(run, SWEEP_MS);
  timer.unref?.(); // don't keep the process alive just for the sweeper
  return timer;
}
