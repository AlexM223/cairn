import { error } from '@sveltejs/kit';
import { getChain } from '$lib/server/chain';
import { isNotFoundError, chainErrorMessage } from '$lib/server/search';
import type { PageServerLoad } from './$types';
import type { FeeEstimates } from '$lib/types';

export const load: PageServerLoad = async ({ params }) => {
	const txid = params.txid.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(txid)) error(404, 'Transaction not found');

	try {
		const tx = await getChain().getTx(txid);

		// For mempool transactions, current fee tiers let the page estimate
		// when this fee rate is likely to confirm.
		let fees: FeeEstimates | null = null;
		if (!tx.confirmed && tx.feeRate !== null) {
			fees = await getChain()
				.getFeeEstimates()
				.catch(() => null);
		}

		return { tx, fees };
	} catch (e) {
		if (isNotFoundError(e)) error(404, 'Transaction not found');
		error(502, chainErrorMessage(e));
	}
};
