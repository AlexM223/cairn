import { db } from '$lib/server/db';
import { getChain } from '$lib/server/chain';
import { scanWallet } from '$lib/server/bitcoin/walletScan';
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

async function loadPortfolio(userId: number) {
	const wallets = db
		.prepare('SELECT id, name, xpub FROM wallets WHERE user_id = ? ORDER BY created_at ASC')
		.all(userId) as { id: number; name: string; xpub: string }[];

	if (wallets.length === 0) return null;

	let confirmed = 0;
	let unconfirmed = 0;
	let reachable = 0;
	for (const w of wallets) {
		try {
			const scan = await scanWallet(w.xpub);
			confirmed += scan.confirmed;
			unconfirmed += scan.unconfirmed;
			reachable++;
		} catch {
			// Wallet scan failure shouldn't take down the dashboard.
		}
	}
	return {
		walletCount: wallets.length,
		scannedCount: reachable,
		confirmed,
		unconfirmed
	};
}

export const load: PageServerLoad = async ({ locals }) => {
	return {
		chain: await loadChainSnapshot(),
		// Streamed: the dashboard renders instantly, the portfolio card fills in.
		portfolio: loadPortfolio(locals.user!.id)
	};
};
