import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
// sharp 0.35 dropped the `sharp.*` TYPE namespace (its declarations are now flat named
// exports), so the instance type comes in by name. The default export is unchanged, so
// runtime uses like sharp.strategy.attention below still read the same.
import sharp, { type Sharp } from 'sharp';

const NCPU = Math.max(2, os.cpus().length);   // use the box's cores for filtering + encoding
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { all, db } from './db';
import { slideshows } from './schema';
import { makePlaybackProxy, playName, makeSlot } from './images';
import { UPLOADS_DIR, uploadDiskPath, eventDir, eventRelPath } from './paths';
import { brandingRemovable as billingBrandingRemovable, BRANDING_REMOVAL_CENTS, billingEnabled as BILLING_ON } from './billing';

const CARD_SECS = 3;   // how long the intro / outro branding cards show
const xml = (s: string) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
const clip = (s: string, n: number) => { s = (s || '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// Render a branding card (intro/outro) at W×H via sharp. Coordinates are authored in 1080p space
// and scaled by k = H/1080. Optionally lays the text over the event image (darkened), tints the
// 🎩 brand chip with the event's accent colour, and adds a footer line (e.g. copyright).
async function renderCard(
  W: number, H: number,
  lines: { text: string; size: number; color: string; weight?: number; dy: number }[],
  outPath: string,
  opts: { bgImage?: string; accent?: string; footer?: string; bg?: string } = {},
): Promise<void> {
  const k = H / 1080, s = (n: number) => Math.round(n * k);
  const BRAND = '#f5c518';   // the Snapdini logo is ALWAYS the brand gold — never the event accent.
  const hasBg = !!(opts.bgImage && fs.existsSync(opts.bgImage));
  const text = (x: number, y: number, str: string, size: number, color: string, weight = 600) =>
    `<text x="${s(x)}" y="${s(y)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${s(size)}" font-weight="${weight}" fill="${color}">${xml(str)}</text>`;
  const rows = lines.map((l) => text(960, l.dy, l.text, l.size, l.color, l.weight ?? 600)).join('');
  // 🎩 brand chip: a little top-hat drawn in SVG (emoji won't rasterise) + the Snapdini wordmark.
  const cx = 960, chipY = 86, hatX = cx - 132;
  const chip = `
    <rect x="${s(cx - 150)}" y="${s(chipY)}" width="${s(300)}" height="${s(64)}" rx="${s(14)}" fill="${BRAND}"/>
    <rect x="${s(hatX)}" y="${s(chipY + 16)}" width="${s(22)}" height="${s(22)}" fill="#111"/>
    <rect x="${s(hatX - 7)}" y="${s(chipY + 38)}" width="${s(36)}" height="${s(7)}" rx="${s(3)}" fill="#111"/>
    <text x="${s(cx + 18)}" y="${s(chipY + 44)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${s(38)}" font-weight="800" fill="#111">Snapdini</text>`;
  const footer = opts.footer ? text(960, 1030, opts.footer, 26, 'rgba(255,255,255,0.8)', 500) : '';
  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="${hasBg ? 'rgba(0,0,0,0.6)' : (opts.bg || '#0f0f0f')}"/>
    ${chip}${rows}${footer}
  </svg>`;
  let pipeline: Sharp;
  if (hasBg) {
    // Smart crop: focus on the most salient region (faces/subjects) instead of a centre crop, so
    // people aren't sliced off the edges of the intro card's event image.
    const base = await sharp(opts.bgImage!).rotate().resize(W, H, { fit: 'cover', position: sharp.strategy.attention }).toBuffer();
    pipeline = sharp(base).composite([{ input: Buffer.from(overlay) }]);
  } else {
    pipeline = sharp(Buffer.from(overlay));
  }
  await fs.promises.writeFile(outPath, await pipeline.png().toBuffer());
}

// Bundled royalty-free tracks (CC-BY — see assets/music/MANIFEST.md; attribution shown in UI).
export const MUSIC_DIR = process.env.MUSIC_DIR || '/app/assets/music';
const MAX_QUEUE = 3;            // how many renders may wait behind the running one, per event
const D_DEFAULT = 3;            // default seconds per photo
const T = 0.6;                  // crossfade seconds
const CLIP_MAX = 6;             // cap each video clip's length (s) so one clip can't dominate
const FPS = 30;
// Output resolution. Default 4K so high-res photos keep their detail (stills are "fit inside" with
// no upscaling, so smaller photos aren't blown up — 4K just stops capping good ones at 1080p).
const RES: Record<string, { w: number; h: number; sizeScale: number }> = {
  '4k':    { w: 3840, h: 2160, sizeScale: 3 },   // sizeScale ≈ how much bigger the file is vs 1080p
  '1080p': { w: 1920, h: 1080, sizeScale: 1 },
};
const resOf = (r?: string) => RES[r || '4k'] || RES['4k'];
const resKey = (r?: string) => (r === '1080p' ? '1080p' : '4k');

// Wall-clock seconds of ENCODING per second of finished video, and seconds of sharp pre-scaling per
// item. MEASURED in this container 2026-09-14 on 12–32 real photos per run, libx264 -preset veryfast
// -crf 20: 4K ran 0.89× real time and 0.19 s/item to pre-scale; 1080p ran 0.27× and 0.07 s/item.
// Seeded a little above the measurement to cover the per-chunk ffmpeg startup, then corrected by
// every render that completes, because a different box is a different number.
const RENDER_RATE: Record<string, number> = { '4k': 1.0, '1080p': 0.35 };
const PREP_SECS: Record<string, number> = { '4k': 0.19, '1080p': 0.07 };
function noteRenderRate(resolution: string | undefined, outputSeconds: number, wallMs: number): void {
  if (outputSeconds <= 0 || wallMs <= 0) return;
  const key = resKey(resolution);
  // Smoothed, so one freak render — a box that was already busy, a pile of video clips — doesn't
  // throw every later estimate out.
  RENDER_RATE[key] = RENDER_RATE[key] * 0.7 + (wallMs / 1000 / outputSeconds) * 0.3;
}

// How long ONE encode is allowed to take. The flat five minutes this replaced was survivable while
// a render was capped at 60 items and fatal the moment it wasn't: the big renders — the ones the
// host most wanted — would have been the only ones that reliably died.
//
// The budget scales with the work, and the work is the length of the film that comes out: seconds
// per photo × the photos, plus each clip's own real duration (clips cost more, being decoded and
// re-encoded rather than held). × 4 headroom over what we expect, because this exists to catch a
// process that is stuck, not to put a ceiling on a job that is merely long.
const ENCODE_HEADROOM = 4;
const ENCODE_BUDGET_FLOOR_MS = 5 * 60_000;
export function encodeTimeoutMs(outputSeconds: number, resolution?: string): number {
  return Math.max(ENCODE_BUDGET_FLOOR_MS, Math.round(outputSeconds * RENDER_RATE[resKey(resolution)] * ENCODE_HEADROOM * 1000));
}
// The guard that actually catches a wedged ffmpeg. `-progress` reports the encoded position
// continuously, so silence this long means stuck whatever the budget above still allows.
const ENCODE_STALL_MS = 10 * 60_000;

// How much film one ffmpeg run may produce. MEASURED here: a 4K run costs ~3.3 GB before it writes
// a frame and then climbs ~86 MB for every second of film it makes — 32 photos in one graph reached
// 9.9 GB. What bounds peak memory is therefore how much film a RUN produces, not how many photos
// the host uploaded, which is why both a frame budget and an item budget are enforced.
const CHUNK_LIMITS: Record<string, { items: number; secs: number }> = {
  '4k':    { items: 12, secs: 20 },   // ≈ 3.3 GB + 20×86 MB ≈ 5 GB, at any film length
  '1080p': { items: 24, secs: 60 },   // ≈ 1.0 GB + 60×21 MB ≈ 2.3 GB
};
const chunkLimitsFor = (W: number) => (W <= RES['1080p'].w ? CHUNK_LIMITS['1080p'] : CHUNK_LIMITS['4k']);

// ── The timeline, counted in FRAMES ───────────────────────────────────────────
//
// Everything below is integer frames, never fractional seconds. A 0.6s fade rounded to a frame
// boundary one way on one side of a chunk join and the other way on the other side is a dropped or
// doubled frame — a stutter that shows up only at some item counts, which is the worst kind.
export type Timeline = {
  frames: number[];      // how long item i is on screen
  fade: number[];        // junction j (item j → j+1) blends for this many frames
  offset: number[];      // frame at which item i's own footage begins, in the finished film
  totalFrames: number;
};
/** Lay the items out on one frame-accurate timeline.
 *
 *  The fade length is per-junction rather than one global T, because an item has to carry BOTH its
 *  fades and still hold at least one frame of its own in between — and a 1s video clip cannot give
 *  0.6s to each side. Shortening that one junction is invisible; the alternatives are padding the
 *  clip with a frozen frame or letting two fades overlap into a corrupt graph. The floor((f-1)/2)
 *  on each side is what guarantees the hold, and the hold is what gives a chunk boundary somewhere
 *  safe to land. */
export function buildTimeline(durations: readonly number[], fps: number, fadeSecs: number): Timeline {
  const frames = durations.map((d) => Math.max(3, Math.round(d * fps)));
  const want = Math.max(1, Math.round(fadeSecs * fps));
  const fade: number[] = [];
  for (let i = 0; i + 1 < frames.length; i++) {
    fade.push(Math.max(1, Math.min(want, Math.floor((frames[i] - 1) / 2), Math.floor((frames[i + 1] - 1) / 2))));
  }
  const offset = [0];
  for (let i = 1; i < frames.length; i++) offset[i] = offset[i - 1] + frames[i - 1] - fade[i - 1];
  const totalFrames = frames.length ? offset[frames.length - 1] + frames[frames.length - 1] : 0;
  return { frames, fade, offset, totalFrames };
}

export type Chunk = { from: number; to: number; startFrame: number; endFrame: number };
/** Split the timeline into runs, without ever splitting a crossfade.
 *
 *  Consecutive chunks SHARE their boundary item: chunk k ends on item b and chunk k+1 begins on it.
 *  Each chunk emits the window running from just after its first item's incoming fade to just after
 *  its last item's incoming fade — so every join lands on a frame where the picture is one photo at
 *  full strength, with identical content either side, and every fade sits wholly inside one run.
 *  startFrame/endFrame are in the CHUNK's own local timeline (its first item starts at frame 0).
 *  A chunk always holds at least one whole junction, so a budget smaller than a two-item span
 *  cannot be met — with the real limits (20s at 4K) against the longest an item may be shown (8s)
 *  that never binds, but it is why the budget is a target rather than a guarantee. */
export function planChunks(tl: Timeline, maxItems: number, maxFrames: number): Chunk[] {
  const n = tl.frames.length;
  if (n === 0) return [];
  if (n === 1) return [{ from: 0, to: 0, startFrame: 0, endFrame: tl.frames[0] }];
  const startOf = (a: number) => (a === 0 ? 0 : tl.fade[a - 1]);
  const endOf = (a: number, b: number) =>
    tl.offset[b] - tl.offset[a] + (b === n - 1 ? tl.frames[b] : tl.fade[b - 1]);
  const chunks: Chunk[] = [];
  let a = 0;
  while (a < n - 1) {
    let b = a + 1;
    // Grow while the run stays inside BOTH budgets; always at least two items, so a chunk can never
    // be empty and the walk always advances.
    while (b < n - 1 && (b + 2 - a) <= maxItems && endOf(a, b + 1) - startOf(a) <= maxFrames) b++;
    chunks.push({ from: a, to: b, startFrame: startOf(a), endFrame: endOf(a, b) });
    a = b;
  }
  return chunks;
}

// Never blow the whole event up to 4K when nothing in it is bigger than 1080p. The canvas would
// carry no detail the photos don't have, and a 4K encode measured 3.3× the wall clock of a 1080p
// one here — pure waiting, for nothing. Only downgraded when EVERY source fits inside 1080p as it
// is: one bigger photo and the big canvas stays, because that one would visibly lose detail.
export function canvasFor(
  resolution: string | undefined, sources: readonly { width?: number | null; height?: number | null }[],
): { w: number; h: number; downgraded: boolean } {
  const want = resOf(resolution);
  if (want.w <= RES['1080p'].w || !sources.length) return { w: want.w, h: want.h, downgraded: false };
  const fits = sources.every((s) => !!s.width && !!s.height
    && Math.max(s.width, s.height) <= RES['1080p'].w && Math.min(s.width, s.height) <= RES['1080p'].h);
  return fits
    ? { w: RES['1080p'].w, h: RES['1080p'].h, downgraded: true }
    : { w: want.w, h: want.h, downgraded: false };
}

function prettyLabel(file: string): string {
  return file.replace(/\.mp3$/i, '').replace(/^c0-/i, '').replace(/^\d+[-_]/, '').replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
/** A track's length in seconds, read off the file. 0 if it can't be read. */
export function probeAudioSeconds(file: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    let out = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } resolve(0); }, 15_000);
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', () => { clearTimeout(t); resolve(0); });
    p.on('close', () => { clearTimeout(t); const v = parseFloat(out.trim()); resolve(isFinite(v) ? v : 0); });
  });
}
// Keyed by path+mtime+size so a replaced custom upload re-probes and a bundled track never does.
// The panel polls slideshowInfo every 1.5s while a render runs; without this that would be an
// ffprobe per track per poll.
const audioSecsCache = new Map<string, number>();
async function cachedAudioSeconds(file: string): Promise<number | undefined> {
  try {
    const st = fs.statSync(file);
    const key = `${file}:${st.mtimeMs}:${st.size}`;
    const hit = audioSecsCache.get(key);
    if (hit === undefined) audioSecsCache.set(key, await probeAudioSeconds(file));
    return audioSecsCache.get(key) || undefined;
  } catch { return undefined; }
}
// Offer ONLY the no-attribution set (Mixkit Free License, prefix "c0-") so slideshows are
// credit-free. The CC-BY tracks remain on disk for reference but aren't selectable.
//
// Lengths are probed HERE rather than read in the browser from <audio preload="metadata">, which is
// where they used to come from. iOS Safari will not load media metadata without a user gesture, so
// `loadedmetadata` never fired on an iPhone and every track length — and with them the "your music
// is shorter than the show" warning — was silently missing on the device most hosts use. The server
// already has ffprobe, the answer is identical for every visitor, and it is knowable BEFORE the
// host taps a track, which is exactly when they want to see it.
export async function listMusic(): Promise<{ id: string; label: string; secs?: number }[]> {
  let files: string[] = [];
  try {
    files = fs.readdirSync(MUSIC_DIR)
      .filter((f) => f.toLowerCase().endsWith('.mp3') && f.toLowerCase().startsWith('c0-')).sort();
  } catch { return []; }
  return Promise.all(files.map(async (f) => {
    const secs = await cachedAudioSeconds(path.join(MUSIC_DIR, f));
    return secs ? { id: f, label: prettyLabel(f), secs } : { id: f, label: prettyLabel(f) };
  }));
}

type Phase = 'collecting' | 'encoding';
// Two orders, and deliberately only two: the night in the order it happened, or shuffled. A
// hand-sorted running order is a video editor's job, not something to ask a party host for.
export type SlideshowOrder = 'chronological' | 'shuffled';
export const orderOf = (o?: string): SlideshowOrder => (o === 'shuffled' ? 'shuffled' : 'chronological');
type Opts = { favouritesOnly?: boolean; track?: string; tracks?: string[]; loopMusic?: boolean; secondsPer?: number; includeVideos?: boolean; keepVideoAudio?: boolean; quality?: string; resolution?: string; branding?: boolean; order?: string };

// Concatenate several audio files (played in order) into one AAC file — so the rest of the encode
// treats "the music" as a single track (looped or not). Returns false on failure.
function concatAudio(paths: string[], dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    const args: string[] = [];
    for (const p of paths) args.push('-i', p);
    const inputs = paths.map((_, i) => `[${i}:a]`).join('');
    args.push('-filter_complex', `${inputs}concat=n=${paths.length}:v=0:a=1[a]`, '-map', '[a]', '-c:a', 'aac', '-b:a', '192k', '-y', dest);
    const p = spawn('ffmpeg', args);
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } resolve(false); }, 120_000);
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', (code) => { clearTimeout(t); resolve(code === 0 && fs.existsSync(dest)); });
  });
}
// Output quality → x264 CRF (lower = better/larger) + an approx 1080p bitrate (kbps) for size hints.
// Slideshows (stills + slow crossfades) compress very well, so these are conservative.
const QUALITY: Record<string, { crf: number; kbps: number }> = {
  best:   { crf: 20, kbps: 6000 },   // ~100% — visually pristine
  high:   { crf: 24, kbps: 3500 },
  small:  { crf: 28, kbps: 1800 },
};
const qualityOf = (q?: string) => QUALITY[q || 'best'] || QUALITY.best;
type Item = { path: string; isVideo: boolean; hasAudio?: boolean; width?: number | null; height?: number | null };

// FNV-1a over the render id → a 32-bit seed. A shuffled render has to be REPRODUCIBLE from the job
// that produced it: seeding off Math.random() would deal a different film every time the same job
// ran, so a host who liked what they saw could never get that one back.
function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// mulberry32 — tiny, fast, and identical for a given seed on every run.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Fisher–Yates driven by a seeded PRNG: same input + same seed → same output, every time. */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = items.slice();
  const next = rng(seedFrom(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
/** Put the items of one render into playing order.
 *
 *  Nothing is left out any more: a host who asks for all 300 photos gets all 300. This was a
 *  `slice(0, MAX_IMAGES)` that answered two questions at once — which photos survived a cut, and
 *  what order they played in — and it answered the first by accident, binning the end of a long
 *  night. With no cut to survive, only the order question is left.
 *
 *  Favourites deliberately do NOT sort here. They were promoted purely to survive the cap; keeping
 *  that with nothing to survive would silently drag every starred photo to the front of the film,
 *  which is not what starring a photo means. */
export function orderForRender<T>(items: readonly T[], order: SlideshowOrder, seed: string): T[] {
  return order === 'shuffled' ? seededShuffle(items, seed) : items.slice();
}

// Probe a video's real duration (seconds); 0 if it can't be read. We count decoded packets and
// divide by the frame rate — reliable even for webm from MediaRecorder, whose container/format
// duration metadata is often missing or wrong (which would make ffmpeg's `-t` hold a frozen frame
// to pad the gap mid-slideshow). Falls back to the container duration if packet counting fails.
function probeDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-count_packets', '-show_entries', 'stream=nb_read_packets,avg_frame_rate:format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=0', file]);
    let out = '';
    // Hard timeout: a malformed file must never hang ffprobe indefinitely.
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } resolve(0); }, 15_000);
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', () => { clearTimeout(t); resolve(0); });
    p.on('close', () => {
      clearTimeout(t);
      const get = (k: string) => { const m = new RegExp(`${k}=([^\\n]+)`).exec(out); return m ? m[1].trim() : ''; };
      const packets = parseInt(get('nb_read_packets'), 10);
      const fpsParts = get('avg_frame_rate').split('/');
      const fps = fpsParts.length === 2 ? parseInt(fpsParts[0], 10) / parseInt(fpsParts[1], 10) : parseFloat(fpsParts[0]);
      const byPackets = packets > 0 && fps > 0 && isFinite(fps) ? packets / fps : 0;
      const byFormat = parseFloat(get('duration')) || 0;
      // Prefer the packet-count duration; fall back to the (sometimes-wrong) container duration.
      resolve(byPackets || byFormat || 0);
    });
  });
}
/** How far apart a clip's own video and audio durations are, in ms. Null when it has no audio. */
export function avDriftMs(v?: number, a?: number): number | null {
  return typeof v === 'number' && typeof a === 'number' && isFinite(v) && isFinite(a)
    ? Math.round(Math.abs(v - a) * 1000) : null;
}

/** Above this, a listener hears the lips and the words come apart. */
export const AV_DRIFT_WARN_MS = 150;

// Probe a video's dimensions + duration (ms) for display metadata. Empty object on failure.
//
// Also logs the clip's A/V alignment AS RECEIVED, before anything of ours has touched it, because
// that is the one question a sync complaint turns on: did it arrive that way, or did we do it?
// Measured on two real uploads through the identical path — one came in 7ms apart and the other
// 983ms apart — so the answer varies per clip and is not something to reason about from the code.
// The crop for an H.264 source is a container-level rewrite that never re-encodes and never touches
// audio, so a drift visible here was already in the file the phone produced.
export function probeVideoMeta(file: string): Promise<{ width?: number; height?: number; durationMs?: number }> {
  return new Promise((resolve) => {
    // Every stream, not just v:0 — the audio stream is the entire point of the check below.
    const p = spawn('ffprobe', ['-v', 'error',
      '-show_entries', 'stream=index,codec_type,codec_name,width,height,duration,avg_frame_rate:format=duration',
      '-of', 'json', file]);
    let out = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } resolve({}); }, 15_000);
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', () => { clearTimeout(t); resolve({}); });
    p.on('close', () => {
      clearTimeout(t);
      try {
        const j = JSON.parse(out);
        const streams: Array<Record<string, unknown>> = Array.isArray(j.streams) ? j.streams : [];
        const v = streams.find((x) => x.codec_type === 'video') ?? {};
        const a = streams.find((x) => x.codec_type === 'audio');
        const dur = parseFloat(j.format?.duration);

        const vd = parseFloat(String(v.duration ?? ''));
        const ad = a ? parseFloat(String(a.duration ?? '')) : NaN;
        const drift = avDriftMs(vd, ad);
        const name = file.split('/').pop() || file;
        if (!a) {
          console.log(`[video] av-sync ${name}: no audio track`);
        } else {
          const line = `[video] av-sync ${name}: v=${isFinite(vd) ? vd.toFixed(3) : '?'}s `
            + `a=${isFinite(ad) ? ad.toFixed(3) : '?'}s drift=${drift ?? '?'}ms `
            + `fps=${String(v.avg_frame_rate ?? '?')} codec=${String(v.codec_name ?? '?')}`;
          if (drift !== null && drift > AV_DRIFT_WARN_MS) {
            console.warn(`${line}  ** OUT OF SYNC AS UPLOADED — ${ad < vd ? 'audio is SHORTER' : 'audio is LONGER'} than the video **`);
          } else {
            console.log(line);
          }
        }

        resolve({ width: v.width as number | undefined, height: v.height as number | undefined,
                  durationMs: isFinite(dur) ? Math.round(dur * 1000) : undefined });
      } catch { resolve({}); }
    });
  });
}
// Normalise a (possibly VFR webm) clip to a clean constant-frame-rate H.264 segment scaled to fit
// W×H, capped to maxDur. This is the definitive fix for mid-slideshow freezes: MediaRecorder webm
// has VFR + unreliable duration, which makes the xfade `-t` hold a frozen frame. After this the
// clip's real duration is exact and it composites cleanly.
function normalizeClip(src: string, dest: string, W: number, H: number, maxDur: number, keepAudio: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ['-y', '-t', String(maxDur), '-i', src,
      '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1,fps=${FPS}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];
    if (keepAudio) args.push('-c:a', 'aac', '-b:a', '160k'); else args.push('-an');
    args.push(dest);
    const p = spawn('ffmpeg', args);
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } resolve(false); }, 120_000);
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', (code) => { clearTimeout(t); resolve(code === 0 && fs.existsSync(dest)); });
  });
}
// Confirm a file actually decodes as audio (an audio stream exists) — used to validate custom
// uploads, since the multer MIME/extension filter alone can be spoofed.
export function probeHasAudioStream(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]);
    let out = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } resolve(false); }, 15_000);
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', () => { clearTimeout(t); resolve(out.includes('audio')); });
  });
}

type Job = { status: 'running' | 'done' | 'error'; url?: string; error?: string;
             progress?: number; phase?: Phase; label?: string; startedAt?: number };
type Pending = { id: string; opts: Opts; label: string; queuedAt: number };
export type StartResult = Job & { queuedCount: number; queueFull?: boolean };
const jobs = new Map<string, Job>();
const pending = new Map<string, Pending[]>();
// A render that failed while others were queued behind it would otherwise vanish the instant the
// next one claimed the job slot — the host would see the bar restart and never learn that the
// render before it died. Kept until a later render for the same event finishes.
const lastFailure = new Map<string, { label: string; error: string; at: number }>();

// Status + the info the panel needs to preview/estimate before building: eligible photo counts
// (so it can show "N photos · ~Xs") and the music list. Async because it counts photos.
// A photo counts toward the slideshow if it's visible: moderation on → approved only; off →
// anything not binned (pending photos are live when moderation is off).
async function visibleStatusSql(eventId: string): Promise<string> {
  const r = await all<{ moderation_enabled: boolean }>(`SELECT moderation_enabled FROM events WHERE id = ?`, [eventId]);
  return r[0]?.moderation_enabled ? "status = 'approved'" : "status != 'rejected'";
}

export async function slideshowInfo(eventId: string) {
  let photoCount = 0, favouriteCount = 0, videoCount = 0, favouriteVideoCount = 0, sourcesFitIn1080 = false;
  try {
    const rows = await all<{ is_highlighted: boolean; media_type: string; width: number | null; height: number | null }>(
      `SELECT is_highlighted, media_type, width, height FROM photos
         WHERE event_id = ? AND ${await visibleStatusSql(eventId)}`, [eventId]);
    const imgs = rows.filter((r) => r.media_type !== 'video');
    photoCount = imgs.length;
    favouriteCount = imgs.filter((r) => r.is_highlighted).length;
    videoCount = rows.length - imgs.length;
    // Favourite CLIPS are counted separately because a favourites render drops them unless asked
    // for: the SQL excludes videos before the favourite filter runs, so a host who starred a clip
    // lost it with nothing said. The panel can only offer them by name if it knows how many.
    favouriteVideoCount = rows.filter((r) => r.media_type === 'video' && r.is_highlighted).length;
    // Whether a 4K request would be pure upscale, so the panel can quote the time it will really
    // take rather than the time 4K would have taken.
    sourcesFitIn1080 = rows.length > 0 && canvasFor('4k', rows).downgraded;
  } catch { /* none */ }
  let hasCustomAudio = false, customAudioSecs: number | undefined;
  try {
    const dir = eventDir(eventId);
    const own = fs.readdirSync(dir).find((n) => n.startsWith('audio-'));
    if (own) { hasCustomAudio = true; customAudioSecs = await cachedAudioSeconds(path.join(dir, own)); }
  } catch { /* none */ }
  const job = jobs.get(eventId) ?? { status: 'idle' as unknown as Job['status'] };
  const recent = await listSlideshows(eventId);
  // Quality presets (id + label + approx 1080p video kbps) so the panel can offer a choice and
  // estimate the output size = (videoKbps + audioKbps) × duration.
  const qualities = [
    { id: 'best', label: 'Best (100%)', kbps: QUALITY.best.kbps },
    { id: 'high', label: 'High', kbps: QUALITY.high.kbps },
    { id: 'small', label: 'Smaller file', kbps: QUALITY.small.kbps },
  ];
  // renderScale = wall-clock seconds of rendering per second of finished video, so the panel can
  // say roughly how long this will take before the host starts it. Learned, not assumed — see
  // RENDER_RATE.
  const resolutions = [
    { id: '4k', label: '4K (sharpest)', sizeScale: RES['4k'].sizeScale, renderScale: Math.round(RENDER_RATE['4k'] * 100) / 100, prepPerItem: PREP_SECS['4k'] },
    { id: '1080p', label: '1080p (faster, smaller)', sizeScale: RES['1080p'].sizeScale, renderScale: Math.round(RENDER_RATE['1080p'] * 100) / 100, prepPerItem: PREP_SECS['1080p'] },
  ];
  // "Remove the Snapdini intro/outro" add-on: whether this event can already do it for free
  // (self-host, or already entitled) and the price to unlock it otherwise.
  let brandingRemovable = false;
  try {
    const r = await all<{ branding_removal_paid: boolean }>(
      `SELECT branding_removal_paid FROM events WHERE id = ?`, [eventId]);
    brandingRemovable = billingBrandingRemovable({ brandingRemovalPaid: r[0]?.branding_removal_paid });
  } catch { /* default false */ }
  // Resolved at SERVE time, not when the render finished: the 1080p copy is transcoded in the
  // background, so it appears a little after the render itself does.
  const jobPlay = (() => {
    if (!job.url?.startsWith('/uploads/')) return undefined;
    const rel = job.url.slice('/uploads/'.length);
    const play = playName(rel);
    try { return fs.existsSync(path.join(UPLOADS_DIR, play)) ? `/uploads/${play}` : undefined; }
    catch { return undefined; }
  })();
  // What is waiting behind the running render. The panel shows it so a host who queued a second
  // one can see that it exists, rather than wondering whether their second press did anything.
  const queued = (pending.get(eventId) ?? []).map((p) => ({ id: p.id, label: p.label, queuedAt: p.queuedAt }));
  // Surfaced separately from `job.error`, because by the time the panel asks, the job slot may
  // already belong to the render that was queued behind the one that failed.
  const failed = job.status === 'error' ? undefined : lastFailure.get(eventId);
  return { ...job, playUrl: jobPlay, music: await listMusic(), photoCount, favouriteCount, videoCount, favouriteVideoCount,
    hasCustomAudio, customAudioSecs, sourcesFitIn1080, secondsPerDefault: D_DEFAULT, recent, qualities, resolutions,
    queued, maxQueue: MAX_QUEUE, failed,
    brandingRemovable, brandingPriceCents: BRANDING_REMOVAL_CENTS, billingEnabled: BILLING_ON };
}

const SLIDESHOW_TTL_MS = 24 * 60 * 60 * 1000;   // non-favourite renders auto-purge after a day

function slideshowLabel(opts: Opts): string {
  const d = Math.min(8, Math.max(2, Math.round(opts.secondsPer || D_DEFAULT)));
  return `${opts.favouritesOnly ? 'Favourites' : 'All photos'} · ${d}s/photo${opts.includeVideos ? ' · video' : ''}${orderOf(opts.order) === 'shuffled' ? ' · shuffled' : ''}`;
}

// Start a render, or queue it behind the one already going.
//
// The old behaviour was to hand back the running job and drop the new request on the floor, so a
// host who changed a setting and pressed go again got no render with those settings and no word
// about it. An encode costs real minutes of this box's CPU, so the running one is never killed to
// make room either. Queue instead: renders are versioned rows in `slideshows`, so both films
// survive and the host picks. Serial and not parallel, deliberately — ffmpeg here already takes
// every core and is killed on a 5-minute timeout, so two 4K encodes at once would starve each
// other until one of them hit that timeout and died.
//
// This queue is PER EVENT. The same argument applies just as hard across events, and until
// `withSlideshowSlot` (below) there was nothing enforcing it there at all.
export function startSlideshow(eventId: string, opts: Opts): StartResult {
  const entry: Pending = { id: randomUUID().replace(/-/g, ''), opts, label: slideshowLabel(opts), queuedAt: Date.now() };
  const running = jobs.get(eventId);
  if (running?.status === 'running') {
    const queue = pending.get(eventId) ?? [];
    if (queue.length >= MAX_QUEUE) return { ...running, queuedCount: queue.length, queueFull: true };
    queue.push(entry);
    pending.set(eventId, queue);
    return { ...running, queuedCount: queue.length };
  }
  begin(eventId, entry);
  return { ...jobs.get(eventId)!, queuedCount: 0 };
}

function begin(eventId: string, entry: Pending): void {
  jobs.set(eventId, { status: 'running', progress: 0, phase: 'collecting', label: entry.label, startedAt: Date.now() });
  run(eventId, entry.opts, entry.id)
    .then(async (r) => {
      // Record this render so it shows in the "recent slideshows" list (versioned, not overwritten).
      // r.resolution, not what was asked for: a 4K request over an all-1080p event renders at 1080p.
      try { await db.insert(slideshows).values({ id: entry.id, eventId, filename: eventRelPath(eventId, `slideshow-${entry.id}.mp4`), label: entry.label, resolution: r.resolution, createdAt: Date.now() }); } catch { /* best-effort */ }
      jobs.set(eventId, { status: 'done', url: r.url, label: entry.label, progress: 100 });
      lastFailure.delete(eventId);   // a render that worked answers the one that didn't
      // A 4K render is what you want to keep and download; it is not what a phone should be asked
      // to stream in a preview. Build a 1080p H.264 copy alongside it, in the background so the
      // host is not kept waiting on the render they already have. 1080p renders need nothing.
      if (r.resolution !== '1080p') {
        void makePlaybackProxy(path.join(UPLOADS_DIR, eventRelPath(eventId, `slideshow-${entry.id}.mp4`)))
          .catch(() => false);
      }
    })
    .catch((e) => {
      const error = String(e?.message || e);
      jobs.set(eventId, { status: 'error', error, label: entry.label });
      lastFailure.set(eventId, { label: entry.label, error, at: Date.now() });
    })
    // Only now, with the finished render written to `slideshows`, does the next one take the job
    // slot — so handing the slot on can never lose the render that just finished.
    .finally(() => {
      const queue = pending.get(eventId);
      const next = queue?.shift();
      if (!queue?.length) pending.delete(eventId);
      if (next) begin(eventId, next);
    });
}

// Recent renders for an event, newest first.
export async function listSlideshows(eventId: string) {
  try {
    const rows = await db.select().from(slideshows).where(eq(slideshows.eventId, eventId))
      .orderBy(desc(slideshows.createdAt), asc(slideshows.id));   // `id` last so the list is a total order
    return rows.map((s) => {
      // playUrl is the lighter copy for the in-browser preview; url stays the full-quality
      // download. Only present once the transcode has finished.
      const play = playName(s.filename);
      const hasPlay = (() => { try { return fs.existsSync(path.join(UPLOADS_DIR, play)); } catch { return false; } })();
      return { id: s.id, url: `/uploads/${s.filename}`, ...(hasPlay ? { playUrl: `/uploads/${play}` } : {}),
               favourite: !!s.favourite, label: s.label || 'Slideshow',
               resolution: s.resolution || '4k', createdAt: s.createdAt };
    });
  } catch { return []; }
}

export async function toggleSlideshowFavourite(eventId: string, id: string): Promise<boolean> {
  const [row] = await db.select().from(slideshows).where(and(eq(slideshows.id, id), eq(slideshows.eventId, eventId)));
  if (!row) return false;
  await db.update(slideshows).set({ favourite: !row.favourite }).where(eq(slideshows.id, id));
  return !row.favourite;
}

export async function deleteSlideshow(eventId: string, id: string): Promise<boolean> {
  const [row] = await db.select().from(slideshows).where(and(eq(slideshows.id, id), eq(slideshows.eventId, eventId)));
  if (!row) return false;
  try { fs.unlinkSync(path.join(UPLOADS_DIR, row.filename)); } catch { /* already gone */ }
  try { fs.unlinkSync(path.join(UPLOADS_DIR, playName(row.filename))); } catch { /* none built */ }
  await db.delete(slideshows).where(eq(slideshows.id, id));
  return true;
}

// Locate a rendered slideshow on disk (for download) — null if the row/file is gone.
export async function slideshowFile(eventId: string, id: string): Promise<{ path: string; resolution: string } | null> {
  const [row] = await db.select().from(slideshows).where(and(eq(slideshows.id, id), eq(slideshows.eventId, eventId)));
  if (!row) return null;
  const p = path.join(UPLOADS_DIR, row.filename);
  if (!fs.existsSync(p)) return null;
  return { path: p, resolution: row.resolution || '4k' };
}

// Live-transcode a (4K) render down to 1080p and stream it to the response. Fragmented MP4 so it
// can be piped without seeking back to write the moov atom. Returns the child so the caller can
// kill it if the client disconnects. CPU encode (one-off, on download) — fine at 1080p.
export function streamSlideshow1080(srcPath: string, out: NodeJS.WritableStream): { kill: () => void } {
  const p = spawn('ffmpeg', ['-i', srcPath,
    '-vf', 'scale=-2:1080', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', 'frag_keyframe+empty_moov+faststart', '-f', 'mp4', 'pipe:1']);
  p.stdout.pipe(out);
  p.stderr.on('data', () => { /* swallow ffmpeg progress chatter */ });
  p.on('error', () => { try { (out as { destroy?: () => void }).destroy?.(); } catch { /* */ } });
  return { kill: () => { try { p.kill('SIGKILL'); } catch { /* */ } } };
}

// Auto-purge: drop non-favourite renders older than the TTL (file + row). Favourites are kept
// until the event itself is purged (handled in cleanup.ts).
export async function purgeOldSlideshows(): Promise<number> {
  let removed = 0;
  try {
    const stale = await db.select().from(slideshows)
      .where(and(eq(slideshows.favourite, false), lt(slideshows.createdAt, Date.now() - SLIDESHOW_TTL_MS)));
    for (const s of stale) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, s.filename)); } catch { /* gone */ }
      try { fs.unlinkSync(path.join(UPLOADS_DIR, playName(s.filename))); } catch { /* none built */ }
      await db.delete(slideshows).where(eq(slideshows.id, s.id));
      removed++;
    }
  } catch { /* best-effort */ }
  return removed;
}

// The one global render slot.
//
// `startSlideshow`'s queue is per event, so ten hosts pressing Build at the same moment used to
// mean ten concurrent renders: ten ffmpeg graphs each asking for `-threads NCPU`, each staging 4K
// intermediates under `UPLOADS_DIR/.ss-tmp`, on a box whose entire reason for chunking the timeline
// is that ONE 4K run peaks in the gigabytes. Organizer-gated bounds WHO can start one, not how
// much of the machine it takes, and nothing above this line bounded the latter.
//
// They deliberately do NOT share images.ts's video slot, tempting as the reuse is. That slot is
// what a GUEST's clip waits in for its crop and its playback proxy, and a 4K render would hold it
// for the several minutes it takes: every guest at every other event on the box would be left with
// a clip their phone may not be able to decode at all (a Firefox/iOS WebM without its H.264 proxy
// is not "lower quality", it is unplayable), to save an organizer a wait their panel is already
// showing them. One slot each is the right shape: at most one render and one piece of guest media
// in flight, and neither can starve the other.
//
// The WHOLE render sits inside the slot, prep included — the pre-scale loop runs sharp over every
// still and spawns an ffmpeg per clip to normalise it, so gating only the encode would have left
// most of the CPU cost unbounded. Waiting costs nothing that can time out: every budget and stall
// timer in `runFfmpeg` starts after its spawn, which now happens after the wait.
//
// One, and not configurable: the guest-media slot next door is a hard 1 for the same reason, and a
// knob here would be a knob on how close to OOM a host may push the box.
//
// Exported so the test can occupy the slot and watch a second event's render queue behind it. That
// is the only way to state the bug as a failing assertion: without the gate, a second event's
// render is never "waiting" — it is simply also running, and nothing in the process knows.
export const withSlideshowSlot = makeSlot(1);

function run(eventId: string, opts: Opts, outId: string): Promise<{ url: string; resolution: string }> {
  return withSlideshowSlot(() => renderFilm(eventId, opts, outId));
}

async function renderFilm(eventId: string, opts: Opts, outId: string): Promise<{ url: string; resolution: string }> {
  const D = Math.min(8, Math.max(2, Math.round(opts.secondsPer || D_DEFAULT)));   // 2–8s/photo
  // Include video clips too when asked; otherwise photos only. Rejected/pending always excluded.
  let rows = await all<{ filename: string; is_highlighted: boolean; media_type: string; width: number | null; height: number | null }>(
    `SELECT filename, is_highlighted, media_type, width, height FROM photos
       WHERE event_id = ? AND ${await visibleStatusSql(eventId)}
         ${opts.includeVideos ? '' : "AND media_type != 'video'"}
       -- THIS IS THE FILM'S SLOT ORDER, and for order='shuffled' it is also the INPUT ARRAY to the
       -- seeded shuffle below, so one tie in taken_at does not swap two slides, it changes the
       -- whole permutation. id last makes it a total order, which is what makes a render
       -- reproducible from its seed. (No backticks in here: this is a template literal.)
       ORDER BY taken_at ASC, id ASC`, [eventId]);
  if (opts.favouritesOnly) rows = rows.filter((r) => r.is_highlighted);

  const allItems: Item[] = rows
    .map((r) => ({ path: path.join(UPLOADS_DIR, r.filename), isVideo: r.media_type === 'video', width: r.width, height: r.height }))
    .filter((it) => fs.existsSync(it.path));
  // Every visible item the host asked for goes in — the render id doubles as the shuffle seed, so a
  // shuffled film is fixed for the life of that render and only a NEW render deals a new order.
  const items = orderForRender(allItems, orderOf(opts.order), outId);
  if (!items.length) throw new Error('No photos to include yet');
  // Output canvas: what was asked for, unless every source is small enough that 4K would only be
  // an expensive upscale of nothing.
  const { w: Wp, h: Hp, downgraded } = canvasFor(opts.resolution, items);
  const resolution = downgraded || opts.resolution === '1080p' ? '1080p' : '4k';

  // Per-item duration: photos get D; clips get their own length, capped to CLIP_MAX (≥1s).
  // When keeping clip sound, also probe which clips actually carry an audio track.
  const durs: number[] = [];
  for (const it of items) {
    if (it.isVideo) {
      const d = await probeDuration(it.path); durs.push(Math.min(CLIP_MAX, Math.max(1, d || CLIP_MAX)));
      if (opts.keepVideoAudio) it.hasAudio = await probeHasAudioStream(it.path);
    } else durs.push(D);
  }

  // ── Event theme → drives the slideshow's background colour AND the branding-card styling, so the
  // video reads in-line with the event rather than on a generic dark/white backdrop. ──
  let themeBg = '#0f0f0f', accent = '#f5c518', headerImage: string | undefined;
  let evMeta: { name?: string; blurb?: string | null; starts_at?: number } = {};
  try {
    const evRow = (await all<{ name: string; blurb: string | null; starts_at: number; theme: string | null }>(
      `SELECT name, blurb, starts_at, theme FROM events WHERE id = ?`, [eventId]))[0];
    evMeta = { name: evRow?.name, blurb: evRow?.blurb, starts_at: evRow?.starts_at };
    const th = evRow?.theme ? JSON.parse(evRow.theme) : null;
    if (th?.bg) themeBg = th.bg;
    if (th?.accent) accent = th.accent;
    if (th?.headerImage) headerImage = uploadDiskPath(String(th.headerImage)); // throws (→ no header image) if it escapes UPLOADS_DIR
  } catch { /* default theme */ }
  // ffmpeg pad/letterbox colour from the theme bg (#rrggbb → 0xrrggbb), falling back to black.
  const hex = themeBg.replace('#', '');
  const padColor = /^[0-9a-fA-F]{6}$/.test(hex) ? `0x${hex}` : 'black';

  // ── Branding cards: a Snapdini intro (logo + event name / blurb / date) and a closing outro. ──
  // Skipped entirely when the organizer bought the "remove Snapdini frames" add-on (opts.branding=false).
  // All render intermediates (cards, pre-scaled stills, normalised clips, concatenated audio) go in a
  // private temp dir on the uploads volume — a dotfile dir so express.static never serves it, and on
  // the same big volume so 4K frames don't fill a small container /tmp. Only the final mp4 lands in
  // the event folder. The whole workDir is removed in the finally below.
  const workDir = path.join(UPLOADS_DIR, '.ss-tmp', outId);
  fs.mkdirSync(workDir, { recursive: true });
  const cardFiles: string[] = [];
  if (opts.branding !== false) try {
    const year = evMeta.starts_at ? new Date(evMeta.starts_at).getFullYear() : new Date().getFullYear();
    const introPath = path.join(workDir, `${outId}-intro.png`), outroPath = path.join(workDir, `${outId}-outro.png`);
    const dateStr = evMeta.starts_at ? new Date(evMeta.starts_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    await renderCard(Wp, Hp, [
      { text: clip(evMeta.name || 'Our Event', 38), size: 92, color: '#ffffff', weight: 800, dy: 480 },
      ...(evMeta.blurb ? [{ text: clip(evMeta.blurb, 70), size: 40, color: '#f0ece6', weight: 400, dy: 565 }] : []),
      ...(dateStr ? [{ text: dateStr, size: 36, color: accent, weight: 700, dy: 645 }] : []),
    ], introPath, { bgImage: headerImage, accent, bg: themeBg, footer: `© ${year} Snapdini` });
    await renderCard(Wp, Hp, [
      { text: 'That’s a wrap!', size: 84, color: '#ffffff', weight: 800, dy: 470 },
      { text: 'Loved capturing your event? Your guests did too.', size: 40, color: '#f0ece6', weight: 400, dy: 560 },
      { text: 'Start your own at snapdini.com', size: 40, color: accent, weight: 700, dy: 650 },
    ], outroPath, { bgImage: headerImage, accent, bg: themeBg, footer: `© ${year} Snapdini · snapdini.com` });
    if (fs.existsSync(introPath)) { items.unshift({ path: introPath, isVideo: false, width: Wp, height: Hp }); durs.unshift(CARD_SECS); cardFiles.push(introPath); }
    if (fs.existsSync(outroPath)) { items.push({ path: outroPath, isVideo: false, width: Wp, height: Hp }); durs.push(CARD_SECS); cardFiles.push(outroPath); }
  } catch { /* cards are best-effort — skip on any failure */ }

  // Pre-scale still photos to 1080p ONCE (fast, via sharp) so ffmpeg isn't re-scaling a 33-megapixel
  // 8K frame 30×/second — that per-frame rescale of full-res stills is the real encode bottleneck.
  // Cards (already 1080p PNGs) and video clips are left untouched.
  const tempFiles: string[] = [...cardFiles];
  const cardSet = new Set(cardFiles);
  const ssDir = workDir;
  for (let i = 0; i < items.length; i++) {
    if (cardSet.has(items[i].path)) continue;
    if (items[i].isVideo) {
      // Normalise clips to clean CFR so they don't freeze mid-show; re-probe the now-exact duration.
      const dest = path.join(ssDir, `${outId}-v${i}.mp4`);
      if (await normalizeClip(items[i].path, dest, Wp, Hp, Math.min(CLIP_MAX, durs[i]), !!items[i].hasAudio)) {
        const d = await probeDuration(dest);
        items[i] = { ...items[i], path: dest };
        if (d > 0) durs[i] = Math.min(CLIP_MAX, Math.max(1, d));
        tempFiles.push(dest);
      }
    } else {
      // Pre-scale stills to the output size ONCE so ffmpeg isn't rescaling an 8K frame 30×/second.
      // We size to fit the canvas with sharp's high-quality Lanczos kernel — this also UPSCALES
      // small photos (e.g. low-res selfie-cam shots) cleanly here rather than letting ffmpeg's
      // cheaper bilinear scaler do it, which is what made low-res stills look soft/grainy in 4K.
      // Quality 95 keeps the intermediate visually lossless.
      const dest = path.join(ssDir, `${outId}-s${i}.jpg`);
      try {
        await sharp(items[i].path).rotate().resize(Wp, Hp, { fit: 'inside', kernel: 'lanczos3' }).jpeg({ quality: 95 }).toFile(dest);
        items[i] = { ...items[i], path: dest };
        tempFiles.push(dest);
      } catch { /* keep the original on failure */ }
    }
  }

  // Resolve the (optional) backing music — one or more tracks, played IN ORDER. Multiple tracks are
  // concatenated into a single temp file so the loop/trim path below is unchanged.
  const resolveTrack = (t: string): string | null => {
    if (t === '__custom__') {
      try { const dir = eventDir(eventId); const f = fs.readdirSync(dir).find((n) => n.startsWith('audio-')); return f ? path.join(dir, f) : null; }
      catch { return null; }
    }
    const p = path.join(MUSIC_DIR, path.basename(t));
    return fs.existsSync(p) ? p : null;
  };
  const trackIds = (opts.tracks && opts.tracks.length) ? opts.tracks : (opts.track ? [opts.track] : []);
  const trackPaths = trackIds.map(resolveTrack).filter((p): p is string => !!p);
  const loopMusic = opts.loopMusic !== false;   // default: loop the music to fill the whole show
  let music: string | null = null;
  if (trackPaths.length === 1) music = trackPaths[0];
  else if (trackPaths.length > 1) {
    const dest = path.join(ssDir, `${outId}-audio.m4a`);
    if (await concatAudio(trackPaths, dest)) { music = dest; tempFiles.push(dest); }
    else music = trackPaths[0];   // concat failed → fall back to the first track
  }

  const outDir = eventDir(eventId);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `slideshow-${outId}.mp4`);

  const tl = buildTimeline(durs, FPS, T);
  const totalSecs = tl.totalFrames / FPS;
  const profile: EncodeProfile = { W: Wp, H: Hp, crf: qualityOf(opts.quality).crf, preset: ENCODE_PRESET, fps: FPS, padColor, threads: NCPU };
  const limits = chunkLimitsFor(Wp);
  const chunks = planChunks(tl, limits.items, limits.secs * FPS);
  const job = jobs.get(eventId);
  if (job) job.phase = 'encoding';
  const encodeStarted = Date.now();
  try {
    // Each chunk is encoded to its own MPEG-TS part with ONE identical settings object, because the
    // concat demuxer joins streams by trusting that their codec parameters match — a chunk encoded
    // even slightly differently is a glitch at the join, not an error anyone would see.
    const parts: string[] = [];
    let emitted = 0;   // frames finished in earlier chunks, so the bar spans the whole film
    for (let c = 0; c < chunks.length; c++) {
      const part = path.join(workDir, `${outId}-p${c}.ts`);
      tempFiles.push(part);
      const span = chunks[c].endFrame - chunks[c].startFrame;
      await runFfmpeg(buildChunkArgs(items, tl, chunks[c], profile, part), (f) => {
        if (job) job.progress = Math.max(0, Math.min(98, Math.round(((emitted + Math.min(f, span)) / tl.totalFrames) * 100)));
      }, encodeTimeoutMs(span / FPS, resolution));
      emitted += span;
      parts.push(part);
    }
    const listPath = path.join(workDir, `${outId}-parts.txt`);
    fs.writeFileSync(listPath, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    tempFiles.push(listPath);
    // One final pass joins the parts and lays the audio over the WHOLE film, with the video copied
    // rather than re-encoded. The music has to run across the joins: cut and re-encoded per chunk it
    // would click at every boundary, which is the same bug as a visible cut, just for the ears.
    await runFfmpeg(buildMuxArgs(listPath, items, tl, music, outPath, !!opts.keepVideoAudio, loopMusic),
      undefined, Math.max(ENCODE_BUDGET_FLOOR_MS, Math.round(totalSecs * 1000)));
    if (job) job.progress = 99;
    noteRenderRate(resolution, totalSecs, Date.now() - encodeStarted);
  } finally {
    // Success or failure, the whole working directory goes — chunk parts included, and they are the
    // biggest thing in it.
    for (const f of tempFiles) { try { fs.unlinkSync(f); } catch { /* gone */ } }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* gone */ }
  }
  return { url: `/uploads/${eventRelPath(eventId, `slideshow-${outId}.mp4`)}`, resolution };
}

export type EncodeProfile = { W: number; H: number; crf: number; preset: string; fps: number; padColor: string; threads: number };
// Measured here on real photos at CRF 20: veryfast ran 0.88× real time at 4K and produced the
// SMALLEST file of every preset tried (17.9 MB, against 21.8 for faster, 22.3 for fast, 19.9 for
// medium and 75.7 for ultrafast). Slower presets cost time and gave nothing back on this content —
// long static holds and slow crossfades — so there is nothing to win by moving off it.
const ENCODE_PRESET = 'veryfast';

// One chunk of the film: the normal xfade chain over just this chunk's items, then trimmed in
// FRAMES to the window this chunk owns. Video only — audio is laid over the joined film later.
export function buildChunkArgs(items: Item[], tl: Timeline, chunk: Chunk, p: EncodeProfile, outPath: string): string[] {
  const { from: a, to: b } = chunk;
  const args: string[] = ['-progress', 'pipe:1', '-nostats'];
  for (let i = a; i <= b; i++) {
    if (items[i].isVideo) args.push('-i', items[i].path);
    // A couple of frames more than needed; the trim below takes it back to the exact count.
    else args.push('-loop', '1', '-t', ((tl.frames[i] + 2) / p.fps).toFixed(4), '-i', items[i].path);
  }
  const parts: string[] = [];
  for (let i = a; i <= b; i++) {
    const k = i - a;
    // tpad clones the last frame if a clip delivers a frame or two fewer than it claimed; trim then
    // cuts every input to EXACTLY frames[i]. Without it one short clip shifts every later fade.
    const pad = items[i].isVideo ? 'tpad=stop_mode=clone:stop_duration=2,' : '';
    parts.push(`[${k}:v]scale=${p.W}:${p.H}:force_original_aspect_ratio=decrease,` +
      `pad=${p.W}:${p.H}:(ow-iw)/2:(oh-ih)/2:${p.padColor},setsar=1,fps=${p.fps},${pad}format=yuv420p,` +
      `trim=end_frame=${tl.frames[i]},setpts=PTS-STARTPTS[v${k}]`);
  }
  let last = 'v0';
  for (let i = a + 1; i <= b; i++) {
    const k = i - a;
    parts.push(`[${last}][v${k}]xfade=transition=fade:duration=${(tl.fade[i - 1] / p.fps).toFixed(6)}` +
      `:offset=${((tl.offset[i] - tl.offset[a]) / p.fps).toFixed(6)}[x${k}]`);
    last = `x${k}`;
  }
  // Cut this chunk's window out of the local timeline by frame index, and rebase to zero so the
  // concat demuxer can lay the parts end to end.
  parts.push(`[${last}]trim=start_frame=${chunk.startFrame}:end_frame=${chunk.endFrame},setpts=PTS-STARTPTS[out]`);
  args.push('-filter_complex_threads', String(p.threads), '-filter_complex', parts.join(';'),
    '-map', '[out]', '-an',
    '-c:v', 'libx264', '-threads', String(p.threads), '-pix_fmt', 'yuv420p', '-r', String(p.fps),
    '-preset', p.preset, '-crf', String(p.crf), '-f', 'mpegts', '-y', outPath);
  return args;
}

// Join the parts and add the sound, in one pass, with `-c:v copy` — the picture is already encoded.
export function buildMuxArgs(listPath: string, items: Item[], tl: Timeline, music: string | null,
                      outPath: string, keepVideoAudio: boolean, loopMusic: boolean): string[] {
  const total = tl.totalFrames / FPS;
  const args: string[] = ['-progress', 'pipe:1', '-nostats', '-fflags', '+genpts',
    '-f', 'concat', '-safe', '0', '-i', listPath];
  let idx = 1, musicIdx = -1;
  // Loop the music to fill the whole show (default), or play it once — when it's shorter than the
  // show the trailing video is silent (the UI warns about this before generating).
  if (music) { if (loopMusic) args.push('-stream_loop', '-1'); args.push('-i', music); musicIdx = idx++; }
  const clips: { item: number; input: number }[] = [];
  if (keepVideoAudio) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].isVideo && items[i].hasAudio) { args.push('-i', items[i].path); clips.push({ item: i, input: idx++ }); }
    }
  }
  const parts: string[] = [];
  const mixIns: string[] = [];
  // Each clip's own audio sits at the frame its footage starts on, which is the only place it can
  // be now that the picture is already cut.
  for (const c of clips) {
    parts.push(`[${c.input}:a]aresample=async=1,adelay=${Math.round((tl.offset[c.item] / FPS) * 1000)}:all=1[ca${c.item}]`);
    mixIns.push(`[ca${c.item}]`);
  }
  if (musicIdx >= 0) {
    // Under the clips when there are clips to be under; at its own level when it is the only sound.
    parts.push(`[${musicIdx}:a]aresample=async=1${clips.length ? ',volume=0.35' : ''}[bgm]`);
    mixIns.push('[bgm]');
  }
  const maps = ['-map', '0:v'];
  if (mixIns.length) {
    let src = mixIns[0];
    if (mixIns.length > 1) {
      parts.push(`${mixIns.join('')}amix=inputs=${mixIns.length}:duration=longest:dropout_transition=0[amx]`);
      src = '[amx]';
    }
    parts.push(`${src}atrim=0:${total.toFixed(3)},afade=t=out:st=${Math.max(0, total - 2).toFixed(3)}:d=2[a]`);
    args.push('-filter_complex', parts.join(';'));
    maps.push('-map', '[a]');
  }
  args.push(...maps, '-c:v', 'copy');
  if (mixIns.length) args.push('-c:a', 'aac', '-b:a', '160k');
  args.push('-movflags', '+faststart', '-y', outPath);
  return args;
}

// Two guards, because they catch different failures. The BUDGET is a ceiling on a legitimate job
// and scales with the job, so an uncapped 400-photo film is not killed merely for being long. The
// STALL guard is the one that catches a process that is actually stuck: `-progress` reports the
// encoded position continuously, so ten minutes of silence means wedged, whatever budget is left.
function runFfmpeg(args: string[], onProgress: ((frames: number) => void) | undefined, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args);
    let err = '';
    const stop = () => { try { p.kill('SIGKILL'); } catch { /* already gone */ } };
    const budget = setTimeout(() => { stop(); reject(new Error('ffmpeg exceeded its time budget')); }, timeoutMs);
    let stall: ReturnType<typeof setTimeout>;
    const waitForProgress = () => {
      stall = setTimeout(() => { stop(); reject(new Error('ffmpeg stopped reporting progress')); }, ENCODE_STALL_MS);
    };
    waitForProgress();
    const done = () => { clearTimeout(budget); clearTimeout(stall); };
    p.stderr.on('data', (d) => { err = (err + d.toString()).slice(-4000); });
    // `-progress pipe:1` writes key=value lines to stdout; `frame` is the encoded position, and
    // frames are what the timeline is counted in. Always read, even with no onProgress: the stall
    // guard is driven off the same lines.
    let buf = '';
    p.stdout.on('data', (d) => {
      buf = (buf + d.toString()).slice(-2000);
      const m = [...buf.matchAll(/frame=\s*(\d+)/g)].pop();
      if (!m) return;
      clearTimeout(stall);
      waitForProgress();
      if (onProgress) onProgress(parseInt(m[1], 10));
    });
    p.on('error', (e) => { done(); reject(e); });
    p.on('close', (code) => { done(); code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`)); });
  });
}
