import { json, requireUser } from '$lib/server/api';
import { getChain } from '$lib/server/chain';
import { isNotFoundError, chainErrorMessage } from '$lib/server/search';
import type { RequestHandler } from './$types';

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
		return json({ error: chainErrorMessage(e) }, { status: 502 });
	}
};
