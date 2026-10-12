// The ONE storage layer every piece of guest media goes through.
//
// Feature code never builds a disk path for a photo, a clip, a thumbnail, a slideshow render, a
// theme image or a feedback screenshot. It names things by KEY — the same relative path the
// database has always stored (`<eventId>/<uuid>.jpg`, `feedback/<uuid>.jpg`) — and asks the store.
// Two drivers answer: `local` keeps the folder layout exactly as it was, and `s3` keeps the same
// keys in a bucket. Moving between them is a copy and an environment variable; no row changes.
//
// Tools that need a real file (sharp, ffmpeg, archiver) get one through a Checkout: a local
// directory that IS the event folder on the local driver and a temporary working copy on s3. Work
// on it, publish what changed, release it. That is the only door between the two worlds, and it is
// deliberately a door rather than a hole: a file on the local disk of an s3 deployment is transient
// by construction, because the directory it lives in is deleted when the checkout is released.
import type { Readable } from 'stream';

export type Driver = 'local' | 's3';

export type ByteRange = { start: number; end?: number };

export interface MediaStat {
  size: number;
  /** A strong or weak validator the serving layer can hand to browsers as an ETag. */
  etag: string;
  mtimeMs: number;
  contentType?: string;
}

export interface MediaBody extends MediaStat {
  stream: Readable;
  /** Present only when a range was asked for and honoured. `total` is the whole object's size. */
  range?: { start: number; end: number; total: number };
}

export interface PutOptions {
  /** `src` is a local file that may be MOVED rather than copied. The local driver renames it into
   *  place; the s3 driver uploads it and then removes it. Either way the source is gone afterwards. */
  move?: boolean;
  contentType?: string;
  /** Known length of a stream source, which lets the s3 driver skip buffering to find it out. */
  size?: number;
}

/** A local directory that stands in for one key prefix (an event folder) for the life of a job.
 *
 *  On the local driver it is the real folder: `path(name)` is the file the store serves, fetch and
 *  publish are no-ops, and release does nothing. On s3 it is a temporary directory under the
 *  staging root: fetch downloads the named objects into it, publish uploads what changed, release
 *  deletes it. Code written against this shape behaves identically on both. */
export interface Checkout {
  readonly prefix: string;
  readonly dir: string;
  /** Local path for `name` inside this checkout. The file may or may not exist yet. */
  path(name: string): string;
  /** Make the named objects available as local files, if the store has them. With no names, every
   *  object under the prefix. Resolves to the names that are now present locally. */
  fetch(names?: string[]): Promise<Set<string>>;
  /** Push the named local files to the store. With no names, every non-temporary file in the
   *  directory whose size or mtime changed since it was last published (or fetched). */
  publish(names?: string[]): Promise<void>;
  /** Delete the named objects from the store AND the local copies, if any. */
  remove(names: string[]): Promise<void>;
  /** Hand the working directory back. Nothing in it survives on s3; on local it is the live folder
   *  and is left exactly as it is. Safe to call more than once. */
  release(): Promise<void>;
}

export interface CheckoutOptions {
  /** Staged files to move INTO the checkout before anything else, keyed by the name they will be
   *  published under. An upload's staged file is adopted this way so it is processed in place. */
  adopt?: { name: string; from: string }[];
  /** Objects to fetch straight away. */
  fetch?: string[];
}

export interface MediaStore {
  readonly driver: Driver;
  /** Store `src` under `key`, replacing anything already there. */
  put(key: string, src: string | Buffer | Readable, opts?: PutOptions): Promise<void>;
  /** The object, or null when there is none. */
  get(key: string, opts?: { range?: ByteRange }): Promise<MediaBody | null>;
  stat(key: string): Promise<MediaStat | null>;
  exists(key: string): Promise<boolean>;
  /** Idempotent: deleting what is not there is a no-op. */
  delete(key: string): Promise<void>;
  /** Everything under `prefix/`, recursively. Returns how many objects went. */
  deletePrefix(prefix: string): Promise<number>;
  /** The names (not keys) of the objects directly under `prefix/`. Files only. */
  list(prefix: string): Promise<string[]>;
  /** The names of the prefixes directly under `prefix/` — event folders, when asked about the root. */
  listDirs(prefix: string): Promise<string[]>;
  copy(from: string, to: string): Promise<void>;
  checkout(prefix: string, opts?: CheckoutOptions): Promise<Checkout>;
}
