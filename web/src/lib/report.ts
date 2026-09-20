// Best-effort client-side error reporting — fire-and-forget, never throws back at the caller.
// Sends TECHNICAL data only (a short message + where it happened); never photos or content.
//
// WHAT WAS WRONG WITH WHAT THIS USED TO SEND. Fifty production reports, and the ones that mattered
// could not be acted on: a row reading `camera: TypeError Type error` with no stack behind it — a
// bug report with the bug taken out — and six upload failures from one event with no way to tell
// whether that was one phone retrying or six people losing their photos. Everything added below
// exists to answer a question somebody actually asked and could not answer.
//
// WHAT IT DELIBERATELY DOES NOT SEND, which matters as much on a public repo with a privacy
// policy. No email address and no guest name (the server stores a participant ID and the admin
// screen joins the name in, so erasing a guest erases it here too). No session or organizer
// token in the body — the session token travels in the header it already travels in on every
// other call, and the server exchanges it for an ID rather than storing it. No query string or
// fragment (that is where a token in a link ends up; the server strips them again anyway, belt
// and braces). No photo, no caption, no filename, nothing typed by a person. No geolocation, no
// device memory, no CPU count, and only the coarse `effectiveType` bucket of the connection
// rather than downlink/rtt, which are continuous values and make a device more identifiable
// without answering anything.
import { version as clientBuild } from '$app/environment';
import { getSession } from '$lib/session';
import { isStandalone } from '$lib/pwa';

/** What the failure cost the guest. NOT optional information: an upload that failed and then
 *  succeeded on retry and an upload that lost the photo are indistinguishable in the archive
 *  today, and they are not the same incident. Omitted means "nobody said", which the console
 *  renders as unknown rather than as fine. */
/* What became of the thing that failed.
 *
 *  Deliberately a closed set: a free-text outcome becomes mush, and the whole point is that the
 *  console can tell "flaky network, no harm done" from "a guest lost a photograph" at a glance.
 *
 *  `gave-up` is not `lost`. Automatic delivery has stopped, but the capture is still in the queue
 *  and still in IndexedDB, and the guest can send it by hand — so calling it lost would be a
 *  stronger claim than the code is entitled to make. */
export type ReportOutcome = 'recovered' | 'lost' | 'retrying' | 'gave-up';

export interface ReportOptions {
  /** The caught error, if the call site has one. Pass it: the object carries a stack, and the
   *  string built from it does not. */
  error?: unknown;
  outcome?: ReportOutcome;
}

/** The ceiling for both stacks. Matched to the server's own cap so a truncation happens once, on
 *  the way out, where it is visible — rather than silently again on the way in. */
const STACK_MAX = 4000;

/** Run a getter and treat any failure as "not available".
 *
 *  Per-field rather than one try/catch around the whole body, which is what this used to have.
 *  The difference shows up on exactly the devices worth hearing from: one obscure API throwing on
 *  some embedded webview (an in-app browser with a stubbed `navigator`, say) would have cost us
 *  the entire report, and the report is the only reason we know that webview exists. */
function safe<T>(get: () => T): T | undefined {
  try { return get(); } catch { return undefined; }
}

/** The stack off a caught error, if there is one there. Deliberately duck-typed rather than
 *  `instanceof Error`: a DOMException, a cross-realm error from an iframe or a worker, and
 *  anything a library threw are all things we want the frames from, and none of them reliably
 *  passes an instanceof against this realm's Error. */
function stackOf(err: unknown): string | undefined {
  const s = (err as { stack?: unknown } | null | undefined)?.stack;
  return typeof s === 'string' && s.trim() ? s.trim().slice(0, STACK_MAX) : undefined;
}

/** Said in the payload, so a reader is never shown one of these believing it is the other. */
const CALL_SITE_NOTE = '(no error object was passed to reportClientError — these are the frames that reported it)';

/** Where the report was made, for the call sites that only have a string.
 *
 *  A synthesised trace is NOT as good as the thrown error's own and is not pretending to be —
 *  hence the first line. It is here because most of this app's call sites format a caught error
 *  into a message and throw the object away, and "which of the six upload paths was this" turns
 *  an unactionable row into a one-line fix. Frames are minified in production; the module and
 *  offset are still enough to place it against a source map.
 *
 *  The `Error`/`Error: …` header line is dropped because V8 emits one and JavaScriptCore does
 *  not, and a header reading "Error" above our own note reads like a second, real error. */
function callSite(): string | undefined {
  const raw = safe(() => new Error().stack);
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const frames = raw.split('\n').filter((line) => !/^\s*Error\b/.test(line)).join('\n').trim();
  return frames ? `${CALL_SITE_NOTE}\n${frames}`.slice(0, STACK_MAX) : undefined;
}

export function reportClientError(
  message: string, context?: string, eventCode?: string, opts?: ReportOptions,
): void {
  try {
    // WHO, without any call site having to learn to say so. The identity is taken from where the
    // app already keeps it — the per-event session token in localStorage — and sent as the header
    // the guest's photo calls already carry, for the server to exchange for a participant ID. A
    // page with no event (marketing, the host dashboard) and a guest whose session was cleared
    // both simply have no token, which is the common case and is not an error.
    const token = eventCode ? safe(() => getSession(eventCode)) : null;
    fetch('/api/client-error', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Session-Token': token } : {}),
      },
      body: JSON.stringify({
        message: String(message).slice(0, 500),
        context,
        eventCode,
        url: typeof location !== 'undefined' ? location.pathname : undefined,
        // PATHNAME ONLY, unchanged and on purpose: a custom join link carries its code in the
        // path and an organizer link carries a credential in the fragment. See the matching note
        // on the server, which strips it again — this is the copy that stops it leaving the phone.
        stack: stackOf(opts?.error) ?? callSite(),
        // Which bundle this tab is actually running, from the build — not a version string kept
        // by hand in a constant here, which is the kind that stops being true on the deploy
        // nobody remembers to edit it. The server stamps its OWN deployed version alongside; when
        // the two disagree, the guest is on a cached bundle we stopped shipping, and knowing that
        // is the difference between "the fix did not work" and "the fix never reached them".
        build: clientBuild,
        // Installed-to-home-screen or a browser tab. Reuses the check the install prompt already
        // makes rather than a second opinion about the same thing (iOS answers it with
        // `navigator.standalone`, everyone else with a display-mode media query).
        displayMode: safe(isStandalone) ? 'standalone' : 'browser',
        // The VIEWPORT, not the screen: the camera UI is laid out against this, and screen
        // dimensions would be a more identifying number that explains less.
        viewport: safe(() => `${Math.round(window.innerWidth)}x${Math.round(window.innerHeight)}`),
        // The coarse bucket — '4g', '3g', 'slow-2g'. Absent on Safari, which is fine: absent
        // reads as "we could not tell", and it is present on exactly the Android devices the
        // upload-failure question was about.
        connection: safe(() => (navigator as unknown as
          { connection?: { effectiveType?: string } }).connection?.effectiveType),
        outcome: opts?.outcome,
      }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* ignore */ }
}
