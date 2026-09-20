import type { AppConfig, User } from './types';

/** An API failure, carrying the HTTP status for logging without putting it in front of anyone. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = 'ApiError'; this.status = status; }
}

/** What a person should read when the server says no and offers no words of its own.
 *
 *  The fallback used to be `Request failed (502)`, and these messages are shown to GUESTS in
 *  toasts — someone at a party who took a photo saw "Request failed (502)" and had no idea whether
 *  their photo was lost. A status code is for us; it stays on the error object for the console and
 *  for client_errors, and never reaches the screen. It matters most for exactly the 5xx case,
 *  because that is the one the guest did nothing to cause and can do nothing about except wait. */
function humanStatus(status: number): string {
  if (status === 0) return 'No connection — check your signal and try again.';
  if (status === 401 || status === 403) return 'You don’t have access to that.';
  if (status === 404) return 'That’s not here any more.';
  if (status === 408) return 'That took too long — try again.';
  if (status === 413) return 'That file is too big.';
  if (status === 429) return 'Too many tries just now — wait a moment.';
  if (status === 502 || status === 503 || status === 504) return 'Snapdini is busy for a second — try again shortly.';
  if (status >= 500) return 'Something went wrong at our end. Try again in a moment.';
  return 'That didn’t work — try again.';
}

// ── A request that never finishes ──────────────────────────────────────────────
//
// `fetch` has no timeout. A server that REFUSES is a rejection and every caller here handles it; a
// server that is merely saturated accepts the socket, sends nothing, and the promise never settles
// at all. Nothing throws, so nothing is caught — and the callers that retry, retry from a `.catch()`
// that is never reached. The gallery is the sharpest case: `loadPhotos().catch(() => schedulePoll())`
// is the ONLY thing that keeps the poll chain alive, so one stalled request ends the polling for the
// life of the page. The screen keeps its last state and quietly stops trying, for ever.
//
// Browsers do eventually give up on a stalled socket, but the timeout is long (minutes), varies by
// browser, and is not guaranteed at all on a half-open connection — the exact condition a saturated
// origin produces.
//
// This is also, precisely, the failure that turns up when the origin is under the load that
// A1/A2/A3 exist to reduce: it is invisible in testing because it takes real congestion to cause.

/** How long a request may take before we stop waiting and call it a failure.
 *
 *  Aborting a request that would have succeeded is its own bug — a guest on venue wifi retrying a
 *  gallery that was 90% delivered is worse off than one who waited — so this has to sit comfortably
 *  above a legitimately slow answer, not near it.
 *
 *  Sized from the real worst case. MEASURED: the gallery answer is ~49KB for 95 photos, so ~515
 *  bytes per photo, and the largest event the product sells is 1000 — call it 515KB raw, ~79KB
 *  after the origin's gzip. On a poor-but-working venue connection (100 kbit/s of usable
 *  throughput) that is ~6.3s on the wire, plus the origin's own time. 20s is three times that
 *  worst case and still short enough that a person watching a spinner has not concluded the page
 *  is broken.
 *
 *  Per-call override exists for anything that legitimately runs longer. Nothing does today: the
 *  big uploads (photos, backing tracks) use XHR and their own fetch, not this. */
export const API_TIMEOUT_MS = 20_000;

export interface RequestDeadline {
  /** Hand this to fetch. */
  readonly signal: AbortSignal;
  /** Stop the clock — safe to call more than once. */
  done(): void;
  /** Did WE abort it, rather than the caller or the network? */
  timedOut(): boolean;
}

/** The abort wiring, as a thing that can be tested with a hand-cranked clock rather than by waiting
 *  twenty seconds. `setTimer`/`clearTimer` are injectable for exactly that; nothing else should
 *  pass them.
 *
 *  It also forwards a CALLER's signal, so an abort the caller asked for is still an abort — it just
 *  does not report as a timeout, because the difference decides what the person is told. */
export function requestDeadline(o: {
  timeoutMs?: number;
  signal?: AbortSignal | null;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
} = {}): RequestDeadline {
  const ms = o.timeoutMs ?? API_TIMEOUT_MS;
  const setTimer = o.setTimer ?? ((fn: () => void, t: number) => setTimeout(fn, t) as unknown);
  const clearTimer = o.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const ctrl = new AbortController();
  let fired = false;
  let handle: unknown;
  const onCallerAbort = () => ctrl.abort();
  if (o.signal) {
    if (o.signal.aborted) ctrl.abort();
    else o.signal.addEventListener('abort', onCallerAbort);
  }
  // `<= 0` disables it outright, which is the escape hatch for anything that must be allowed to run
  // as long as it likes.
  if (ms > 0) handle = setTimer(() => { fired = true; ctrl.abort(); }, ms);
  return {
    signal: ctrl.signal,
    done() {
      if (handle !== undefined) { clearTimer(handle); handle = undefined; }
      o.signal?.removeEventListener('abort', onCallerAbort);
    },
    timedOut: () => fired,
  };
}

export type ApiOptions = RequestInit & {
  /** Override API_TIMEOUT_MS for this call. 0 or less waits for ever. */
  timeoutMs?: number;
  /** Test seam — see requestDeadline. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
};

/** Thin typed fetch wrapper. Throws ApiError on non-2xx: the server's own `error` when it sent one
 *  (those are already written for people), otherwise a human sentence — never a bare status code.
 *
 *  Also throws when the request runs past API_TIMEOUT_MS. That is deliberately the SAME shape as
 *  every other failure — an ApiError rejection — so every existing `.catch()` and every existing
 *  retry keeps working without being told about timeouts at all. */
export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { timeoutMs, setTimer, clearTimer, ...init } = opts;
  const deadline = requestDeadline({ timeoutMs, signal: init.signal, setTimer, clearTimer });
  /** 408, not 0: "that took too long" is a different thing to say to a guest than "no connection",
   *  and it is the honest one when their signal is fine and our origin is the one struggling. */
  const timeout = () => new ApiError(humanStatus(408), 408);
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init, signal: deadline.signal });
  } catch {
    deadline.done();
    // Offline, DNS, a dropped connection: fetch rejects with a message that varies by browser and
    // says nothing useful ("Failed to fetch", "Load failed", "NetworkError"). An abort lands here
    // too, and is told apart by who caused it.
    throw deadline.timedOut() ? timeout() : new ApiError(humanStatus(0), 0);
  }
  // The headers can arrive long before the body does, so the deadline has to cover the read as
  // well — a stalled origin that has sent `200 OK` and then nothing is the same hang wearing a
  // status line.
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    // A body that arrived COMPLETE but is not JSON reads as empty: several endpoints answer 204 or
    // an empty 200, and callers rely on that. A body that was CUT OFF must not — it would reach
    // `photos = data.photos ?? []` as an empty success and wipe the screen, which is worse than any
    // error. The signal is what tells the two apart.
    if (deadline.timedOut() || deadline.signal.aborted) { deadline.done(); throw timeout(); }
    data = {};
  }
  deadline.done();
  if (!res.ok) {
    // A 5xx body is usually the proxy's HTML error page, not ours — there is no `error` field to
    // find, which is precisely how the raw status used to end up on screen.
    throw new ApiError((data as { error?: string })?.error || humanStatus(res.status), res.status);
  }
  return data as T;
}

/** Is this worth trying again, or is the answer settled?
 *
 *  0 (offline / dropped), 408 (our origin was slow), 429 (asked to wait) and every 5xx are the
 *  server or the link having a moment — they say nothing about whether the thing exists. 403, 404
 *  and 410 are answers: retrying them is just asking the same question louder.
 *
 *  Used two ways: a READ keeps its loading state and retries in the background rather than showing
 *  a dead error during a deploy, and a WRITE says "try again in a moment" rather than the flat
 *  "Could not save that" it used to. */
export function isTransient(e: unknown): boolean {
  const status = e instanceof ApiError ? e.status : null;
  if (status === null) return false;
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/** What to put in a toast when a WRITE fails. The server's own words where it has them; a
 *  try-again-shortly where the failure is transient and the words would only be a status line. */
export function writeFailed(e: unknown, fallback: string): string {
  if (isTransient(e)) return e instanceof ApiError && e.status !== 0
    ? 'Snapdini is busy for a second — try again shortly.'
    : 'No connection — check your signal and try again.';
  return e instanceof Error && e.message ? e.message : fallback;
}

/** POST JSON helper. */
export function postJson<T = unknown>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  return api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

let _config: Promise<AppConfig> | null = null;
/** Cached server config (dropdown options, version, flags). Single source — never hard-coded. */
export function getConfig(): Promise<AppConfig> {
  if (!_config) _config = api<AppConfig>('/api/config');
  return _config;
}

/** getConfig, ignoring the memo.
 *
 *  getConfig() caches for the life of the page, which is right for everything in there that cannot
 *  change under a running tab — except one thing that now can. `readOnly` flips when a standby is
 *  promoted back to read-write, and a cached config would leave the recovery banner up on a site
 *  that had already recovered. The banner polls this instead. */
export function refreshConfig(): Promise<AppConfig> {
  _config = api<AppConfig>('/api/config');
  return _config;
}

export function getMe(): Promise<{ user: User | null; googleEnabled: boolean }> {
  return api('/api/auth/me');
}
