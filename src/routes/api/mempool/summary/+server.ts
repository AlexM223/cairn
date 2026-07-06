import { json, requireUser } from '$lib/server/api';
import { getChain } from '$lib/server/chain';
import { chainErrorMessage } from '$lib/server/search';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('chain');

/** GET /api/mempool/summary → MempoolSummary */
export const GET: RequestHandler = async (event) => {
	requireUser(event);
	try {
		return json(await getChain().getMempoolSummary());
	} catch (e) {
		log.error({ err: e }, 'mempool summary failed');
		return json({ error: chainErrorMessage(e) }, { status: 502 });
	}
};
