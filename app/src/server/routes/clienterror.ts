import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { clientErrors, participants } from '../schema';
import pkg from '../../../package.json';

const router = Router();

// Contexts that are observations, not defects: recorded for the denominator, never queued for
// someone to action. Keep this list short — anything genuinely broken must still surface.
const INFORMATIONAL = new Set(['camera-denied']);

// POST /api/client-error — lightweight client-side diagnostic capture (e.g. a failed upload).
// Public (guests aren't authenticated) and best-effort: we never want error reporting to itself
// throw. Stores TECHNICAL data only — message + where it happened — never photos or content.
/** Everything before the first `?` or `#` — see the note at its use. */
function stripQuery(u: string): string {
  const cut = u.search(/[?#]/);
  return cut === -1 ? u : u.slice(0, cut);
}

/** `s` trimmed to `max`, or null when there was nothing there. One helper rather than the same
 *  `x ? String(x).slice(0, n) : null` written fourteen times, now that there are fourteen fields. */
function cap(v: unknown, max: number): string | null {
  const s = String(v ?? '').trim().slice(0, max);
  return s || null;
}

// ── What counts as "the same error" ──────────────────────────────────────────────────────────
//
// THE PROBLEM THIS SOLVES, measured rather than imagined: fifty production rows were eleven
// distinct problems. Twelve of them were one camera permission failure repeated verbatim, and the
// six upload failures that actually cost a guest their photos were below them, unread.
//
// The key is `context|normalised message`, and each step of the normalisation is here because a
// real message needed it — nothing is normalised speculatively, because every extra rule merges
// two things that might have been worth telling apart:
//
//   whitespace   a message built from a caught error can carry a newline from the browser's own
//                text ("The request is not allowed\nby the user agent"), and Safari and Chrome do
//                not wrap in the same place. Same defect, two groups, for a line break.
//   uuids        ids appear in messages via the thing they name ("photo <uuid> failed"). One per
//                occurrence means one group per occurrence, which is no grouping at all.
//   long digits  byte counts, durations, timestamps, request ids. Runs of THREE OR MORE, so
//                one- and two-digit numbers survive — retry counts, shot numbers, "2 of 5".
//                Note what this DOES collapse: a bare three-digit HTTP status. 500 and 503 would
//                land in one group. That is accepted rather than overlooked, because the messages
//                this app actually reports are sentences and not codes ("Event has ended",
//                "Network error", "camera: NotAllowedError Permission denied") — every one of
//                which keeps the words that distinguish it. If a call site ever does start
//                reporting bare statuses, raise this to four and re-check the backfill in 0071,
//                which implements the same rule in SQL and must not drift from it.
//   truncation   at 120 characters, which also does useful work on its own — the variable part of
//                a long message is almost always at the end, after the part that identifies it.
//
// NOT NORMALISED, deliberately: case (a `TypeError` and a `typeerror` from different code paths
// are different code paths), and anything inside parentheses — `camera: lens unavailable
// (ultrawide: OverconstrainedError)` and the same line for the telephoto are arguably one defect,
// but they are just as often two, and a rule that guesses is worse here than one row too many.
//
// The stack is NOT part of the key. Minified frame names change with every build, so a
// stack-keyed group splits in two on deploy — which is precisely when the operator is asking
// whether the thing is still happening.
export function fingerprintOf(context: string | null, message: string): string {
  const normalised = message
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '#')
    .replace(/[0-9]{3,}/g, '#')
    .slice(0, 120);
  return `${context || '-'}|${normalised}`;
}

/** The guest this report came from, as an ID — or null, which is the common case (the marketing
 *  pages, the host's own dashboard, and any guest whose session has since been cleared).
 *
 *  THE TOKEN IS EXCHANGED HERE AND NEVER STORED. It arrives in `X-Session-Token`, the header the
 *  guest already sends on every photo call, so no call site had to learn to pass an identity and
 *  no identity travels in a body we persist. What lands in the row is the participant id; the
 *  token is a bearer credential and a diagnostic log that a human reads is the last place it
 *  should come to rest — the same judgement that made `url` path-only below.
 *
 *  Its own try/catch, not the caller's: a lookup that fails must cost us the guest's name, not
 *  the whole report. Losing the error itself because we could not work out who sent it would be
 *  the reporting bug this endpoint exists to avoid having. */
async function participantFor(req: Request): Promise<string | null> {
  try {
    const token = String(req.get('x-session-token') || '').trim();
    if (!token) return null;
    const rows = await db.select({ id: participants.id }).from(participants)
      .where(eq(participants.sessionToken, token)).limit(1);
    return rows[0]?.id ?? null;
  } catch { return null; }
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const b = req.body as {
      message?: string; context?: string; eventCode?: string; url?: string; stack?: string;
      build?: string; displayMode?: string; viewport?: string; connection?: string; outcome?: string;
    };
    const message = String(b?.message || '').trim().slice(0, 500);
    if (!message) return res.status(400).json({ error: 'message required' });
    const context = b?.context ? String(b.context).slice(0, 60) : null;
    await db.insert(clientErrors).values({
      id: uuidv4(),
      message,
      context,
      eventCode: b?.eventCode ? String(b.eventCode).slice(0, 40) : null,
      // PATH ONLY. This is a caller-supplied string we store and then show in the admin queue, and a
      // URL is exactly where a credential ends up — a session token or organizer code in a query
      // string would be persisted here by the client's own error reporter. Rendering was never the
      // risk (Svelte escapes it); keeping the secret was.
      url: b?.url ? stripQuery(String(b.url)).slice(0, 300) : null,
      userAgent: String(req.get('user-agent') || '').slice(0, 300) || null,
      // Informational reports arrive already handled. A guest declining or dismissing the camera
      // prompt is a CHOICE, not a fault — the client already gives it its own context precisely so
      // it doesn't look like a bug, but it still landed in the open queue, so every dismissed
      // prompt became something for the operator to clear by hand. They are still recorded, because
      // the denial count is only meaningful against the number of people who were asked; they just
      // don't ask anyone to do something about them.
      handled: INFORMATIONAL.has(context ?? ''),
      createdAt: Date.now(),

      // Computed here and not accepted from the body. A client that could choose its own
      // fingerprint could merge its reports into somebody else's group, or split one defect into a
      // thousand groups and push everything else off the screen — for a public unauthenticated
      // endpoint that is a denial of the only diagnostic view we have.
      fingerprint: fingerprintOf(context, message),
      // 4000 characters. Long enough for the frames that name our own code on every engine that
      // produces one, short enough that a runaway recursion cannot post a megabyte per report.
      stack: cap(b?.stack, 4000),
      participantId: await participantFor(req),
      // OURS, not theirs. The client sends its build id (below) and the two are allowed to differ
      // — that disagreement is how a report from a stale cached PWA identifies itself.
      appVersion: pkg.version,
      clientBuild: cap(b?.build, 40),
      // Constrained to the two values the column means. Free text here would arrive as whatever a
      // future caller felt like sending, and the admin filter would quietly stop matching.
      displayMode: b?.displayMode === 'standalone' ? 'standalone'
                 : b?.displayMode === 'browser' ? 'browser' : null,
      viewport: cap(b?.viewport, 20),
      connection: cap(b?.connection, 20),
      outcome: cap(b?.outcome, 20),
    });
  } catch { /* never let reporting throw back at the client */ }
  res.json({ ok: true });
});

export default router;
