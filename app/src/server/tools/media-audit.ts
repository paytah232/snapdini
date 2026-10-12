// Does the store hold everything the database points at? The post-cut-over check.
//
//   docker compose exec app npx tsx src/server/tools/media-audit.ts [--driver local|s3] [--derived]
//
// Walks every key a row references — photos.filename, slideshows.filename,
// contact_messages.image_filename, and the /uploads/ paths inside events.theme and
// events.poster_config — and asks the store for each. Exits non-zero and lists every key that is
// missing. `--derived` also checks each photo's thumbnail, which every row should have, and
// reports (without failing) which derived clips exist, so a cut-over can be compared against the
// listing the old store gave.
import path from 'path';
import { sql } from 'drizzle-orm';
import { db, init } from '../db';
import { UPLOADS_DIR } from '../paths';
import { thumbName, derivedNames } from '../images';
import { keyFromWebPath } from '../media/keys';
import type { MediaStore } from '../media/types';
import { storeFor } from './media-copy';

export async function referencedKeys(): Promise<{ required: string[]; thumbs: string[]; derived: string[] }> {
  const required = new Set<string>(), thumbs = new Set<string>(), derived = new Set<string>();
  const photos = await db.execute(sql`SELECT filename, media_type FROM photos`);
  for (const r of (photos.rows ?? photos) as Array<{ filename: string; media_type: string | null }>) {
    required.add(r.filename);
    thumbs.add(thumbName(r.filename));
    if (r.media_type === 'video') for (const d of derivedNames(r.filename)) if (!d.endsWith('_thumb.webp') || d === thumbName(r.filename)) derived.add(d);
  }
  const ss = await db.execute(sql`SELECT filename FROM slideshows`);
  for (const r of (ss.rows ?? ss) as Array<{ filename: string }>) required.add(r.filename);
  const cm = await db.execute(sql`SELECT image_filename FROM contact_messages WHERE image_filename IS NOT NULL`);
  for (const r of (cm.rows ?? cm) as Array<{ image_filename: string }>) required.add(r.image_filename);
  const ev = await db.execute(sql`SELECT theme, poster_config FROM events WHERE purged_at IS NULL`);
  for (const r of (ev.rows ?? ev) as Array<{ theme: string | null; poster_config: string | null }>) {
    for (const raw of [r.theme, r.poster_config]) {
      if (!raw) continue;
      for (const m of raw.matchAll(/"(\/uploads\/[A-Za-z0-9._/-]+)"/g)) { try { required.add(keyFromWebPath(m[1])); } catch { /* not ours */ } }
    }
  }
  return { required: [...required].sort(), thumbs: [...thumbs].sort(), derived: [...derived].sort() };
}

export async function audit(store: MediaStore, withDerived: boolean, log: (s: string) => void = console.log): Promise<{ missing: string[]; missingThumbs: string[] }> {
  const { required, thumbs, derived } = await referencedKeys();
  const check = async (keys: string[]) => {
    const missing: string[] = [];
    let i = 0;
    const worker = async () => { while (i < keys.length) { const k = keys[i++]; if (!(await store.exists(k))) missing.push(k); } };
    await Promise.all(Array.from({ length: Math.min(8, keys.length || 1) }, worker));
    return missing.sort();
  };
  const missing = await check(required);
  log(`${required.length} referenced object(s): ${required.length - missing.length} present, ${missing.length} missing`);
  let missingThumbs: string[] = [];
  if (withDerived) {
    missingThumbs = await check(thumbs);
    log(`${thumbs.length} thumbnail(s): ${thumbs.length - missingThumbs.length} present, ${missingThumbs.length} missing (backfilled on next boot)`);
    const present = derived.length - (await check(derived)).length;
    log(`${derived.length} possible derived clip name(s): ${present} present (most are expected to be absent)`);
  }
  return { missing, missingThumbs };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const driver = argv.includes('--driver') ? argv[argv.indexOf('--driver') + 1] : (process.env.MEDIA_DRIVER || 'local');
  await init();
  const store = storeFor(driver, path.join(UPLOADS_DIR, '.work'));
  const { missing } = await audit(store, argv.includes('--derived'));
  for (const k of missing) console.error(`  MISSING ${k}`);
  return missing.length ? 1 : 0;
}

if (require.main === module) main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(2); });
