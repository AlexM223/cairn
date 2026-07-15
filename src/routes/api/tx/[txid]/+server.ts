import { json, requireUser } from '$lib/server/api';
import { getChain } from '$lib/server/chain';
import { isNotFoundError } from '$lib/server/search';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';
import { sanitizeChainError } from '$lib/server/chainErrors';

const log = childLogger('chain');

/** GET /api/tx/[txid] → { tx: TxDetail } */
export const GET: RequestHandler = async (event) => {
	requireUser(event);

	const txid = event.params.txid.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(txid)) {
		return json({ error: 'Transaction not found' }, { status: 404 });
	}

	try {
		const tx = await getChain().getTx(txid);
		return json({ tx });
	} catch (e) {
		if (isNotFoundError(e)) return json({ error: 'Transaction not found' }, { status: 404 });
		return json(
			{ error: sanitizeChainError(e, log, { txid }, 'tx lookup failed') },
			{ status: 502 }
		);
	}
};
