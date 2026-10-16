#!/usr/bin/env node
/** Read-only development publisher. Never copies an API response wholesale. */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile, lstat } from 'node:fs/promises';

const STRING_FIELDS = ['id', 'name', 'revealMode'];
const NULLABLE_FIELDS = ['blurb', 'timezone'];
const NUMBER_FIELDS = ['maxPhotos', 'revealDelayHours', 'videoSeconds', 'startsAt', 'expiresAt'];
const BOOLEAN_FIELDS = ['isDemo', 'isLocked', 'allowDownloads', 'noFlash', 'heartsEnabled',
  'commentsEnabled', 'galleryHeartsEnabled', 'galleryCommentsEnabled'];
const THEME_FIELDS = ['bg', 'surface', 'surface2', 'border', 'text', 'textMuted', 'accent',
  'accentDark', 'mode', 'font', 'customCss', 'headerImage', 'preset', 'imageOriginal', 'imageCrop'];

export function identifier(raw, kind = 'code') {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128)
    throw new Error('Invalid recovery identifier');
  if (kind === 'code' && /^[a-z0-9]+$/i.test(raw)) return raw.toUpperCase();
  if (kind === 'slug' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(raw)) return raw.toLowerCase();
  throw new Error('Invalid recovery identifier');
}

export function publicCameraEvent(source) {
  if (!source || typeof source !== 'object') throw new Error('Invalid public event');
  const event = {};
  for (const key of STRING_FIELDS) {
    if (typeof source[key] !== 'string') throw new Error(`Invalid public event ${key}`);
    event[key] = source[key];
  }
  for (const key of NULLABLE_FIELDS) event[key] = typeof source[key] === 'string' ? source[key] : null;
  event.joinCode = identifier(source.joinCode);
  event.slug = source.slug == null ? null : identifier(source.slug, 'slug');
  for (const key of NUMBER_FIELDS) {
    if (typeof source[key] !== 'number' || !Number.isFinite(source[key]))
      throw new Error(`Invalid public event ${key}`);
    event[key] = source[key];
  }
  event.revealAt = typeof source.revealAt === 'number' && Number.isFinite(source.revealAt) ? source.revealAt : null;
  for (const key of BOOLEAN_FIELDS) event[key] = source[key] === true;
  if (!Array.isArray(source.aspectRatios) || !source.aspectRatios.every(x => typeof x === 'string'))
    throw new Error('Invalid public event aspectRatios');
  event.aspectRatios = [...source.aspectRatios];
  event.theme = null;
  if (source.theme && typeof source.theme === 'object' && !Array.isArray(source.theme)) {
    event.theme = {};
    for (const key of THEME_FIELDS) if (typeof source.theme[key] === 'string') event.theme[key] = source.theme[key];
  }
  // Counts and clock-derived flags are intentionally absent. The guest computes time status
  // from startsAt/expiresAt and uses its own queue; these files grant no server permission.
  return event;
}

async function previousSnapshot(filename) {
  try {
    if (!(await lstat(filename)).isFile()) throw new Error('Snapshot is not a regular file');
    return JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function publishOnce({ source, fetchEvent, outputDir, now = Date.now, onError = () => {} }) {
  // A failed database read must never be mistaken for an empty event list.
  const rows = await source(now());
  const expected = new Set();
  const claimed = new Map();
  const stats = { changed: 0, unchanged: 0, removed: 0, failed: 0 };
  await mkdir(outputDir, { recursive: true, mode: 0o755 });
  for (const row of rows) {
    const names = [identifier(row.joinCode)];
    if (row.slug != null) names.push(identifier(row.slug, 'slug'));
    for (const name of names) {
      if (claimed.has(name) && claimed.get(name) !== row.joinCode)
        throw new Error('Conflicting recovery identifiers');
      claimed.set(name, row.joinCode);
      expected.add(`${name}.json`);
    }
    try {
      const response = await fetchEvent(row.joinCode);
      if (response.status === 404 || response.status === 410) {
        for (const name of names) expected.delete(`${name}.json`);
        continue;
      }
      if (!response.ok) throw new Error(`Public event HTTP ${response.status}`);
      const event = publicCameraEvent(await response.json());
      if (event.joinCode !== identifier(row.joinCode) || event.slug !== (row.slug == null ? null : identifier(row.slug, 'slug')))
        throw new Error('Event identity changed during publication');
      const body = { schema: 1, publishedAt: now(), event };
      for (const name of names) {
        const filename = path.join(outputDir, `${name}.json`);
        const previous = await previousSnapshot(filename);
        if (previous?.schema === 1 && JSON.stringify(previous.event) === JSON.stringify(event)) {
          stats.unchanged++;
          continue;
        }
        const temporary = path.join(outputDir, `.${name}.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, JSON.stringify(body) + '\n', { mode: 0o644, flag: 'wx' });
          await rename(temporary, filename);
        } finally {
          await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
        stats.changed++;
      }
    } catch (error) {
      stats.failed++;
      onError(error);
      // A transient API failure preserves the last good settings. The browser still enforces
      // the event's end time; there is no promise of learning organizer changes while offline.
    }
  }
  for (const filename of await readdir(outputDir)) {
    if (/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\.json$/.test(filename) && !expected.has(filename)) {
      await unlink(path.join(outputDir, filename));
      stats.removed++;
    }
  }
  return stats;
}

export async function main(env = process.env) {
  if (env.GUEST_RECOVERY_ENV !== 'dev') throw new Error('GUEST_RECOVERY_ENV must be dev');
  for (const key of ['DATABASE_URL', 'INTERNAL_API_BASE', 'OUTPUT_DIR'])
    if (!env[key]) throw new Error(`${key} is required; no production defaults are provided`);
  const api = new URL(env.INTERNAL_API_BASE);
  if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password || api.search || api.hash)
    throw new Error('Invalid INTERNAL_API_BASE');
  if (api.hostname === 'snapdini.com' || api.hostname.endsWith('.snapdini.com'))
    throw new Error('Production API is forbidden by the dev publisher');
  const require = createRequire(new URL('../../app/package.json', import.meta.url));
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: env.DATABASE_URL, options: '-c default_transaction_read_only=on' });
  const source = async now => {
    const { rows } = await pool.query(`SELECT join_code AS "joinCode", slug FROM events
      WHERE purged_at IS NULL
        AND COALESCE(purge_at, expires_at + GREATEST(COALESCE(retention_days, 7), 1)::bigint * 86400000) > $1
      ORDER BY join_code`, [now]);
    return rows;
  };
  const fetchEvent = code => fetch(new URL(`/api/events/${encodeURIComponent(code)}`, api), {
    signal: AbortSignal.timeout(15000), redirect: 'error', headers: { Accept: 'application/json' },
  });
  let stopping = false;
  const controller = new AbortController();
  const stop = () => { stopping = true; controller.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    do {
      try {
        const stats = await publishOnce({ source, fetchEvent, outputDir: path.resolve(env.OUTPUT_DIR),
          onError: error => console.error(`Recovery event publication failed: ${error.message}`) });
        console.log(JSON.stringify({ at: Date.now(), ...stats }));
        if (process.argv.includes('--once') && stats.failed) process.exitCode = 1;
      } catch (error) {
        // Avoid logging connection strings, headers, event payloads or SQL parameters.
        console.error(`Recovery publication pass failed (${error.code ?? error.name})`);
        if (process.argv.includes('--once')) process.exitCode = 1;
      }
      if (process.argv.includes('--once') || stopping) break;
      const { setTimeout } = await import('node:timers/promises');
      await setTimeout(60000, undefined, { signal: controller.signal }).catch(error => {
        if (error.name !== 'AbortError') throw error;
      });
    } while (!stopping);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
