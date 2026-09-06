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

/** `<id>.webm` → `<id>_play.mp4`. The playback copy sits beside the original. */
export function playName(filename: string): string {
  return filename.replace(/\.[^.]+$/, '') + '_play.mp4';
}

// One transcode at a time. ffmpeg will happily eat every core, and a guest uploading during a
// live event matters more than a proxy finishing quickly.
let videoActive = 0;
const videoWaiters: Array<() => void> = [];
async function withVideoSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (videoActive >= 1) await new Promise<void>((r) => videoWaiters.push(r));
  videoActive++;
  try { return await fn(); }
  finally { videoActive--; videoWaiters.shift()?.(); }
}

/**
 * A playback copy every phone can actually decode.
 *
 * Browser MediaRecorder hands us whatever the device felt like producing — commonly VP8 in WebM,
 * which is the one format with essentially no hardware decoder on phones. A 4K VP8 clip is decoded
 * on the CPU and stutters, while the same file plays perfectly on a laptop, which makes it look
 * like the recording failed. Worse, Safari will not reliably play WebM at all, so an iPhone guest
 * can be unable to watch a clip that recorded without error.
 *
 * H.264 in MP4 at 1080p has a hardware decoder on essentially every phone made in the last decade.
 * The ORIGINAL is untouched and is still what downloads — this is only what the gallery plays.
 *
 * Returns true when a proxy now exists (including when the original was already fine and none was
 * needed — the caller only cares whether playback is safe).
 */
export async function makePlaybackProxy(videoPath: string): Promise<boolean> {
  const out = path.join(path.dirname(videoPath), playName(path.basename(videoPath)));
  try { await fs.promises.access(out); return true; } catch { /* not built yet */ }

  const probe = await new Promise<{ codec: string; height: number } | null>((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,height', '-of', 'csv=p=0', videoPath]);
    let outBuf = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } resolve(null); }, 15_000);
    p.stdout.on('data', (d) => { outBuf += String(d); });
    p.stderr.on('data', () => { /* drain */ });
    p.on('error', () => { clearTimeout(t); resolve(null); });
    p.on('close', () => {
      clearTimeout(t);
      const [codec, h] = outBuf.trim().split(',');
      resolve(codec ? { codec, height: Number(h) || 0 } : null);
    });
  });
  // Already the thing we would transcode to: leave it alone rather than re-encode and lose quality.
  if (probe && /^(h264|avc1)$/i.test(probe.codec) && probe.height > 0 && probe.height <= 1920 &&
      /\.(mp4|m4v)$/i.test(videoPath)) return true;
  if (!probe) return false;

  return withVideoSlot(() => new Promise<boolean>((resolve) => {
    const tmp = out + '.tmp.mp4';
    // scale=-2 keeps the aspect and forces an even width, which H.264 requires. The cap is on the
    // LONG edge so portrait clips (the common case) come out 1080 wide, not 1080 tall.
    const p = spawn('ffmpeg', ['-v', 'error', '-y', '-i', videoPath,
      '-vf', "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '128k', tmp]);
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } }, 10 * 60_000);
    p.stderr.on('data', () => { /* drain */ });
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', async (code) => {
      clearTimeout(t);
      if (code !== 0) { try { await fs.promises.unlink(tmp); } catch { /* */ } return resolve(false); }
      try { await fs.promises.rename(tmp, out); resolve(true); }
      catch { resolve(false); }
    });
  }));
}

// Generate a missing thumbnail for one original if it doesn't already have a sibling _thumb.webp.
async function backfillOne(original: string): Promise<boolean> {
  const name = path.basename(original);
  if (name.includes('_thumb')) return false;
  const isPhoto = /\.jpe?g$/i.test(name);
  const isVideo = /\.(mp4|webm|mov|m4v)$/i.test(name);
  if (!isPhoto && !isVideo) return false;
  const thumb = path.join(path.dirname(original), thumbName(name));
  try { await fs.promises.access(thumb); return false; } catch { /* missing → make it */ }
  try { if (isPhoto) await makeThumbnail(original); else await makeVideoPoster(original); return true; }
  catch { return false; }
}

// One-time/best-effort: generate missing thumbnails for pre-existing photo originals. Scans the
// uploads dir AND one level of event subfolders (/uploads/<eventId>/…, the per-event layout),
// skipping dotdirs (staging / render temp). Runs on boot.
/**
 * Build playback copies for guest videos uploaded before this existed.
 *
 * Takes an explicit list rather than walking the uploads directory: that directory also holds
 * slideshow renders, which are already H.264 MP4 and are not guest media — a blind walk transcoded
 * 83 of them into 49MB of proxies nothing would ever play. The caller passes exactly the filenames
 * that `photos` says are videos.
 *
 * One at a time via the video slot, so a boot on a small box cannot peg every core.
 */
export async function backfillPlaybackProxies(uploadsDir: string, filenames: string[]): Promise<number> {
  let made = 0;
  for (const rel of filenames) {
    if (!rel || rel.includes('_play')) continue;
    const abs = path.join(uploadsDir, rel);
    try { await fs.promises.access(abs); } catch { continue; }          // purged already
    try { if (await makePlaybackProxy(abs)) made++; } catch { /* best effort */ }
  }
  if (made) console.log(`[video] playback copies ready for ${made} clip(s)`);
  return made;
}

export async function backfillThumbnails(uploadsDir: string): Promise<number> {
  let entries: import('fs').Dirent[];
  try { entries = await fs.promises.readdir(uploadsDir, { withFileTypes: true }); }
  catch { return 0; }
  let made = 0;
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;                          // .incoming / .ss-tmp
    if (ent.isDirectory()) {
      // One level down: an event folder (or the legacy themes/ dir — harmless to scan).
      let sub: string[];
      try { sub = await fs.promises.readdir(path.join(uploadsDir, ent.name)); } catch { continue; }
      for (const n of sub) if (await backfillOne(path.join(uploadsDir, ent.name, n))) made++;
    } else if (await backfillOne(path.join(uploadsDir, ent.name))) {  // legacy flat files
      made++;
    }
  }
  if (made) console.log(`[thumbs] backfilled ${made} thumbnail(s)`);
  return made;
}
