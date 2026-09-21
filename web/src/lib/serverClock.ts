// Whose clock is it anyway.
//
// Every deadline in this product is the SERVER'S: `expiresAt` arrives as an absolute epoch
// millisecond, the upload gate compares against it, and the reveal opens on it. Every clock
// READING, until now, was the device's — `Date.now()` on a phone that nobody has ever checked.
//
// That was survivable while the two were only used for a countdown, because a countdown that is
// forty seconds out looks exactly like a countdown. It stopped being survivable the moment the
// camera began closing its own shutter on that reading: a phone whose clock runs fast now shuts
// the guest out early, and one running slow lets them shoot past the end and then have the
// uploads judged against the timestamp its own clock invented.
//
// The server tells us the time on every single response and always has. `Date` is a required HTTP
// header, it is already on the wire, and reading it costs nothing — no endpoint, no extra round
// trip, no clock-sync protocol.
//
// ── What this is not ──────────────────────────────────────────────────────────
// This is not NTP. The `Date` header has one-second resolution and we cannot see when in the
// round trip the server stamped it, so a single sample is worth roughly ±(0.5s + half the RTT).
// Three things keep that honest enough to act on:
//
//   · the midpoint assumption — the stamp is treated as having happened halfway through the round
//     trip, which is the least-wrong guess available and is exactly what NTP does with the same
//     problem;
//   · keeping the FASTEST sample rather than the newest, because a short round trip is a narrow
//     window for the stamp to hide in. A 40ms reply pins the offset far better than a 3s one, and
//     a phone at a party produces both;
//   · a dead band. Below a couple of seconds we do not believe our own measurement and use the
//     device clock untouched, so the overwhelming majority of correctly-synced phones are not
//     handed a countdown that stutters by a second because the wifi hiccuped.
//
// So this does not make the clock exact. It makes a phone that is minutes or hours out behave
// like one that is seconds out, which is the entire difference that matters here.

/** Ignore a sample whose round trip was this long or longer.
 *
 *  The stamp could be anywhere inside the round trip, so the round trip IS the error bar. Ten
 *  seconds of uncertainty cannot improve on a device clock that is merely wrong by seconds, and a
 *  reply that slow is usually a phone that has just come back from being asleep — where the
 *  timings either side of the request are not describing the same world anyway. */
const MAX_USABLE_RTT_MS = 10_000;

/** Ignore a sample that came back faster than a network can answer.
 *
 *  THE BUG THIS EXISTS FOR, because it turned the whole module upside down. Gallery replies are
 *  `public, max-age=30`, so an ordinary load can be served straight from the browser's own cache.
 *  That reply carries the `Date` from when it was FIRST generated — up to thirty seconds ago — and
 *  arrives in about a millisecond. Which is to say: a stale reading with a round trip so short
 *  that the logic below rated it the most trustworthy sample it had ever seen, adopted a thirty-
 *  second-negative offset, and then refused every real network sample for five minutes because
 *  none of them could beat 1ms.
 *
 *  The result was not merely an unhelpful correction. It was the exact failure this module was
 *  written to prevent — a clock tens of seconds out — now applied deliberately, with confidence,
 *  to a device whose own clock had been fine.
 *
 *  `Age` is the proper fix and is handled below; this is the guard for caches that do not send it,
 *  which includes a browser serving its own stored copy. 3ms is under any real round trip to an
 *  origin and over any cache hit. The cost of being wrong is that a very fast local sample is
 *  skipped and the device clock is used, which is where we started. */
const MIN_PLAUSIBLE_RTT_MS = 3;

/** Below this, trust the device.
 *
 *  Two seconds is comfortably outside the measurement's own noise floor (a second of header
 *  resolution plus half a round trip) and comfortably inside what would change any decision we
 *  make. A phone within two seconds of us needs no correcting; correcting it anyway would only
 *  add our error to a clock that was fine. */
export const CLOCK_DEADBAND_MS = 2_000;

/** How long a sample stays authoritative on RTT alone.
 *
 *  Without this, the first fast reply of the session wins for ever — including across the phone
 *  being asleep in a pocket for an hour, which is when a device clock is most likely to have been
 *  quietly stepped by the OS. After this, the next sample is taken regardless of how its round
 *  trip compares. */
const SAMPLE_STALE_MS = 5 * 60_000;

let offsetMs = 0;
let bestRtt = Number.POSITIVE_INFINITY;
let takenAt = 0;
let haveSample = false;

/** Feed one response's `Date` header, with the instants the request left and the reply landed.
 *
 *  Never throws and never needs to be awaited: a header that is missing, unparseable or absurd
 *  simply leaves the previous estimate alone, and no estimate at all means the device clock,
 *  which is where we started. */
export function noteServerDate(header: string | null | undefined, sentAt: number, receivedAt: number,
                               ageHeader?: string | null): void {
  if (!header) return;
  const stamped = Date.parse(header);
  if (!Number.isFinite(stamped)) return;
  const rtt = receivedAt - sentAt;
  if (!(rtt >= MIN_PLAUSIBLE_RTT_MS) || rtt >= MAX_USABLE_RTT_MS) return;

  // `Date` says when the reply was GENERATED; `Age` says how long it has been sitting in caches
  // since. Adding them back together is what turns a cached reply into an honest reading of the
  // clock rather than a stale one — and every hop between us and the origin is required to
  // maintain it, so where it exists it is exact. A reply straight from the origin has no Age, or
  // Age: 0, and this is a no-op.
  const age = Number(ageHeader);
  const serverMs = stamped + (Number.isFinite(age) && age > 0 ? age * 1000 : 0);

  // The stamp is assumed to have been made halfway through the round trip, so the server's clock
  // at the moment the reply LANDED was about serverMs + rtt/2. The offset is what has to be added
  // to this device's clock to agree with that.
  const sample = serverMs + rtt / 2 - receivedAt;

  const stale = receivedAt - takenAt > SAMPLE_STALE_MS;
  if (haveSample && !stale && rtt >= bestRtt) return;

  offsetMs = sample;
  bestRtt = rtt;
  takenAt = receivedAt;
  haveSample = true;
}

/** The correction currently being applied, in milliseconds. 0 inside the dead band. */
export function serverOffsetMs(): number {
  return Math.abs(offsetMs) >= CLOCK_DEADBAND_MS ? Math.round(offsetMs) : 0;
}

/** Now, as the server would read it. Falls back to the device clock, exactly, when we have never
 *  managed to measure anything — which is the behaviour every caller had before this existed. */
export function serverNow(): number {
  return Date.now() + serverOffsetMs();
}

/** Have we actually measured anything, or is serverNow() just Date.now() in a hat? */
export function clockSynced(): boolean {
  return haveSample;
}

/** Tests only. */
export function resetServerClock(): void {
  offsetMs = 0;
  bestRtt = Number.POSITIVE_INFINITY;
  takenAt = 0;
  haveSample = false;
}
