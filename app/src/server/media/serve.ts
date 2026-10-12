// `/uploads/<key>` straight out of the store.
//
// The local driver keeps express.static, which already does everything below. This is the same
// contract for a bucket: unauthenticated by unguessable uuid (see the gate in index.ts and spec
// 97b), a year of immutable caching, conditional requests answered with 304, and Range honoured so
// a phone can scrub a clip. Access control stays in the app — there are no presigned URLs — so the
// URLs the web app, the emails and the share pages hold never change.
import type { Request, Response, NextFunction } from 'express';
import { assertKey, contentTypeFor } from './keys';
import type { MediaStore } from './types';

const YEAR = 365 * 24 * 60 * 60;

export function serveUploads(store: MediaStore) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let key: string;
    try {
      key = assertKey(decodeURIComponent(req.path));
      // Dotfiles are never media: staging dirs and markers. express.static ignores them too.
      if (key.split('/').some((seg) => seg.startsWith('.'))) { res.status(404).end(); return; }
    } catch { res.status(404).end(); return; }

    try {
      const st = await store.stat(key);
      if (!st) { res.status(404).end(); return; }

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', `public, max-age=${YEAR}, immutable`);
      res.setHeader('Content-Type', contentTypeFor(key));
      if (st.etag) res.setHeader('ETag', st.etag);
      if (st.mtimeMs) res.setHeader('Last-Modified', new Date(st.mtimeMs).toUTCString());

      // Conditional: the ETag first, then the date, exactly as express.static resolves them.
      const inm = req.headers['if-none-match'];
      if (inm && st.etag && inm.split(',').map((s) => s.trim()).some((t) => t === st.etag || t === '*')) {
        res.status(304).end(); return;
      }
      const ims = req.headers['if-modified-since'];
      if (!inm && ims && st.mtimeMs && Math.floor(st.mtimeMs / 1000) <= Math.floor(Date.parse(ims) / 1000)) {
        res.status(304).end(); return;
      }

      const range = parseRange(req.headers.range, st.size);
      if (range === 'unsatisfiable') {
        res.setHeader('Content-Range', `bytes */${st.size}`);
        res.status(416).end();
        return;
      }
      if (req.method === 'HEAD') {
        res.setHeader('Content-Length', String(st.size));
        res.status(200).end();
        return;
      }
      const body = await store.get(key, range ? { range } : undefined);
      if (!body) { res.status(404).end(); return; }
      if (body.range) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${body.range.start}-${body.range.end}/${body.range.total}`);
        res.setHeader('Content-Length', String(body.range.end - body.range.start + 1));
      } else {
        res.status(200);
        res.setHeader('Content-Length', String(body.size));
      }
      // A client that goes away mid-body must not leave the object stream open against the store.
      res.on('close', () => { if (!res.writableFinished) body.stream.destroy(); });
      body.stream.on('error', (e) => { console.error('[uploads] stream error for %s:', key, (e as Error).message); res.destroy(); });
      body.stream.pipe(res);
    } catch (e) {
      console.error('[uploads] %s:', key, (e as Error).message);
      if (!res.headersSent) res.status(502).end();
      else res.destroy();
    }
  };
}

/** One `bytes=a-b` range, or the suffix form `bytes=-n`. Anything else is ignored (a full 200),
 *  which is what RFC 7233 allows; only a syntactically valid range that cannot be satisfied is a
 *  416. Multiple ranges are deliberately not supported — nothing we serve asks for them. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (size <= 0) return 'unsatisfiable';
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(size - 1, Number(m[2]));
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}
