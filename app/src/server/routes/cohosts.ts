import { Router, type Request, type Response } from 'express';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { eventCohosts, events, users } from '../schema';
import * as auth from '../auth';

const router = Router();

// ── GET /api/cohosts — pending co-host invites addressed to the signed-in user's email ──
// Powers the "you've been invited to co-host" section in the dashboard so invitees can accept
// in-app (not only via the emailed link).
router.get('/', auth.requireAuth, async (req: Request, res: Response) => {
  const email = req.user!.email.toLowerCase();
  const rows = await db.select().from(eventCohosts)
    .where(and(eq(sql`lower(${eventCohosts.email})`, email), eq(eventCohosts.status, 'invited')));
  if (!rows.length) return res.json({ invites: [] });

  // Batch the event + inviter lookups (avoid an N+1 of two queries per invite).
  const eventIds = [...new Set(rows.map((r) => r.eventId))];
  const inviterIds = [...new Set(rows.map((r) => r.invitedByUserId).filter(Boolean) as string[])];
  const evs = await db.select({ id: events.id, name: events.name, joinCode: events.joinCode, purgedAt: events.purgedAt })
    .from(events).where(inArray(events.id, eventIds));
  const evMap = new Map(evs.map((e) => [e.id, e]));
  const us = inviterIds.length
    ? await db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(users).where(inArray(users.id, inviterIds))
    : [];
  const uMap = new Map(us.map((u) => [u.id, u]));

  const invites = rows.map((r) => {
    const ev = evMap.get(r.eventId);
    if (!ev || ev.purgedAt) return null;
    const u = r.invitedByUserId ? uMap.get(r.invitedByUserId) : null;
    return { token: r.token, eventName: ev.name, joinCode: ev.joinCode, inviter: u ? (u.displayName || u.email) : 'A Snapdini host' };
  }).filter(Boolean);
  res.json({ invites });
});

// ── GET /api/cohosts/:token — view an invitation (renders the accept page before sign-in) ──
router.get('/:token', async (req: Request, res: Response) => {
  const [row] = await db.select().from(eventCohosts).where(eq(eventCohosts.token, String(req.params.token)));
  if (!row) return res.status(404).json({ error: 'This invitation is invalid or has expired' });
  const [ev] = await db.select({ name: events.name, joinCode: events.joinCode }).from(events).where(eq(events.id, row.eventId));
  if (!ev) return res.status(404).json({ error: 'This event is no longer available' });

  let inviter = 'A Snapdini host';
  if (row.invitedByUserId) {
    const [u] = await db.select({ displayName: users.displayName, email: users.email }).from(users).where(eq(users.id, row.invitedByUserId));
    if (u) inviter = u.displayName || u.email;
  }
  const me = await auth.currentUser(req);
  res.json({
    eventName: ev.name,
    joinCode: ev.joinCode,
    inviter,
    email: row.email,
    status: row.status,
    loggedIn: !!me,
    verified: !!me?.emailVerifiedAt,
    // The invite is tied to its email — the accepting account must match it.
    emailMatches: !!me && me.email.toLowerCase() === (row.email || '').toLowerCase(),
    yourEmail: me?.email ?? null,
    alreadyAccepted: row.status === 'accepted' && !!me && row.userId === me.id,
  });
});

// ── POST /api/cohosts/:token/accept — bind the invite to the signed-in (verified) user ──
router.post('/:token/accept', auth.requireAuth, async (req: Request, res: Response) => {
  if (!req.user!.emailVerifiedAt)
    return res.status(403).json({ error: 'Please verify your email before accepting', needsVerification: true });
  const [row] = await db.select().from(eventCohosts).where(eq(eventCohosts.token, String(req.params.token)));
  if (!row) return res.status(404).json({ error: 'This invitation is invalid or has expired' });

  // The invitation is tied to the email it was sent to — you can only accept it from that account.
  if (req.user!.email.toLowerCase() !== (row.email || '').toLowerCase())
    return res.status(403).json({ error: `This invitation is for ${row.email}. Sign in with that email to accept it.`, emailMismatch: true });

  await db.update(eventCohosts)
    .set({ userId: req.user!.id, status: 'accepted', acceptedAt: Date.now() })
    .where(eq(eventCohosts.id, row.id));
  const [ev] = await db.select({ joinCode: events.joinCode }).from(events).where(eq(events.id, row.eventId));
  res.json({ ok: true, joinCode: ev?.joinCode });
});

export default router;
