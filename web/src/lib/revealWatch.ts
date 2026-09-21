// Making a locked gallery unlock ITSELF.
//
// The countdown was display-only: a text node fed by a 1s interval, watched by nothing. When it
// reached 00:00:00 it simply stayed there, and the lock wall stayed with it until the visitor
// thought to reload — which is the one thing a person staring at a countdown does not expect to
// have to do. Nothing polled either, so a `manual` reveal (no countdown at all) and a moderated
// gallery (revealed, but empty until the host approves) never updated at all.
//
// The logic lives here rather than in the two page components because it is timing code: it is
// wrong in ways nobody notices for months, and a component is not somewhere you can test "what
// happens when the phone's clock is three seconds fast".
//
// ── The clock-skew pad ──────────────────────────────────────────────────────────
// The server opens the gate on `Date.now() >= at` using ITS clock. The browser counts down against
// ITS own. Those disagree by seconds routinely — an unsynced phone, a laptop back from sleep — and
// the failure is asymmetric:
//
//   · a client that is SLOW asks late, and the answer is yes. Nothing is lost but a second.
//   · a client that is FAST asks early, is told `revealed: false`, and — with a single attempt —
//     would sit on the lock wall forever having already spent its one chance.
//
// So the first attempt waits past zero, and a no is retried rather than believed.

/** How long past the counted-down zero before asking the server at all.
 *
 *  5s covers ordinary client/server clock disagreement (NTP-unsynced phones are typically within a
 *  second or two) at the cost of 5s of dead air on a correct clock — which is invisible next to the
 *  round trip that follows it. Larger would start to feel like the page had missed the moment. */
export const REVEAL_SKEW_PAD_MS = 5_000;

/** How much RANDOM delay may be added on top of the pad, per client.
 *
 *  The pad alone is a constant, and a constant is a herd. Every guest holding the link counts down
 *  against the same instant, so without this they all ask within a second or two of each other —
 *  one spike of N requests at exactly `revealAt + 5s`, on the highest-fan-out surface in the
 *  product, at the one moment the origin is also serving the whole gallery body to everyone.
 *  Measured shape of that answer: ~49KB of JSON per guest at 1000 photos, which is what makes the
 *  crossing (not the poll) the request worth spreading.
 *
 *  12s because it is long enough to flatten the spike into a trickle — 150 guests over 12s is ~12/s
 *  rather than 150 at once — and short enough that the slowest-jittered guest is still inside the
 *  time it takes to look up from a phone. The pad's MINIMUM is untouched: this only ever ADDS, so
 *  the 5s of clock-skew cover is still there for every client.
 *
 *  The slow poll has carried a +/-20% spread since it was written, for exactly this reason (see
 *  JITTER below). The crossing did not, and the crossing is the sharper of the two spikes. */
export const REVEAL_PAD_JITTER_MS = 12_000;

/** The pad THIS client will wait, given a random number in [0,1).
 *
 *  Additive, never multiplicative: the pad exists to cover clock skew and must not be allowed to
 *  shrink below `base` for an unlucky client, which is exactly what a +/-% spread would do. */
export function revealPadMs(rand: number, base: number = REVEAL_SKEW_PAD_MS): number {
  const r = Math.min(1, Math.max(0, rand));
  return base + Math.round(r * REVEAL_PAD_JITTER_MS);
}

/** How many times we ask before giving up and leaving it to the slow poll.
 *
 *  A cap is the whole point: a client whose clock is an hour fast would otherwise retry for an hour
 *  at whatever cadence, for every visitor holding the link. Five attempts spread over ~80s past
 *  zero, which is far more skew than a real clock has. Anything worse than that is not skew, it is
 *  a wrong clock, and the 45s poll is the right instrument for it. */
export const REVEAL_MAX_ATTEMPTS = 5;

const RETRY_BASE_MS = 5_000;
const RETRY_CAP_MS = 60_000;

/** Delay before the next attempt, given how many have already been made (1 after the first).
 *  5s, 10s, 20s, 40s — doubling, so an honestly-early client is caught within seconds while a
 *  hopeless one backs off instead of hammering.
 *
 *  This is the BASE. createRevealWatch spreads it through jitterMs() before waiting on it: without
 *  that, a herd whose first attempt failed together simply retries together, and the backoff turns
 *  one spike into four. */
export function revealRetryDelayMs(attemptsMade: number): number {
  const n = Math.max(1, Math.floor(attemptsMade));
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (n - 1));
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface RevealWatch {
  /** Feed it the clock and the moment. Safe to call every second — it acts at most once per
   *  distinct `revealAt`, and re-arms by itself if the host moves the moment. */
  tick(revealAt: number | null): void;
  /** Tear down (component destroyed). */
  stop(): void;
  /** How many refetches it has made for the current moment. Test/debug surface. */
  readonly attempts: number;
  /** True once it has either succeeded or spent its attempts. */
  readonly settled: boolean;
}

export interface RevealWatchOptions {
  /** Refetch, and answer whether the server now says revealed. Must not throw — but is guarded. */
  attempt: () => Promise<boolean>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
  padMs?: number;
  maxAttempts?: number;
  /** Injectable so the spread can be tested, and so a test can ask for no spread at all. */
  rand?: () => number;
}

/** A one-shot-per-crossing refetcher with a skew pad and a capped backoff. */
export function createRevealWatch(opts: RevealWatchOptions): RevealWatch {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
  const padMs = opts.padMs ?? REVEAL_SKEW_PAD_MS;
  const maxAttempts = opts.maxAttempts ?? REVEAL_MAX_ATTEMPTS;
  const rand = opts.rand ?? (() => Math.random());

  // `armedFor` is what makes "exactly once per crossing" true: the moment being watched. A tick
  // carrying the same moment after the crossing does nothing; a tick carrying a DIFFERENT one (the
  // host rescheduled, or a refetch filled in a revealAt we did not have) starts the whole thing
  // over, which is the only sane reading of "the moment changed".
  let armedFor: number | null | undefined;
  let fired = false;
  let attempts = 0;
  let settled = false;
  let handle: TimerHandle | undefined;
  let stopped = false;
  // Which arming an in-flight attempt belongs to.
  //
  // cancel() can only take back a TIMER. An attempt that is already awaiting the network is not a
  // timer, and it used to come back and write into whatever arming had replaced it: a tick carrying
  // a new moment (the host rescheduled, or a refetch filled in a revealAt we did not have) reset
  // `attempts`, cleared `fired` and scheduled the new crossing — and then the old attempt resolved
  // and either marked the fresh arming `settled` (so the new moment was never watched at all) or
  // called schedule(), whose cancel() threw away the new crossing timer and replaced it with a retry
  // for the moment that no longer exists. Both outcomes are the same bug from opposite ends: the
  // transition dropped, or two watches running over one handle.
  //
  // A counter rather than a flag because the arming can change twice inside one request.
  let gen = 0;

  function cancel() {
    if (handle !== undefined) { clearTimer(handle); handle = undefined; }
  }

  function schedule(ms: number) {
    cancel();
    handle = setTimer(run, ms);
  }

  async function run() {
    handle = undefined;
    if (stopped) return;
    const myGen = gen;
    attempts += 1;
    let ok = false;
    // A refetch that fails (offline, a 502) is a "no" like any other — it must not settle the
    // watch, because the retry is exactly what covers it.
    try { ok = await opts.attempt(); } catch { ok = false; }
    // Re-armed while this was in flight: every variable below now belongs to a different moment,
    // and the new arming has already scheduled itself. Drop this answer on the floor.
    if (stopped || myGen !== gen) return;
    if (ok || attempts >= maxAttempts) { settled = true; return; }
    schedule(jitterMs(revealRetryDelayMs(attempts), rand()));
  }

  return {
    tick(revealAt: number | null) {
      if (stopped) return;
      if (revealAt !== armedFor) {
        armedFor = revealAt;
        fired = false; settled = false; attempts = 0;
        // Before cancel(), and covering what cancel() cannot: an attempt already awaiting its
        // refetch belongs to the arming that is being replaced.
        gen += 1;
        cancel();
      }
      if (revealAt === null || fired) return;
      if (now() < revealAt) return;
      fired = true;
      // Jittered HERE rather than at the call sites: the spread has to be re-rolled per
      // crossing (a host who reschedules re-arms the watch), and a value computed once in a
      // component would hand every re-arm the same offset.
      schedule(revealPadMs(rand(), padMs));
    },
    stop() {
      stopped = true; settled = true;
      cancel();
    },
    get attempts() { return attempts; },
    get settled() { return settled; },
  };
}

// ── The slow poll ───────────────────────────────────────────────────────────────
//
// The crossing watcher above only helps an event that unlocks on a clock. Two cases never reach a
// zero at all:
//
//   · `manual` reveal — `scheduledRevealAt` is null, so there is no moment and no countdown. The
//     host presses a button, somewhere else, whenever they like.
//   · moderation — moderation is a WHERE clause, not a gate, so a moderated event that HAS revealed
//     answers `revealed: true, photos: []`. A guest watching the host approve ninety photos sees a
//     flat empty state the whole time.
//
// Both want the same cheap thing: ask again, slowly, only while there is something to learn.

/** Base interval between polls.
 *
 *  45s, and the number is a compromise between two real costs rather than a round guess:
 *
 *   · The event gallery is the highest-fan-out surface in the product. One host shares one link
 *     with every guest at once, so this interval is multiplied by the whole guest list — a 200-
 *     person wedding sitting on the lock wall is ~4.4 req/s sustained at 45s, ~6.7 at 30s. The
 *     pre-reveal answer is a single COUNT, which is why any of this is affordable at all.
 *   · The moderated case is watched by people standing next to the host: a minute of nothing after
 *     "I've approved them" reads as broken, so 60s is too slow at the moment it matters most.
 *
 *  It was 45s, chosen as a compromise between those two and on the understanding that it was the
 *  whole delay. It was not. The reply to a poll was itself shared-cacheable for 30s, so the real
 *  worst case a guest experienced was the interval PLUS the TTL — 84s at 45s jittered — and a host
 *  who pressed "Reveal all now" in front of an open gallery watched it sit there for over a
 *  minute. The cache is now skipped while the gallery is locked (see `knownLocked` in the gallery
 *  page), which removes the invisible half of that; 30s removes most of the visible half, and puts
 *  the worst case at 36s rather than 84s.
 *
 *  The cost of the change is smaller than the original 45-vs-30 note implies, because that note
 *  was written about an interval whose replies were being shared between guests. They are not, now,
 *  while locked — so what this multiplies is a single count per guest, which is the cheapest thing
 *  the API serves and the reason polling is affordable here at all. 200 guests on a locked gallery
 *  is ~6.7 req/s of counts against a stack measured at ~850 req/s.
 *
 *  Backgrounded tabs poll not at all (see the visibility handling in the pages), which is where
 *  most of the saving actually comes from — a gallery link left open on a phone in a pocket is the
 *  common case. */
export const GALLERY_POLL_MS = 30_000;

/** ±20% spread on every delay.
 *
 *  Without it, a host texting the link to eighty people produces eighty clients whose polls are
 *  aligned to within the few seconds it took everyone to tap it — and they stay aligned forever,
 *  arriving as one spike every 45s rather than as a flat trickle. */
const JITTER = 0.2;

/** `ms`, spread +/-JITTER by a random number in [0,1). The ONE place the spread is computed, so the
 *  slow poll and the reveal retry cannot drift apart on what "jittered" means. */
export function jitterMs(ms: number, rand: number): number {
  const r = Math.min(1, Math.max(0, rand));
  return Math.round(ms * (1 + (r * 2 - 1) * JITTER));
}

/** The slow tier, used while a SCHEDULED reveal is still far away.
 *
 *  A 45s heartbeat against a reveal six hours out is ~480 requests per guest to learn nothing: the
 *  crossing watcher already handles the scheduled moment itself, to the second. The only thing
 *  polling adds before then is catching a host who reveals EARLY by hand — worth catching, not
 *  worth 480 requests. Five minutes bounds that surprise while costing ~1/7th as much.
 *
 *  It applies ONLY when there is a moment to be far from. `manual` events and the
 *  moderation-in-progress case have no scheduled instant, so polling is their only signal and they
 *  stay on the fast tier. */
export const GALLERY_POLL_FAR_MS = 300_000;

/** Far enough away that the fast tier is buying nothing. Comfortably more than one fast interval,
 *  so a client near the boundary cannot flip tiers back and forth between ticks. */
const FAR_THRESHOLD_MS = 600_000;

/** Which cadence applies right now. */
export function galleryPollBaseMs(s: {
  revealed: boolean;
  revealAt: number | null;
  now: number;
}): number {
  if (!s.revealed && s.revealAt !== null && s.revealAt - s.now > FAR_THRESHOLD_MS) return GALLERY_POLL_FAR_MS;
  return GALLERY_POLL_MS;
}

/** One poll delay, jittered. `rand` is injectable so the spread can actually be tested. */
export function galleryPollDelayMs(rand: number = Math.random(), base: number = GALLERY_POLL_MS): number {
  return jitterMs(base, rand);
}

/** Is there anything left to learn by asking again?
 *
 *  Not revealed → yes, always: that covers `manual` (no moment to cross), a host who reveals early,
 *  and a client whose clock was wrong enough that the crossing watcher gave up.
 *  Revealed but empty WITH moderation on, AND something actually waiting → yes: the host is still
 *  approving, and every approval changes the answer.
 *  Revealed with photos → no. Stop. New photos arriving mid-event is what the event's own camera
 *  screen is for; a shared gallery is not a live feed and must not become one.
 *
 *  ── The state that had no way out ─────────────────────────────────────────────
 *  A moderated event that IS revealed and has no photos at all — nobody came, or nobody shot
 *  anything — used to poll every 45 seconds for the rest of the page's life. There was no cap and
 *  no terminal state, and the client had nothing to stop on: the revealed branch of the endpoint
 *  did not carry a count, so "the host is still approving ninety photos" and "this event is empty"
 *  arrived as the same answer. It assumed the former, said "the host is still approving photos" to
 *  someone at an event where nobody had taken any, and kept asking for ever.
 *
 *  `pendingCount` is that missing signal, and it is what makes the state terminal rather than
 *  merely capped: zero pending means there is genuinely nothing coming, and the page can say so
 *  honestly instead of blaming a host who has nothing to approve.
 *
 *  `undefined` — a server too old to send it, or a cached body from one — keeps the old behaviour
 *  of polling. A silent stop is the wrong way to handle "I don't know". */
export function shouldPollGallery(s: {
  revealed: boolean;
  photoCount: number;
  moderationEnabled?: boolean;
  pendingCount?: number;
}): boolean {
  if (!s.revealed) return true;
  if (!s.moderationEnabled || s.photoCount !== 0) return false;
  return s.pendingCount === undefined || s.pendingCount > 0;
}
