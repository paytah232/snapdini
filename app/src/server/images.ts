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

// ── Cropping a clip to the shape the guest asked for ─────────────────────────
//
// Photos are cropped in the browser at the shutter and always arrive correct. Clips are cropped by
// asking the CAMERA (applyConstraints({aspectRatio})), which Chrome on Android honours, and which
// iOS Safari and Firefox on Android quietly ignore — so those guests choose Square and get a
// full-frame clip. This finishes the job server-side.
//
// It is LOSSLESS. H.264 carries a cropping rectangle in the SPS, so changing the visible window is
// a header rewrite: no frames are re-encoded, the audio is byte-identical, and it runs in ~135ms
// rather than the seconds a re-encode costs. Four things have to be right, and each of them was
// found by getting it wrong first:
//
//  1. ROTATION. A phone writes a display matrix — iOS typically rotation=-90 — so a clip CODED
//     1920x1080 landscape DISPLAYS as 1080x1920 portrait. Crop in coded space and you trim the
//     wrong axis. The rotation is read from side data (this ffmpeg never writes the old TAG:rotate)
//     and normalised, because 270 and -90 are the same thing reported differently.
//
//  2. THE CROP ALREADY THERE. h264_metadata's values REPLACE, they do not add. 1080 is not a
//     multiple of 16, so the encoder codes 1088 rows and hides 8 of them with an existing SPS crop.
//     Passing crop_bottom=0 does not mean "no crop" — it means "show me the padding", and 8 rows of
//     encoder garbage appear. The existing rectangle has to be read and added to ours.
//
//  3. EVEN NUMBERS. 4:2:0 chroma means offsets are in 2-pixel units; ffmpeg hard-errors on an odd
//     value rather than rounding. Centred means left==right, so each axis's TOTAL trim must be a
//     multiple of 4.
//
//  4. THE CONTAINER. After the header rewrite the SPS says 1080x1080 while the MP4 track header
//     still says 1920x1080, because the muxer copied it from the pre-filter stream. A second plain
//     remux fixes it. Players that size from the container rather than the bitstream need this.
//
// AND IT IS VERIFIED, NOT ASSUMED. A crop that consumes a whole axis is written with no error at
// all, yet no decoder will touch the result — and ffprobe then reports the ORIGINAL dimensions, so
// a file that does not decode looks untouched. Every crop is probed afterwards and thrown away
// unless the displayed size is exactly what was asked for.
//
// WHAT IT DOES NOT DO: remove the cropped-away pixels. They are still in the file, outside the
// display window, recoverable by anyone who resets the SPS offsets. That is fine here — this crop
// applies the guest's own framing choice, and the untouched original is kept beside it deliberately
// — but it would NOT be fine as a way to take somebody out of a picture. That needs a re-encode.

/** Crop by actually re-encoding — the only way to REMOVE the pixels outside the window.
 *
 *  Used for two different jobs:
 *   - a WebM source (Firefox), which has no cropping rectangle to rewrite and is being re-encoded
 *     to H.264 anyway because most phones cannot play WebM. Scaled to the playback cap.
 *   - the download copy of an H.264 clip, where the lossless crop only HIDES the surplus. Kept at
 *     full resolution and a better quality setting, because it is the file someone keeps.
 *
 *  `crop` runs AFTER ffmpeg's auto-rotation, so its arguments are display dimensions and none of
 *  the display-matrix arithmetic the lossless path needs applies here. min() guards a source
 *  already narrower than the target, which would otherwise ask for a window bigger than the frame.
 */
async function cropByReencode(videoPath: string, want: { w: number; h: number },
                              opts: { outName: string; crf: number; capLongEdge: boolean }): Promise<boolean> {
  const out = path.join(path.dirname(videoPath), opts.outName);
  const tmp = out + '.tmp.mp4';
  const cropVf = `crop='min(iw,ih*${want.w}/${want.h})':'min(ih,iw*${want.h}/${want.w})'`;
  const vf = opts.capLongEdge
    ? cropVf + ",scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'"
    // Even dimensions are still required by H.264 even when we are not capping the size.
    : cropVf + ',scale=trunc(iw/2)*2:trunc(ih/2)*2';
  return withVideoSlot(() => new Promise<boolean>((resolve) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-y', '-i', videoPath,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(opts.crf), '-profile:v', 'high',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '128k', tmp]);
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } }, 10 * 60_000);
    p.stderr.on('data', () => { /* drain */ });
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', async (code) => {
      clearTimeout(t);
      const bin = async () => { try { await fs.promises.unlink(tmp); } catch { /* */ } };
      if (code !== 0) { await bin(); return resolve(false); }
      // Checked, like the lossless path — for a different reason, but with the same rule: nothing
      // is published under a name the rest of the app trusts until it has been read back and found
      // to be the shape it claims. A file that is merely PRESENT is not evidence of anything.
      const after = await probeClip(tmp);
      if (!after) { await bin(); return resolve(false); }
      const aSwap = after.rotation % 180 !== 0;
      const adw = aSwap ? after.h : after.w, adh = aSwap ? after.w : after.h;
      // Within a pixel or two: even dimensions are forced, so an odd target cannot land exactly.
      if (Math.abs(adw * want.h - adh * want.w) > Math.max(adw, adh) * 0.02) {
        console.warn(`[crop] re-encode refused ${opts.outName}: ${adw}x${adh} is not ${want.w}:${want.h}`);
        await bin();
        return resolve(false);
      }
      try { await fs.promises.rename(tmp, out); resolve(true); } catch { resolve(false); }
    });
  }));
}

/** `<id>.mp4` → `<id>_crop.mp4`. Sits beside the original, which is never modified. */
export function cropName(filename: string): string {
  return filename.replace(/\.[^.]+$/, '') + '_crop.mp4';
}

/** `<id>.mp4` → `<id>_dl.mp4`: the crop with the surplus genuinely GONE, for downloading.
 *
 *  The lossless crop hides the pixels outside the window; it cannot remove them, because removing
 *  them means re-encoding every frame. That is fine for a clip being watched in our gallery and not
 *  fine for a file somebody saves and forwards, where "cropped" ought to mean cropped. So the
 *  download gets its own copy, re-encoded from the original at full resolution.
 *
 *  Only H.264 sources need one. A WebM was re-encoded to make its crop in the first place, so its
 *  `_crop.mp4` is already a true crop with nothing hidden in it. */
export function dlName(filename: string): string {
  return filename.replace(/\.[^.]+$/, '') + '_dl.mp4';
}

/** Parse "4:5" into a ratio. Null for 'full', blank, or anything unrecognised — all of which mean
 *  "leave it alone". */
export function shapeRatio(shape: string | null | undefined): { w: number; h: number } | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec((shape || '').trim());
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  return w > 0 && h > 0 ? { w, h } : null;
}

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let out = '';
    p.stdout.on('data', (d) => { out += String(d); });
    p.stderr.on('data', () => { /* drain */ });
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
    p.on('error', () => { clearTimeout(t); resolve({ code: -1, out: '' }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, out }); });
  });
}

interface ClipShape { w: number; h: number; rotation: number; codec: string; }

/** Coded size, codec and normalised rotation. */
async function probeClip(file: string): Promise<ClipShape | null> {
  const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name:stream_side_data=rotation',
    '-of', 'default=noprint_wrappers=1', file], 30_000);
  if (r.code !== 0) return null;
  const get = (k: string) => new RegExp(`^${k}=(.+)$`, 'm').exec(r.out)?.[1]?.trim();
  const w = Number(get('width')), h = Number(get('height'));
  const codec = get('codec_name') || '';
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  // 270 and -90 are the same rotation reported two ways; normalise into [0,360).
  const raw = Number(get('rotation') ?? 0);
  const rotation = Number.isFinite(raw) ? ((Math.round(raw) % 360) + 360) % 360 : 0;
  return { w, h, rotation, codec };
}

/** Which coded edge each DISPLAYED edge became, once the display matrix is applied. Centred crops
 *  make left==right and top==bottom, so for those the 90-vs-270 rows are interchangeable — but the
 *  full table is here because getting it "right" on centred tests alone hides a real error, which
 *  is exactly how it was got wrong the first time. */
function codedEdges(d: { l: number; r: number; t: number; b: number }, rotation: number) {
  switch (rotation) {
    case 90:  return { left: d.b, right: d.t, top: d.l, bottom: d.r };
    case 180: return { left: d.r, right: d.l, top: d.b, bottom: d.t };
    case 270: return { left: d.t, right: d.b, top: d.r, bottom: d.l };
    default:  return { left: d.l, right: d.r, top: d.t, bottom: d.b };
  }
}

const align16 = (n: number) => Math.ceil(n / 16) * 16;

/** Crop a clip to `shape` losslessly, writing `<id>_crop.mp4` beside it. The original is untouched.
 *
 *  Returns true only when a verified cropped file now exists. False means "serve the original",
 *  which is always a correct outcome — a clip in the wrong shape is a far smaller problem than a
 *  clip that does not play. */
export async function cropClipToShape(videoPath: string, shape: string | null | undefined): Promise<boolean> {
  const want = shapeRatio(shape);
  if (!want) return false;

  const info = await probeClip(videoPath);
  if (!info) return false;

  // VP8/VP9 (Firefox's MediaRecorder) has no equivalent header trick — there is no cropping
  // rectangle to rewrite. But those clips are ALREADY re-encoded to H.264, because most phones
  // cannot play WebM at all, so the crop rides along in a pass that was going to happen regardless
  // and costs no extra generation of loss. Same output name as the lossless path, so nothing
  // downstream has to know or care which codec arrived.
  if (info.codec !== 'h264') {
    return cropByReencode(videoPath, want,
      { outName: cropName(path.basename(videoPath)), crf: 23, capLongEdge: true });
  }

  const swap = info.rotation % 180 !== 0;
  const dw = swap ? info.h : info.w;
  const dh = swap ? info.w : info.h;

  // The largest centred window of the wanted ratio that fits the displayed frame.
  let nw: number, nh: number;
  if (dw * want.h > dh * want.w) { nh = dh; nw = Math.round((dh * want.w) / want.h); }
  else                           { nw = dw; nh = Math.round((dw * want.h) / want.w); }
  let tx = dw - Math.min(nw, dw);
  let ty = dh - Math.min(nh, dh);
  // Each side must be even, and the sides are equal, so the total must be a multiple of 4. Rounding
  // DOWN keeps a hair more picture and can leave the result up to 2px off the exact ratio, which is
  // invisible and preferable to an off-centre frame.
  tx -= tx % 4;
  ty -= ty % 4;
  if (tx === 0 && ty === 0) return false;             // already the right shape — nothing to do
  if (tx >= dw || ty >= dh) return false;             // would consume an axis; see the header note

  const mapped = codedEdges({ l: tx / 2, r: tx / 2, t: ty / 2, b: ty / 2 }, info.rotation);
  // The rectangle the encoder already hid: H.264 codes in 16px macroblocks and crops the surplus
  // off the right and bottom. These values REPLACE rather than add, so ours must include it.
  const exRight = align16(info.w) - info.w;
  const exBottom = align16(info.h) - info.h;

  const expectW = dw - tx, expectH = dh - ty;
  const dir = path.dirname(videoPath);
  const out = path.join(dir, cropName(path.basename(videoPath)));
  const raw = out + '.raw.mp4';
  const tmp = out + '.tmp.mp4';
  const cleanup = async () => {
    for (const f of [raw, tmp]) { try { await fs.promises.unlink(f); } catch { /* */ } }
  };

  return withVideoSlot(async () => {
    try {
      const bsf = `h264_metadata=crop_left=${mapped.left}:crop_right=${mapped.right + exRight}`
                + `:crop_top=${mapped.top}:crop_bottom=${mapped.bottom + exBottom}`;
      const a = await run('ffmpeg', ['-v', 'error', '-y', '-i', videoPath,
        '-map', '0', '-c', 'copy', '-bsf:v', bsf, raw]);
      if (a.code !== 0) { await cleanup(); return false; }

      // Second pass: the track header still carries the ORIGINAL size, because the muxer read it
      // before the filter ran. A plain remux rewrites it from the corrected bitstream.
      const b = await run('ffmpeg', ['-v', 'error', '-y', '-i', raw,
        '-map', '0', '-c', 'copy', '-movflags', '+faststart', tmp]);
      if (b.code !== 0) { await cleanup(); return false; }

      // Verify, because the one catastrophic failure writes cleanly and reports the file untouched.
      const after = await probeClip(tmp);
      if (!after) { await cleanup(); return false; }
      const aSwap = after.rotation % 180 !== 0;
      const adw = aSwap ? after.h : after.w;
      const adh = aSwap ? after.w : after.h;
      if (adw !== expectW || adh !== expectH) {
        console.warn(`[crop] refused ${path.basename(videoPath)}: wanted ${expectW}x${expectH}, got ${adw}x${adh}`);
        await cleanup();
        return false;
      }

      await fs.promises.rename(tmp, out);
      try { await fs.promises.unlink(raw); } catch { /* */ }
      // And now the honest one, for downloading. Not awaited: the gallery is already correct by
      // this point, and this is the expensive pass. Until it lands, a download gets the lossless
      // crop — right shape, surplus hidden rather than gone — which is the same thing the gallery
      // is showing and never a wrong-looking file.
      void cropByReencode(videoPath, want,
        { outName: dlName(path.basename(videoPath)), crf: 18, capLongEdge: false })
        .catch(() => false);
      return true;
    } catch {
      await cleanup();
      return false;
    }
  });
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
