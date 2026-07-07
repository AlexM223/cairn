import { db } from '$lib/server/db';
import { getChain } from '$lib/server/chain';
import type { PageServerLoad } from './$types';
import type { BlockSummary, FeeEstimates, MempoolSummary } from '$lib/types';

export interface ChainSnapshot {
	tipHeight: number | null;
	tipTime: number | null;
	hashrate: number | null;
	blocks: BlockSummary[];
	mempool: MempoolSummary | null;
	fees: FeeEstimates | null;
	error: string | null;
}

async function loadChainSnapshot(): Promise<ChainSnapshot> {
	const chain = getChain();
	try {
		const [blocks, mempool, fees, hashrate] = await Promise.all([
			chain.getRecentBlocks(10),
			chain.getMempoolSummary().catch(() => null),
			chain.getFeeEstimates().catch(() => null),
			chain.getHashrate().catch(() => null)
		]);
		return {
			tipHeight: blocks[0]?.height ?? null,
			tipTime: blocks[0]?.time ?? null,
			hashrate,
			blocks,
			mempool,
			fees,
			error: null
		};
	} catch (e) {
		return {
			tipHeight: null,
			tipTime: null,
			hashrate: null,
			blocks: [],
			mempool: null,
			fees: null,
			error: e instanceof Error ? e.message : 'Could not reach chain data sources'
		};
	}
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

	return {
		// Streamed, not awaited (SvelteKit 2 leaves top-level promises alone):
		// navigating to the dashboard paints immediately with a skeleton while the
		// Electrum round-trips (blocks + mempool + fees + hashrate) resolve in the
		// background (cairn-ybsv). loadChainSnapshot never rejects — failures
		// resolve to an error-shaped snapshot the page renders as a banner.
		chain: loadChainSnapshot(),
		hasWallets
	};
};
