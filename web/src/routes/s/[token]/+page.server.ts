import type { PageServerLoad } from './$types';
import { loadShareOg } from '$lib/server/og';

// Server-rendered OG/link-preview data so a shared link shows the share's NAME + a photo when
// pasted into messengers/chat. The page itself still fetches the gallery client-side.
export const load: PageServerLoad = ({ params, url }) => loadShareOg(params.token, url);
