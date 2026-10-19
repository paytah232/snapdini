#!/usr/bin/env node
/** Deploy only public event metadata, independently of camera releases. No KV or billing APIs. */
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, readdir, lstat, writeFile, rename, rm, copyFile } from 'node:fs/promises';
import { publicCameraEvent, SOURCE_RECEIPT, snapshotRevision } from './publish.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);
export const WRANGLER_VERSION = '4.151.1';
const DAY = 86400000;
const NAME = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\.json$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const integer = (raw, fallback, min, max) => {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid edge publication budget');
  return value;
};
export function configuration(env) {
  const lane = env.GUEST_RECOVERY_ENV;
  if (!['dev', 'production'].includes(lane)) throw new Error('Explicit dev or production recovery lane required');
  const workerName = env.GUEST_EDGE_WORKER_NAME;
  const expectedWorker = lane === 'dev' ? 'snapdini-guest-events-dev' : 'snapdini-guest-events';
  if (workerName !== expectedWorker)
    throw new Error('An explicit event-only Worker name matching the lane is required');
  if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '')) throw new Error('Explicit Cloudflare account required');
  for (const key of ['OUTPUT_DIR', 'GUEST_EDGE_STATE_DIR', 'GUEST_EDGE_TOKEN_FILE', 'GUEST_EDGE_WRANGLER_PACKAGE'])
    if (!path.isAbsolute(env[key] ?? '')) throw new Error(`${key} must be an absolute private/runtime path`);
  const snapshotDir = path.resolve(env.OUTPUT_DIR);
  const stateDir = path.resolve(env.GUEST_EDGE_STATE_DIR);
  const tokenFile = path.resolve(env.GUEST_EDGE_TOKEN_FILE);
  if (tokenFile === snapshotDir || tokenFile.startsWith(snapshotDir + path.sep)
      || tokenFile.startsWith(path.join(stateDir, 'artifact') + path.sep))
    throw new Error('Credentials must remain outside public deployment artifacts');
  if (stateDir === snapshotDir || stateDir.startsWith(snapshotDir + path.sep)) throw new Error('Private edge state must be outside public snapshots');
  return { lane, workerName, accountId: env.CLOUDFLARE_ACCOUNT_ID, snapshotDir, stateDir,
    tokenFile: env.GUEST_EDGE_TOKEN_FILE, wranglerPackage: env.GUEST_EDGE_WRANGLER_PACKAGE,
    minIntervalMs: integer(env.GUEST_EDGE_MIN_INTERVAL_SECONDS, 60, 60, 3600) * 1000,
    maxDailyAttempts: integer(env.GUEST_EDGE_MAX_DAILY_ATTEMPTS, 96, 1, 500) };
}
async function readJSON(filename, fallback) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Invalid private edge state'); }
}
async function atomicJSON(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
}
export async function collectSnapshots(snapshotDir) {
  const receiptFile = path.join(snapshotDir, SOURCE_RECEIPT);
  const receipt = await readJSON(receiptFile, null);
  if (receipt?.schema !== 1 || receipt.complete !== true) throw new Error('Public snapshot source is incomplete');
  const rawEntries = [];
  const files = {};
  for (const entry of (await readdir(snapshotDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === SOURCE_RECEIPT || entry.name.startsWith('.') && entry.name.endsWith('.tmp')) continue;
    if (!entry.isFile() || !NAME.test(entry.name)) throw new Error('Unexpected snapshot entry');
    const filename = path.join(snapshotDir, entry.name);
    if ((await lstat(filename)).size > 65536) throw new Error('Snapshot exceeds public metadata size limit');
    const raw = await readFile(filename);
    rawEntries.push([entry.name, hash(raw)]);
    const source = JSON.parse(raw.toString('utf8'));
    if (source.schema !== 1 || !Number.isSafeInteger(source.publishedAt) || source.publishedAt < 0)
      throw new Error('Invalid snapshot publication');
    const event = publicCameraEvent(source.event);
    if (![`${event.joinCode}.json`, `${event.slug}.json`].includes(entry.name)) throw new Error('Snapshot identity mismatch');
    files[entry.name] = { schema: 1, publishedAt: source.publishedAt, event };
  }
  if (receipt.files !== rawEntries.length || receipt.revision !== snapshotRevision(rawEntries)
      || JSON.stringify(await readJSON(receiptFile, null)) !== JSON.stringify(receipt))
    throw new Error('Public snapshot generation is incomplete or changed during collection');
  if (Object.keys(files).length > 18000) throw new Error('Too many public snapshots');
  return files;
}
export function planPublication(files, previous, now) {
  const records = {};
  const publicFiles = { ...files };
  for (const [name, snapshot] of Object.entries(files)) {
    records[name] = { expiresAt: snapshot.event.expiresAt };
  }
  for (const [name, record] of Object.entries(previous.records ?? {})) {
    if (!NAME.test(name) || files[name]) continue;
    const withdrawnAt = record.withdrawnAt ?? now;
    const retainUntil = record.retainUntil ?? Math.max(now + 30 * DAY, (record.expiresAt ?? now) + DAY);
    if (retainUntil <= now) continue;
    records[name] = { withdrawnAt, retainUntil };
    publicFiles[name] = { schema: 1, publishedAt: withdrawnAt, identifier: name.slice(0, -5), withdrawn: true };
  }
  const names = Object.keys(publicFiles).sort();
  if (names.length > 18000) throw new Error('Too many snapshots and withdrawal records');
  const content = Object.fromEntries(names.map(name => [name, JSON.stringify(publicFiles[name]) + '\n']));
  if (Object.values(content).reduce((sum, body) => sum + Buffer.byteLength(body), 0) > 16 * 1024 * 1024)
    throw new Error('Public metadata deployment exceeds size limit');
  const revision = hash(JSON.stringify(content));
  return { content, revision, records };
}
export async function prepareArtifact(config, plan, now) {
  const artifact = path.join(config.stateDir, 'artifact');
  await rm(artifact, { recursive: true, force: true });
  const eventsDir = path.join(artifact, 'public', 'guest', 'events');
  await mkdir(eventsDir, { recursive: true, mode: 0o700 });
  for (const [name, body] of Object.entries(plan.content)) await writeFile(path.join(eventsDir, name), body, { mode: 0o600 });
  await writeFile(path.join(artifact, 'public', 'guest', 'publication.json'), JSON.stringify({
    schema: 1, revision: plan.revision, publishedAt: now,
  }) + '\n', { mode: 0o600 });
  await copyFile(path.join(here, 'events-worker.mjs'), path.join(artifact, 'events-worker.mjs'));
  const worker = { name: config.workerName, account_id: config.accountId,
    main: './events-worker.mjs', compatibility_date: '2026-10-16', workers_dev: false, preview_urls: false,
    routes: [], assets: { directory: './public', binding: 'ASSETS', html_handling: 'none',
      not_found_handling: 'none', run_worker_first: ['/guest/events/*', '/guest/publication.json'] },
    vars: { DEPLOYMENT_LANE: config.lane } };
  await writeFile(path.join(artifact, 'wrangler.json'), JSON.stringify(worker, null, 2) + '\n', { mode: 0o600 });
  return artifact;
}
export async function deployArtifact(config, artifact) {
  const tokenStat = await lstat(config.tokenFile);
  if (!tokenStat.isFile() || (tokenStat.mode & 0o077) !== 0) throw new Error('Cloudflare token must be a private regular file');
  const token = (await readFile(config.tokenFile, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw new Error('Invalid Cloudflare token file');
  const pkg = JSON.parse(await readFile(path.join(config.wranglerPackage, 'package.json'), 'utf8'));
  if (pkg.name !== 'wrangler' || pkg.version !== WRANGLER_VERSION) throw new Error(`Wrangler ${WRANGLER_VERSION} is required`);
  try {
    await execute(process.execPath, [path.join(config.wranglerPackage, 'bin', 'wrangler.js'), 'deploy',
      '--config', path.join(artifact, 'wrangler.json'), '--keep-vars'], {
      cwd: artifact, timeout: 120000, maxBuffer: 1024 * 1024, shell: false,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', WRANGLER_SEND_METRICS: 'false',
        CLOUDFLARE_ACCOUNT_ID: config.accountId, CLOUDFLARE_API_TOKEN: token },
    });
  } catch { throw new Error('Authenticated event snapshot deployment failed'); }
}
export async function publishEdgeOnce(config, { now = Date.now, deploy = deployArtifact } = {}) {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const lock = path.join(config.stateDir, 'publication.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readJSON(path.join(lock, 'owner.json'), null);
    // Recover a dead process after a terminated container/host restart. A live owner is never
    // displaced. Run one publisher per target/state directory, including during restarts.
    if (owner && Number.isInteger(owner.pid)) {
      let alive = true;
      try { process.kill(owner.pid, 0); }
      catch (signalError) { if (signalError.code === 'ESRCH') alive = false; }
      const processStartedAt = Date.now() - process.uptime() * 1000;
      if (!alive || owner.pid === process.pid && owner.startedAt < processStartedAt - 1000) {
        await rm(lock, { recursive: true, force: true });
        return publishEdgeOnce(config, { now, deploy });
      }
    }
    return { status: 'locked' };
  }
  try {
    await atomicJSON(path.join(lock, 'owner.json'), { pid: process.pid, startedAt: Date.now() });
    const time = now();
    const filename = path.join(config.stateDir, 'state.json');
    const previous = await readJSON(filename, { schema: 1, records: {} });
    const target = `${config.accountId}/${config.workerName}/${config.lane}`;
    if (previous.target && previous.target !== target) throw new Error('Private state belongs to another publication target');
    const files = await collectSnapshots(config.snapshotDir);
    const plan = planPublication(files, previous, time);
    if (plan.revision === previous.revision) return { status: 'unchanged', revision: plan.revision };
    if (time < (previous.nextAttemptAt ?? 0)) return { status: 'coalesced' };
    const day = new Date(time).toISOString().slice(0, 10);
    const attempts = previous.day === day ? previous.attempts ?? 0 : 0;
    if (attempts >= config.maxDailyAttempts) return { status: 'daily-budget' };
    const state = { ...previous, schema: 1, target, day, attempts: attempts + 1,
      nextAttemptAt: time + config.minIntervalMs };
    // Record attempts before network writes, so failures and restarts cannot bypass the budget.
    await atomicJSON(filename, state);
    const artifact = await prepareArtifact(config, plan, time);
    try { await deploy(config, artifact); }
    catch (error) {
      state.failures = (state.failures ?? 0) + 1;
      state.nextAttemptAt = time + Math.min(3600000, config.minIntervalMs * 2 ** Math.min(state.failures, 6));
      await atomicJSON(filename, state);
      throw error;
    }
    await atomicJSON(filename, { ...state, revision: plan.revision, records: plan.records,
      failures: 0, lastSuccessAt: time });
    return { status: 'published', revision: plan.revision, files: Object.keys(plan.content).length };
  } finally { await rm(lock, { recursive: true, force: true }); }
}
export function createEdgePublisher(env) {
  const config = configuration(env);
  return () => publishEdgeOnce(config);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = configuration(process.env);
  const prepareOnly = process.argv.includes('--prepare-only');
  const result = prepareOnly ? (async () => {
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    const previous = await readJSON(path.join(config.stateDir, 'state.json'), { records: {} });
    const now = Date.now();
    const plan = planPublication(await collectSnapshots(config.snapshotDir), previous, now);
    const artifact = await prepareArtifact(config, plan, now);
    return { status: 'prepared', artifact, revision: plan.revision, files: Object.keys(plan.content).length };
  })() : publishEdgeOnce(config);
  result.then(value => console.log(JSON.stringify(value))).catch(error => {
    // Do not expose child-process output, headers, account secrets or snapshot bodies.
    console.error(`Event snapshot publication failed (${error.code ?? error.name})`);
    process.exitCode = 1;
  });
}
