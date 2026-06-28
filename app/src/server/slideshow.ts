import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

const NCPU = Math.max(2, os.cpus().length);   // use the box's cores for filtering + encoding
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { all, db } from './db';
import { slideshows } from './schema';
import { UPLOADS_DIR } from './paths';
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
  let pipeline: sharp.Sharp;
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
const MAX_IMAGES = 60;          // bound encode time/memory (counts photos + clips)
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

function prettyLabel(file: string): string {
  return file.replace(/\.mp3$/i, '').replace(/^c0-/i, '').replace(/^\d+[-_]/, '').replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
// Offer ONLY the no-attribution set (Mixkit Free License, prefix "c0-") so slideshows are
// credit-free. The CC-BY tracks remain on disk for reference but aren't selectable.
export function listMusic(): { id: string; label: string }[] {
  try {
    return fs.readdirSync(MUSIC_DIR)
      .filter((f) => f.toLowerCase().endsWith('.mp3') && f.toLowerCase().startsWith('c0-'))
      .sort().map((f) => ({ id: f, label: prettyLabel(f) }));
  } catch { return []; }
}

type Phase = 'collecting' | 'encoding';
type Opts = { favouritesOnly?: boolean; track?: string; tracks?: string[]; loopMusic?: boolean; secondsPer?: number; includeVideos?: boolean; keepVideoAudio?: boolean; quality?: string; resolution?: string; branding?: boolean };

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
type Item = { path: string; isVideo: boolean; hasAudio?: boolean };

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
// Probe a video's dimensions + duration (ms) for display metadata. Empty object on failure.
export function probeVideoMeta(file: string): Promise<{ width?: number; height?: number; durationMs?: number }> {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file]);
    let out = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } resolve({}); }, 15_000);
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', () => { clearTimeout(t); resolve({}); });
    p.on('close', () => {
      clearTimeout(t);
      try {
        const j = JSON.parse(out); const s = (j.streams && j.streams[0]) || {};
        const dur = parseFloat(j.format?.duration);
        resolve({ width: s.width, height: s.height, durationMs: isFinite(dur) ? Math.round(dur * 1000) : undefined });
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

type Job = { status: 'running' | 'done' | 'error'; url?: string; error?: string; truncated?: boolean; progress?: number; phase?: Phase };
const jobs = new Map<string, Job>();

// Status + the info the panel needs to preview/estimate before building: eligible photo counts
// (so it can show "N photos · ~Xs") and the music list. Async because it counts photos.
// A photo counts toward the slideshow if it's visible: moderation on → approved only; off →
// anything not binned (pending photos are live when moderation is off).
async function visibleStatusSql(eventId: string): Promise<string> {
  const r = await all<{ moderation_enabled: boolean }>(`SELECT moderation_enabled FROM events WHERE id = ?`, [eventId]);
  return r[0]?.moderation_enabled ? "status = 'approved'" : "status != 'rejected'";
}

export async function slideshowInfo(eventId: string) {
  let photoCount = 0, favouriteCount = 0, videoCount = 0;
  try {
    const rows = await all<{ is_highlighted: boolean; media_type: string }>(
      `SELECT is_highlighted, media_type FROM photos
         WHERE event_id = ? AND ${await visibleStatusSql(eventId)}`, [eventId]);
    const imgs = rows.filter((r) => r.media_type !== 'video');
    photoCount = imgs.length;
    favouriteCount = imgs.filter((r) => r.is_highlighted).length;
    videoCount = rows.length - imgs.length;
  } catch { /* none */ }
  let hasCustomAudio = false;
  try {
    hasCustomAudio = fs.readdirSync(path.join(UPLOADS_DIR, 'slideshow-audio')).some((n) => n.startsWith(eventId + '-'));
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
  const resolutions = [
    { id: '4k', label: '4K (sharpest)', sizeScale: RES['4k'].sizeScale },
    { id: '1080p', label: '1080p (faster, smaller)', sizeScale: RES['1080p'].sizeScale },
  ];
  // "Remove the Snapdini intro/outro" add-on: whether this event can already do it for free
  // (self-host, or already entitled) and the price to unlock it otherwise.
  let brandingRemovable = false;
  try {
    const r = await all<{ branding_removal_paid: boolean }>(
      `SELECT branding_removal_paid FROM events WHERE id = ?`, [eventId]);
    brandingRemovable = billingBrandingRemovable({ brandingRemovalPaid: r[0]?.branding_removal_paid });
  } catch { /* default false */ }
  return { ...job, music: listMusic(), photoCount, favouriteCount, videoCount, hasCustomAudio, maxImages: MAX_IMAGES, secondsPerDefault: D_DEFAULT, recent, qualities, resolutions,
    brandingRemovable, brandingPriceCents: BRANDING_REMOVAL_CENTS, billingEnabled: BILLING_ON };
}

const SLIDESHOW_TTL_MS = 24 * 60 * 60 * 1000;   // non-favourite renders auto-purge after a day

function slideshowLabel(opts: Opts): string {
  const d = Math.min(8, Math.max(2, Math.round(opts.secondsPer || D_DEFAULT)));
  return `${opts.favouritesOnly ? 'Favourites' : 'All photos'} · ${d}s/photo${opts.includeVideos ? ' · video' : ''}`;
}

export function startSlideshow(eventId: string, opts: Opts): Job {
  const existing = jobs.get(eventId);
  if (existing?.status === 'running') return existing;
  const id = randomUUID().replace(/-/g, '');
  const job: Job = { status: 'running', progress: 0, phase: 'collecting' };
  jobs.set(eventId, job);
  run(eventId, opts, id)
    .then(async (r) => {
      // Record this render so it shows in the "recent slideshows" list (versioned, not overwritten).
      try { await db.insert(slideshows).values({ id, eventId, filename: `slideshows/${id}.mp4`, label: slideshowLabel(opts), resolution: (opts.resolution === '1080p' ? '1080p' : '4k'), createdAt: Date.now() }); } catch { /* best-effort */ }
      jobs.set(eventId, { status: 'done', url: r.url, truncated: r.truncated, progress: 100 });
    })
    .catch((e) => jobs.set(eventId, { status: 'error', error: String(e?.message || e) }));
  return job;
}

// Recent renders for an event, newest first.
export async function listSlideshows(eventId: string) {
  try {
    const rows = await db.select().from(slideshows).where(eq(slideshows.eventId, eventId)).orderBy(desc(slideshows.createdAt));
    return rows.map((s) => ({ id: s.id, url: `/uploads/${s.filename}`, favourite: !!s.favourite, label: s.label || 'Slideshow', resolution: s.resolution || '4k', createdAt: s.createdAt }));
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
      await db.delete(slideshows).where(eq(slideshows.id, s.id));
      removed++;
    }
  } catch { /* best-effort */ }
  return removed;
}

async function run(eventId: string, opts: Opts, outId: string): Promise<{ url: string; truncated: boolean }> {
  const { w: Wp, h: Hp } = resOf(opts.resolution);   // output canvas (4K default, 1080p option)
  const D = Math.min(8, Math.max(2, Math.round(opts.secondsPer || D_DEFAULT)));   // 2–8s/photo
  // Include video clips too when asked; otherwise photos only. Rejected/pending always excluded.
  let rows = await all<{ filename: string; is_highlighted: boolean; media_type: string }>(
    `SELECT filename, is_highlighted, media_type FROM photos
       WHERE event_id = ? AND ${await visibleStatusSql(eventId)}
         ${opts.includeVideos ? '' : "AND media_type != 'video'"}
       ORDER BY taken_at ASC`, [eventId]);
  if (opts.favouritesOnly) rows = rows.filter((r) => r.is_highlighted);

  const allItems: Item[] = rows
    .map((r) => ({ path: path.join(UPLOADS_DIR, r.filename), isVideo: r.media_type === 'video' }))
    .filter((it) => fs.existsSync(it.path));
  const truncated = allItems.length > MAX_IMAGES;
  const items = allItems.slice(0, MAX_IMAGES);
  if (!items.length) throw new Error('No photos to include yet');

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
    if (th?.headerImage) headerImage = path.join(UPLOADS_DIR, String(th.headerImage).replace('/uploads/', ''));
  } catch { /* default theme */ }
  // ffmpeg pad/letterbox colour from the theme bg (#rrggbb → 0xrrggbb), falling back to black.
  const hex = themeBg.replace('#', '');
  const padColor = /^[0-9a-fA-F]{6}$/.test(hex) ? `0x${hex}` : 'black';

  // ── Branding cards: a Snapdini intro (logo + event name / blurb / date) and a closing outro. ──
  // Skipped entirely when the organizer bought the "remove Snapdini frames" add-on (opts.branding=false).
  const cardFiles: string[] = [];
  if (opts.branding !== false) try {
    const year = evMeta.starts_at ? new Date(evMeta.starts_at).getFullYear() : new Date().getFullYear();
    const dir = path.join(UPLOADS_DIR, 'slideshows'); fs.mkdirSync(dir, { recursive: true });
    const introPath = path.join(dir, `${outId}-intro.png`), outroPath = path.join(dir, `${outId}-outro.png`);
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
    if (fs.existsSync(introPath)) { items.unshift({ path: introPath, isVideo: false }); durs.unshift(CARD_SECS); cardFiles.push(introPath); }
    if (fs.existsSync(outroPath)) { items.push({ path: outroPath, isVideo: false }); durs.push(CARD_SECS); cardFiles.push(outroPath); }
  } catch { /* cards are best-effort — skip on any failure */ }

  // Pre-scale still photos to 1080p ONCE (fast, via sharp) so ffmpeg isn't re-scaling a 33-megapixel
  // 8K frame 30×/second — that per-frame rescale of full-res stills is the real encode bottleneck.
  // Cards (already 1080p PNGs) and video clips are left untouched.
  const tempFiles: string[] = [...cardFiles];
  const cardSet = new Set(cardFiles);
  const ssDir = path.join(UPLOADS_DIR, 'slideshows');
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
      try { const dir = path.join(UPLOADS_DIR, 'slideshow-audio'); const f = fs.readdirSync(dir).find((n) => n.startsWith(eventId + '-')); return f ? path.join(dir, f) : null; }
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

  const outDir = path.join(UPLOADS_DIR, 'slideshows');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${outId}.mp4`);

  const total = durs.reduce((a, b) => a + b, 0) - (items.length - 1) * T;   // final video length (s)
  const job = jobs.get(eventId);
  if (job) job.phase = 'encoding';
  // Report encode progress (ffmpeg -progress) back onto the job so the panel shows a live bar.
  try {
    await runFfmpeg(buildArgs(items, durs, music, outPath, !!opts.keepVideoAudio, qualityOf(opts.quality).crf, Wp, Hp, loopMusic, padColor), (sec) => {
      if (job) job.progress = Math.max(0, Math.min(99, Math.round((sec / total) * 100)));
    });
  } finally {
    for (const f of tempFiles) { try { fs.unlinkSync(f); } catch { /* gone */ } }   // clean up temp cards + pre-scaled stills
  }
  return { url: `/uploads/slideshows/${outId}.mp4`, truncated };
}

function buildArgs(items: Item[], durs: number[], music: string | null, outPath: string, keepVideoAudio: boolean, crf: number, Wp: number, Hp: number, loopMusic = true, padColor = 'black'): string[] {
  const args: string[] = ['-progress', 'pipe:1', '-nostats'];
  // `-t durs[i]` caps each input's video AND audio to its shown duration; stills are looped.
  items.forEach((it, i) => {
    if (it.isVideo) args.push('-t', String(durs[i]), '-i', it.path);
    else args.push('-loop', '1', '-t', String(durs[i]), '-i', it.path);
  });
  // Loop the music to fill the whole show (default), or play it once — when it's shorter than the
  // show the trailing video is silent (the UI warns about this before generating).
  if (music) { if (loopMusic) args.push('-stream_loop', '-1', '-i', music); else args.push('-i', music); }

  const N = items.length;
  const musicIdx = N;   // music is the input after the N media items
  // offsets[i] = when clip i starts in the output timeline (each transition overlaps by T).
  const offsets: number[] = [0];
  for (let i = 1; i < N; i++) offsets[i] = offsets[i - 1] + durs[i - 1] - T;
  const total = durs.reduce((a, b) => a + b, 0) - (N - 1) * T;

  const parts: string[] = [];
  for (let i = 0; i < N; i++) {
    parts.push(`[${i}:v]scale=${Wp}:${Hp}:force_original_aspect_ratio=decrease,` +
      `pad=${Wp}:${Hp}:(ow-iw)/2:(oh-ih)/2:${padColor},setsar=1,fps=${FPS},format=yuv420p,setpts=PTS-STARTPTS[v${i}]`);
  }
  let last = 'v0';
  for (let i = 1; i < N; i++) {
    const out = i === N - 1 ? 'vout' : `x${i}`;
    parts.push(`[${last}][v${i}]xfade=transition=fade:duration=${T}:offset=${offsets[i].toFixed(3)}[${out}]`);
    last = out;
  }

  const maps = ['-map', `[${last}]`];
  let haveAudio = false;
  const afade = (label: string) => `${label}atrim=0:${total.toFixed(3)},afade=t=out:st=${Math.max(0, total - 2).toFixed(3)}:d=2[a]`;

  if (keepVideoAudio) {
    // Place each clip's own audio at its timeline offset, then mix them (under the backing track,
    // if one is selected). Clips without an audio track are simply skipped.
    const mixIns: string[] = [];
    items.forEach((it, i) => {
      if (it.isVideo && it.hasAudio) {
        const ms = Math.max(0, Math.round(offsets[i] * 1000));
        parts.push(`[${i}:a]aresample=async=1,adelay=${ms}:all=1[ca${i}]`);
        mixIns.push(`[ca${i}]`);
      }
    });
    if (music) { parts.push(`[${musicIdx}:a]aresample=async=1,volume=0.35[bgm]`); mixIns.push('[bgm]'); }
    if (mixIns.length) {
      parts.push(`${mixIns.join('')}amix=inputs=${mixIns.length}:duration=longest:dropout_transition=0[amx]`);
      parts.push(afade('[amx]'));
      maps.push('-map', '[a]'); haveAudio = true;
    }
  } else if (music) {
    parts.push(afade(`[${musicIdx}:a]`));
    maps.push('-map', '[a]'); haveAudio = true;
  }

  const filter = parts.join(';');
  args.push('-filter_complex_threads', String(NCPU), '-filter_complex', filter, ...maps,
    '-c:v', 'libx264', '-threads', '0', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-preset', 'veryfast', '-crf', String(crf));
  if (haveAudio) args.push('-c:a', 'aac', '-b:a', '160k');
  args.push('-movflags', '+faststart', '-y', outPath);
  return args;
}

function runFfmpeg(args: string[], onProgress?: (seconds: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args);
    let err = '';
    // Hard cap on encode time so a pathological input can't pin a CPU forever.
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } reject(new Error('ffmpeg timed out')); }, 5 * 60_000);
    p.stderr.on('data', (d) => { err = (err + d.toString()).slice(-4000); });
    // `-progress pipe:1` writes key=value lines to stdout; out_time_us is the encoded position.
    if (onProgress) {
      let buf = '';
      p.stdout.on('data', (d) => {
        buf = (buf + d.toString()).slice(-2000);
        const m = [...buf.matchAll(/out_time_us=(\d+)/g)].pop();
        if (m) onProgress(parseInt(m[1], 10) / 1_000_000);
      });
    }
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`)); });
  });
}
