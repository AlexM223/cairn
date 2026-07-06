import { error } from '@sveltejs/kit';
import { getChain } from '$lib/server/chain';
import { isNotFoundError, chainErrorMessage } from '$lib/server/search';
import type { PageServerLoad } from './$types';
import type { BlockDetail, TxDetail } from '$lib/types';

export const load: PageServerLoad = async ({ params, url }) => {
	const id = params.id.trim();
	const isHeight = /^\d{1,9}$/.test(id);
	const isHash = /^[0-9a-fA-F]{64}$/.test(id);
	if (!isHeight && !isHash) error(404, 'Block not found');

	const pageParam = url.searchParams.get('page') ?? '';
	const txPage = /^\d{1,5}$/.test(pageParam) ? parseInt(pageParam, 10) : 0;

	const chain = getChain();
	let block: BlockDetail;
	try {
		block = await chain.getBlock(isHeight ? Number(id) : id.toLowerCase());
	} catch (e) {
		if (isNotFoundError(e)) error(404, 'Block not found');
		error(502, chainErrorMessage(e));
	}

	const tip = await chain.getTip().catch(() => null);

	let txs: TxDetail[] = [];
	let txTotal = block.txCount;
	let txError: string | null = null;
	try {
		const res = await chain.getBlockTxs(block.hash, txPage);
		txs = res.txs;
		txTotal = res.total;
	} catch (e) {
		txError = isNotFoundError(e) ? 'No transactions at this page.' : chainErrorMessage(e);
	}

	return { block, txs, txTotal, txPage, txError, tipHeight: tip?.height ?? null };
};
