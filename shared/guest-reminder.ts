// ── When "photos open tomorrow" is due ───────────────────────────────────────
//
// This rule lived in two places and they DISAGREED, in the way that is hardest to see: the server
// required the gap to EXCEED a day, the browser accepted exactly a day, and each half carried a
// confident test asserting the opposite of the other. Both suites were green. A host who set a
// 24-hour reveal delay was shown the reminder switched on, with the exact time it would fire, and
// the server never sent it — which is verbatim the failure the web module's own header warned
// about: "a day-before reminder offered where no day exists (the host turns it on and nothing
// ever happens)".
//
// Nothing compared the two, because nothing could: there was no shared thing to compare against.
// So the rule lives here now, the same way scheduledRevealAt does after the four copies of
// `expiresAt + delay * 3600000` disagreed.
//
// THE RULE, and why it is a strict inequality:
//
// The reminder is measured from the event's END, not from now. The thank-you goes out when the
// event ends and already names the release moment, so a reminder timed at or before that instant
// has been overtaken by it — the guest gets the same fact twice within a tick. A reminder that
// arrives alongside the thing it is reminding you about is not a reminder. Hence `>`, not `>=`.
//
// Measuring from the END rather than from the clock also keeps the control still: a host part-way
// through the form does not watch the option appear and vanish as time passes.

/** A full day. The reminder's lead time, and the gap the schedule must exceed. */
export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * When the day-before reminder should land, or null when it should never be sent.
 *
 * @param endsAt    the event's end (expiresAt)
 * @param releaseAt when the gallery opens, or null when no moment is fixed
 */
export function guestReminderInstant(endsAt: number, releaseAt: number | null): number | null {
  if (releaseAt === null) return null;
  const at = releaseAt - REMINDER_LEAD_MS;
  // Strictly after the event's end — see above. Equal means the same breath as the thank-you.
  return at > endsAt ? at : null;
}

/** Whether a reminder is possible at all — the question the host's toggle is really asking. */
export const guestReminderPossible = (endsAt: number, releaseAt: number | null): boolean =>
  guestReminderInstant(endsAt, releaseAt) !== null;
