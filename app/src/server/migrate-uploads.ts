import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { events, photos, slideshows } from './schema';
import { UPLOADS_DIR, eventDir, eventRelPath } from './paths';
import { thumbName } from './images';

// One-off, idempotent migration to the per-event folder layout (/uploads/<eventId>/…). Moves any
// assets still in the old flat / type-subdir locations into their event folder and rewrites the DB
// path. Safe to run on every boot: once migrated there's nothing left to move. Best-effort per item
// so one bad row never blocks startup.
export async function migrateUploadsToPerEvent(): Promise<number> {
  let moved = 0;
  const mv = (src: string, dest: string): boolean => {
    try {
      if (!fs.existsSync(src)) return false;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      return true;
    } catch { return false; }
  };

  // 1. Guest photos/videos: flat "<uuid>.ext" → "<eventId>/<uuid>.ext" (+ its _thumb sibling).
  try {
    const rows = await db.select({ id: photos.id, eventId: photos.eventId, filename: photos.filename }).from(photos);
    for (const p of rows) {
      if (!p.filename || p.filename.includes('/')) continue;   // already foldered
      const rel = eventRelPath(p.eventId, p.filename);
      if (mv(path.join(UPLOADS_DIR, p.filename), path.join(UPLOADS_DIR, rel))) moved++;
      mv(path.join(UPLOADS_DIR, thumbName(p.filename)), path.join(UPLOADS_DIR, thumbName(rel)));
      try { await db.update(photos).set({ filename: rel }).where(eq(photos.id, p.id)); } catch { /* */ }
    }
  } catch (e) { console.error('[migrate] photos:', (e as Error).message); }

  // 2. Slideshows: "slideshows/<id>.mp4" → "<eventId>/slideshow-<id>.mp4".
  try {
    const rows = await db.select({ id: slideshows.id, eventId: slideshows.eventId, filename: slideshows.filename }).from(slideshows);
    for (const s of rows) {
      if (!s.filename || !s.filename.startsWith('slideshows/')) continue;
      const rel = eventRelPath(s.eventId, `slideshow-${path.basename(s.filename)}`);
      if (mv(path.join(UPLOADS_DIR, s.filename), path.join(UPLOADS_DIR, rel))) moved++;
      try { await db.update(slideshows).set({ filename: rel }).where(eq(slideshows.id, s.id)); } catch { /* */ }
    }
  } catch (e) { console.error('[migrate] slideshows:', (e as Error).message); }

  // 3. Theme header images: "/uploads/themes/<file>" → "/uploads/<eventId>/theme-<file>".
  try {
    const rows = await db.select({ id: events.id, theme: events.theme }).from(events);
    for (const ev of rows) {
      if (!ev.theme) continue;
      try {
        const t = JSON.parse(ev.theme) as { headerImage?: string };
        if (typeof t.headerImage === 'string' && t.headerImage.startsWith('/uploads/themes/')) {
          const rel = eventRelPath(ev.id, `theme-${path.basename(t.headerImage)}`);
          if (mv(path.join(UPLOADS_DIR, t.headerImage.replace(/^\/uploads\//, '')), path.join(UPLOADS_DIR, rel))) moved++;
          t.headerImage = `/uploads/${rel}`;
          await db.update(events).set({ theme: JSON.stringify(t) }).where(eq(events.id, ev.id));
        }
      } catch { /* malformed theme JSON */ }
    }
  } catch (e) { console.error('[migrate] themes:', (e as Error).message); }

  // 4. Custom audio: "slideshow-audio/<eventId>-<rest>" → "<eventId>/audio-<rest>". Match the event
  // id prefix against real ids (they're UUIDs with their own hyphens, so we can't split on '-').
  try {
    const adir = path.join(UPLOADS_DIR, 'slideshow-audio');
    const files = fs.existsSync(adir) ? fs.readdirSync(adir) : [];
    if (files.length) {
      const ids = (await db.select({ id: events.id }).from(events)).map((e) => e.id);
      for (const f of files) {
        const evId = ids.find((id) => f.startsWith(id + '-'));
        if (!evId) continue;
        const rest = f.slice(evId.length + 1);
        if (mv(path.join(adir, f), path.join(eventDir(evId), `audio-${rest}`))) moved++;
      }
    }
  } catch (e) { console.error('[migrate] audio:', (e as Error).message); }

  if (moved) console.log(`[migrate] moved ${moved} file(s) into per-event folders`);
  return moved;
}
