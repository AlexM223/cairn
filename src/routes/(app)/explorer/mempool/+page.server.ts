import { readChainSnapshot } from '$lib/server/chainSnapshot';
import type { PageServerLoad } from './$types';
import type {
	MempoolSummary,
	FeeEstimates,
	FeeHistogram,
	MempoolBlockProjection,
	MempoolTrendPoint
} from '$lib/types';

export interface MempoolPageData {
	summary: MempoolSummary | null;
	fees: FeeEstimates | null;
	histogram: FeeHistogram | null;
	projected: MempoolBlockProjection[] | null;
	trend: MempoolTrendPoint[] | null;
	error: string | null;
}

export const load: PageServerLoad = async ({ depends }) => {
	// Re-run on new-block SSE events / after a background refresh, without
	// re-running unrelated loads.
	depends('cairn:chain');

	// Stale-while-revalidate: the whole mempool view comes from the persisted
	// chain snapshot (synchronous SQLite read, no live chain call). The client
	// refreshes it in the background on mount + on every new block.
	const snap = readChainSnapshot();
	const mempool: MempoolPageData | null = snap
		? {
				summary: snap.data.mempoolSummary,
				fees: snap.data.fees,
				histogram: snap.data.feeHistogram,
				projected: snap.data.mempoolBlocks,
				trend: snap.data.mempoolTrend,
				error: null
			}
		: null;
	return { mempool, lastSyncedAt: snap?.lastSyncedAt ?? null };
};
