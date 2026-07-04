import { db } from '$lib/server/db';
import { getChain } from '$lib/server/chain';
import type { PageServerLoad } from './$types';
import type { BlockSummary, FeeEstimates, MempoolSummary } from '$lib/types';

interface ChainSnapshot {
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

export const load: PageServerLoad = async ({ locals, depends }) => {
	// New-block SSE events invalidate this tag only — the portfolio is fetched
	// client-side from /api/portfolio so wallet scans aren't retriggered by
	// every block (see the portfolio endpoint).
	depends('cairn:chain');

	const hasWallets =
		(db.prepare('SELECT COUNT(*) AS n FROM wallets WHERE user_id = ?').get(locals.user!.id) as {
			n: number;
		}).n > 0;

	return {
		chain: await loadChainSnapshot(),
		hasWallets
	};
};
