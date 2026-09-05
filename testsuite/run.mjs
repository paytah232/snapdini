// Snapdini integration suite — orchestrator.
//
// Drives the real API end-to-end across event settings, reveal/ending logic, sharing/downloads,
// moderation, rating modes, timezones, limits and lifecycle, and validates the resulting Postgres
// state directly. Run against a live stack.
//
//   node testsuite/run.mjs [baseURL]            # default http://localhost:3001
//   node testsuite/run.mjs --jobs=8             # parallelism (default 4)
//   node testsuite/run.mjs --serial             # jobs=1
//   node testsuite/run.mjs --only=cohost        # run only specs whose filename contains this
//   node testsuite/run.mjs --list               # list the discovered specs and exit
//
// Billing is assumed OFF (self-host) so caps don't interfere — that path is covered
// separately. Each spec cleans up everything it creates (test user + events + upload files).
//
// LAYOUT
//   testsuite/lib/harness.mjs   shared helpers + the per-spec bootstrap/cleanup/result plumbing
//   testsuite/specs/NN-name.mjs one area each; run as `node <spec> <baseURL>` child processes
//
// Each spec prints its own `## group` headers and, as its LAST line of stdout, a machine-readable
//   ##RESULT {"spec":"…","pass":N,"fail":N,"fails":[…]}
// which this file parses. A spec's output is buffered and printed as one contiguous block so
// parallel runs stay readable. A spec that exits non-zero, times out, or prints no ##RESULT is
// reported as a failure.
//
// SERIAL SPECS — CONVENTION: a spec file whose name starts with `9` (the `9x-` prefix) mutates or
// reads GLOBAL database state and must not run alongside anything that creates events:
//   90-retention-purge          POST /api/admin/run-sweep purges every eligible event in the DB
//   92-reschedule               also calls run-sweep
//   91-auth-cooldown-admin      compares /api/admin/overview counts to a live SELECT count(*)
// All non-`9x-` specs run first in the concurrency pool; the `9x-` ones then run one at a time.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));

const BASE = (positional[0] || 'http://localhost:3001').replace(/\/$/, '');
const flag = (name) => flags.find((f) => f === `--${name}` || f.startsWith(`--${name}=`));
const flagValue = (name) => { const f = flag(name); return f && f.includes('=') ? f.slice(f.indexOf('=') + 1) : undefined; };

const SPEC_TIMEOUT_MS = 180_000;
const SPECS_DIR = path.join(import.meta.dirname, 'specs');
const isSerial = (file) => path.basename(file).startsWith('9');

let jobs = Number(flagValue('jobs') || 4);
if (flag('serial')) jobs = 1;
if (!Number.isFinite(jobs) || jobs < 1) jobs = 1;

const only = flagValue('only');
let specs = fs.readdirSync(SPECS_DIR).filter((f) => f.endsWith('.mjs')).sort();
if (only) specs = specs.filter((f) => f.includes(only));

if (flag('list')) {
  for (const s of specs) console.log(`${s}${isSerial(s) ? '  (serial)' : ''}`);
  process.exit(0);
}
if (!specs.length) {
  console.error(only ? `No specs match --only=${only}` : `No specs found in ${SPECS_DIR}`);
  process.exit(1);
}

// Several specs guard their operator-only assertions behind ADMIN_EMAIL/ADMIN_PASSWORD and skip
// when they're absent. Skipping quietly is worse than failing: the operator endpoints looked
// covered while nothing ran. If the vars aren't set, lift them off the container under test so
// those branches execute by default. Local dev container only — never a remote or prod target.
function adoptAdminCreds() {
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) return 'env';
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE)) return 'skipped (non-local target)';
  const container = process.env.TEST_APP_CONTAINER || 'snapdini-dev-app';
  try {
    const read = (k) => spawnSync('docker', ['exec', container, 'printenv', k], { encoding: 'utf8' }).stdout.trim();
    const email = read('ADMIN_EMAIL'), password = read('ADMIN_PASSWORD');
    if (!email || !password) return `unavailable (${container} has no admin creds)`;
    process.env.ADMIN_EMAIL = email; process.env.ADMIN_PASSWORD = password;
    return `adopted from ${container}`;
  } catch { return 'unavailable (docker not reachable)'; }
}
const adminCredSource = adoptAdminCreds();
console.log(`# operator credentials: ${adminCredSource}`);

let pass = 0, fail = 0;
const fails = [];
let broken = 0;

function runSpec(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(SPECS_DIR, file), BASE], {
      env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, SPEC_TIMEOUT_MS);
    child.on('error', (e) => { err += `\nspawn error: ${e.message}`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ file, code, out, err, timedOut, ms: Date.now() - started });
    });
  });
}

function report(r) {
  const lines = r.out.split('\n');
  const ri = lines.findLastIndex((l) => l.startsWith('##RESULT '));
  const result = ri >= 0 ? (() => { try { return JSON.parse(lines[ri].slice('##RESULT '.length)); } catch { return null; } })() : null;

  // Buffered block, printed contiguously so interleaved parallel output stays readable.
  const body = (ri >= 0 ? lines.slice(0, ri) : lines).join('\n').replace(/\n+$/, '');
  console.log(`\n┌─ ${r.file}  (${(r.ms / 1000).toFixed(1)}s)`);
  if (body.trim()) console.log(body);
  if (r.err.trim()) console.log(r.err.replace(/\n+$/, ''));

  if (!result) {
    broken++;
    const why = r.timedOut ? `timed out after ${SPEC_TIMEOUT_MS / 1000}s` : `exited ${r.code} with no ##RESULT line`;
    fails.push(`${r.file} — ${why}`);
    console.log(`  ✗ ${r.file} — ${why}`);
    return;
  }
  pass += result.pass;
  fail += result.fail;
  for (const f of result.fails) fails.push(`[${r.file}] ${f}`);
  if (r.timedOut || (r.code !== 0 && result.fail === 0)) {
    broken++;
    const why = r.timedOut ? `timed out after ${SPEC_TIMEOUT_MS / 1000}s` : `exited ${r.code} despite reporting no failures`;
    fails.push(`${r.file} — ${why}`);
    console.log(`  ✗ ${r.file} — ${why}`);
  }
}

async function pool(files, limit) {
  let next = 0;
  const done = [];
  const worker = async () => {
    while (next < files.length) {
      const r = await runSpec(files[next++]);
      done.push(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, files.length) }, worker));
  // Print in filename order so the transcript is stable regardless of finish order.
  done.sort((a, b) => files.indexOf(a.file) - files.indexOf(b.file));
  for (const r of done) report(r);
}

const t0 = Date.now();
console.log(`# Snapdini integration suite → ${BASE}`);
console.log(`# ${specs.length} spec(s), ${jobs} job(s)`);

await pool(specs.filter((s) => !isSerial(s)), jobs);
for (const s of specs.filter(isSerial)) report(await runSpec(s));

console.log(`\n${'═'.repeat(48)}\n${fail === 0 && broken === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed`);
if (fails.length) console.log('Failures:\n - ' + fails.join('\n - '));
console.log(`\n[${((Date.now() - t0) / 1000).toFixed(1)}s total]`);
process.exit(fail || broken ? 1 : 0);
