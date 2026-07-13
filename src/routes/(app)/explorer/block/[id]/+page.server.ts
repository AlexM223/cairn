import { error } from '@sveltejs/kit';
import { getChain } from '$lib/server/chain';
import { coreRpcConfigured } from '$lib/server/settings';
import { isNotFoundError, chainErrorMessage } from '$lib/server/search';
import { getEpochStrip } from '$lib/server/chainEpochs';
import type { PageServerLoad } from './$types';
import type { BlockDetail, TxDetail } from '$lib/types';

interface BlockPageData {
	block: BlockDetail | null;
	txs: TxDetail[];
	txTotal: number;
	txPage: number;
	txError: string | null;
	tipHeight: number | null;
	/** The block hash/height parsed but no matching block exists on the backend. */
	notFound: boolean;
	/** The backend was unreachable or errored (distinct from a genuine 404). */
	error: string | null;
}

/** getBlock + getTip + getBlockTxs are Electrum/esplora round-trips (cairn-2zxt.3)
 *  — bundled into one streamed promise so the page chrome paints instantly and
 *  the block + its transactions fill in when the backend answers. Never rejects:
 *  a missing block resolves to `notFound`, any other failure to `error`, so a
 *  slow/unreachable backend degrades to a graceful in-page state instead of a
 *  route-level 404/502 that would block paint. */
async function loadBlockData(
	id: string,
	isHeight: boolean,
	txPage: number
): Promise<BlockPageData> {
	const chain = getChain();
	let block: BlockDetail;
	try {
		block = await chain.getBlock(isHeight ? Number(id) : id.toLowerCase());
	} catch (e) {
		return {
			block: null,
			txs: [],
			txTotal: 0,
			txPage,
			txError: null,
			tipHeight: null,
			notFound: isNotFoundError(e),
			error: isNotFoundError(e) ? null : chainErrorMessage(e)
		};
	}

	const [tip, txsRes] = await Promise.all([
		chain.getTip().catch(() => null),
		chain.getBlockTxs(block.hash, txPage).then(
			(res) => ({ txs: res.txs, total: res.total, error: null as string | null }),
			(e) => ({
				txs: [] as TxDetail[],
				total: block.txCount ?? 0,
				error: isNotFoundError(e) ? 'No transactions at this page.' : chainErrorMessage(e)
			})
		)
	]);

	return {
		block,
		txs: txsRes.txs,
		txTotal: txsRes.total,
		txPage,
		txError: txsRes.error,
		tipHeight: tip?.height ?? null,
		notFound: false,
		error: null
	};
}

export const load: PageServerLoad = async ({ params, url, locals }) => {
	const id = params.id.trim();
	const isHeight = /^\d{1,9}$/.test(id);
	const isHash = /^[0-9a-fA-F]{64}$/.test(id);
	// Syntactic validation stays a synchronous 404 — it's a pure routing decision
	// with no chain round-trip.
	if (!isHeight && !isHash) error(404, 'Block not found');

	const pageParam = url.searchParams.get('page') ?? '';
	const txPage = /^\d{1,5}$/.test(pageParam) ? parseInt(pageParam, 10) : 0;

	return {
		// Whether a Bitcoin Core RPC backend is configured: full block detail
		// (tx list, fee/reward stats) needs it. When it's absent the page renders the
		// honest CoreRpcRequiredNotice instead of a bare error (cairn-zoz8.10).
		coreRpcConfigured: coreRpcConfigured(),
		isAdmin: locals?.user?.isAdmin ?? false,
		// Streamed, not awaited (cairn-2zxt.3).
		chain: loadBlockData(id, isHeight, txPage),
		// Locator-strip dataset (cairn-koy4.7): streamed, cached hard after the
		// first computation; resolves to null (strip hidden) rather than rejecting.
		strip: getEpochStrip().catch(() => null)
	};
};
