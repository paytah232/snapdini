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
/** A "no more than N of these at once" gate. There are three of them on this box — sharp
 *  operations, guest video work, and slideshow renders (`slideshow.ts`) — and they were three
 *  copies of the same eight lines, which is how the third one came to be missing entirely.
 *
 *  Each release wakes exactly one waiter, and the woken waiter does not re-check the limit: that is
 *  the original behaviour and it is correct, because the slot it was woken for is the one the
 *  releaser just gave up. `stats()` exists so a test can see a queue form. */
export type Slot = {
  <T>(fn: () => Promise<T>): Promise<T>;
  stats(): { active: number; waiting: number };
};
export function makeSlot(limit: number): Slot {
  let active = 0;
  const waiters: Array<() => void> = [];
  const slot = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((r) => waiters.push(r));
    active++;
    try { return await fn(); }
    finally { active--; waiters.shift()?.(); }
  };
  return Object.assign(slot, { stats: () => ({ active, waiting: waiters.length }) });
}

const withImageSlot = makeSlot(MAX_CONCURRENT);

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

/** The same scrub, but to PNG — for the one upload whose TRANSPARENCY is the point.
 *
 *  A poster logo is a cut-out: a monogram, a crest, a wordmark, sitting over whatever background
 *  the host chose. Run it through the JPEG path above and sharp flattens the alpha to black, so the
 *  host gets their mark in a black box and no explanation. This keeps the alpha channel and still
 *  re-encodes, which is what strips the metadata — the security property is the re-encode, not the
 *  format. `.rotate()` for the same reason as above.
 *
 *  Capped at 1200px on the long edge: it is furniture on a poster, not the poster. */
export async function stripImageMetadataPng(filePath: string): Promise<{ width?: number; height?: number }> {
  const { data, info } = await withImageSlot(() => sharp(filePath)
    .rotate()
    .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
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

/** Every file DERIVED from one upload, by name. The original is deliberately NOT in the list:
 *  callers that want it already have it, and keeping it out means no caller can delete the original
 *  while meaning to clear only the copies.
 *
 *  One list because there were two. The delete route and the rotate route must each account for
 *  every sibling, and the failure when they disagree is silent — an orphaned `_dl.mp4` nobody ever
 *  sees, or a gallery still serving a crop cut from the pre-rotation clip. Add a derived file
 *  anywhere in this module and it belongs here on the same day.
 *
 *  Names only. Most will not exist for most rows (a photo has exactly one, an MP4 that needed no
 *  crop has two), and every caller already treats a missing sibling as the normal case. */
export function derivedNames(filename: string): string[] {
  // Every MP4 this pipeline can produce from one upload. `playName(cropName(…))` is the proxy built
  // from the crop rather than from the original — see playFile()'s ladder in routes/photos.ts.
  const clips = [playName(filename), cropName(filename), playName(cropName(filename)), dlName(filename)];
  // A thumbnail for EACH of them, and that is not over-caution. `backfillThumbnails` walks the
  // event folder on every boot and posters anything that is a video and has no sibling `_thumb`,
  // which includes the derived clips — so `<id>_play_thumb.webp` and friends are real files sitting
  // on the volume. The delete route's hand-written list did not know that, and every deleted clip
  // left one behind; it was found when a rotation renamed the base and an orphan stayed put.
  // Nothing READS them (photoRow's thumbUrl is the original's or the crop's), so they are pure
  // litter — but litter that only the code which made it can name.
  return [thumbName(filename), ...clips, ...clips.map(thumbName)];
}

// ── Which uploads still have derived copies coming ───────────────────────────
//
// Every file derivedNames() lists is built AFTER the guest has been answered: the crop, the poster
// cut from it, the playback proxy and the full-resolution `_dl` re-encode are all `void` promises
// queued behind one global video slot, so a 30-second clip can still be growing siblings minutes
// after the upload said "done".
//
// Nothing needed to know that until something wanted to MOVE the base name. POST /:id/rotate
// renames an upload and every copy made from it (routes/photos.ts), and a rename landing in the
// middle of this leaves the still-running job writing `<oldbase>_crop.mp4` under a name no row
// points at — while the base the row now carries has no crop, no download copy, and nothing that
// will ever build them. The guest's chosen shape silently reverts to full frame, for good, and
// not one line of that is an error anybody sees.
//
// So the jobs declare themselves and the mover asks. COUNTED rather than a flag because one upload
// starts two independent chains (audio-lead → proxy, and crop → poster → download copy) and it is
// the last one to finish that decides when the name is safe to move.
//
// Keyed on the resolved path of the ORIGINAL, which is the one name every derived file is computed
// from — so a caller holding any of them can ask about the set by naming the file it came from.
//
// IN-PROCESS, DELIBERATELY. The promises this tracks live in this process and nowhere else, so a
// restart that forgets the register has already killed the work the register described: there is
// nothing to expire and nothing to reconcile on boot. The honest limit of that is that it only
// covers one process — run two app containers against one uploads volume and a rotation arriving
// at the other one would not see this, which is the race exactly as it was. The deployment is a
// single app process (see the compose stack), and a shared marker would need a table, a lease and
// an expiry to answer a question that is only ever asked about work THIS process started.
const deriving = new Map<string, number>();

/** Count `job` as outstanding work against `originalPath` until it settles.
 *
 *  try/finally, so a job that throws or is rejected releases the name too — a failed transcode that
 *  wedged its upload shut for the life of the process would be a worse bug than the race this
 *  closes. */
export async function whileDeriving<T>(originalPath: string, job: () => Promise<T>): Promise<T> {
  const key = path.resolve(originalPath);
  deriving.set(key, (deriving.get(key) ?? 0) + 1);
  try {
    return await job();
  } finally {
    const left = (deriving.get(key) ?? 1) - 1;
    if (left > 0) deriving.set(key, left);
    else deriving.delete(key);
  }
}

/** Is anything still being written under this upload's base name? */
export function isDeriving(originalPath: string): boolean {
  return deriving.has(path.resolve(originalPath));
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
      // Registered with whileDeriving, because this one OUTLIVES the promise the caller is
      // awaiting: cropClipToShape resolves as soon as the lossless crop is in place, and without
      // this the base name would read as finished while the most expensive copy of the lot was
      // still being written into it.
      void whileDeriving(videoPath, () => cropByReencode(videoPath, want,
        { outName: dlName(path.basename(videoPath)), crf: 18, capLongEdge: false }))
        .catch(() => false);
      return true;
    } catch {
      await cleanup();
      return false;
    }
  });
}

/**
 * Below this, a lead is inaudible and "correcting" it would just be chasing measurement noise.
 * One frame at 30fps is 33ms; 150ms is where a voice visibly stops matching a mouth.
 */
export const AUDIO_LEAD_MIN_SECS = 0.15;

/**
 * And above this it is not a wake-up, so it is not ours to correct.
 *
 * The fix rests on one assumption: the whole deficit is time the microphone spent waking up, so
 * sliding the audio back by exactly that much puts it where it was recorded. That holds for a
 * wake-up. It does NOT hold for a clip whose sound failed some other way — a mic interrupted
 * mid-recording, a permission granted late, a track that ended early — and there the assumption is
 * actively destructive: a 15.5s clip arrived carrying 3.9s of audio, and shifting it by the 11.5s
 * "lead" moved the entire soundtrack to the end, turning a clip with sound in the wrong place into
 * one with sound nowhere near its picture.
 *
 * Every genuine wake-up measured across four sessions came in at or under 1.0s — 0.175, 0.415,
 * 0.571, 0.820, 0.853, 0.918, 0.970, 0.997 — against 11.5s for the broken one. 2.0s sits well clear
 * of the real population with room for a slower device, and well below anything that has turned out
 * to be a different fault.
 *
 * Past it the file is left exactly as recorded. Sound at the start that belongs further in is
 * wrong, but it is the muxer's wrongness and it is bounded; moving it somewhere we cannot justify
 * is ours, and it is worse. A capped clip is logged rather than silently skipped.
 */
export const AUDIO_LEAD_MAX_SECS = 2.0;

/**
 * Where each stream actually STOPS, from `codec_type,start_time,duration` rows.
 *
 * It has to be the end and not the duration, because the fix works by moving the audio's start
 * rather than by padding it: a corrected clip still has a 1.53s audio track, it just begins at
 * 0.997 instead of 0. Measured on duration alone that file looks exactly as broken as it did
 * before, so a second pass would shift it again — and a backfill runs over everything, every boot.
 * Ends are the same number before and after, which is what makes correcting twice a no-op.
 *
 * Returns null unless BOTH streams are readable, so a clip with no sound, or one ffprobe could not
 * make sense of, is left alone rather than guessed at.
 */
export function endsFrom(probeOut: string): { v: number; a: number; aStart: number } | null {
  let v: number | null = null, a: number | null = null, aStart = 0;
  for (const line of probeOut.trim().split('\n')) {
    const [kind, start, dur] = line.split(',');
    const s = Number(start), d = Number(dur);
    if (!Number.isFinite(s) || !Number.isFinite(d) || d <= 0) continue;
    if (kind === 'video' && v === null) v = s + d;
    if (kind === 'audio' && a === null) { a = s + d; aStart = s; }
  }
  return v !== null && a !== null ? { v, a, aStart } : null;
}

/**
 * Has this file already had its audio placed?
 *
 * A clip as a browser muxes it starts BOTH tracks at zero — that is the whole fault. So a non-zero
 * audio start means someone has already decided where the sound goes, and the only someone is us.
 *
 * This is the real idempotency guard, and it replaces trusting the arithmetic. The first version
 * reasoned that a corrected file must measure as having no lead left, since shifting by exactly the
 * gap closes it — true on paper, and true for every small offset tested. It did not survive one
 * clip: an 11.5s shift left a residual the next pass read as a fresh 7.7s lead and corrected AGAIN,
 * stacking to 11.542s. Reading a flag that is either set or not cannot drift the way a subtraction
 * across two ffprobe runs can.
 */
export function alreadyPlaced(ends: { aStart: number } | null): boolean {
  return !!ends && ends.aStart >= AUDIO_LEAD_MIN_SECS;
}

/**
 * How far the sound runs AHEAD of the picture, in seconds — 0 when it doesn't, or can't be read.
 *
 * The microphone is the slow one. It can take up to a second to deliver its first sample, and the
 * muxer rebases the audio track to zero regardless of when it actually started — so everything the
 * mic recorded lands that far early, for the whole clip, with nothing in the file to say so. No
 * packets are dropped and there is no gap: audio runs unbroken at a perfect 21.3ms apart from the
 * first to the last. The only trace is the track ending short by exactly the distance it moved.
 *
 * Measured across three sessions the lead clusters at ~1s, which is a wake-up and not drift. It is
 * NOT fixable by handing the camera fresh tracks — that was tried, and made it worse, because a
 * just-acquired stream is precisely one with a cold microphone. See the note in toggleRecord.
 */
export function audioLeadFrom(ends: { v: number; a: number; aStart: number } | null): number {
  if (!ends || alreadyPlaced(ends)) return 0;
  const lead = ends.v - ends.a;
  return lead >= AUDIO_LEAD_MIN_SECS && lead <= AUDIO_LEAD_MAX_SECS ? lead : 0;
}

/** True when there IS a deficit but it is too big to be a wake-up — worth saying out loud. */
export function leadTooBig(ends: { v: number; a: number; aStart: number } | null): boolean {
  return !!ends && !alreadyPlaced(ends) && ends.v - ends.a > AUDIO_LEAD_MAX_SECS;
}

/** `audioLeadFrom` against a real file. Best-effort: anything unreadable reports no lead. */
async function audioLead(videoPath: string): Promise<number> {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,start_time,duration', '-of', 'csv=p=0', videoPath], 15_000);
  if (r.code !== 0) return 0;
  const ends = endsFrom(r.out);
  if (leadTooBig(ends)) {
    console.log(`[video] ${path.basename(videoPath)}: audio is ${(ends!.v - ends!.a).toFixed(1)}s ` +
      'short of its video — too much to be a microphone wake-up, leaving it as recorded');
  }
  return audioLeadFrom(ends);
}

/**
 * Put the sound back on the picture, in the ORIGINAL, without re-encoding it.
 *
 * `-itsoffset` moves the audio's timestamps; `-c copy` means not one sample is decoded. It costs a
 * file copy and takes about as long as writing the upload did, and the result is bit-identical
 * media with a corrected clock — no generation loss on the file the guest keeps.
 *
 * Fixing the ORIGINAL rather than only the playback proxy matters because the original is what
 * downloads: the gallery's save button, the whole-event zip, and the CRF-18 re-encode a shaped
 * event makes all read this file. Correcting only the proxy would leave every one of those out of
 * step — the copy people keep being the broken one. It also means the proxy step then finds nothing
 * wrong and skips a full transcode it would otherwise have been forced into.
 *
 * Safe by construction: the replacement is built beside the original and only moves into place once
 * it has been re-probed and agrees. Anything that fails leaves the original untouched.
 */
export async function fixAudioLead(videoPath: string): Promise<boolean> {
  const lead = await audioLead(videoPath);
  if (!lead) return false;

  const tmp = videoPath + '.sync' + (path.extname(videoPath) || '.mp4');
  const args = ['-v', 'error', '-y', '-i', videoPath, '-itsoffset', lead.toFixed(3), '-i', videoPath,
    '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy'];
  if (/\.(mp4|m4v|mov)$/i.test(videoPath)) args.push('-movflags', '+faststart');
  args.push(tmp);

  const done = await run('ffmpeg', args, 120_000);
  const scrap = async () => { try { await fs.promises.unlink(tmp); } catch { /* */ } };
  if (done.code !== 0) { await scrap(); return false; }

  // Re-probe before trusting it. `-map 1:a:0` on a file ffprobe misread could land a clip with no
  // sound at all, and audioLead reports 0 for that as readily as it does for a clip already in
  // step — so the check is that both streams are THERE and now agree, never just that the lead
  // came back 0.
  const r = await run('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,start_time,duration', '-of', 'csv=p=0', tmp], 15_000);
  const ends = r.code === 0 ? endsFrom(r.out) : null;
  // Both streams there, the sound now landing with the picture, AND the offset we asked for actually
  // applied. That last one is not paranoia: the clip that had to be repaired by hand got its shift
  // only partly written, and the leftover read as a fresh fault on the next pass.
  if (!ends || Math.abs(ends.v - ends.a) >= AUDIO_LEAD_MIN_SECS ||
      Math.abs(ends.aStart - lead) > 0.05) { await scrap(); return false; }

  try { await fs.promises.rename(tmp, videoPath); }   // same directory, so atomic
  catch { await scrap(); return false; }
  console.log(`[video] audio was ${lead.toFixed(3)}s ahead — corrected ${path.basename(videoPath)}`);
  return true;
}

/** `<id>.webm` → `<id>_play.mp4`. The playback copy sits beside the original. */
export function playName(filename: string): string {
  return filename.replace(/\.[^.]+$/, '') + '_play.mp4';
}

// One transcode at a time. ffmpeg will happily eat every core, and a guest uploading during a
// live event matters more than a proxy finishing quickly.
//
// This slot belongs to GUEST media — crops and playback proxies, the things somebody standing at a
// party is waiting on. Slideshow renders are gated separately (`slideshow.ts`) for exactly that
// reason; see the note there for why they are not put in here.
const withVideoSlot = makeSlot(1);

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


  const probe = await new Promise<{ codec: string; height: number; vfr: boolean } | null>((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,height,r_frame_rate,avg_frame_rate', '-of', 'csv=p=0', videoPath]);
    let outBuf = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } resolve(null); }, 15_000);
    p.stdout.on('data', (d) => { outBuf += String(d); });
    p.stderr.on('data', () => { /* drain */ });
    p.on('error', () => { clearTimeout(t); resolve(null); });
    p.on('close', () => {
      clearTimeout(t);
      const [codec, h, rRate, avgRate] = outBuf.trim().split(',');
      // Rates arrive as "30000/1" style fractions. A file whose declared rate is more than a hair
      // off its average is variable — and the 30000/1 case is not a hair, it is three orders of
      // magnitude.
      const asFps = (x?: string) => {
        const [n, d] = String(x ?? '').split('/').map(Number);
        return d ? n / d : Number.isFinite(n) ? n : 0;
      };
      const r = asFps(rRate), a = asFps(avgRate);
      const vfr = r > 0 && a > 0 && Math.abs(r - a) / a > 0.02;
      resolve(codec ? { codec, height: Number(h) || 0, vfr } : null);
    });
  });
  // Already the thing we would transcode to: leave it alone rather than re-encode and lose quality.
  // EXCEPT when it is variable frame rate — a browser-recorded clip is H.264 in an MP4 and still
  // needs the pass below, because what is wrong with it is its timestamps, not its codec. `vfr`
  // here means "the declared rate and the real one disagree", which is the signature of a
  // MediaRecorder file: one off a phone declared `r_frame_rate=30000/1` — thirty thousand frames a
  // second — against an actual ~29.98.
  //
  // THIS IS NOT WHY SOUND GOES OUT OF STEP. It used to say so here, and that was wrong: the sound
  // fault is the microphone waking up after the camera, and it is corrected in the ORIGINAL at
  // ingest (fixAudioLead). The two are independent — clips arrive VFR and in sync, and in sync and
  // CFR, in the same session on the same phone. What is left for the rate itself is that some
  // players seek badly or misreport duration on a container claiming 30000fps, which is a thinner
  // reason for a full re-encode than the one written here before. Worth revisiting; measure first.
  // Sound running ahead of the picture is a reason to build a proxy all on its own — the clip can
  // be H.264 at a sane size and perfectly constant rate and still be unwatchable.
  const lead = await audioLead(videoPath);

  if (probe && !probe.vfr && !lead && /^(h264|avc1)$/i.test(probe.codec) && probe.height > 0 && probe.height <= 1920 &&
      /\.(mp4|m4v)$/i.test(videoPath)) return true;
  if (!probe) return false;

  return withVideoSlot(() => new Promise<boolean>((resolve) => {
    const tmp = out + '.tmp.mp4';
    // scale=-2 keeps the aspect and forces an even width, which H.264 requires. The cap is on the
    // LONG edge so portrait clips (the common case) come out 1080 wide, not 1080 tall.
    // `-fps_mode cfr -r 30` and `-af aresample=async=1` are what keep the SOUND on the pictures.
    //
    // A clip recorded in a browser is variable frame rate and it lies about it, so `-fps_mode cfr
    // -r 30` gives players a rate they can actually follow instead of the declared 30000/1.
    //
    // The audio filters are the SECOND line of defence, not the first. `aresample=async=1` holds
    // the audio against the video's timeline as it re-encodes, and `adelay` moves it back by any
    // lead still present. Normally there is none: the original is corrected at ingest, so by the
    // time a proxy is built the sound is already where it belongs and `lead` is 0. These exist for
    // the clip that slips past — a lead that appears only after the container is rewritten, or an
    // original that could not be replaced.
    //
    // `aresample` alone is not enough and never was. Its job is to correct DRIFT, and audio dragged
    // to the front of a file is not drifting — it sits at pts 0, exactly where `first_pts=0` wants
    // it, and passes through untouched. Measured on two real clips, the proxy faithfully reproduced
    // the fault it was supposed to be fixing (0.415s in, 0.400s out; 0.997s in, 1.027s out). That
    // is what `adelay` is for. See `audioLeadFrom` for why the gap IS the offset.
    const p = spawn('ffmpeg', ['-v', 'error', '-y', '-i', videoPath,
      '-vf', "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'",
      '-fps_mode', 'cfr', '-r', '30',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-af', lead ? `aresample=async=1:first_pts=0,adelay=${Math.round(lead * 1000)}:all=1`
                  : 'aresample=async=1:first_pts=0',
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

// ── Turning a shot the right way up ──────────────────────────────────────────
//
// The shot this exists for has NO EXIF at all: the camera page draws to a canvas and posts the
// pixels, and ingest re-encodes whatever is left out of the file (stripImageMetadata). So there is
// no orientation tag to correct and nothing a viewer could honour — the scene is simply lying on
// its side in the pixels, and putting it upright means moving the pixels.
//
// Which direction is 'up' is NOT derivable. capture_orientation (0042) records only that the phone
// was held sideways, never which way; the answer lives with the person who took the photo. So both
// functions here take a signed quarter from a human and do exactly that, once.
//
// ONE CONVENTION, END TO END: positive is CLOCKWISE, as the guest sees the picture. sharp's
// `.rotate(n)` is already clockwise-positive, so the still path needs no translation. ffmpeg's
// `-display_rotation` is the opposite sign (it documents itself as counter-clockwise), which is
// the single place a sign flips — and it flips in `rotateClipTo` and nowhere else. Both were
// checked against real files rather than read off the documentation: a frame with red on the LEFT
// comes back with red on TOP through either path.

/** Fold any number of degrees into the (-180, 180] window the column stores.
 *
 *  Shared with the route that accumulates the total, so "90 then 90 is 180" and "180 then 180 is
 *  0" are decided in one place. The window matters: 270 and -90 are the same turn, and storing
 *  both spellings would make every later comparison ("has this been corrected?") answer twice. */
export function normalizeTurn(deg: number): number {
  const wrapped = ((Math.round(deg) % 360) + 360) % 360;   // [0, 360)
  return wrapped > 180 ? wrapped - 360 : wrapped;          // (-180, 180]
}

/** Turn a stored still and write the result to `destPath`.
 *
 *  A NEW FILE, never in place. /uploads is served `immutable, max-age=365d` (index.ts) on the
 *  promise that a uuid filename addresses one set of bytes for ever, so rewriting a file under its
 *  own name changes nothing for anybody whose browser, or Cloudflare, already has it. The caller
 *  renames the row; this function only ever writes somewhere new.
 *
 *  Encoded exactly as ingest encodes an upload — same IMAGE_QUALITY, same chroma decision — so a
 *  corrected photo is not quietly a different quality from its neighbours, and inside the same slot
 *  so a host working through an album cannot outrun the uploads it shares a box with.
 *
 *  No bare `.rotate()` first. That one auto-orients from EXIF, and the stored original has had
 *  every scrap of metadata re-encoded out of it at ingest — there is nothing left to honour, and
 *  calling both would be two rotations where the guest asked for one. */
export async function rotateImageTo(srcPath: string, destPath: string, clockwise: number): Promise<{ width?: number; height?: number }> {
  const hi = IMAGE_QUALITY >= 90;
  const { data, info } = await withImageSlot(() => sharp(srcPath)
    .rotate(clockwise)
    .jpeg({ quality: IMAGE_QUALITY, chromaSubsampling: hi ? '4:4:4' : '4:2:0', mozjpeg: !hi })
    .toBuffer({ resolveWithObject: true }));
  await fs.promises.writeFile(destPath, data);
  return { width: info.width, height: info.height };
}

/** Turn a clip WITHOUT decoding a single frame, writing the result to `destPath`.
 *
 *  A video carries a display matrix, so "rotate" is a header value and `-c copy` is all it takes —
 *  the same trick, and the same reasoning, as the audio-sync fix above: the file a guest downloads
 *  must not lose a generation of quality to a correction. A re-encode would cost minutes of CPU in
 *  the one video slot and give a visibly worse clip back.
 *
 *  THE SIGN. `-display_rotation` is documented as degrees COUNTER-clockwise, and ffprobe reports
 *  the matrix in the same convention — measured here: `-display_rotation -90` on a clip with red on
 *  the left produced a clip that plays with red on top, i.e. a quarter turn clockwise, and probes
 *  back as `rotation=-90`. So the existing value minus our clockwise quarter is the new one.
 *
 *  IT REPLACES, IT DOES NOT ADD. Also measured: applying `-display_rotation -90` twice leaves the
 *  matrix at -90, not -180. That is why the source is probed first and the TOTAL is written, rather
 *  than the delta — a clip already carrying a phone's own rotation (iOS writes -90 routinely) would
 *  otherwise have it silently discarded, and the correction would look like it made things worse.
 *
 *  VERIFIED, NOT ASSUMED, in the house style of every other ffmpeg path in this file: WebM has no
 *  equivalent header in every muxer, and a container that quietly drops the matrix would leave a
 *  file that looks written and plays exactly as wrong as before. False means "nothing was
 *  published", and the caller must keep the original.
 */
export async function rotateClipTo(srcPath: string, destPath: string, clockwise: number): Promise<boolean> {
  const info = await probeClip(srcPath);
  if (!info) return false;
  const want = normalizeTurn(info.rotation - clockwise);
  const tmp = destPath + '.rot' + (path.extname(destPath) || '.mp4');
  const args = ['-v', 'error', '-y', '-display_rotation', String(want), '-i', srcPath, '-c', 'copy'];
  if (/\.(mp4|m4v|mov)$/i.test(destPath)) args.push('-movflags', '+faststart');
  args.push(tmp);

  return withVideoSlot(async () => {
    const scrap = async () => { try { await fs.promises.unlink(tmp); } catch { /* */ } };
    const done = await run('ffmpeg', args, 120_000);
    if (done.code !== 0) { await scrap(); return false; }
    // probeClip normalises into [0, 360); `want` is in (-180, 180]. Compare in one window or 270
    // and -90 read as a mismatch and every successful rotation is thrown away.
    const after = await probeClip(tmp);
    if (!after || normalizeTurn(after.rotation) !== want) {
      console.warn(`[rotate] ${path.basename(srcPath)}: container kept rotation=${after ? after.rotation : '?'} `
        + `when ${want} was asked for — leaving the clip as it was`);
      await scrap();
      return false;
    }
    try { await fs.promises.rename(tmp, destPath); return true; }
    catch { await scrap(); return false; }
  });
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
    // Correct the original BEFORE the proxy looks at it: a proxy built from a shifted file
    // faithfully reproduces the shift, and the download would stay wrong either way.
    try { await fixAudioLead(abs); } catch { /* best effort */ }
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
