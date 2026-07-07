import { error, redirect } from '@sveltejs/kit';
import { getChain } from '$lib/server/chain';
import { isNotFoundError, chainErrorMessage } from '$lib/server/search';
import type { PageServerLoad } from './$types';
import type { CpfpInfo, FeeEstimates, RbfInfo, TxDetail } from '$lib/types';

// Raw hex beyond this is a novelty payload (huge inscriptions etc.) — don't
// ship hundreds of KB to the client just for a curiosity viewer.
const RAW_HEX_LIMIT = 400_000;

interface TxDetails {
	fees: FeeEstimates | null;
	rbf: RbfInfo | null;
	cpfp: CpfpInfo | null;
	rawHex: string | null;
	rawTooLarge: boolean;
}

/** The fee-outlook estimate, RBF timeline, CPFP package context, and raw hex are
 *  each EXTRA Electrum/esplora round-trips (cairn-2zxt.3) — the RBF-index lookup
 *  and raw-hex fetch can be slow. They're streamed so the decoded transaction
 *  paints immediately and these supplementary details fill in after. Never
 *  rejects: every sub-call already degrades to null. */
async function loadTxDetails(tx: TxDetail, isCoinbase: boolean): Promise<TxDetails> {
	const chain = getChain();

	// For mempool transactions, current fee tiers let the page estimate when
	// this fee rate is likely to confirm.
	const feesPromise: Promise<FeeEstimates | null> =
		!tx.confirmed && tx.feeRate !== null
			? chain.getFeeEstimates().catch(() => null)
			: Promise.resolve(null);

	// Replace-by-fee history. Coinbase txs can't be replaced; failures and
	// backends without an RBF index degrade to "no timeline".
	const rbfPromise: Promise<RbfInfo | null> = isCoinbase
		? Promise.resolve(null)
		: chain.getTxRbfInfo(tx.txid).catch(() => null);

	// CPFP package context only matters while the tx sits in the mempool.
	const cpfpPromise: Promise<CpfpInfo | null> = tx.confirmed
		? Promise.resolve(null)
		: chain.getCpfpInfo(tx.txid).catch(() => null);

	const rawHexPromise: Promise<string | null> = chain.getTxHex(tx.txid).catch(() => null);

	const [fees, rbf, cpfp, fetchedHex] = await Promise.all([
		feesPromise,
		rbfPromise,
		cpfpPromise,
		rawHexPromise
	]);

	const rawTooLarge = fetchedHex !== null && fetchedHex.length > RAW_HEX_LIMIT;
	const rawHex = rawTooLarge ? null : fetchedHex;
	return { fees, rbf, cpfp, rawHex, rawTooLarge };
}

export const load: PageServerLoad = async ({ params, url }) => {
	const txid = params.txid.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(txid)) error(404, 'Transaction not found');

	// Explains the hop when the visitor arrived via a replaced-tx redirect.
	const replacedFromRaw = url.searchParams.get('replaced');
	const replacedFrom =
		replacedFromRaw && /^[0-9a-f]{64}$/.test(replacedFromRaw) ? replacedFromRaw : null;

	// getTx stays AWAITED (judgment call, cairn-2zxt.3): it drives the routing
	// decision — a not-found tx either 302-redirects to its RBF replacement or
	// 404s, and that must resolve before the response streams. Only the decoded
	// tx itself gates the first paint; the four supplementary round-trips below
	// stream in after.
	const chain = getChain();
	let tx: TxDetail;
	try {
		tx = await chain.getTx(txid);
	} catch (e) {
		if (isNotFoundError(e)) {
			// Replaced transactions are evicted from the backend, so their pages
			// 404 — but the RBF index may still know what superseded them. Send
			// the visitor to the live version instead of a dead end. This lookup
			// is part of the routing decision, so it stays synchronous too.
			const rbf = await chain.getTxRbfInfo(txid).catch(() => null);
			const newest = rbf?.chain[rbf.chain.length - 1];
			if (newest && newest.txid !== txid) {
				redirect(302, `/explorer/tx/${newest.txid}?replaced=${txid}`);
			}
			error(404, 'Transaction not found');
		}
		error(502, chainErrorMessage(e));
	}

	const isCoinbase = tx.vin.some((v) => v.coinbase);

	return {
		tx,
		replacedFrom,
		// Streamed, not awaited (cairn-2zxt.3): supplementary display data only.
		details: loadTxDetails(tx, isCoinbase)
	};
};
