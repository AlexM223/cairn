import { getChain } from '$lib/server/chain';
import { classifySearch, chainErrorMessage } from '$lib/server/search';
import type { PageServerLoad } from './$types';
import type { BlockSummary, MempoolSummary, SearchResult } from '$lib/types';

const PAGE_SIZE = 15;

export interface ExplorerChainData {
	blocks: BlockSummary[];
	mempool: MempoolSummary | null;
	tipHeight: number | null;
	chainError: string | null;
}

async function loadChainData(before: number | null): Promise<ExplorerChainData> {
	const chain = getChain();
	try {
		const [blocks, mempool, tip] = await Promise.all([
			chain.getRecentBlocks(PAGE_SIZE, before !== null ? Math.max(0, before - 1) : undefined),
			chain.getMempoolSummary().catch(() => null),
			chain.getTip().catch(() => null)
		]);
		return {
			blocks,
			mempool,
			tipHeight: tip?.height ?? (before === null ? (blocks[0]?.height ?? null) : null),
			chainError: null
		};
	} catch (e) {
		return { blocks: [], mempool: null, tipHeight: null, chainError: chainErrorMessage(e) };
	}
}

// The `explorer` feature gate lives in +layout.server.ts so it covers every
// explorer sub-route, not just this index page.
export const load: PageServerLoad = async ({ url, depends }) => {
	// Re-run on new-block SSE events without re-running unrelated loads.
	depends('cairn:chain');

	const rawQ = url.searchParams.get('q');
	const q = rawQ?.trim() ?? '';

	// Classification is surfaced to the user ("looks like a transaction ID")
	// rather than silently redirecting — the detection itself is informative.
	// Awaited (not streamed): it only runs on an explicit search submit, and the
	// result decides the first paint of the page.
	let search: SearchResult | null = null;
	if (q !== '') {
		search = await classifySearch(q);
	}

	const beforeParam = url.searchParams.get('before') ?? '';
	const before = /^\d{1,9}$/.test(beforeParam) ? parseInt(beforeParam, 10) : null;

	return {
		q,
		search,
		before,
		// Streamed, not awaited (cairn-ybsv): blocks + mempool + tip are Electrum
		// round-trips — the page paints instantly with skeletons while they
		// resolve. loadChainData never rejects (errors resolve to chainError).
		chain: loadChainData(before)
	};
};
