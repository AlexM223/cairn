import { getChain } from '$lib/server/chain';
import { classifySearch, chainErrorMessage } from '$lib/server/search';
import { getEpochStrip } from '$lib/server/chainEpochs';
import type { PageServerLoad } from './$types';
import type {
	BlockSummary,
	MempoolSummary,
	SearchResult,
	FeeEstimates,
	DifficultyInfo,
	MempoolBlockProjection
} from '$lib/types';

const PAGE_SIZE = 15;

export interface ExplorerChainData {
	blocks: BlockSummary[];
	mempool: MempoolSummary | null;
	tipHeight: number | null;
	chainError: string | null;
	/** Fee tiers for the hero's "next ring ≈ N sat/vB" line. */
	fees: FeeEstimates | null;
	/** Epoch progress + projected retarget for the hero sub-line. */
	difficulty: DifficultyInfo | null;
	/** The projected next block, for the dashed pending row. */
	nextBlock: MempoolBlockProjection | null;
}

async function loadChainData(before: number | null): Promise<ExplorerChainData> {
	const chain = getChain();
	try {
		const [blocks, mempool, tip, fees, difficulty, projected] = await Promise.all([
			chain.getRecentBlocks(PAGE_SIZE, before !== null ? Math.max(0, before - 1) : undefined),
			chain.getMempoolSummary().catch(() => null),
			chain.getTip().catch(() => null),
			// Hero sub-line extras (5e): all optional, the line degrades segment by
			// segment when a backend lacks them.
			chain.getFeeEstimates().catch(() => null),
			chain.getDifficultyInfo().catch(() => null),
			chain.getMempoolBlocks().catch(() => null)
		]);
		return {
			blocks,
			mempool,
			tipHeight: tip?.height ?? (before === null ? (blocks[0]?.height ?? null) : null),
			chainError: null,
			fees,
			difficulty,
			nextBlock: projected?.[0] ?? null
		};
	} catch (e) {
		return {
			blocks: [],
			mempool: null,
			tipHeight: null,
			chainError: chainErrorMessage(e),
			fees: null,
			difficulty: null,
			nextBlock: null
		};
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
		chain: loadChainData(before),
		// The ChainStrip dataset (cairn-koy4.7): real difficulty-epoch boundaries,
		// cached hard after the first computation. Streamed separately so a slow
		// first-ever boundary fetch can't hold up the block list; resolves to null
		// (strip hidden) rather than rejecting.
		strip: getEpochStrip().catch(() => null)
	};
};
