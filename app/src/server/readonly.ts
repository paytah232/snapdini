/**
 * Read-only mode — for when this app is serving from a streaming replica.
 *
 * snapdini has a warm standby at a second site. Its database is a Postgres streaming replica, which
 * is PHYSICALLY read-only: it refuses every write, including the DDL the app runs on boot. So the
 * standby could not start the app at all — `migrate()` threw `PreventCommandIfReadOnly` and the
 * container sat in a crash loop. Which is the wrong failure: almost everything a guest wants during
 * an outage is to LOOK at their photos, and looking is a read.
 *
 * WHY THIS IS DETECTED RATHER THAN CONFIGURED. The obvious design is a SNAPDINI_READ_ONLY flag in
 * the standby's .env, and it is the wrong one twice over. That .env is rsynced from production every
 * fifteen minutes, so the flag would be overwritten by the very machine it is meant to survive —
 * workable only by teaching the sync script to re-apply it, i.e. one more thing to remember. And it
 * would still be wrong at the moment it matters most: a promotion (`pg_promote()`) happens during an
 * incident, and a flag has to be found and cleared by hand before the site can take writes again.
 *
 * `pg_is_in_recovery()` is the database's own answer to the only question that matters, and it
 * changes by itself the instant the replica is promoted. Polled rather than read once at boot, so
 * promotion needs no restart: the app notices within one interval and starts accepting writes.
 *
 * FAILURE DIRECTION. When the check itself fails — the database is briefly gone, a blip mid-poll —
 * the last known state is KEPT rather than reset. Guessing "writable" would let writes through to a
 * replica that would reject them anyway, and guessing "read-only" would take a healthy production
 * site read-only over a dropped packet. Neither guess is better than the answer we already had.
 */
import { get } from './db';

/** How often to re-ask. Short enough that a promotion is picked up promptly, long enough that it is
 *  a rounding error against normal query load — this is one trivial query per interval. */
const POLL_MS = Number(process.env.READ_ONLY_POLL_MS || 15_000);

let replica = false;
let known = false;          // has the question ever been answered? Until it has, assume writable.
let timer: ReturnType<typeof setInterval> | undefined;

/** Is this deployment serving from a read-only replica right now? */
export const isReadOnly = (): boolean => replica;

/** Has the state ever been established? False only in the window before the first successful poll. */
export const readOnlyKnown = (): boolean => known;

/** Ask Postgres. Returns null when the question could not be put — see FAILURE DIRECTION above. */
export async function queryIsReplica(): Promise<boolean | null> {
  try {
    const row = await get<{ in_recovery: boolean }>('select pg_is_in_recovery() as in_recovery');
    return !!row?.in_recovery;
  } catch {
    return null;
  }
}

/** Apply a fresh answer, and say so in the log ONLY when it changes. A line per poll would bury
 *  every other thing in the log within a day; a line per transition is the thing worth seeing. */
export function applyReplicaState(answer: boolean | null): void {
  if (answer === null) return;                       // keep what we had
  const first = !known;
  const changed = answer !== replica;
  replica = answer;
  known = true;
  if (!first && !changed) return;
  if (replica) {
    console.log('[readonly] READ-ONLY: this database is a replica (pg_is_in_recovery() = true). '
      + 'Reads are served normally; writes answer 503. Promotion clears this by itself.');
  } else if (first) {
    console.log('[readonly] read-write: primary database');
  } else {
    console.log('[readonly] PROMOTED: the database now accepts writes — read-only mode lifted with no restart');
  }
}

/** One check now, then every POLL_MS. Safe to call twice; the second call is a no-op. */
export async function startReadOnlyWatch(): Promise<void> {
  applyReplicaState(await queryIsReplica());
  if (timer) return;
  timer = setInterval(() => { void queryIsReplica().then(applyReplicaState); }, POLL_MS);
  timer.unref?.();   // never hold the process open on this alone
}

export function stopReadOnlyWatch(): void {
  if (timer) { clearInterval(timer); timer = undefined; }
}

/** Methods that change things. Everything else is a read and is served normally. */
const WRITE_METHOD = /^(POST|PUT|PATCH|DELETE)$/;

/** Endpoints that use a write METHOD but touch no database row, so they stay open on a replica.
 *  Kept deliberately short: the default for anything new must be "blocked", not "allowed". */
const WRITES_NOTHING = [
  /^\/csp-report$/,          // logs a line, stores nothing
];

/** GETs that write, which the method test alone would wave straight through.
 *
 *  Both are email links, and an email link can only ever be a GET — there is no way to make a
 *  mail client POST. `/auth/verify` stamps `emailVerifiedAt`; `/auth/magic` does the same and
 *  issues a session. On a replica the write throws and the error handler answers 500 "Something
 *  went wrong", which is the one response this whole mode exists to avoid: it tells somebody their
 *  sign-in link is broken when it is merely early.
 *
 *  Found by auditing every GET for a write rather than by assuming the method was enough. If a
 *  third one is ever added, it belongs here on the same day. */
const WRITES_ON_GET = [
  /^\/auth\/verify$/,
  /^\/auth\/magic$/,
];

/** Should this request be refused because the database cannot take writes? */
export function blockedByReadOnly(method: string, path: string): boolean {
  if (!replica) return false;
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return WRITES_ON_GET.some((re) => re.test(path));
  if (!WRITE_METHOD.test(m)) return false;
  return !WRITES_NOTHING.some((re) => re.test(path));
}

/** What a refused write says. 503 + Retry-After, because this is temporary by definition and a
 *  client that backs off and retries is doing exactly the right thing — the camera's upload queue
 *  already does, which is why a paused upload resumes on its own rather than being lost. */
export const READ_ONLY_BODY = {
  error: "We're recovering a server. Your photos and videos are safe — uploads are paused and will "
    + "work again shortly. There's no need to re-upload anything.",
  readOnly: true,
} as const;

/** Should a background writer skip this tick?
 *
 *  The HTTP gate covers requests; these are the timers, and they were still firing on a replica —
 *  the cleanup sweep failed three prunes every cycle and said so in the log each time.
 *
 *  Nothing unsafe was happening, and it is worth writing down WHY: every email path in this codebase
 *  claims before it sends (`claim()` in guest-delivery, the welcome/check-in claims in lifecycle),
 *  so on a replica the claim throws and the send never runs. That ordering is what stopped a
 *  failover from mailing every guest again on a fifteen-minute loop. This guard means the safety no
 *  longer RESTS on that ordering being preserved by whoever edits those files next.
 *
 *  Per tick rather than at startup, so a promotion resumes the sweeps without a restart — the same
 *  reason the mode itself is polled. */
export function skipWriteSweep(label: string): boolean {
  if (!isReadOnly()) return false;
  const last = lastSkipLog.get(label) ?? 0;
  const now = Date.now();
  // One line per label per ten minutes: enough to show a sweep is dormant, not enough to bury a log.
  if (now - last > 10 * 60_000) {
    lastSkipLog.set(label, now);
    console.log(`[readonly] ${label} sweep skipped — database is read-only`);
  }
  return true;
}
const lastSkipLog = new Map<string, number>();
