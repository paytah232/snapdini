import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

// The preference centre. Reached from a token in an email, never from a session: someone who wants
// to stop hearing from us is exactly the person least likely to still be signed in, and an
// unsubscribe that first asks for a password is not an unsubscribe.
//
// The lists are loaded from the server rather than written here so there is one place that decides
// which messages are optional — a page that had its own copy of that list would eventually offer to
// switch off something we keep sending, or quietly stop offering something we do.
export const load: PageServerLoad = async ({ params, fetch }) => {
  const base = env.INTERNAL_API_BASE || '';
  try {
    const r = await fetch(`${base}/api/email-prefs/${encodeURIComponent(params.token)}`);
    if (r.status === 404) throw error(404, 'This link is not valid. It may have been replaced by a newer email.');
    if (!r.ok) throw error(502, 'Could not load your email preferences right now.');
    const ctx = await r.json() as {
      email: string;
      optional: Array<{ key: string; label: string; description: string; optedOut: boolean }>;
      service: Array<{ label: string; description: string }>;
    };
    return { token: params.token, ...ctx };
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e) throw e;
    throw error(502, 'Could not load your email preferences right now.');
  }
};
