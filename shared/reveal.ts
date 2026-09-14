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
