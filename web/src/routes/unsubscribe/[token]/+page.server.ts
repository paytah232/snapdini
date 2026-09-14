import type { Actions, PageServerLoad } from './$types';
import { error, fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

// The guest unsubscribe page. Reached from a link in an invite, by someone who has no account here
// and never will — so no session, no password, and nothing asking them to "confirm your address".
// The per-invite token is what identifies them; the address itself is never in the URL.

interface Context {
  email: string;
  eventName: string;
  guestName: string | null;
  scope: 'event' | 'all' | null;
  feedbackGiven: boolean;
  reasons: Array<{ key: string; label: string }>;
}

/**
 * Read-only, deliberately.
 *
 * Mail providers and security gateways fetch the links in an email before any human opens it
 * (Outlook SafeLinks and Proofpoint both do). A load that unsubscribed on GET would quietly opt out
 * guests who never saw the invite, and the host's resend would then skip them with no explanation
 * visible from either side. The opt-out happens on a POST — from the page as soon as it mounts, so
 * nobody has to press anything, or from the form below when there is no JavaScript to do it.
 */
export const load: PageServerLoad = async ({ params, fetch }) => {
  const base = env.INTERNAL_API_BASE || '';
  try {
    const r = await fetch(`${base}/api/guest-unsubscribe/${encodeURIComponent(params.token)}`);
    if (r.status === 404) throw error(404, 'This link is not valid. It may have been replaced by a newer email.');
    if (!r.ok) throw error(502, 'We could not load this page right now.');
    return { token: params.token, ...(await r.json() as Context) };
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e) throw e;
    throw error(502, 'We could not load this page right now.');
  }
};

/**
 * The no-JavaScript path.
 *
 * An unsubscribe that only works when a script runs is an unsubscribe that sometimes does not, and
 * the recipient's next move when it does not is the button marked "spam". One plain form, one
 * button, same endpoint.
 */
export const actions: Actions = {
  default: async ({ params, request, fetch }) => {
    const base = env.INTERNAL_API_BASE || '';
    const form = await request.formData();
    const scope = form.get('scope') === 'all' ? 'all' : 'event';
    const r = await fetch(`${base}/api/guest-unsubscribe/${encodeURIComponent(params.token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope }),
    });
    if (!r.ok) return fail(502, { failed: true });
    return { scope };
  },
};
