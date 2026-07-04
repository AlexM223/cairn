import { json, requireUser } from '$lib/server/api';
import { getChain } from '$lib/server/chain';
import { chainErrorMessage } from '$lib/server/search';
import type { RequestHandler } from './$types';

/** GET /api/mempool/fees → FeeEstimates */
export const GET: RequestHandler = async (event) => {
	requireUser(event);
	try {
		return json(await getChain().getFeeEstimates());
	} catch (e) {
		return json({ error: chainErrorMessage(e) }, { status: 502 });
	}
};
