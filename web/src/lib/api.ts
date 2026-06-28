import type { AppConfig, User } from './types';

/** Thin typed fetch wrapper. Throws Error(message) on non-2xx (message = server `error`). */
export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string })?.error || `Request failed (${res.status})`);
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
