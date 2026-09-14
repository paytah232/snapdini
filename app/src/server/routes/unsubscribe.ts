// The guest unsubscribe. Four endpoints, no login anywhere, and one bearer token for the lot — the
// per-invite token already minted in routes/guests.ts.
//
// The split that matters, because it is easy to collapse the two and get both wrong:
//
//   POST /:token/one-click   The RFC 8058 endpoint a MAIL CLIENT posts to. No page comes back, no
//                            confirmation is asked for, and there is deliberately no GET handler.
//                            A "are you sure?" step fails the standard outright, and Gmail and
//                            Yahoo's bulk-sender rules are what make that standard matter.
//   GET/POST /:token         The PAGE a person reaches from the body link, which offers the two
//                            choices and then — only then — asks why.
//
// Why there is no GET on the one-click path. Mail providers and security gateways fetch the links
// in an email before a human ever sees it (Outlook SafeLinks and Proofpoint both do). A GET that
// unsubscribed would silently opt out guests who never opened the invite, and the host's resend
// would then be skipped with no explanation either of them could see. The page's GET is therefore
// read-only too: the mutation happens on a POST, and only a POST.
import { Router, type Request, type Response } from 'express';
import {
  applyUnsubscribe, maskAddress, parseFeedback, parseScope, recordFeedback,
  targetFromToken, unsubscribeState, UNSUB_REASONS,
} from '../unsubscribe';

const router = Router();

const NOT_FOUND = { error: 'This link is not valid. It may have been replaced by a newer email.' };

// ── One-click ────────────────────────────────────────────────────────────────

/**
 * The mail client's own unsubscribe button.
 *
 * Scope is everything, for that address. A client offers no way to express anything narrower, so
 * the press has to be read as "stop" — guessing at "just this event" would leave someone who
 * believes they unsubscribed still getting mail from us, which is the exact failure the header
 * exists to prevent.
 *
 * Always 200, even for a token we cannot resolve. Two reasons, and both are worth more than the
 * tidiness of a 404: a status code that distinguishes a real token from a fake one turns this into
 * an oracle for guessing them, and Gmail actively probes these endpoints — an unsubscribe URL that
 * answers 404 for an old message reads as a broken facility and is charged to the sender.
 *
 * The POST body (`List-Unsubscribe=One-Click`) is deliberately not inspected. It is not a secret
 * and it is not a signature, so checking it buys nothing; refusing a client that words it slightly
 * differently would cost a real unsubscribe, and the recipient's next move after an unsubscribe
 * that did nothing is the spam button.
 */
router.post('/:token/one-click', async (req: Request, res: Response) => {
  const target = await targetFromToken(String(req.params.token || ''));
  if (target) {
    try {
      await applyUnsubscribe(target, 'all', 'one-click');
    } catch (e) {
      // A 5xx here is the one case worth reporting honestly: some clients retry, and a silent 200
      // over a failed write would leave the person unsubscribed in their mail app and still on our
      // list — the worst of both, and invisible from either side.
      console.error('[unsubscribe] one-click failed', e);
      return res.status(500).type('text/plain').send('Could not process that just now.');
    }
  }
  res.status(200).type('text/plain').send('Unsubscribed.');
});

// ── The page ─────────────────────────────────────────────────────────────────

/** What this link is about. Read-only: see the file header. */
router.get('/:token', async (req: Request, res: Response) => {
  const target = await targetFromToken(String(req.params.token || ''));
  if (!target) return res.status(404).json(NOT_FOUND);
  const state = await unsubscribeState(target);
  res.json({
    // Masked, never the address itself. Holding the link only makes someone the presumed
    // recipient, and the page still has to say which address it is about for anyone with two.
    email: maskAddress(target.email),
    eventName: target.eventName,
    guestName: target.guestName,
    scope: state.scope,
    feedbackGiven: state.feedbackGiven,
    reasons: UNSUB_REASONS,
  });
});

/**
 * Apply it. `{ scope: 'event' | 'all' }`.
 *
 * The page posts 'event' the moment it loads, with nothing for the guest to press — arriving here
 * is the request, and a page that opened with "click to confirm you want to unsubscribe" would be
 * asking someone to do the same thing twice. Widening to 'all' is a second POST from the button
 * that offers it.
 *
 * Idempotent, so a reload or a second copy of the link lands on the state the person can see.
 */
router.post('/:token', async (req: Request, res: Response) => {
  const target = await targetFromToken(String(req.params.token || ''));
  if (!target) return res.status(404).json(NOT_FOUND);

  const scope = parseScope((req.body as { scope?: unknown } | undefined)?.scope);
  if (!scope) return res.status(400).json({ error: 'Could not read that choice — please try again.' });

  await applyUnsubscribe(target, scope, 'page');
  res.json({ ok: true, scope, eventName: target.eventName });
});

/**
 * The optional "why", asked AFTER the unsubscribe has already taken effect.
 *
 * Its own endpoint rather than a field on the one above, because that is the whole point: the
 * unsubscribe must not wait on it, must not be re-sent with it, and must not be revocable by
 * failing to give it. An error here is reported to the page as a failed comment, never as a failed
 * unsubscribe.
 */
router.post('/:token/feedback', async (req: Request, res: Response) => {
  const target = await targetFromToken(String(req.params.token || ''));
  if (!target) return res.status(404).json(NOT_FOUND);

  const feedback = parseFeedback(req.body);
  if (!feedback) return res.status(400).json({ error: 'There was nothing to send.' });

  const attached = await recordFeedback(target, feedback);
  // No row to attach it to means the unsubscribe never landed — which is the thing that actually
  // matters, so say so rather than accepting the comment into nowhere.
  if (!attached) return res.status(409).json({ error: 'We could not find your unsubscribe — please reload the page.' });
  res.json({ ok: true });
});

export default router;
