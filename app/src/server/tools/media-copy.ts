// Copy every object from one media store to another. The cut-over tool.
//
//   npx tsx src/server/tools/media-copy.ts --from local --to s3 [--dry-run] [--verify size|etag|full]
//                                          [--prefix <eventId>] [--concurrency 4] [--manifest out.json]
//
// Inside the container the environment already names both stores: `local` is UPLOADS_DIR and `s3`
// is the S3_* settings, so the usual invocation is
//   docker compose exec app npx tsx src/server/tools/media-copy.ts --from local --to s3 --verify full
//
// WHAT IT PROMISES. It never deletes anything, anywhere. It is resumable: an object already at the
// destination with the same size (and, under --verify etag, the same validator) is skipped, so a
// copy interrupted at object 300 of 400 picks up where it stopped. It exits non-zero if ANY object
// could not be copied or failed verification, and says which. `--verify full` reads every copied
// object back and compares a SHA-256 of the bytes, which is the check to run before a cut-over.
// Nothing under a dotfile prefix is copied (staging, working copies, render temp).
//
// Cut-over = run this while live (resumable), stop the app, run it once more for the delta with
// --verify full, flip MEDIA_DRIVER, start, keep the old copy until you are sure.
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { UPLOADS_DIR } from '../paths';
import { LocalStore } from '../media/local';
import { S3Store, s3ConfigFromEnv } from '../media/s3';
import type { MediaStore } from '../media/types';
import { isTempName, joinKey } from '../media/keys';

type Args = { from: string; to: string; dryRun: boolean; verify: 'size' | 'etag' | 'full'; prefix: string; concurrency: number; manifest?: string };

export function parseArgs(argv: string[]): Args {
  const a: Args = { from: 'local', to: 's3', dryRun: false, verify: 'size', prefix: '', concurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--from') { a.from = v; i++; }
    else if (k === '--to') { a.to = v; i++; }
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--verify') { if (v !== 'size' && v !== 'etag' && v !== 'full') throw new Error('--verify size|etag|full'); a.verify = v; i++; }
    else if (k === '--prefix') { a.prefix = v; i++; }
    else if (k === '--concurrency') { a.concurrency = Math.max(1, Number(v) || 4); i++; }
    else if (k === '--manifest') { a.manifest = v; i++; }
    else throw new Error(`unknown argument ${k}`);
  }
  if (a.from === a.to) throw new Error('--from and --to must differ');
  return a;
}

export function storeFor(driver: string, workRoot: string): MediaStore {
  if (driver === 'local') return new LocalStore(UPLOADS_DIR);
  if (driver === 's3') return new S3Store(s3ConfigFromEnv(process.env, workRoot));
  throw new Error(`unknown driver ${driver} (local|s3)`);
}

/** Every key under `prefix` (one level of folders, like the app's own layout), skipping temp and
 *  dotfile names. The root's own loose files are included when no prefix is given. */
export async function walkKeys(store: MediaStore, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  const dirs = prefix ? [prefix] : ['', ...(await store.listDirs(''))];
  for (const d of dirs) {
    if (d.startsWith('.')) continue;
    for (const n of await store.list(d)) if (!isTempName(n)) keys.push(joinKey(d, n));
  }
  return keys.sort();
}

async function sha256(store: MediaStore, key: string): Promise<string> {
  const body = await store.get(key);
  if (!body) throw new Error('missing');
  const h = createHash('sha256');
  for await (const c of body.stream) h.update(c as Buffer);
  return h.digest('hex');
}

export type CopyReport = { copied: number; skipped: number; failed: { key: string; why: string }[]; manifest: Record<string, { size: number; sha256?: string }> };

export async function copyAll(from: MediaStore, to: MediaStore, a: Args, log: (s: string) => void = console.log): Promise<CopyReport> {
  const keys = await walkKeys(from, a.prefix);
  log(`${keys.length} object(s) under ${a.from}${a.prefix ? ` prefix ${a.prefix}/` : ''}${a.dryRun ? ' (dry run)' : ''}`);
  const report: CopyReport = { copied: 0, skipped: 0, failed: [], manifest: {} };
  let i = 0, done = 0;
  const worker = async () => {
    while (i < keys.length) {
      const key = keys[i++];
      try {
        const src = await from.stat(key);
        if (!src) throw new Error('vanished from the source');
        const dst = await to.stat(key);
        // "Already there" is a size match — and under --verify etag a validator match too, but
        // only when both sides hold a STRONG one (an MD5 from a bucket). The local driver's
        // validator is weak (`W/"size-mtime"`) and can never equal a bucket's, so comparing those
        // would re-copy every object on every run and the tool would not be resumable at all.
        const strong = (e: string) => !!e && !e.startsWith('W/');
        const same = dst && dst.size === src.size
          && (a.verify !== 'etag' || !strong(dst.etag) || !strong(src.etag) || dst.etag === src.etag);
        if (same) { report.skipped++; report.manifest[key] = { size: src.size }; }
        else if (a.dryRun) { report.copied++; report.manifest[key] = { size: src.size }; }
        else {
          const body = await from.get(key);
          if (!body) throw new Error('vanished from the source');
          await to.put(key, body.stream, { size: body.size, contentType: body.contentType });
          const after = await to.stat(key);
          if (!after || after.size !== src.size) throw new Error(`size mismatch after copy: ${after?.size} != ${src.size}`);
          report.copied++;
          report.manifest[key] = { size: src.size };
        }
        if (a.verify === 'full' && !a.dryRun) {
          const [x, y] = await Promise.all([sha256(from, key), sha256(to, key)]);
          if (x !== y) throw new Error(`sha256 mismatch: source ${x.slice(0, 12)} destination ${y.slice(0, 12)}`);
          report.manifest[key].sha256 = x;
        }
      } catch (e) {
        report.failed.push({ key, why: (e as Error).message });
      }
      done++;
      if (done % 50 === 0 || done === keys.length) log(`  ${done}/${keys.length}  copied ${report.copied}  skipped ${report.skipped}  failed ${report.failed.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(a.concurrency, keys.length || 1) }, worker));
  return report;
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  const work = path.join(UPLOADS_DIR, '.work');
  const from = storeFor(a.from, work), to = storeFor(a.to, work);
  const report = await copyAll(from, to, a);
  if (a.manifest) fs.writeFileSync(a.manifest, JSON.stringify({ from: a.from, to: a.to, at: new Date().toISOString(), verify: a.verify, ...report }, null, 2));
  console.log(`copied ${report.copied}, skipped ${report.skipped} already there, failed ${report.failed.length}`);
  for (const f of report.failed) console.error(`  FAILED ${f.key}: ${f.why}`);
  return report.failed.length ? 1 : 0;
}

if (require.main === module) main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(2); });
