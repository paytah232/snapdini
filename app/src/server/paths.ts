import path from 'path';

// DATA_DIR holds everything that must stay on fast local disk (e.g. the Postgres data dir).
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');

// UPLOADS_DIR holds the heavy media (event photos/videos + theme images). It's separately
// configurable so it can be pointed at a ZFS pool mounted over NFS, without moving the DB.
// Default = <DATA_DIR>/uploads (current behaviour). The public `/uploads` URL maps here.
export const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(DATA_DIR, 'uploads');

// True when `abs` resolves to UPLOADS_DIR itself or something beneath it.
// path.join does NOT neutralise "..", it RESOLVES it — join(UPLOADS_DIR, '../../etc/passwd')
// walks straight out of the volume. Only resolve-then-compare catches that.
export function insideUploads(abs: string): boolean {
  const root = path.resolve(UPLOADS_DIR);
  const p = path.resolve(abs);
  return p === root || p.startsWith(root + path.sep);
}

// Map a stored "/uploads/…" web path to its on-disk location under UPLOADS_DIR.
//
// Throws rather than returning an escaping path. The strip is deliberately anchored: the old
// `.replace('/uploads/', '')` was unanchored and removed only the FIRST occurrence, so
// "/uploads/../../etc/passwd" became "../../etc/passwd" and joined to /etc/passwd. Two callers
// fed that to sharp (read) and to unlink (delete), reachable by an anonymous caller via the demo
// event's organizer code. Callers already sit inside try/catch that degrades to no header image.
export function uploadDiskPath(webPath: string): string {
  const abs = path.join(UPLOADS_DIR, String(webPath).replace(/^\/?uploads\//, ''));
  if (!insideUploads(abs)) throw new Error('unsafe uploads path: ' + webPath);
  return abs;
}

// ── Per-event storage ────────────────────────────────────────────────────────
// All of an event's assets (guest photos/videos + thumbs, theme image, slideshows, custom audio,
// poster bg) live under UPLOADS_DIR/<eventId>/. Benefits: no filename clashes, trivial manual
// inspection, and purge = remove the one folder. Stored DB paths are RELATIVE to UPLOADS_DIR, e.g.
// "<eventId>/<uuid>.jpg", so the web URL is "/uploads/<eventId>/<uuid>.jpg" and the disk path is
// join(UPLOADS_DIR, that). Event ids are safe path segments (uuid/crypto), but sanitise anyway.

const SAFE_SEG = /^[A-Za-z0-9_-]+$/;
function seg(id: string): string {
  if (!SAFE_SEG.test(id)) throw new Error('unsafe path segment: ' + id);
  return id;
}

// On-disk directory for one event's assets (not auto-created).
export function eventDir(eventId: string): string {
  return path.join(UPLOADS_DIR, seg(eventId));
}

// Relative "<eventId>/<name>" to store in DB path columns.
export function eventRelPath(eventId: string, name: string): string {
  return `${seg(eventId)}/${name}`;
}

// Staging dir for in-flight uploads (multer runs before we know the event, so files land here then
// get moved into the event folder). A dotfile dir so express.static (dotfiles:'ignore') never serves
// it, and under UPLOADS_DIR so the move into the event folder is a same-filesystem atomic rename.
export const INCOMING_DIR = path.join(UPLOADS_DIR, '.incoming');
