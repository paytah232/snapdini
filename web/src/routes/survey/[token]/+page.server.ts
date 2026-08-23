import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

// Loads the personalisation context for the feedback survey. The token identifies the event (and
// therefore the customer), so the page can greet by name and adapt questions to what they had.
export const load: PageServerLoad = async ({ params, url, fetch }) => {
  const base = env.INTERNAL_API_BASE || '';
  let ctx: {
    eventName: string; ownerName: string; hadVideo: boolean; revealMode: string;
    largeEvent: boolean; framesAll: boolean; ended: boolean; alreadySubmitted: boolean;
  };
  try {
    const r = await fetch(`${base}/api/survey/${encodeURIComponent(params.token)}`);
    if (r.status === 404) throw error(404, 'This survey link is not valid.');
    if (!r.ok) throw error(502, 'Could not load the survey right now.');
    ctx = await r.json();
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e) throw e;
    throw error(502, 'Could not load the survey right now.');
  }

  const score = parseInt(url.searchParams.get('score') || '', 10);
  return { token: params.token, ...ctx, initialOverall: score >= 1 && score <= 5 ? score : 0 };
};
