import type { PageServerLoad } from './$types';
import { loadEventOg } from '$lib/server/og';

export const load: PageServerLoad = ({ params, url }) => loadEventOg(params.code, url, 'gallery');
