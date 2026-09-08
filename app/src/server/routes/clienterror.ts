import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db';
import { clientErrors } from '../schema';

const router = Router();

// Contexts that are observations, not defects: recorded for the denominator, never queued for
// someone to action. Keep this list short — anything genuinely broken must still surface.
const INFORMATIONAL = new Set(['camera-denied']);

// POST /api/client-error — lightweight client-side diagnostic capture (e.g. a failed upload).
// Public (guests aren't authenticated) and best-effort: we never want error reporting to itself
// throw. Stores TECHNICAL data only — message + where it happened — never photos or content.
router.post('/', async (req: Request, res: Response) => {
  try {
    const b = req.body as { message?: string; context?: string; eventCode?: string; url?: string };
    const message = String(b?.message || '').trim().slice(0, 500);
    if (!message) return res.status(400).json({ error: 'message required' });
    const context = b?.context ? String(b.context).slice(0, 60) : null;
    await db.insert(clientErrors).values({
      id: uuidv4(),
      message,
      context,
      eventCode: b?.eventCode ? String(b.eventCode).slice(0, 40) : null,
      url: b?.url ? String(b.url).slice(0, 300) : null,
      userAgent: String(req.get('user-agent') || '').slice(0, 300) || null,
      // Informational reports arrive already handled. A guest declining or dismissing the camera
      // prompt is a CHOICE, not a fault — the client already gives it its own context precisely so
      // it doesn't look like a bug, but it still landed in the open queue, so every dismissed
      // prompt became something for the operator to clear by hand. They are still recorded, because
      // the denial count is only meaningful against the number of people who were asked; they just
      // don't ask anyone to do something about them.
      handled: INFORMATIONAL.has(context ?? ''),
      createdAt: Date.now(),
    });
  } catch { /* never let reporting throw back at the client */ }
  res.json({ ok: true });
});

export default router;
