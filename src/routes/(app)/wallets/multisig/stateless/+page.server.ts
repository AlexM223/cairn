import { getChain } from '$lib/server/chain';
import type { FeeEstimates } from '$lib/types';
import type { PageServerLoad } from './$types';

// The stateless page deliberately loads NOTHING multisig-shaped from the server:
// its whole model is "everything comes from the config you paste" (see the
// Caravan parity study — config-file-only, refetched, never persisted). Only
// live fee estimates ride along to seed the fee selector; auth is enforced by
// the (app) layout and again by every /api/stateless endpoint.
export const load: PageServerLoad = async () => {
	let fees: FeeEstimates | null = null;
	try {
		fees = await getChain().getFeeEstimates();
	} catch {
		fees = null;
	}
	return { fees };
};
