import type { PageServerLoad } from './$types';
import { pickDeck, pickStampStart } from '$lib/samples';

// Chosen HERE rather than in the component so the server and the client agree — see pickSamples.
export const load: PageServerLoad = async () => ({ deck: pickDeck(4), stampStart: pickStampStart() });
