import { json, requireUser } from '$lib/server/api';
import { getChain } from '$lib/server/chain';
import { isValidAddress } from '$lib/server/bitcoin/xpub';
import { isNotFoundError, chainErrorMessage } from '$lib/server/search';
import type { RequestHandler } from './$types';

/** GET /api/address/[address] → { address: AddressInfo, txs: AddressTx[] } */
export const GET: RequestHandler = async (event) => {
	requireUser(event);

	const addr = event.params.address.trim();
	if (!isValidAddress(addr)) {
		return json({ error: 'Not a valid Bitcoin address' }, { status: 404 });
	}

	try {
		const chain = getChain();
		const [address, txs] = await Promise.all([
			chain.getAddressInfo(addr),
			chain.getAddressTxs(addr).catch(() => [])
		]);
		return json({ address, txs });
	} catch (e) {
		if (isNotFoundError(e)) return json({ error: 'Address not found' }, { status: 404 });
		return json({ error: chainErrorMessage(e) }, { status: 502 });
	}
};
