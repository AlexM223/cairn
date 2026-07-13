import { getChain } from '$lib/server/chain';
import { classifySearch, chainErrorMessage } from '$lib/server/search';
import { getEpochStrip } from '$lib/server/chainEpochs';
import { ownedBlockHeights } from './ownership.server';
import { readChainSnapshot } from '$lib/server/chainSnapshot';
import { gatherNodeTrust } from '$lib/server/chain/nodeTrust';
import type { PersistedChainData } from '$lib/server/chainSnapshot';
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
	/** The next few projected blocks (cairn-pw3u), for the index's compact
	 *  "Up next" strip — same snapshot field the mempool page's "Projected
	 *  next rings" section and /explorer/mempool/blocks treemap already read,
	 *  just condensed for the index. Null when the backend doesn't provide
	 *  projections (plain esplora) or the snapshot hasn't landed yet. */
	mempoolBlocks: MempoolBlockProjection[] | null;
}

/** Shape the tip-view explorer data from the persisted snapshot (no chain call). */
function shapeFromSnapshot(d: PersistedChainData): ExplorerChainData {
	return {
		blocks: d.blocks.slice(0, PAGE_SIZE),
		mempool: d.mempoolSummary,
		tipHeight: d.tipHeight,
		chainError: null,
		fees: d.fees,
		difficulty: d.difficultyInfo,
		nextBlock: d.mempoolBlocks?.[0] ?? null,
		mempoolBlocks: d.mempoolBlocks ?? null
	};
}

/**
 * Paging into OLDER rings (`before` set) is a genuine on-demand history browse —
 * those blocks aren't part of the current-tip snapshot and there is no stale
 * data to serve for an arbitrary past height range — so this one path does a
 * live block fetch. The hero context (mempool/tip/fees/difficulty) still comes
 * from the snapshot, so it stays consistent with the SWR pages.
 */
async function loadOlderBlocks(before: number): Promise<ExplorerChainData> {
	const snap = readChainSnapshot()?.data ?? null;
	const context = {
		mempool: snap?.mempoolSummary ?? null,
		tipHeight: snap?.tipHeight ?? null,
		fees: snap?.fees ?? null,
		difficulty: snap?.difficultyInfo ?? null,
		nextBlock: snap?.mempoolBlocks?.[0] ?? null,
		mempoolBlocks: snap?.mempoolBlocks ?? null
	};
	try {
		const blocks = await getChain().getRecentBlocks(PAGE_SIZE, Math.max(0, before - 1));
		return { blocks, chainError: null, ...context };
	} catch (e) {
		return { blocks: [], chainError: chainErrorMessage(e), ...context };
	}
}

// The `explorer` feature gate lives in +layout.server.ts so it covers every
// explorer sub-route, not just this index page.
export const load: PageServerLoad = async ({ url, depends, locals }) => {
	// Re-run on new-block SSE events / after a background refresh, without
	// re-running unrelated loads.
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

	// Tip view = stale-while-revalidate from the persisted snapshot (synchronous,
	// no live chain call); the client refreshes it in the background. Paged
	// history is the one live-fetch exception (see loadOlderBlocks).
	const snap = before === null ? readChainSnapshot() : null;
	const chain: ExplorerChainData | null =
		before === null
			? snap
				? shapeFromSnapshot(snap.data)
				: null
			: await loadOlderBlocks(before);

	// "Yours" pip data (cairn-6efi.4): block heights where the viewing user has a
	// tx. Viewer-scoped, DB-only (no chain call — safe in load()), bounded by the
	// viewer's own tx count. Serialize the Set as an array for the client payload.
	const yoursHeights = [...ownedBlockHeights(locals?.user?.id)];

	return {
		q,
		search,
		before,
		chain,
		yoursHeights,
		lastSyncedAt: snap?.lastSyncedAt ?? null,
		// NodeTrust provenance chip (cairn-6efi.3). Synchronous + cached-only —
		// no chain call — so it rides the instant-paint snapshot read above and
		// never blocks the load (Explorer-redesign Cardinal rule 3).
		nodeTrust: gatherNodeTrust(),
		// Admins get a direct link to connection settings on the no-chain-backend
		// banner below (cairn-obg6); non-admins keep the calm retry-only copy since
		// they can't act on it.
		isAdmin: locals?.user?.isAdmin ?? false,
		// The ChainStrip dataset (cairn-koy4.7): real difficulty-epoch boundaries,
		// cached hard after the first computation. Streamed separately so a slow
		// first-ever boundary fetch can't hold up the block list; resolves to null
		// (strip hidden) rather than rejecting.
		strip: getEpochStrip().catch(() => null)
	};
};
