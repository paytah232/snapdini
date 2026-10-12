// A tiny S3 that lives inside the test process.
//
// Enough of the protocol for the s3 driver and the copy tool to be exercised end to end with no
// network, no credentials and no container: path-style PutObject / GetObject (with Range) /
// HeadObject / DeleteObject / DeleteObjects / ListObjectsV2 (with delimiter and paging) /
// CopyObject, and the multipart trio the SDK's Upload uses for anything over one part. Signatures
// are not checked — this is a stub, not a server.
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

type Obj = { body: Buffer; etag: string; mtime: Date; contentType: string };

export interface S3Stub {
  endpoint: string;
  bucket: string;
  objects: Map<string, Obj>;
  /** Requests seen, for assertions about how the driver behaves. */
  log: { method: string; url: string }[];
  close(): Promise<void>;
}

const xmlEsc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
const md5 = (b: Buffer) => `"${createHash('md5').update(b).digest('hex')}"`;

export async function startS3Stub(bucket = 'test-bucket'): Promise<S3Stub> {
  const objects = new Map<string, Obj>();
  const uploads = new Map<string, { key: string; contentType: string; parts: Map<number, Buffer> }>();
  const log: S3Stub['log'] = [];
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    log.push({ method: req.method || '', url: req.url || '' });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const parts = url.pathname.split('/').filter(Boolean);
    const b = parts[0];
    const key = parts.slice(1).map(decodeURIComponent).join('/');
    const send = (status: number, text = '', headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-length': String(Buffer.byteLength(text)), ...headers });
      res.end(text);
    };
    if (b !== bucket) return send(404, '<Error><Code>NoSuchBucket</Code></Error>');

    // ── bucket-level ──
    if (!key) {
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') || '';
        const delimiter = url.searchParams.get('delimiter') || '';
        const maxKeys = Math.max(1, Number(url.searchParams.get('max-keys') || 1000));
        const after = url.searchParams.get('continuation-token') || '';
        const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const contents: string[] = [], prefixes = new Set<string>();
        const entries: { kind: 'c' | 'p'; v: string }[] = [];
        for (const k of all) {
          const rest = k.slice(prefix.length);
          if (delimiter && rest.includes(delimiter)) {
            const cp = prefix + rest.slice(0, rest.indexOf(delimiter) + 1);
            if (!prefixes.has(cp)) { prefixes.add(cp); entries.push({ kind: 'p', v: cp }); }
          } else entries.push({ kind: 'c', v: k });
        }
        const start = after ? entries.findIndex((e) => e.v === after) + 1 : 0;
        const page = entries.slice(start, start + maxKeys);
        const truncated = start + maxKeys < entries.length;
        for (const e of page) {
          if (e.kind === 'c') {
            const o = objects.get(e.v)!;
            contents.push(`<Contents><Key>${xmlEsc(e.v)}</Key><LastModified>${o.mtime.toISOString()}</LastModified><ETag>${xmlEsc(o.etag)}</ETag><Size>${o.body.length}</Size></Contents>`);
          } else contents.push(`<CommonPrefixes><Prefix>${xmlEsc(e.v)}</Prefix></CommonPrefixes>`);
        }
        const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${xmlEsc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${xmlEsc(page[page.length - 1].v)}</NextContinuationToken>` : ''}${contents.join('')}</ListBucketResult>`;
        return send(200, xml, { 'content-type': 'application/xml' });
      }
      if (req.method === 'POST' && url.searchParams.has('delete')) {
        const keys = [...body.toString().matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
        for (const k of keys) objects.delete(k);
        return send(200, `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${keys.map((k) => `<Deleted><Key>${xmlEsc(k)}</Key></Deleted>`).join('')}</DeleteResult>`, { 'content-type': 'application/xml' });
      }
      return send(400, '<Error><Code>BadRequest</Code></Error>');
    }

    // ── multipart ──
    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      const id = `up-${++seq}`;
      uploads.set(id, { key, contentType: String(req.headers['content-type'] || 'application/octet-stream'), parts: new Map() });
      return send(200, `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${xmlEsc(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`, { 'content-type': 'application/xml' });
    }
    if (req.method === 'PUT' && url.searchParams.has('uploadId')) {
      const up = uploads.get(url.searchParams.get('uploadId')!);
      if (!up) return send(404, '<Error><Code>NoSuchUpload</Code></Error>');
      const n = Number(url.searchParams.get('partNumber'));
      up.parts.set(n, body);
      return send(200, '', { etag: md5(body) });
    }
    if (req.method === 'POST' && url.searchParams.has('uploadId')) {
      const id = url.searchParams.get('uploadId')!;
      const up = uploads.get(id);
      if (!up) return send(404, '<Error><Code>NoSuchUpload</Code></Error>');
      const order = [...up.parts.keys()].sort((a, b) => a - b);
      const whole = Buffer.concat(order.map((n) => up.parts.get(n)!));
      const etag = `"${createHash('md5').update(whole).digest('hex')}-${order.length}"`;
      objects.set(up.key, { body: whole, etag, mtime: new Date(), contentType: up.contentType });
      uploads.delete(id);
      return send(200, `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Location>http://x/${bucket}/${xmlEsc(up.key)}</Location><Bucket>${bucket}</Bucket><Key>${xmlEsc(up.key)}</Key><ETag>${xmlEsc(etag)}</ETag></CompleteMultipartUploadResult>`, { 'content-type': 'application/xml' });
    }
    if (req.method === 'DELETE' && url.searchParams.has('uploadId')) {
      uploads.delete(url.searchParams.get('uploadId')!);
      return send(204);
    }

    // ── objects ──
    if (req.method === 'PUT') {
      const src = req.headers['x-amz-copy-source'];
      if (src) {
        const from = decodeURIComponent(String(src)).replace(/^\/?[^/]+\//, '');
        const o = objects.get(from);
        if (!o) return send(404, '<Error><Code>NoSuchKey</Code></Error>');
        const copy = { ...o, mtime: new Date(), contentType: String(req.headers['content-type'] || o.contentType) };
        objects.set(key, copy);
        return send(200, `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>${xmlEsc(copy.etag)}</ETag><LastModified>${copy.mtime.toISOString()}</LastModified></CopyObjectResult>`, { 'content-type': 'application/xml' });
      }
      const o = { body, etag: md5(body), mtime: new Date(), contentType: String(req.headers['content-type'] || 'application/octet-stream') };
      objects.set(key, o);
      return send(200, '', { etag: o.etag });
    }
    const o = objects.get(key);
    if (req.method === 'DELETE') { objects.delete(key); return send(204); }
    if (!o) return req.method === 'HEAD' ? send(404) : send(404, '<Error><Code>NoSuchKey</Code><Message>no</Message></Error>', { 'content-type': 'application/xml' });
    const base = { etag: o.etag, 'last-modified': o.mtime.toUTCString(), 'content-type': o.contentType, 'accept-ranges': 'bytes' };
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...base, 'content-length': String(o.body.length) });
      return res.end();
    }
    if (req.method === 'GET') {
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
      if (range) {
        const size = o.body.length;
        let start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
        const end = range[1] !== '' && range[2] !== '' ? Math.min(size - 1, Number(range[2])) : size - 1;
        if (start >= size || end < start) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
        const slice = o.body.subarray(start, end + 1);
        res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(slice.length) });
        return res.end(slice);
      }
      res.writeHead(200, { ...base, 'content-length': String(o.body.length) });
      return res.end(o.body);
    }
    return send(405);
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    objects,
    log,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
