import { redirect } from '@sveltejs/kit';
import { getChain } from '$lib/server/chain';
import { classifySearch, chainErrorMessage } from '$lib/server/search';
import type { PageServerLoad } from './$types';
import type { BlockSummary, MempoolSummary } from '$lib/types';

const PAGE_SIZE = 15;

export const load: PageServerLoad = async ({ url }) => {
	const rawQ = url.searchParams.get('q');
	const q = rawQ?.trim() ?? '';
	if (q !== '') {
		const result = await classifySearch(q);
		if (result.redirect) redirect(302, result.redirect);
	}

	const beforeParam = url.searchParams.get('before') ?? '';
	const before = /^\d{1,9}$/.test(beforeParam) ? parseInt(beforeParam, 10) : null;

	const chain = getChain();
	let blocks: BlockSummary[] = [];
	let mempool: MempoolSummary | null = null;
	let tipHeight: number | null = null;
	let chainError: string | null = null;

	try {
		const [blocksRes, mempoolRes, tipRes] = await Promise.all([
			chain.getRecentBlocks(PAGE_SIZE, before !== null ? Math.max(0, before - 1) : undefined),
			chain.getMempoolSummary().catch(() => null),
			chain.getTip().catch(() => null)
		]);
		blocks = blocksRes;
		mempool = mempoolRes;
		tipHeight = tipRes?.height ?? (before === null ? (blocksRes[0]?.height ?? null) : null);
	} catch (e) {
		chainError = chainErrorMessage(e);
	}

	return { q, before, blocks, mempool, tipHeight, chainError };
};
