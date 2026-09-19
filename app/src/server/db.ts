import path from 'path';
import { Pool, types } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from './schema';

// Epoch-millisecond timestamps are stored as BIGINT. node-postgres returns BIGINT
// (oid 20) as a string by default; parse back to a JS number so all the existing
// `Date.now() > expiresAt` arithmetic keeps working. (Epoch-ms stays well within
// Number.MAX_SAFE_INTEGER.)
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgres://snapdini:snapdini@localhost:5432/snapdini',
  // The pool had NO bounds of its own, which meant node-postgres' default of 10 connections and no
  // timeout on any of them. Ten is fine while every query is milliseconds; the failure mode is that
  // ONE slow query shape — a big event's gallery read, say — occupies all ten, and every other
  // request on the box then queues behind it with nothing to cut it short. A statement timeout is
  // what turns that from an outage into a handful of failed requests.
  max: Number(process.env.PG_POOL_MAX || 20),
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 10_000),
  // Long enough that a quiet minute does not churn connections, short enough that a burst does not
  // hold twenty open all night.
  idleTimeoutMillis: 30_000,
  // Fail fast rather than hang when the database itself is unreachable — the app's health check and
  // the retry in front of it can both act on an error, neither can act on a promise that never
  // settles.
  connectionTimeoutMillis: 5_000,
});

// Drizzle ORM client — the primary data-access API across the backend.
export const db = drizzle(pool, { schema });
export { schema };

// ── Telling one refusal from another ─────────────────────────────────────────
//
// SQLSTATE codes, because they are the only part of a failed statement that is stable. The
// driver's message is English prose from whatever Postgres the operator happens to run, and
// `constraint` is a name any later migration is free to change; the five-character code is in the
// standard and cannot move.
//
// Worth having at all because a catch that assumes ONE failure mode reports every OTHER one as
// that mode. routes/guests.ts told a host "that email is already on this guest list" when what
// the database had actually said was "email cannot be null", which sends someone hunting a
// duplicate that does not exist.
/** A unique index refused the row. */
export const PG_UNIQUE_VIOLATION = '23505';
/** A NOT NULL column was handed null. */
export const PG_NOT_NULL_VIOLATION = '23502';

/** The SQLSTATE behind a thrown query error, or null when this was not Postgres refusing anything.
 *
 *  THE CODE IS NOT ON THE ERROR YOU CATCH. Drizzle wraps every driver failure in a
 *  `DrizzleQueryError` carrying the query and its params; the node-postgres `DatabaseError` that
 *  actually holds `.code` is its `cause`. So `(e as { code?: string }).code` reads `undefined` and
 *  every comparison against it is quietly false — the trap this helper exists to close. Confirmed
 *  against the versions in package.json (drizzle-orm 0.45.2 over pg 8) rather than assumed.
 *
 *  Walks the cause chain instead of reaching one fixed level down, so a later wrapper (another
 *  driver, a transaction helper) cannot turn every code back into null without anyone noticing. */
export function pgErrorCode(e: unknown): string | null {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

// Translate the `?` placeholders into Postgres `$1, $2, …`. Retained as a typed
// escape hatch for the rare raw query; prefer the Drizzle query builder via `db`.
export function toPg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export async function all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(toPg(sql), params as never[]);
  return r.rows as T[];
}
export async function get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await pool.query(toPg(sql), params as never[]);
  return r.rows[0] as T | undefined;
}
export async function run(sql: string, params: unknown[] = []) {
  return pool.query(toPg(sql), params as never[]);
}

// Apply Drizzle migrations on boot. The schema lives in schema.ts; SQL migrations are
// generated with `npx drizzle-kit generate` into ./drizzle and applied here in order.
// The baseline migration is idempotent (IF NOT EXISTS / guarded constraints), so it is a
// safe no-op against the existing populated database and builds fresh ones from scratch.
export async function init(): Promise<void> {
  await migrate(db, { migrationsFolder: path.join(__dirname, 'drizzle') });
}
