// The gallery unlocking itself is timing code, and timing code rots silently: nothing throws when a
// reveal stops firing, the page just sits there looking like it is still waiting. These tests pin
// the three things that are actually load-bearing — it fires once, it waits out clock skew, and it
// gives up rather than spinning.
import { describe, it, expect, vi } from 'vitest';
import { createRevealWatch, revealRetryDelayMs, shouldPollGallery, galleryPollDelayMs, jitterMs, revealPadMs, REVEAL_SKEW_PAD_MS, REVEAL_PAD_JITTER_MS, REVEAL_MAX_ATTEMPTS, GALLERY_POLL_MS, galleryPollBaseMs, GALLERY_POLL_FAR_MS } from './revealWatch';

/** Every watch below is built with `rand: () => 0` — no spread — because the assertions are
 *  "how long did it wait", and a random addend makes that unanswerable. The spread is real in
 *  production and is pinned on its own in "the thundering herd" further down.
 */
/** A hand-cranked clock + timer queue. Real fake timers would work, but the interesting assertions
 *  are "how long did it wait", and a queue answers that directly. */
function harness() {
  let clock = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  return {
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ at: clock + ms, fn, id });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (h: ReturnType<typeof setTimeout>) => {
      const i = timers.findIndex((t) => t.id === (h as unknown as number));
      if (i >= 0) timers.splice(i, 1);
    },
    /** Move time forward, running anything due. Returns after the microtask queue drains. */
    async advance(ms: number) {
      const target = clock + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        clock = due.at;
        due.fn();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      }
      clock = target;
    },
    pending: () => timers.length,
  };
}

describe('the reveal crossing', () => {
  it('does nothing at all before the moment', async () => {
    const h = harness();
    const attempt = vi.fn(async () => true);
    const w = createRevealWatch({ attempt, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, rand: () => 0 });
    for (let i = 0; i < 30; i++) { w.tick(60_000); await h.advance(1000); }
    expect(attempt).not.toHaveBeenCalled();
  });

  it('waits out the skew pad before asking — a phone 2s fast must not ask early', async () => {
    const h = harness();
    const attempt = vi.fn(async () => true);
    const w = createRevealWatch({ attempt, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, rand: () => 0 });
    // The client's own clock reaches the moment. The server's may not have.
    w.tick(0);
    await h.advance(REVEAL_SKEW_PAD_MS - 1);
    expect(attempt).not.toHaveBeenCalled();
    await h.advance(1);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('fires exactly once per crossing, not once per tick', async () => {
    const h = harness();
    // Says no forever, so nothing settles it early — the only thing stopping a second FIRING is
    // the crossing guard itself.
    const attempt = vi.fn(async () => false);
    const w = createRevealWatch({ attempt, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, rand: () => 0 });
    for (let i = 0; i < 20; i++) { w.tick(0); await h.advance(1000); }
    // 20s past zero: the pad (5s) and the first two backoffs (5s, 10s) have elapsed. Three asks,
    // not twenty.
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('stops asking the moment the server agrees', async () => {
    const h = harness();
    let revealed = false;
    const attempt = vi.fn(async () => revealed);
    const w = createRevealWatch({ attempt, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, rand: () => 0 });
    w.tick(0);
    await h.advance(REVEAL_SKEW_PAD_MS);        // attempt 1 — server still says no
    expect(w.settled).toBe(false);
    revealed = true;
    await h.advance(5_000);                      // attempt 2 — yes
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(w.settled).toBe(true);
    await h.advance(600_000);
    expect(attempt).toHaveBeenCalledTimes(2);    // and never again
    expect(h.pending()).toBe(0);
  });

  it('gives up after the cap so a wrong clock cannot spin forever', async () => {
    const h = harness();
    const attempt = vi.fn(async () => false);
    const w = createRevealWatch({ attempt, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, rand: () => 0 });
    w.tick(0);
    await h.advance(3_600_000);                  // an hour-fast clock
    expect(attempt).toHaveBeenCalledTimes(REVEAL_MAX_ATTEMPTS);
    expect(w.settled).toBe(true);
    expect(h.pending()).toBe(0);
  });

  it('treats a failed refetch as a no and keeps its retries', async () => {
    const h = harness();
    let calls = 0;
    const attempt = vi.fn(async () => { calls++; if (calls < 3) throw new Error('offline'); return true; });
    const w = createRevealWatch({ attempt, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, rand: () => 0 });
    w.tick(0);
    await h.advance(60_000);
    expect(calls).toBe(3);
    expect(w.settled).toBe(true);
  });

  it('never fires for a manual reveal, which has no moment', async () => {
    const h = harness();
    const attempt = vi.fn(async () => true);
    const w = createRevealWatch({ attempt, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, rand: () => 0 });
    for (let i = 0; i < 50; i++) { w.tick(null); await h.advance(1000); }
    expect(attempt).not.toHaveBeenCalled();
  });

  it('re-arms when the host moves the moment', async () => {
    const h = harness();
    const attempt = vi.fn(async () => false);
    const w = createRevealWatch({ attempt, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, rand: () => 0 });
    w.tick(0);
    await h.advance(3_600_000);
    expect(w.attempts).toBe(REVEAL_MAX_ATTEMPTS);
    // A refetch comes back with a later reveal time. That is a new crossing, not the old one.
    const later = h.now() + 10_000;
    w.tick(later);
    expect(w.attempts).toBe(0);
    for (let i = 0; i < 16; i++) { w.tick(later); await h.advance(1000); }
    expect(w.attempts).toBe(1);
  });

  it('asks straight away when the page is opened after the moment has passed', async () => {
    const h = harness();
    const attempt = vi.fn(async () => true);
    const w = createRevealWatch({ attempt, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, rand: () => 0 });
    w.tick(-60_000);                             // reveal time was a minute ago
    await h.advance(REVEAL_SKEW_PAD_MS);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('stop() drops a pending retry', async () => {
    const h = harness();
    const attempt = vi.fn(async () => false);
    const w = createRevealWatch({ attempt, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, rand: () => 0 });
    w.tick(0);
    await h.advance(REVEAL_SKEW_PAD_MS);
    expect(attempt).toHaveBeenCalledTimes(1);
    w.stop();
    expect(h.pending()).toBe(0);
    await h.advance(600_000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('the retry backoff', () => {
  it('doubles from 5s and is capped', () => {
    expect(revealRetryDelayMs(1)).toBe(5_000);
    expect(revealRetryDelayMs(2)).toBe(10_000);
    expect(revealRetryDelayMs(3)).toBe(20_000);
    expect(revealRetryDelayMs(4)).toBe(40_000);
    expect(revealRetryDelayMs(99)).toBe(60_000);
  });

  it('spends its whole budget inside ~80s past zero', () => {
    let total = REVEAL_SKEW_PAD_MS;
    for (let n = 1; n < REVEAL_MAX_ATTEMPTS; n++) total += revealRetryDelayMs(n);
    expect(total).toBe(80_000);
  });
});

describe('when the slow poll should run', () => {
  it('runs while the gallery is locked — manual reveal has no countdown to cross', () => {
    expect(shouldPollGallery({ revealed: false, photoCount: 0 })).toBe(true);
  });

  it('runs on a revealed-but-empty MODERATED gallery — the host is still approving', () => {
    expect(shouldPollGallery({ revealed: true, photoCount: 0, moderationEnabled: true })).toBe(true);
  });

  it('stops once photos arrive', () => {
    expect(shouldPollGallery({ revealed: true, photoCount: 12, moderationEnabled: true })).toBe(false);
  });

  it('does not poll an unmoderated event that simply has no photos', () => {
    expect(shouldPollGallery({ revealed: true, photoCount: 0, moderationEnabled: false })).toBe(false);
    expect(shouldPollGallery({ revealed: true, photoCount: 0 })).toBe(false);
  });

  it('stops when a moderated gallery is revealed, empty, and there is nothing in the queue', () => {
    // The state that had no way out. Nobody took a photo; the host has nothing to approve; the page
    // said "the host is still approving photos" and asked again every 45 seconds for the life of
    // the tab. There was no cap and no terminal state, and the client had no signal to stop on
    // because the revealed branch of the endpoint carried no count.
    expect(shouldPollGallery({ revealed: true, photoCount: 0, moderationEnabled: true, pendingCount: 0 })).toBe(false);
  });

  it('...but keeps going while the host still has a queue', () => {
    expect(shouldPollGallery({ revealed: true, photoCount: 0, moderationEnabled: true, pendingCount: 1 })).toBe(true);
    expect(shouldPollGallery({ revealed: true, photoCount: 0, moderationEnabled: true, pendingCount: 90 })).toBe(true);
  });

  it('a server that does not send the count is asked again, not abandoned', () => {
    // An older server, or a body served from a cache that predates the field. "I don't know" must
    // not be answered with a silent stop — that is the original bug with the sign flipped.
    expect(shouldPollGallery({ revealed: true, photoCount: 0, moderationEnabled: true })).toBe(true);
    expect(shouldPollGallery({ revealed: true, photoCount: 0, moderationEnabled: true, pendingCount: undefined })).toBe(true);
  });

  it('a pending queue does not restart polling once photos are actually showing', () => {
    // Revealed with photos is terminal regardless: a shared gallery is not a live feed. A host who
    // approves more later is not a reason to poll — the page has already done its job.
    expect(shouldPollGallery({ revealed: true, photoCount: 12, moderationEnabled: true, pendingCount: 40 })).toBe(false);
  });
});

describe('the poll cadence', () => {
  it('sits within ±20% of the base', () => {
    expect(galleryPollDelayMs(0)).toBe(GALLERY_POLL_MS * 0.8);
    expect(galleryPollDelayMs(0.5)).toBe(GALLERY_POLL_MS);
    expect(galleryPollDelayMs(1)).toBe(GALLERY_POLL_MS * 1.2);
  });

  it('spreads a crowd that all opened the link at once', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) seen.add(galleryPollDelayMs(i / 50));
    expect(seen.size).toBeGreaterThan(40);
  });

  it('stays inside the window the surface can afford', () => {
    // Was "between 30s and 60s", around a 45s base. The base is 30s now, and the change was not a
    // preference: the poll's REPLY was itself shared-cacheable for 30s, so the delay a guest
    // actually experienced was the interval plus the TTL — up to 84s — and a host pressing
    // "Reveal all now" in front of an open gallery watched it sit there for over a minute. The
    // cache is skipped while the gallery is locked now (the reply is a single count), which
    // removes the hidden half; 30s removes most of the visible half.
    //
    // The floor is what keeps this honest in the other direction: this interval is multiplied by
    // every guest holding the link, so it must never quietly become a live feed.
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const d = galleryPollDelayMs(r);
      // The ACTUAL jittered range at a 30s base is 24-36s. The first version of this bounded it
      // at 20-40s, which is looser than the 30-60s it replaced and would let the base drift to
      // 25s or 33s unnoticed — a test that permits the thing it exists to watch.
      expect(d).toBeGreaterThanOrEqual(24_000);
      expect(d).toBeLessThanOrEqual(36_000);
    }
  });
});


describe('how often to ask again', () => {
  const now = 1_700_000_000_000;

  it('drops to the slow tier while a scheduled reveal is still hours away', () => {
    // 45s against a reveal six hours out is ~480 requests per guest to learn nothing — the
    // crossing watcher already handles the scheduled moment itself.
    expect(galleryPollBaseMs({ revealed: false, revealAt: now + 6 * 3600_000, now })).toBe(GALLERY_POLL_FAR_MS);
  });

  it('is back on the fast tier once the reveal is close', () => {
    expect(galleryPollBaseMs({ revealed: false, revealAt: now + 60_000, now })).toBe(GALLERY_POLL_MS);
  });

  it('stays fast when there is no scheduled moment to be far from', () => {
    // `manual` events have no instant to cross, so polling is their ONLY signal that the host
    // pressed reveal. Slowing these down would be slowing down the only thing that works.
    expect(galleryPollBaseMs({ revealed: false, revealAt: null, now })).toBe(GALLERY_POLL_MS);
  });

  it('stays fast for moderation-in-progress, which is revealed but still filling', () => {
    // Watched by someone standing next to the host; five minutes would read as broken.
    expect(galleryPollBaseMs({ revealed: true, revealAt: now - 10_000, now })).toBe(GALLERY_POLL_MS);
  });

  it('does not flip tiers back and forth near the boundary', () => {
    // The threshold sits well beyond one fast interval, so a client either side of it cannot
    // oscillate between cadences from one tick to the next.
    const justFar = galleryPollBaseMs({ revealed: false, revealAt: now + 600_001, now });
    const justNear = galleryPollBaseMs({ revealed: false, revealAt: now + 599_999, now });
    expect(justFar).toBe(GALLERY_POLL_FAR_MS);
    expect(justNear).toBe(GALLERY_POLL_MS);
    expect(GALLERY_POLL_FAR_MS).toBeGreaterThan(GALLERY_POLL_MS * 2);
  });
});


// ── The thundering herd ─────────────────────────────────────────────────────────
//
// Everything above asks whether ONE client does the right thing. This asks what N of them do at
// once, which is the only question the reveal actually poses: one host shares one link with every
// guest, every phone counts down to the same instant, and the answer at that instant is the whole
// gallery body (~49KB at 1000 photos). A constant pad means they all ask together.
describe('the reveal crossing does not arrive as a herd', () => {
  it('adds to the pad and never subtracts from it — the 5s of skew cover is a floor', () => {
    for (const r of [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1]) {
      expect(revealPadMs(r)).toBeGreaterThanOrEqual(REVEAL_SKEW_PAD_MS);
    }
    // ...and an out-of-range rand cannot shrink it either.
    expect(revealPadMs(-5)).toBe(REVEAL_SKEW_PAD_MS);
    expect(revealPadMs(2)).toBe(REVEAL_SKEW_PAD_MS + REVEAL_PAD_JITTER_MS);
  });

  it('spreads a hundred guests across the window instead of stacking them on one second', () => {
    // A hundred clients, each with its own random number, all crossing the same instant.
    const fire = Array.from({ length: 100 }, (_, i) => revealPadMs(i / 100));
    const min = Math.min(...fire), max = Math.max(...fire);
    expect(min).toBe(REVEAL_SKEW_PAD_MS);
    expect(max).toBeGreaterThanOrEqual(REVEAL_SKEW_PAD_MS + REVEAL_PAD_JITTER_MS * 0.98);
    // The spike test: no single second holds more than a small fraction of the guest list. Without
    // jitter this is 100 in one second.
    const perSecond = new Map<number, number>();
    for (const t of fire) perSecond.set(Math.floor(t / 1000), (perSecond.get(Math.floor(t / 1000)) ?? 0) + 1);
    expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(100 / (REVEAL_PAD_JITTER_MS / 1000) + 2);
  });

  it('jitters the RETRY too — a herd that failed together must not retry together', () => {
    // The failure this guards: every client is told "not yet" by the same over-loaded origin, and
    // an unjittered backoff hands that origin the identical spike again 5s later, then 10s, then 20s.
    const base = revealRetryDelayMs(1);
    const spread = new Set(Array.from({ length: 50 }, (_, i) => jitterMs(base, i / 50)));
    expect(spread.size).toBeGreaterThan(10);
    for (const d of spread) {
      expect(d).toBeGreaterThanOrEqual(base * 0.8);
      expect(d).toBeLessThanOrEqual(base * 1.2);
    }
  });

  it('is the same spread the slow poll has always used — one definition, not two', () => {
    for (const r of [0, 0.3, 0.5, 0.77, 1]) {
      expect(galleryPollDelayMs(r, GALLERY_POLL_MS)).toBe(jitterMs(GALLERY_POLL_MS, r));
    }
  });

  it('a refetch that HANGS still moves the backoff on, instead of stalling on attempt 1', async () => {
    // `fetch` has no timeout of its own, so before api() grew one a saturated origin meant
    // `attempt()` never settled — and this watch would sit on attempt 1 for the life of the page,
    // holding its one crossing and never reaching the retries that exist to cover it. The contract
    // this depends on is that api() rejects at API_TIMEOUT_MS and the attempt's own catch turns
    // that into a "no" (see api.test.ts, "a request that never finishes").
    const h = harness();
    let live = 0;
    const attempt = vi.fn(async () => {
      live += 1;
      // A request that only ever ends by timing out — modelled as the rejection api() produces.
      await Promise.reject(new Error('timeout'));
      return true;
    });
    const w = createRevealWatch({ attempt, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, rand: () => 0.5 });
    w.tick(0);
    // rand fixed at 0.5, so this client's pad is exactly the middle of the jitter window.
    await h.advance(revealPadMs(0.5));
    expect(live).toBe(1);
    // ...and it keeps going rather than stopping at the first hang.
    for (let i = 0; i < 5; i++) await h.advance(120_000);
    expect(w.attempts).toBe(REVEAL_MAX_ATTEMPTS);
    expect(w.settled).toBe(true);
    expect(h.pending()).toBe(0);
  });

  it('actually waits the jittered pad, not the bare one', async () => {
    const h = harness();
    const attempt = vi.fn(async () => true);
    // rand fixed at the top of the range: this client waits pad + the whole jitter window.
    const w = createRevealWatch({ attempt, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, rand: () => 1 });
    w.tick(0);
    await h.advance(REVEAL_SKEW_PAD_MS + REVEAL_PAD_JITTER_MS - 1);
    expect(attempt).not.toHaveBeenCalled();
    await h.advance(1);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

// ── Re-arming while a refetch is still out ───────────────────────────────

describe('the re-arm race', () => {
  it('drops an attempt whose moment was replaced under it', async () => {
    const h = harness();
    let release!: (v: boolean) => void;
    const attempt = vi.fn(() => new Promise<boolean>((res) => { release = res; }));
    const w = createRevealWatch({ attempt, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, rand: () => 0 });

    // Cross the moment and let the refetch go out. It hangs: a slow network, which is the whole
    // window this bug lives in.
    w.tick(0);
    await h.advance(REVEAL_SKEW_PAD_MS);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(h.pending()).toBe(0);

    // The host reschedules — or a refetch fills in a revealAt we did not have — while the request
    // is in flight. cancel() can take back a timer; it cannot take back an awaited promise.
    w.tick(3_600_000);
    expect(h.pending()).toBe(0);            // an hour away: nothing armed yet

    // ...and now the OLD request answers "not yet".
    release(false);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // It must not schedule a retry for the moment that no longer exists: that cancel()s the new
    // arming's timer and puts the watch back on the old one.
    expect(h.pending()).toBe(0);
    // ...nor count against, nor settle, the arming it does not belong to.
    expect(w.attempts).toBe(0);
    expect(w.settled).toBe(false);

    // And the moment that IS armed still fires.
    await h.advance(3_600_000);
    w.tick(3_600_000);
    await h.advance(REVEAL_SKEW_PAD_MS);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('still retries when nothing was re-armed', async () => {
    // The guard must not swallow the ordinary case: a genuine "not yet" on the SAME moment is what
    // the backoff exists for.
    const h = harness();
    const attempt = vi.fn(async () => false);
    const w = createRevealWatch({ attempt, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, rand: () => 0 });
    w.tick(0);
    await h.advance(REVEAL_SKEW_PAD_MS);
    expect(attempt).toHaveBeenCalledTimes(1);
    await h.advance(revealRetryDelayMs(1));
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

// ── Which number the poll decision is entitled to ────────────────────────

describe('shouldPollGallery counts the EVENT, not the view', () => {
  it('stops once the event has photos, even when the current filter shows none', () => {
    // The gallery page passes this. It used to pass `photos.length`, which is the list AFTER
    // ?highlightsOnly — so a moderated event with a queue and nothing starred read as an empty
    // gallery and polled for a change that view could never show. The server sends `photoCount`
    // counted without the filter for exactly this decision.
    expect(shouldPollGallery({ revealed: true, photoCount: 50, moderationEnabled: true, pendingCount: 9 }))
      .toBe(false);
    expect(shouldPollGallery({ revealed: true, photoCount: 0, moderationEnabled: true, pendingCount: 9 }))
      .toBe(true);
  });
});
