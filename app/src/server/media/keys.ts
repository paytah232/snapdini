// What a key may look like, and what kind of bytes it names.
//
// Keys are the database's relative paths: `<eventId>/<name>` for everything an event owns, and a
// handful of structural prefixes (`feedback/`, legacy `themes/` and `slideshow-audio/`). Every
// segment is a uuid, a slug or a name this server generated, so the grammar is tight and anything
// outside it is refused rather than normalised. `..` is excluded by the grammar itself: a segment
// is letters, digits, `_` and `-`, and a name may carry dots only INSIDE it.
import path from 'path';

const SEG = /^[A-Za-z0-9_-]+$/;
const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** Throws unless `key` is a well-formed relative key. Returns it normalised (no leading slash). */
export function assertKey(key: string): string {
  const k = String(key).replace(/^\/+/, '');
  const parts = k.split('/');
  if (!parts.length || parts.some((p) => !p)) throw new Error('unsafe media key: ' + key);
  for (let i = 0; i < parts.length - 1; i++) if (!SEG.test(parts[i])) throw new Error('unsafe media key: ' + key);
  const name = parts[parts.length - 1];
  if (!NAME.test(name) || name.includes('..')) throw new Error('unsafe media key: ' + key);
  return k;
}

/** Throws unless `prefix` is a well-formed directory key (`<eventId>` or `feedback`). Returns it
 *  with no leading or trailing slash. The empty string is the root. */
export function assertPrefix(prefix: string): string {
  const p = String(prefix).replace(/^\/+|\/+$/g, '');
  if (p === '') return '';
  for (const seg of p.split('/')) if (!SEG.test(seg)) throw new Error('unsafe media prefix: ' + prefix);
  return p;
}

/** The `/uploads/…` web path for a key. */
export const webPath = (key: string): string => `/uploads/${assertKey(key)}`;

/** The key named by a stored `/uploads/…` web path. Anchored: only a LEADING `/uploads/` is
 *  stripped, so `/uploads/../x` is refused by assertKey rather than walking anywhere. */
export function keyFromWebPath(webPath: string): string {
  return assertKey(String(webPath).replace(/^\/?uploads\//, ''));
}

export const keyDir = (key: string): string => { const d = path.posix.dirname(key); return d === '.' ? '' : d; };
export const keyName = (key: string): string => path.posix.basename(key);
export const joinKey = (prefix: string, name: string): string => (prefix ? `${prefix}/${name}` : name);

/** Files a pipeline writes beside an output while it is still being made. They are never
 *  published and never served: every tool in images.ts and slideshow.ts writes to one of these and
 *  renames into place at the end, so a publish that runs while another job is mid-flight cannot
 *  pick up a half-written file. Add a new temp suffix anywhere and it belongs in this list. */
const TEMP_MARKERS = ['.tmp.', '.raw.', '.sync.', '.rot.', '.turn.', '.part'];
export function isTempName(name: string): boolean {
  return name.startsWith('.') || TEMP_MARKERS.some((m) => name.includes(m));
}

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
  txt: 'text/plain; charset=utf-8', json: 'application/json',
};
/** The Content-Type for a name, by extension. Unknown is octet-stream, never a guess. */
export function contentTypeFor(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return TYPES[ext] || 'application/octet-stream';
}
