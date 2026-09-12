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

/** Thin typed fetch wrapper. Throws ApiError on non-2xx: the server's own `error` when it sent one
 *  (those are already written for people), otherwise a human sentence — never a bare status code. */
export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...opts });
  } catch {
    // Offline, DNS, a dropped connection: fetch rejects with a message that varies by browser and
    // says nothing useful ("Failed to fetch", "Load failed", "NetworkError").
    throw new ApiError(humanStatus(0), 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A 5xx body is usually the proxy's HTML error page, not ours — there is no `error` field to
    // find, which is precisely how the raw status used to end up on screen.
    throw new ApiError((data as { error?: string })?.error || humanStatus(res.status), res.status);
  }
  return data as T;
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

export function getMe(): Promise<{ user: User | null; googleEnabled: boolean }> {
  return api('/api/auth/me');
}
