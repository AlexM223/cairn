import { error } from '@sveltejs/kit';
import { getChain } from '$lib/server/chain';
import { isNotFoundError, chainErrorMessage } from '$lib/server/search';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const txid = params.txid.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(txid)) error(404, 'Transaction not found');

	try {
		const tx = await getChain().getTx(txid);
		return { tx };
	} catch (e) {
		if (isNotFoundError(e)) error(404, 'Transaction not found');
		error(502, chainErrorMessage(e));
	}
};
