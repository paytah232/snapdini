// The local driver: the uploads folder exactly as it has always been.
//
// Keys map to `<root>/<key>`, so a deployment that never sets MEDIA_DRIVER sees no change at all —
// the same files in the same places, served by the same express.static. Writes land under a
// temporary name and are renamed into place, so a reader can never open a half-written object.
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import type { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { assertKey, assertPrefix, contentTypeFor, isTempName, joinKey } from './keys';
import type { ByteRange, Checkout, CheckoutOptions, MediaBody, MediaStat, MediaStore, PutOptions } from './types';

/** A validator with the same shape express.static sends for a file: size and mtime, weak. */
const etagOf = (st: fs.Stats): string => `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;

export class LocalStore implements MediaStore {
  readonly driver = 'local' as const;
  constructor(readonly root: string) {}

  /** Absolute path for a key, re-checked for containment: the key grammar already forbids `..`,
   *  but a path helper that is only correct for trusted input is a trap for the next caller. */
  diskPath(key: string): string {
    const abs = path.join(this.root, assertKey(key));
    const root = path.resolve(this.root);
    const p = path.resolve(abs);
    if (p !== root && !p.startsWith(root + path.sep)) throw new Error('unsafe media key: ' + key);
    return abs;
  }
  private dirPath(prefix: string): string {
    const p = assertPrefix(prefix);
    return p ? path.join(this.root, p) : this.root;
  }

  async put(key: string, src: string | Buffer | Readable, opts: PutOptions = {}): Promise<void> {
    if (isTempName(path.posix.basename(key))) throw new Error('refusing to store a temporary name: ' + key);
    const dest = this.diskPath(key);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    if (typeof src === 'string') {
      if (opts.move) {
        try { await fs.promises.rename(src, dest); return; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e; }
        // Across filesystems: copy, then remove — never leave the source behind on success.
        await copyAtomic(src, dest);
        await fs.promises.unlink(src).catch(() => {});
        return;
      }
      await copyAtomic(src, dest);
      return;
    }
    const tmp = tmpBeside(dest);
    try {
      if (Buffer.isBuffer(src)) await fs.promises.writeFile(tmp, src);
      else await pipeline(src, fs.createWriteStream(tmp));
      await fs.promises.rename(tmp, dest);
    } catch (e) {
      await fs.promises.unlink(tmp).catch(() => {});
      throw e;
    }
  }

  async get(key: string, opts: { range?: ByteRange } = {}): Promise<MediaBody | null> {
    if (isTempName(path.posix.basename(key))) return null;
    const file = this.diskPath(key);
    let st: fs.Stats;
    try { st = await fs.promises.stat(file); } catch { return null; }
    if (!st.isFile()) return null;
    const base: MediaStat = { size: st.size, etag: etagOf(st), mtimeMs: st.mtimeMs, contentType: contentTypeFor(key) };
    if (opts.range) {
      const r = clampRange(opts.range, st.size);
      if (!r) return null;
      return { ...base, size: r.end - r.start + 1, stream: fs.createReadStream(file, { start: r.start, end: r.end }), range: { ...r, total: st.size } };
    }
    return { ...base, stream: fs.createReadStream(file) };
  }

  async stat(key: string): Promise<MediaStat | null> {
    // A temporary name is never an object, whichever driver: the folder IS the store here, so a
    // tool's half-written `.tmp.` file sits beside the real ones and must read as absent.
    if (isTempName(path.posix.basename(key))) return null;
    try {
      const st = await fs.promises.stat(this.diskPath(key));
      return st.isFile() ? { size: st.size, etag: etagOf(st), mtimeMs: st.mtimeMs, contentType: contentTypeFor(key) } : null;
    } catch { return null; }
  }

  async exists(key: string): Promise<boolean> { return (await this.stat(key)) !== null; }

  async delete(key: string): Promise<void> {
    try { await fs.promises.unlink(this.diskPath(key)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const p = assertPrefix(prefix);
    if (!p) throw new Error('refusing to delete the whole uploads root');
    const dir = this.dirPath(p);
    let n = 0;
    const walk = async (d: string) => {
      let ents: fs.Dirent[];
      try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.isDirectory()) await walk(path.join(d, e.name));
        else n++;
      }
    };
    await walk(dir);
    await fs.promises.rm(dir, { recursive: true, force: true });
    return n;
  }

  async list(prefix: string): Promise<string[]> {
    try {
      const ents = await fs.promises.readdir(this.dirPath(prefix), { withFileTypes: true });
      return ents.filter((e) => e.isFile() && !isTempName(e.name)).map((e) => e.name).sort();
    } catch { return []; }
  }

  async listDirs(prefix: string): Promise<string[]> {
    try {
      const ents = await fs.promises.readdir(this.dirPath(prefix), { withFileTypes: true });
      return ents.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
    } catch { return []; }
  }

  async copy(from: string, to: string): Promise<void> {
    const dest = this.diskPath(to);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await copyAtomic(this.diskPath(from), dest);
  }

  async checkout(prefix: string, opts: CheckoutOptions = {}): Promise<Checkout> {
    const p = assertPrefix(prefix);
    const dir = this.dirPath(p);
    await fs.promises.mkdir(dir, { recursive: true });
    for (const a of opts.adopt ?? []) {
      await this.put(joinKey(p, a.name), a.from, { move: true });
    }
    const store = this;
    const co: Checkout = {
      prefix: p,
      dir,
      path: (name: string) => {
        if (name.includes('/') || name.includes('..') || !name) throw new Error('unsafe checkout name: ' + name);
        return path.join(dir, name);
      },
      async fetch(names?: string[]) {
        const all = new Set(await store.list(p));
        if (!names) return all;
        return new Set(names.filter((n) => all.has(n)));
      },
      async publish() { /* the folder IS the store */ },
      async remove(names: string[]) { for (const n of names) await store.delete(joinKey(p, n)); },
      async release() { /* live folder — nothing to hand back */ },
    };
    void opts.fetch;   // nothing to pre-fetch: the files are already where they will be read
    return co;
  }
}

function tmpBeside(dest: string): string {
  return path.join(path.dirname(dest), `.${path.basename(dest)}.${randomUUID().slice(0, 8)}.part`);
}

async function copyAtomic(src: string, dest: string): Promise<void> {
  const tmp = tmpBeside(dest);
  try {
    await fs.promises.copyFile(src, tmp);
    await fs.promises.rename(tmp, dest);
  } catch (e) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw e;
  }
}

/** RFC 7233 semantics for a single range against a known size. Null means unsatisfiable. */
export function clampRange(r: ByteRange, size: number): { start: number; end: number } | null {
  if (size <= 0) return null;
  const start = Math.max(0, Math.floor(r.start));
  const end = r.end === undefined ? size - 1 : Math.min(size - 1, Math.floor(r.end));
  if (start >= size || end < start) return null;
  return { start, end };
}

export { isTempName };
