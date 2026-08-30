// Cloudflare Turnstile — bot check for public POST endpoints (contact, register, login).
// Follows Cloudflare's "existing widget" integration flow.
//
// Enabled ONLY when TURNSTILE_SECRET is set, so self-hosters and any deploy made before the keys
// are provisioned keep working unchanged.
//
// NOTE this defends against scripted abuse. It will NOT stop paid-traffic fraud from real
// handsets — those score as human because they are. That belongs in the ad platform's placement
// exclusions, not here.
import type { Request, Response, NextFunction } from 'express';

const SECRET = process.env.TURNSTILE_SECRET || '';
export const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
export const turnstileEnabled = !!SECRET;

// Cloudflare's guidance is to reject when siteverify cannot be reached. That is the default here.
// The escape hatch exists because a Turnstile outage would otherwise take login, sign-up AND the
// contact form down together — set TURNSTILE_FAIL_OPEN=1 to ride out an incident without a rebuild.
const FAIL_OPEN = process.env.TURNSTILE_FAIL_OPEN === '1';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LEN = 2048;   // per Cloudflare: anything longer is not a real token

// Hostnames the widget is allowed to be solved on. Defaults to BASE_URL's host; override/extend
// with a comma-separated TURNSTILE_ALLOWED_HOSTNAMES. An empty allowlist means "reject".
function allowedHostnames(): string[] {
  const extra = (process.env.TURNSTILE_ALLOWED_HOSTNAMES || '')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  let base = '';
  try { base = new URL(process.env.BASE_URL || '').hostname.toLowerCase(); } catch { /* unset */ }
  return [...new Set([...(base ? [base] : []), ...extra])];
}

export interface TurnstileResult { ok: boolean; reason?: string }

export async function verifyTurnstile(
  token: string | undefined, ip: string | undefined, expectedAction?: string,
): Promise<TurnstileResult> {
  if (!turnstileEnabled) return { ok: true };
  if (!token) return { ok: false, reason: 'missing-token' };
  if (token.length > MAX_TOKEN_LEN) return { ok: false, reason: 'oversized-token' };

  const hosts = allowedHostnames();
  if (!hosts.length) return { ok: false, reason: 'no-hostname-allowlist' };

  let data: { success?: boolean; action?: string; hostname?: string; 'error-codes'?: string[] };
  try {
    const body = new URLSearchParams({ secret: SECRET, response: token });
    if (ip) body.set('remoteip', ip);
    const r = await fetch(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`siteverify HTTP ${r.status}`);
    data = (await r.json()) as typeof data;
  } catch (e) {
    console.warn('[turnstile] siteverify unreachable:', (e as Error).message);
    return FAIL_OPEN ? { ok: true } : { ok: false, reason: 'verify-unreachable' };
  }

  if (data.success !== true) {
    return { ok: false, reason: (data['error-codes'] || []).join(',') || 'not-successful' };
  }
  // The token must have been minted for THIS operation and on one of OUR hostnames — otherwise a
  // token solved on an attacker's page, or against a cheaper endpoint, would be replayable here.
  if (expectedAction && data.action !== expectedAction) {
    return { ok: false, reason: `action-mismatch:${data.action ?? 'none'}` };
  }
  if (!data.hostname || !hosts.includes(data.hostname.toLowerCase())) {
    return { ok: false, reason: `hostname-not-allowed:${data.hostname ?? 'none'}` };
  }
  return { ok: true };
}

// Express guard. Reads the widget's single-use token from the canonical `cf-turnstile-response`
// field (Cloudflare's name), falling back to a header for non-form callers.
export function requireTurnstile(expectedAction?: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!turnstileEnabled) return next();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = (body['cf-turnstile-response'] as string | undefined)
      || (body.turnstileToken as string | undefined)
      || (req.headers['cf-turnstile-response'] as string | undefined);
    const result = await verifyTurnstile(token, req.ip, expectedAction);
    if (result.ok) return next();
    console.warn('[turnstile] rejected %s %s: %s', req.method, req.path, result.reason);
    return res.status(403).json({ error: 'Bot check failed — please reload the page and try again.' });
  };
}
