import { getChain } from '$lib/server/chain';
import { chainErrorMessage } from '$lib/server/search';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends }) => {
	// Re-run on new-block SSE events without re-running unrelated loads.
	depends('cairn:chain');

	const chain = getChain();
	try {
		const [summary, fees, histogram, projected, trend] = await Promise.all([
			chain.getMempoolSummary(),
			chain.getFeeEstimates().catch(() => null),
			chain.getFeeHistogram().catch(() => null),
			chain.getMempoolBlocks().catch(() => null),
			chain.getMempoolTrend().catch(() => null)
		]);
		return { summary, fees, histogram, projected, trend, error: null };
	} catch (e) {
		return {
			summary: null,
			fees: null,
			histogram: null,
			projected: null,
			trend: null,
			error: chainErrorMessage(e)
		};
	}
};
