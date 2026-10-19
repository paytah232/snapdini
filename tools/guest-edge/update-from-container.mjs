#!/usr/bin/env node
/** Optional operator upgrade hook: promote exactly the camera shipped in the running web image. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promote } from './promote.mjs';
const execute = promisify(execFile);
export async function update(env = process.env, expectedVersion = process.argv[2]) {
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion ?? '')) throw new Error('Explicit deployed release version required');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(env.GUEST_WEB_CONTAINER ?? ''))
    throw new Error('Explicit running web container required');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'snapdini-camera-release-'));
  try {
    const { stdout } = await execute('docker', ['inspect', '--format', '{{.State.Running}}', env.GUEST_WEB_CONTAINER]);
    if (stdout.trim() !== 'true') throw new Error('Web container must be running');
    const guestDir = path.join(directory, 'guest');
    await execute('docker', ['cp', `${env.GUEST_WEB_CONTAINER}:/app/build/client/guest`, guestDir]);
    const manifest = JSON.parse(await readFile(path.join(guestDir, 'release.json'), 'utf8'));
    if (manifest.version !== expectedVersion) throw new Error('Running web camera does not match deployed release');
    return await promote({ ...env, EXPECTED_VERSION: expectedVersion, GUEST_ASSET_DIR: guestDir }, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  update().then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
