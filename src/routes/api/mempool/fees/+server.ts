import { json, requireUser } from '$lib/server/api';
import { getChain } from '$lib/server/chain';
import { childLogger } from '$lib/server/logger';
import { sanitizeChainError } from '$lib/server/chainErrors';
import type { RequestHandler } from './$types';

const log = childLogger('chain');

/** GET /api/mempool/fees → FeeEstimates */
export const GET: RequestHandler = async (event) => {
	requireUser(event);
	try {
		return json(await getChain().getFeeEstimates());
	} catch (e) {
		return json(
			{ error: sanitizeChainError(e, log, {}, 'mempool fees failed') },
			{ status: 502 }
		);
	}
};
