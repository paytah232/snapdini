// Cloudflare Turnstile — bot check for public POST endpoints (contact, register, login).
//
// Enabled ONLY when TURNSTILE_SECRET is set, so self-hosters and any deploy made before the keys
// are provisioned keep working unchanged. Verification FAILS OPEN on a network/timeout error:
// a Cloudflare outage must never take the contact form or the login page down with it.
//
// NOTE this defends against scripted abuse. It will NOT stop paid-traffic fraud from real
// handsets — those score as human because they are. That belongs in the ad platform's placement
// exclusions, not here.
import type { Request, Response, NextFunction } from 'express';

const SECRET = process.env.TURNSTILE_SECRET || '';
export const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
export const turnstileEnabled = !!SECRET;

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(token: string | undefined, ip?: string): Promise<boolean> {
  if (!turnstileEnabled) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: SECRET, response: token });
    if (ip) body.set('remoteip', ip);
    const r = await fetch(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(5000) });
    const j = (await r.json()) as { success?: boolean };
    return j.success === true;
  } catch {
    return true;   // fail open — never let a captcha outage block real users
  }
}

// Express guard. Reads the widget's token from the JSON body or the standard header.
export function requireTurnstile(field = 'turnstileToken') {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!turnstileEnabled) return next();
    const token = (req.body?.[field] as string | undefined)
      || (req.headers['cf-turnstile-response'] as string | undefined);
    if (await verifyTurnstile(token, req.ip)) return next();
    return res.status(400).json({ error: 'Bot check failed — please reload the page and try again.' });
  };
}
