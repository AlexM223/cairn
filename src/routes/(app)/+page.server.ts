import { db } from '$lib/server/db';
import { readChainSnapshot } from '$lib/server/chainSnapshot';
import type { PageServerLoad } from './$types';
import type { BlockSummary, FeeEstimates, MempoolSummary } from '$lib/types';

export interface ChainSnapshot {
	tipHeight: number | null;
	tipTime: number | null;
	hashrate: number | null;
	blocks: BlockSummary[];
	mempool: MempoolSummary | null;
	fees: FeeEstimates | null;
}

export const load: PageServerLoad = async ({ locals, depends, parent }) => {
	// New-block SSE events invalidate this tag only — the portfolio is fetched
	// client-side from /api/portfolio so wallet scans aren't retriggered by
	// every block (see the portfolio endpoint).
	depends('cairn:chain');

	// The layout's load() redirects to /login when locals.user is null, but
	// SvelteKit runs layout and page loads concurrently unless the page
	// explicitly depends on the layout — without this, an anonymous/expired
	// request can hit the locals.user!.id assertion below before the layout's
	// redirect takes effect, 500ing instead of redirecting (cairn-ydxi).
	await parent();

	// Either flavor counts — a multisig-only user still has a portfolio.
	const hasWallets =
		((
			db
				.prepare(
					`SELECT
						(SELECT COUNT(*) FROM wallets WHERE user_id = ?) +
						(SELECT COUNT(*) FROM multisigs WHERE user_id = ?) AS n`
				)
				.get(locals.user!.id, locals.user!.id) as { n: number }
		).n) > 0;

	// Stale-while-revalidate: render instantly from the persisted chain snapshot
	// (a synchronous SQLite read — zero live chain-service calls here). The client
	// fires POST /api/chain/refresh on mount + on every new block and calls
	// invalidate('cairn:chain'), which re-runs this cheap load to pick up the
	// fresh snapshot. `chain` is null until the very first refresh has persisted
	// one — the page shows a loading state (or, if that refresh failed, an error).
	const snap = readChainSnapshot();
	const chain: ChainSnapshot | null = snap
		? {
				tipHeight: snap.data.tipHeight,
				tipTime: snap.data.tipTime,
				hashrate: snap.data.hashrate,
				blocks: snap.data.blocks.slice(0, 10),
				mempool: snap.data.mempoolSummary,
				fees: snap.data.fees
			}
		: null;

	return {
		chain,
		lastSyncedAt: snap?.lastSyncedAt ?? null,
		hasWallets
	};
};
