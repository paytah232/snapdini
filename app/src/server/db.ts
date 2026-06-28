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
});

// Drizzle ORM client — the primary data-access API across the backend.
export const db = drizzle(pool, { schema });
export { schema };

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
