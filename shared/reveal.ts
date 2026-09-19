// When a scheduled reveal actually happens.
//
// Shared because the host is SHOWN the moment ("photos appear from 7:15 pm") in the browser and is
// GATED on it by the server. Those are two computations of one instant, and the only interesting
// failure is the one where they disagree: the host is told a time, the guests see another, and
// nothing anywhere reports a fault.

/** The grid a host-chosen reveal is rounded onto.
 *
 *  Nothing polls for a reveal — `scheduledRevealAt` is compared against the clock on each read, so
 *  the gate opens by itself the moment it passes and no timer exists to add. The grid is for the
 *  things that CANNOT be lazy: the countdown a guest is already staring at, and any sweep-driven
 *  work, which can only ever act when its own sweep wakes. Quantising the stored instant is what
 *  makes the time the host was promised the same time all of those arrive at.
 *
 *  15 minutes because that is the finest sweep the product runs (lifecycle.ts SWEEP_MS) — reveal
 *  rides that tick rather than introducing one. Finer would be a promise no scheduled work could
 *  keep; the hourly retention sweep would be coarse enough to turn "8 pm" into "9 pm", which is a
 *  different evening to the person who typed it.
 *
 *  It divides the hour, and every time zone in current use is a whole number of quarter-hours off
 *  UTC, so a grid laid out in epoch ms lands on :00/:15/:30/:45 on the host's own clock too. A
 *  17-minute tick would round "7:00 pm" to something no one could read back. */
export const REVEAL_TICK_MS = 15 * 60 * 1000;

/** The value the delay control carries for "let me pick the moment". A string on purpose: any
 *  number here would be indistinguishable from an hour preset. */
export const REVEAL_CUSTOM = 'custom';

/** Round a chosen instant onto the grid, ALWAYS up.
 *
 *  A host who typed 7:05 pm can be told 7:15 and accept it. Rounding to nearest would show the
 *  photos at 7:00 — before the moment they picked — and an early reveal is the one that cannot be
 *  undone: the surprise is spent. */
export function ceilToRevealTick(ms: number): number {
  return Math.ceil(ms / REVEAL_TICK_MS) * REVEAL_TICK_MS;
}

/** A zone's UTC offset in ms at a given instant. Intl carries the only DST database both halves of
 *  the product have; formatting the instant in the zone and reading the result back as though it
 *  were UTC is how you get a number out of it. Throws for a zone Intl does not know. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // The h23 cycle reports midnight as hour 24 on the SAME date, which is the same instant as 0 —
  // but Date.UTC would read it as the next day and put the offset out by 24 hours.
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - utcMs;
}

/** Epoch ms for a wall-clock `YYYY-MM-DD` + `HH:MM` AS READ IN `timeZone`. Null when either part is
 *  malformed or the zone is unknown — callers must decide what to do rather than get a silent
 *  fallback to the machine's own zone, which is UTC on the server and the host's phone in the
 *  browser (the two answers this function exists to stop differing).
 *
 *  A wall time does not always name exactly one instant, and BOTH exceptions resolve LATE here,
 *  deliberately — an early reveal is the one that cannot be undone:
 *
 *   · the hour a spring-forward skips never existed, and resolves to the instant just after the
 *     jump — the next moment the host could have meant;
 *   · the hour an autumn fall-back repeats happens twice, and resolves to the SECOND one.
 *
 *  Which is why this probes the zone on either side of the reading and keeps the latest candidate
 *  that survives the round trip, rather than correcting one guess. The obvious single correction —
 *  take the offset at the reading, subtract, take the offset again — lands on whichever side of the
 *  transition it happened to start from: it resolved Sydney's skipped 02:30 forwards and New York's
 *  backwards, so half the world's hosts would have had that reveal an hour early. */
export function zonedWallTimeToMs(date: string, time: string, timeZone: string): number | null {
  const d = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec((date || '').trim());
  const t = /^(\d{1,2}):(\d{2})/.exec((time || '').trim());
  if (!d || !t) return null;
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), 0, 0);
  if (!Number.isFinite(wall)) return null;
  try {
    const DAY = 86_400_000;
    const naive = wall - zoneOffsetMs(wall, timeZone);
    const candidates = [
      wall - zoneOffsetMs(wall - DAY, timeZone),   // the offset in force before any nearby change
      wall - zoneOffsetMs(wall + DAY, timeZone),   // …and after it
      wall - zoneOffsetMs(naive, timeZone),
    ];
    // An instant reads back as this wall time exactly when adding its own offset returns it, so the
    // check costs one more Intl call and no date arithmetic of its own.
    const exact = candidates.filter((c) => c + zoneOffsetMs(c, timeZone) === wall);
    return Math.max(...(exact.length ? exact : candidates));
  } catch {
    return null;   // RangeError — not a zone Intl knows
  }
}

/** The inverse: what the clock on the wall in `timeZone` reads at an instant, as the `YYYY-MM-DD` /
 *  `HH:MM` a date and a time input want. Needed so an event's saved reveal loads back into the form
 *  as the time the host typed rather than that instant translated into whichever zone the phone
 *  they are editing from happens to be in. Null for an unknown zone. */
export function msToZonedWallTime(ms: number, timeZone: string): { date: string; time: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {   // en-CA formats dates as YYYY-MM-DD
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const hour = String(Number(get('hour')) % 24).padStart(2, '0');   // h23 midnight again
    return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${hour}:${get('minute')}` };
  } catch {
    return null;
  }
}

// ── The window an absolute reveal instant has to sit in ──────────────────────
//
// WHAT WENT WRONG. resolveCustomReveal() in routes/events.ts checked one bound — that the reveal is
// not after retention deletes the photos — and nothing else. So a 24-hour `at_end` event could be
// created with a reveal 48 hours IN THE PAST, and the API answered 200. The gallery then reads
// `revealed: true` from the moment the event starts, to anybody, with `cache-control: public` on
// it, while the event is still running. On the default settings (`at_end`, moderation off) that is
// every photo public the instant it is taken, on a product whose entire pitch is that they appear
// at the end. Reproduced twice, and confirmed against a control event which correctly read
// `revealed: false`.
//
// The rule these two functions state is one sentence: AN ABSOLUTE REVEAL SITS AT OR AFTER THE END
// OF THE EVENT AND AT OR BEFORE THE PHOTOS ARE DELETED. Everything about reveal timing in the
// product already assumes it — `scheduledRevealAt` above returns `revealAt` in place of
// `expiresAt + delay`, and a delay cannot be negative — but nothing enforced it.
//
// They live HERE, beside scheduledRevealAt and ceilToRevealTick, rather than in the route: the
// route is where the rule was missing, and a rule that lives where it is enforced is a rule the
// next enforcement point has to reinvent.

/** Why this instant cannot be an event's reveal, in words for a host — or null if it can be.
 *
 *  The order of the three is the order a host would notice them in, and each says what to do. */
export function revealInstantRefusal(
  at: number,
  window: { expiresAt: number; purgeAt: number },
  now: number,
): string | null {
  // A reveal in the past is a gallery that is ALREADY open. There is no schedule left in it.
  if (at <= now)
    return 'That reveal time has already passed. Pick a date and time in the future.';
  // THE ONE THAT LEAKED. A reveal before the end of the event unlocks the gallery while the party
  // is still going, so every photo is public as it is taken.
  if (at < window.expiresAt)
    return 'That is before your event ends, so your guests would see the photos as they were taken. Pick a time at or after your event finishes.';
  // Retention deletes the photos. A reveal booked past that unlocks an empty gallery — the one
  // outcome worse than refusing to save.
  if (at > window.purgeAt)
    return 'That is after the photos are deleted at the end of retention. Pick an earlier reveal, or extend retention first.';
  return null;
}

/** Keep a reveal the host already chose inside the window a RESCHEDULE has just moved.
 *
 *  0044_reveal_at.sql argues that an absolute instant must not be dragged around when an event is
 *  nudged — "rescheduling would drag a date the host chose on purpose to a different day" — and
 *  that is right for nudging by hours and wrong for a genuine reschedule. Moving an event two weeks
 *  out left `reveal_at` at the original instant: two weeks BEFORE the event it belongs to, which is
 *  the leak above arriving by a second road. Reproduced both by re-sending the same wall-clock
 *  strings (which the real client always does — web/src/lib/eventEdit.ts) and by a name-only save
 *  that sends no reveal keys at all.
 *
 *  CLAMPED UP, NOT REFUSED, and the precedent is clampGuestSendAt() in guest-delivery.ts, which has
 *  done exactly this for the guest send since it was written. The host is not choosing this instant
 *  — they are moving their event, and the reveal came along on its own — so throwing the whole
 *  reschedule away over it would be refusing the edit they DID make because of one they did not.
 *  "At the end of the event" is the only thing an earlier instant can mean. The caller reports the
 *  clamp so the host is told rather than shown a different time back without explanation.
 *
 *  THE LATE SIDE IS REFUSED, not clamped, and the asymmetry is deliberate: clamping down would land
 *  the reveal at the instant the photos are deleted, which unlocks an empty gallery — so there is
 *  no safe value to pick on that side, and the host has to choose. Moving an event EARLIER is the
 *  only way to get there, and the host doing it is on the settings screen with both controls. */
export function clampRevealAt(at: number, window: { expiresAt: number; purgeAt: number }):
  { at: number; clamped: boolean } | { error: string } {
  if (at > window.purgeAt)
    return { error: 'Moving the event leaves the photo reveal after the photos would be deleted. Pick a new reveal time, or extend retention first.' };
  if (at < window.expiresAt) return { at: window.expiresAt, clamped: true };
  return { at, clamped: false };
}

/** The reveal timing fields of an event, as both halves see them. */
export interface RevealTiming {
  revealMode: string;
  expiresAt: number;
  revealDelayHours: number;
  /** The exact instant the host picked, already on the grid. Null — which is every event created
   *  before this column existed — means the delay-after-the-end rule below, unchanged. */
  revealAt?: number | null;
}

/** When this event's gallery unlocks by itself, or null when only the host can unlock it.
 *
 *  One function rather than the four copies of `expiresAt + delay * 3600000` this replaced: the
 *  gate, the guest countdown, the share-page countdown and the camera all have to name the same
 *  instant, and they drifted apart the moment any one of them learned something the others hadn't. */
export function scheduledRevealAt(event: RevealTiming): number | null {
  if (event.revealMode !== 'at_end') return null;
  return event.revealAt ?? event.expiresAt + (event.revealDelayHours || 0) * 3_600_000;
}


// ── How long the EDGE may hold the public gallery answer ────────────────────────
//
// `GET /api/photos/:code?gallery=true` is the highest-fan-out response in the product: one host
// shares one link with every guest, and every one of those phones polls it. It is also the only
// photos response that is byte-identical for every viewer — the gallery branches build their rows
// with `photoRow(p, null, …)`, so there is no `isOwn` and no `myParticipantId` in it. That, and
// only that, is what makes it safe to cache in a shared cache at all.
//
// The tempting implementation is one number. It is wrong, and the reason is which STATE the number
// lands in: the pre-reveal body contains `revealed: false`. Cache that for 60s and a guest can sit
// on a lock wall for up to a minute AFTER the reveal fired, served a stale "not yet" by the edge
// while their client did everything right — spending the entire reveal-latency budget (the 5s skew
// pad plus the jitter on top of it) to save two requests a minute. So the TTL is computed per
// state, and the interesting half is the cap that stops it ever spanning `revealAt`.
//
// NB this only takes effect if the CDN in front is configured to respect the origin's TTL. A
// Cloudflare Cache Rule with a fixed "Edge Cache TTL" overrides Cache-Control outright and gives
// every state one blanket number, which is precisely what this exists to avoid.

/** Revealed. The body changes only when the host approves another photo, and the page already
 *  promises "you don't need to refresh" — the poll behind that promise is what this is throttling.
 *  30 rather than 60 because un-reveal is a real endpoint, and a stale revealed body is the one
 *  direction of staleness that shows people something they were meant to stop seeing. The saving
 *  between the two is two requests a minute across a whole guest list; it is not worth the window. */
export const GALLERY_CACHE_REVEALED_S = 30;

/** Never longer than this, whatever the state. A minute is already past the point where a longer
 *  TTL saves a measurable number of requests: 150 guests polling at 45s is ~3.3 req/s uncached,
 *  and ANY TTL in this range collapses that to a handful of origin fetches per minute. */
export const GALLERY_CACHE_MAX_S = 60;

/** A `manual` reveal has no scheduled instant, so there is no window that is provably safe — the
 *  host may press the button during any of it. Short enough that the lock wall cannot outlive the
 *  press by more than a moment, long enough to still absorb the simultaneous poll of a guest list. */
export const GALLERY_CACHE_MANUAL_S = 5;

/** How far short of `revealAt` a pre-reveal TTL must stop.
 *
 *  It covers the edge's own clock disagreeing with ours, and the round trip of the request that
 *  stores the entry — an object cached at T with TTL t is served until T+t by the EDGE's reckoning,
 *  not ours. 10s is comfortably more than either and costs nothing: the requests being saved are in
 *  the minutes before the reveal, not the last ten seconds of them. */
export const GALLERY_CACHE_REVEAL_MARGIN_S = 10;

/** Below this, a TTL is all risk and no saving — it cannot absorb even one poll interval. Rounds
 *  down to "do not cache" rather than shaving a second off the margin. */
const GALLERY_CACHE_MIN_USEFUL_S = 5;

/** Seconds the public gallery answer may be held by a shared cache. 0 means "do not".
 *
 *  The load-bearing property, which the tests pin directly: when the gallery is NOT yet revealed,
 *  `now + seconds*1000` is always at least GALLERY_CACHE_REVEAL_MARGIN_S before `revealAt`. No
 *  cached lock wall can outlive the reveal it is denying. */
export function galleryCacheSeconds(s: {
  revealed: boolean;
  revealAt: number | null;
  revealMode?: string | null;
  now: number;
}): number {
  if (s.revealed) return GALLERY_CACHE_REVEALED_S;
  // A host with a button can press it during any window, so no window is safe. This is checked
  // before revealAt deliberately: a manual event that somehow carries an instant is still manual.
  if (s.revealMode === 'manual') return GALLERY_CACHE_MANUAL_S;
  // No moment to be far from — treat it exactly like manual rather than guessing at a long TTL.
  if (s.revealAt === null || !Number.isFinite(s.revealAt)) return GALLERY_CACHE_MANUAL_S;
  const until = Math.floor((s.revealAt - s.now) / 1000);
  const ttl = Math.min(GALLERY_CACHE_MAX_S, until - GALLERY_CACHE_REVEAL_MARGIN_S);
  return ttl >= GALLERY_CACHE_MIN_USEFUL_S ? ttl : 0;
}

/** The header itself, so no caller can assemble a different one by hand. `no-store` — not merely
 *  `max-age=0` — because this is also what the PER-VIEWER branches send, and those must never be
 *  held by an intermediary at all. */
export function galleryCacheControl(seconds: number): string {
  return seconds > 0 ? `public, max-age=${seconds}` : 'private, no-store';
}
