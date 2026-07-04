import { error } from '@sveltejs/kit';
import { getChain } from '$lib/server/chain';
import { isNotFoundError, chainErrorMessage } from '$lib/server/search';
import type { PageServerLoad } from './$types';
import type { CpfpInfo, FeeEstimates, RbfInfo } from '$lib/types';

// Raw hex beyond this is a novelty payload (huge inscriptions etc.) — don't
// ship hundreds of KB to the client just for a curiosity viewer.
const RAW_HEX_LIMIT = 400_000;

export const load: PageServerLoad = async ({ params }) => {
	const txid = params.txid.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(txid)) error(404, 'Transaction not found');

	try {
		const chain = getChain();
		const tx = await chain.getTx(txid);
		const isCoinbase = tx.vin.some((v) => v.coinbase);

		// For mempool transactions, current fee tiers let the page estimate
		// when this fee rate is likely to confirm.
		const feesPromise: Promise<FeeEstimates | null> =
			!tx.confirmed && tx.feeRate !== null
				? chain.getFeeEstimates().catch(() => null)
				: Promise.resolve(null);

		// Replace-by-fee history. Coinbase txs can't be replaced; failures and
		// backends without an RBF index degrade to "no timeline".
		const rbfPromise: Promise<RbfInfo | null> = isCoinbase
			? Promise.resolve(null)
			: chain.getTxRbfInfo(txid).catch(() => null);

		// CPFP package context only matters while the tx sits in the mempool.
		const cpfpPromise: Promise<CpfpInfo | null> = tx.confirmed
			? Promise.resolve(null)
			: chain.getCpfpInfo(txid).catch(() => null);

		const rawHexPromise: Promise<string | null> = chain.getTxHex(txid).catch(() => null);

		const [fees, rbf, cpfp, fetchedHex] = await Promise.all([
			feesPromise,
			rbfPromise,
			cpfpPromise,
			rawHexPromise
		]);

		const rawTooLarge = fetchedHex !== null && fetchedHex.length > RAW_HEX_LIMIT;
		const rawHex = rawTooLarge ? null : fetchedHex;

		return { tx, fees, rbf, cpfp, rawHex, rawTooLarge };
	} catch (e) {
		if (isNotFoundError(e)) error(404, 'Transaction not found');
		error(502, chainErrorMessage(e));
	}
};
