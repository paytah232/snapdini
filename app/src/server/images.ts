import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import sharp from 'sharp';

// Each sharp operation runs single-threaded; we instead run a bounded NUMBER of operations in
// parallel (the semaphore below). That keeps total threads ≈ cores under an upload burst
// (every guest shooting at once) instead of N operations each spawning a core's worth of
// threads and thrashing CPU/RAM — important now that originals are kept at max quality.
sharp.concurrency(1);
const MAX_CONCURRENT = parseInt(process.env.IMAGE_CONCURRENCY || '', 10) || Math.max(2, os.cpus().length - 1);

// JPEG quality for stored originals. Default 100 (maximum). Lower it via IMAGE_QUALITY (1–100) to
// trade a little fidelity for much smaller files / less disk. At ≥90 we keep full 4:4:4 chroma; below
// that we use 4:2:0 + mozjpeg, which is where the real size savings come from.
const IMAGE_QUALITY = (() => {
  const q = parseInt(process.env.IMAGE_QUALITY || '', 10);
  return Number.isFinite(q) && q >= 1 && q <= 100 ? q : 100;
})();
let active = 0;
const waiters: Array<() => void> = [];
async function withImageSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
  active++;
  try { return await fn(); }
  finally { active--; waiters.shift()?.(); }
}

// Re-encode an uploaded image in place to strip ALL embedded metadata — most importantly
// EXIF GPS coordinates (guests' locations), plus camera serial, timestamps, thumbnails.
// `.rotate()` bakes in the EXIF orientation first so the photo still looks right once the
// orientation tag is gone. Throws if the file isn't a decodable image, which doubles as
// magic-byte validation (we don't trust the client-supplied MIME type).
// FULL resolution is always preserved (no downscale). Quality follows IMAGE_QUALITY (default 100).
export async function stripImageMetadata(filePath: string): Promise<{ width?: number; height?: number }> {
  const hi = IMAGE_QUALITY >= 90;
  const { data, info } = await withImageSlot(() => sharp(filePath)
    .rotate()
    .jpeg({ quality: IMAGE_QUALITY, chromaSubsampling: hi ? '4:4:4' : '4:2:0', mozjpeg: !hi })
    .toBuffer({ resolveWithObject: true }));
  await fs.promises.writeFile(filePath, data);
  return { width: info.width, height: info.height };
}

// The thumbnail filename that sits alongside an original (e.g. abc.jpg → abc_thumb.webp).
export function thumbName(filename: string): string {
  return filename.replace(/\.[^.]+$/, '') + '_thumb.webp';
}

// Generate a small, fast-loading thumbnail next to the original for grid display.
// The original is left untouched (full quality, full resolution) for download.
export async function makeThumbnail(originalPath: string): Promise<void> {
  const dir = path.dirname(originalPath);
  const thumb = path.join(dir, thumbName(path.basename(originalPath)));
  const buf = await withImageSlot(() => sharp(originalPath)
    .rotate()
    .resize(640, 640, { fit: 'cover' })
    .webp({ quality: 72 })
    .toBuffer());
  await fs.promises.writeFile(thumb, buf);
}

// Extract a poster frame from a video and write it as the sibling thumbnail (same naming as
// photos, so the gallery can show a static <img> instead of spinning up a <video> per cell).
// Best-effort: returns false (no poster) if ffmpeg can't read a frame.
export async function makeVideoPoster(videoPath: string): Promise<boolean> {
  const thumb = path.join(path.dirname(videoPath), thumbName(path.basename(videoPath)));
  const frame = await new Promise<Buffer | null>((resolve) => {
    // Decode just the first frame to a PNG on stdout (-an: ignore audio).
    const p = spawn('ffmpeg', ['-i', videoPath, '-frames:v', '1', '-an', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']);
    const chunks: Buffer[] = [];
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } resolve(null); }, 15_000);
    p.stdout.on('data', (d) => chunks.push(d as Buffer));
    p.stderr.on('data', () => { /* drain so the pipe never blocks */ });
    p.on('error', () => { clearTimeout(t); resolve(null); });
    p.on('close', () => { clearTimeout(t); resolve(chunks.length ? Buffer.concat(chunks) : null); });
  });
  if (!frame) return false;
  try {
    const buf = await withImageSlot(() => sharp(frame).resize(640, 640, { fit: 'cover' }).webp({ quality: 72 }).toBuffer());
    await fs.promises.writeFile(thumb, buf);
    return true;
  } catch { return false; }
}

// One-time/best-effort: generate missing thumbnails for pre-existing photo originals.
// Scans the uploads dir for .jpg originals without a sibling _thumb.webp. Runs on boot.
export async function backfillThumbnails(uploadsDir: string): Promise<number> {
  let entries: string[];
  try { entries = await fs.promises.readdir(uploadsDir); }
  catch { return 0; }
  let made = 0;
  for (const name of entries) {
    if (name.includes('_thumb')) continue;
    const isPhoto = /\.jpe?g$/i.test(name);
    const isVideo = /\.(mp4|webm|mov|m4v)$/i.test(name);
    if (!isPhoto && !isVideo) continue;
    const original = path.join(uploadsDir, name);
    const thumb = path.join(uploadsDir, thumbName(name));
    try { await fs.promises.access(thumb); continue; } catch { /* missing → make it */ }
    try { if (isPhoto) await makeThumbnail(original); else await makeVideoPoster(original); made++; }
    catch { /* skip undecodable */ }
  }
  if (made) console.log(`[thumbs] backfilled ${made} thumbnail(s)`);
  return made;
}
