// Snapdini MULTI-EVENT stress test — simulates several events running at once, each with
// many guests joining + uploading simultaneously. Answers "how many concurrent live events
// can this self-hosted box take?" by driving real demo events through join → upload → read
// and reporting aggregate throughput, latency, error rate, and a capacity estimate.
//
// Usage:  node multi.mjs [baseURL] [events] [guestsPerEvent] [shotsPerGuest] [concurrency] [sampleImg]
//   node multi.mjs http://localhost:3001 5 10 3 32
//
// Note: demo events are entitled to 25 guests, so keep guestsPerEvent ≤ 25.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE   = (process.argv[2] || 'http://localhost:3001').replace(/\/$/, '');
const EVENTS = parseInt(process.argv[3] || '5', 10);
const GUESTS = parseInt(process.argv[4] || '10', 10);
const SHOTS  = parseInt(process.argv[5] || '3', 10);
const CONC   = parseInt(process.argv[6] || '32', 10);
const SAMPLE = process.argv[7] || path.join(import.meta.dirname, 'sample.jpg');

function fmt(ms) { return `${ms.toFixed(1)}ms`; }
function stats(ts) {
  if (!ts.length) return null;
  const s = [...ts].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { n: s.length, avg: sum / s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] };
}
async function timed(fn) { const t = performance.now(); const r = await fn(); return [performance.now() - t, r]; }
// Run `tasks` (array of thunks) with a fixed concurrency cap; returns wall time.
async function pool(tasks, conc) {
  let i = 0;
  const run = async () => { while (i < tasks.length) { const idx = i++; try { await tasks[idx](); } catch { /* counted by caller */ } } };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: Math.min(conc, tasks.length || 1) }, run));
  return performance.now() - t0;
}
function line(label, st, wallMs) {
  if (!st) return `${label.padEnd(16)} (no samples)`;
  const tput = st.n / (wallMs / 1000);
  return `${label.padEnd(16)} n=${String(st.n).padStart(5)}  avg=${fmt(st.avg).padStart(8)}  p50=${fmt(st.p50).padStart(8)}  p95=${fmt(st.p95).padStart(8)}  max=${fmt(st.max).padStart(9)}  ${tput.toFixed(1)}/s`;
}

const img = fs.readFileSync(SAMPLE);
const report = [];
const log = (s) => { console.log(s); report.push(s); };

log(`# Snapdini multi-event stress test`);
log(`Target: ${BASE}  ·  ${EVENTS} events × ${GUESTS} guests × ${SHOTS} shots  ·  concurrency: ${CONC}  ·  sample: ${(img.length / 1024).toFixed(0)}KB`);
log(`Host: ${os.cpus().length} vCPU · ${(os.totalmem() / 1e9).toFixed(1)}GB RAM\n`);

// ── Spin up N events ──
const codes = [];
for (let e = 0; e < EVENTS; e++) {
  const r = await (await fetch(`${BASE}/api/events/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  if (r?.joinCode) codes.push(r.joinCode);
}
log(`Created ${codes.length}/${EVENTS} events: ${codes.join(', ')}\n`);

// ── Phase 1: all guests across all events join (interleaved, capped concurrency) ──
const tokens = new Map(); // code -> [sessionToken,...]
codes.forEach((c) => tokens.set(c, []));
let joinErr = 0;
const joinTimes = [];
const joinTasks = [];
for (const code of codes) {
  for (let g = 0; g < GUESTS; g++) {
    joinTasks.push(async () => {
      const [t, r] = await timed(() => fetch(`${BASE}/api/participants`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ joinCode: code, name: `g${g}` }),
      }).then((res) => res.json()).catch(() => null));
      joinTimes.push(t);
      if (r?.sessionToken) tokens.get(code).push(r.sessionToken); else joinErr++;
    });
  }
}
const joinWall = await pool(joinTasks, CONC);
log(line('join', stats(joinTimes), joinWall) + `  errors=${joinErr}`);

// ── Phase 2: every guest uploads SHOTS photos, all events at once (the real stress) ──
let upErr = 0, upOk = 0;
const upTimes = [];
const upTasks = [];
for (const code of codes) {
  for (const token of tokens.get(code)) {
    for (let s = 0; s < SHOTS; s++) {
      upTasks.push(async () => {
        const fd = new FormData();
        fd.append('sessionToken', token);
        fd.append('photo', new Blob([img], { type: 'image/jpeg' }), 'shot.jpg');
        const [t, res] = await timed(() => fetch(`${BASE}/api/photos`, { method: 'POST', body: fd }).catch(() => null));
        upTimes.push(t);
        if (res && res.ok) upOk++; else upErr++;
      });
    }
  }
}
const upWall = await pool(upTasks, CONC);
log(line('upload', stats(upTimes), upWall) + `  ok=${upOk} errors=${upErr}`);

// ── Phase 3: gallery reads across all events (3 per event, concurrent) ──
let readErr = 0;
const readTimes = [];
const readTasks = [];
for (const code of codes) {
  for (let k = 0; k < 3; k++) {
    readTasks.push(async () => {
      const [t, res] = await timed(() => fetch(`${BASE}/api/photos/${code}?gallery=true`).catch(() => null));
      readTimes.push(t);
      if (!res || !res.ok) readErr++;
    });
  }
}
const readWall = await pool(readTasks, CONC);
log(line('gallery-read', stats(readTimes), readWall) + `  errors=${readErr}`);

// ── Aggregate + capacity estimate ──
const upStat = stats(upTimes);
const upTput = upStat ? upStat.n / (upWall / 1000) : 0;
const totalUploads = upOk;
log(`\n## Result`);
log(`- ${codes.length} concurrent events · ${joinTimes.length} guest-joins · ${totalUploads} photos uploaded.`);
log(`- Aggregate upload throughput: **${upTput.toFixed(1)} photos/s** across all events (p95 ${upStat ? fmt(upStat.p95) : 'n/a'}).`);
log(`- Upload error rate: ${upTimes.length ? ((upErr / upTimes.length) * 100).toFixed(1) : '0'}%  (joins ${joinErr}, reads ${readErr}).`);

log(`\n## Rough capacity (this ${os.cpus().length}-vCPU host)`);
if (upTput > 0) {
  // A "busy" event peaks at ~1 upload/sec/event during a lively moment; sustained is lower.
  const PEAK_PER_EVENT = 1;
  const safe = Math.max(1, Math.floor((upTput / PEAK_PER_EVENT) * 0.7)); // 70% headroom
  log(`- Uploads are the bottleneck (sharp re-encode + thumbnail, CPU-bound).`);
  log(`- At ~${PEAK_PER_EVENT} upload/s per busy event, this box sustains roughly **${safe} simultaneously-busy events** before uploads start queuing.`);
  log(`- Far more events can exist concurrently if they're not all uploading at the same instant (the realistic case).`);
  log(`- Scaling lever: add vCPU first (CPU-bound), cap concurrent sharp jobs if needed, keep media on the ZFS pool. Reads/serves stay cheap.`);
} else {
  log(`- No successful uploads — check that the stack is up and billing caps aren't blocking joins (demo cap = 25/event).`);
}

fs.writeFileSync(path.join(import.meta.dirname, 'RESULTS-multi.md'), report.join('\n') + '\n');
console.log('\nWrote RESULTS-multi.md');
