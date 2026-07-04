import { getChain } from '$lib/server/chain';
import { classifySearch, chainErrorMessage } from '$lib/server/search';
import type { PageServerLoad } from './$types';
import type { BlockSummary, MempoolSummary, SearchResult } from '$lib/types';

const PAGE_SIZE = 15;

export const load: PageServerLoad = async ({ url, depends }) => {
	// Re-run on new-block SSE events without re-running unrelated loads.
	depends('cairn:chain');

	const rawQ = url.searchParams.get('q');
	const q = rawQ?.trim() ?? '';

	// Classification is surfaced to the user ("looks like a transaction ID")
	// rather than silently redirecting — the detection itself is informative.
	let search: SearchResult | null = null;
	if (q !== '') {
		search = await classifySearch(q);
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

	return { q, search, before, blocks, mempool, tipHeight, chainError };
};
