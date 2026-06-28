import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as email from '../email';
import { db } from '../db';
import { contactMessages } from '../schema';
import { escapeHtml } from '../lib';

const router = Router();

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || '';
const isEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// POST /api/contact — public "contact us" form. ALWAYS stored in the DB (a durable mailbox),
// so nothing is lost if email is unconfigured or the send fails. If email IS configured we also
// forward to SUPPORT_EMAIL (best-effort, with the sender as Reply-To). Either way it succeeds.
router.post('/', async (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const from = String(req.body?.email || '').trim().slice(0, 200);
  const message = String(req.body?.message || '').trim().slice(0, 5000);

  if (!message) return res.status(400).json({ error: 'Please enter a message' });
  if (from && !isEmail(from)) return res.status(400).json({ error: 'Enter a valid email (or leave it blank)' });

  let emailed = false;
  if (email.enabled && SUPPORT_EMAIL) {
    try {
      await email.sendMail({
        to: SUPPORT_EMAIL,
        subject: `Snapdini contact — ${name || 'someone'}`,
        replyTo: from || undefined,
        html: email.htmlEmail('New contact message', `
          <p><strong>From:</strong> ${escapeHtml(name || 'Anonymous')}${from ? ` &lt;${escapeHtml(from)}&gt;` : ''}</p>
          <p style="white-space:pre-wrap">${escapeHtml(message)}</p>
        `),
      });
      emailed = true;
    } catch { /* fall back to the DB record below */ }
  }

  await db.insert(contactMessages).values({
    id: uuidv4(), name: name || null, email: from || null, message, emailed, createdAt: Date.now(),
  });
  res.json({ success: true });
});

export default router;
