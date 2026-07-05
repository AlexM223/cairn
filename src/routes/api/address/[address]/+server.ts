import { json, requireUser } from '$lib/server/api';
import { getChain } from '$lib/server/chain';
import { isValidAddress } from '$lib/server/bitcoin/xpub';
import { isNotFoundError, chainErrorMessage } from '$lib/server/search';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('chain');

/**
 * GET /api/address/[address] → { address: AddressInfo, txs: AddressTx[] }
 * GET /api/address/[address]?after=<txid> → { txs: AddressTx[] } (next page of
 * confirmed transactions after the given txid).
 */
export const GET: RequestHandler = async (event) => {
	requireUser(event);

	const addr = event.params.address.trim();
	if (!isValidAddress(addr)) {
		return json({ error: 'Not a valid Bitcoin address' }, { status: 404 });
	}

	const after = event.url.searchParams.get('after');
	if (after !== null && !/^[0-9a-fA-F]{64}$/.test(after)) {
		return json({ error: 'after must be a 64-character hex txid' }, { status: 400 });
	}

	try {
		const chain = getChain();
		if (after !== null) {
			const txs = await chain.getAddressTxs(addr, after);
			return json({ txs });
		}
		const [address, txs] = await Promise.all([
			chain.getAddressInfo(addr),
			chain.getAddressTxs(addr).catch(() => [])
		]);
		return json({ address, txs });
	} catch (e) {
		if (isNotFoundError(e)) return json({ error: 'Address not found' }, { status: 404 });
		log.error({ err: e }, 'address lookup failed');
		return json({ error: chainErrorMessage(e) }, { status: 502 });
	}
};
