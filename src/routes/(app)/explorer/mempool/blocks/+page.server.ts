import { readChainSnapshot } from '$lib/server/chainSnapshot';
import type { PageServerLoad } from './$types';
import type { FeeHistogram, FeeEstimates, MempoolBlockProjection } from '$lib/types';

export interface MempoolBlocksPageData {
	projected: MempoolBlockProjection[] | null;
	histogram: FeeHistogram | null;
	fees: FeeEstimates | null;
	tipHeight: number | null;
}

/**
 * Was the ONE live-fetch explorer page: four Electrum round-trips on every
 * navigation (cairn-2zxt.3), then owned by a 10s client poll of
 * /api/mempool/projected that repeated the same round-trips forever
 * (cairn-6efi.5). Converted to the same snapshot-backed SWR pattern every
 * other explorer page uses — this data (`mempoolBlocks`/`feeHistogram`/`fees`/
 * `tipHeight`) already lives in the persisted chain snapshot
 * (chainSnapshot.ts PersistedChainData), refreshed in the background by
 * chainSync.ts. load() is now a synchronous SQLite read: zero chain calls,
 * instant paint from cache.
 *
 * Note: this page's data (fee histogram + projection) is Electrum-sourced, not
 * Core-RPC-sourced — Electrum is always configured (public default or
 * custom), so there is no Core-RPC gate here. The page previously showed
 * CoreRpcRequiredNotice behind a DEMONSTRATION-only `coreRpcConfigured` flag
 * (cairn-zoz8.9) that never matched the real data source; that fake gate is
 * removed (cairn-6efi.5 "make it real" — the honest answer is this page
 * simply never needs Core RPC).
 */
export const load: PageServerLoad = async ({ depends }) => {
	depends('cairn:chain');

	const snap = readChainSnapshot();
	const mempool: MempoolBlocksPageData | null = snap
		? {
				projected: snap.data.mempoolBlocks,
				histogram: snap.data.feeHistogram,
				fees: snap.data.fees,
				tipHeight: snap.data.tipHeight
			}
		: null;

	return { mempool, lastSyncedAt: snap?.lastSyncedAt ?? null };
};
