import { getChain } from '$lib/server/chain';
import { chainErrorMessage } from '$lib/server/search';
import type { PageServerLoad } from './$types';

/** The mempool snapshot is five Electrum/esplora round-trips (cairn-2zxt.3) —
 *  streamed as one promise so the page chrome paints instantly instead of
 *  blocking SSR until the backend answers. Never rejects: a failure of the
 *  required summary resolves to all-null + error. */
async function loadMempool() {
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
}

export const load: PageServerLoad = async ({ depends }) => {
	// Re-run on new-block SSE events without re-running unrelated loads.
	depends('cairn:chain');

	// Streamed, not awaited (cairn-2zxt.3).
	return { mempool: loadMempool() };
};
