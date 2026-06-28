import crypto from 'crypto';
import * as argon2 from 'argon2';
import { v4 as uuidv4 } from 'uuid';
import { eq, and } from 'drizzle-orm';
import type { Request, Response, NextFunction, CookieOptions } from 'express';
import { db } from './db';
import { users, sessions, emailTokens, type User } from './schema';

export const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOKEN_TTL_MS = 30 * 60 * 1000;             // 30 min for verify / magic-link

// ── Password hashing (argon2id) ───────────────────────────────────────────────
export const hashPassword = (pw: string): Promise<string> => argon2.hash(pw, { type: argon2.argon2id });
export const verifyPassword = (hash: string, pw: string): Promise<boolean> =>
  argon2.verify(hash, pw).catch(() => false);

// ── One-time email tokens (verify / magic_login) ──────────────────────────────
// We store only the SHA-256 of the token; the raw value is what gets emailed.
const hashToken = (raw: string): string => crypto.createHash('sha256').update(raw).digest('hex');

export async function createEmailToken(userId: string, purpose: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await db.insert(emailTokens).values({
    id: uuidv4(), userId, purpose, tokenHash: hashToken(raw), expiresAt: now + TOKEN_TTL_MS, createdAt: now,
  });
  return raw;
}

// Validate + consume a token in one step. Returns the user row or null.
export async function consumeEmailToken(raw: string | undefined, purpose: string): Promise<User | null> {
  if (!raw) return null;
  const [row] = await db.select().from(emailTokens)
    .where(and(eq(emailTokens.tokenHash, hashToken(raw)), eq(emailTokens.purpose, purpose)));
  if (!row || row.consumedAt || row.expiresAt < Date.now()) return null;
  await db.update(emailTokens).set({ consumedAt: Date.now() }).where(eq(emailTokens.id, row.id));
  const [user] = await db.select().from(users).where(eq(users.id, row.userId));
  return user ?? null;
}

// ── Sessions (server-side, opaque id in an HttpOnly cookie) ───────────────────
export async function createSession(userId: string, userAgent?: string): Promise<string> {
  const id = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await db.insert(sessions).values({
    id, userId, expiresAt: now + SESSION_TTL_MS, userAgent: (userAgent || '').slice(0, 300), createdAt: now,
  });
  return id;
}

export async function destroySession(id?: string): Promise<void> {
  if (id) await db.delete(sessions).where(eq(sessions.id, id));
}

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  };
}

export function setSessionCookie(res: Response, sessionId: string): void {
  res.cookie(SESSION_COOKIE, sessionId, cookieOptions());
}
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

// Resolve the logged-in user from the session cookie (or null).
export async function currentUser(req: Request): Promise<User | null> {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (!sid) return null;
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sid));
  if (!session || session.expiresAt < Date.now()) return null;
  const [user] = await db.select().from(users).where(eq(users.id, session.userId));
  return user ?? null;
}

// Shape a user row for API responses (never leak passwordHash).
export function publicUser(u: User | null) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, displayName: u.displayName,
    emailVerified: !!u.emailVerifiedAt, plan: u.plan, isAdmin: !!u.isAdmin,
  };
}

// Middleware
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: 'Not signed in' }); return; }
  req.user = user;
  next();
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  req.user = await currentUser(req);
  next();
}

// Site-admin gate — requires a signed-in user with the is_admin flag.
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await currentUser(req);
  if (!user) { res.status(401).json({ error: 'Not signed in' }); return; }
  if (!user.isAdmin) { res.status(403).json({ error: 'Admins only' }); return; }
  req.user = user;
  next();
}

// Bootstrap a site admin from ADMIN_EMAIL/ADMIN_PASSWORD on boot. Self-host default is
// NO admin (both unset) — there is no shipped default credential. If set, the user is
// created (or promoted) and marked verified; the password is only (re)written when the
// account is first created, so an operator can later change it in-app without it reverting.
export async function ensureAdminFromEnv(): Promise<void> {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email) return;
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) {
    if (!existing.isAdmin) await db.update(users).set({ isAdmin: true }).where(eq(users.id, existing.id));
    return;
  }
  if (!password) { console.warn(`[admin] ADMIN_EMAIL set but ADMIN_PASSWORD missing — admin ${email} not created.`); return; }
  await db.insert(users).values({
    id: uuidv4(), email, passwordHash: await hashPassword(password),
    displayName: 'Site Admin', emailVerifiedAt: Date.now(), plan: 'free',
    isAdmin: true, createdAt: Date.now(),
  });
  console.log(`[admin] bootstrapped site admin: ${email}`);
}
