// Snapdini load test — simulates a busy event: many guests joining, uploading photos,
// browsing the gallery, the server serving media, and a bulk zip download. Measures
// latency (avg/p50/p95/max) + throughput per operation, then estimates server capacity.
//
// Usage:  node run.mjs [baseURL] [concurrency] [opsPerStage] [sampleImg]
//   node run.mjs http://localhost:3001 25 100
//
// Notes: hits the public demo + participant/photo/gallery endpoints (no auth needed).
// Billing is assumed OFF (self-host) so guest caps don't block; if on, raise the cap.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.argv[2] || 'http://localhost:3001').replace(/\/$/, '');
const CONC = parseInt(process.argv[3] || '25', 10);
const OPS = parseInt(process.argv[4] || '100', 10);
const SAMPLE = process.argv[5] || path.join(import.meta.dirname, 'sample.jpg');

function fmt(ms) { return `${ms.toFixed(1)}ms`; }
function stats(ts) {
  if (!ts.length) return null;
  const s = [...ts].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { n: s.length, avg: sum / s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] };
}
async function timed(fn) { const t = performance.now(); const r = await fn(); return [performance.now() - t, r]; }
async function pool(count, conc, worker) {
  let i = 0; const out = [];
  const run = async () => { while (i < count) { const idx = i++; try { out[idx] = await worker(idx); } catch (e) { out[idx] = { error: String(e) }; } } };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: conc }, run));
  return { wall: performance.now() - t0, out };
}
function line(label, st, wallMs) {
  if (!st) return `${label.padEnd(16)} (no samples)`;
  const tput = st.n / (wallMs / 1000);
  return `${label.padEnd(16)} n=${String(st.n).padStart(4)}  avg=${fmt(st.avg).padStart(8)}  p50=${fmt(st.p50).padStart(8)}  p95=${fmt(st.p95).padStart(8)}  max=${fmt(st.max).padStart(9)}  ${tput.toFixed(1)}/s`;
}

const img = fs.readFileSync(SAMPLE);
const report = [];
const log = (s) => { console.log(s); report.push(s); };

log(`# Snapdini load test\nTarget: ${BASE}  ·  concurrency: ${CONC}  ·  ops/stage: ${OPS}  ·  sample: ${(img.length / 1024).toFixed(0)}KB`);
log(`Host: ${os.cpus().length} vCPU · ${(os.totalmem() / 1e9).toFixed(1)}GB RAM\n`);

// Create a demo event to target.
const demo = await (await fetch(`${BASE}/api/events/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
const code = demo.joinCode;
log(`Demo event: ${code}\n`);

// 1) Joins
const joinTokens = [];
const joinTimes = [];
const join = await pool(OPS, CONC, async (i) => {
  const [t, r] = await timed(() => fetch(`${BASE}/api/participants`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ joinCode: code, name: `load_${i}` }),
  }).then((res) => res.json()));
  joinTimes.push(t);
  if (r?.sessionToken) joinTokens.push(r.sessionToken);
  return r;
});
log(line('join', stats(joinTimes), join.wall));

// 2) Uploads (one per joined guest)
const upTimes = [];
const up = await pool(joinTokens.length, Math.min(CONC, joinTokens.length || 1), async (i) => {
  const fd = new FormData();
  fd.append('sessionToken', joinTokens[i]);
  fd.append('photo', new Blob([img], { type: 'image/jpeg' }), 'shot.jpg');
  const [t, res] = await timed(() => fetch(`${BASE}/api/photos`, { method: 'POST', body: fd }));
  upTimes.push(t);
  return res.status;
});
log(line('upload', stats(upTimes), up.wall));

// 3) Gallery reads (organizer demo is instant-reveal → photos visible)
const readTimes = [];
const read = await pool(OPS, CONC, async () => {
  const [t] = await timed(() => fetch(`${BASE}/api/photos/${code}?gallery=true`).then((r) => r.text()));
  readTimes.push(t);
});
log(line('gallery-read', stats(readTimes), read.wall));

// 4) Static media serve
const gal = await (await fetch(`${BASE}/api/photos/${code}?gallery=true`)).json();
const serveTimes = [];
if (gal.photos?.length) {
  const u = gal.photos[0].url;
  const serve = await pool(OPS, CONC, async () => {
    const [t] = await timed(() => fetch(`${BASE}${u}`).then((r) => r.arrayBuffer()));
    serveTimes.push(t);
  });
  log(line('media-serve', stats(serveTimes), serve.wall));
}

// 5) Zip download (heavier; lower concurrency)
const dlTimes = [];
const dl = await pool(Math.min(OPS, 20), Math.min(CONC, 5), async () => {
  const [t] = await timed(() => fetch(`${BASE}/api/photos/${code}/download`).then((r) => r.arrayBuffer()));
  dlTimes.push(t);
});
log(line('zip-download', stats(dlTimes), dl.wall));

// Capacity estimate (very rough): from upload throughput, extrapolate.
const upStat = stats(upTimes);
if (upStat) {
  const upTput = upStat.n / (up.wall / 1000);
  log(`\n## Rough capacity (this ${os.cpus().length}-vCPU host)`);
  log(`- Sustained uploads: ~${upTput.toFixed(1)}/s (each = re-encode + thumbnail via sharp — CPU-bound).`);
  log(`- A typical event peaks at a few uploads/sec; ~${Math.max(1, Math.floor(upTput / 2))} busy events could run concurrently before uploads queue.`);
  log(`- Reads/serves are far cheaper (see above) and scale with RAM/IO + the 1y immutable cache.`);
  log(`- Scaling lever: uploads. Add vCPU (sharp is CPU-bound) before RAM. Move media to the ZFS pool (done) to keep IO off the system disk.`);
}

fs.writeFileSync(path.join(import.meta.dirname, 'RESULTS.md'), report.join('\n') + '\n');
console.log('\nWrote RESULTS.md');
