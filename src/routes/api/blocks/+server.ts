import { json, requireUser } from '$lib/server/api';
import { getChain } from '$lib/server/chain';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';
import { sanitizeChainError } from '$lib/server/chainErrors';

const log = childLogger('chain');

/** GET /api/blocks?limit=&before= → { blocks: BlockSummary[] } */
export const GET: RequestHandler = async (event) => {
	requireUser(event);

	const limitParam = event.url.searchParams.get('limit') ?? '';
	const limit = /^\d{1,3}$/.test(limitParam)
		? Math.min(50, Math.max(1, parseInt(limitParam, 10)))
		: 10;

	const beforeParam = event.url.searchParams.get('before') ?? '';
	if (beforeParam !== '' && !/^\d{1,9}$/.test(beforeParam)) {
		return json({ error: 'Invalid "before" parameter' }, { status: 400 });
	}
	const fromHeight =
		beforeParam !== '' ? Math.max(0, parseInt(beforeParam, 10) - 1) : undefined;

	try {
		const blocks = await getChain().getRecentBlocks(limit, fromHeight);
		return json({ blocks });
	} catch (e) {
		return json(
			{ error: sanitizeChainError(e, log, {}, 'blocks list failed') },
			{ status: 502 }
		);
	}
};
