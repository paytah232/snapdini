#!/usr/bin/env node
/** Build a reviewable release artifact; deploy only with an explicit --deploy. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepare } from './prepare.mjs';

export async function verifyOrigin(origin, expectedVersion, fetchOrigin = fetch) {
  const response = await fetchOrigin(new URL('/api/config', origin), {
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Origin health check HTTP ${response.status}`);
  const config = await response.json();
  if (config.version !== expectedVersion || config.readOnly !== false)
    throw new Error('Origin must be healthy, writable and on the matching release');
}

export async function promote(env = process.env, deploy = false) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const web = JSON.parse(await readFile(path.join(root, 'web/package.json'), 'utf8'));
  const app = JSON.parse(await readFile(path.join(root, 'app/package.json'), 'utf8'));
  if (web.version !== app.version) throw new Error('Application and camera versions do not match');
  if (env.EXPECTED_VERSION !== web.version) throw new Error('Explicit EXPECTED_VERSION must match source');
  const options = { accountId: env.CLOUDFLARE_ACCOUNT_ID, origin: env.APP_ORIGIN,
    lane: env.DEPLOYMENT_LANE, eventsWorker: env.GUEST_EVENTS_WORKER, canaryCode: env.GUEST_CANARY_CODE,
    guestDir: env.GUEST_ASSET_DIR, snapshotDir: env.GUEST_SNAPSHOT_DIR };
  // Verify the built camera version too: a forgotten build must never promote stale assets.
  const guest = options.guestDir ?? path.join(root, 'web/guest-dist');
  const manifest = JSON.parse(await readFile(path.join(guest, 'release.json'), 'utf8'));
  if (manifest.version !== web.version) throw new Error('Rebuild the guest camera for this release');
  await verifyOrigin(options.origin, web.version);
  const result = await prepare(options);
  if (deploy) {
    if (!env.CLOUDFLARE_API_TOKEN) throw new Error('Deployment token is required');
    // Recheck immediately before the external mutation. No shell interpolation or secret logs.
    await verifyOrigin(options.origin, web.version);
    await new Promise((resolve, reject) => {
      const child = spawn('npx', ['--yes', 'wrangler@4.151.1', 'deploy', '--config',
        path.join(result.artifact, 'wrangler.json')], { cwd: result.artifact,
        env: { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }, stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('Guest deployment failed')));
    });
  }
  return { ...result, version: web.version, deployed: deploy };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  promote(process.env, process.argv.includes('--deploy')).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
