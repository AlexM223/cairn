import { readChainSnapshot } from '$lib/server/chainSnapshot';
import { coreRpcConfigured } from '$lib/server/settings';
import { viewerPendingTxs, type PendingTx } from '../ownership.server';
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

export const load: PageServerLoad = async ({ depends, locals }) => {
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

	// "Your pending txs" band — the viewing user's own unconfirmed transactions,
	// read purely from persisted wallet snapshots (viewer-scoped, no chain call),
	// so it never violates the zero-chain-calls-in-load() rule (Cardinal rule 3).
	const pending: PendingTx[] = viewerPendingTxs(locals.user?.id);

	return {
		mempool,
		lastSyncedAt: snap?.lastSyncedAt ?? null,
		pending,
		// Whether a Bitcoin Core RPC is configured — drives the honest degrade copy
		// in the counts/summary panel when the snapshot has no mempool summary yet.
		coreRpcConfigured: coreRpcConfigured(),
		isAdmin: locals.user?.isAdmin ?? false
	};
};
