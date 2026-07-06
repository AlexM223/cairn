import { getChain } from '$lib/server/chain';
import { chainErrorMessage } from '$lib/server/search';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const chain = getChain();
	try {
		const [projected, histogram, fees, tip] = await Promise.all([
			chain.getMempoolBlocks(),
			chain.getFeeHistogram().catch(() => null),
			chain.getFeeEstimates().catch(() => null),
			chain.getTip().catch(() => null)
		]);
		return { projected, histogram, fees, tipHeight: tip?.height ?? null, error: null };
	} catch (e) {
		return {
			projected: null,
			histogram: null,
			fees: null,
			tipHeight: null,
			error: chainErrorMessage(e)
		};
	}
};
