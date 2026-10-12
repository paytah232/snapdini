// The s3 driver: the same keys, in a bucket.
//
// Any S3-compatible endpoint — SeaweedFS on the LAN, or a hosted bucket — addressed path-style by
// default because that is what self-hosted stores answer to. The SDK is loaded lazily so a
// deployment on the local driver never pays for it, and never needs it installed to boot.
//
// Checksums are sent only WHEN REQUIRED. The SDK's default of computing a CRC on every upload
// wraps the body in aws-chunked framing with trailing checksums, which older S3 implementations
// reject outright. A size-and-ETag verification after upload is what the copy tool does instead.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { randomUUID } from 'crypto';
import { assertKey, assertPrefix, contentTypeFor, isTempName, joinKey } from './keys';
import type { ByteRange, Checkout, CheckoutOptions, MediaBody, MediaStat, MediaStore, PutOptions } from './types';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
  /** Optional key prefix inside the bucket, so several environments can share one. */
  prefix: string;
  /** Local directory for checkouts: the transient working copies tools need. */
  workRoot: string;
  /** Extra CA (PEM file) for a private TLS endpoint. */
  caFile?: string;
  /** Listing page size — lowered by the tests to exercise pagination. */
  listPageSize?: number;
}

/** Read the driver's configuration out of the environment. Throws on anything missing: a store
 *  that cannot be reached is a boot failure, not a feature that quietly stops working. */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv, workRoot: string): S3Config {
  const need = (k: string) => {
    const v = (env[k] || '').trim();
    if (!v) throw new Error(`MEDIA_DRIVER=s3 needs ${k}`);
    return v;
  };
  return {
    endpoint: need('S3_ENDPOINT'),
    region: (env.S3_REGION || '').trim() || 'us-east-1',
    bucket: need('S3_BUCKET'),
    accessKey: need('S3_ACCESS_KEY'),
    secretKey: need('S3_SECRET_KEY'),
    forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? '1').trim() !== '0',
    prefix: (env.S3_PREFIX || '').trim().replace(/^\/+|\/+$/g, ''),
    workRoot,
    caFile: (env.S3_CA_FILE || '').trim() || undefined,
  };
}

type Sdk = typeof import('@aws-sdk/client-s3');
type Client = import('@aws-sdk/client-s3').S3Client;

export class S3Store implements MediaStore {
  readonly driver = 's3' as const;
  private sdk: Sdk | null = null;
  private client: Client | null = null;
  constructor(readonly cfg: S3Config) {}

  private async s3(): Promise<{ sdk: Sdk; client: Client }> {
    if (this.sdk && this.client) return { sdk: this.sdk, client: this.client };
    const sdk: Sdk = await import('@aws-sdk/client-s3');
    let requestHandler: unknown;
    if (this.cfg.caFile) {
      const { NodeHttpHandler } = await import('@smithy/node-http-handler');
      const https = await import('https');
      requestHandler = new NodeHttpHandler({ httpsAgent: new https.Agent({ ca: fs.readFileSync(this.cfg.caFile) }) });
    }
    const client = new sdk.S3Client({
      endpoint: this.cfg.endpoint,
      region: this.cfg.region,
      forcePathStyle: this.cfg.forcePathStyle,
      credentials: { accessKeyId: this.cfg.accessKey, secretAccessKey: this.cfg.secretKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...(requestHandler ? { requestHandler: requestHandler as never } : {}),
    });
    this.sdk = sdk; this.client = client;
    return { sdk, client };
  }

  /** The bucket key for a store key: the environment prefix, then the key. */
  objectKey(key: string): string {
    const k = assertKey(key);
    return this.cfg.prefix ? `${this.cfg.prefix}/${k}` : k;
  }
  private objectPrefix(prefix: string): string {
    const p = assertPrefix(prefix);
    const base = this.cfg.prefix ? `${this.cfg.prefix}/` : '';
    return p ? `${base}${p}/` : base;
  }

  async put(key: string, src: string | Buffer | Readable, opts: PutOptions = {}): Promise<void> {
    const { sdk, client } = await this.s3();
    const Key = this.objectKey(key);
    const ContentType = opts.contentType || contentTypeFor(key);
    if (Buffer.isBuffer(src)) {
      await client.send(new sdk.PutObjectCommand({ Bucket: this.cfg.bucket, Key, Body: src, ContentType, ContentLength: src.length }));
      return;
    }
    if (typeof src === 'string') {
      const size = (await fs.promises.stat(src)).size;
      const rs = fs.createReadStream(src);
      try { await this.putStream(Key, rs, size, ContentType); }
      finally {
        // The descriptor is released on 'close', a tick after the SDK has read the last byte and
        // resolved. Wait for it: a checkout that removes its directory the moment publish()
        // returns was unlinking a file still open — harmless on a local disk, a silly-renamed
        // `.nfs…` file and an ENOTEMPTY on a network one.
        await closed(rs);
      }
      if (opts.move) await fs.promises.unlink(src).catch(() => {});
      return;
    }
    await this.putStream(Key, src, opts.size, ContentType);
  }

  /** Multipart for anything big or of unknown length — 16 MB parts, four in flight. A small file
   *  of known size goes up in one request. */
  private async putStream(Key: string, body: Readable, size: number | undefined, ContentType: string): Promise<void> {
    const { sdk, client } = await this.s3();
    const PART = 16 * 1024 * 1024;
    if (size !== undefined && size <= PART) {
      await client.send(new sdk.PutObjectCommand({ Bucket: this.cfg.bucket, Key, Body: body, ContentType, ContentLength: size }));
      return;
    }
    const { Upload } = await import('@aws-sdk/lib-storage');
    const up = new Upload({
      client,
      params: { Bucket: this.cfg.bucket, Key, Body: body, ContentType },
      partSize: PART,
      queueSize: 4,
      leavePartsOnError: false,
    });
    await up.done();
  }

  async get(key: string, opts: { range?: ByteRange } = {}): Promise<MediaBody | null> {
    const { sdk, client } = await this.s3();
    // The size first, so an unsatisfiable range is a null answer here rather than a thrown
    // InvalidRange — and the serving layer can say 416 with the real length.
    const st = await this.stat(key);
    if (!st) return null;
    let Range: string | undefined;
    let range: MediaBody['range'];
    if (opts.range) {
      const start = Math.max(0, Math.floor(opts.range.start));
      const end = opts.range.end === undefined ? st.size - 1 : Math.min(st.size - 1, Math.floor(opts.range.end));
      if (start >= st.size || end < start) return null;
      Range = `bytes=${start}-${end}`;
      range = { start, end, total: st.size };
    }
    try {
      const r = await client.send(new sdk.GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.objectKey(key), Range }));
      if (!r.Body) return null;
      const stream = r.Body as Readable;
      return {
        size: range ? range.end - range.start + 1 : (r.ContentLength ?? st.size),
        etag: r.ETag || st.etag,
        mtimeMs: r.LastModified ? r.LastModified.getTime() : st.mtimeMs,
        contentType: contentTypeFor(key),
        stream,
        ...(range ? { range } : {}),
      };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async stat(key: string): Promise<MediaStat | null> {
    const { sdk, client } = await this.s3();
    try {
      const r = await client.send(new sdk.HeadObjectCommand({ Bucket: this.cfg.bucket, Key: this.objectKey(key) }));
      return {
        size: r.ContentLength ?? 0,
        etag: r.ETag || '',
        mtimeMs: r.LastModified ? r.LastModified.getTime() : 0,
        contentType: contentTypeFor(key),
      };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async exists(key: string): Promise<boolean> { return (await this.stat(key)) !== null; }

  async delete(key: string): Promise<void> {
    const { sdk, client } = await this.s3();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: this.objectKey(key) }));
  }

  async deletePrefix(prefix: string): Promise<number> {
    const p = assertPrefix(prefix);
    if (!p) throw new Error('refusing to delete the whole bucket prefix');
    const { sdk, client } = await this.s3();
    const Prefix = this.objectPrefix(p);
    let n = 0;
    // List from the start each time rather than following a continuation token: a token points
    // into a listing the deletes below have just changed. Loop until the prefix answers empty.
    for (;;) {
      const page = await client.send(new sdk.ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix, MaxKeys: this.cfg.listPageSize }));
      const keys = (page.Contents ?? []).map((o) => o.Key!).filter(Boolean);
      if (!keys.length) break;
      // Batches of 1000, the API's ceiling; the SDK does not split them for us.
      for (let i = 0; i < keys.length; i += 1000) {
        const slice = keys.slice(i, i + 1000);
        await client.send(new sdk.DeleteObjectsCommand({
          Bucket: this.cfg.bucket, Delete: { Objects: slice.map((Key) => ({ Key })), Quiet: true },
        }));
        n += slice.length;
      }
    }
    return n;
  }

  private async listPage(prefix: string): Promise<{ files: string[]; dirs: string[] }> {
    const { sdk, client } = await this.s3();
    const Prefix = this.objectPrefix(prefix);
    const files: string[] = [], dirs: string[] = [];
    let ContinuationToken: string | undefined;
    do {
      const page = await client.send(new sdk.ListObjectsV2Command({
        Bucket: this.cfg.bucket, Prefix, Delimiter: '/', ContinuationToken, MaxKeys: this.cfg.listPageSize,
      }));
      for (const o of page.Contents ?? []) {
        const name = o.Key!.slice(Prefix.length);
        if (name && !name.includes('/')) files.push(name);
      }
      for (const c of page.CommonPrefixes ?? []) {
        const name = (c.Prefix || '').slice(Prefix.length).replace(/\/$/, '');
        if (name) dirs.push(name);
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return { files: files.sort(), dirs: dirs.sort() };
  }

  async list(prefix: string): Promise<string[]> { return (await this.listPage(prefix)).files; }
  async listDirs(prefix: string): Promise<string[]> { return (await this.listPage(prefix)).dirs; }

  async copy(from: string, to: string): Promise<void> {
    const { sdk, client } = await this.s3();
    await client.send(new sdk.CopyObjectCommand({
      Bucket: this.cfg.bucket,
      CopySource: `/${this.cfg.bucket}/${encodeURIComponent(this.objectKey(from)).replace(/%2F/g, '/')}`,
      Key: this.objectKey(to),
      ContentType: contentTypeFor(to),
      MetadataDirective: 'REPLACE',
    }));
  }

  /** Download one object to a local file, atomically. False when it does not exist. */
  async download(key: string, dest: string): Promise<boolean> {
    const body = await this.get(key);
    if (!body) return false;
    const tmp = `${dest}.${randomUUID().slice(0, 8)}.part`;
    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await pipeline(body.stream, fs.createWriteStream(tmp));
      await fs.promises.rename(tmp, dest);
      return true;
    } catch (e) {
      await fs.promises.unlink(tmp).catch(() => {});
      throw e;
    }
  }

  async checkout(prefix: string, opts: CheckoutOptions = {}): Promise<Checkout> {
    const p = assertPrefix(prefix);
    const dir = path.join(this.cfg.workRoot, `work-${randomUUID()}`);
    await fs.promises.mkdir(dir, { recursive: true });
    const store = this;
    /** What was last published or fetched, so publish() with no names uploads only what moved. */
    const seen = new Map<string, string>();
    const stamp = async (name: string): Promise<string | null> => {
      try { const st = await fs.promises.stat(path.join(dir, name)); return `${st.size}:${Math.floor(st.mtimeMs)}`; }
      catch { return null; }
    };
    let released = false;
    const co: Checkout = {
      prefix: p,
      dir,
      path: (name: string) => {
        if (name.includes('/') || name.includes('..') || !name) throw new Error('unsafe checkout name: ' + name);
        return path.join(dir, name);
      },
      async fetch(names?: string[]) {
        const have = new Set(await store.list(p));
        const want = names ? names.filter((n) => have.has(n)) : [...have];
        const present = new Set<string>();
        // A few at a time: an event with hundreds of photos is the slideshow case, and one
        // connection per object would be the wrong shape for a LAN store.
        let i = 0;
        const worker = async () => {
          while (i < want.length) {
            const n = want[i++];
            const local = co.path(n);
            if (await stamp(n) !== null) { present.add(n); continue; }   // already here (adopted or fetched)
            if (await store.download(joinKey(p, n), local)) { present.add(n); seen.set(n, (await stamp(n))!); }
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, want.length || 1) }, worker));
        return present;
      },
      async publish(names?: string[]) {
        let todo: string[];
        if (names) todo = names;
        else {
          const ents = await fs.promises.readdir(dir);
          todo = [];
          for (const n of ents) {
            if (isTempName(n)) continue;
            const s = await stamp(n);
            if (s !== null && seen.get(n) !== s) todo.push(n);
          }
        }
        for (const n of todo) {
          const local = co.path(n);
          const s = await stamp(n);
          if (s === null) continue;                       // asked to publish something not there: not an error
          await store.put(joinKey(p, n), local);
          seen.set(n, s);
        }
      },
      async remove(names: string[]) {
        for (const n of names) {
          await store.delete(joinKey(p, n));
          await fs.promises.unlink(co.path(n)).catch(() => {});
          seen.delete(n);
        }
      },
      async release() {
        if (released) return;
        released = true;
        // Best effort, never thrown: a working directory that will not go is litter the hourly
        // sweeper collects, and litter must not fail the upload that has already succeeded. One
        // retry after a beat covers a descriptor that is still being closed.
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await fs.promises.rm(dir, { recursive: true, force: true }); return; }
          catch (e) {
            if (attempt === 2) { console.warn(`[media] could not remove working directory ${dir}:`, (e as Error).message); return; }
            await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          }
        }
      },
    };
    try {
      for (const a of opts.adopt ?? []) {
        // Staging and the working directory share a filesystem in every deployment we ship, so
        // this is a rename; across devices it degrades to a copy and never to a failure.
        try { await fs.promises.rename(a.from, co.path(a.name)); }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
          await fs.promises.copyFile(a.from, co.path(a.name));
          await fs.promises.unlink(a.from).catch(() => {});
        }
      }
      if (opts.fetch) await co.fetch(opts.fetch);
    } catch (e) {
      await co.release();
      throw e;
    }
    return co;
  }
}

/** Resolves once a read stream has released its descriptor (or already has). */
function closed(rs: fs.ReadStream): Promise<void> {
  if (rs.closed) return Promise.resolve();
  return new Promise((resolve) => { rs.once('close', () => resolve()); rs.once('error', () => resolve()); });
}

function isNotFound(e: unknown): boolean {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err?.name === 'NoSuchKey' || err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404;
}

export const defaultWorkRoot = (): string => path.join(os.tmpdir(), 'snapdini-media');
