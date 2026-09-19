// What in a URL is a CREDENTIAL rather than a name.
//
// One rule, two consumers, because they were already disagreeing:
//
//   the server  reduces a reported path to a route pattern before it is stored in site_events
//               (app/src/server/analytics.ts cleanPath)
//   the browser decides whether Google's and Microsoft's tags may be injected on this page at all
//               (web/src/hooks.server.ts)
//
// They have to agree, and they cannot agree by copy. The audit that produced this file found
// exactly that failure: the server redacted a segment of EXACTLY 32 hex characters, the email
// preference-centre token is 64, and so a 400-day multi-use bearer token was being written
// verbatim into first-party analytics and handed to Google in the page URL.
//
// Two kinds of rule live here, deliberately:
//
//   BY SHAPE  a uuid, or any long run of hex — catches credentials on routes nobody has written
//             yet, which is the only kind of protection that survives a new route being added by
//             someone who never read this file.
//   BY ROUTE  the email-link routes below, whose next segment is a bearer token WHATEVER it looks
//             like. The survey token is base64url, so no hex rule will ever catch it, and a rule
//             loose enough to catch base64url would swallow every event slug ("sarah-and-toms-
//             wedding-2026" is 27 characters of [a-z0-9-]). Naming the four routes is precise;
//             widening the shape rule to reach them is not.

/**
 * Routes whose FIRST segment is a bearer credential handed out in an email.
 *
 * Every one of these is entered by clicking a link in a message — there is no in-product link to
 * any of them — so treating the whole route as untrackable costs no funnel measurement at all.
 * Keep the two properties that make the list safe: each entry is a full path segment, and each is
 * a route where the token IS the authentication (no session, no second factor).
 */
export const TOKEN_ROUTES = ['/email-preferences', '/unsubscribe', '/cohost', '/survey'] as const;

/** A uuid — an id in most places, and the invite token in /unsubscribe. */
const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi;

/**
 * Any segment that is a long run of hex.
 *
 * 24 is the bound, not 32: the tokens this product mints are 32 hex (organizer code), 48 hex
 * (co-host invite) and 64 hex (email preference centre), and the old exactly-32 rule caught one of
 * the three. 24 sits below all of them with room to spare and still above everything legitimate —
 * see redact-path.test.ts, which walks every route name, use-case slug and join-code alphabet the
 * site can produce and asserts none of them is touched. Going lower buys nothing (no shorter
 * credential exists) and starts to reach real event slugs.
 */
const LONG_HEX_SEGMENT = /\/[0-9a-f]{24,}(?=\/|$)/gi;

const segments = (pathname: string): string[] => pathname.split('/').filter(Boolean);

/**
 * Is this pathname a token-bearing route?
 *
 * Matched on whole segments, so /signup is not caught by /s-anything and the bare /unsubscribe
 * landing (no token) is still covered — it is the route that is untrackable, not just the URLs that
 * happen to have a token in them today.
 */
export function isTokenRoute(pathname: string): boolean {
  const first = '/' + (segments(pathname)[0] ?? '');
  return (TOKEN_ROUTES as readonly string[]).includes(first);
}

/**
 * A pathname reduced to its route PATTERN: every credential-shaped segment, and every segment
 * sitting in a token route's token position, replaced by a placeholder.
 *
 * Order matters. The shape rules run FIRST so that /unsubscribe/<uuid> keeps reporting as
 * `/unsubscribe/:id`, which is what it has always reported and what the existing site_events rows
 * say — re-labelling it would split one metric in two for no gain. The route rule is the backstop
 * underneath them: whatever is still sitting in that position is a token by definition.
 *
 * Query and fragment are NOT this function's business; callers strip or keep them deliberately
 * (cleanPath drops both; the gtag page_location keeps the query, because that is where utm and
 * gclid live, and drops the fragment, because that is where the organizer code lives).
 */
export function redactPath(pathname: string): string {
  const byShape = pathname
    .replace(UUID_SEGMENT, '/:id')
    .replace(LONG_HEX_SEGMENT, '/:token');
  if (!isTokenRoute(byShape)) return byShape;
  const parts = segments(byShape);
  if (parts.length < 2) return byShape;
  // Only the token position — /admin/<code>/review-style tails below a token route stay readable.
  if (!parts[1].startsWith(':')) parts[1] = ':token';
  return '/' + parts.join('/');
}
