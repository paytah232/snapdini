// The preference centre's API. Token-gated, never session-gated: an unsubscribe that first demands
// a password is not an unsubscribe facility, and the person reading the email is usually not the
// person with a live session in that browser.
//
// Every failure answers the same 404. The token maps to an account, so distinguishing "expired"
// from "never existed" here would turn this into an oracle for guessing them.
import { Router, type Request, type Response } from 'express';
import {
  OPTIONAL_EMAIL_KINDS, SERVICE_EMAIL_KINDS,
  accountFromPrefsToken, maskEmail, optedOutKinds, parseOptOutRequest, setOptOuts,
} from '../email-prefs';

const router = Router();

const NOT_FOUND = { error: 'This link is not valid. It may have been replaced by a newer email.' };

// GET /api/email-prefs/:token — what we send this account, and what they have already switched off.
router.get('/:token', async (req: Request, res: Response) => {
  const user = await accountFromPrefsToken(String(req.params.token || ''));
  if (!user) return res.status(404).json(NOT_FOUND);

  const off = new Set(await optedOutKinds(user.id));
  res.json({
    // Masked, not the address itself: holding the link only makes someone the presumed recipient.
    email: maskEmail(user.email),
    optional: OPTIONAL_EMAIL_KINDS.map((m) => ({ ...m, optedOut: off.has(m.key) })),
    service: SERVICE_EMAIL_KINDS,
  });
});

// POST /api/email-prefs/:token  { optOut: string[] } — the complete set of kinds to switch off.
//
// The whole set rather than a delta, so the page is idempotent: someone who saves twice, or who
// opens a second copy of the link, ends up in the state they can see rather than one that depends
// on what happened to be stored when they arrived.
router.post('/:token', async (req: Request, res: Response) => {
  const user = await accountFromPrefsToken(String(req.params.token || ''));
  if (!user) return res.status(404).json(NOT_FOUND);

  const wanted = parseOptOutRequest(req.body);
  if (!wanted) return res.status(400).json({ error: 'Could not read your choices — please try again.' });

  await setOptOuts(user.id, wanted);
  res.json({ ok: true, optedOut: wanted });
});

export default router;
