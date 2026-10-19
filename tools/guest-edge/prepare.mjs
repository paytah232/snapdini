#!/usr/bin/env node
/** Produce a private, reviewable artifact. Does not install Wrangler or call Cloudflare. */
import { mkdir, mkdtemp, readdir, readFile, writeFile, copyFile, lstat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appOrigin } from './worker.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const FILE_TYPES = new Set(['.html', '.js', '.css', '.svg', '.woff2', '.json']);
const SNAPSHOT_NAME = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\.json$/;

async function copyGuest(source, destination) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) throw new Error('Unexpected guest artifact entry');
    if (entry.isDirectory()) {
      if (!['assets', 'fonts'].includes(entry.name)) throw new Error('Unexpected guest artifact directory');
      await mkdir(to);
      await copyGuest(from, to);
    } else {
      if (!entry.isFile() || !FILE_TYPES.has(path.extname(entry.name))
          || (path.extname(entry.name) === '.json' && entry.name !== 'release.json'))
        throw new Error('Unexpected guest artifact file type');
      if (entry.name === 'release.json') {
        const release = JSON.parse(await readFile(from, 'utf8'));
        if (!/^\d+\.\d+\.\d+$/.test(release.version) || !/^[a-f0-9]{16}$/.test(release.fingerprint))
          throw new Error('Invalid guest release manifest');
        await writeFile(to, JSON.stringify({ version: release.version, fingerprint: release.fingerprint }));
      } else await copyFile(from, to);
    }
  }
}

export async function prepare({ accountId, origin, lane, guestDir = path.join(root, 'web/guest-dist'),
  eventsWorker, canaryCode, snapshotDir = path.join(root, 'app/data/guest-recovery'), tempRoot = os.tmpdir() }) {
  const validatedOrigin = appOrigin(origin, lane);
  if (canaryCode && (lane !== 'production' || !/^[A-Z0-9]{8}$/.test(canaryCode)))
    throw new Error('Canary requires a valid production event code');
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? '')) throw new Error('An explicit Cloudflare account ID is required');
  // Validate required inputs before creating a destination. No origin fallback or snapshot fetch.
  if (!(await lstat(guestDir)).isDirectory() || (!eventsWorker && !(await lstat(snapshotDir)).isDirectory()))
    throw new Error('Expected guest artifact and snapshot directories');
  const artifact = await mkdtemp(path.join(tempRoot, 'snapdini-guest-dev-'));
  try {
    const publicDir = path.join(artifact, 'public');
    const guest = path.join(publicDir, 'guest');
    await mkdir(guest, { recursive: true });
    await copyGuest(guestDir, guest);
    await readFile(path.join(guest, 'index.html')); // A partial build cannot be deployed.
    // Cloudflare's redirect validator can reject rewrites to index.html as loops
    // even with html_handling:none. An extensionless HTML alias avoids that check.
    await copyFile(path.join(guest, 'index.html'), path.join(guest, 'shell'));
    await mkdir(path.join(guest, 'events'));
    let snapshots = 0;
    const { publicCameraEvent } = await import('../guest-recovery/publish.mjs');
    for (const entry of eventsWorker ? [] : await readdir(snapshotDir, { withFileTypes: true })) {
      if (entry.name === '.publication-complete.json' && entry.isFile()) continue;
      if (!SNAPSHOT_NAME.test(entry.name) || !entry.isFile())
        throw new Error('Unexpected recovery snapshot entry');
      const source = JSON.parse(await readFile(path.join(snapshotDir, entry.name), 'utf8'));
      if (source.schema !== 1 || !Number.isFinite(source.publishedAt)) throw new Error('Invalid recovery snapshot');
      // Reapply the allowlist at the public deployment boundary, never copy arbitrary JSON.
      const event = publicCameraEvent(source.event);
      if (![`${event.joinCode}.json`, `${event.slug}.json`].includes(entry.name))
        throw new Error('Recovery snapshot identity does not match its filename');
      await writeFile(path.join(guest, 'events', entry.name), JSON.stringify({
        schema: 1, publishedAt: source.publishedAt, event,
      }) + '\n');
      snapshots++;
    }
    await writeFile(path.join(publicDir, '_redirects'),
      '/join/* /guest/shell 200\n/e/* /guest/shell 200\n/guest/join/* /guest/shell 200\n/guest/e/* /guest/shell 200\n/guest/saved/* /guest/shell 200\n');
    await writeFile(path.join(publicDir, '_headers'), [
      '/guest/*',
      '  X-Content-Type-Options: nosniff',
      '  X-Frame-Options: DENY',
      '  Referrer-Policy: no-referrer',
      '  X-Robots-Tag: noindex, nofollow',
      '  Permissions-Policy: camera=(self), microphone=(self), geolocation=()',
      "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      '/guest/shell',
      '  Content-Type: text/html; charset=utf-8',
      '  Cache-Control: no-cache',
      '/guest/index.html',
      '  Cache-Control: no-cache',
      '/guest/sw.js',
      '  Cache-Control: no-cache',
      '  Service-Worker-Allowed: /',
      '/join/*',
      '  X-Robots-Tag: noindex, nofollow',
      '  X-Frame-Options: DENY',
      '  Content-Type: text/html; charset=utf-8',
      '  Cache-Control: no-cache',
      "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      '  X-Content-Type-Options: nosniff',
      '  Referrer-Policy: no-referrer',
      '  Permissions-Policy: camera=(self), microphone=(self), geolocation=()',
      '/e/*',
      '  X-Robots-Tag: noindex, nofollow',
      '  X-Frame-Options: DENY',
      '  Content-Type: text/html; charset=utf-8',
      '  Cache-Control: no-cache',
      "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      '  X-Content-Type-Options: nosniff',
      '  Referrer-Policy: no-referrer',
      '  Permissions-Policy: camera=(self), microphone=(self), geolocation=()',
      '/guest/join/*',
      '  Content-Type: text/html; charset=utf-8',
      '  Cache-Control: no-cache',
      '/guest/e/*',
      '  Content-Type: text/html; charset=utf-8',
      '  Cache-Control: no-cache',
      '/guest/saved/*',
      '  Content-Type: text/html; charset=utf-8',
      '  Cache-Control: no-cache',
      '/guest/assets/*',
      '  Cache-Control: public, max-age=31536000, immutable',
      '/guest/events/*',
      '  Cache-Control: no-store',
      '',
    ].join('\n'));
    const config = JSON.parse(await readFile(path.join(here, 'wrangler.template.json'), 'utf8'));
    config.account_id = accountId;
    config.vars.DEPLOYMENT_LANE = lane;
    if (lane === 'production') {
      const host = new URL(validatedOrigin).hostname;
      config.name = 'snapdini-guest';
      config.workers_dev = false;
      const paths = canaryCode
        ? [`join/${canaryCode}*`, 'guest/assets/*', 'guest/fonts/*', 'guest/sw.js*',
          'guest/icon.svg*', 'guest/index.html*', 'guest/shell*', 'guest/release.json*',
          'guest/publication.json*', `guest/events/${canaryCode}.json*`, `guest/saved/${canaryCode}*`]
        : ['join/*', 'e/*', 'guest/*'];
      config.routes = paths.map(route => ({ pattern: `${host}/${route}`, zone_name: host }));
      config.assets.run_worker_first = ['/guest/events/*', '/guest/publication.json'];
    }
    if (eventsWorker) {
      const required = lane === 'dev' ? 'snapdini-guest-events-dev' : 'snapdini-guest-events';
      if (eventsWorker !== required) throw new Error('Event Worker does not match deployment lane');
      config.services = [{ binding: 'EVENTS_ASSETS', service: eventsWorker }];
      if (!config.assets.run_worker_first.includes('/guest/events/*')) config.assets.run_worker_first.push('/guest/events/*', '/guest/publication.json');
    } else if (lane === 'production') throw new Error('Production requires an independent event publication Worker');
    config.vars.APP_ORIGIN = validatedOrigin;
    await writeFile(path.join(artifact, 'wrangler.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    await copyFile(path.join(here, 'worker.mjs'), path.join(artifact, 'worker.mjs'));
    return { artifact, snapshots };
  } catch (error) {
    await rm(artifact, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepare({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, origin: process.env.APP_ORIGIN,
    lane: process.env.DEPLOYMENT_LANE, guestDir: process.env.GUEST_ASSET_DIR,
    eventsWorker: process.env.GUEST_EVENTS_WORKER, canaryCode: process.env.GUEST_CANARY_CODE, snapshotDir: process.env.GUEST_SNAPSHOT_DIR }).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
