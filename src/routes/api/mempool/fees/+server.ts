import { json, requireUser } from '$lib/server/api';
import { getChain } from '$lib/server/chain';
import { chainErrorMessage } from '$lib/server/search';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('chain');

/** GET /api/mempool/fees → FeeEstimates */
export const GET: RequestHandler = async (event) => {
	requireUser(event);
	try {
		return json(await getChain().getFeeEstimates());
	} catch (e) {
		log.error({ err: e }, 'mempool fees failed');
		return json({ error: chainErrorMessage(e) }, { status: 502 });
	}
};
