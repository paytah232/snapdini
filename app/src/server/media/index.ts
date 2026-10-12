// The store this process uses, chosen once from the environment, plus the two helpers every
// caller wants: a short-lived listing cache and the "give me a real file" escape hatch.
//
//   MEDIA_DRIVER=local (default)  files under UPLOADS_DIR, as always
//   MEDIA_DRIVER=s3               S3_ENDPOINT / S3_REGION / S3_BUCKET / S3_ACCESS_KEY /
//                                 S3_SECRET_KEY / S3_FORCE_PATH_STYLE / S3_PREFIX / S3_CA_FILE
//
// UPLOADS_DIR keeps a job on either driver: it is where uploads are staged and where checkouts
// put their working copies. On s3 that is all it holds, and everything in it is transient.
import path from 'path';
import { Readable } from 'stream';
import { UPLOADS_DIR } from '../paths';
import { LocalStore } from './local';
import { S3Store, s3ConfigFromEnv } from './s3';
import { assertPrefix, keyDir, keyName } from './keys';
import type { Checkout, MediaStore } from './types';

export type { MediaStore, Checkout, MediaBody, MediaStat } from './types';
export { assertKey, assertPrefix, keyFromWebPath, webPath, keyDir, keyName, joinKey, contentTypeFor, isTempName } from './keys';

function build(): MediaStore {
  const driver = (process.env.MEDIA_DRIVER || 'local').trim().toLowerCase();
  if (driver === 's3') return new S3Store(s3ConfigFromEnv(process.env, path.join(UPLOADS_DIR, '.work')));
  if (driver !== 'local') throw new Error(`MEDIA_DRIVER must be local or s3, not "${driver}"`);
  return new LocalStore(UPLOADS_DIR);
}

/** The store. Built on first use so a test can set the environment before touching it. */
let instance: MediaStore | null = null;
export function media(): MediaStore {
  if (!instance) instance = build();
  return instance;
}
/** Tests only: swap the store under the modules that import it. */
export function __setMedia(store: MediaStore | null): void { instance = store; listings.clear(); }

// ── The listing cache ─────────────────────────────────────────────────────────
//
// `onDisk` is asked up to three times for EVERY row a gallery returns — the `_dl`, `_play` and
// `_crop` siblings. All of an upload's siblings live under one prefix (its event), so ONE listing
// answers every question about every row: 500 filesystem questions for a 200-clip gallery become
// 1, and on s3 one ListObjects call. Measured against the NFS share this replaced: 73ms of blocked
// loop → 12ms at 200 clips. Kept for a couple of seconds because a gallery is polled continuously
// and the answers only change when a crop or proxy lands (seconds after an upload) or the event is
// purged — a window the callers are built for: the whole fallback ladder in playFile/downloadFile
// exists because a crop lands AFTER the upload response, and "until it lands, serve the original"
// is the documented, correct answer.
const LISTING_TTL_MS = 2_000;
const listings = new Map<string, { at: number; names: Set<string> }>();

/** The names under `prefix`, from the cache when it is fresh. */
export async function listing(prefix: string): Promise<ReadonlySet<string>> {
  const p = assertPrefix(prefix);
  const now = Date.now();
  const hit = listings.get(p);
  if (hit && now - hit.at < LISTING_TTL_MS) return hit.names;
  const names = new Set(await media().list(p));
  // A cache with no bound is a leak: event folders are unbounded over the life of the process. The
  // entries are short-lived by TTL anyway, so dropping the lot is enough — no LRU needed.
  if (listings.size > 64) listings.clear();
  listings.set(p, { at: now, names });
  return names;
}

/** A listing that answers `has(key)` for keys under ONE prefix. Keys under any other prefix read
 *  as absent — the callers' documented fallback — rather than triggering a second listing from
 *  inside a synchronous row builder. */
export type Listing = { prefix: string; has(key: string): boolean };
export async function listingFor(prefix: string): Promise<Listing> {
  const p = assertPrefix(prefix);
  const names = await listing(p);
  return { prefix: p, has: (key: string) => keyDir(key) === p && names.has(keyName(key)) };
}

/** Forget what we know about a prefix — called after a write or delete under it so the next
 *  gallery poll sees the change without waiting out the TTL. */
export function invalidateListing(prefix: string): void {
  try { listings.delete(assertPrefix(prefix)); } catch { /* a key that fails the grammar was never cached */ }
}
/** Throw the whole cache away. Tests only — see routes/photos.ts for why it must be reachable. */
export function __resetListingCache(): void { listings.clear(); }

// ── The escape hatch ──────────────────────────────────────────────────────────

/** Run `fn` with a real local file for `key`. On the local driver that is the stored file itself;
 *  on s3 it is a temporary copy that is removed afterwards. Throws when the object does not exist. */
export async function withLocalFile<T>(key: string, fn: (localPath: string) => Promise<T>): Promise<T> {
  const co = await media().checkout(keyDir(key), { fetch: [keyName(key)] });
  try {
    const present = await co.fetch([keyName(key)]);
    if (!present.has(keyName(key))) {
      const e = new Error(`media object not found: ${key}`) as Error & { code?: string };
      e.code = 'ENOENT';
      throw e;
    }
    return await fn(co.path(keyName(key)));
  } finally {
    await co.release();
  }
}

/** A checkout of one event folder with the named files fetched. The caller MUST release it. */
export async function checkoutFor(prefix: string, fetch?: string[]): Promise<Checkout> {
  return media().checkout(prefix, { fetch });
}

// ── Feeding an archive ────────────────────────────────────────────────────────

/** What to hand archiver for one object: the file itself on the local driver (archiver lstats and
 *  opens it in its own time, and its 'warning' carries that path), or on s3 a stream that opens
 *  the object only when archiver reaches it — so a 400-photo zip is not 400 open requests. */
export function archiveSource(key: string): { path: string } | { stream: Readable } {
  const store = media();
  if (store instanceof LocalStore) return { path: store.diskPath(key) };
  return { stream: lazyStream(key) };
}

/** A readable that fetches `key` on first read, with back-pressure, and fails like a missing file
 *  (code ENOENT) when there is no such object. */
export function lazyStream(key: string): Readable {
  let started = false;
  let src: Readable | null = null;
  const out = new Readable({
    read() {
      if (started) { src?.resume(); return; }
      started = true;
      media().get(key).then((body) => {
        if (!body) {
          const e = new Error(`media object not found: ${key}`) as Error & { code?: string; path?: string };
          e.code = 'ENOENT'; e.path = key;
          out.destroy(e);
          return;
        }
        src = body.stream;
        src.on('data', (chunk: Buffer) => { if (!out.push(chunk)) src!.pause(); });
        src.on('end', () => out.push(null));
        src.on('error', (e) => out.destroy(e));
      }).catch((e) => out.destroy(e));
    },
    destroy(err, cb) { src?.destroy(); cb(err); },
  });
  return out;
}
