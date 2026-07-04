import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { getChain } from '$lib/server/chain';
import type { RequestHandler } from './$types';

/**
 * Data feed for the mempool block visualizer: projected next blocks plus the
 * live fee histogram the transaction rectangles are synthesized from.
 */
export const GET: RequestHandler = async (event) => {
	requireUser(event);
	const chain = getChain();
	try {
		const [projected, histogram, tip] = await Promise.all([
			chain.getMempoolBlocks(),
			chain.getFeeHistogram(),
			chain.getTip().catch(() => null)
		]);
		return json({ projected, histogram, tipHeight: tip?.height ?? null });
	} catch (e) {
		return json(
			{ error: e instanceof Error ? e.message : 'Chain data unavailable' },
			{ status: 502 }
		);
	}
};
