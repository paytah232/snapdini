// These messages are shown to GUESTS, in a toast, at a party. Someone who had just taken a photo
// saw "Request failed (502)" and had no way to know whether their photo was lost. A status code is
// for us; it belongs on the error object, not on the screen.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiError, requestDeadline, API_TIMEOUT_MS } from './api';

const respond = (status: number, body: unknown, ok = status >= 200 && status < 300) => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok, status,
    json: async () => { if (body === undefined) throw new Error('not json'); return body; },
  })));
};

afterEach(() => vi.unstubAllGlobals());

/** The rejection, typed — `.catch(e => e)` alone gives `unknown` and every assertion then fails to
 *  compile rather than to run. */
const failure = async (path = '/x'): Promise<ApiError> =>
  (await api(path).catch((e: unknown) => e)) as ApiError;

describe('what a failed request tells the person using it', () => {
  it('never puts a bare status code on the screen', async () => {
    for (const status of [400, 401, 404, 413, 429, 500, 502, 503, 504]) {
      respond(status, undefined);   // a proxy's HTML page — no JSON to read
      const err = await failure();
      expect(err).toBeInstanceOf(ApiError);
      expect(err.message).not.toMatch(/\d{3}/);
      expect(err.message.length).toBeGreaterThan(10);
    }
  });

  it('says a 502 is temporary, because the guest did nothing and can do nothing', async () => {
    respond(502, undefined);
    const err = await failure();
    expect(err.message).toMatch(/busy|try again shortly/i);
  });

  it('keeps the status on the error for the console and client_errors', async () => {
    respond(503, undefined);
    const err = await failure();
    expect(err.status).toBe(503);
  });

  it('prefers the server’s own words when it sent any', async () => {
    // Our API writes these for people already — replacing them would be a downgrade.
    respond(400, { error: 'That email doesn’t look right' });
    const err = await failure();
    expect(err.message).toBe('That email doesn’t look right');
    expect(err.status).toBe(400);
  });

  it('turns a dropped connection into something readable', async () => {
    // Browsers disagree here: "Failed to fetch", "Load failed", "NetworkError when attempting…".
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const err = await failure();
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/connection/i);
    expect(err.message).not.toMatch(/fetch/i);
  });

  it('returns the body untouched when the request worked', async () => {
    respond(200, { hello: 'there' });
    await expect(api('/x')).resolves.toEqual({ hello: 'there' });
  });

  it('treats a 200 with an unreadable body as empty rather than throwing', async () => {
    respond(200, undefined);
    await expect(api('/x')).resolves.toEqual({});
  });
});

// ── A request that never finishes ───────────────────────────────────────────────
//
// `fetch` has no timeout of its own. A REFUSED connection rejects and every caller handles it; a
// saturated origin accepts the socket and sends nothing, and the promise simply never settles.
// Nothing throws, so nothing is caught — and the gallery's whole retry loop is a `.catch()`:
// `loadPhotos().catch(() => schedulePoll())`. One stalled request and the page stops polling for
// good, keeping its last state and looking perfectly fine.
//
// Tested on a hand-cranked clock rather than by waiting twenty seconds for each case.
function clock() {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    setTimer: (fn: () => void, ms: number) => { const id = next++; timers.push({ at: now + ms, fn, id }); return id as unknown; },
    clearTimer: (h: unknown) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
    async advance(ms: number) {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) { timers.splice(timers.indexOf(t), 1); t.fn(); }
      for (let i = 0; i < 6; i++) await Promise.resolve();
    },
    pending: () => timers.length,
  };
}

/** A fetch that honours the abort signal and otherwise never answers — a saturated origin. */
const hangs = () => vi.stubGlobal('fetch', vi.fn((_p: string, init?: RequestInit) => new Promise((_res, rej) => {
  init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
})));

describe('a request that never finishes', () => {
  it('rejects rather than hanging for ever, and lands in the ordinary catch path', async () => {
    const c = clock();
    hangs();
    let caught: unknown;
    let retried = false;
    // Exactly the shape the gallery uses.
    const p = api('/api/photos/X?gallery=true', { setTimer: c.setTimer, clearTimer: c.clearTimer })
      .catch((e) => { caught = e; retried = true; });
    await c.advance(API_TIMEOUT_MS - 1);
    expect(retried).toBe(false);          // still waiting — it has not given up early
    await c.advance(1);
    await p;
    expect(retried).toBe(true);           // ...and the caller's retry actually ran
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(408);
    expect((caught as ApiError).message).toMatch(/too long/i);
    expect((caught as ApiError).message).not.toMatch(/\d{3}/);   // never a bare status on screen
  });

  it('a body that is CUT OFF is an error, not an empty success', async () => {
    // The dangerous one. `res.json()` failing used to read as `{}`, which reaches the gallery as
    // `photos = data.photos ?? []` — an empty successful response that wipes the screen. A body
    // that merely is not JSON still reads as empty (204s rely on it); a body we gave up on does not.
    const c = clock();
    vi.stubGlobal('fetch', vi.fn(async (_p: string, init?: RequestInit) => ({
      ok: true, status: 200,
      // `aborted` is checked FIRST, not just listened for: by the time api() gets round to reading
      // the body the deadline may already have fired, and addEventListener on a signal that has
      // already aborted never calls you.
      json: () => new Promise((_r, rej) => {
        const fail = () => rej(new DOMException('aborted', 'AbortError'));
        if (init?.signal?.aborted) fail();
        else init?.signal?.addEventListener('abort', fail);
      }),
    })));
    const p = api('/x', { setTimer: c.setTimer, clearTimer: c.clearTimer }).catch((e: unknown) => e);
    // Let api() get as far as reading the body before the clock runs out — the point of the test is
    // a body that stalls MID-READ, not one that never starts.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await c.advance(API_TIMEOUT_MS);
    const err = (await p) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(408);
  });

  it('does not leave a timer behind when the request succeeds', async () => {
    const c = clock();
    respond(200, { ok: true });
    await api('/x', { setTimer: c.setTimer, clearTimer: c.clearTimer });
    expect(c.pending()).toBe(0);
  });

  it('does not leave a timer behind when the request fails', async () => {
    const c = clock();
    respond(500, undefined);
    await api('/x', { setTimer: c.setTimer, clearTimer: c.clearTimer }).catch(() => {});
    expect(c.pending()).toBe(0);
  });

  it('still reports a dropped connection as a connection problem, not a timeout', async () => {
    const c = clock();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const err = (await api('/x', { setTimer: c.setTimer, clearTimer: c.clearTimer }).catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/connection/i);
  });

  it('a caller\'s own abort is an abort, but is not reported as our timeout', async () => {
    const c = clock();
    hangs();
    const ctrl = new AbortController();
    const p = api('/x', { signal: ctrl.signal, setTimer: c.setTimer, clearTimer: c.clearTimer }).catch((e: unknown) => e);
    ctrl.abort();
    const err = (await p) as ApiError;
    expect(err.status).toBe(0);   // "no connection", not "took too long" — we did not give up, they did
  });

  it('timeoutMs <= 0 waits for ever, for anything that legitimately runs long', async () => {
    const c = clock();
    hangs();
    let settled = false;
    void api('/x', { timeoutMs: 0, setTimer: c.setTimer, clearTimer: c.clearTimer }).catch(() => { settled = true; });
    await c.advance(API_TIMEOUT_MS * 10);
    expect(settled).toBe(false);
    expect(c.pending()).toBe(0);   // and no timer was armed at all
  });
});

describe('the deadline itself', () => {
  it('aborts at the deadline and says it was us', async () => {
    const c = clock();
    const d = requestDeadline({ timeoutMs: 1000, setTimer: c.setTimer, clearTimer: c.clearTimer });
    expect(d.signal.aborted).toBe(false);
    expect(d.timedOut()).toBe(false);
    await c.advance(1000);
    expect(d.signal.aborted).toBe(true);
    expect(d.timedOut()).toBe(true);
  });

  it('done() disarms it — a settled request must not abort a reused signal later', async () => {
    const c = clock();
    const d = requestDeadline({ timeoutMs: 1000, setTimer: c.setTimer, clearTimer: c.clearTimer });
    d.done();
    await c.advance(10_000);
    expect(d.signal.aborted).toBe(false);
    expect(c.pending()).toBe(0);
    d.done();   // idempotent
  });

  it('an already-aborted caller signal aborts immediately', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const c = clock();
    const d = requestDeadline({ signal: ctrl.signal, setTimer: c.setTimer, clearTimer: c.clearTimer });
    expect(d.signal.aborted).toBe(true);
    expect(d.timedOut()).toBe(false);
  });
});
