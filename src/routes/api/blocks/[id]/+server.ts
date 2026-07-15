import { json, requireUser } from '$lib/server/api';
import { getChain } from '$lib/server/chain';
import { isNotFoundError } from '$lib/server/search';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';
import { sanitizeChainError } from '$lib/server/chainErrors';

const log = childLogger('chain');

/** GET /api/blocks/[id] → { block } — with ?txpage=N → { block, txs, total } */
export const GET: RequestHandler = async (event) => {
	requireUser(event);

	const id = event.params.id.trim();
	const isHeight = /^\d{1,9}$/.test(id);
	const isHash = /^[0-9a-fA-F]{64}$/.test(id);
	if (!isHeight && !isHash) {
		return json({ error: 'Block not found' }, { status: 404 });
	}

	const txPageParam = event.url.searchParams.get('txpage');

	try {
		const chain = getChain();
		const block = await chain.getBlock(isHeight ? Number(id) : id.toLowerCase());
		if (txPageParam === null) return json({ block });

		const txPage = /^\d{1,5}$/.test(txPageParam) ? parseInt(txPageParam, 10) : 0;
		const { txs, total } = await chain.getBlockTxs(block.hash, txPage);
		return json({ block, txs, total });
	} catch (e) {
		if (isNotFoundError(e)) return json({ error: 'Block not found' }, { status: 404 });
		return json(
			{
				error: sanitizeChainError(
					e,
					log,
					{ id: event.params.id },
					'block lookup failed'
				)
			},
			{ status: 502 }
		);
	}
};
