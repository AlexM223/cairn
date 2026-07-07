import { getChain } from '$lib/server/chain';
import { chainErrorMessage } from '$lib/server/search';
import type { PageServerLoad } from './$types';

/** The projected-blocks seed is four Electrum/esplora round-trips (cairn-2zxt.3)
 *  — streamed as one promise so the page chrome paints instantly instead of
 *  blocking SSR. The client then owns the live picture via polling. Never
 *  rejects: a failure of the required projection resolves to all-null + error. */
async function loadMempoolBlocks() {
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
}

export const load: PageServerLoad = async () => {
	// Streamed, not awaited (cairn-2zxt.3).
	return { mempool: loadMempoolBlocks() };
};
