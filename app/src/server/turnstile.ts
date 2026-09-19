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

// Env is read lazily on every call, not captured at module load. That keeps the module free of
// any import-order dependency on dotenv, and makes the behaviour testable.
const secret = () => process.env.TURNSTILE_SECRET || '';
export const turnstileSiteKey = (): string => process.env.TURNSTILE_SITE_KEY || '';
export const turnstileEnabled = (): boolean => !!secret();

// Cloudflare's guidance is to reject when siteverify cannot be reached. That is the default here.
// The escape hatch exists because a Turnstile outage would otherwise take login, sign-up AND the
// contact form down together — set TURNSTILE_FAIL_OPEN=1 to ride out an incident without a rebuild.
const failOpen = () => process.env.TURNSTILE_FAIL_OPEN === '1';

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
  if (!turnstileEnabled()) return { ok: true };
  if (!token) {
    // No token means the widget never produced one — usually because the visitor's network blocked
    // challenges.cloudflare.com (ad blockers, privacy DNS such as Pi-hole, some corporate
    // firewalls), not because they are a bot. Hard-failing here silently locks those people out of
    // sign-up, login AND the contact form with no way to self-diagnose. When FAIL_OPEN is set we
    // let them through and rely on the honeypot and per-IP limits, which are unaffected.
    // The `fail-open:` prefix is not cosmetic: it is what lets the caller tell a pass that was
    // EARNED from one that only happened because the escape hatch is open, and counting the second
    // kind is the only safe way to decide whether the hatch can be closed. See requireTurnstile.
    if (failOpen()) return { ok: true, reason: 'fail-open:missing-token' };
    return { ok: false, reason: 'missing-token' };
  }
  if (token.length > MAX_TOKEN_LEN) return { ok: false, reason: 'oversized-token' };

  const hosts = allowedHostnames();
  if (!hosts.length) return { ok: false, reason: 'no-hostname-allowlist' };

  let data: {
    success?: boolean; action?: string; hostname?: string;
    'error-codes'?: string[]; metadata?: { result_with_testing_key?: boolean };
  };
  try {
    const body = new URLSearchParams({ secret: secret(), response: token });
    if (ip) body.set('remoteip', ip);
    const r = await fetch(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`siteverify HTTP ${r.status}`);
    data = (await r.json()) as typeof data;
  } catch (e) {
    console.warn('[turnstile] siteverify unreachable:', (e as Error).message);
    return failOpen()
      ? { ok: true, reason: 'fail-open:verify-unreachable' }
      : { ok: false, reason: 'verify-unreachable' };
  }

  if (data.success !== true) {
    return { ok: false, reason: (data['error-codes'] || []).join(',') || 'not-successful' };
  }
  // Cloudflare's documented testing keys (1x…/2x…) always answer with hostname "example.com" and
  // no action, so the checks below would reject them and make the test suite unrunnable. Only
  // Cloudflare can set this flag, and a real secret never produces it, so trusting it is safe.
  if (data.metadata?.result_with_testing_key === true) return { ok: true };

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

// ── What a refused person is actually told ─────────────────────────────────────
//
// The `reason` strings above are for our logs. These are for a person, and splitting them is the
// point. "Bot check failed — reload the page and try again" was one line for three different
// truths, and for the commonest of the three it was both wrong and unactionable: a MISSING token
// means the widget never loaded, which is an ad blocker or a privacy DNS resolver swallowing
// challenges.cloudflare.com far more often than it is a bot (see verifyTurnstile). Reloading
// cannot fix that, so the old copy sent a real customer round the same loop for ever with nothing
// to go on — the dead end DEVELOPMENT.md forbids: state the condition AND take them to whatever
// is blocking it. So the blocked case names the address to allow and the network to try; only a
// token we genuinely judged and rejected gets told to reload.
//
// `code` is the machine-readable half, so a client (or a test) can react without matching prose.
export interface TurnstileRefusal { status: number; code: string; error: string }

export function refusalFor(reason?: string): TurnstileRefusal {
  if (reason === 'missing-token') return {
    status: 403,
    code: 'security-check-blocked',
    error: 'Your browser couldn’t finish the security check on this page. That is nearly always an '
      + 'ad blocker or a private DNS service blocking challenges.cloudflare.com — allow that address, '
      + 'or try again on a different network.',
  };
  // Neither the visitor's fault nor anything they can fix, so it must not read as if it were. 503,
  // not 403, so an outage that is locking every customer out looks like an outage in monitoring.
  if (reason === 'verify-unreachable' || reason === 'no-hostname-allowlist') return {
    status: 503,
    code: 'security-check-unavailable',
    error: 'Our security check isn’t answering right now. Please try again in a few minutes.',
  };
  return {
    status: 403,
    code: 'security-check-failed',
    error: 'That security check didn’t go through. Please reload the page and try again.',
  };
}

// Express guard. Reads the widget's single-use token from the canonical `cf-turnstile-response`
// field (Cloudflare's name), falling back to a header for non-form callers.
export function requireTurnstile(expectedAction?: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!turnstileEnabled()) return next();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = (body['cf-turnstile-response'] as string | undefined)
      || (body.turnstileToken as string | undefined)
      || (req.headers['cf-turnstile-response'] as string | undefined);
    const result = await verifyTurnstile(token, req.ip, expectedAction);
    if (result.ok) {
      // A pass that happened ONLY because the escape hatch is open is the one number the owner
      // needs before closing it: it is precisely the set of real people who would start being
      // refused. `docker compose logs app | grep 'fail-open'` counts them, per endpoint.
      // originalUrl, not req.path: this is mounted with app.use on the full path, so req.path
      // is '/' and every endpoint's line would read the same. The point of the line is WHICH one.
      if (result.reason) console.warn('[turnstile] %s %s allowed: %s', req.method, req.originalUrl, result.reason);
      return next();
    }
    console.warn('[turnstile] rejected %s %s: %s', req.method, req.originalUrl, result.reason);
    const refusal = refusalFor(result.reason);
    return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });
  };
}
