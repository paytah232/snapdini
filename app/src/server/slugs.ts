// Custom URLs a host may not claim.
//
// Event slugs live at /e/<slug> and share slugs at /s/<slug>, so neither can ever shadow a real
// route — `/e/demo` and `/demo` are different pages. That is NOT what this list is for. It exists
// because a custom URL on our own domain borrows our authority: `snapdini.com/e/support` reads as
// a page we wrote, and can be handed to someone as though it were. The risk is impersonation, not
// routing.
//
// EXACT MATCHES ONLY — never a prefix, substring or fuzzy match. This is the important rule and it
// is deliberate:
//
//   reserved   →  snapdini, support, billing
//   still fine →  snapdini1, snapdinis-party, support-crew-xmas, billings-birthday
//
// A prefix rule would look tighter and would be worse. `snapdini.com/e/support` looks official;
// `snapdini.com/e/support-crew-xmas` plainly does not, and it is somebody's actual event name.
// Every false positive is a host who typed the name of their own party, was told it was
// unavailable, and has no way to find out why — we would be trading a real, common cost against a
// threat the extra breadth does not actually prevent (anyone set on impersonating has infinite
// unreserved phrasings anyway). Keep this list short, exact, and about words that would read as
// OURS rather than as an event's.
//
// The list is also why `isSlugAvailable()` in routes/events.ts calls this rather than each caller
// checking separately: a future call site that forgets is then still safe, just with a slightly
// less precise message.
const RESERVED = new Set([
  // us
  'snapdini', 'official', 'team', 'staff',
  // account and money — the phrases a phishing link wants
  'account', 'accounts', 'billing', 'invoice', 'payment', 'payments', 'refund', 'refunds',
  'password', 'verify', 'security', 'login', 'logout', 'signin', 'signup', 'register',
  // support surfaces
  'support', 'help', 'contact', 'admin', 'siteadmin', 'settings', 'dashboard',
  // product pages people would expect to be ours
  'api', 'app', 'demo', 'pricing', 'terms', 'privacy', 'unsubscribe',
]);

/** Is this slug one we keep for ourselves? Exact match on an already-slugified value. */
export function isReservedSlug(slug: unknown): boolean {
  // Fail OPEN on anything unexpected: a host being wrongly refused their own event name is a real
  // cost we would pay often, and letting an odd value through here costs nothing — the length and
  // uniqueness checks still run, and the value has already been through slugify().
  if (typeof slug !== 'string') return false;
  return RESERVED.has(slug.trim().toLowerCase());
}

/** Shown when a host asks for one of these. Never says "taken" — nobody has it, and a host who
 *  tries three of our words in a row deserves to learn the actual rule. */
export const RESERVED_SLUG_ERROR =
  'That custom URL is reserved. Try adding a word or number — “yourname2” works.';
