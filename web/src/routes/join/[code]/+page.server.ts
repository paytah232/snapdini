import { env } from '$env/dynamic/private';
import type { PageServerLoad } from './$types';
import { loadEventOg } from '$lib/server/og';

export const load: PageServerLoad = async ({ params, url }) => ({
  ...await loadEventOg(params.code, url, 'invite'),
  // Development opt-in; ordinary self-hosted/production pages keep their current behavior.
  guestRecovery: env.GUEST_RECOVERY_ENV === 'dev',
});
