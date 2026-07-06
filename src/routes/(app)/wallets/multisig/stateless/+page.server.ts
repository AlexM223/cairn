import { requireFeature } from '$lib/server/api';
import { getChain } from '$lib/server/chain';
import { getReferralBuyUrls } from '$lib/server/referrals';
import type { FeeEstimates } from '$lib/types';
import type { PageServerLoad } from './$types';

// The stateless page deliberately loads NOTHING multisig-shaped from the server:
// its whole model is "everything comes from the config you paste" (see the
// Caravan parity study — config-file-only, refetched, never persisted). Only
// live fee estimates ride along to seed the fee selector; auth is enforced by
// the (app) layout and again by every /api/stateless endpoint.
export const load: PageServerLoad = async (event) => {
	// The airgapped/stateless signer is gated behind the `stateless_signer` flag.
	requireFeature(event, 'stateless_signer');
	let fees: FeeEstimates | null = null;
	try {
		fees = await getChain().getFeeEstimates();
	} catch {
		fees = null;
	}
	return {
		fees,
		// Buy-a-device links for the signer cards' unavailable states; null when
		// the referral_links flag is off (the cards then render no referral UI).
		// Nothing multisig-shaped — this stays a config-file-only page.
		referralBuyUrls: getReferralBuyUrls(event.locals.flags)
	};
};
