import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db';
import { users, authIdentities } from '../schema';
import * as email from '../email';
import * as auth from '../auth';
import { baseUrl } from '../lib';

const router = Router();

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const googleEnabled        = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

function normalizeEmail(e: unknown): string {
  return String(e || '').trim().toLowerCase();
}
function validEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
}

async function startSession(req: Request, res: Response, userId: string): Promise<void> {
  const sid = await auth.createSession(userId, req.get('user-agent'));
  auth.setSessionCookie(res, sid);
}

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', async (req: Request, res: Response) => {
  res.json({ user: auth.publicUser(await auth.currentUser(req)), googleEnabled });
});

// ── POST /api/auth/register ───────────────────────────────────────────────────
router.post('/', (_req: Request, res: Response) => res.status(404).end()); // guard stray POSTs

router.post('/register', async (req: Request, res: Response) => {
  const { email: emailRaw, password: passwordRaw, displayName: displayNameRaw } =
    req.body as { email?: string; password?: string; displayName?: string };
  const emailAddr   = normalizeEmail(emailRaw);
  const password    = passwordRaw || '';
  const displayName = (displayNameRaw || '').trim().slice(0, 80) || null;

  if (!validEmail(emailAddr)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (password.length < 8)    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const [existing] = await db.select({ id: users.id, passwordHash: users.passwordHash })
    .from(users).where(eq(users.email, emailAddr));
  if (existing && existing.passwordHash)
    return res.status(409).json({ error: 'An account with that email already exists' });

  const now  = Date.now();
  const hash = await auth.hashPassword(password);
  let userId: string;
  if (existing) {
    // Email pre-existed via magic-link/social; attach a password to it.
    userId = existing.id;
    await db.update(users)
      .set({ passwordHash: hash, displayName: sql`COALESCE(${users.displayName}, ${displayName})` })
      .where(eq(users.id, userId));
  } else {
    userId = uuidv4();
    await db.insert(users).values({
      id: userId, email: emailAddr, passwordHash: hash, displayName, plan: 'free', createdAt: now,
    });
  }

  const token  = await auth.createEmailToken(userId, 'verify');
  const link   = `${baseUrl(req)}/api/auth/verify?token=${token}`;
  const result = await email.sendAuthLink({ to: emailAddr, kind: 'verify', link });

  res.status(201).json({
    ok: true,
    message: 'Account created — check your email to verify.',
    emailDelivered: result.delivered,
    devLink: result.devLink,           // present only when SMTP is disabled (dev)
  });
});

// ── GET /api/auth/verify?token= ───────────────────────────────────────────────
router.get('/verify', async (req: Request, res: Response) => {
  const user = await auth.consumeEmailToken(req.query.token as string | undefined, 'verify');
  if (!user) return res.status(400).send('This verification link is invalid or has expired.');
  if (!user.emailVerifiedAt)
    await db.update(users).set({ emailVerifiedAt: Date.now() }).where(eq(users.id, user.id));
  await startSession(req, res, user.id);
  res.redirect('/dashboard');
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req: Request, res: Response) => {
  const { email: emailRaw, password: passwordRaw } = req.body as { email?: string; password?: string };
  const emailAddr = normalizeEmail(emailRaw);
  const password  = passwordRaw || '';
  const [user] = await db.select().from(users).where(eq(users.email, emailAddr));
  // Same response whether the user is missing or the password is wrong.
  if (!user || !user.passwordHash || !(await auth.verifyPassword(user.passwordHash, password)))
    return res.status(401).json({ error: 'Wrong email or password' });
  if (!user.emailVerifiedAt)
    return res.status(403).json({ error: 'Please verify your email first', needsVerification: true });
  await startSession(req, res, user.id);
  res.json({ user: auth.publicUser(user) });
});

// ── POST /api/auth/magic-link ─────────────────────────────────────────────────
// Sends a one-time sign-in link. Creates the account if the email is new (so it
// doubles as passwordless signup). Always returns ok (don't reveal who has an account).
router.post('/magic-link', async (req: Request, res: Response) => {
  const { email: emailRaw } = req.body as { email?: string };
  const emailAddr = normalizeEmail(emailRaw);
  if (!validEmail(emailAddr)) return res.status(400).json({ error: 'Enter a valid email address' });

  let [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, emailAddr));
  if (!user) {
    const id = uuidv4();
    await db.insert(users).values({ id, email: emailAddr, plan: 'free', createdAt: Date.now() });
    user = { id };
  }
  const token  = await auth.createEmailToken(user.id, 'magic_login');
  const link   = `${baseUrl(req)}/api/auth/magic?token=${token}`;
  const result = await email.sendAuthLink({ to: emailAddr, kind: 'magic', link });

  res.json({ ok: true, message: 'Check your email for a sign-in link.',
             emailDelivered: result.delivered, devLink: result.devLink });
});

// ── GET /api/auth/magic?token= ────────────────────────────────────────────────
router.get('/magic', async (req: Request, res: Response) => {
  const user = await auth.consumeEmailToken(req.query.token as string | undefined, 'magic_login');
  if (!user) return res.status(400).send('This sign-in link is invalid or has expired.');
  if (!user.emailVerifiedAt) // signing in via a link to your own inbox proves the address
    await db.update(users).set({ emailVerifiedAt: Date.now() }).where(eq(users.id, user.id));
  await startSession(req, res, user.id);
  res.redirect('/dashboard');
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', async (req: Request, res: Response) => {
  await auth.destroySession(req.cookies?.[auth.SESSION_COOKIE]);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// ── Google OAuth (scaffolded; active when GOOGLE_CLIENT_ID/SECRET are set) ──────
router.get('/google', (req: Request, res: Response) => {
  if (!googleEnabled) return res.status(503).send('Google sign-in is not configured on this server.');
  // CSRF protection: random state echoed back by Google + verified against a short-lived cookie.
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax',
    maxAge: 10 * 60 * 1000, path: '/api/auth',
  });
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  `${baseUrl(req)}/api/auth/google/callback`,
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'online',
    prompt:        'select_account',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/google/callback', async (req: Request, res: Response) => {
  if (!googleEnabled) return res.status(503).send('Google sign-in is not configured.');
  // Verify the CSRF state matches the cookie we set, then clear it (single-use).
  const state = req.query.state as string | undefined;
  const cookieState = req.cookies?.oauth_state as string | undefined;
  res.clearCookie('oauth_state', { path: '/api/auth' });
  if (!state || !cookieState || state !== cookieState) return res.status(400).send('Invalid OAuth state — please try signing in again.');
  const code = req.query.code as string | undefined;
  if (!code) return res.status(400).send('Missing authorization code.');

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: `${baseUrl(req)}/api/auth/google/callback`, grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) return res.status(502).send('Google token exchange failed.');
  const { access_token } = await tokenRes.json() as { access_token: string };

  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!infoRes.ok) return res.status(502).send('Could not fetch Google profile.');
  const profile = await infoRes.json() as { sub: string; email?: string; name?: string }; // { sub, email, name, ... }

  const sub       = profile.sub;
  const emailAddr = normalizeEmail(profile.email);
  const now       = Date.now();

  const [identity] = await db.select().from(authIdentities)
    .where(and(eq(authIdentities.provider, 'google'), eq(authIdentities.providerUserId, sub)));
  let userId: string;
  if (identity) {
    userId = identity.userId;
  } else {
    // Link to an existing email account, or create a new one.
    const [user] = emailAddr
      ? await db.select({ id: users.id }).from(users).where(eq(users.email, emailAddr))
      : [undefined];
    if (!user) {
      userId = uuidv4();
      await db.insert(users).values({
        id: userId, email: emailAddr, displayName: (profile.name || '').slice(0, 80) || null,
        emailVerifiedAt: now, plan: 'free', createdAt: now,
      });
    } else {
      userId = user.id;
      await db.update(users).set({ emailVerifiedAt: sql`COALESCE(${users.emailVerifiedAt}, ${now})` })
        .where(eq(users.id, userId));
    }
    await db.insert(authIdentities).values({
      id: uuidv4(), userId, provider: 'google', providerUserId: sub, createdAt: now,
    });
  }

  await startSession(req, res, userId);
  res.redirect('/dashboard');
});

export default router;
