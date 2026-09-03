// Write-behind counters for gallery engagement.
//
// The naive version — one UPDATE per tracked action — is exactly the wrong shape here. A 150-guest
// event means 150 gallery loads each bumping the same ~100 photo rows, so every viewer contends for
// the same rows and each request waits on a write before responding. That is how a counter takes
// down a read path.
//
// Instead: coalesce in memory and flush on an interval in ONE statement per table, using a VALUES
// join so N photos cost one round trip. Ten viewers of the same photo within a flush window become
// "+10" once, not ten separate row locks.
//
// Trade-off, deliberate: counts are engagement analytics, not money, so losing a few seconds of
// them on a crash is fine — and far cheaper than the alternative. This is per-process state, so it
// assumes ONE app container. If this is ever scaled horizontally, move the accumulator to Redis
// (or accept per-instance flushes, which still converge because the SQL is additive).
import { sql } from 'drizzle-orm';
import { db } from './db';

const FLUSH_MS = Number(process.env.COUNTER_FLUSH_MS || 5000);
// Hard cap so a flood cannot grow the maps without bound; beyond this we drop rather than balloon.
const MAX_KEYS = 20_000;

type Bucket = Map<string, number>;
const photoViews: Bucket = new Map();
const photoDownloads: Bucket = new Map();
const galleryViews: Bucket = new Map();   // keyed by event id
const referralClicks: Bucket = new Map(); // keyed by event id

const add = (b: Bucket, key: string, n = 1) => {
  if (!key) return;
  if (!b.has(key) && b.size >= MAX_KEYS) return;
  b.set(key, (b.get(key) || 0) + n);
};

export const bumpPhotoViews     = (ids: string[]) => ids.forEach((id) => add(photoViews, id));
export const bumpPhotoDownloads = (ids: string[]) => ids.forEach((id) => add(photoDownloads, id));
export const bumpGalleryView    = (eventId: string) => add(galleryViews, eventId);
export const bumpReferralClick  = (eventId: string) => add(referralClicks, eventId);

/** One additive UPDATE for the whole bucket, via a VALUES join. */
async function flushBucket(b: Bucket, table: 'photos' | 'events', column: string): Promise<void> {
  if (!b.size) return;
  const entries = [...b.entries()];
  b.clear();                                  // take the batch before awaiting, so new bumps queue
  try {
    const values = sql.join(
      entries.map(([id, n]) => sql`(${id}, ${n}::int)`),
      sql`, `,
    );
    await db.execute(sql`
      UPDATE ${sql.raw(table)} AS t
         SET ${sql.raw(column)} = t.${sql.raw(column)} + v.n
        FROM (VALUES ${values}) AS v(id, n)
       WHERE t.id = v.id
    `);
  } catch (e) {
    // Put nothing back: a retry storm on analytics is worse than a lost increment.
    console.warn(`[counters] flush ${table}.${column} failed:`, (e as Error).message);
  }
}

export async function flushCounters(): Promise<void> {
  await flushBucket(photoViews, 'photos', 'view_count');
  await flushBucket(photoDownloads, 'photos', 'download_count');
  await flushBucket(galleryViews, 'events', 'gallery_views');
  await flushBucket(referralClicks, 'events', 'referral_clicks');
}

let timer: NodeJS.Timeout | null = null;
export function startCounters(): void {
  if (timer) return;
  timer = setInterval(() => { void flushCounters(); }, FLUSH_MS);
  timer.unref?.();                            // never hold the process open for a counter
  // Flush on the way out so a normal restart does not discard the current window.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => { void flushCounters(); });
  }
}
