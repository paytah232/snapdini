import path from 'path';

// DATA_DIR holds everything that must stay on fast local disk (e.g. the Postgres data dir).
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');

// UPLOADS_DIR holds the heavy media (event photos/videos + theme images). It's separately
// configurable so it can be pointed at a ZFS pool mounted over NFS, without moving the DB.
// Default = <DATA_DIR>/uploads (current behaviour). The public `/uploads` URL maps here.
export const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(DATA_DIR, 'uploads');

// Map a stored "/uploads/…" web path to its on-disk location under UPLOADS_DIR.
export function uploadDiskPath(webPath: string): string {
  return path.join(UPLOADS_DIR, webPath.replace(/^\/?uploads\//, ''));
}
